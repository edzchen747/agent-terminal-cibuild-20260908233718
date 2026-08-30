/**
 * Pure decision rules for connection battery policy. Everything in here is
 * side-effect free so it can be unit tested in Node; the connection runtime
 * files feed real connectivity information in.
 */

/** Reconnect starts a second after a loss and doubles per attempt. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * A heartbeat every minute keeps sockets sufficient liveness detection without
 * waking the radio three times a minute while the device is in active use.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Only attempt a connection when a route exists; offline attempts wake the radio to fail. */
export function canAttemptConnection(online: boolean): boolean {
  return online;
}

/** Exponential backoff clamped between the base and maximum reconnect delays. */
export function nextReconnectDelay(currentDelayMs: number): number {
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.max(RECONNECT_BASE_DELAY_MS, currentDelayMs * 2));
}

/**
 * Heartbeats run while the screen is awake so a dying desktop is caught by
 * the request timeout even when the app is in the background. They stop while
 * the screen is off: the native service covers route loss, background timers
 * are throttled anyway, and a missed tick is never queued - the transition
 * back to awake runs an overdue check immediately instead.
 */
export function heartbeatActive(screenAwake: boolean, online: boolean): boolean {
  return screenAwake && online;
}

/**
 * A screen wake runs the heartbeat immediately only if the previous one ran
 * a full interval ago, i.e. a tick was actually missed while the screen was
 * off. A fresh handoff has a heartbeat due on schedule, so the catch-up would
 * only add a request.
 */
export function heartbeatCatchUpNeeded(lastHeartbeatAtMs: number, nowMs: number): boolean {
  return nowMs - lastHeartbeatAtMs >= HEARTBEAT_INTERVAL_MS;
}

/** What the ongoing notification should report for a given device state. */
export type ConnectionNotificationState = "connected" | "reconnecting" | "offline";

/**
 * The notification shows "connected" whenever the app holds an authenticated
 * socket, "waiting for internet" when there is no route (the reconnect loop is
 * paused by design), and "reconnecting" when it is recovering through a live
 * route. The native service renders the twin of this mapping: without an
 * active network the reconnect text reads as waiting for the internet and the
 * action reads as Cancel.
 */
export function notificationStateFor(online: boolean, isConnected: boolean): ConnectionNotificationState {
  if (isConnected) return "connected";
  return online ? "reconnecting" : "offline";
}
