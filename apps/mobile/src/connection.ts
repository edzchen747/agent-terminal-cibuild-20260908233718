import { Preferences } from "@capacitor/preferences";
import type { ClientMessage, DeviceIdentity, HostSnapshot, PairingPayload, ServerMessage } from "@agentterminal/protocol";
import { createRequestId, decodeServerMessage, encodeMessage, LAN_CONNECT_TIMEOUT_MS, OVERLAY_CONTROL_URL, OVERLAY_TAILNET_DOMAIN } from "@agentterminal/protocol";
import { EmbeddedNodeEngine, type EmbeddedNodeState } from "./embedded-engine";
import { isDroppedNodeEnrollmentError } from "./nodeEnrollment";

const HOST_KEY = "agent-terminal-host";
const REQUEST_TIMEOUT_MS = 12_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_TIMEOUT_MS = 30_000;
const DROPPED_MOBILE_NODE_MESSAGE = "This phone's remote node is no longer registered. Reconnect to the desktop on LAN; remote registration will refresh automatically.";

export interface SavedHost {
  id: string;
  name: string;
  /** Kept as the LAN endpoint for backwards-compatible saved records. */
  endpoint: string;
  localEndpoint?: string;
  remoteEndpoint?: string;
  controlUrl?: string;
  transport?: "direct" | "overlay";
  remoteTransport?: "direct" | "overlay";
  deviceId: string;
  deviceToken: string;
  remoteEnrolled?: boolean;
}

export type RemoteRegistrationState = {
  status: "unregistered" | "pending" | "enrolled" | "failed";
  error?: string;
};

type EventMap = {
  snapshot: HostSnapshot;
  output: { sessionId: string; data: string };
  disconnected: undefined;
  connected: HostSnapshot;
  reconnecting: { attempt: number; delayMs: number };
  reconnectFailed: Error;
  remoteRegistration: RemoteRegistrationState;
};

export class HostConnection {
  private socket?: WebSocket;
  private socketGeneration = 0;
  private closed = false;
  private authenticated = false;
  private heartbeatTimer?: number;
  private heartbeatInFlight = false;
  private connectPromise?: Promise<HostSnapshot>;
  private reconnectTimer?: number;
  private reconnectTimeoutTimer?: number;
  private reconnectAttempt = 0;
  private reconnectDelay = RECONNECT_BASE_DELAY_MS;
  private autoReconnect = false;
  private readonly embeddedEngine = new EmbeddedNodeEngine();
  private enrollmentPromise?: Promise<void>;
  private remoteRegistration: RemoteRegistrationState;
  private pending = new Map<string, { resolve: (message: ServerMessage) => void; reject: (error: Error) => void }>();
  private listeners = new Map<keyof EventMap, Set<(value: never) => void>>();
  snapshot?: HostSnapshot;

  constructor(public readonly host: SavedHost) {
    this.remoteRegistration = { status: host.remoteEnrolled ? "enrolled" : "unregistered" };
  }

  static async saved(): Promise<SavedHost | null> {
    const { value } = await Preferences.get({ key: HOST_KEY });
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as SavedHost & { nodeAuthKey?: string };
      if ("nodeAuthKey" in parsed) {
        // Purge credentials persisted by builds that copied a shared key out
        // of the QR. An enrolled node only needs its native persistent state.
        delete parsed.nodeAuthKey;
        await Preferences.set({ key: HOST_KEY, value: JSON.stringify(parsed) });
      }
      return parsed;
    } catch { return null; }
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
      remoteEndpoint: payload.remoteEndpoint ?? defaultRemoteEndpoint(payload.hostId),
      controlUrl: payload.controlUrl ?? OVERLAY_CONTROL_URL,
      transport: "direct",
      remoteTransport: payload.remoteTransport ?? "overlay",
      deviceId: device.id,
      deviceToken: ""
    });
    try {
      await temporary.open(localEndpoint, LAN_CONNECT_TIMEOUT_MS);
      const response = await temporary.request({ type: "pair", requestId: createRequestId(), token: payload.pairingToken, device });
      if (response.type !== "pair.accepted") throw new Error("The desktop rejected the pairing request.");
      temporary.host.deviceToken = response.deviceToken;
      temporary.snapshot = response.snapshot;
      temporary.authenticated = true;
      // Trusted LAN pairing is the commit point. Overlay registration happens
      // independently so provisioning outages never block terminal streaming.
      await Preferences.set({ key: HOST_KEY, value: JSON.stringify(temporary.host) });
      temporary.startHeartbeat();
      queueMicrotask(() => { void temporary.retryRemoteRegistration(); });
      return temporary;
    } catch (error) {
      temporary.close();
      throw error;
    }
  }

  async connect(): Promise<HostSnapshot> {
    if (this.closed) throw new Error("Connection closed.");
    if (this.socket?.readyState === WebSocket.OPEN && this.snapshot && this.authenticated) {
      return this.snapshot;
    }
    if (this.connectPromise) return this.connectPromise;

    this.startReconnectTimeout();
    let failed = false;
    const attempt = this.connectOnce()
      .catch((error) => {
        failed = true;
        if (isEmbeddedNodeConfigurationError(error)) {
          this.autoReconnect = false;
          this.clearReconnectTimer();
          this.clearReconnectTimeout();
          this.emit("reconnectFailed", error instanceof Error ? error : new Error("The embedded network node is unavailable."));
        }
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
        if (failed && this.autoReconnect) this.scheduleReconnect();
      });
    this.connectPromise = attempt;
    return attempt;
  }

  startAutoReconnect(): void {
    this.autoReconnect = true;
  }

  stopAutoReconnect(): void {
    this.autoReconnect = false;
    this.clearReconnectTimer();
    this.clearReconnectTimeout();
  }

  retryNow(): void {
    if (!this.autoReconnect || this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      void this.checkHeartbeat();
      return;
    }
    this.clearReconnectTimer();
    this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
    this.scheduleReconnect(0);
  }

  isConnected(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  isClosed(): boolean {
    return this.closed;
  }

  remoteRegistrationState(): RemoteRegistrationState {
    return { ...this.remoteRegistration };
  }

  retryRemoteRegistration(): Promise<void> {
    if (this.enrollmentPromise) return this.enrollmentPromise;
    if (this.closed || !this.authenticated || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Reconnect to the paired desktop before retrying remote registration."));
    }
    this.setRemoteRegistration({ status: "pending" });
    const attempt = this.enrollMobile()
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error("Remote connection registration failed.");
        this.setRemoteRegistration({
          status: "failed",
          error: /update the desktop app/i.test(error.message)
            ? error.message
            : "Remote connection registration failed. LAN access is still available."
        });
        throw error;
      })
      .finally(() => { this.enrollmentPromise = undefined; });
    // Enrollment is intentionally background work. Attach a rejection handler
    // here so the automatic attempt cannot become an unhandled promise.
    attempt.catch(() => undefined);
    this.enrollmentPromise = attempt;
    return attempt;
  }

  private async enrollMobile(): Promise<void> {
    const response = await this.request({
      type: "node.enroll",
      requestId: createRequestId(),
      nonce: crypto.randomUUID()
    });
    if (response.type !== "node.enrollment") throw new Error("The desktop did not issue a mobile enrollment key.");

    let authKey: string | undefined = response.authKey;
    response.authKey = "";
    try {
      const state = await this.embeddedEngine.start(
        this.host.controlUrl ?? OVERLAY_CONTROL_URL,
        this.host.remoteEndpoint ?? defaultRemoteEndpoint(this.host.id),
        this.host.remoteTransport ?? "overlay",
        authKey
      );
      if ((this.host.remoteTransport ?? "overlay") === "overlay" && !state.engineStarted) {
        throw new Error("The native embedded network node is unavailable.");
      }
      this.host.remoteEnrolled = true;
      await Preferences.set({ key: HOST_KEY, value: JSON.stringify(this.host) });
      this.setRemoteRegistration({ status: "enrolled" });
    } finally {
      authKey = undefined;
    }
  }

  private setRemoteRegistration(state: RemoteRegistrationState): void {
    this.remoteRegistration = state;
    this.emit("remoteRegistration", { ...state });
  }

  private async markRemoteNodeDropped(): Promise<void> {
    this.host.remoteEnrolled = false;
    await Preferences.set({ key: HOST_KEY, value: JSON.stringify(this.host) });
    this.setRemoteRegistration({ status: "failed", error: DROPPED_MOBILE_NODE_MESSAGE });
  }

  private async connectOnce(): Promise<HostSnapshot> {
    this.authenticated = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    if (this.socket) this.abortSocket();

    const localEndpoint = this.host.localEndpoint ?? (this.host.transport === "direct" ? this.host.endpoint : undefined);
    let connectedOverLan = false;
    try {
      if (localEndpoint) {
        try {
          await this.open(localEndpoint, LAN_CONNECT_TIMEOUT_MS);
          connectedOverLan = true;
        } catch {
          this.abortSocket();
        }
      }

      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        const remoteEndpoint = this.host.remoteEndpoint ?? defaultRemoteEndpoint(this.host.id);
        const remoteTransport = this.host.remoteTransport ?? "overlay";
        if (remoteTransport === "overlay" && !this.host.remoteEnrolled) {
          throw new Error(DROPPED_MOBILE_NODE_MESSAGE);
        }
        let nodeState: EmbeddedNodeState;
        try {
          nodeState = await this.embeddedEngine.start(this.host.controlUrl ?? OVERLAY_CONTROL_URL, remoteEndpoint, remoteTransport);
        } catch (error) {
          if (remoteTransport === "overlay" && isDroppedNodeEnrollmentError(error)) {
            await this.markRemoteNodeDropped();
            throw new Error(DROPPED_MOBILE_NODE_MESSAGE);
          }
          throw error;
        }
        if (remoteTransport === "overlay" && !nodeState.proxyEndpoint) {
          throw new Error("The embedded network node is unavailable for a remote connection.");
        }
        await this.open(nodeState.proxyEndpoint ?? remoteEndpoint, 8_000);
      }
      const response = await this.request({ type: "auth", requestId: createRequestId(), deviceId: this.host.deviceId, deviceToken: this.host.deviceToken });
      if (response.type !== "auth.accepted") throw new Error("This phone is not authorized by the desktop.");
      this.snapshot = response.snapshot;
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
      this.clearReconnectTimeout();
      this.startHeartbeat();
      this.emit("connected", response.snapshot);
      if (connectedOverLan && (this.host.remoteTransport ?? "overlay") === "overlay" && !this.host.remoteEnrolled) {
        queueMicrotask(() => { void this.retryRemoteRegistration(); });
      }
      return response.snapshot;
    } catch (error) {
      this.abortSocket();
      throw error;
    }
  }

  async request(message: ClientMessage): Promise<ServerMessage> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("The desktop is not connected.");
    if (!("requestId" in message)) {
      this.sendPayload(encodeMessage(message));
      return { type: "ok", requestId: "" };
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error("The desktop did not respond."));
        if (this.authenticated) this.forceSocketClose();
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(message.requestId, {
        resolve: (response) => { window.clearTimeout(timeout); resolve(response); },
        reject: (error) => { window.clearTimeout(timeout); reject(error); }
      });
      try {
        this.sendPayload(encodeMessage(message));
      } catch (error) {
        this.pending.delete(message.requestId);
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("The desktop connection is unavailable."));
        this.forceSocketClose();
      }
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.sendPayload(encodeMessage(message));
    } catch {
      this.forceSocketClose();
    }
  }

  on<K extends keyof EventMap>(event: K, callback: (value: EventMap[K]) => void): () => void {
    const callbacks = this.listeners.get(event) ?? new Set();
    callbacks.add(callback as (value: never) => void);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback as (value: never) => void);
  }

  close(): void {
    this.closed = true;
    this.autoReconnect = false;
    this.clearReconnectTimer();
    this.clearReconnectTimeout();
    this.stopHeartbeat();
    this.authenticated = false;
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.rejectAll(new Error("Connection closed."));
    void this.embeddedEngine.stop();
  }

  private open(endpoint: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const generation = ++this.socketGeneration;
      const socket = new WebSocket(endpoint);
      let opened = false;
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("The desktop connection attempt timed out."));
      }, timeoutMs);
      socket.onopen = () => {
        if (generation !== this.socketGeneration || this.closed) {
          socket.close();
          return;
        }
        window.clearTimeout(timeout);
        opened = true;
        settled = true;
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => {
        if (opened || settled) return;
        window.clearTimeout(timeout);
        settled = true;
        reject(new Error("Could not reach the desktop host."));
      };
      socket.onclose = () => {
        window.clearTimeout(timeout);
        if (this.socket === socket) this.socket = undefined;
        if (generation !== this.socketGeneration) return;
        if (!opened) {
          if (!settled) {
            settled = true;
            reject(new Error("The desktop connection closed during setup."));
          }
          return;
        }
        this.authenticated = false;
        this.stopHeartbeat();
        this.rejectAll(new Error("Desktop disconnected."));
        if (!this.closed) {
          this.emit("disconnected", undefined);
          this.scheduleReconnect();
        }
      };
      socket.onmessage = (event) => {
        if (generation === this.socketGeneration) this.receive(String(event.data));
      };
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.authenticated) return;
    this.heartbeatTimer = window.setInterval(() => void this.checkHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatInFlight = false;
  }

  private async checkHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight || !this.isConnected()) return;
    this.heartbeatInFlight = true;
    try {
      await this.request({ type: "snapshot.request", requestId: createRequestId() });
    } catch {
      if (!this.closed) this.forceSocketClose();
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (!this.autoReconnect || this.closed || this.reconnectTimer !== undefined || this.connectPromise) return;
    this.startReconnectTimeout();
    const delayMs = delayOverride ?? this.reconnectDelay;
    this.reconnectAttempt += 1;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.reconnectDelay = Math.min(RECONNECT_MAX_DELAY_MS, Math.max(RECONNECT_BASE_DELAY_MS, this.reconnectDelay * 2));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private startReconnectTimeout(): void {
    if (!this.autoReconnect || this.closed || this.isConnected() || this.reconnectTimeoutTimer !== undefined) return;
    this.reconnectTimeoutTimer = window.setTimeout(() => {
      this.reconnectTimeoutTimer = undefined;
      if (!this.autoReconnect || this.closed || this.isConnected()) return;
      const error = new Error("Could not reach the desktop within 30 seconds.");
      this.close();
      this.emit("reconnectFailed", error);
    }, RECONNECT_TIMEOUT_MS);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeoutTimer !== undefined) window.clearTimeout(this.reconnectTimeoutTimer);
    this.reconnectTimeoutTimer = undefined;
  }

  private receive(raw: string): void {
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("The desktop is not connected.");
    this.socket.send(payload);
  }

  private forceSocketClose(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }

  private abortSocket(): void {
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    this.stopHeartbeat();
    socket?.close();
    this.rejectAll(new Error("Connection attempt was replaced."));
  }
}

function defaultRemoteEndpoint(hostId: string): string {
  return `ws://${hostId}.${OVERLAY_TAILNET_DOMAIN}:47831`;
}

function isEmbeddedNodeConfigurationError(error: unknown): boolean {
  return error instanceof Error && /update the (desktop|mobile) app|enrollment key was rejected|tsnet desktop host name|remote registration is still pending|remote node is no longer registered/i.test(error.message);
}
