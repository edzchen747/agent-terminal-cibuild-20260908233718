/**
 * Pure rules for the connect/pair flow. App.tsx consults these so the
 * cancel/host-name gating on the connecting splash is unit tested in Node
 * instead of living only in component code.
 *
 * The saved desktop record (the launch default) is never wiped by navigating
 * *to* the pairing screen: the "Hosts" page lists previously paired desktops,
 * and entering pairing from it defers all record changes. The single commit
 * point is a successful HostConnection.pair, which persists the newly paired
 * desktop as the new default while the hosts list keeps every other entry.
 */

export type AppStatus = "loading" | "pairing" | "connecting" | "connected" | "error";

/**
 * The connecting splash offers Cancel and the desktop name only while it is
 * actually retrying a *saved* desktop. During the initial "Opening Agent
 * Terminal" load and during an in-flight QR pairing (no live connection yet)
 * a cancel would strand the user on the try-again page, so it is hidden.
 */
export function isRetryingSavedHost(status: AppStatus, hasConnection: boolean): boolean {
  return status === "connecting" && hasConnection;
}
