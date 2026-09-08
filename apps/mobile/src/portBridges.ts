import type { HostSnapshot, PortBridge } from "@agentterminal/protocol";
import { normalizePortBridging, portBridgeStatusOf } from "@agentterminal/protocol";

/**
 * This phone's half of the port bridges.
 *
 * The desktop arbitrates: it decides which device owns each port number and
 * publishes its own half to its node. This turns the same snapshot into the
 * phone's half, which is the mirror image - where the desktop accepts on the
 * tailnet this phone dials it, and where the desktop dials this phone accepts.
 *
 * Only bridges the host marked `active` are built. A port another device holds
 * must not open a local listener here: the phone would then have a socket that
 * accepts connections and forwards them nowhere.
 */

/** One entry of the node's `bridges.json`, as the Go reconciler reads it. */
export interface NodeBridgeSpec {
  id: string;
  mode: "listen-tsnet" | "listen-local";
  port?: number;
  listen?: string;
  target?: string;
  peer?: string;
}

export function phoneBridgeSpecs(snapshot: HostSnapshot | undefined, deviceId: string): NodeBridgeSpec[] {
  if (!snapshot) return [];
  const device = snapshot.devices.find((entry) => entry.id === deviceId);
  if (!device) return [];
  const bridging = normalizePortBridging(device.portBridging);
  if (!bridging.enabled) return [];
  const host = snapshot.hostTailnetAddress;

  const specs: NodeBridgeSpec[] = [];
  for (const bridge of bridging.bridges) {
    if (portBridgeStatusOf(snapshot.portBridgeStatuses, deviceId, bridge.id)?.state !== "active") continue;
    if (bridge.server === "client") {
      // The service runs here: accept on the tailnet and dial our own
      // localhost. The desktop is the only peer the relay can route in.
      specs.push({
        id: bridge.id,
        mode: "listen-tsnet",
        port: bridge.port,
        target: `127.0.0.1:${bridge.port}`,
        ...(host ? { peer: host } : {})
      });
      continue;
    }
    // The service runs on the desktop: accept on our loopback and dial it.
    // Without the host's overlay address there is nothing to dial, so the
    // listener is not opened at all rather than opened and dead.
    if (!host) continue;
    specs.push({
      id: bridge.id,
      mode: "listen-local",
      listen: `127.0.0.1:${bridge.port}`,
      target: `${host}:${bridge.port}`
    });
  }
  return specs;
}

/** Whether this device has bridging switched on at all. */
export function bridgingEnabledFor(snapshot: HostSnapshot | undefined, deviceId: string): boolean {
  const device = snapshot?.devices.find((entry) => entry.id === deviceId);
  return normalizePortBridging(device?.portBridging).enabled;
}

/** This device's configured bridges, whatever became of them. */
export function bridgesFor(snapshot: HostSnapshot | undefined, deviceId: string): PortBridge[] {
  const device = snapshot?.devices.find((entry) => entry.id === deviceId);
  return normalizePortBridging(device?.portBridging).bridges;
}

/**
 * Whether two desired-state lists ask for the same thing, so an unchanged
 * snapshot does not rewrite the file the node is polling.
 */
export function sameBridgeSpecs(left: readonly NodeBridgeSpec[], right: readonly NodeBridgeSpec[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
