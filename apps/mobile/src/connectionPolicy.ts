/**
 * Pure decision rules for connection battery policy. Everything in here is
 * side-effect free so it can be unit tested in Node; the connection runtime
 * files feed real connectivity information in.
 */

/** Reconnect starts a second after a loss and doubles per attempt. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Heartbeat cadence: fast while the screen is on so a dying desktop is caught
 * promptly, slow while the screen is off to conserve radio, and none at all
 * while the device sleeps (Doze) because the WebView is frozen anyway and a
 * refresh could only wake the radio pointlessly.
 */
export const HEARTBEAT_AWAKE_INTERVAL_MS = 10_000;
export const HEARTBEAT_ASLEEP_INTERVAL_MS = 60_000;

export function heartbeatIntervalMs(screenAwake: boolean): number {
  return screenAwake ? HEARTBEAT_AWAKE_INTERVAL_MS : HEARTBEAT_ASLEEP_INTERVAL_MS;
}

/** Only attempt a connection when a route exists; offline attempts wake the radio to fail. */
export function canAttemptConnection(online: boolean): boolean {
  return online;
}

/** Exponential backoff clamped between the base and maximum reconnect delays. */
export function nextReconnectDelay(currentDelayMs: number): number {
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.max(RECONNECT_BASE_DELAY_MS, currentDelayMs * 2));
}

/**
 * Heartbeats run while the device is online and awake (screen on: every 10s;
 * screen off: every 60s). They pause entirely while the device sleeps: the
 * OS freezes the WebView with it, so a tick cannot run, and the wake
 * transition runs one overdue check instead of queuing.
 */
export function heartbeatActive(online: boolean, sleeping: boolean): boolean {
  return online && !sleeping;
}

/**
 * A screen wake runs the heartbeat immediately only if the cadence-appropriate
 * interval elapsed since the previous one, i.e. a tick was actually missed
 * while inactive. A fresh handoff has a heartbeat due on schedule, so the
 * catch-up would only add a request.
 */
export function heartbeatCatchUpNeeded(lastHeartbeatAtMs: number, nowMs: number, intervalMs: number): boolean {
  return nowMs - lastHeartbeatAtMs >= intervalMs;
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
