import { Preferences } from "@capacitor/preferences";
import type { ClientMessage, DeviceIdentity, HostSnapshot, PairingPayload, RelayMessage, ServerMessage } from "@agentterminal/protocol";
import { createRequestId, decodeServerMessage, encodeMessage, LAN_CONNECT_TIMEOUT_MS, OVERLAY_CONTROL_URL, OVERLAY_RELAY_URL } from "@agentterminal/protocol";
import { EmbeddedNodeEngine } from "./embedded-engine";

const HOST_KEY = "agent-terminal-host";

export interface SavedHost {
  id: string;
  name: string;
  /** Kept as the LAN endpoint for backwards-compatible saved records. */
  endpoint: string;
  localEndpoint?: string;
  remoteEndpoint?: string;
  controlUrl?: string;
  transport?: "relay" | "direct" | "overlay";
  remoteTransport?: "relay" | "direct" | "overlay";
  nodeAuthKey?: string;
  deviceId: string;
  deviceToken: string;
}

type EventMap = {
  snapshot: HostSnapshot;
  output: { sessionId: string; data: string };
  disconnected: undefined;
};

export class HostConnection {
  private socket?: WebSocket;
  private activeTransport: "relay" | "direct" | "overlay" = "direct";
  private intentionalClose = false;
  private readonly connectionId = crypto.randomUUID();
  private readonly embeddedEngine = new EmbeddedNodeEngine();
  private pending = new Map<string, { resolve: (message: ServerMessage) => void; reject: (error: Error) => void }>();
  private listeners = new Map<keyof EventMap, Set<(value: never) => void>>();
  snapshot?: HostSnapshot;

  constructor(public readonly host: SavedHost) {}

  static async saved(): Promise<SavedHost | null> {
    const { value } = await Preferences.get({ key: HOST_KEY });
    if (!value) return null;
    try { return JSON.parse(value) as SavedHost; } catch { return null; }
  }

  static async forget(): Promise<void> {
    await Preferences.remove({ key: HOST_KEY });
  }

  static async pair(payload: PairingPayload, device: DeviceIdentity): Promise<HostConnection> {
    const localEndpoint = payload.localEndpoint ?? payload.endpoint;
    if (payload.transport && payload.transport !== "direct" && !payload.localEndpoint) {
      throw new Error("Pairing must be completed while the phone and desktop are on the same LAN.");
    }
    const temporary = new HostConnection({
      id: payload.hostId,
      name: payload.hostName,
      endpoint: localEndpoint,
      localEndpoint,
      remoteEndpoint: payload.remoteEndpoint ?? OVERLAY_RELAY_URL,
      controlUrl: payload.controlUrl ?? OVERLAY_CONTROL_URL,
      transport: "direct",
      remoteTransport: payload.remoteTransport ?? "relay",
      nodeAuthKey: payload.nodeAuthKey,
      deviceId: device.id,
      deviceToken: ""
    });
    try {
      await temporary.open(localEndpoint, "direct", LAN_CONNECT_TIMEOUT_MS);
      const response = await temporary.request({ type: "pair", requestId: createRequestId(), token: payload.pairingToken, device });
      if (response.type !== "pair.accepted") throw new Error("The desktop rejected the pairing request.");
      temporary.host.deviceToken = response.deviceToken;
      temporary.snapshot = response.snapshot;
      await Preferences.set({ key: HOST_KEY, value: JSON.stringify(temporary.host) });
      // Initialize and persist the overlay identity during pairing so a later
      // off-LAN reconnect does not create a new node after an app restart.
      await temporary.embeddedEngine.start(temporary.host.controlUrl ?? OVERLAY_CONTROL_URL);
      return temporary;
    } catch (error) {
      temporary.close();
      throw error;
    }
  }

  async connect(): Promise<HostSnapshot> {
    const localEndpoint = this.host.localEndpoint ?? (this.host.transport === "direct" ? this.host.endpoint : undefined);
    let connectedLocally = false;
    if (localEndpoint) {
      try {
        await this.open(localEndpoint, "direct", LAN_CONNECT_TIMEOUT_MS);
        connectedLocally = true;
      } catch {
        this.abortSocket();
      }
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      const hasExplicitRemoteEndpoint = Boolean(this.host.remoteEndpoint);
      const remoteEndpoint = this.host.remoteEndpoint ?? (this.host.transport === "relay" ? this.host.endpoint : OVERLAY_RELAY_URL);
      const remoteTransport = this.host.remoteTransport ?? (this.host.transport === "relay" || !hasExplicitRemoteEndpoint ? "relay" : "overlay");
      const nodeState = await this.embeddedEngine.start(this.host.controlUrl ?? OVERLAY_CONTROL_URL, remoteEndpoint, remoteTransport, this.host.nodeAuthKey);
      if (remoteTransport === "overlay" && !nodeState.proxyEndpoint && !nodeState.engineStarted) {
        await this.open(OVERLAY_RELAY_URL, "relay", 8_000);
      } else {
        try {
          await this.open(
            nodeState.proxyEndpoint ?? remoteEndpoint,
            nodeState.proxyEndpoint ? "direct" : remoteTransport,
            8_000
          );
        } catch (remoteError) {
          this.abortSocket();
          if (remoteTransport !== "overlay") throw remoteError;
          // Keep the protocol relay as a compatibility path while a native
          // engine is unavailable or still being enrolled with Headscale.
          await this.open(OVERLAY_RELAY_URL, "relay", 8_000);
        }
      }
    } else if (connectedLocally) {
      // Persist the node identity even when this launch happens on the LAN.
      await this.embeddedEngine.start(this.host.controlUrl ?? OVERLAY_CONTROL_URL);
    }
    const response = await this.request({ type: "auth", requestId: createRequestId(), deviceId: this.host.deviceId, deviceToken: this.host.deviceToken });
    if (response.type !== "auth.accepted") throw new Error("This phone is not authorized by the desktop.");
    this.snapshot = response.snapshot;
    return response.snapshot;
  }

  async request(message: ClientMessage): Promise<ServerMessage> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("The desktop is not connected.");
    if (!("requestId" in message)) {
      this.sendPayload(encodeMessage(message));
      return { type: "ok", requestId: "" };
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => { this.pending.delete(message.requestId); reject(new Error("The desktop did not respond.")); }, 12_000);
      this.pending.set(message.requestId, {
        resolve: (response) => { window.clearTimeout(timeout); resolve(response); },
        reject: (error) => { window.clearTimeout(timeout); reject(error); }
      });
      this.sendPayload(encodeMessage(message));
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.sendPayload(encodeMessage(message));
  }

  on<K extends keyof EventMap>(event: K, callback: (value: EventMap[K]) => void): () => void {
    const callbacks = this.listeners.get(event) ?? new Set();
    callbacks.add(callback as (value: never) => void);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback as (value: never) => void);
  }

  close(): void {
    this.intentionalClose = true;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.rejectAll(new Error("Connection closed."));
    void this.embeddedEngine.stop();
  }

  private open(endpoint: string, transport: "relay" | "direct" | "overlay", timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      this.activeTransport = transport;
      const socket = new WebSocket(endpoint);
      const timeout = window.setTimeout(() => { socket.close(); reject(new Error("The desktop connection attempt timed out.")); }, timeoutMs);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.socket = socket;
        if (this.activeTransport === "relay") {
          socket.send(JSON.stringify({ type: "relay.connect", hostId: this.host.id, connectionId: this.connectionId } satisfies RelayMessage));
        }
        resolve();
      };
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error("Could not reach the desktop host.")); };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined;
        this.rejectAll(new Error("Desktop disconnected."));
        if (!this.intentionalClose) this.emit("disconnected", undefined);
      };
      socket.onmessage = (event) => this.receive(String(event.data));
    });
  }

  private receive(raw: string): void {
    if (this.activeTransport === "relay") {
      let relay: RelayMessage;
      try { relay = JSON.parse(raw) as RelayMessage; } catch { return; }
      if (relay.type === "relay.message") raw = relay.payload;
      else if (relay.type === "relay.disconnect") { this.emit("disconnected", undefined); return; }
      else return;
    }
    let message: ServerMessage;
    try { message = decodeServerMessage(raw); } catch { return; }
    if (message.type === "session.output") { this.emit("output", { sessionId: message.sessionId, data: message.data }); return; }
    if (message.type === "snapshot") { this.snapshot = message.snapshot; this.emit("snapshot", message.snapshot); }
    if ((message.type === "auth.accepted" || message.type === "pair.accepted") && message.snapshot) this.snapshot = message.snapshot;
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        if (message.type === "error") pending.reject(new Error(message.message)); else pending.resolve(message);
      }
    }
  }

  private emit<K extends keyof EventMap>(event: K, value: EventMap[K]): void {
    for (const callback of this.listeners.get(event) ?? []) callback(value as never);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private sendPayload(payload: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.activeTransport === "relay") {
      this.socket.send(JSON.stringify({ type: "relay.message", connectionId: this.connectionId, payload } satisfies RelayMessage));
    } else {
      this.socket.send(payload);
    }
  }

  private abortSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.intentionalClose = true;
    socket?.close();
    this.rejectAll(new Error("Connection attempt was replaced."));
  }
}
