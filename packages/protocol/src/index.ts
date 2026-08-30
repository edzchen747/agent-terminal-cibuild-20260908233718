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

export type Platform = "android" | "ios" | "web";
export type TerminalModifier = "ctrl" | "alt" | "shift";

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
  shells: ShellProfile[];
  defaultShellId: string;
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
  | { type: "session.attach"; requestId: string; sessionId: string; cols: number; rows: number }
  | { type: "session.detach"; requestId: string; sessionId: string }
  | { type: "session.input"; sessionId: string; data: string }
  | { type: "session.resize"; sessionId: string; cols: number; rows: number; force?: boolean };

export type ServerMessage =
  | { type: "pair.accepted"; requestId: string; deviceToken: string; snapshot: HostSnapshot }
  | { type: "auth.accepted"; requestId: string; snapshot: HostSnapshot }
  | { type: "node.enrollment"; requestId: string; authKey: string; expiresAt: string }
  | { type: "snapshot"; requestId?: string; snapshot: HostSnapshot }
  | { type: "directory.listing"; requestId: string; listing: DirectoryListing }
  | { type: "session.output"; sessionId: string; data: string }
  | { type: "session.buffer"; requestId: string; sessionId: string; data: string }
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
