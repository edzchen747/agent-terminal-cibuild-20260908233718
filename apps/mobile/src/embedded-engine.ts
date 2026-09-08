import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { OVERLAY_CONTROL_URL } from "@agentterminal/protocol";
import { asEmbeddedNodeFailure } from "./nodeEnrollment";
import type { NodeBridgeSpec } from "./portBridges";

const ENGINE_STATE_KEY = "agent-terminal-embedded-node";

export interface EmbeddedNodeState {
  privateKey: string;
  nodeId: string;
  controlUrl: string;
  tailnetAddress?: string;
  proxyEndpoint?: string;
  engineStarted?: boolean;
  lastConnectedAt?: string;
}

interface EmbeddedNodePlugin {
  start(options: { controlUrl: string; privateKey: string; nodeId: string; remoteEndpoint: string; authKey?: string; stateKey?: string }): Promise<{
    nodeId?: string;
    tailnetAddress?: string;
    endpoint?: string;
  }>;
  stop(options?: { stateKey?: string }): Promise<void>;
  setBridges(options: { stateKey?: string; revision: number; bridges: NodeBridgeSpec[] }): Promise<void>;
  bridgeStatus(options: { stateKey?: string }): Promise<{ bridges?: { id?: string; state?: string; error?: string }[] }>;
}

const NativeEmbeddedNode = registerPlugin<EmbeddedNodePlugin>("EmbeddedNode");

/**
 * Keeps the mobile node identity independent from the WebView lifecycle.
 * Native builds may provide the process-isolated engine plugin; browser
 * builds still retain the identity and report that an embedded node is
 * required for off-LAN connections.
 *
 * Each paired desktop gets its own identity: the relay isolates every
 * pairing group in its own Headscale user, so a phone-side tsnet node
 * enrolled under one host's user can only ever reach that host's desktop
 * node. One shared phone node therefore could only ever belong to one
 * host, which is exactly why every host but the last-enrolled one failed
 * over tsnet. Persisting the identity per host (and running the native
 * engine in a matching per-host state directory via `stateKey`) lets each
 * host keep its own phone-side node.
 */
export class EmbeddedNodeEngine {
  private state?: EmbeddedNodeState;
  private readonly hostId?: string;
  private readonly storageKey: string;

  constructor(hostId?: string) {
    this.hostId = hostId;
    this.storageKey = hostId ? `${ENGINE_STATE_KEY}-${hostId}` : ENGINE_STATE_KEY;
  }

  /**
   * Start (or adopt) this host's node.
   *
   * `force` starts the node even on a direct/LAN connection. Port bridges run
   * through the node whatever the terminal socket happens to be using, so a
   * phone that is bridging keeps its node up on LAN too.
   */
  async start(controlUrl: string = OVERLAY_CONTROL_URL, remoteEndpoint?: string, transport: "direct" | "overlay" = "overlay", authKey?: string, force = false): Promise<EmbeddedNodeState> {
    const current = await this.load();
    const state: EmbeddedNodeState = {
      ...current,
      proxyEndpoint: undefined,
      engineStarted: false,
      controlUrl,
      lastConnectedAt: new Date().toISOString()
    };

    if (Capacitor.isNativePlatform() && remoteEndpoint && (transport === "overlay" || force)) {
      try {
        const result = await NativeEmbeddedNode.start({
          controlUrl,
          privateKey: state.privateKey,
          nodeId: state.nodeId,
          remoteEndpoint,
          authKey,
          // The native process persists the tsnet node key in its state
          // directory; the per-host key keeps one host's enrollment from
          // ever being resumed by another host's process.
          stateKey: this.hostId
        });
        state.nodeId = result.nodeId ?? state.nodeId;
        state.tailnetAddress = result.tailnetAddress ?? state.tailnetAddress;
        state.proxyEndpoint = result.endpoint ?? state.proxyEndpoint;
        state.engineStarted = Boolean(result.endpoint);
      } catch (error) {
        // Keep the persisted identity, but preserve the native error so the
        // caller can explain whether the enrollment key or target hostname
        // needs attention.
        await this.save(state);
        throw asEmbeddedNodeFailure(error);
      }
    }

    await this.save(state);
    return state;
  }

  /**
   * Publish this phone's half of the port bridges for the node to reconcile
   * against. Safe with no node running: the file is picked up on its next
   * start, which is how a bridge comes up as soon as the node does.
   */
  async setBridges(bridges: NodeBridgeSpec[], revision: number): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    await NativeEmbeddedNode.setBridges({ stateKey: this.hostId, revision, bridges });
  }

  /**
   * What the node made of them. An empty list means it has not reconciled
   * yet, which is not the same as "everything failed".
   */
  async bridgeStatus(): Promise<{ id: string; state: string; error?: string }[]> {
    if (!Capacitor.isNativePlatform()) return [];
    const result = await NativeEmbeddedNode.bridgeStatus({ stateKey: this.hostId });
    return (result.bridges ?? [])
      .filter((entry): entry is { id: string; state: string; error?: string } => typeof entry.id === "string" && typeof entry.state === "string");
  }

  /**
   * Stops only this engine's own node process. The native plugin can run one
   * node per paired desktop side by side (the live connection's node must
   * survive background registration checks for other hosts); an engine
   * without a host (legacy) stops every node.
   */
  async stop(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try { await NativeEmbeddedNode.stop({ stateKey: this.hostId ?? "" }); } catch { /* best effort */ }
  }

  /**
   * Drops the persisted identity of a desktop that was unpaired and stops
   * its node process. The tsnet node it registered stays in the relay until
   * inactivity expiry, so no relay-side cleanup is needed; only the local
   * record goes away.
   *
   * The native stop is fire-and-forget: the plugin serializes start and
   * stop on one dedicated lifecycle thread, and a start can occupy it for
   * up to 30 seconds while a tsnet node comes up (the hosts-page
   * background checks start engines for every registered desktop). An
   * unpair must not queue behind that, or the hosts list removal the UI
   * awaits on this call lingers on screen even though storage was already
   * updated. (The lifecycle thread is separate from Capacitor's shared
   * plugin thread, so engine start/stop can no longer stall the app's
   * other plugin calls - the delete path's Preferences round-trips.)
   */
  static async forget(hostId: string): Promise<void> {
    await Preferences.remove({ key: `${ENGINE_STATE_KEY}-${hostId}` });
    if (!Capacitor.isNativePlatform()) return;
    void NativeEmbeddedNode.stop({ stateKey: hostId }).catch(() => { /* best effort */ });
  }

  private async load(): Promise<EmbeddedNodeState> {
    if (this.state) return this.state;
    const { value } = await Preferences.get({ key: this.storageKey });
    if (value) {
      try {
        const parsed = JSON.parse(value) as Partial<EmbeddedNodeState>;
        if (parsed.privateKey && parsed.nodeId) {
          this.state = {
            privateKey: parsed.privateKey,
            nodeId: parsed.nodeId,
            controlUrl: parsed.controlUrl ?? OVERLAY_CONTROL_URL,
            tailnetAddress: parsed.tailnetAddress,
            proxyEndpoint: parsed.proxyEndpoint,
            engineStarted: parsed.engineStarted ?? false,
            lastConnectedAt: parsed.lastConnectedAt
          };
          return this.state;
        }
      } catch {
        // Replace a corrupt record with a new identity below.
      }
    }
    this.state = {
      privateKey: randomKey(),
      nodeId: crypto.randomUUID(),
      controlUrl: OVERLAY_CONTROL_URL
    };
    return this.state;
  }

  private async save(state: EmbeddedNodeState): Promise<void> {
    this.state = state;
    await Preferences.set({ key: this.storageKey, value: JSON.stringify(state) });
  }
}

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
