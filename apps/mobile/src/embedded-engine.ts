import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { OVERLAY_CONTROL_URL } from "@agentterminal/protocol";

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
  start(options: { controlUrl: string; privateKey: string; nodeId: string; remoteEndpoint: string; authKey?: string }): Promise<{
    nodeId?: string;
    tailnetAddress?: string;
    endpoint?: string;
  }>;
  stop(): Promise<void>;
}

const NativeEmbeddedNode = registerPlugin<EmbeddedNodePlugin>("EmbeddedNode");

/**
 * Keeps the mobile node identity independent from the WebView lifecycle.
 * Native builds may provide the process-isolated engine plugin; browser
 * builds still retain the identity and report that an embedded node is
 * required for off-LAN connections.
 */
export class EmbeddedNodeEngine {
  private state?: EmbeddedNodeState;

  async start(controlUrl: string = OVERLAY_CONTROL_URL, remoteEndpoint?: string, transport: "direct" | "overlay" = "overlay", authKey?: string): Promise<EmbeddedNodeState> {
    const current = await this.load();
    const state: EmbeddedNodeState = {
      ...current,
      proxyEndpoint: undefined,
      engineStarted: false,
      controlUrl,
      lastConnectedAt: new Date().toISOString()
    };

    if (Capacitor.isNativePlatform() && remoteEndpoint && transport === "overlay") {
      try {
        const result = await NativeEmbeddedNode.start({
          controlUrl,
          privateKey: state.privateKey,
          nodeId: state.nodeId,
          remoteEndpoint,
          authKey
        });
        state.nodeId = result.nodeId ?? state.nodeId;
        state.tailnetAddress = result.tailnetAddress ?? state.tailnetAddress;
        state.proxyEndpoint = result.endpoint ?? state.proxyEndpoint;
        state.engineStarted = Boolean(result.endpoint);
      } catch {
        // Keep the persisted identity; the caller reports that the native
        // engine is unavailable instead of silently using a second transport.
      }
    }

    await this.save(state);
    return state;
  }

  async stop(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try { await NativeEmbeddedNode.stop(); } catch { /* best effort */ }
  }

  private async load(): Promise<EmbeddedNodeState> {
    if (this.state) return this.state;
    const { value } = await Preferences.get({ key: ENGINE_STATE_KEY });
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
    await Preferences.set({ key: ENGINE_STATE_KEY, value: JSON.stringify(state) });
  }
}

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
