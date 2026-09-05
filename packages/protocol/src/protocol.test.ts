import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DARK_TERMINAL_SCHEME_ID, DEFAULT_LIGHT_TERMINAL_SCHEME_ID, DEFAULT_TERMINAL_THEME_SETTINGS, LAN_CONNECT_TIMEOUT_MS, MOBILE_HEARTBEAT_INTERVAL_MS, OVERLAY_CONTROL_URL, OVERLAY_TAILNET_DOMAIN, PROTOCOL_VERSION, TERMINAL_SCROLLBACK_LINES, VIEWPORT_KEEPALIVE_INTERVAL_MS, VIEWPORT_WATCHDOG_TIMEOUT_MS, applyTerminalModifiers, decodeClientMessage, decodeServerMessage, encodeMessage, encodePairingPayload, findHttpLinks, gridForContent, parsePairingPayload, parseTerminalWorkingDirectories, streamByteLength, TERMINAL_ANSI_THEME, TERMINAL_SCHEMES, normalizeTerminalThemeSettings, resolveTerminalScheme, terminalSchemeById, terminalSchemesFor, xtermThemeFor, squishScaleToFill, zoomedFontSize, type ClientMessage, type HostSnapshot } from "./index.js";

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
