import { Preferences } from "@capacitor/preferences";
import { Capacitor } from "@capacitor/core";
import type { ClientMessage, DeviceIdentity, HostSnapshot, PairingPayload, ServerMessage } from "@agentterminal/protocol";
import { createRequestId, decodeServerMessage, encodeMessage, LAN_CONNECT_TIMEOUT_MS, OVERLAY_CONTROL_URL, OVERLAY_TAILNET_DOMAIN } from "@agentterminal/protocol";
import { deviceName } from "./device";
import { canAttemptConnection, heartbeatActive, heartbeatCatchUpNeeded, heartbeatIntervalMs, nextReconnectDelay, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from "./connectionPolicy";
import { EmbeddedNodeEngine, type EmbeddedNodeState } from "./embedded-engine";
import { isDroppedNodeEnrollmentError } from "./nodeEnrollment";
import { defaultHostAfterRemoval } from "./hostSelection";

const HOST_KEY = "agent-terminal-host";
const HOSTS_KEY = "agent-terminal-hosts";
const REQUEST_TIMEOUT_MS = 12_000;
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

/** A previously paired desktop: the full connection record plus the last time this phone connected to it. */
export interface SavedHostRecord extends SavedHost {
  lastConnectedAt?: number;
}

type EventMap = {
  snapshot: HostSnapshot;
  output: { sessionId: string; data: string };
  disconnected: undefined;
  connected: HostSnapshot;
  heartbeat: HostSnapshot;
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
  private screenAwake = true;
  private deviceSleeping = false;
  private lastHeartbeatAt = 0;
  private activeEndpoint = "";
  private connectPromise?: Promise<HostSnapshot>;
  private reconnectTimer?: number;
  private reconnectTimeoutTimer?: number;
  private reconnectAttempt = 0;
  private reconnectDelay = RECONNECT_BASE_DELAY_MS;
  private autoReconnect = false;
  private readonly embeddedEngine: EmbeddedNodeEngine;
  private enrollmentPromise?: Promise<void>;
  // One automatic re-attempt per connection: the first registration failure
  // (launch race, provisioning hiccup) retries itself; any further failure
  // waits for the user (desktop parity).
  private automaticRetryArmed = false;
  private remoteRegistration: RemoteRegistrationState;
  private pending = new Map<string, { resolve: (message: ServerMessage) => void; reject: (error: Error) => void }>();
  private listeners = new Map<keyof EventMap, Set<(value: never) => void>>();
  snapshot?: HostSnapshot;

  constructor(public readonly host: SavedHost) {
    // Each desktop has its own phone-side tsnet identity (see
    // EmbeddedNodeEngine); the engine is bound to this host's record.
    this.embeddedEngine = new EmbeddedNodeEngine(this.host.id);
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

  /** Persists a desktop as the launch-time default connection. */
  static async saveHost(host: SavedHost): Promise<void> {
    await Preferences.set({ key: HOST_KEY, value: JSON.stringify(host) });
  }

  /**
   * Previously paired desktop hosts, backing the hosts page. The single
   * saved record above stays the launch default while this list remembers
   * every desktop this phone has paired with.
   */
  static async savedHostRecords(): Promise<SavedHostRecord[]> {
    const { value } = await Preferences.get({ key: HOSTS_KEY });
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((record): record is SavedHostRecord =>
        Boolean(record) &&
        typeof (record as SavedHostRecord).id === "string" &&
        typeof (record as SavedHostRecord).name === "string"
      );
    } catch {
      return [];
    }
  }

  /** Adds a desktop to the previously paired list, or refreshes its entry. */
  static async recordHost(host: SavedHost): Promise<void> {
    const records = await this.savedHostRecords();
    const index = records.findIndex((record) => record.id === host.id);
    const entry: SavedHostRecord = {
      ...host,
      lastConnectedAt: index >= 0 ? records[index]?.lastConnectedAt : undefined
    };
    if (index >= 0) records[index] = entry;
    else records.push(entry);
    await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(records) });
  }

  /** Notes a successful connection so the hosts page can show last connected. */
  static async markHostConnected(id: string): Promise<void> {
    const records = await this.savedHostRecords();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return;
    const record = records[index];
    if (!record) return;
    records[index] = { ...record, lastConnectedAt: Date.now() };
    await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(records) });
  }

  /**
   * Removes a previously paired desktop and returns the remaining list. If
   * the removed entry was the launch default, the default is repointed to
   * the most recently connected survivor, or dropped when none remain.
   */
  static async removeSavedHostRecord(id: string): Promise<SavedHostRecord[]> {
    const records = await this.savedHostRecords();
    const remaining = records.filter((record) => record.id !== id);
    if (remaining.length !== records.length) {
      await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(remaining) });
      await EmbeddedNodeEngine.forget(id);
    }
    const saved = await this.saved();
    if (saved?.id === id) {
      const fallback = defaultHostAfterRemoval(remaining);
      if (fallback) await this.saveHost(fallback);
      else await this.forget();
    }
    return remaining;
  }

  /**
   * Re-verifies a previously paired desktop's phone-side node registration
   * against the control plane. The persisted `remoteEnrolled` flag is never
   * trusted: the node may have been revoked or expired since it was written,
   * so the hosts page only shows "Ready" for a host whose node actually
   * comes back. A host that was never registered never starts a node.
   */
  static async verifySavedHostRegistration(record: SavedHostRecord): Promise<"verified" | "lanOnly"> {
    if (record.remoteEnrolled !== true) return "lanOnly";
    if (!Capacitor.isNativePlatform()) return "verified";
    const engine = new EmbeddedNodeEngine(record.id);
    try {
      const state = await engine.start(
        record.controlUrl ?? OVERLAY_CONTROL_URL,
        record.remoteEndpoint ?? defaultRemoteEndpoint(record.id),
        record.remoteTransport ?? "overlay"
      );
      if (state.engineStarted) return "verified";
    } catch (error) {
      if (isDroppedNodeEnrollmentError(error)) await this.markSavedHostUnregistered(record);
      return "lanOnly";
    } finally {
      await engine.stop();
    }
    return "lanOnly";
  }

  /** A node was revoked or expired: clear both persisted enrollment flags. */
  private static async markSavedHostUnregistered(record: SavedHostRecord): Promise<void> {
    const records = await this.savedHostRecords();
    const index = records.findIndex((entry) => entry.id === record.id);
    if (index >= 0) {
      const entry = records[index];
      if (entry && entry.remoteEnrolled !== false) {
        records[index] = { ...entry, remoteEnrolled: false };
        await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(records) });
      }
    }
    const saved = await this.saved();
    if (saved?.id === record.id && saved.remoteEnrolled === true) {
      await this.saveHost({ ...saved, remoteEnrolled: false });
    }
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
      temporary.automaticRetryArmed = true;
      // Trusted LAN pairing is the commit point. Overlay registration happens
      // independently so provisioning outages never block terminal streaming.
      await Preferences.set({ key: HOST_KEY, value: JSON.stringify(temporary.host) });
      // The new desktop joins the previously paired list here, so it stays
      // listed even if this pairing session is later dropped.
      await this.recordHost(temporary.host);
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
    if (!hasInternet()) {
      // No route, no attempt: connecting can only fail, wake the radio, and
      // burn battery. The online event triggers the retry when the route is
      // back; the notification service already shows "reconnecting".
      this.clearReconnectTimeout();
      throw new Error("Waiting for an internet connection.");
    }

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
    if (!this.autoReconnect || this.closed || !hasInternet()) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      void this.checkHeartbeat();
      return;
    }
    this.clearReconnectTimer();
    this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
    this.scheduleReconnect(0);
  }

  notifyNetworkLost(): void {
    if (!this.autoReconnect || this.closed) return;
    // Pause all reconnect bookkeeping while the route is gone. A closed
    // socket cannot connect and every attempt would wake the radio.
    this.clearReconnectTimer();
    this.clearReconnectTimeout();
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
      return;
    }
    if (hasInternet()) this.scheduleReconnect(0);
  }

  isConnected(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  /** The endpoint the current socket is actually bound to, for the native liveness probe. */
  endpoint(): string {
    return this.activeEndpoint;
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
        if (this.automaticRetryArmed) {
          this.automaticRetryArmed = false;
          window.setTimeout(() => {
            if (this.closed || !this.authenticated || this.socket?.readyState !== WebSocket.OPEN) return;
            void this.retryRemoteRegistration().catch(() => undefined);
          }, 5_000);
        }
        throw error;
      })
      .finally(() => { this.enrollmentPromise = undefined; });
    // Enrollment is intentionally background work. Attach a rejection handler
    // here so the automatic attempt cannot become an unhandled promise.
    attempt.catch(() => undefined);
    this.enrollmentPromise = attempt;
    return attempt;
  }

  /**
   * Launch-time parity with the desktop: instead of trusting the persisted
   * enrollment flag, start this host's saved node identity against the
   * control plane and confirm it still comes back. A node the control plane
   * proves removed is re-enrolled automatically with a fresh key (the
   * run-through of the Retry chain); a transient failure restores the saved
   * verdict so the badge is not left on "Registering" for it.
   */
  private async verifySavedNodeOnLaunch(): Promise<void> {
    this.setRemoteRegistration({ status: "pending" });
    const engine = new EmbeddedNodeEngine(this.host.id);
    try {
      const state = await engine.start(
        this.host.controlUrl ?? OVERLAY_CONTROL_URL,
        this.host.remoteEndpoint ?? defaultRemoteEndpoint(this.host.id),
        this.host.remoteTransport ?? "overlay"
      );
      if (state.engineStarted) {
        if (!this.host.remoteEnrolled) {
          this.host.remoteEnrolled = true;
          await Preferences.set({ key: HOST_KEY, value: JSON.stringify(this.host) });
          void this.syncHostRecordEnrollment();
        }
        this.setRemoteRegistration({ status: "enrolled" });
      } else {
        // No native engine (browser build) or the check was inconclusive:
        // keep the verdict the record already carries.
        this.setRemoteRegistration({ status: this.host.remoteEnrolled ? "enrolled" : "unregistered" });
      }
    } catch (error) {
      if (isDroppedNodeEnrollmentError(error)) {
        await this.markRemoteNodeDropped();
        // The first re-registration of the launch is automatic: the key
        // request travels over the live LAN session the phone just opened.
        queueMicrotask(() => { void this.retryRemoteRegistration().catch(() => undefined); });
      } else {
        this.setRemoteRegistration({ status: this.host.remoteEnrolled ? "enrolled" : "unregistered" });
      }
    } finally {
      await engine.stop();
    }
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
      void this.syncHostRecordEnrollment();
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
    void this.syncHostRecordEnrollment();
    this.setRemoteRegistration({ status: "failed", error: DROPPED_MOBILE_NODE_MESSAGE });
  }

  /**
   * Keeps the previously paired record's enrollment flag current. The launch
   * default (HOST_KEY) and the hosts-page list (HOSTS_KEY) are separate
   * records; host switching starts from a hosts-page record, so a stale
   * flag there would make a still-enrolled host demand a LAN reconnect.
   */
  private async syncHostRecordEnrollment(): Promise<void> {
    const records = await HostConnection.savedHostRecords();
    const index = records.findIndex((record) => record.id === this.host.id);
    if (index < 0) return;
    const record = records[index];
    if (!record || record.remoteEnrolled === this.host.remoteEnrolled) return;
    records[index] = { ...record, remoteEnrolled: this.host.remoteEnrolled };
    await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(records) });
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
      const response = await this.request({ type: "auth", requestId: createRequestId(), deviceId: this.host.deviceId, deviceToken: this.host.deviceToken, name: await deviceName() });
      if (response.type !== "auth.accepted") throw new Error("This phone is not authorized by the desktop.");
      this.snapshot = response.snapshot;
      this.authenticated = true;
      this.automaticRetryArmed = true;
      this.reconnectAttempt = 0;
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
      this.clearReconnectTimeout();
      this.startHeartbeat();
      this.emit("connected", response.snapshot);
      // Bookkeeping only: make sure this desktop is in the previously paired
      // list (upserting it when it was saved by an older build) and note
      // when it was last seen, without ever risking the live connection over
      // a storage write.
      void HostConnection.recordHost(this.host)
        .then(() => HostConnection.markHostConnected(this.host.id))
        .catch(() => undefined);
      if (connectedOverLan && (this.host.remoteTransport ?? "overlay") === "overlay") {
        if (this.host.remoteEnrolled) {
          // Desktop parity: a launch must confirm the saved node still
          // registers before the badge may stay on Ready. A dropped node is
          // re-enrolled automatically below.
          queueMicrotask(() => { void this.verifySavedNodeOnLaunch().catch(() => undefined); });
        } else {
          queueMicrotask(() => { void this.retryRemoteRegistration(); });
        }
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
        this.activeEndpoint = endpoint;
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
    if (!this.authenticated) return;
    // Seed the catch-up window from the start of the cadence: a pointer
    // measured from page load could make a screen wake fire an immediate
    // heartbeat even though the first tick is still on schedule.
    this.lastHeartbeatAt = performance.now();
    this.restartHeartbeat();
  }

  /** Re-arms the interval for the current power cadence without reseeding the catch-up window. */
  private restartHeartbeat(): void {
    if (!this.authenticated) return;
    this.stopHeartbeat(false);
    this.heartbeatTimer = window.setInterval(() => void this.checkHeartbeat(), heartbeatIntervalMs(this.screenAwake));
  }

  private stopHeartbeat(resetInFlight = true): void {
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (resetInFlight) this.heartbeatInFlight = false;
  }

  private async checkHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight || !this.isConnected()) return;
    // Cadence follows the power state: 10s while the screen is on, 60s while
    // it is off, none while the device sleeps (the WebView is frozen with it).
    // Ticks that land while inactive return early instead of stacking up, and
    // the wake/awake transitions run one overdue check at most (setPowerState).
    if (!heartbeatActive(navigator.onLine, this.deviceSleeping)) return;
    this.heartbeatInFlight = true;
    this.lastHeartbeatAt = performance.now();
    try {
      const response = await this.request({ type: "snapshot.request", requestId: createRequestId() });
      if (response.type === "snapshot") this.emit("heartbeat", response.snapshot);
    } catch {
      // The desktop is gone even though the socket reports OPEN (half-open
      // through the overlay proxy). forceSocketClose treats the timeout as
      // the authoritative disconnect: it does not wait for onclose to fire.
      if (!this.closed) this.forceSocketClose();
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  /**
   * Native power events keep the heartbeat policy honest: the interval ticks
   * on its own schedule, so while the screen is off there is one check every
   * 60s instead of 10s, and none at all while the device sleeps. Coming awake
   * runs a check immediately when a whole cadence was missed - never a queue
   * of accrued refreshes. heartbeatInFlight caps concurrent requests.
   */
  setScreenAwake(awake: boolean): void {
    this.screenAwake = awake;
    if (this.heartbeatTimer !== undefined) this.restartHeartbeat();
    if (!awake || !this.isConnected()) return;
    if (heartbeatCatchUpNeeded(this.lastHeartbeatAt, performance.now(), heartbeatIntervalMs(awake))) void this.checkHeartbeat();
  }

  /**
   * Doze/sleep enters a hard pause: the OS freezes the WebView with the
   * device, so no timer survives anyway, and the heartbeat must not try until
   * the device comes back. The transition back to awake is handled by
   * setScreenAwake's overdue check.
   */
  setDeviceSleeping(sleeping: boolean): void {
    this.deviceSleeping = sleeping;
    if (this.heartbeatTimer !== undefined) this.restartHeartbeat();
    if (sleeping || !this.isConnected()) return;
    if (heartbeatCatchUpNeeded(this.lastHeartbeatAt, performance.now(), heartbeatIntervalMs(this.screenAwake))) void this.checkHeartbeat();
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (!this.autoReconnect || this.closed || this.reconnectTimer !== undefined || this.connectPromise) return;
    if (!hasInternet()) {
      // Defer reconnects instead of failing: the online event restarts the
      // connection with the base delay when a route exists again.
      this.clearReconnectTimeout();
      return;
    }
    this.startReconnectTimeout();
    const delayMs = delayOverride ?? this.reconnectDelay;
    this.reconnectAttempt += 1;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.reconnectDelay = nextReconnectDelay(this.reconnectDelay);
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
    if (!hasInternet()) return;
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
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    // A dead desktop leaves the socket half-open: the close handshake never
    // completes and onclose may never fire, so the request timeout is the
    // authoritative disconnect. Bump the generation so the late close event
    // is ignored, then run the teardown onclose would have run.
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    this.stopHeartbeat();
    socket.close();
    this.rejectAll(new Error("Desktop disconnected."));
    if (!this.closed) {
      this.emit("disconnected", undefined);
      this.scheduleReconnect();
    }
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

function hasInternet(): boolean {
  return canAttemptConnection(navigator.onLine);
}

function isEmbeddedNodeConfigurationError(error: unknown): boolean {
  return error instanceof Error && /update the (desktop|mobile) app|enrollment key was rejected|tsnet desktop host name|remote registration is still pending|remote node is no longer registered/i.test(error.message);
}
