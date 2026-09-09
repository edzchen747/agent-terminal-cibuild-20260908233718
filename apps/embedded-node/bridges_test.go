package main

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBridgesToStop(t *testing.T) {
	kept := bridgeSpec{ID: "kept", Mode: bridgeModeTsnet, Port: 5173, Target: "127.0.0.1:5173"}
	dropped := bridgeSpec{ID: "dropped", Mode: bridgeModeTsnet, Port: 8080, Target: "127.0.0.1:8080"}
	reshaped := bridgeSpec{ID: "reshaped", Mode: bridgeModeTsnet, Port: 9000, Target: "127.0.0.1:9000", Peer: "100.64.0.3"}
	reawarded := reshaped
	reawarded.Peer = "100.64.0.7"

	cases := []struct {
		name    string
		live    map[string]bridgeSpec
		desired []bridgeSpec
		stop    []string
	}{
		{
			name:    "an unchanged bridge keeps its listener",
			live:    map[string]bridgeSpec{"kept": kept},
			desired: []bridgeSpec{kept},
			stop:    []string{},
		},
		{
			name:    "a bridge the desired set dropped is stopped",
			live:    map[string]bridgeSpec{"kept": kept, "dropped": dropped},
			desired: []bridgeSpec{kept},
			stop:    []string{"dropped"},
		},
		{
			name:    "a port re-awarded to another peer is reopened",
			live:    map[string]bridgeSpec{"reshaped": reshaped},
			desired: []bridgeSpec{reawarded},
			stop:    []string{"reshaped"},
		},
		{
			name:    "an empty desired set stops everything",
			live:    map[string]bridgeSpec{"kept": kept, "dropped": dropped},
			desired: nil,
			stop:    []string{"dropped", "kept"},
		},
		{
			name:    "a bridge that is not running yet needs no stop",
			live:    map[string]bridgeSpec{},
			desired: []bridgeSpec{kept, dropped},
			stop:    []string{},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := bridgesToStop(testCase.live, testCase.desired)
			if !reflect.DeepEqual(got, testCase.stop) {
				t.Fatalf("bridgesToStop = %v, want %v", got, testCase.stop)
			}
		})
	}
}

func TestReadBridgeFileTreatsAMissingOrBrokenFileAsNoBridges(t *testing.T) {
	directory := t.TempDir()
	missing := filepath.Join(directory, "bridges.json")
	if got := readBridgeFile(missing); len(got.Bridges) != 0 || got.Revision != 0 {
		t.Fatalf("a missing file must read as no bridges, got %+v", got)
	}

	if err := os.WriteFile(missing, []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := readBridgeFile(missing); len(got.Bridges) != 0 {
		t.Fatalf("a corrupt file must read as no bridges, got %+v", got)
	}

	written := bridgeFile{Revision: 7, Bridges: []bridgeSpec{{ID: "a", Mode: bridgeModeLocal, Listen: "127.0.0.1:8080", Target: "100.64.0.3:8080"}}}
	data, err := json.Marshal(written)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(missing, data, 0600); err != nil {
		t.Fatal(err)
	}
	got := readBridgeFile(missing)
	if !reflect.DeepEqual(got, written) {
		t.Fatalf("readBridgeFile = %+v, want %+v", got, written)
	}
}

func TestSameBridgeStatuses(t *testing.T) {
	listening := []bridgeStatus{{ID: "a", State: bridgeStateListening}}
	if !sameBridgeStatuses(listening, []bridgeStatus{{ID: "a", State: bridgeStateListening}}) {
		t.Fatal("identical statuses must compare equal")
	}
	if sameBridgeStatuses(listening, []bridgeStatus{{ID: "a", State: bridgeStateFailed, Error: "in use"}}) {
		t.Fatal("a bridge that started failing must be republished")
	}
	if sameBridgeStatuses(listening, nil) {
		t.Fatal("a dropped bridge must be republished")
	}
}

func TestAllowedBridgePeer(t *testing.T) {
	open := bridgeSpec{ID: "a"}
	if !allowedBridgePeer(open, stubConn{remote: "100.64.0.9:41000"}) {
		t.Fatal("a bridge with no peer allowlist must accept any peer")
	}
	awarded := bridgeSpec{ID: "a", Peer: "100.64.0.3"}
	if !allowedBridgePeer(awarded, stubConn{remote: "100.64.0.3:41000"}) {
		t.Fatal("the awarded peer must be accepted")
	}
	if allowedBridgePeer(awarded, stubConn{remote: "100.64.0.4:41000"}) {
		t.Fatal("a device that was not awarded the port must be rejected")
	}
}


func TestListeningStatusReportsAFailedDial(t *testing.T) {
	// A bridge whose listener is open but whose target refuses is the case
	// that is otherwise invisible: without this it reports as listening and
	// every connection through it just hangs.
	if got := listeningStatus("a", ""); got != (bridgeStatus{ID: "a", State: bridgeStateListening}) {
		t.Fatalf("a bridge that forwarded fine must read as listening, got %+v", got)
	}
	got := listeningStatus("a", "connection refused")
	want := bridgeStatus{ID: "a", State: bridgeStateUnreachable, Error: "connection refused"}
	if got != want {
		t.Fatalf("listeningStatus = %+v, want %+v", got, want)
	}
}

func TestNoteDialRemembersTheLastOutcome(t *testing.T) {
	bridge := &runningBridge{conns: map[net.Conn]struct{}{}}
	if bridge.lastDialError() != "" {
		t.Fatal("a bridge that has forwarded nothing yet has no error")
	}

	bridge.noteDial(errors.New("connection refused"))
	if bridge.lastDialError() != "connection refused" {
		t.Fatalf("a failed dial must be remembered, got %q", bridge.lastDialError())
	}

	// A later success means the far side came back, so the warning has to
	// clear on its own rather than needing the bridge to be rebuilt.
	bridge.noteDial(nil)
	if bridge.lastDialError() != "" {
		t.Fatalf("a successful dial must clear the error, got %q", bridge.lastDialError())
	}
}

// A net.Conn that only needs to report a remote address.
type stubConn struct {
	net.Conn
	remote string
}

func (conn stubConn) RemoteAddr() net.Addr { return stubAddr(conn.remote) }

type stubAddr string

func (addr stubAddr) Network() string { return "tcp" }
func (addr stubAddr) String() string  { return string(addr) }
