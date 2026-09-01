/**
 * Pure rules for the previously paired desktops list (the hosts page).
 * App.tsx keeps a live copy of the persisted list and hands it to these
 * functions so the ordering and display rules stay testable without the
 * Capacitor storage layer.
 */

import type { RegistrationVerdict } from "./registrationCache";

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

/** Shorthand labels shown on the phone, mirroring the full desktop labels. */
export const REGISTRATION_STATUS_LABELS: Record<RegistrationDisplayStatus, string> = {
  unregistered: "LAN only",
  pending: "Registering",
  enrolled: "Ready",
  failed: "Failed",
  offline: "Offline"
};

/**
 * The badge status for the connected desktop: its live enrollment verdict
 * while the phone has a route, "Offline" while it does not (the desktop does
 * the same with its own connectivity reading).
 */
export function registrationDisplayStatusFor(
  live: "unregistered" | "pending" | "enrolled" | "failed",
  online: boolean
): RegistrationDisplayStatus {
  return online ? live : "offline";
}

/**
 * The badge label for a hosts-page row. A background-check row in the
 * checking state says "Checking" (it is not actively enrolling); the
 * connected row keeps the live "Registering" wording.
 */
export function hostRowStatusLabel(status: RegistrationDisplayStatus, isCurrent: boolean): string {
  return isCurrent ? REGISTRATION_STATUS_LABELS[status] : status === "pending" ? "Checking" : REGISTRATION_STATUS_LABELS[status];
}

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

/**
 * Plans one hosts-page registration-check round. The live desktop is
 * skipped (it is verified by being connected) and hosts that were never
 * registered (`remoteEnrolled` not set) stay LAN only without ever starting
 * a node; every other registered host joins the round. With `force` (the
 * header's manual refresh) the persisted verdict cache is ignored so each
 * pending host is re-verified; a plain page visit reuses live cache
 * entries, which keeps revisits from churning the native node engine.
 */
export function hostsPageCheckPlan<T extends { id: string; remoteEnrolled?: boolean }>(input: {
  records: readonly T[];
  liveHostId: string | null | undefined;
  cached: ReadonlyMap<string, RegistrationVerdict>;
  force: boolean;
}): { pending: T[]; toVerify: T[]; states: Map<string, HostCheckState> } {
  const pending = input.records.filter((record) => record.remoteEnrolled === true && record.id !== input.liveHostId);
  const states = new Map<string, HostCheckState>();
  const toVerify: T[] = [];
  for (const record of pending) {
    const verdict = input.force ? undefined : input.cached.get(record.id);
    if (verdict) states.set(record.id, verdict);
    else {
      states.set(record.id, "checking");
      toVerify.push(record);
    }
  }
  return { pending, toVerify, states };
}
