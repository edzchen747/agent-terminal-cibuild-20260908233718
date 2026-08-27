import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, applyTerminalModifiers, encodeMessage, parsePairingPayload } from "./index.js";

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
});

test("mobile terminal modifiers encode control characters", () => {
  assert.equal(applyTerminalModifiers("d", new Set(["ctrl"])), "\x04");
  assert.equal(applyTerminalModifiers("c", new Set(["ctrl"])), "\x03");
  assert.equal(applyTerminalModifiers("d", new Set(["ctrl", "alt"])), "\x1b\x04");
  assert.equal(applyTerminalModifiers("a", new Set(["shift"])), "A");
});

test("control modifiers do not corrupt paste or unsupported characters", () => {
  assert.equal(applyTerminalModifiers("echo hello", new Set(["ctrl"])), "echo hello");
  assert.equal(applyTerminalModifiers("1", new Set(["ctrl"])), "1");
});
