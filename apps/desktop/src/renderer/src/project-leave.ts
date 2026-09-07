import type { Project, SessionActivity, TerminalSession } from "@agentterminal/protocol";
import { projectActivitySummary } from "./session-activity.ts";

/**
 * A snapshot of a project card that just left the sidebar list. While the
 * ghost plays its leave animation it stays pinned in the slot the project
 * used to occupy, so the items below can slide up into the freed space.
 */
export interface LeavingProject {
  project: Project;
  /** Index the project held in the list before it left. */
  index: number;
  /** Running-session count the card showed when it left. */
  count: number;
  /**
   * The caption the card showed when it left, frozen with it. The
   * ghost outlives the sessions it is describing, so it cannot
   * recompute one.
   */
  label: string;
}

/** One row of the sidebar render list: a live project card or a leaving ghost. */
export type ProjectListEntry =
  | { kind: "live"; project: Project; index: number }
  | { kind: "leaving"; entry: LeavingProject };

/**
 * How long the ghost stays in the list: the 150ms leftward slide plus the
 * 270ms slot collapse, which must add up to the animation timings in
 * styles.css (`.project-item.is-leaving`).
 */
export const PROJECT_LEAVE_MS = 420;

/**
 * Projects from `previous` that no longer appear in `current`, each pinned to
 * the index it held so the sidebar can render a leaving ghost per card.
 */
export function departedProjects(previous: readonly Project[], current: readonly Project[], previousSessions: readonly TerminalSession[], activity: ReadonlyMap<string, SessionActivity> = new Map()): LeavingProject[] {
  const remaining = new Set(current.map((project) => project.id));
  const leavings: LeavingProject[] = [];
  previous.forEach((project, index) => {
    if (remaining.has(project.id)) return;
    const summary = projectActivitySummary(previousSessions, activity, project.id);
    leavings.push({ project, index, count: summary.running, label: summary.label });
  });
  return leavings;
}

/**
 * The sidebar's render order: live cards with the leaving ghosts spliced
 * back into their old slots. Live entries keep their index in the live list
 * (not their rendered position) so drag transforms keep working against it.
 */
export function projectListEntries(live: readonly Project[], leaving: readonly LeavingProject[]): ProjectListEntry[] {
  const ghosts = leaving.filter((entry) => !live.some((project) => project.id === entry.project.id));
  const ghostByIndex = new Map<number, LeavingProject>();
  for (const ghost of ghosts) ghostByIndex.set(ghost.index, ghost);
  if (!ghostByIndex.size) return live.map((project, index) => ({ kind: "live" as const, project, index }));
  const entries: ProjectListEntry[] = [];
  let liveIndex = 0;
  for (let position = 0; position < live.length + ghostByIndex.size; position++) {
    const ghost = ghostByIndex.get(position);
    if (ghost) entries.push({ kind: "leaving", entry: ghost });
    // A stale ghost position beyond the live list leaves no row behind: the
    // remaining live cards simply take the tail slots.
    else if (liveIndex < live.length) { entries.push({ kind: "live", project: live[liveIndex]!, index: liveIndex }); liveIndex += 1; }
  }
  return entries;
}