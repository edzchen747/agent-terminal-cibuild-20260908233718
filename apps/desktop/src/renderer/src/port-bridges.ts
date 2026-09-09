import { isPortBridgeWarning, normalizePortBridging, portBridgeStatusOf } from "@agentterminal/protocol";
import type { AuthorizedDevice, PortBridgeStatus } from "@agentterminal/protocol";

/**
 * Pure decisions for the Port Bridge pages, kept out of the JSX so they can be
 * unit tested the way the rest of the renderer's logic is.
 */

/**
 * Devices most recently connected first.
 *
 * A live device always outranks an idle one: `lastSeenAt` stops advancing the
 * moment a device drops, so a phone that is connected right now can easily
 * carry the older timestamp.
 */
export function devicesByLastConnected(devices: readonly AuthorizedDevice[]): AuthorizedDevice[] {
  return [...devices].sort((left, right) => {
    if (Boolean(left.online) !== Boolean(right.online)) return left.online ? -1 : 1;
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) || left.name.localeCompare(right.name);
  });
}

/** Whether any of a device's configured bridges is showing a warning. */
export function deviceHasBridgeWarning(
  device: Pick<AuthorizedDevice, "id" | "portBridging">,
  statuses: Record<string, PortBridgeStatus[]> | undefined
): boolean {
  const bridging = normalizePortBridging(device.portBridging);
  // Bridges that are switched off are not meant to be up, so a stale status
  // must not raise a warning the user cannot act on.
  if (!bridging.enabled) return false;
  return bridging.bridges.some((bridge) => isPortBridgeWarning(portBridgeStatusOf(statuses, device.id, bridge.id)));
}
