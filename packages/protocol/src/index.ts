import type { TerminalThemeSettings } from "./terminal-themes.js";
import type { TaskbarProgress } from "./taskbar.js";

export * from "./terminal-themes.js";
export * from "./terminal-layout.js";
export * from "./terminal-grid.js";
export * from "./terminal-zoom.js";
export * from "./terminal-find.js";
export * from "./session-activity.js";
export * from "./taskbar.js";

export const PROTOCOL_VERSION = 1 as const;

// Keep the control-plane address in the shared protocol package so the
// desktop and mobile clients use the same default. Deployments can override
// it through their native app configuration/environment at build time.
export const OVERLAY_CONTROL_URL = "https://node.hopto.org" as const;
export const OVERLAY_TAILNET_DOMAIN = "agent-terminal.internal" as const;
export const LAN_CONNECT_TIMEOUT_MS = 1_500 as const;
export const NODE_INACTIVITY_TIMEOUT_DAYS = 30 as const;
export const MAX_PROJECT_NAME_LENGTH = 100 as const;
/**
 * How often the mobile client sends a `snapshot.request` heartbeat while it
 * is visible. The desktop treats a paired device as connected while it has
 * received any message within a small multiple of this interval.
 */
export const MOBILE_HEARTBEAT_INTERVAL_MS = 60_000 as const;

/**
 * How often a remote terminal client sends a bare `ping` while a session
 * page is attached and the app is visible. The host treats any message as
 * viewport liveness: a networked client stays in a session's viewport set S
 * while it keeps pinging, and drops out after `VIEWPORT_WATCHDOG_TIMEOUT_MS`.
 * Keep in sync with VIEWPORT_KEEPALIVE_INTERVAL_MS in core.rs.
 */
export const VIEWPORT_KEEPALIVE_INTERVAL_MS = 1_000 as const;
/**
 * A networked client still counts as viewing a session while its last
 * message is within this window; then its viewport entry is evicted, and if
 * it owned the grid, ownership passes to the client that was showing the
 * session most recently (a backgrounded phone hands the grid back to the
 * desktop). In-process desktop panes never expire.
 * Keep in sync with VIEWPORT_WATCHDOG_TIMEOUT_MS in core.rs.
 */
export const VIEWPORT_WATCHDOG_TIMEOUT_MS = 2_000 as const;

/**
 * Grid ownership: the PTY grid is the ACTIVE client's announced viewport,
 * verbatim. A client claims the grid by interacting with the session -
 * typing, tapping/clicking it, or explicitly opening it (`claim` on
 * `session.resize` / `session.attach`) - and keeps it until another client
 * claims it or it departs, at which point the most recently active
 * remaining client takes over. A non-owner's announcements are recorded
 * (they are the fallback pool) but never resize the PTY.
 *
 * Viewport membership (set S, the fallback pool) is a separate concept from
 * stream attachment: a client is a member of S only from a CLAIMED
 * `session.attach`/`session.resize` onward, and leaves S the moment it stops
 * actually displaying the session - via `session.detach` (which also leaves
 * the stream) or `session.viewport.release` (which does not: the client
 * keeps receiving output, it is just no longer a sizing candidate). An
 * unclaimed attach - a desktop tab opened in the background - is a pure
 * stream subscription: it never joins S and so can never be handed the
 * grid while it is not the one actually shown. The last client to leave S
 * with no survivor clears ownership and leaves the last grid in place; a
 * later announce from anyone re-adopts it (the lone-client bootstrap).
 *
 * Every other client renders the owner's grid EXACTLY and scales it to fit
 * its own container - a client narrower than the PTY simply zooms out - so
 * the raw journal still replays 1:1 with no re-wrapping and no cursor
 * drift. Grid changes are journaled at their exact stream offset
 * (`session.buffer.segments` + live `session.grid` messages), so a replay
 * reproduces the same resize sequence the live clients applied.
 */
/** xterm scrollback on every client; the host journal cap is the same idea in bytes. */
export const TERMINAL_SCROLLBACK_LINES = 50_000 as const;

export type Platform = "android" | "ios" | "web";
export type TerminalModifier = "ctrl" | "alt" | "shift";

/**
 * How a running foreground program wants to own the terminal grid. The host
 * classifies the PTY stream into one of these modes and tells every client:
 *
 * - canonical: the shell owns the line-editor grid, and every client
 *   renders the host grid exactly.
 * - inline: the program is a TUI but paints on the primary buffer -
 *   typically a scrolling transcript plus a bounded band it repaints in
 *   place (an agent harness's composer, a picker's result list). It owns
 *   the grid like fullscreen does, but its output is NOT history-isolated:
 *   the transcript above the repainted band is the program's scrollback
 *   and has to stay in the buffer. Announced by sync output, mouse
 *   tracking, or kitty keyboard flags - none of which say where the
 *   program draws.
 * - fullscreen: the program owns the whole grid, proven by its own
 *   alt-screen entry or by a scroll region plus drawing. Output is
 *   history-isolated (a synthetic alt-screen pair is journaled when the
 *   program does not use one itself) so TUI frames never bleed into the
 *   shell history.
 *
 * A period only ever rises (canonical < inline < fullscreen), so a harness
 * that starts inline and later takes the whole grid is promoted in place.
 *
 * The three modes are still classified and broadcast on the stream, but
 * neither the clients nor the host use the mode for sizing decisions: the
 * grid belongs to whichever client last claimed it, in every mode.
 */
export type TuiMode = "canonical" | "inline" | "fullscreen";
export const TERMINAL_TUI_MODES: readonly TuiMode[] = ["canonical", "inline", "fullscreen"];

/**
 * Whether a session is blocked waiting for a foreground program to
 * finish (`active`) or has its prompt back and is waiting for the user
 * (`idle`). `status: "running"` only says the shell process is alive;
 * this says whether the tab is doing anything.
 *
 * The host decides, so every client agrees: it reads the OSC 133 markers
 * its own shell hooks emit, treats any non-canonical TUI period as
 * active, and falls back to submitted input plus stream quiet in a shell
 * it could not hook. See `activity.rs` on the desktop.
 */
export type SessionActivity = "idle" | "active";
export const TERMINAL_SESSION_ACTIVITIES: readonly SessionActivity[] = ["idle", "active"];

/**
 * The 16 ANSI colors the desktop terminal renders with. These are the
 * "Campbell" scheme that Windows Terminal ships as its default, so the
 * desktop terminal colors shell output the same way the native Windows
 * terminal does (this machine's Windows Terminal uses the stock defaults:
 * no custom schemes or per-profile color overrides). xterm's built-in
 * palette is noticeably lighter than Campbell, which is why the desktop
 * terminal looked washed out next to the native terminal. Keep this list
 * in sync with Windows Terminal's Campbell scheme if it ever changes.
 *
 * Spread it into the xterm v6 `ITheme` (which uses named color keys, not an
 * `ansi` array).
 */

export interface HttpLinkMatch {
  text: string;
  start: number;
  end: number;
}

const HTTP_LINK_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

/** Find valid HTTP(S) URLs in one rendered terminal line. */
export function findHttpLinks(value: string): HttpLinkMatch[] {
  const links: HttpLinkMatch[] = [];
  for (const match of value.matchAll(HTTP_LINK_PATTERN)) {
    const rawText = match[0];
    const matchStart = match.index ?? 0;
    if (!rawText || (matchStart > 0 && /[\w./-]/.test(value[matchStart - 1] ?? ""))) continue;

    const text = trimUrlPunctuation(rawText);
    if (!text) continue;
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    links.push({ text, start: matchStart, end: matchStart + text.length });
  }
  return links;
}

function trimUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && /[.,!?;:]/.test(value[end - 1] ?? "")) end -= 1;

  while (end > 0 && ")]}".includes(value[end - 1] ?? "")) {
    const closing = value[end - 1];
    const opening = closing === ")" ? "(" : closing === "]" ? "[" : "{";
    const prefix = value.slice(0, end - 1);
    const opens = [...prefix].filter((character) => character === opening).length;
    const closes = [...prefix].filter((character) => character === closing).length;
    if (closes < opens) break;
    end -= 1;
  }

  return value.slice(0, end);
}

export function applyTerminalModifiers(value: string, modifiers: ReadonlySet<TerminalModifier>): string {
  let output = value;
  const modifierCode = 1 + (modifiers.has("shift") ? 1 : 0) + (modifiers.has("alt") ? 2 : 0) + (modifiers.has("ctrl") ? 4 : 0);
  const arrow = output.match(/^\x1b\[([ABCD])$/);
  if (arrow && modifierCode > 1) return `\x1b[1;${modifierCode}${arrow[1]}`;
  const page = output.match(/^\x1b\[([56])~$/);
  if (page && modifierCode > 1) return `\x1b[${page[1]};${modifierCode}~`;
  if (output === "\t" && modifiers.has("shift")) {
    return `${modifiers.has("alt") ? "\x1b" : ""}\x1b[Z`;
  }

  if (modifiers.has("shift") && Array.from(output).length === 1) {
    output = output.toUpperCase();
  }

  if (modifiers.has("ctrl") && (output === "\x7f" || output === "\x08")) {
    // Mobile keyboards report Backspace as DEL or BS. Ctrl+Backspace should
    // erase the previous word consistently across PowerShell, cmd and Bash.
    output = "\x17";
  } else if (modifiers.has("ctrl") && Array.from(output).length === 1) {
    const character = output.toUpperCase();
    const code = character.charCodeAt(0);

    if (code >= 0x40 && code <= 0x5f) {
      output = String.fromCharCode(code & 0x1f);
    } else if (character === " ") {
      output = "\x00";
    } else if (character === "?") {
      output = "\x7f";
    }
  }

  if (modifiers.has("alt")) {
    output = `\x1b${output}`;
  }

  return output;
}

export function parseTerminalWorkingDirectories(value: string): string[] {
  const directories: string[] = [];
  const pattern = /\x1b\]([^\x07]*?)(?:\x07|\x1b\\)/g;
  for (const match of value.matchAll(pattern)) {
    const payload = match[1] ?? "";
    if (payload.startsWith("9;9;")) {
      const directory = payload.slice(4).trim().replace(/^"|"$/g, "");
      if (directory) directories.push(directory);
      continue;
    }
    if (!payload.startsWith("7;")) continue;
    try {
      const location = new URL(payload.slice(2));
      if (location.protocol !== "file:") continue;
      let pathname = decodeURIComponent(location.pathname);
      if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
      directories.push(location.hostname ? `//${location.hostname}${pathname}` : pathname);
    } catch {
      // Ignore malformed shell-integration metadata.
    }
  }
  return directories;
}

export interface DeviceIdentity {
  id: string;
  name: string;
  platform: Platform;
}

export interface AuthorizedDevice extends DeviceIdentity {
  addedAt: string;
  lastSeenAt: string;
  /** True while the device holds an authenticated connection to the desktop. */
  online?: boolean;
  /**
   * The sessions the device is displaying right now: its viewport entries in
   * each session's set S. Empty while the device is connected but has no
   * terminal open, and cleared with the rest of its viewports when the
   * watchdog evicts a backgrounded phone.
   */
  viewingSessionIds?: string[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  persistent: boolean;
  createdAt?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parentPath?: string;
  directories: DirectoryEntry[];
}

export interface TerminalSession {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  shellId: string;
  status: "running" | "exited";
  createdAt: string;
  exitCode?: number;
  /**
   * The host's TUI classification of the running foreground program
   * (default canonical). The modes determine how a program may draw its
   * frames (strict cell grid, alt-screen isolation), but they do not change
   * sizing: the PTY grid is the active client's own viewport in every mode
   * (see the grid ownership note above).
   */
  tuiMode?: TuiMode;
  /**
   * Whether the shell is currently blocked on a foreground program.
   * Absent on a host that predates activity detection; treat that as
   * `"idle"`.
   */
  activity?: SessionActivity;
  /** When the session entered `activity`, RFC3339. */
  activitySince?: string;
  /**
   * The ConEmu `OSC 9;4` taskbar progress of the session's last command
   * (default clear). A window's taskbar button shows the combined state
   * of its project's sessions, highest priority first: error, paused,
   * value, indeterminate, clear.
   */
  taskbar?: TaskbarProgress;
}

export interface ShellProfile {
  id: string;
  name: string;
  executable: string;
  args: string[];
}

export interface HostSnapshot {
  host: {
    id: string;
    name: string;
    version: string;
  };
  projects: Project[];
  sessions: TerminalSession[];
  devices: AuthorizedDevice[];
  /**
   * The sessions desktop windows are actively showing (their active tabs,
   * unioned across windows), reported by the desktop renderers. Optional
   * because a host older than this field omits it: a phone reads it to
   * drop a "come look" marker for a session the user actually opened on
   * the desktop (a background tab never counts as a look).
   */
  desktopActiveSessionIds?: string[];
  /**
   * The sessions whose command just finished (progress indicator went
   * from running to clear) and that no client has viewed yet - the
   * host-persisted "come look" markers. Optional because a host older
   * than this field omits it: a client connecting after the edge seeds
   * its markers from this list, so the static-dot marker survives a
   * connect that happens after the command finished.
   */
  lookHereSessionIds?: string[];
  shells: ShellProfile[];
  defaultShellId: string;
  /**
   * The dark/light terminal schemes every client renders. Optional because a
   * host older than this field omits it entirely, and a phone pairs with
   * whatever desktop build is installed: read it through
   * normalizeTerminalThemeSettings rather than reaching into it.
   */
  terminalTheme?: TerminalThemeSettings;
}

export interface PairingPayload {
  version: typeof PROTOCOL_VERSION;
  hostId: string;
  hostName: string;
  /** LAN-only endpoint used for the first QR pairing. */
  endpoint: string;
  localEndpoint?: string;
  /** Endpoint used after the local probe fails. */
  remoteEndpoint?: string;
  controlUrl?: string;
  transport?: "direct" | "overlay";
  remoteTransport?: "direct" | "overlay";
  pairingToken: string;
  expiresAt: string;
}

export type ClientMessage =
  | { type: "pair"; requestId: string; token: string; device: DeviceIdentity }
  | { type: "auth"; requestId: string; deviceId: string; deviceToken: string; name?: string }
  | { type: "node.enroll"; requestId: string; nonce: string }
  | { type: "snapshot.request"; requestId: string }
  | { type: "project.create"; requestId: string; name: string; path: string }
  | { type: "project.rename"; requestId: string; projectId: string; name: string }
  | { type: "project.remove"; requestId: string; projectId: string }
  | { type: "project.persistence"; requestId: string; projectId: string; persistent: boolean }
  | { type: "project.reorder"; requestId: string; projectIds: string[] }
  | { type: "directory.list"; requestId: string; path?: string }
  | { type: "session.create"; requestId: string; projectId: string; shellId?: string }
  | { type: "session.close"; requestId: string; sessionId: string }
  /**
   * Subscribe to a session's stream and replay its journal. Opening a
   * terminal is an explicit interaction, so a client that the user actually
   * opened sets `claim`, which both joins the viewport set S and takes
   * ownership of the PTY grid; a pane that attaches in the background (a
   * desktop tab that is not the active one) omits it and is a pure stream
   * subscription - it does not join S and so cannot be handed the grid
   * later while it remains unshown (see the grid ownership note above).
   */
  | { type: "session.attach"; requestId: string; sessionId: string; cols: number; rows: number; claim?: boolean }
  | { type: "session.detach"; requestId: string; sessionId: string }
  | { type: "session.input"; sessionId: string; data: string; cols?: number; rows?: number }
  /**
   * This client's viewport. `claim` is set only on an interaction-driven
   * announce - a tap, a click, a character-width change - never on a plain
   * layout resize: a claim takes the PTY grid over, an unclaimed announce
   * from a non-owner is recorded but changes nothing (see the grid
   * ownership note above).
   */
  | { type: "session.resize"; sessionId: string; cols: number; rows: number; claim?: boolean }
  /**
   * Leave the session's viewport set S without leaving its stream: this
   * client is still attached (it keeps receiving live output) but is no
   * longer displaying the session, so it must not size the PTY and must not
   * be a successor candidate. A hidden desktop tab and a backgrounded phone
   * send this instead of detaching, so switching back needs no journal
   * replay; `session.detach` implies it.
   */
  | { type: "session.viewport.release"; requestId: string; sessionId: string }
  | { type: "ping" }
  | { type: "debug.diagnostics"; message: string }
  | { type: "shell.default"; requestId: string; shellId: string }
  | { type: "terminal.theme"; requestId: string; darkSchemeId: string; lightSchemeId: string };

/**
 * One contiguous slice of a session's PTY stream recorded under a single
 * terminal grid. The client resizes its emulator to `cols` x `rows` before
 * writing `data`, which reflows its history exactly the way live clients did.
 */
export interface SessionSegment {
  cols: number;
  rows: number;
  data: string;
}

export type ServerMessage =
  | { type: "pair.accepted"; requestId: string; deviceToken: string; snapshot: HostSnapshot }
  | { type: "auth.accepted"; requestId: string; snapshot: HostSnapshot }
  | { type: "node.enrollment"; requestId: string; authKey: string; expiresAt: string }
  | { type: "snapshot"; requestId?: string; snapshot: HostSnapshot }
  | { type: "directory.listing"; requestId: string; listing: DirectoryListing }
  | { type: "session.output"; sessionId: string; data: string; offset: number }
  | { type: "session.buffer"; requestId: string; sessionId: string; segments: SessionSegment[]; endOffset: number }
  | { type: "session.grid"; sessionId: string; cols: number; rows: number; offset: number }
  | { type: "session.mode"; sessionId: string; mode: TuiMode; offset: number }
  /**
   * Carries no stream offset, unlike the grid and mode events: idle is
   * found by a timeout on the host, not by a byte in the stream, so
   * there is no position to anchor it to.
   */
  | { type: "session.activity"; sessionId: string; activity: SessionActivity; since: string }
  /**
   * The session's taskbar progress changed (a ConEmu `OSC 9;4` report,
   * the shell's command lifecycle, or the process exiting), like the
   * activity event: no stream offset, the state is host-side.
   */
  | { type: "session.taskbar"; sessionId: string; taskbar: TaskbarProgress }
  | { type: "ok"; requestId: string }
  | { type: "error"; requestId?: string; code: string; message: string };

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function decodeClientMessage(value: unknown): ClientMessage {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
    throw new Error("Message must be an object with a type.");
  }
  return parsed as ClientMessage;
}

export function decodeServerMessage(value: unknown): ServerMessage {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
    throw new Error("Message must be an object with a type.");
  }
  return parsed as ServerMessage;
}

/**
 * Encode only the pairing information needed by a phone. The full payload is
 * still returned by the desktop IPC API, but the QR uses short keys and omits
 * values that the mobile client can derive. This keeps the modules larger and
 * easier for a camera to resolve without changing the pairing semantics.
 */
export function encodePairingPayload(payload: PairingPayload): string {
  const compact: Record<string, string | number> = {
    v: payload.version,
    i: payload.hostId,
    n: payload.hostName,
    e: payload.localEndpoint ?? payload.endpoint,
    t: payload.pairingToken
  };
  const expiresAt = Date.parse(payload.expiresAt);
  compact.x = Number.isFinite(expiresAt) ? Math.floor(expiresAt / 1_000) : payload.expiresAt;

  const defaultRemoteEndpoint = `ws://${payload.hostId}.${OVERLAY_TAILNET_DOMAIN}:47831`;
  if (payload.remoteEndpoint && payload.remoteEndpoint !== defaultRemoteEndpoint) compact.r = payload.remoteEndpoint;
  if (payload.controlUrl && payload.controlUrl !== OVERLAY_CONTROL_URL) compact.c = payload.controlUrl;
  if (payload.remoteTransport && payload.remoteTransport !== "overlay") compact.rt = payload.remoteTransport;
  return JSON.stringify(compact);
}

export function parsePairingPayload(raw: string): PairingPayload {
  const text = raw.startsWith("agentterminal://pair?")
    ? decodeURIComponent(new URL(raw).searchParams.get("data") ?? "")
    : raw;

  const parsed = JSON.parse(text) as Record<string, unknown>;
  const payload: Partial<PairingPayload> = Object.prototype.hasOwnProperty.call(parsed, "v")
    ? {
        version: parsed.v as PairingPayload["version"],
        hostId: parsed.i as string,
        hostName: parsed.n as string,
        endpoint: parsed.e as string,
        ...(typeof parsed.e === "string" ? { localEndpoint: parsed.e } : {}),
        ...(typeof parsed.r === "string" ? { remoteEndpoint: parsed.r } : {}),
        ...(typeof parsed.c === "string" ? { controlUrl: parsed.c } : {}),
        ...(parsed.rt === "direct" || parsed.rt === "overlay" ? { remoteTransport: parsed.rt } : {}),
        pairingToken: parsed.t as string,
        expiresAt: typeof parsed.x === "number" ? new Date(parsed.x * 1_000).toISOString() : parsed.x as string
      }
    : parsed as Partial<PairingPayload>;
  // Old builds placed a Headscale key in this field. Never propagate it even
  // when parsing a legacy, non-compact payload.
  delete (payload as Partial<PairingPayload> & { nodeAuthKey?: unknown }).nodeAuthKey;

  if (
    payload.version !== PROTOCOL_VERSION ||
    typeof payload.hostId !== "string" ||
    typeof payload.hostName !== "string" ||
    typeof payload.endpoint !== "string" ||
    typeof payload.pairingToken !== "string" ||
    typeof payload.expiresAt !== "string"
  ) {
    throw new Error("This is not valid Agent Terminal pairing QR data.");
  }
  return payload as PairingPayload;
}

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

const STREAM_BYTE_ENCODER = new TextEncoder();

/**
 * Length of a terminal stream chunk in bytes. The host journal numbers every
 * output chunk with the absolute byte offset of its first byte in the session
 * stream, so clients need the same byte accounting to know whether a piece of
 * live output is already contained in a replayed journal snapshot.
 */
export function streamByteLength(value: string): number {
  return STREAM_BYTE_ENCODER.encode(value).byteLength;
}
