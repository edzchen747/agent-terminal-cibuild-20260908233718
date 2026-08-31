import type { HostSnapshot, Project, TerminalSession } from "@agentterminal/protocol";

export type ViewType = "home" | "hosts" | "project" | "terminal";

export interface ViewGeometryInput {
  viewType: ViewType;
  /** The project the view was opened for: the selected project on the home
   * and hosts pages, the view's own project on the project/terminal pages. */
  requestedProjectId: string | null;
  /** The session the view was opened for: the view's session on the terminal
   * page, the selected session everywhere else. */
  requestedSessionId: string | null;
}

export interface ViewGeometry {
  activeProject: Project | undefined;
  activeSession: TerminalSession | undefined;
  /** Pages the pager shows: home, the active project, the active session. */
  pageCount: number;
  currentPage: number;
}

/**
 * The pager's project/session geometry for the current view. A terminal view
 * follows its session even when a cd in the shell moves the tab to another
 * project: the phone stays attached, and the project it shows (and lands on
 * when the user leaves) is the one the session currently belongs to. The
 * home and project pages still gate sessions to their own project, and a
 * missing project falls back to matching a session by id only so a previously
 * visible terminal page never pops open unexpectedly.
 */
export function resolveViewGeometry(snapshot: HostSnapshot, input: ViewGeometryInput): ViewGeometry {
  const baseProject = snapshot.projects.find((item) => item.id === input.requestedProjectId);
  const activeSession = snapshot.sessions.find(
    (item) => item.id === input.requestedSessionId &&
      (input.viewType === "terminal" || !baseProject || item.projectId === baseProject.id)
  );
  const activeProject = input.viewType === "terminal" && activeSession
    ? snapshot.projects.find((item) => item.id === activeSession.projectId)
    : baseProject;
  const pageCount = 1 + (activeProject ? 1 : 0) + (activeProject && activeSession ? 1 : 0);
  const currentPage = Math.min(
    input.viewType === "terminal" ? 2 : input.viewType === "project" ? 1 : 0,
    pageCount - 1
  );
  return { activeProject, activeSession, pageCount, currentPage };
}

export interface TerminalViewRef {
  sessionId: string;
  projectId: string;
}

/**
 * The project a back-navigation from a terminal view lands on. The session
 * can move to another project while it runs (a cd reassigns the tab), so the
 * project it belongs to *now* is the target; the project the view was opened
 * from is the fallback when the session is no longer running.
 */
export function backProjectId(snapshot: HostSnapshot | null, view: TerminalViewRef): string {
  const session = snapshot?.sessions.find((item) => item.id === view.sessionId);
  return session?.projectId ?? view.projectId;
}
