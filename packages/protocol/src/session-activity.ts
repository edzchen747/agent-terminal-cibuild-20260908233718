import type { SessionActivity, TerminalSession } from "./index.js";

/**
 * Shared reading of the host's active/idle detection.
 *
 * The host decides whether a session is blocked on a foreground program
 * (see `activity.rs`); these helpers only turn what it reported into the
 * things both clients show - a per-session flag for the status dot, and
 * the "1 of 2 sessions active" rollup. They live here because the desktop
 * sidebar, the mobile project list and the mobile project card all render
 * the same sentence, and three copies of that wording drift.
 */

/** A session's state, defaulting to idle for a host that predates the field. */
export function sessionActivityOf(session: Pick<TerminalSession, "activity" | "status">): SessionActivity {
  // An exited tab keeps its exit marker; it is never also busy.
  if (session.status !== "running") return "idle";
  return session.activity ?? "idle";
}

/** Whether a session's shell is currently blocked on a foreground program. */
export function isSessionActive(session: Pick<TerminalSession, "activity" | "status">): boolean {
  return sessionActivityOf(session) === "active";
}

export interface SessionActivitySummary {
  /** Sessions whose shell is blocked on a program. */
  active: number;
  /** Sessions whose shell is still alive. */
  running: number;
  /** The caption to render. */
  label: string;
}

export interface SessionActivitySummaryOptions {
  /** Limit the summary to one project. Omit to summarize every session. */
  projectId?: string;
  /**
   * States newer than the ones on `sessions`. The desktop renderer holds
   * activity events, which arrive ahead of the snapshot they will also
   * appear in; a session missing here falls back to its own field.
   */
  activity?: ReadonlyMap<string, SessionActivity>;
}

/**
 * How many of a project's (or the host's) live sessions are busy, with the
 * caption that says so.
 */
export function sessionActivitySummary(
  sessions: readonly TerminalSession[],
  options: SessionActivitySummaryOptions = {}
): SessionActivitySummary {
  const { projectId, activity } = options;
  const running = sessions.filter(
    (session) => session.status === "running" && (projectId === undefined || session.projectId === projectId)
  );
  const active = running.filter((session) => (activity?.get(session.id) ?? sessionActivityOf(session)) === "active").length;
  return { active, running: running.length, label: sessionActivityLabel(active, running.length) };
}

/**
 * The caption for a busy/live pair. A count of live sessions on its own
 * reads as a claim about activity that it is not making, so the word
 * "active" is reserved for the sessions that earned it.
 */
export function sessionActivityLabel(active: number, running: number): string {
  if (running === 0) return "No active sessions";
  const sessions = `session${running === 1 ? "" : "s"}`;
  if (active === 0) return `${running} idle ${sessions}`;
  return `${active} of ${running} ${sessions} active`;
}
