import { Preferences } from "@capacitor/preferences";
import type { ClientMessage, DeviceIdentity, HostSnapshot, PairingPayload, RelayMessage, ServerMessage } from "@agentterminal/protocol";
import { createRequestId, decodeServerMessage, encodeMessage } from "@agentterminal/protocol";

const HOST_KEY = "agent-terminal-host";

export interface SavedHost {
  id: string;
  name: string;
  endpoint: string;
  transport?: "relay" | "direct";
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
  private readonly connectionId = crypto.randomUUID();
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
    const temporary = new HostConnection({ id: payload.hostId, name: payload.hostName, endpoint: payload.endpoint, transport: payload.transport, deviceId: device.id, deviceToken: "" });
    await temporary.open();
    const response = await temporary.request({ type: "pair", requestId: createRequestId(), token: payload.pairingToken, device });
    if (response.type !== "pair.accepted") throw new Error("The desktop rejected the pairing request.");
    temporary.host.deviceToken = response.deviceToken;
    temporary.snapshot = response.snapshot;
    await Preferences.set({ key: HOST_KEY, value: JSON.stringify(temporary.host) });
    return temporary;
  }

  async connect(): Promise<HostSnapshot> {
    await this.open();
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

  close(): void { this.socket?.close(); }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.host.endpoint);
      const timeout = window.setTimeout(() => { socket.close(); reject(new Error("Could not reach the desktop. Check the relay or desktop connection.")); }, 8_000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.socket = socket;
        if (this.host.transport === "relay") {
          socket.send(JSON.stringify({ type: "relay.connect", hostId: this.host.id, connectionId: this.connectionId } satisfies RelayMessage));
        }
        resolve();
      };
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error("Could not reach the desktop host.")); };
      socket.onclose = () => { this.rejectAll(new Error("Desktop disconnected.")); this.emit("disconnected", undefined); };
      socket.onmessage = (event) => this.receive(String(event.data));
    });
  }

  private receive(raw: string): void {
    if (this.host.transport === "relay") {
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
    if (this.host.transport === "relay") {
      this.socket.send(JSON.stringify({ type: "relay.message", connectionId: this.connectionId, payload } satisfies RelayMessage));
    } else {
      this.socket.send(payload);
    }
  }
}
