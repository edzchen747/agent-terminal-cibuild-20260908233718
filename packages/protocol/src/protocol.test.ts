import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, applyTerminalModifiers, encodeMessage, parsePairingPayload, parseTerminalWorkingDirectories } from "./index.js";

test("pairing payloads round-trip", () => {
  const payload = {
    version: PROTOCOL_VERSION,
    hostId: "host-1",
    hostName: "Workstation",
    endpoint: "ws://192.168.1.10:47831",
    pairingToken: "one-time-secret",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  assert.deepEqual(parsePairingPayload(JSON.stringify(payload)), payload);
});

test("messages encode as JSON", () => {
  assert.equal(encodeMessage({ type: "snapshot.request", requestId: "r1" }), '{"type":"snapshot.request","requestId":"r1"}');
  assert.equal(
    encodeMessage({ type: "project.persistence", requestId: "r2", projectId: "p1", persistent: false }),
    '{"type":"project.persistence","requestId":"r2","projectId":"p1","persistent":false}'
  );
});

test("mobile terminal modifiers encode control characters", () => {
  assert.equal(applyTerminalModifiers("d", new Set(["ctrl"])), "\x04");
  assert.equal(applyTerminalModifiers("c", new Set(["ctrl"])), "\x03");
  assert.equal(applyTerminalModifiers("d", new Set(["ctrl", "alt"])), "\x1b\x04");
  assert.equal(applyTerminalModifiers("a", new Set(["shift"])), "A");
  assert.equal(applyTerminalModifiers("\t", new Set(["shift"])), "\x1b[Z");
  assert.equal(applyTerminalModifiers("\x1b[D", new Set(["ctrl"])), "\x1b[1;5D");
});

test("control modifiers do not corrupt paste or unsupported characters", () => {
  assert.equal(applyTerminalModifiers("echo hello", new Set(["ctrl"])), "echo hello");
  assert.equal(applyTerminalModifiers("1", new Set(["ctrl"])), "1");
});

test("shell working-directory reports parse from Windows Terminal OSC sequences", () => {
  assert.deepEqual(
    parseTerminalWorkingDirectories('\x1b]9;9;"C:\\Users\\Ada\\Project"\x07prompt'),
    ["C:\\Users\\Ada\\Project"]
  );
  assert.deepEqual(
    parseTerminalWorkingDirectories("\x1b]7;file:///C:/Users/Ada/Project%20One\x1b\\"),
    ["C:/Users/Ada/Project One"]
  );
});
