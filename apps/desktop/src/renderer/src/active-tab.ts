/**
 * Per-project memory of the last selected terminal tab.
 *
 * A desktop window shows one project at a time. When the window's active
 * tab no longer belongs to the project it is showing (the user switched
 * projects, or the tab was closed), the window should fall back to the
 * tab the user last selected in that project, not to the last tab. The
 * memory is deliberately in-memory only: sessions are in-memory PTYs that
 * die with the host, so a remembered tab id has no meaning across an app
 * restart.
 */

export interface ResolveProjectActiveSessionInput {
  /** The project the window is showing. */
  projectId: string;
  /** The tab the window currently has selected, if any. */
  activeSessionId: string | null;
  /** The shown project's session ids, in tab order. */
  projectSessionIds: string[];
  /** The remembered last-selected tab for each project. */
  rememberedByProject: ReadonlyMap<string, string>;
}

/**
 * The tab the window should show: the current selection when it still
 * belongs to the shown project; otherwise the project's remembered
 * last-selected tab when it still exists; otherwise the last tab (or
 * null when the project has no sessions).
 */
export function resolveProjectActiveSession(input: ResolveProjectActiveSessionInput): string | null {
  const { projectId, activeSessionId, projectSessionIds, rememberedByProject } = input;
  if (activeSessionId && projectSessionIds.includes(activeSessionId)) return activeSessionId;
  const remembered = rememberedByProject.get(projectId);
  if (remembered && projectSessionIds.includes(remembered)) return remembered;
  return projectSessionIds.at(-1) ?? null;
}

/** Remember `sessionId` as the last-selected tab of `projectId`. */
export function rememberProjectActiveSession(rememberedByProject: Map<string, string>, projectId: string, sessionId: string): void {
  rememberedByProject.set(projectId, sessionId);
}

/** Drop memories for projects that no longer exist. */
export function pruneRememberedActiveSessions(rememberedByProject: Map<string, string>, projectIds: Iterable<string>): void {
  const known = new Set(projectIds);
  for (const projectId of [...rememberedByProject.keys()]) {
    if (!known.has(projectId)) rememberedByProject.delete(projectId);
  }
}
