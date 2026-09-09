/**
 * Port Bridge: userspace TCP reverse proxies between the desktop host and a
 * paired client.
 *
 * A bridge names one port number and one side that acts as the *server* - the
 * side where the real service already listens on `127.0.0.1:port`. The other
 * side opens a local listener on its own `127.0.0.1:port` and forwards the
 * connection to the server side over the overlay. The bytes travel through the
 * embedded tsnet node, not through this protocol socket; what the protocol
 * carries is the configuration, the host's arbitration of the port, and the
 * status each side reports back.
 *
 * Ports are unique within one device. Between devices they may collide, and
 * the host resolves a collision first-come-first-served: the connected device
 * that claimed the port keeps it until it disconnects.
 */

/** Which side of the bridge the real service runs on. */
export type PortBridgeServer = "host" | "client";

export interface PortBridge {
  id: string;
  port: number;
  /** The side that already listens on `127.0.0.1:port`. */
  server: PortBridgeServer;
  /**
   * What the user calls this bridge ("dev server", "ollama"). Optional and
   * purely for the config pages: it never reaches the node, so renaming one
   * cannot disturb a live bridge.
   */
  label?: string;
}

export interface DevicePortBridging {
  enabled: boolean;
  bridges: PortBridge[];
}

/**
 * What the host made of one configured bridge.
 *
 * - `active` - both sides are proxying.
 * - `pending` - bridging is on but the bridge is not up yet: the device is
 *   offline, or its overlay node has not reported an address.
 * - `conflict` - another connected device claimed this port first.
 * - `failed` - a side could not open its listener (usually the local port is
 *   already in use by an unrelated program).
 * - `disabled` - bridging is switched off for the device.
 */
export type PortBridgeState = "active" | "pending" | "conflict" | "failed" | "disabled";

export interface PortBridgeStatus {
  bridgeId: string;
  state: PortBridgeState;
  /** Human-readable reason, shown in the warning tooltip. */
  detail?: string;
}

export const MIN_BRIDGE_PORT = 1 as const;
export const MAX_BRIDGE_PORT = 65_535 as const;
export const MAX_BRIDGE_LABEL_LENGTH = 40 as const;

/** Trim a label and drop it entirely when nothing is left. */
export function normalizeBridgeLabel(label: string | undefined): string | undefined {
  const trimmed = (label ?? "").trim().slice(0, MAX_BRIDGE_LABEL_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}

export function emptyPortBridging(): DevicePortBridging {
  return { enabled: false, bridges: [] };
}

/** A host older than this feature omits the field entirely. */
export function normalizePortBridging(value: DevicePortBridging | undefined): DevicePortBridging {
  if (!value) return emptyPortBridging();
  return { enabled: Boolean(value.enabled), bridges: Array.isArray(value.bridges) ? value.bridges : [] };
}

export function isValidBridgePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_BRIDGE_PORT && port <= MAX_BRIDGE_PORT;
}

/**
 * The ids of every bridge whose port repeats within the same device. The
 * first bridge to use a port is left out: it is the one the user keeps, and
 * the later duplicates are the rows the config page marks invalid.
 */
export function duplicatePortIds(bridges: readonly PortBridge[]): string[] {
  const seen = new Set<number>();
  const duplicates: string[] = [];
  for (const bridge of bridges) {
    if (seen.has(bridge.port)) duplicates.push(bridge.id);
    else seen.add(bridge.port);
  }
  return duplicates;
}

/** Whether `port` can still be added to this device's list. */
export function canAddBridgePort(bridges: readonly PortBridge[], port: number): boolean {
  return isValidBridgePort(port) && !bridges.some((bridge) => bridge.port === port);
}

/** Which machine the service lives on, phrased for the side that is reading. */
export function bridgeDirectionLabel(bridge: Pick<PortBridge, "server">, audience: "desktop" | "mobile"): string {
  if (bridge.server === "host") return audience === "desktop" ? "Served by this PC" : "Served by the desktop";
  return audience === "desktop" ? "Served by the device" : "Served by this phone";
}

/** The status text a bridge row shows next to its port. */
export function bridgeStateLabel(state: PortBridgeState): string {
  switch (state) {
    case "active": return "Bridged";
    case "pending": return "Waiting";
    case "conflict": return "Port taken";
    case "failed": return "Not bridged";
    case "disabled": return "Off";
  }
}

/** Whether the Port Bridge page should show a warning marker for this status. */
export function isPortBridgeWarning(status: PortBridgeStatus | undefined): boolean {
  return status?.state === "conflict" || status?.state === "failed";
}

/**
 * The warning tooltip. The host always sends a `detail`; the fallbacks keep
 * the marker meaningful if a status arrives without one.
 */
export function bridgeWarningDetail(bridge: Pick<PortBridge, "port">, status: PortBridgeStatus | undefined): string {
  if (!status || !isPortBridgeWarning(status)) return "";
  if (status.detail) return status.detail;
  if (status.state === "conflict") return `Port ${bridge.port} is already bridged by another device.`;
  return `Port ${bridge.port} could not be bridged.`;
}

export function portBridgeStatusOf(
  statuses: Record<string, PortBridgeStatus[]> | undefined,
  deviceId: string,
  bridgeId: string
): PortBridgeStatus | undefined {
  return statuses?.[deviceId]?.find((status) => status.bridgeId === bridgeId);
}

/**
 * The list edits both config pages make. They are here rather than in either
 * UI because the desktop page and the phone page offer the same operations on
 * the same list, and the two would otherwise drift.
 */
export function createBridge(port: number, server: PortBridgeServer, label?: string): PortBridge {
  const named = normalizeBridgeLabel(label);
  return { id: globalThis.crypto.randomUUID(), port, server, ...(named ? { label: named } : {}) };
}

export function addBridge(
  bridges: readonly PortBridge[],
  port: number,
  server: PortBridgeServer,
  label?: string
): PortBridge[] {
  if (!canAddBridgePort(bridges, port)) return [...bridges];
  return [...bridges, createBridge(port, server, label)];
}

/**
 * Change one bridge in place. A port already used by another bridge on the
 * same device is rejected: within a device the ports must be unique, which is
 * the one rule the config page enforces itself rather than leaving to the
 * host.
 */
export function updateBridge(
  bridges: readonly PortBridge[],
  id: string,
  patch: Partial<Pick<PortBridge, "port" | "server" | "label">>
): PortBridge[] {
  return bridges.map((bridge) => {
    if (bridge.id !== id) return bridge;
    const port = patch.port ?? bridge.port;
    const taken = bridges.some((other) => other.id !== id && other.port === port);
    const label = "label" in patch ? normalizeBridgeLabel(patch.label) : bridge.label;
    const next: PortBridge = {
      ...bridge,
      port: isValidBridgePort(port) && !taken ? port : bridge.port,
      server: patch.server ?? bridge.server
    };
    // Assigning undefined would leave the key present; clearing a label has
    // to actually remove it so the row falls back to showing its port.
    if (label) next.label = label; else delete next.label;
    return next;
  });
}

export function removeBridge(bridges: readonly PortBridge[], id: string): PortBridge[] {
  return bridges.filter((bridge) => bridge.id !== id);
}

/**
 * What a bridge row is called: the user's label when they gave one, and the
 * port itself otherwise, so a row is never nameless.
 */
export function bridgeDisplayName(bridge: Pick<PortBridge, "port" | "label">): string {
  return bridge.label ?? String(bridge.port);
}

/** Bridges shown in a stable order, so a saved edit never reshuffles the page. */
export function sortedBridges(bridges: readonly PortBridge[]): PortBridge[] {
  return [...bridges].sort((left, right) => left.port - right.port || left.id.localeCompare(right.id));
}
