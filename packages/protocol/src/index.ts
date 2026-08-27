export const PROTOCOL_VERSION = 1 as const;

export type Platform = "android" | "ios" | "web";
export type TerminalModifier = "ctrl" | "alt" | "shift";

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
}

export interface Project {
  id: string;
  name: string;
  path: string;
  persistent: boolean;
  createdAt?: string;
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
  endpoint: string;
  transport?: "relay" | "direct";
  pairingToken: string;
  expiresAt: string;
}

export type RelayMessage =
  | { type: "relay.register"; hostId: string; hostToken: string }
  | { type: "relay.registered"; hostId: string }
  | { type: "relay.connect"; hostId: string; connectionId: string }
  | { type: "relay.connected"; connectionId: string }
  | { type: "relay.message"; connectionId: string; payload: string }
  | { type: "relay.disconnect"; connectionId: string }
  | { type: "relay.error"; message: string };

export type ClientMessage =
  | { type: "pair"; requestId: string; token: string; device: DeviceIdentity }
  | { type: "auth"; requestId: string; deviceId: string; deviceToken: string }
  | { type: "snapshot.request"; requestId: string }
  | { type: "project.create"; requestId: string; name: string; path: string }
  | { type: "project.remove"; requestId: string; projectId: string }
  | { type: "project.persistence"; requestId: string; projectId: string; persistent: boolean }
  | { type: "session.create"; requestId: string; projectId: string; shellId?: string }
  | { type: "session.close"; requestId: string; sessionId: string }
  | { type: "session.attach"; requestId: string; sessionId: string; cols: number; rows: number }
  | { type: "session.detach"; requestId: string; sessionId: string }
  | { type: "session.input"; sessionId: string; data: string }
  | { type: "session.resize"; sessionId: string; cols: number; rows: number; force?: boolean };

export type ServerMessage =
  | { type: "pair.accepted"; requestId: string; deviceToken: string; snapshot: HostSnapshot }
  | { type: "auth.accepted"; requestId: string; snapshot: HostSnapshot }
  | { type: "snapshot"; requestId?: string; snapshot: HostSnapshot }
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

export function parsePairingPayload(raw: string): PairingPayload {
  const text = raw.startsWith("agentterminal://pair?")
    ? decodeURIComponent(new URL(raw).searchParams.get("data") ?? "")
    : raw;
  const payload = JSON.parse(text) as Partial<PairingPayload>;
  if (
    payload.version !== PROTOCOL_VERSION ||
    !payload.hostId ||
    !payload.hostName ||
    !payload.endpoint ||
    !payload.pairingToken ||
    !payload.expiresAt
  ) {
    throw new Error("This is not valid Agent Terminal pairing QR data.");
  }
  return payload as PairingPayload;
}

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}
