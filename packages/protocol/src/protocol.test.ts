import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DARK_TERMINAL_SCHEME_ID, DEFAULT_LIGHT_TERMINAL_SCHEME_ID, DEFAULT_TERMINAL_THEME_SETTINGS, LAN_CONNECT_TIMEOUT_MS, MOBILE_HEARTBEAT_INTERVAL_MS, OVERLAY_CONTROL_URL, OVERLAY_TAILNET_DOMAIN, PROTOCOL_VERSION, TERMINAL_SCROLLBACK_LINES, VIEWPORT_KEEPALIVE_INTERVAL_MS, VIEWPORT_WATCHDOG_TIMEOUT_MS, applyTerminalModifiers, decodeClientMessage, decodeServerMessage, encodeMessage, encodePairingPayload, findHttpLinks, gridForContent, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, MAX_ZOOM_FONT_SIZE, MIN_ZOOM_FONT_SIZE, parsePairingPayload, parseTerminalWorkingDirectories, streamByteLength, TERMINAL_ANSI_THEME, TERMINAL_SCHEMES, normalizeTerminalThemeSettings, resolveTerminalScheme, findDecorationsFor, terminalSchemeById, terminalSchemesFor, xtermThemeFor, squishScaleToFill, ConsoleFrame, consoleContentRows, scrollIntoScrollback, viewportContentRows, writeHostChunk, zoomedFontSize, BASELINE_TERMINAL_ZOOM, MAX_TERMINAL_ZOOM, MIN_TERMINAL_ZOOM, TERMINAL_ZOOM_STEPS, extrapolatedCell, nearestTerminalZoom, steppedTerminalZoom, terminalZoomFontSize, CLOSED_FIND, applyFindResults, closeFind, findCommandForKey, findStatusLabel, openFind, setFindQuery, type ClientMessage, type HostSnapshot } from "./index.js";

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

test("a plain layout announce carries no claim, so it can never take the grid over", () => {
  // The claim is what makes a client the grid owner, so it must never ride
  // along on an ordinary layout-driven resize: the host records an
  // unclaimed announce from a non-owner and changes nothing.
  const message: ClientMessage = { type: "session.resize", sessionId: "s1", cols: 120, rows: 30 };
  const roundTrip = decodeClientMessage(encodeMessage(message));
  assert.deepEqual(roundTrip, message);
  assert.equal("claim" in roundTrip, false);
});

test("an interaction-driven resize claims the grid on the wire", () => {
  const message: ClientMessage = { type: "session.resize", sessionId: "s1", cols: 45, rows: 36, claim: true };
  assert.equal(
    encodeMessage(message),
    '{"type":"session.resize","sessionId":"s1","cols":45,"rows":36,"claim":true}'
  );
  assert.deepEqual(decodeClientMessage(encodeMessage(message)), message);
});

test("opening a terminal claims the grid through session.attach", () => {
  // Explicitly opening a session is an interaction; a background pane
  // attaching (a desktop tab that is not the active one) omits the flag.
  const opened: ClientMessage = { type: "session.attach", requestId: "r1", sessionId: "s1", cols: 45, rows: 36, claim: true };
  assert.deepEqual(decodeClientMessage(encodeMessage(opened)), opened);
  const background: ClientMessage = { type: "session.attach", requestId: "r2", sessionId: "s1", cols: 210, rows: 66 };
  const roundTrip = decodeClientMessage(encodeMessage(background));
  assert.deepEqual(roundTrip, background);
  assert.equal("claim" in roundTrip, false);
});

test("session.viewport.release leaves set S without leaving the stream", () => {
  // A hidden desktop tab or a backgrounded phone sends this instead of
  // session.detach: it stays attached (still receiving output) but drops
  // out of the fallback pool, so it can never be handed the grid back
  // while it is not actually shown.
  const message: ClientMessage = { type: "session.viewport.release", requestId: "r1", sessionId: "s1" };
  assert.equal(
    encodeMessage(message),
    '{"type":"session.viewport.release","requestId":"r1","sessionId":"s1"}'
  );
  assert.deepEqual(decodeClientMessage(encodeMessage(message)), message);
});

const ANSI_KEYS = Object.keys(TERMINAL_ANSI_THEME) as (keyof typeof TERMINAL_ANSI_THEME)[];

function channels(hex: string): [number, number, number] {
  const value = hex.slice(1, 7);
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const linear = channels(hex).map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(first: string, second: string): number {
  const [a, b] = [relativeLuminance(first), relativeLuminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("every terminal scheme is a complete, well-formed palette", () => {
  assert.ok(TERMINAL_SCHEMES.length > 0);
  const ids = new Set<string>();
  for (const scheme of TERMINAL_SCHEMES) {
    assert.ok(!ids.has(scheme.id), `duplicate scheme id ${scheme.id}`);
    ids.add(scheme.id);
    assert.match(scheme.id, /^[a-z0-9-]+$/, `${scheme.id} must be a url-safe id`);
    assert.ok(scheme.name.length > 0, `${scheme.id} needs a display name`);
    assert.ok(scheme.mode === "dark" || scheme.mode === "light");
    for (const surface of [scheme.background, scheme.foreground, scheme.cursor, scheme.cursorAccent]) {
      assert.match(surface, /^#[0-9A-Fa-f]{6}$/, `${scheme.id} surface colors must be 6-digit hex`);
    }
    assert.match(scheme.selectionBackground, /^#[0-9A-Fa-f]{6,8}$/);
    // A partial palette would leave xterm falling back to its own Tango
    // defaults for the missing slots, which is exactly the drift the shared
    // table exists to prevent.
    assert.deepEqual(Object.keys(scheme.ansi).sort(), [...ANSI_KEYS].sort(), `${scheme.id} must define all 16 ANSI colors`);
    for (const [key, color] of Object.entries(scheme.ansi)) {
      assert.match(color, /^#[0-9A-Fa-f]{6}$/, `${scheme.id}.${key} must be 6-digit hex`);
    }
  }
});

test("both modes offer schemes and the defaults belong to their own mode", () => {
  assert.ok(terminalSchemesFor("dark").length >= 2);
  assert.ok(terminalSchemesFor("light").length >= 2);
  for (const scheme of terminalSchemesFor("dark")) assert.equal(scheme.mode, "dark");
  for (const scheme of terminalSchemesFor("light")) assert.equal(scheme.mode, "light");
  assert.equal(terminalSchemeById(DEFAULT_DARK_TERMINAL_SCHEME_ID)?.mode, "dark");
  assert.equal(terminalSchemeById(DEFAULT_LIGHT_TERMINAL_SCHEME_ID)?.mode, "light");
  assert.deepEqual(DEFAULT_TERMINAL_THEME_SETTINGS, {
    darkSchemeId: DEFAULT_DARK_TERMINAL_SCHEME_ID,
    lightSchemeId: DEFAULT_LIGHT_TERMINAL_SCHEME_ID
  });
});

test("the default dark scheme is still the native Windows Campbell palette", () => {
  // The desktop must keep looking like the Windows terminal out of the box.
  const campbell = terminalSchemeById(DEFAULT_DARK_TERMINAL_SCHEME_ID)!;
  assert.equal(campbell.background, "#0C0C0C");
  assert.equal(campbell.foreground, "#CCCCCC");
  assert.deepEqual(campbell.ansi, TERMINAL_ANSI_THEME);
});

test("a scheme id from the wrong mode falls back instead of painting an unreadable terminal", () => {
  // The whole point of the mode split: a dark palette on a light background
  // hides every glyph a program prints in ANSI black.
  assert.equal(resolveTerminalScheme("one-half-light", "dark").id, DEFAULT_DARK_TERMINAL_SCHEME_ID);
  assert.equal(resolveTerminalScheme("campbell", "light").id, DEFAULT_LIGHT_TERMINAL_SCHEME_ID);
  assert.equal(resolveTerminalScheme("no-such-scheme", "dark").id, DEFAULT_DARK_TERMINAL_SCHEME_ID);
  assert.equal(resolveTerminalScheme(undefined, "light").id, DEFAULT_LIGHT_TERMINAL_SCHEME_ID);
  assert.equal(resolveTerminalScheme("solarized-dark", "dark").id, "solarized-dark");
  assert.equal(resolveTerminalScheme("novel", "light").id, "novel");
});

test("stored settings are normalized into a matching dark/light pair", () => {
  assert.deepEqual(normalizeTerminalThemeSettings(null), DEFAULT_TERMINAL_THEME_SETTINGS);
  assert.deepEqual(normalizeTerminalThemeSettings({ darkSchemeId: "novel", lightSchemeId: "vintage" }), DEFAULT_TERMINAL_THEME_SETTINGS);
  assert.deepEqual(
    normalizeTerminalThemeSettings({ darkSchemeId: "vintage", lightSchemeId: "novel" }),
    { darkSchemeId: "vintage", lightSchemeId: "novel" }
  );
});

test("every scheme keeps its own text legible on its own background", () => {
  for (const scheme of TERMINAL_SCHEMES) {
    assert.ok(
      contrast(scheme.foreground, scheme.background) >= 4.5,
      `${scheme.id}: foreground ${scheme.foreground} on ${scheme.background} is too faint`
    );
  }
});

test("light schemes keep ANSI-black text readable on their background", () => {
  // The hazard that makes schemes indivisible: most palettes render ANSI
  // black as near-black, so a light background needs a scheme whose black is
  // still dark enough to read, not a dark scheme's palette.
  for (const scheme of terminalSchemesFor("light")) {
    assert.ok(
      contrast(scheme.ansi.black, scheme.background) >= 4.5,
      `${scheme.id}: ANSI black ${scheme.ansi.black} is unreadable on ${scheme.background}`
    );
    assert.ok(relativeLuminance(scheme.background) > 0.5, `${scheme.id} must have a light background`);
  }
  for (const scheme of terminalSchemesFor("dark")) {
    assert.ok(relativeLuminance(scheme.background) < 0.25, `${scheme.id} must have a dark background`);
  }
});

test("xtermThemeFor flattens a scheme into the shape xterm expects", () => {
  const theme = xtermThemeFor(terminalSchemeById("solarized-light")!);
  assert.equal(theme.background, "#FDF6E3");
  assert.equal(theme.foreground, "#073642");
  for (const key of ANSI_KEYS) assert.ok(key in theme, `xterm theme is missing ${key}`);
});

test("terminal.theme carries the shared scheme pair through the wire contract", () => {
  const message: ClientMessage = { type: "terminal.theme", requestId: "r9", darkSchemeId: "vintage", lightSchemeId: "novel" };
  assert.deepEqual(decodeClientMessage(encodeMessage(message)), message);
});

test("a snapshot from a host older than terminal themes still resolves a scheme", () => {
  // Regression: the phone pairs with whatever desktop build is installed, and
  // one older than this field sends no terminalTheme at all. Reaching into it
  // threw on every render and blanked the mobile app after its first snapshot.
  const legacy = { defaultShellId: "powershell" } as Partial<HostSnapshot>;
  const settings = normalizeTerminalThemeSettings(legacy.terminalTheme);
  assert.deepEqual(settings, DEFAULT_TERMINAL_THEME_SETTINGS);
  assert.equal(resolveTerminalScheme(settings.darkSchemeId, "dark").mode, "dark");
  assert.equal(resolveTerminalScheme(settings.lightSchemeId, "light").mode, "light");
});

test("garbage scheme ids off the wire still resolve to a usable scheme", () => {
  // Snapshots are JSON from another machine: the declared string type is a
  // promise, not a guarantee. Anything unusable must land on the mode default
  // rather than reaching xterm and painting an unreadable terminal.
  const junk = ["", "   ", "CAMPBELL", "Campbell", "campbell ", "../campbell", null, undefined, 7, {}, [], true];
  for (const value of junk) {
    for (const mode of ["dark", "light"] as const) {
      const scheme = resolveTerminalScheme(value as unknown as string | undefined, mode);
      assert.equal(scheme.mode, mode, `${JSON.stringify(value)} must resolve to a ${mode} scheme`);
      assert.ok(terminalSchemeById(scheme.id), `${JSON.stringify(value)} resolved to an unknown scheme`);
    }
    const settings = normalizeTerminalThemeSettings({ darkSchemeId: value, lightSchemeId: value } as never);
    assert.equal(terminalSchemeById(settings.darkSchemeId)?.mode, "dark");
    assert.equal(terminalSchemeById(settings.lightSchemeId)?.mode, "light");
  }
});

test("a half-filled settings pair keeps the good half and defaults the other", () => {
  assert.deepEqual(normalizeTerminalThemeSettings({ darkSchemeId: "vintage" }), {
    darkSchemeId: "vintage",
    lightSchemeId: DEFAULT_LIGHT_TERMINAL_SCHEME_ID
  });
  assert.deepEqual(normalizeTerminalThemeSettings({ lightSchemeId: "novel" }), {
    darkSchemeId: DEFAULT_DARK_TERMINAL_SCHEME_ID,
    lightSchemeId: "novel"
  });
  // Normalizing is idempotent: feeding a result back changes nothing.
  const once = normalizeTerminalThemeSettings({ darkSchemeId: "novel", lightSchemeId: "vintage" });
  assert.deepEqual(normalizeTerminalThemeSettings(once), once);
});

test("xtermThemeFor leaks no scheme metadata into the xterm theme", () => {
  // id/name/mode are ours, not xterm's. Passing them through would put unknown
  // keys in the emulator's theme option.
  const allowed = new Set(["background", "foreground", "cursor", "cursorAccent", "selectionBackground", ...ANSI_KEYS]);
  for (const scheme of TERMINAL_SCHEMES) {
    for (const key of Object.keys(xtermThemeFor(scheme))) {
      assert.ok(allowed.has(key), `${scheme.id}: xterm theme must not carry ${key}`);
    }
  }
});

test("xtermThemeFor hands out a fresh object so one client cannot recolor another", () => {
  // Both terminals resolve the same shared scheme object; if the flattened
  // theme aliased it, an emulator mutating its own theme would repaint every
  // other client's.
  const scheme = terminalSchemeById("campbell")!;
  const first = xtermThemeFor(scheme);
  first.background = "#ff00ff";
  first.black = "#ff00ff";
  assert.equal(scheme.background, "#0C0C0C", "the shared scheme must be untouched");
  assert.equal(scheme.ansi.black, "#0C0C0C", "the shared palette must be untouched");
  assert.equal(xtermThemeFor(scheme).background, "#0C0C0C");
  assert.notEqual(xtermThemeFor(scheme), first);
});

test("scheme names are unique so a picker never shows the same label twice", () => {
  const names = TERMINAL_SCHEMES.map((scheme) => scheme.name);
  assert.equal(new Set(names).size, names.length, `duplicate scheme name in ${names.join(", ")}`);
});

test("the two modes never share a scheme id", () => {
  // An id in both lists would make the mode check in resolveTerminalScheme
  // ambiguous, and let one picker's choice satisfy the other's guard.
  const dark = new Set(terminalSchemesFor("dark").map((scheme) => scheme.id));
  for (const scheme of terminalSchemesFor("light")) {
    assert.ok(!dark.has(scheme.id), `${scheme.id} is registered as both dark and light`);
  }
  assert.equal(terminalSchemesFor("dark").length + terminalSchemesFor("light").length, TERMINAL_SCHEMES.length);
});

// gridForContent: the grid a content box holds at a given cell size. Both
// desktop and mobile clients announce this (never a raw FitAddon proposal)
// so the viewport they report the host stays exactly what their own content
// box - not their border box - can hold.
test("gridForContent computes whole cells from the content box", () => {
  const cell = { width: 8.05, height: 16.1026 };
  const grid = gridForContent({ width: 922, height: 623.51 }, cell);
  assert.deepEqual(grid, { cols: 114, rows: 38 });
});

test("gridForContent keeps a row whose fit is exact but lands under it in floating point", () => {
  const exact = { width: 8, height: 16.1026 };
  const grid = gridForContent({ width: 800, height: 65 * exact.height }, exact);
  assert.deepEqual(grid, { cols: 100, rows: 65 });
});

test("gridForContent reflects the pane's real content box, not its border box (half-screen snap regression)", () => {
  // Measured: a 1067.12px tall stack with 14px of vertical letterbox padding
  // leaves a 1053.12px content box, which holds 65 rows - not the 66 a
  // border-box measurement would suggest.
  const cell = { width: 8.05, height: 16.1026 };
  const grid = gridForContent({ width: 1050, height: 1067.12 - 14 }, cell);
  assert.equal(grid?.rows, 65);
});

test("gridForContent floors a content box too small for the minimum grid", () => {
  const cell = { width: 8.05, height: 16.1026 };
  assert.deepEqual(gridForContent({ width: 9, height: 12 }, cell), { cols: 2, rows: 1 });
});

test("gridForContent returns null, not a floored grid, when a measurement is not yet usable", () => {
  // A pane the layout has not sized yet reports 0; computed padding on a
  // detached element parses to NaN. Neither is grounds for clamping to the
  // 2x1 floor - the caller falls back to its own default instead.
  const cell = { width: 8.05, height: 16.1026 };
  assert.equal(gridForContent({ width: 922, height: 623.51 }, null), null);
  assert.equal(gridForContent({ width: 922, height: 623.51 }, { width: 0, height: 0 }), null);
  assert.equal(gridForContent({ width: 0, height: 623.51 }, cell), null);
  assert.equal(gridForContent({ width: Number.NaN, height: 623.51 }, cell), null);
  assert.equal(gridForContent({ width: 922, height: -14 }, cell), null);
  assert.equal(gridForContent({ width: 922, height: 623.51 }, { width: Number.NaN, height: 16 }), null);
});

// zoomedFontSize: the render-only counterpart to gridForContent. It never
// feeds the announcement (see gridForContent above) - only xterm's fontSize -
// so raising it can never shrink the announced grid and ratchet the session
// down to a couple of columns.
test("zoomedFontSize grows the font to fill the content box's tighter axis", () => {
  // A 10x5 grid at a {8,16} cell is 80x80px. A 200x100 box has 2.5x headroom
  // on width but only 1.25x on height, so height wins and the cell aspect
  // ratio is preserved.
  const next = zoomedFontSize(14, { cols: 10, rows: 5 }, { width: 8, height: 16 }, { width: 200, height: 100 });
  assert.equal(next, 17.5);
});

test("zoomedFontSize shrinks the font when the grid overflows the content box", () => {
  const next = zoomedFontSize(14, { cols: 10, rows: 5 }, { width: 8, height: 16 }, { width: 40, height: 40 });
  assert.equal(next, 7);
});

test("zoomedFontSize returns null once the correction is under the 0.05px tolerance", () => {
  // Stops the caller's fixed-point correction loop instead of oscillating
  // over glyph-advance rounding between font sizes.
  const next = zoomedFontSize(14, { cols: 10, rows: 5 }, { width: 8, height: 16 }, { width: 1000, height: 80.16 });
  assert.equal(next, null);
});

test("zoomedFontSize clamps to a sanity band but never caps ordinary zoom-in", () => {
  assert.equal(zoomedFontSize(14, { cols: 1, rows: 1 }, { width: 1, height: 1 }, { width: 100_000, height: 100_000 }), 400);
  assert.equal(zoomedFontSize(14, { cols: 1, rows: 1 }, { width: 1, height: 1 }, { width: 0.001, height: 1_000 }), 4);
});

test("zoomedFontSize returns null for unusable inputs instead of a bad font size", () => {
  assert.equal(zoomedFontSize(0, { cols: 10, rows: 5 }, { width: 8, height: 16 }, { width: 200, height: 100 }), null);
  assert.equal(zoomedFontSize(-14, { cols: 10, rows: 5 }, { width: 8, height: 16 }, { width: 200, height: 100 }), null);
  assert.equal(zoomedFontSize(14, { cols: 10, rows: 5 }, null, { width: 200, height: 100 }), null);
  assert.equal(zoomedFontSize(14, { cols: 10, rows: 5 }, { width: 8, height: 16 }, null), null);
  assert.equal(zoomedFontSize(14, { cols: 0, rows: 5 }, { width: 8, height: 16 }, { width: 200, height: 100 }), null);
  assert.equal(zoomedFontSize(14, { cols: 10, rows: 0 }, { width: 8, height: 16 }, { width: 200, height: 100 }), null);
  assert.equal(zoomedFontSize(14, { cols: 10, rows: 5 }, { width: 0, height: 16 }, { width: 200, height: 100 }), null);
});

// squishScaleToFill: the phone's slider sets how narrow cells MAY go, so the
// terminal always spans the screen - it never leaves the slider's fraction of
// the width painted and the rest dead.
test("squishScaleToFill keeps the slider's density when the phone got the columns it asked for", () => {
  // 86 columns announced at 0.65 density fill a 404px box exactly:
  // 86 * 7.2 * 0.65 = 402.5, so the cells stay at the user's width.
  const scale = squishScaleToFill({ cols: 86, rows: 43 }, { width: 7.2, height: 16 }, { width: 404, height: 688 }, 0.65);
  assert.ok(scale !== null);
  assert.ok(Math.abs(scale! - 0.6524) < 0.001, `expected ~0.65, got ${scale}`);
});

test("squishScaleToFill relaxes the cells when the grid is narrower than the box", () => {
  // The phone asked for 86 columns but renders a 56-column grid (another
  // client owns it). Squishing to 0.65 would paint 262px of a 404px screen;
  // relaxing to ~1.0 spans it instead.
  const scale = squishScaleToFill({ cols: 56, rows: 43 }, { width: 7.2, height: 16 }, { width: 404, height: 688 }, 0.65);
  assert.equal(scale, 1, "cells never stretch past their natural width, but they do fill");
});

test("squishScaleToFill never squishes past the slider when the grid overflows", () => {
  // A far wider grid than the box can hold at any allowed density: the paint
  // scale bottoms out at the slider value and the font size (zoomedFontSize)
  // shrinks the rest.
  const scale = squishScaleToFill({ cols: 190, rows: 50 }, { width: 7.2, height: 16 }, { width: 404, height: 688 }, 0.65);
  assert.equal(scale, 0.65);
});

test("squishScaleToFill returns null for unusable inputs", () => {
  assert.equal(squishScaleToFill({ cols: 86, rows: 43 }, null, { width: 404, height: 688 }, 0.65), null);
  assert.equal(squishScaleToFill({ cols: 86, rows: 43 }, { width: 7.2, height: 16 }, null, 0.65), null);
  assert.equal(squishScaleToFill({ cols: 0, rows: 43 }, { width: 7.2, height: 16 }, { width: 404, height: 688 }, 0.65), null);
  assert.equal(squishScaleToFill({ cols: 86, rows: 43 }, { width: 7.2, height: 16 }, { width: 404, height: 688 }, 0), null);
  assert.equal(squishScaleToFill({ cols: 86, rows: 43 }, { width: 7.2, height: 16 }, { width: 404, height: 688 }, Number.NaN), null);
});


// --- Console frame: growing without eating (or duplicating) history -------

/**
 * A stand-in for the parts of xterm.js `ConsoleFrame` touches, with the
 * behaviour that causes the bug: growing the row count pulls lines back out
 * of the scrollback (baseY drops).
 */
function fakeTerminal(cols: number, rows: number, content: string[], baseY: number) {
  const writes: string[] = [];
  return {
    cols,
    rows,
    writes,
    buffer: {
      active: {
        baseY,
        type: "normal",
        getLine(index: number) {
          const line = content[index] ?? "";
          return { translateToString: () => line };
        }
      }
    },
    resize(nextCols: number, nextRows: number) {
      const reclaimed = Math.max(0, Math.min(this.buffer.active.baseY, nextRows - this.rows));
      this.buffer.active.baseY -= reclaimed;
      this.cols = nextCols;
      this.rows = nextRows;
    },
    write(data: string) { writes.push(data); }
  };
}

/** A ConPTY resize repaint: pen setup, home, `rows` drawn rows, cursor home. */
function conptyRepaint(rows: number, contentRows: number): string {
  const drawn = Array.from({ length: rows }, (_, row) => (row < contentRows ? `row ${row + 1}\x1b[K` : "\x1b[K"));
  return `\x1b[?25l\x1b[34m\x1b[1m\x1b[H${drawn.join("\r\n")}\x1b[${contentRows};3H\x1b[?25h`;
}

test("consoleContentRows reads the console's last content row off a repaint", () => {
  assert.equal(consoleContentRows(conptyRepaint(38, 24), 38), 24);
  // Signed off with relative motion: the cursor is where the drawing ended,
  // so the console has no blank rows below its content.
  assert.equal(consoleContentRows("\x1b[?25l\x1b[Hrow\x1b[K\x1b[1C\x1b[?25h", 24), 24);
  // Not a repaint at all.
  assert.equal(consoleContentRows("plain output\r\n", 24), null);
  assert.equal(consoleContentRows("\x1b[Hmoved but never hid the cursor", 24), null);
  // Never past the grid.
  assert.equal(consoleContentRows("\x1b[?25l\x1b[Hx\x1b[99;3H\x1b[?25h", 24), 24);
});

test("viewportContentRows ignores the blank rows under the content", () => {
  const terminal = fakeTerminal(80, 6, ["a", "b", "c", "", "", ""], 0);
  assert.equal(viewportContentRows(terminal), 3);
  assert.equal(viewportContentRows(fakeTerminal(80, 3, ["", "", ""], 0)), 0);
});

test("applying the same grid is a no-op", () => {
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, [], 10);
  assert.equal(frame.applyGrid(terminal, 80, 24), false);
  // No grid change means no repaint to expect, so the next chunk is ordinary.
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(24, 12)), "");
});

test("a grow aligns the frame to the console's, pushing only the rows the repaint will not redraw", () => {
  // The phone had the grid at 73x24; the desktop takes it back at 112x38.
  // xterm reclaims 21 lines to fill the taller viewport, but the console's
  // screen is only 24 rows of content - so the 12 rows above those belong in
  // the scrollback, not under the repaint's blank padding.
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(73, 24, Array.from({ length: 59 }, (_, i) => `line ${i}`), 21);
  assert.equal(frame.applyGrid(terminal, 112, 38), true);
  assert.equal(terminal.buffer.active.baseY, 7, "xterm reclaimed 14 lines to fill the taller viewport");
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(38, 24)), "\x1b7\x1b[38;1H" + "\n".repeat(14) + "\x1b8");
});

test("a viewport the repaint fully covers needs no alignment", () => {
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, Array.from({ length: 24 }, (_, i) => `line ${i}`), 0);
  assert.equal(frame.applyGrid(terminal, 80, 30), true);
  // The console has content all the way down: nothing of the client's is
  // left unpainted, so nothing has to move.
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(30, 30)), "");
});

test("only the chunk that answers a grid change is ever aligned", () => {
  const frame = new ConsoleFrame();
  const rows = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const terminal = fakeTerminal(80, 38, rows, 2);
  frame.applyGrid(terminal, 80, 38 + 1);
  // Ordinary output consumes the expectation without touching the buffer...
  assert.equal(frame.alignmentFor(terminal, "just some output\r\n"), "");
  // ...so a repaint arriving later (a TUI redrawing itself, say) is not
  // treated as a resize repaint.
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(39, 10)), "");
});

test("the alternate screen is never realigned", () => {
  // A fullscreen TUI owns the alt buffer, which has no scrollback to protect
  // and would simply lose the rows a push scrolled away.
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, Array.from({ length: 24 }, (_, i) => `line ${i}`), 0);
  terminal.buffer.active.type = "alternate";
  frame.applyGrid(terminal, 80, 38);
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(38, 10)), "");
});

test("writeHostChunk writes the alignment before the chunk, and nothing extra otherwise", () => {
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(73, 24, Array.from({ length: 59 }, (_, i) => `line ${i}`), 21);
  frame.applyGrid(terminal, 112, 38);
  const repaint = conptyRepaint(38, 24);
  writeHostChunk(frame, terminal, repaint);
  assert.deepEqual(terminal.writes, ["\x1b7\x1b[38;1H" + "\n".repeat(14) + "\x1b8", repaint]);
  writeHostChunk(frame, terminal, "more output");
  assert.deepEqual(terminal.writes.slice(2), ["more output"]);
});

test("scrollIntoScrollback parks the cursor on the last row and restores it", () => {
  // DECSC/DECRC save the cursor's place in the buffer, so it survives the
  // line feeds that move the content; only a line feed on the last row
  // scrolls a line INTO the scrollback, which is why the cursor goes there.
  assert.equal(scrollIntoScrollback(3, 40), "\x1b7\x1b[40;1H\n\n\n\x1b8");
  assert.equal(scrollIntoScrollback(0, 40), "");
  assert.equal(scrollIntoScrollback(-2, 40), "");
  assert.equal(scrollIntoScrollback(3, 0), "");
});

// --- Console frame: edge cases -------------------------------------------

test("a repaint merged with the prompt fixup behind it still reports the console's rows", () => {
  // The host merges PTY writes that land within a couple of milliseconds, so
  // the shell's own `\r$ CSI K` touch-up can ride along in the same chunk.
  // The cursor is read off the show-cursor that closes the repaint, not off
  // the end of the chunk.
  const merged = conptyRepaint(38, 24) + "\r$\x1b[K\x1b[1C";
  assert.equal(consoleContentRows(merged, 38), 24);
});

test("consoleContentRows keeps a cursor row inside the grid", () => {
  // A row of 0 is not addressable (rows are 1-based) and a row past the grid
  // would ask for a negative number of blank rows.
  assert.equal(consoleContentRows("\x1b[?25l\x1b[Hx\x1b[0;1H\x1b[?25h", 24), 1);
  assert.equal(consoleContentRows("\x1b[?25l\x1b[Hx\x1b[900;1H\x1b[?25h", 24), 24);
});

test("consoleContentRows accepts the pen ConPTY actually sets up", () => {
  // Any run of SGR before the home, including 256-colour and sub-parameter
  // forms, is still just a pen: it paints nothing.
  assert.equal(consoleContentRows("\x1b[?25l\x1b[38;5;12m\x1b[1m\x1b[Hx\x1b[4;1H\x1b[?25h", 10), 4);
  assert.equal(consoleContentRows("\x1b[?25l\x1b[38:2::255:0:0m\x1b[Hx\x1b[4;1H\x1b[?25h", 10), 4);
  // A cursor move that is not a home means the chunk is not a full repaint.
  assert.equal(consoleContentRows("\x1b[?25l\x1b[2;1Hx\x1b[4;1H\x1b[?25h", 10), null);
});

test("an empty chunk leaves the repaint still expected", () => {
  // A zero-length segment performs a grid swap and nothing else; the repaint
  // is in the chunk after it.
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, Array.from({ length: 40 }, (_, i) => `line ${i}`), 16);
  frame.applyGrid(terminal, 80, 38);
  assert.equal(frame.alignmentFor(terminal, ""), "");
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(38, 20)), "\x1b7\x1b[38;1H" + "\n".repeat(18) + "\x1b8");
});

test("a console holding more rows than the client never pushes a negative count", () => {
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, ["only", "three", "lines"], 0);
  frame.applyGrid(terminal, 80, 38);
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(38, 30)), "");
});

test("viewportContentRows survives a buffer shorter than the grid", () => {
  // A freshly reset emulator can be asked for rows it has no lines for.
  const terminal = fakeTerminal(80, 24, ["first"], 0);
  assert.equal(viewportContentRows(terminal), 1);
  assert.equal(viewportContentRows(fakeTerminal(80, 24, [], 0)), 0);
});

test("a whitespace-only row counts as blank, matching the console's padding", () => {
  const terminal = fakeTerminal(80, 5, ["a", "b", "   ", "", ""], 0);
  assert.equal(viewportContentRows(terminal), 2);
});

test("the frame realigns again on the next grid change", () => {
  // Ownership can bounce between clients repeatedly; each grid change arms
  // the alignment exactly once.
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, Array.from({ length: 60 }, (_, i) => `line ${i}`), 36);
  frame.applyGrid(terminal, 80, 30);
  assert.notEqual(frame.alignmentFor(terminal, conptyRepaint(30, 20)), "");
  assert.equal(frame.alignmentFor(terminal, conptyRepaint(30, 20)), "", "one repaint per grid change");
  frame.applyGrid(terminal, 80, 36);
  assert.notEqual(frame.alignmentFor(terminal, conptyRepaint(36, 20)), "");
});

test("writeHostChunk passes the callback through even when nothing is aligned", () => {
  const frame = new ConsoleFrame();
  const terminal = fakeTerminal(80, 24, [], 0);
  let done = 0;
  writeHostChunk(frame, terminal, "output", () => { done += 1; });
  assert.equal(terminal.writes.length, 1);
  // The fake runs the callback itself only if given one; assert the shape the
  // real emulator relies on instead: the chunk is the last thing written.
  assert.equal(terminal.writes.at(-1), "output");
  assert.equal(done, 0);
});

test("the zoom ladder is ascending, spans 25%-200%, and includes the baseline", () => {
  assert.equal(MIN_TERMINAL_ZOOM, 25);
  assert.equal(MAX_TERMINAL_ZOOM, 200);
  assert.ok(TERMINAL_ZOOM_STEPS.includes(BASELINE_TERMINAL_ZOOM));
  for (let i = 1; i < TERMINAL_ZOOM_STEPS.length; i += 1) {
    assert.ok(TERMINAL_ZOOM_STEPS[i]! > TERMINAL_ZOOM_STEPS[i - 1]!, `step ${i} does not ascend`);
  }
});

test("zoom steps are fine at the bottom of the ladder and coarse at the top", () => {
  const gap = (from: number) => steppedTerminalZoom(from, 1) - from;
  assert.equal(gap(25), 5);
  assert.equal(gap(45), 5);
  assert.equal(gap(50), 10);
  assert.equal(gap(90), 10);
  assert.equal(gap(100), 25);
  assert.equal(gap(175), 25);
});

test("stepping walks one stop at a time and clamps at both ends", () => {
  assert.equal(steppedTerminalZoom(100, -1), 90);
  assert.equal(steppedTerminalZoom(90, 1), 100);
  assert.equal(steppedTerminalZoom(MIN_TERMINAL_ZOOM, -1), MIN_TERMINAL_ZOOM);
  assert.equal(steppedTerminalZoom(MAX_TERMINAL_ZOOM, 1), MAX_TERMINAL_ZOOM);
});

test("stepping off the ladder moves one stop rather than snapping past it", () => {
  assert.equal(steppedTerminalZoom(112, 1), 125);
  assert.equal(steppedTerminalZoom(112, -1), 100);
  assert.equal(steppedTerminalZoom(1_000, -1), 200);
  assert.equal(steppedTerminalZoom(1, 1), 25);
  assert.equal(steppedTerminalZoom(Number.NaN, 1), 125);
});

test("a zoom settles on the nearest stop, and a corrupt one on the baseline", () => {
  assert.equal(nearestTerminalZoom(103), 100);
  assert.equal(nearestTerminalZoom(118), 125);
  assert.equal(nearestTerminalZoom(0), 25);
  assert.equal(nearestTerminalZoom(10_000), 200);
  assert.equal(nearestTerminalZoom(Number.NaN), BASELINE_TERMINAL_ZOOM);
});

test("a zoom stop paints at its own share of the baseline font size", () => {
  assert.equal(terminalZoomFontSize(14, 100), 14);
  assert.equal(terminalZoomFontSize(14, 200), 28);
  assert.equal(terminalZoomFontSize(14, 50), 7);
  // The bottom of the ladder is clamped into the shared font band rather
  // than emitting the raw 3.5px, which is under what a browser will lay DOM
  // text out at and so paints as overlapping glyphs.
  assert.equal(terminalZoomFontSize(14, 25), MIN_ZOOM_FONT_SIZE);
  assert.equal(terminalZoomFontSize(4000, 200), MAX_ZOOM_FONT_SIZE);
  // Off-ladder and unusable inputs settle the same way the ladder does.
  assert.equal(terminalZoomFontSize(14, 103), 14);
  assert.equal(terminalZoomFontSize(0, 150), 0);
  assert.equal(terminalZoomFontSize(Number.NaN, 150), 0);
});

test("every zoom stop maps to a distinct font size, ascending with the stop", () => {
  const sizes = TERMINAL_ZOOM_STEPS.map((step) => terminalZoomFontSize(14, step));
  assert.equal(new Set(sizes).size, sizes.length);
  for (let i = 1; i < sizes.length; i += 1) assert.ok(sizes[i]! > sizes[i - 1]!, `stop ${i} does not grow`);
});

test("a font size is a pure function of the stop, never of the grid it produced", () => {
  // The property the whole design rests on: measuring a cell, announcing a
  // grid from it and painting that grid must land back on the same size.
  const content = { width: 800, height: 400 };
  const cellAt = (fontSize: number) => ({ width: fontSize * 0.6, height: fontSize * 1.2 });
  for (const step of TERMINAL_ZOOM_STEPS) {
    const fontSize = terminalZoomFontSize(14, step);
    const grid = gridForContent(content, cellAt(fontSize))!;
    // The grid never overflows the box, and never leaves a whole cell spare.
    assert.ok(grid.cols * cellAt(fontSize).width <= content.width + 0.01, `cols overflow at ${step}%`);
    assert.ok(grid.rows * cellAt(fontSize).height <= content.height + 0.01, `rows overflow at ${step}%`);
    assert.ok((grid.cols + 1) * cellAt(fontSize).width > content.width, `a whole column spare at ${step}%`);
    assert.ok((grid.rows + 1) * cellAt(fontSize).height > content.height, `a whole row spare at ${step}%`);
    assert.equal(terminalZoomFontSize(14, step), fontSize);
  }
});

test("a zoomed grid is proportionally smaller than the baseline one", () => {
  const content = { width: 800, height: 400 };
  const cellAt = (fontSize: number) => ({ width: fontSize * 0.5, height: fontSize });
  assert.deepEqual(gridForContent(content, cellAt(terminalZoomFontSize(16, 100))), { cols: 100, rows: 25 });
  assert.deepEqual(gridForContent(content, cellAt(terminalZoomFontSize(16, 200))), { cols: 50, rows: 12 });
  assert.deepEqual(gridForContent(content, cellAt(terminalZoomFontSize(16, 50))), { cols: 200, rows: 50 });
});

test("an unpainted stop extrapolates from the nearest measured cell", () => {
  assert.deepEqual(extrapolatedCell({ width: 8, height: 16 }, 14, 28), { width: 16, height: 32 });
  assert.deepEqual(extrapolatedCell({ width: 8, height: 16 }, 14, 14), { width: 8, height: 16 });
  assert.equal(extrapolatedCell(null, 14, 28), null);
  assert.equal(extrapolatedCell({ width: 8, height: 16 }, 0, 28), null);
  assert.equal(extrapolatedCell({ width: 8, height: 16 }, 14, 0), null);
});

test("a grid is capped at the host's ceiling, so a client cannot announce one it would rewrite", () => {
  // A 1px cell over a huge box: uncapped this would be tens of thousands of
  // cells on both axes.
  const huge = gridForContent({ width: 100_000, height: 100_000 }, { width: 1, height: 1 });
  assert.deepEqual(huge, { cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS });
});

test("each axis caps independently, and neither cap disturbs a grid under it", () => {
  // Wide but short: cols saturate, rows must not be touched. This asymmetry is
  // the original bug - a pane is wider in cells than it is tall, so cols
  // reaches the ceiling several zoom stops before rows does.
  assert.deepEqual(
    gridForContent({ width: 100_000, height: 400 }, { width: 1, height: 10 }),
    { cols: MAX_TERMINAL_COLS, rows: 40 }
  );
  assert.deepEqual(
    gridForContent({ width: 400, height: 100_000 }, { width: 10, height: 1 }),
    { cols: 40, rows: MAX_TERMINAL_ROWS }
  );
});

test("the ceiling never overrides the floor, or an ordinary grid", () => {
  assert.deepEqual(gridForContent({ width: 1, height: 1 }, { width: 1_000, height: 1_000 }), { cols: 2, rows: 1 });
  assert.deepEqual(gridForContent({ width: 800, height: 400 }, { width: 8, height: 16 }), { cols: 100, rows: 25 });
});

test("the ceiling clears the ultrawide pane that raised it", () => {
  // A ~3070px content box at the 25% zoom stop (a ~2.1px cell) - the case the
  // limit was raised for. It must come back uncapped on both axes.
  const zoomedOut = gridForContent({ width: 3_070, height: 1_300 }, { width: 2.1, height: 2.8 })!;
  assert.ok(zoomedOut.cols < MAX_TERMINAL_COLS, `${zoomedOut.cols} cols is still capped`);
  assert.ok(zoomedOut.rows < MAX_TERMINAL_ROWS, `${zoomedOut.rows} rows is still capped`);
});

test("a zoom exactly between two stops settles on the lower one", () => {
  // Documented tie-break: the more conservative stop wins, so repeatedly
  // settling an off-ladder value can never drift upwards.
  assert.equal(nearestTerminalZoom(112.5), 100);
  assert.equal(nearestTerminalZoom(27.5), 25);
  assert.equal(nearestTerminalZoom(55), 50);
});

test("stepping by zero settles without moving", () => {
  assert.equal(steppedTerminalZoom(112, 0), 100);
  assert.equal(steppedTerminalZoom(100, 0), 100);
});

test("a non-finite or negative baseline font size yields no font size at all", () => {
  // 0 is the caller's "unusable" signal; a NaN or Infinity baseline must
  // never reach xterm as a font size.
  assert.equal(terminalZoomFontSize(Number.POSITIVE_INFINITY, 100), 0);
  assert.equal(terminalZoomFontSize(Number.NEGATIVE_INFINITY, 100), 0);
  assert.equal(terminalZoomFontSize(-14, 100), 0);
  assert.equal(terminalZoomFontSize(0, 100), 0);
});

test("no zoom stop, at any baseline, can leave the band the renderer needs", () => {
  // The floor is what stops the DOM renderer's letter-spacing (a canvas cell
  // width minus a DOM glyph advance) going negative when a browser's own
  // minimum font size floors the DOM side and not the canvas one. A stop that
  // would land under it must clamp, never escape.
  for (const baseFontSize of [4, 6, 8, 12, 14, 16, 20, 96, 1_000]) {
    for (const step of TERMINAL_ZOOM_STEPS) {
      const fontSize = terminalZoomFontSize(baseFontSize, step);
      const where = `${baseFontSize}px at ${step}%`;
      assert.ok(fontSize >= MIN_ZOOM_FONT_SIZE, `${where}: ${fontSize} is under the floor`);
      assert.ok(fontSize <= MAX_ZOOM_FONT_SIZE, `${where}: ${fontSize} is over the ceiling`);
    }
  }
});

test("clamping the ladder never turns an unusable baseline into a usable font size", () => {
  // 0 is the "no font size at all" sentinel, and it sits below the floor -
  // so the clamp must run only on a size that was computed, never on the
  // refusal, or an unmeasured pane would silently paint at 4px.
  for (const baseFontSize of [0, -14, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const step of TERMINAL_ZOOM_STEPS) assert.equal(terminalZoomFontSize(baseFontSize, step), 0);
  }
});

test("a baseline small enough to clamp collapses the bottom stops rather than inverting them", () => {
  // With a small baseline several stops share the floor. Distinctness is the
  // casualty (the ladder simply stops getting smaller); the ordering is not,
  // and no stop may ever be smaller than a lower one.
  const sizes = TERMINAL_ZOOM_STEPS.map((step) => terminalZoomFontSize(6, step));
  assert.equal(sizes[0], MIN_ZOOM_FONT_SIZE);
  assert.ok(sizes.filter((size) => size === MIN_ZOOM_FONT_SIZE).length > 1, "the floor is never reused");
  for (let i = 1; i < sizes.length; i += 1) assert.ok(sizes[i]! >= sizes[i - 1]!, `stop ${i} goes backwards`);
});

test("the fill pass and the zoom ladder clamp into one and the same band", () => {
  // Both paths write xterm's fontSize, so a size the ladder refuses to emit
  // must be one the fill pass refuses to emit too.
  const cell = { width: 10, height: 20 };
  assert.equal(zoomedFontSize(14, { cols: 100, rows: 100 }, cell, { width: 1, height: 1 }), MIN_ZOOM_FONT_SIZE);
  assert.equal(zoomedFontSize(14, { cols: 1, rows: 1 }, cell, { width: 100_000, height: 100_000 }), MAX_ZOOM_FONT_SIZE);
  assert.equal(terminalZoomFontSize(MIN_ZOOM_FONT_SIZE, MIN_TERMINAL_ZOOM), MIN_ZOOM_FONT_SIZE);
});

test("a grid too large to fit even at the floor is floored, not refused", () => {
  // The pane clips the overflow (`.mobile-terminal { overflow: hidden }`);
  // what matters is that it paints at a legible 4px rather than at a size no
  // engine will lay out, or than declining to shrink at all.
  const floored = zoomedFontSize(12, { cols: 400, rows: 200 }, { width: 7, height: 14 }, { width: 390, height: 720 });
  assert.equal(floored, MIN_ZOOM_FONT_SIZE);
});

test("extrapolation refuses every unusable font size rather than inventing a cell", () => {
  const cell = { width: 8, height: 16 };
  assert.equal(extrapolatedCell(cell, Number.POSITIVE_INFINITY, 28), null);
  assert.equal(extrapolatedCell(cell, 14, Number.POSITIVE_INFINITY), null);
  assert.equal(extrapolatedCell(cell, Number.NaN, 28), null);
  assert.equal(extrapolatedCell(cell, 14, Number.NaN), null);
  assert.equal(extrapolatedCell(cell, -14, 28), null);
  assert.equal(extrapolatedCell(cell, 14, -28), null);
});

test("a grid exactly at the ceiling is left alone", () => {
  // The ceiling is inclusive on both sides of the wire: the host applies this
  // grid verbatim (see a_grid_at_the_ceiling_is_applied_verbatim in core.rs),
  // so the client must be able to ask for it.
  assert.deepEqual(
    gridForContent({ width: MAX_TERMINAL_COLS, height: MAX_TERMINAL_ROWS }, { width: 1, height: 1 }),
    { cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS }
  );
  // One cell under it is untouched by the cap.
  assert.deepEqual(
    gridForContent({ width: MAX_TERMINAL_COLS - 1, height: MAX_TERMINAL_ROWS - 1 }, { width: 1, height: 1 }),
    { cols: MAX_TERMINAL_COLS - 1, rows: MAX_TERMINAL_ROWS - 1 }
  );
});

test("a degenerate cell can no longer produce an infinite grid", () => {
  // A positive-but-subnormal cell passes the usable-size guard, and
  // content / cell then overflows to Infinity. Before the ceiling existed
  // this returned { cols: Infinity, rows: Infinity } and was announced as
  // such; the cap is what makes the result finite.
  const degenerate = gridForContent({ width: 800, height: 400 }, { width: 1e-300, height: 1e-300 })!;
  assert.deepEqual(degenerate, { cols: MAX_TERMINAL_COLS, rows: MAX_TERMINAL_ROWS });
  assert.ok(Number.isFinite(degenerate.cols) && Number.isFinite(degenerate.rows));
});

test("no zoom stop on any display can announce a grid the host would rewrite", () => {
  // The invariant the client-side ceiling exists to hold. Swept over every
  // stop and a range of displays from a small laptop pane up to an 8K
  // ultrawide, at a cell aspect typical of a monospace face.
  const displays = [
    { width: 640, height: 400 },
    { width: 1_920, height: 1_080 },
    { width: 3_070, height: 1_300 },
    { width: 7_680, height: 2_160 }
  ];
  for (const content of displays) {
    for (const stop of TERMINAL_ZOOM_STEPS) {
      const fontSize = terminalZoomFontSize(14, stop);
      const grid = gridForContent(content, { width: fontSize * 0.6, height: fontSize * 1.2 })!;
      const where = `${content.width}x${content.height} at ${stop}%`;
      assert.ok(Number.isInteger(grid.cols) && Number.isInteger(grid.rows), `${where}: non-integer grid`);
      assert.ok(grid.cols >= 2 && grid.rows >= 1, `${where}: under the floor`);
      assert.ok(grid.cols <= MAX_TERMINAL_COLS, `${where}: ${grid.cols} cols exceeds the host ceiling`);
      assert.ok(grid.rows <= MAX_TERMINAL_ROWS, `${where}: ${grid.rows} rows exceeds the host ceiling`);
    }
  }
});

test("opening and closing the find bar keeps the query but not the tally", () => {
  const searching = applyFindResults(setFindQuery(openFind(CLOSED_FIND), "error"), { resultIndex: 2, resultCount: 9 });
  assert.deepEqual(searching, { open: true, query: "error", index: 2, count: 9 });
  const closed = closeFind(searching);
  assert.equal(closed.open, false);
  assert.equal(closed.query, "error", "reopening should offer the last thing searched for");
  assert.equal(closed.count, 0);
  assert.equal(closed.index, -1);
  assert.deepEqual(openFind(closed), { open: true, query: "error", index: -1, count: 0 });
});

test("find seeds from a usable selection only", () => {
  assert.equal(openFind(CLOSED_FIND, "  npm run build  ").query, "npm run build");
  const typed = setFindQuery(openFind(CLOSED_FIND), "typed");
  // A multi-line selection is not a search term, and blank ones say nothing:
  // neither may wipe a query the user already typed.
  assert.equal(openFind(closeFind(typed), "first\nsecond").query, "typed");
  assert.equal(openFind(closeFind(typed), "   ").query, "typed");
  assert.equal(openFind(closeFind(typed), undefined).query, "typed");
  // Re-seeding with the same term must not throw away a live tally.
  const live = applyFindResults(typed, { resultIndex: 1, resultCount: 4 });
  assert.deepEqual(openFind(live, "typed"), live);
});

test("changing the find query clears the previous term's tally", () => {
  const found = applyFindResults(setFindQuery(openFind(CLOSED_FIND), "alpha"), { resultIndex: 3, resultCount: 12 });
  const retyped = setFindQuery(found, "beta");
  assert.deepEqual(retyped, { open: true, query: "beta", index: -1, count: 0 });
  // An identical query is not a change, so the tally survives a re-render.
  assert.equal(setFindQuery(found, "alpha"), found);
});

test("find results keep the count when the addon stops tracking the active match", () => {
  const searching = setFindQuery(openFind(CLOSED_FIND), "e");
  // resultIndex -1 means the addon's match threshold was exceeded: the count
  // still stands, so only the position is dropped.
  const untracked = applyFindResults(searching, { resultIndex: -1, resultCount: 5_000 });
  assert.deepEqual(untracked, { open: true, query: "e", index: -1, count: 5_000 });
  assert.equal(findStatusLabel(untracked), "5000");
  // An index the count cannot support is treated the same way.
  assert.equal(applyFindResults(searching, { resultIndex: 9, resultCount: 4 }).index, -1);
  assert.equal(applyFindResults(searching, { resultIndex: 0, resultCount: 0 }).count, 0);
});

test("find status reports position, bare count, emptiness and no results", () => {
  assert.equal(findStatusLabel(CLOSED_FIND), "", "an empty query has nothing to report yet");
  assert.equal(findStatusLabel(setFindQuery(openFind(CLOSED_FIND), "nope")), "No results");
  assert.equal(findStatusLabel(applyFindResults(setFindQuery(openFind(CLOSED_FIND), "x"), { resultIndex: 0, resultCount: 17 })), "1/17");
  assert.equal(findStatusLabel(applyFindResults(setFindQuery(openFind(CLOSED_FIND), "x"), { resultIndex: 16, resultCount: 17 })), "17/17");
});

test("find keys step forward, back, and close", () => {
  assert.equal(findCommandForKey({ key: "Enter", shiftKey: false }), "next");
  assert.equal(findCommandForKey({ key: "Enter", shiftKey: true }), "previous");
  assert.equal(findCommandForKey({ key: "Escape", shiftKey: false }), "close");
  assert.equal(findCommandForKey({ key: "Escape", shiftKey: true }), "close");
  for (const key of ["a", "F3", "Backspace", "ArrowDown", " "]) {
    assert.equal(findCommandForKey({ key, shiftKey: false }), "none", `${key} is ordinary typing`);
  }
});

test("find highlights stay visible on every scheme", () => {
  for (const scheme of TERMINAL_SCHEMES) {
    const decorations = findDecorationsFor(scheme);
    // Active and inactive matches must differ, or stepping through results
    // tells the user nothing. Several palettes put a grey in the bright
    // slots, so the two are the same hue at different strengths instead.
    assert.notEqual(decorations.matchBackground, decorations.activeMatchBackground, scheme.id);
    assert.equal(decorations.activeMatchBackground, scheme.ansi.yellow, scheme.id);
    assert.equal(decorations.matchBackground, `${scheme.ansi.yellow}66`, scheme.id);
    // Nothing may be painted in the surface color, on any scheme.
    for (const color of Object.values(decorations)) {
      assert.notEqual(color.toLowerCase(), scheme.background.toLowerCase(), `${scheme.id}: highlight matches the background`);
    }
  }
});

test("find reducers never mutate the state handed to them", () => {
  // The clients hold FindState in React state and pass it straight back in.
  // A reducer that mutated in place would leave a render reading a value it
  // never rendered - and setState would skip the re-render entirely.
  const frozen = Object.freeze({ open: true, query: "term", index: 1, count: 4 });
  assert.doesNotThrow(() => setFindQuery(frozen, "other"));
  assert.doesNotThrow(() => applyFindResults(frozen, { resultIndex: 0, resultCount: 2 }));
  assert.doesNotThrow(() => closeFind(frozen));
  assert.doesNotThrow(() => openFind(frozen, "seed"));
  assert.deepEqual(frozen, { open: true, query: "term", index: 1, count: 4 });
});

test("clearing the find query reports nothing rather than no results", () => {
  // Emptying the field is not a failed search: the bar must fall silent, or
  // deleting the last character flashes "No results" at the user.
  const found = applyFindResults(setFindQuery(openFind(CLOSED_FIND), "x"), { resultIndex: 0, resultCount: 3 });
  const cleared = setFindQuery(found, "");
  assert.deepEqual(cleared, { open: true, query: "", index: -1, count: 0 });
  assert.equal(findStatusLabel(cleared), "");
});

test("a whitespace query is a real search, not an empty one", () => {
  // Spaces are perfectly good terminal search terms (column alignment,
  // trailing whitespace), so a query of spaces must report like any other.
  const spaces = setFindQuery(openFind(CLOSED_FIND), "   ");
  assert.equal(spaces.query, "   ");
  assert.equal(findStatusLabel(spaces), "No results");
  assert.equal(findStatusLabel(applyFindResults(spaces, { resultIndex: 0, resultCount: 2 })), "1/2");
});

test("reopening an already-open find bar re-seeds it in place", () => {
  // Ctrl+F pressed again while the bar is open (with a new selection) is a
  // fresh search, not a no-op - but it must not close the bar or lose it.
  const live = applyFindResults(setFindQuery(openFind(CLOSED_FIND), "old"), { resultIndex: 2, resultCount: 6 });
  const reseeded = openFind(live, "new");
  assert.deepEqual(reseeded, { open: true, query: "new", index: -1, count: 0 });
});

test("a multi-line seed is rejected whatever its line endings", () => {
  // A terminal selection spanning rows is never a search term. It must not
  // silently replace a query the user typed, on either newline convention.
  const typed = closeFind(setFindQuery(openFind(CLOSED_FIND), "kept"));
  for (const seed of ["a\nb", "a\r\nb", "one\ntwo\nthree", "\n", "\r\n"]) {
    assert.equal(openFind(typed, seed).query, "kept", JSON.stringify(seed));
  }
  // Selecting one whole row hands over that line plus its trailing newline;
  // that is still a single-line selection, and trimming makes it usable.
  assert.equal(openFind(typed, "trailing\n").query, "trailing");
  assert.equal(openFind(typed, "\n  leading").query, "leading");
  // A single line that merely contains spaces is still usable.
  assert.equal(openFind(typed, "npm run build").query, "npm run build");
});

test("find tallies survive nonsense from the addon", () => {
  // resultCount is reported by the addon, not computed here. Nothing it can
  // send may produce a negative count or an index the label cannot render.
  const searching = setFindQuery(openFind(CLOSED_FIND), "q");
  for (const event of [
    { resultIndex: -5, resultCount: -3 },
    { resultIndex: 0, resultCount: -1 },
    { resultIndex: -1, resultCount: 0 },
    { resultIndex: 3, resultCount: 3 }
  ]) {
    const state = applyFindResults(searching, event);
    assert.ok(state.count >= 0, JSON.stringify(event));
    assert.ok(state.index === -1 || (state.index >= 0 && state.index < state.count), JSON.stringify(event));
    assert.equal(findStatusLabel(state).includes("-"), false, `${JSON.stringify(event)} produced ${findStatusLabel(state)}`);
  }
});

test("closing a find bar that was never opened changes nothing", () => {
  assert.deepEqual(closeFind(CLOSED_FIND), CLOSED_FIND);
  assert.equal(findStatusLabel(CLOSED_FIND), "");
});
