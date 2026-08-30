import assert from "node:assert/strict";
import test from "node:test";
import { LAN_CONNECT_TIMEOUT_MS, MOBILE_HEARTBEAT_INTERVAL_MS, OVERLAY_CONTROL_URL, OVERLAY_TAILNET_DOMAIN, PROTOCOL_VERSION, applyTerminalModifiers, decodeClientMessage, encodeMessage, encodePairingPayload, findHttpLinks, parsePairingPayload, parseTerminalWorkingDirectories } from "./index.js";
import type { ClientMessage } from "./index.js";

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

test("legacy pairing payloads discard QR-carried Headscale keys", () => {
  const decoded = parsePairingPayload(JSON.stringify({
    version: PROTOCOL_VERSION,
    hostId: "host-1",
    hostName: "Workstation",
    endpoint: "ws://192.168.1.10:47831",
    pairingToken: "one-time-secret",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nodeAuthKey: "legacy-shared-key"
  }));
  assert.equal("nodeAuthKey" in decoded, false);
});

test("network defaults keep pairing local and remote control configurable", () => {
  assert.equal(LAN_CONNECT_TIMEOUT_MS, 1_500);
  assert.equal(OVERLAY_CONTROL_URL, "https://node.hopto.org");
  const payload = parsePairingPayload(JSON.stringify({
    version: PROTOCOL_VERSION,
    hostId: "host-1",
    hostName: "Workstation",
    endpoint: "ws://192.168.1.10:47831",
    localEndpoint: "ws://192.168.1.10:47831",
    remoteEndpoint: "ws://host-1.agent-terminal.internal:47831",
    remoteTransport: "overlay",
    pairingToken: "one-time-secret",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }));
  assert.equal(payload.remoteTransport, "overlay");
  assert.equal(payload.localEndpoint, payload.endpoint);
});

test("compact pairing payloads preserve connection data", () => {
  const payload = {
    version: PROTOCOL_VERSION,
    hostId: "host-1",
    hostName: "Workstation",
    endpoint: "ws://192.168.1.10:47831",
    localEndpoint: "ws://192.168.1.10:47831",
    remoteEndpoint: `ws://host-1.${OVERLAY_TAILNET_DOMAIN}:47831`,
    controlUrl: OVERLAY_CONTROL_URL,
    transport: "direct" as const,
    remoteTransport: "overlay" as const,
    pairingToken: "one-time-secret",
    expiresAt: "2026-08-28T12:00:00.000Z"
  };
  const encoded = encodePairingPayload(payload);
  const decoded = parsePairingPayload(encoded);

  assert.ok(encoded.length < JSON.stringify(payload).length);
  assert.equal(decoded.version, payload.version);
  assert.equal(decoded.hostId, payload.hostId);
  assert.equal(decoded.hostName, payload.hostName);
  assert.equal(decoded.endpoint, payload.endpoint);
  assert.equal(decoded.localEndpoint, payload.localEndpoint);
  assert.equal(decoded.pairingToken, payload.pairingToken);
  assert.equal(decoded.expiresAt, payload.expiresAt);
  assert.equal(decoded.remoteEndpoint, undefined);
  assert.equal(decoded.controlUrl, undefined);
  assert.equal(decoded.remoteTransport, undefined);
  assert.equal(encoded.includes("node-auth-key"), false);
});

test("messages encode as JSON", () => {
  assert.equal(encodeMessage({ type: "snapshot.request", requestId: "r1" }), '{"type":"snapshot.request","requestId":"r1"}');
  assert.equal(
    encodeMessage({ type: "project.persistence", requestId: "r2", projectId: "p1", persistent: false }),
    '{"type":"project.persistence","requestId":"r2","projectId":"p1","persistent":false}'
  );
  assert.equal(
    encodeMessage({ type: "project.rename", requestId: "r3", projectId: "p1", name: "New name" }),
    '{"type":"project.rename","requestId":"r3","projectId":"p1","name":"New name"}'
  );
  assert.equal(
    encodeMessage({ type: "project.reorder", requestId: "r4", projectIds: ["p2", "p1"] }),
    '{"type":"project.reorder","requestId":"r4","projectIds":["p2","p1"]}'
  );
  assert.equal(
    encodeMessage({ type: "directory.list", requestId: "r4", path: "C:\\Users\\Ada" }),
    '{"type":"directory.list","requestId":"r4","path":"C:\\\\Users\\\\Ada"}'
  );
});

test("the default terminal syncs through a shell.default message", () => {
  const message: ClientMessage = { type: "shell.default", requestId: "r9", shellId: "git-bash" };
  const encoded = encodeMessage(message);
  assert.equal(encoded, '{"type":"shell.default","requestId":"r9","shellId":"git-bash"}');
  assert.deepEqual(decodeClientMessage(encoded), message);
});

test("shell.default survives adversarial ids and empty request ids", () => {
  const message: ClientMessage = { type: "shell.default", requestId: "", shellId: "cmd \" % \\\\ ;" };
  assert.deepEqual(decodeClientMessage(encodeMessage(message)), message);
});

test("shell.default decoding tolerates unknown fields added by newer clients", () => {
  const decoded = decodeClientMessage({ type: "shell.default", requestId: "r9", shellId: "cmd", shellArgs: ["-NoLogo"] });
  assert.deepEqual(decoded, { type: "shell.default", requestId: "r9", shellId: "cmd", shellArgs: ["-NoLogo"] });
});

test("mobile terminal modifiers encode control characters", () => {
  assert.equal(applyTerminalModifiers("d", new Set(["ctrl"])), "\x04");
  assert.equal(applyTerminalModifiers("c", new Set(["ctrl"])), "\x03");
  assert.equal(applyTerminalModifiers("d", new Set(["ctrl", "alt"])), "\x1b\x04");
  assert.equal(applyTerminalModifiers("a", new Set(["shift"])), "A");
  assert.equal(applyTerminalModifiers("\t", new Set(["shift"])), "\x1b[Z");
  assert.equal(applyTerminalModifiers("\x1b[D", new Set(["ctrl"])), "\x1b[1;5D");
  assert.equal(applyTerminalModifiers("\x7f", new Set(["ctrl"])), "\x17");
  assert.equal(applyTerminalModifiers("\x08", new Set(["ctrl"])), "\x17");
  assert.equal(applyTerminalModifiers("\x7f", new Set(["ctrl", "alt"])), "\x1b\x17");
});

test("control modifiers do not corrupt paste or unsupported characters", () => {
  assert.equal(applyTerminalModifiers("echo hello", new Set(["ctrl"])), "echo hello");
  assert.equal(applyTerminalModifiers("1", new Set(["ctrl"])), "1");
});

test("terminal link detection finds HTTP(S) URLs and excludes sentence punctuation", () => {
  assert.deepEqual(
    findHttpLinks("Access it at: http://192.168.1.218:8000. More: https://example.com/path?q=1."),
    [
      { text: "http://192.168.1.218:8000", start: 14, end: 39 },
      { text: "https://example.com/path?q=1", start: 47, end: 75 }
    ]
  );
  assert.deepEqual(findHttpLinks("not-a-http://example.com http://example.com/(docs)"), [
    { text: "http://example.com/(docs)", start: 25, end: 50 }
  ]);
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

test("the mobile heartbeat interval is the desktop presence window source", () => {
  // The desktop Rust core counts as connected any device heard from within
  // 2x this value, so these two sides must share one constant.
  assert.equal(MOBILE_HEARTBEAT_INTERVAL_MS, 60_000);
});

test("auth messages carry an optional display name through the wire contract", () => {
  const wire = encodeMessage({
    type: "auth",
    requestId: "r1",
    deviceId: "d1",
    deviceToken: "t1",
    name: "Pixel 9"
  });
  const decoded = decodeClientMessage(JSON.parse(wire));
  assert.equal(decoded.type, "auth");
  if (decoded.type !== "auth") assert.fail("expected an auth message");
  assert.equal(decoded.name, "Pixel 9");
});
