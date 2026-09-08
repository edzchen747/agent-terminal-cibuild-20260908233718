import type { TerminalSession, TaskbarProgress } from "@agentterminal/protocol";
import { CLEAR_TASKBAR_PROGRESS, isSessionActive } from "@agentterminal/protocol";

export { CLEAR_TASKBAR_PROGRESS };

/** The state the session's snapshot alone says, from its `taskbar` field. */
export function taskbarOf(session: TerminalSession): TaskbarProgress {
  return session.taskbar ?? CLEAR_TASKBAR_PROGRESS;
}

/**
 * Whether the session's taskbar state just transitioned from a running
 * state (value, indeterminate, or paused) to clear - the "the command
 * finished" edge. The host's machine emits the edge; comparing each
 * session's effective state against the last render's catches it (see the
 * hold effect in App.tsx).
 */
export function taskbarJustCompleted(previous: TaskbarProgress, next: TaskbarProgress): boolean {
  return next.state === "clear" && previous.state !== "clear";
}

/**
 * The dot and ring a session row should draw, ported from the desktop's
 * tab progress model (desktop `session-taskbar.ts`): the dot semantics and
 * the bar's value/pulse/full states are the same, the bar re-homes around
 * the session icon's outline as a ring, and the active-tab exception does
 * not apply because the phone's session list (the project's tabs view) has
 * no active tab - the session the terminal view shows is a different pager
 * page, and its marker is only released when it is opened (App.tsx).
 */
export interface SessionProgressModel {
  /** The dot beside the session label, or none: a blinking green dot while a
   * command runs (with or without a progress percentage), a static green
   * dot on the "come look" marker of a just-finished session, an empty
   * circle on an idle session, a red dot after a failure. */
  dot: "running" | "completed" | "idle" | "error" | null;
  /** The 3px ring around the session icon: `value` fills to the percentage
   * (idle sessions draw it at 0%, leaving only the dim track), `pulse`
   * sweeps around the outline while a command runs without a percentage,
   * and `full` is the 100% bright ring held on a session whose command
   * just finished while the user was looking elsewhere. */
  ring: "value" | "pulse" | "full" | null;
  /** The fill in percent, for a `value` ring; `null` otherwise. */
  fill: number | null;
}

export interface SessionProgressInput {
  session: Pick<TerminalSession, "status" | "exitCode" | "activity">;
  taskbar: TaskbarProgress;
  /** The session's command just finished while the user was viewing
   * another session: hold the ring at 100% (the "come look" marker)
   * until the session is opened, then let it fall back to the idle ring. */
  justCompleted?: boolean;
}

/** The dot and ring a session row should draw (see {@link SessionProgressModel}). */
export function sessionProgressModel({ session, taskbar, justCompleted }: SessionProgressInput): SessionProgressModel {
  // A failed command keeps its marker until the next command starts:
  // either the host's taskbar machine still holds the error state, or the
  // session has exited and its non-zero code (an unknown code counts as
  // failed) is all that is left.
  const exitedCode = session.status === "exited" ? (session.exitCode ?? 1) : 0;
  if (taskbar.state === "error" || (taskbar.state === "clear" && exitedCode !== 0)) {
    return { dot: "error", ring: null, fill: null };
  }
  // A running command without a percentage: the blinking dot, and a sweep
  // around the icon like the taskbar's indeterminate animation.
  if (taskbar.state === "indeterminate") return { dot: "running", ring: "pulse", fill: null };
  // A paused command still runs: the dot blinks, the ring holds the
  // percentage where it stopped.
  if (taskbar.state === "paused") {
    return { dot: "running", ring: "value", fill: taskbar.progress ?? 0 };
  }
  // An explicit progress percentage: the ring carries the number, the
  // green dot says the command is still running.
  if (taskbar.state === "value") {
    return { dot: "running", ring: "value", fill: taskbar.progress ?? 0 };
  }
  // No explicit state: the session's own verdict decides.
  if (session.status !== "running") return { dot: null, ring: null, fill: null };
  // A command that just finished while the user was on another session:
  // the marker draws immediately, ahead of the activity's busy badge
  // leaving its grace window - the taskbar's clear edge outranks the
  // lingering "active" activity, or the marker would flash as a
  // blinking running command instead of the static "come look" dot.
  if (justCompleted) return { dot: "completed", ring: "full", fill: null };
  if (isSessionActive(session)) return { dot: "running", ring: "pulse", fill: null };
  // A normal idle session: the empty circle, and the ring as a 0%
  // progress bar - only the dim track, no fill.
  return { dot: "idle", ring: "value", fill: 0 };
}