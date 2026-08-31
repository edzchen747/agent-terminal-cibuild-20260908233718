/**
 * Pure rules for the previously paired desktops list (the hosts page).
 * App.tsx keeps a live copy of the persisted list and hands it to these
 * functions so the ordering and display rules stay testable without the
 * Capacitor storage layer.
 */

/** The minimum shape of a persisted host entry these rules need. */
export interface HostRef {
  id: string;
  lastConnectedAt?: number;
}

/**
 * Sorts the hosts most recently connected first. Hosts we have never seen
 * connected (no timestamp) come after, keeping list order, so display and
 * default selection are stable.
 */
export function sortHostsByLastConnected<T extends HostRef>(hosts: readonly T[]): T[] {
  return hosts
    .map((host, position) => ({ host, position, lastConnectedAt: host.lastConnectedAt ?? 0 }))
    .sort((a, b) => (b.lastConnectedAt - a.lastConnectedAt) || (a.position - b.position))
    .map((entry) => entry.host);
}

/**
 * The launch default after a host is removed: the most recently connected
 * survivor, or null when nothing is left.
 */
export function defaultHostAfterRemoval<T extends HostRef>(remaining: readonly T[]): T | null {
  const first = sortHostsByLastConnected(remaining)[0];
  return first ?? null;
}

/** "Last connected …" label for a host row on the hosts page. */
export function lastConnectedLabel(timestamp: number | undefined, now: number = Date.now()): string {
  if (!timestamp) return "Never";
  const elapsedMs = Math.max(0, now - timestamp);
  if (elapsedMs < 60_000) return "Just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(elapsedMs / 86_400_000);
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Registration states shared with the desktop badge. */
export type RegistrationDisplayStatus = "unregistered" | "pending" | "enrolled" | "failed" | "offline";

/** Where a hosts-page row stands in its background registration check. */
export type HostCheckState = "checking" | "verified" | "lanOnly";

/**
 * The registration badge shown for a hosts-page row. The connected desktop's
 * badge follows its live connection state; every other row is only trusted
 * after its own check ran: a never-registered host shows LAN only right away,
 * a registered one stays "checking" until the verification comes back.
 */
export function hostRowRegistrationStatus(input: {
  remoteEnrolled?: boolean;
  isCurrent: boolean;
  liveStatus: RegistrationDisplayStatus;
  check: HostCheckState | undefined;
}): RegistrationDisplayStatus {
  if (input.isCurrent) return input.liveStatus;
  if (input.check === "verified") return "enrolled";
  if (input.check === "lanOnly" || input.remoteEnrolled !== true) return "unregistered";
  return "pending";
}
