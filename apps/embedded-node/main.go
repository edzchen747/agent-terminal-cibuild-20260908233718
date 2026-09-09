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
	"errors"
	"flag"
	"fmt"
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
	ErrorDetail    string `json:"errorDetail,omitempty"`
}

func main() {
	stateDir := flag.String("state-dir", "", "persistent tsnet state directory")
	controlURL := flag.String("control-url", "https://node.hopto.org", "Headscale control URL")
	nodeID := flag.String("node-id", "agent-terminal-node", "stable node hostname/identity")
	targetPort := flag.String("target-port", "47831", "local Agent Terminal WebSocket port")
	remoteAddress := flag.String("remote-address", "", "tailnet address of a remote Agent Terminal host")
	proxyListen := flag.String("proxy-listen", "", "localhost listen address for mobile mode")
	exitWithParent := flag.Bool("exit-with-parent", false, "exit when the launcher's stdin pipe closes")
	flag.Parse()

	if *exitWithParent {
		go exitWhenParentCloses()
	}

	if *stateDir == "" {
		log.Fatal("--state-dir is required")
	}
	if err := os.MkdirAll(*stateDir, 0700); err != nil {
		log.Fatal(err)
	}
	configureNetworkInterfaceGetter()
	authKey := strings.TrimSpace(os.Getenv("AGENT_TERMINAL_NODE_AUTH_KEY"))
	if authKey != "" {
		// tsnet otherwise ignores a supplied auth key when the state directory
		// exists but contains no enrolled state (for example after a failed
		// first attempt). Force the one-time provisioning key to be consumed.
		_ = os.Setenv("TSNET_FORCE_LOGIN", "1")
	}

	node := &tsnet.Server{
		Dir:        *stateDir,
		Hostname:   *nodeID,
		ControlURL: *controlURL,
		AuthKey:    authKey,
		// Native logs are persisted on Android. Suppress tsnet's verbose log
		// callback so an enrollment capability can never be written to disk.
		Logf: func(string, ...any) {},
	}
	if err := node.Start(); err != nil {
		writeFailure(*stateDir, *nodeID, err, false)
		log.Fatal(err)
	}
	defer node.Close()
	if err := waitForNode(node); err != nil {
		writeFailure(*stateDir, *nodeID, err, false)
		log.Fatal(err)
	}
	// The native engine's state directory now contains the durable node
	// identity. Drop the single-use enrollment capability immediately.
	node.AuthKey = ""
	_ = os.Unsetenv("AGENT_TERMINAL_NODE_AUTH_KEY")

	result := status{NodeID: *nodeID}
	if ipv4, _ := node.TailscaleIPs(); ipv4.IsValid() {
		result.TailnetAddress = ipv4.String()
	}

	if *remoteAddress != "" {
		remoteDialAddress, err := waitForRemote(node, *remoteAddress)
		if err != nil {
			writeFailure(*stateDir, *nodeID, err, true)
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
		// The terminal proxy is the reason this process exists, but it is no
		// longer the only thing it serves: port bridges are added and removed
		// while it runs, so the main goroutine stays free to reconcile them.
		go serve(listener, func() (net.Conn, error) { return node.Dial(context.Background(), "tcp", remoteDialAddress) })
		runBridgeReconciler(node, *stateDir)
		return
	}

	listener, err := node.Listen("tcp", ":"+*targetPort)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	writeStatus(*stateDir, result)
	go serve(listener, func() (net.Conn, error) { return net.DialTimeout("tcp", "127.0.0.1:"+*targetPort, 2*time.Second) })
	runBridgeReconciler(node, *stateDir)
}

// Exit once the launcher goes away.
//
// The node outlives its launcher otherwise: it is a detached child process, so
// a crash, a kill, or a development restart of the app leaves it running - and
// the next launch starts another one against the same state directory and the
// same node identity, so several processes end up contending for one node.
// Rather than have the launcher hunt for strays by pid (which races with pid
// reuse), it hands the child an inherited stdin pipe and never writes to it:
// the read below blocks for as long as the launcher lives and returns EOF the
// moment the OS tears its end down, whatever killed it.
func exitWhenParentCloses() {
	buffer := make([]byte, 1)
	for {
		if _, err := os.Stdin.Read(buffer); err != nil {
			// EOF, or a broken pipe. Either way the launcher is gone.
			os.Exit(0)
		}
	}
}

// Start returns once the tsnet backend has been initialized, which is not the
// same as being enrolled and connected. Waiting for the backend state here
// prevents a mobile enrollment failure from being misreported as a remote
// desktop connectivity failure.
func waitForNode(node *tsnet.Server) error {
	client, err := node.LocalClient()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	lastState := ""
	for {
		current, statusErr := client.Status(ctx)
		if statusErr == nil {
			lastState = current.BackendState
			switch current.BackendState {
			case "Running":
				return nil
			case "NeedsMachineAuth":
				return errors.New("tsnet: backend needs machine auth")
			case "Stopped":
				return errors.New("tsnet: backend stopped")
			}
		}

		select {
		case <-ctx.Done():
			if lastState == "NeedsLogin" {
				if os.Getenv("AGENT_TERMINAL_NODE_AUTH_KEY") != "" {
					return errors.New("tsnet: preauth authentication did not complete")
				}
				return errors.New("tsnet: preauth key missing")
			}
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func waitForRemote(node *tsnet.Server, address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", fmt.Errorf("tsnet: invalid remote address %q: %w", address, err)
	}

	deadline := time.Now().Add(10 * time.Second)
	var lastError error
	for {
		target, resolveErr := resolveRemoteAddress(node, host, port)
		if resolveErr != nil {
			lastError = resolveErr
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			connection, dialErr := node.Dial(ctx, "tcp", target)
			cancel()
			if dialErr == nil {
				_ = connection.Close()
				return target, nil
			}
			lastError = dialErr
		}
		if time.Now().After(deadline) {
			return "", lastError
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// Android's system resolver can resolve the public control URL, but the
// desktop's *.agent-terminal.internal name is a tailnet-only MagicDNS name.
// Resolve it from tsnet's peer map and dial the peer IP directly so this works
// in userspace networking without relying on a system DNS stub or TUN device.
func resolveRemoteAddress(node *tsnet.Server, host, port string) (string, error) {
	if net.ParseIP(host) != nil {
		return net.JoinHostPort(host, port), nil
	}

	client, err := node.LocalClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	current, err := client.Status(ctx)
	if err != nil {
		return "", err
	}

	wanted := strings.TrimSuffix(strings.ToLower(host), ".")
	for _, peer := range current.Peer {
		peerName := strings.TrimSuffix(strings.ToLower(peer.DNSName), ".")
		if peerName != wanted {
			continue
		}

		var fallback string
		for _, ip := range peer.TailscaleIPs {
			if !ip.IsValid() {
				continue
			}
			if ip.Is4() {
				return net.JoinHostPort(ip.String(), port), nil
			}
			if fallback == "" {
				fallback = net.JoinHostPort(ip.String(), port)
			}
		}
		if fallback != "" {
			return fallback, nil
		}
		return "", fmt.Errorf("tsnet: peer %q has no tailnet IP", host)
	}

	return "", fmt.Errorf("tsnet: peer %q not found in netmap", host)
}

func writeFailure(stateDir, nodeID string, err error, remote bool) {
	code, message := explainError(err, remote)
	writeStatus(stateDir, status{
		NodeID:       nodeID,
		ErrorCode:    code,
		ErrorMessage: message,
		ErrorDetail:  safeErrorDetail(err),
	})
}

func explainError(err error, remote bool) (string, string) {
	text := strings.ToLower(err.Error())
	if remote && isHostNameNotFound(err) {
		return "tsnet_host_not_found", "The tsnet desktop host name could not be found. Update the mobile app and pair again."
	}
	if strings.Contains(text, "preauth key missing") {
		return "preauth_missing", "This device's overlay node is no longer registered."
	}
	if isAuthFailure(text) {
		return "preauth_rejected", "The desktop preauth key was rejected or has expired. Update the desktop app and pair again."
	}
	if strings.Contains(text, "connection refused") ||
		strings.Contains(text, "i/o timeout") ||
		strings.Contains(text, "context deadline exceeded") ||
		strings.Contains(text, "network is unreachable") ||
		strings.Contains(text, "no route to host") {
		if !remote {
			return "control_server_unavailable", "The overlay control server could not be reached. Check the control URL and try pairing again."
		}
		return "remote_host_unavailable", "The desktop overlay host is unavailable. Check that the desktop app is running and try again."
	}
	return "embedded_node_start_failed", "The embedded network node could not start. Try pairing again."
}

func isAuthFailure(text string) bool {
	return strings.Contains(text, "authkey") ||
		strings.Contains(text, "auth key") ||
		strings.Contains(text, "preauth") ||
		strings.Contains(text, "unauthorized") ||
		strings.Contains(text, "not authorized") ||
		strings.Contains(text, "invalid key") ||
		strings.Contains(text, "key not found") ||
		strings.Contains(text, "expired") ||
		strings.Contains(text, "already been used") ||
		strings.Contains(text, "authentication failed") ||
		strings.Contains(text, "needs machine auth") ||
		strings.Contains(text, "preauth authentication") ||
		strings.Contains(text, "access denied") ||
		strings.Contains(text, "registration failed")
}

func isHostNameNotFound(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "no such host") ||
		strings.Contains(text, "host not found") ||
		strings.Contains(text, "unknown host") ||
		strings.Contains(text, "name or service not known") ||
		strings.Contains(text, "not found in netmap") ||
		strings.Contains(text, "cannot resolve") ||
		(strings.Contains(text, "lookup ") && (strings.Contains(text, "not found") || strings.Contains(text, "server misbehaving")))
}

// Keep the user-visible diagnostic useful without ever echoing an auth key or
// token that a control server might include in an error string.
func safeErrorDetail(err error) string {
	value := strings.Join(strings.Fields(err.Error()), " ")
	text := strings.ToLower(value)
	if strings.Contains(text, "auth") || strings.Contains(text, "preauth") || strings.Contains(text, "token") || strings.Contains(text, "password") {
		return "authentication or enrollment detail was redacted"
	}
	if len(value) > 180 {
		return value[:180] + "…"
	}
	return value
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
	writeJSON(filepath.Join(stateDir, "status.json"), value)
}

// Publish a small JSON document the launcher reads. The write is atomic so a
// reader polling the path never sees a half-written document.
func writeJSON(path string, value any) {
	temporary := path + ".tmp"
	data, err := json.Marshal(value)
	if err != nil {
		log.Printf("embedded-node: could not encode %s: %v", filepath.Base(path), err)
		return
	}
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		log.Printf("embedded-node: could not write %s: %v", filepath.Base(path), err)
		return
	}
	if err := os.Rename(temporary, path); err != nil {
		log.Printf("embedded-node: could not publish %s: %v", filepath.Base(path), err)
	}
}
