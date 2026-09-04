import assert from "node:assert/strict";
import test from "node:test";
import { LAN_CONNECT_TIMEOUT_MS, MOBILE_HEARTBEAT_INTERVAL_MS, OVERLAY_CONTROL_URL, OVERLAY_TAILNET_DOMAIN, PROTOCOL_VERSION, TERMINAL_SCROLLBACK_LINES, VIEWPORT_KEEPALIVE_INTERVAL_MS, VIEWPORT_WATCHDOG_TIMEOUT_MS, applyTerminalModifiers, decodeClientMessage, decodeServerMessage, encodeMessage, encodePairingPayload, findHttpLinks, parsePairingPayload, parseTerminalWorkingDirectories, streamByteLength, TERMINAL_ANSI_THEME, type ClientMessage } from "./index.js";

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

test("session.buffer chunks history into grid segments and session.grid targets reflows", () => {
  const buffer = {
    type: "session.buffer",
    requestId: "r1",
    sessionId: "s1",
    segments: [
      { cols: 120, rows: 30, data: "PS C:\\> ls\r\n" },
      { cols: 45, rows: 35, data: "file.txt\r\n" }
    ],
    endOffset: 1024
  };
  const decoded = decodeServerMessage(JSON.stringify(buffer));
  assert.equal(decoded.type, "session.buffer");
  if (decoded.type !== "session.buffer") assert.fail("expected session.buffer");
  assert.equal(decoded.segments[1]?.cols, 45);
  assert.equal(decoded.segments[1]?.rows, 35);
  assert.equal(decoded.endOffset, 1024);

  const grid = decodeServerMessage(JSON.stringify({ type: "session.grid", sessionId: "s1", cols: 100, rows: 34, offset: 512 }));
  assert.equal(grid.type, "session.grid");
  assert.ok(TERMINAL_SCROLLBACK_LINES >= 50_000);
});

test("the mobile heartbeat interval is the desktop presence window source", () => {
  // The desktop Rust core counts as connected any device heard from within
  // 2x this value, so these two sides must share one constant.
  assert.equal(MOBILE_HEARTBEAT_INTERVAL_MS, 60_000);
});

test("debug.diagnostics round-trips as a fire-and-forget client message", () => {
  const message: ClientMessage = { type: "debug.diagnostics", message: "[ATSync] out off=337 len=299 upTo=636" };
  const encoded = encodeMessage(message);
  assert.equal(encoded, '{"type":"debug.diagnostics","message":"[ATSync] out off=337 len=299 upTo=636"}');
  assert.deepEqual(decodeClientMessage(encoded), message);
});

test("session.mode round-trips the three TUI modes", () => {
  for (const mode of ["canonical", "inline", "fullscreen"]) {
    const message = decodeServerMessage(JSON.stringify({ type: "session.mode", sessionId: "s1", mode, offset: 2048 }));
    assert.equal(message.type, "session.mode");
    if (message.type !== "session.mode") assert.fail("expected session.mode");
    assert.equal(message.mode, mode);
    assert.equal(message.offset, 2048);
  }
});

test("TerminalSession.tuiMode is optional so old snapshots parse cleanly", () => {
  const decoded = decodeServerMessage(JSON.stringify({
    type: "snapshot",
    snapshot: { host: { id: "h1", name: "Desktop One", version: "0.3.5" }, projects: [], sessions: [{ id: "s1", projectId: "p1", title: "pwsh", cwd: "C:\\repo", shellId: "powershell", status: "running", createdAt: "now" }], devices: [], shells: [], defaultShellId: "" }
  }));
  if (decoded.type !== "snapshot") assert.fail("expected snapshot");
  assert.equal(decoded.snapshot.sessions[0]?.tuiMode, undefined, "a legacy session without the flag must stay undefined");
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

test("stream byte lengths match the host journal's byte accounting", () => {
  assert.equal(streamByteLength("abc"), 3);
  assert.equal(streamByteLength("C:\\repo>"), 8);
  assert.equal(streamByteLength("\x1b[31m"), 5);
  assert.equal(streamByteLength("日本"), 6);
  assert.equal(streamByteLength("Ω"), 2);
  assert.equal(streamByteLength(""), 0);
});

test("stream byte lengths count surrogate pairs as four bytes each", () => {
  // PTY output can contain astral characters (emoji, exotic filename
  // glyphs); the host journal counts UTF-8 bytes and the clients must agree.
  assert.equal(streamByteLength("😀"), 4);
  assert.equal(streamByteLength("😀a"), 5);
  assert.equal(streamByteLength("a😀日本"), 1 + 4 + 6);
  assert.equal(streamByteLength("\x1b[31m😀\x1b[0m"), 5 + 4 + 4);
});

// Windows Terminal ships "Campbell" as its default scheme (microsoft/terminal
// TerminalSettingsModel/defaults.json + the conhost color table). The desktop
// and mobile terminals must both pin these exact values, so shell color
// output looks the same in this app as in the native Windows terminal.
const CAMPBELL_ANSI_THEME = {
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  magenta: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightMagenta: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2"
} as const;

test("the terminal ANSI theme pins the Windows Terminal Campbell palette", () => {
  assert.deepEqual({ ...TERMINAL_ANSI_THEME }, { ...CAMPBELL_ANSI_THEME });
});

test("the terminal ANSI theme only carries valid xterm v6 color keys and hex values", () => {
  const keys = Object.keys(TERMINAL_ANSI_THEME).sort();
  assert.deepEqual(keys, [
    "black",
    "blue",
    "brightBlack",
    "brightBlue",
    "brightCyan",
    "brightGreen",
    "brightMagenta",
    "brightRed",
    "brightWhite",
    "brightYellow",
    "cyan",
    "green",
    "magenta",
    "red",
    "white",
    "yellow"
  ]);
  for (const [key, value] of Object.entries(TERMINAL_ANSI_THEME)) {
    assert.match(String(value), /^#[0-9a-f]{6}$/i, `${key} must be a 6-digit hex color`);
  }
});

test("the terminal ANSI theme has no duplicate colors", () => {
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(TERMINAL_ANSI_THEME)) {
    const hex = String(value).toLowerCase();
    assert.ok(!seen.has(hex), `${key} duplicates the color of an earlier entry (${hex})`);
    seen.add(hex);
  }
});

test("the terminal ANSI theme bright variants are brighter than their normal pair", () => {
  const luminance = (hex: string): number => {
    const channel = (index: number): number => {
      const v = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const pairs = [
    ["black", "brightBlack"],
    ["red", "brightRed"],
    ["green", "brightGreen"],
    ["yellow", "brightYellow"],
    ["blue", "brightBlue"],
    ["magenta", "brightMagenta"],
    ["cyan", "brightCyan"],
    ["white", "brightWhite"]
  ] as const;
  for (const [normalKey, brightKey] of pairs) {
    const normal = TERMINAL_ANSI_THEME[normalKey];
    const bright = TERMINAL_ANSI_THEME[brightKey];
    assert.ok(
      luminance(bright) > luminance(normal),
      `${brightKey} (${bright}) must be brighter than ${normalKey} (${normal})`
    );
  }
});

test("the viewport keepalive window mirrors the host constants", () => {
  assert.equal(VIEWPORT_KEEPALIVE_INTERVAL_MS, 1_000);
  // The host evicts a networked client after two missed intervals.
  assert.equal(VIEWPORT_WATCHDOG_TIMEOUT_MS, 2_000);
});

test("a bare ping is a valid client message with nothing else required", () => {
  const message = decodeClientMessage({ type: "ping" });
  assert.equal(message.type, "ping");
  assert.equal(JSON.stringify(message), JSON.stringify({ type: "ping" }));
});

test("session.resize carries no force flag anymore", () => {
  const message: ClientMessage = { type: "session.resize", sessionId: "s1", cols: 120, rows: 30 };
  const roundTrip = decodeClientMessage(encodeMessage(message));
  assert.deepEqual(roundTrip, message);
  assert.equal("force" in roundTrip, false);
});
