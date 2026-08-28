// Command embedded-node runs one isolated tsnet node for Agent Terminal.
//
// In desktop mode it exposes the local Agent Terminal WebSocket listener on
// the node's tailnet listener. In mobile mode it exposes a localhost proxy
// which dials the saved desktop node through tsnet. The process owns its own
// tsnet state directory, so it never installs or configures a system-wide
// Tailscale service.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

type status struct {
	NodeID         string `json:"nodeId"`
	TailnetAddress string `json:"tailnetAddress,omitempty"`
	ProxyAddress   string `json:"proxyAddress,omitempty"`
	ErrorCode      string `json:"errorCode,omitempty"`
	ErrorMessage   string `json:"errorMessage,omitempty"`
}

func main() {
	stateDir := flag.String("state-dir", "", "persistent tsnet state directory")
	controlURL := flag.String("control-url", "https://node.hopto.org", "Headscale control URL")
	nodeID := flag.String("node-id", "agent-terminal-node", "stable node hostname/identity")
	targetPort := flag.String("target-port", "47831", "local Agent Terminal WebSocket port")
	remoteAddress := flag.String("remote-address", "", "tailnet address of a remote Agent Terminal host")
	proxyListen := flag.String("proxy-listen", "", "localhost listen address for mobile mode")
	flag.Parse()

	if *stateDir == "" {
		log.Fatal("--state-dir is required")
	}
	if err := os.MkdirAll(*stateDir, 0700); err != nil {
		log.Fatal(err)
	}

	node := &tsnet.Server{
		Dir:        *stateDir,
		Hostname:   *nodeID,
		ControlURL: *controlURL,
		AuthKey:    os.Getenv("AGENT_TERMINAL_NODE_AUTH_KEY"),
		Logf:       func(string, ...any) {},
	}
	if err := node.Start(); err != nil {
		writeFailure(*stateDir, *nodeID, err)
		log.Fatal(err)
	}
	defer node.Close()

	result := status{NodeID: *nodeID}
	if ipv4, _ := node.TailscaleIPs(); ipv4.IsValid() {
		result.TailnetAddress = ipv4.String()
	}

	if *remoteAddress != "" {
		if err := waitForRemote(node, *remoteAddress); err != nil {
			writeFailure(*stateDir, *nodeID, err)
			log.Fatal(err)
		}
		if *proxyListen == "" {
			*proxyListen = "127.0.0.1:0"
		}
		listener, err := net.Listen("tcp", *proxyListen)
		if err != nil {
			log.Fatal(err)
		}
		defer listener.Close()
		result.ProxyAddress = listener.Addr().String()
		writeStatus(*stateDir, result)
		serve(listener, func() (net.Conn, error) { return node.Dial(context.Background(), "tcp", *remoteAddress) })
		return
	}

	listener, err := node.Listen("tcp", ":"+*targetPort)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	writeStatus(*stateDir, result)
	serve(listener, func() (net.Conn, error) { return net.DialTimeout("tcp", "127.0.0.1:"+*targetPort, 2*time.Second) })
}

func waitForRemote(node *tsnet.Server, address string) error {
	deadline := time.Now().Add(10 * time.Second)
	var lastError error
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		connection, err := node.Dial(ctx, "tcp", address)
		cancel()
		if err == nil {
			_ = connection.Close()
			return nil
		}
		lastError = err
		if isHostNameNotFound(err) || time.Now().After(deadline) {
			return lastError
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func writeFailure(stateDir, nodeID string, err error) {
	code, message := explainError(err)
	writeStatus(stateDir, status{NodeID: nodeID, ErrorCode: code, ErrorMessage: message})
}

func explainError(err error) (string, string) {
	text := strings.ToLower(err.Error())
	if isHostNameNotFound(err) {
		return "tsnet_host_not_found", "The tsnet desktop host name could not be found. Update the mobile app and pair again."
	}
	if strings.Contains(text, "authkey") ||
		strings.Contains(text, "auth key") ||
		strings.Contains(text, "preauth") ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "not authorized") ||
		strings.Contains(text, "invalid key") ||
		strings.Contains(text, "expired") ||
		strings.Contains(text, "already been used") {
		return "preauth_rejected", "The desktop preauth key was rejected or has expired. Update the desktop app and pair again."
	}
	if strings.Contains(text, "connection refused") || strings.Contains(text, "i/o timeout") {
		return "remote_host_unavailable", "The desktop overlay host is unavailable. Check that the desktop app is running and try again."
	}
	return "embedded_node_start_failed", "The embedded network node could not start. Try pairing again."
}

func isHostNameNotFound(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "no such host") ||
		strings.Contains(text, "host not found") ||
		strings.Contains(text, "unknown host")
}

func serve(listener net.Listener, dial func() (net.Conn, error)) {
	for {
		incoming, err := listener.Accept()
		if err != nil {
			return
		}
		go func(in net.Conn) {
			defer in.Close()
			setKeepAlive(in)
			outgoing, err := dial()
			if err != nil {
				return
			}
			defer outgoing.Close()
			setKeepAlive(outgoing)
			go io.Copy(outgoing, in)
			_, _ = io.Copy(in, outgoing)
		}(incoming)
	}
}

func setKeepAlive(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	_ = tcp.SetKeepAlive(true)
	_ = tcp.SetKeepAlivePeriod(30 * time.Second)
}

func writeStatus(stateDir string, value status) {
	path := filepath.Join(stateDir, "status.json")
	temporary := path + ".tmp"
	data, err := json.Marshal(value)
	if err != nil {
		log.Printf("embedded-node: could not encode status: %v", err)
		return
	}
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		log.Printf("embedded-node: could not write status: %v", err)
		return
	}
	if err := os.Rename(temporary, path); err != nil {
		log.Printf("embedded-node: could not publish status: %v", err)
	}
}
