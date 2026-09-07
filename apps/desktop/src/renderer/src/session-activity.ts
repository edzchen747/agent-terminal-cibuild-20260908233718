import type { SessionActivity, TerminalSession } from "@agentterminal/protocol";
import { sessionActivityOf, sessionActivitySummary, type SessionActivitySummary } from "@agentterminal/protocol";

/**
 * Renderer-side view of the host's active/idle detection.
 *
 * The host decides whether a session is blocked on a foreground program
 * (see `activity.rs`); the renderer only tracks what it was last told.
 * Reading a session's state and phrasing the sidebar rollup are shared
 * with the mobile app in `@agentterminal/protocol`; what lives here is
 * the bookkeeping only this client needs.
 *
 * Two sources say the same thing at different rates: the `desktop-state`
 * snapshot, which every session carries its state in, and the
 * `desktop-activity` event, which arrives the moment a state changes. The
 * event is the faster of the two and must not be undone by a snapshot
 * that was already in flight when it landed, which is what
 * {@link mergeActivity} is for.
 */

export { sessionActivityOf as activityOf };

/**
 * Fold a `desktop-activity` event into the map the UI reads. Returns the
 * same map when nothing changed, so React state can skip the re-render.
 */
export function applyActivityEvent(
  current: ReadonlyMap<string, SessionActivity>,
  sessionId: string,
  activity: SessionActivity
): ReadonlyMap<string, SessionActivity> {
  if (current.get(sessionId) === activity) return current;
  const next = new Map(current);
  next.set(sessionId, activity);
  return next;
}

/**
 * Reconcile the map against a fresh snapshot: drop sessions that are gone,
 * and adopt the snapshot's state for sessions the map has not heard an
 * event about yet. A running session the map already holds keeps its entry
 * - the event that set it is newer than any snapshot that can still
 * arrive.
 */
export function mergeActivity(
  current: ReadonlyMap<string, SessionActivity>,
  sessions: readonly TerminalSession[]
): ReadonlyMap<string, SessionActivity> {
  const next = new Map<string, SessionActivity>();
  for (const session of sessions) {
    // A session that is no longer running takes the snapshot's verdict
    // outright: the host stops sweeping an exited session, so no event is
    // coming to clear a badge it was still holding when its shell died.
    const held = session.status === "running" ? current.get(session.id) : undefined;
    next.set(session.id, held ?? sessionActivityOf(session));
  }
  if (next.size === current.size && [...next].every(([id, state]) => current.get(id) === state)) {
    return current;
  }
  return next;
}

/** The project sidebar's rollup, against the events this window has seen. */
export function projectActivitySummary(
  sessions: readonly TerminalSession[],
  activity: ReadonlyMap<string, SessionActivity>,
  projectId: string
): SessionActivitySummary {
  return sessionActivitySummary(sessions, { projectId, activity });
}
