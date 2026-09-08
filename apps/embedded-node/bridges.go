package main

// Port Bridge support.
//
// The node is spawned once and lives as long as the app, so bridges cannot be
// flags: they come and go while it runs. The desired set is a file the
// launcher owns - bridges.json in the node's own state directory - and this
// reconciler polls it, opens and closes listeners to match, and publishes what
// actually happened to bridges-status.json. A file is used rather than a
// control socket because both launchers (Rust on the desktop, the Capacitor
// plugin on Android) already own that directory and already read status.json
// out of it, so no new IPC surface or port is introduced.
//
// A bridge is one of two shapes, which is all either side needs:
//
//	listen-tsnet - accept on the tailnet and dial a local service. Used by the
//	               side that runs the service.
//	listen-local - accept on loopback and dial the peer over the tailnet. Used
//	               by the side that wants to reach the service.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

// How often the desired-state file is re-read. Bridges follow a device
// connecting or disconnecting, so half a second is well inside what a user
// perceives as immediate, and reading a file this small costs nothing.
const bridgePollInterval = 500 * time.Millisecond

type bridgeSpec struct {
	ID   string `json:"id"`
	Mode string `json:"mode"`
	// listen-tsnet: the tailnet port to accept on.
	Port int `json:"port,omitempty"`
	// listen-local: the loopback address to accept on.
	Listen string `json:"listen,omitempty"`
	// Where an accepted connection is forwarded to.
	Target string `json:"target"`
	// listen-tsnet: the only peer address allowed to connect, when set.
	Peer string `json:"peer,omitempty"`
}

type bridgeFile struct {
	Revision int64        `json:"revision"`
	Bridges  []bridgeSpec `json:"bridges"`
}

type bridgeStatus struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

type bridgeStatusFile struct {
	Revision int64          `json:"revision"`
	Bridges  []bridgeStatus `json:"bridges"`
}

const (
	bridgeStateListening = "listening"
	bridgeStateFailed    = "failed"

	bridgeModeTsnet = "listen-tsnet"
	bridgeModeLocal = "listen-local"
)

// A bridge that currently owns a listener.
//
// Its connections are tracked so that closing the bridge closes them too. A
// port can be re-awarded to a different device the moment its previous holder
// disconnects, and a connection still copying bytes into the old device's
// service would outlive the claim that authorized it.
type runningBridge struct {
	spec     bridgeSpec
	listener net.Listener
	done     chan struct{}

	mu     sync.Mutex
	conns  map[net.Conn]struct{}
	closed bool
}

func (bridge *runningBridge) track(conn net.Conn) bool {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	if bridge.closed {
		return false
	}
	bridge.conns[conn] = struct{}{}
	return true
}

func (bridge *runningBridge) untrack(conn net.Conn) {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	delete(bridge.conns, conn)
}

func (bridge *runningBridge) close() {
	bridge.mu.Lock()
	if bridge.closed {
		bridge.mu.Unlock()
		return
	}
	bridge.closed = true
	conns := make([]net.Conn, 0, len(bridge.conns))
	for conn := range bridge.conns {
		conns = append(conns, conn)
	}
	bridge.conns = map[net.Conn]struct{}{}
	bridge.mu.Unlock()

	_ = bridge.listener.Close()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

// True once the accept loop has stopped on its own, which means the listener
// died and the bridge must be reopened rather than left silently dead.
func (bridge *runningBridge) finished() bool {
	select {
	case <-bridge.done:
		return true
	default:
		return false
	}
}

// Reconcile bridges against the desired-state file for as long as the node
// runs. Never returns.
func runBridgeReconciler(node *tsnet.Server, stateDir string) {
	desiredPath := filepath.Join(stateDir, "bridges.json")
	statusPath := filepath.Join(stateDir, "bridges-status.json")
	running := map[string]*runningBridge{}
	var published []bridgeStatus
	publishedRevision := int64(-1)

	for {
		desired := readBridgeFile(desiredPath)
		statuses := reconcileBridges(node, running, desired.Bridges)
		if desired.Revision != publishedRevision || !sameBridgeStatuses(statuses, published) {
			writeJSON(statusPath, bridgeStatusFile{Revision: desired.Revision, Bridges: statuses})
			published = statuses
			publishedRevision = desired.Revision
		}
		time.Sleep(bridgePollInterval)
	}
}

// A missing or unreadable file means "no bridges": a launcher that predates
// this feature never writes one, and the node then behaves exactly as it did
// before.
func readBridgeFile(path string) bridgeFile {
	data, err := os.ReadFile(path)
	if err != nil {
		return bridgeFile{}
	}
	var parsed bridgeFile
	if err := json.Unmarshal(data, &parsed); err != nil {
		return bridgeFile{}
	}
	return parsed
}

// Bring running in line with desired and report the outcome for every desired
// bridge. Idempotent, so a bridge whose listener could not be opened - its
// local port is in use by another program - is retried on the next tick and
// comes up on its own once the port frees.
func reconcileBridges(node *tsnet.Server, running map[string]*runningBridge, desired []bridgeSpec) []bridgeStatus {
	live := make(map[string]bridgeSpec, len(running))
	for id, bridge := range running {
		if bridge.finished() {
			// The listener died on its own. Retire it here rather than
			// leaving a silently dead bridge in place; the pass below then
			// reopens it like any bridge that is not running.
			bridge.close()
			delete(running, id)
			continue
		}
		live[id] = bridge.spec
	}
	for _, id := range bridgesToStop(live, desired) {
		if bridge, found := running[id]; found {
			bridge.close()
			delete(running, id)
		}
	}

	statuses := make([]bridgeStatus, 0, len(desired))
	for _, spec := range desired {
		if _, alive := running[spec.ID]; alive {
			statuses = append(statuses, bridgeStatus{ID: spec.ID, State: bridgeStateListening})
			continue
		}
		bridge, err := startBridge(node, spec)
		if err != nil {
			statuses = append(statuses, bridgeStatus{ID: spec.ID, State: bridgeStateFailed, Error: safeErrorDetail(err)})
			continue
		}
		running[spec.ID] = bridge
		statuses = append(statuses, bridgeStatus{ID: spec.ID, State: bridgeStateListening})
	}
	return statuses
}

// The ids of the bridges that must give up their listener: the ones the
// desired set dropped, and the ones whose shape changed (a re-awarded port, a
// flipped direction) and so have to be reopened rather than reused.
func bridgesToStop(live map[string]bridgeSpec, desired []bridgeSpec) []string {
	wanted := make(map[string]bridgeSpec, len(desired))
	for _, spec := range desired {
		wanted[spec.ID] = spec
	}
	stop := make([]string, 0)
	for id, spec := range live {
		if kept, found := wanted[id]; found && kept == spec {
			continue
		}
		stop = append(stop, id)
	}
	sort.Strings(stop)
	return stop
}

func startBridge(node *tsnet.Server, spec bridgeSpec) (*runningBridge, error) {
	if spec.ID == "" || spec.Target == "" {
		return nil, errors.New("bridge is missing an id or target")
	}

	var listener net.Listener
	var dial func() (net.Conn, error)
	var err error

	switch spec.Mode {
	case bridgeModeTsnet:
		if spec.Port <= 0 || spec.Port > 65535 {
			return nil, fmt.Errorf("bridge port %d is out of range", spec.Port)
		}
		listener, err = node.Listen("tcp", fmt.Sprintf(":%d", spec.Port))
		if err != nil {
			return nil, err
		}
		target := spec.Target
		dial = func() (net.Conn, error) { return net.DialTimeout("tcp", target, 5*time.Second) }
	case bridgeModeLocal:
		if spec.Listen == "" {
			return nil, errors.New("bridge is missing a listen address")
		}
		listener, err = net.Listen("tcp", spec.Listen)
		if err != nil {
			return nil, err
		}
		target := spec.Target
		dial = func() (net.Conn, error) {
			host, port, splitErr := net.SplitHostPort(target)
			if splitErr != nil {
				return nil, splitErr
			}
			// Reuse the peer-map resolution the mobile proxy path uses, so a
			// MagicDNS target works without a system DNS stub or TUN device.
			resolved, resolveErr := resolveRemoteAddress(node, host, port)
			if resolveErr != nil {
				return nil, resolveErr
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			return node.Dial(ctx, "tcp", resolved)
		}
	default:
		return nil, fmt.Errorf("unknown bridge mode %q", spec.Mode)
	}

	bridge := &runningBridge{
		spec:     spec,
		listener: listener,
		done:     make(chan struct{}),
		conns:    map[net.Conn]struct{}{},
	}
	go serveBridge(bridge, dial)
	return bridge, nil
}

func serveBridge(bridge *runningBridge, dial func() (net.Conn, error)) {
	defer close(bridge.done)
	for {
		incoming, err := bridge.listener.Accept()
		if err != nil {
			return
		}
		if !allowedBridgePeer(bridge.spec, incoming) {
			_ = incoming.Close()
			continue
		}
		if !bridge.track(incoming) {
			_ = incoming.Close()
			return
		}
		go func(in net.Conn) {
			defer in.Close()
			defer bridge.untrack(in)
			setKeepAlive(in)
			outgoing, err := dial()
			if err != nil {
				return
			}
			if !bridge.track(outgoing) {
				_ = outgoing.Close()
				return
			}
			defer outgoing.Close()
			defer bridge.untrack(outgoing)
			setKeepAlive(outgoing)
			go func() { _, _ = io.Copy(outgoing, in) }()
			_, _ = io.Copy(in, outgoing)
		}(incoming)
	}
}

// A tailnet listener accepts from any peer the control plane lets through. The
// host serves one device's service on a port it awarded to that device alone,
// so the awarded peer is the only one allowed to use it.
func allowedBridgePeer(spec bridgeSpec, conn net.Conn) bool {
	if spec.Peer == "" {
		return true
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return false
	}
	return host == spec.Peer
}

func sameBridgeStatuses(left, right []bridgeStatus) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
