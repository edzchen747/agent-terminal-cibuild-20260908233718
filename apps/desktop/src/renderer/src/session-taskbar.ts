import type { SessionActivity, TaskbarProgress, TerminalSession } from "@agentterminal/protocol";
import {
  CLEAR_TASKBAR_PROGRESS,
  TASKBAR_PROGRESS_STATES,
} from "@agentterminal/protocol";

/**
 * Renderer-side view of the host's taskbar progress tracking.
 *
 * The host decides a session's ConEmu `OSC 9;4` state (an explicit
 * program report, or derived from the shell's command lifecycle, see
 * `taskbar.rs`); the renderer only tracks what it was last told and
 * draws the tab indicator from it.
 *
 * Two sources say the same thing at different rates: the `desktop-state`
 * snapshot, which every session carries its state in, and the
 * `desktop-taskbar` event, which arrives the moment a state changes.
 * The event is the faster of the two and must not be undone by a
 * snapshot that was already in flight when it landed, which is what
 * {@link mergeTaskbar} is for.
 */

export { CLEAR_TASKBAR_PROGRESS, TASKBAR_PROGRESS_STATES };

/** Whether a taskbar state carries the 0-100 `progress` field. */
export function taskbarHasProgress(state: TaskbarProgress): boolean {
  return state.state === "value" || state.state === "error" || state.state === "paused";
}

/** The state the session's tab should draw, from the snapshot alone. */
export function taskbarOf(session: TerminalSession): TaskbarProgress {
  return session.taskbar ?? CLEAR_TASKBAR_PROGRESS;
}

/** Two wire states are the same when every field is. */
export function sameTaskbarProgress(a: TaskbarProgress, b: TaskbarProgress): boolean {
  return a.state === b.state && a.progress === b.progress;
}

/**
 * Fold a `desktop-taskbar` event into the map the UI reads. Returns the
 * same map when nothing changed, so React state can skip the re-render.
 * The map keeps the latest state per session, clear included: a clear
 * entry must survive, because a snapshot in flight was built *before*
 * the clear transition and still carries the previous state - for a
 * running session the event (which is newer) must win, or a cleared
 * spinner would resurrect as a pulse and the running-to-clear edge the
 * "come look" marker needs would never be seen.
 */
export function applyTaskbarEvent(
  current: ReadonlyMap<string, TaskbarProgress>,
  sessionId: string,
  taskbar: TaskbarProgress
): ReadonlyMap<string, TaskbarProgress> {
  const held = current.get(sessionId) ?? CLEAR_TASKBAR_PROGRESS;
  if (sameTaskbarProgress(held, taskbar)) return current;
  const next = new Map(current);
  next.set(sessionId, taskbar);
  return next;
}

/**
 * Reconcile the map against a fresh snapshot: drop sessions that are
 * gone, and adopt the snapshot's state for sessions the map has not
 * heard an event about yet. A running session the map already holds
 * keeps its entry (a clear one included) - the event that set it is
 * newer than any snapshot that can still arrive. Exited sessions take
 * the snapshot's verdict as-is: the host pushes their final taskbar
 * (an error or a clear) with the lifecycle event.
 */
export function mergeTaskbar(
  current: ReadonlyMap<string, TaskbarProgress>,
  sessions: readonly TerminalSession[]
): ReadonlyMap<string, TaskbarProgress> {
  const next = new Map<string, TaskbarProgress>();
  for (const session of sessions) {
    // An exited tab's state is terminal: the host pushed one last clear
    // for a tab it keeps open for inspection, so a non-running session
    // takes the snapshot's verdict outright.
    const held = session.status === "running" ? current.get(session.id) : undefined;
    const state = held ?? taskbarOf(session);
    if (state.state !== "clear") {
      next.set(session.id, state);
    } else if (held !== undefined) {
      // A clear event was heard for this running session: keep the clear
      // entry so a stale snapshot cannot resurrect the previous state.
      next.set(session.id, state);
    }
  }
  if (
    next.size === current.size &&
    [...next].every(([id, state]) =>
      sameTaskbarProgress(current.get(id) ?? CLEAR_TASKBAR_PROGRESS, state)
    )
  ) {
    return current;
  }
  return next;
}

/**
 * What a tab draws, from the session's state, its taskbar progress and
 * the window's activity events. The active tab keeps its own underline
 * (the accent indicator bar) and draws nothing else; everything here
 * is for the other tabs of the project.
 */
export interface TabProgressModel {
  /** The dot beside the tab label, or none: a blinking green dot while a
   * command runs (with or without a progress percentage), a static
   * green dot on the "come look" marker of a just-finished tab, an
   * empty circle on an idle tab, a red dot after a failure. */
  dot: "running" | "completed" | "idle" | "error" | null;
  /** The 2px bar along the tab's bottom edge: `value` fills to the
   * percentage (idle tabs draw it at 0%, leaving only the dim track),
   * `pulse` sweeps while a command runs without a percentage, and
   * `full` is the 100% bright bar held on a tab whose command just
   * finished while the user was looking elsewhere, until the tab is
   * opened. */
  bar: "value" | "pulse" | "full" | null;
  /** The fill in percent, for a `value` bar; `null` otherwise. */
  fill: number | null;
}

export interface TabProgressInput {
  isActive: boolean;
  session: Pick<TerminalSession, "status" | "exitCode">;
  taskbar: TaskbarProgress;
  activity?: SessionActivity;
  /** The session's command just finished while the user was viewing
   * another tab: hold the bar at 100% (the "come look" marker) until
   * the tab is opened, then let it fall back to the idle bar. */
  justCompleted?: boolean;
}

/** Whether the session's taskbar state just transitioned from a
 * running state (value, indeterminate, or paused) to clear - the
 * "the command finished" edge. */
export function taskbarJustCompleted(previous: TaskbarProgress, next: TaskbarProgress): boolean {
  return next.state === "clear" && previous.state !== "clear";
}

/** The dot and bar a tab should draw (see {@link TabProgressModel}). */
export function tabProgressModel({
  isActive,
  session,
  taskbar,
  activity,
  justCompleted
}: TabProgressInput): TabProgressModel {
  // The active tab always shows the active indicator bar, never a
  // progress bar, so it draws nothing here.
  if (isActive) return { dot: null, bar: null, fill: null };
  // A failed command keeps its marker until the next command starts:
  // either the host's taskbar machine still holds the error state, or
  // the tab has exited and its non-zero code (an unknown code counts
  // as failed) is all that is left.
  const exitedCode = session.status === "exited" ? (session.exitCode ?? 1) : 0;
  if (taskbar.state === "error" || (taskbar.state === "clear" && exitedCode !== 0)) {
    return { dot: "error", bar: null, fill: null };
  }
  // A running command without a percentage: the blinking dot, and a
  // sweep through the bar like the taskbar's indeterminate animation.
  if (taskbar.state === "indeterminate") return { dot: "running", bar: "pulse", fill: null };
  // A paused command still runs: the dot blinks, the bar holds the
  // percentage where it stopped.
  if (taskbar.state === "paused") {
    return { dot: "running", bar: "value", fill: taskbar.progress ?? 0 };
  }
  // An explicit progress percentage: the bar carries the number, the
  // green dot says the command is still running.
  if (taskbar.state === "value") {
    return { dot: "running", bar: "value", fill: taskbar.progress ?? 0 };
  }
  // No explicit state: the session's own verdict decides.
  if (session.status !== "running") return { dot: null, bar: null, fill: null };
  // A command that just finished while the user was on another tab: the
  // marker draws immediately, ahead of the activity's busy badge leaving
  // its grace window - the taskbar's clear edge outranks the lingering
  // "active" activity, or the marker would flash as a blinking running
  // command instead of the static "come look" dot.
  if (justCompleted) return { dot: "completed", bar: "full", fill: null };
  if (activity === "active") return { dot: "running", bar: "pulse", fill: null };
  // A normal idle tab: the empty circle, and the bar as a 0% progress
  // bar - only the dim track, no fill.
  return { dot: "idle", bar: "value", fill: 0 };
}