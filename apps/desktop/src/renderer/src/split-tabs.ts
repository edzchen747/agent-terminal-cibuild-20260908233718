export type SplitLayout = "side-by-side" | "stacked";

export interface SplitGroup {
  id: string;
  projectId: string;
  sessionIds: [string, string];
  layout: SplitLayout;
  ratio: number;
}

interface SessionIdentity {
  id: string;
  projectId: string;
}

export interface SplitPreferences {
  groups: SplitGroup[];
  allowEdgeDrop: boolean;
}

const STORAGE_KEY = "agent-terminal.desktop.split-tabs.v1";
const DEFAULT_PREFERENCES: SplitPreferences = { groups: [], allowEdgeDrop: true };

export function findSplitGroup(groups: SplitGroup[], sessionId: string | null | undefined): SplitGroup | undefined {
  if (!sessionId) return undefined;
  return groups.find((group) => group.sessionIds.includes(sessionId));
}

export interface SplitEdgeHintState {
  /** The tab currently held by a pointer, null when no tab press is in flight. */
  dragging: { sessionId: string; didMove: boolean } | null;
  activeSessionId: string | null;
  allowEdgeDrop: boolean;
  groups: SplitGroup[];
  /** Non-null while the pointer is inside an edge drop zone. */
  dropSide: "left" | "right" | null;
}

/**
 * Whether the faint edge-drop hitbox hint should be shown: the pointer must
 * have crossed the drag threshold, the drop must be valid for the active
 * session, and the pointer must not already be inside the drop zone.
 */
export function isSplitEdgeHintVisible(state: SplitEdgeHintState): boolean {
  if (state.dropSide !== null) return false;
  if (!state.dragging || !state.dragging.didMove) return false;
  if (!state.allowEdgeDrop) return false;
  if (!state.activeSessionId) return false;
  if (state.activeSessionId === state.dragging.sessionId) return false;
  if (findSplitGroup(state.groups, state.activeSessionId)) return false;
  if (findSplitGroup(state.groups, state.dragging.sessionId)) return false;
  return true;
}

export function clampSplitRatio(ratio: number, minimum = 0.18): number {
  return Math.max(minimum, Math.min(1 - minimum, ratio));
}

export function reconcileSplitGroups(groups: SplitGroup[], sessions: SessionIdentity[]): SplitGroup[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const claimed = new Set<string>();
  const next: SplitGroup[] = [];
  for (const group of groups) {
    const [firstId, secondId] = group.sessionIds;
    const first = byId.get(firstId);
    const second = byId.get(secondId);
    if (!first || !second || firstId === secondId || first.projectId !== second.projectId || claimed.has(firstId) || claimed.has(secondId)) continue;
    claimed.add(firstId);
    claimed.add(secondId);
    next.push({
      id: group.id,
      projectId: first.projectId,
      sessionIds: [firstId, secondId],
      layout: group.layout === "stacked" ? "stacked" : "side-by-side",
      ratio: clampSplitRatio(Number.isFinite(group.ratio) ? group.ratio : 0.5)
    });
  }
  return next;
}

export function pairSessionsInOrder(order: string[], anchorId: string, firstId: string, secondId: string): string[] {
  if (firstId === secondId || !order.includes(firstId) || !order.includes(secondId)) return order;
  const anchorIndex = order.indexOf(anchorId);
  if (anchorIndex < 0) return order;
  const pair = new Set([firstId, secondId]);
  const insertionIndex = order.slice(0, anchorIndex).filter((id) => !pair.has(id)).length;
  const remaining = order.filter((id) => !pair.has(id));
  remaining.splice(insertionIndex, 0, firstId, secondId);
  return remaining;
}

export function normalizeSplitOrder(order: string[], groups: SplitGroup[]): string[] {
  let next = [...order];
  for (const group of groups) {
    const [firstId, secondId] = group.sessionIds;
    if (!next.includes(firstId) || !next.includes(secondId)) continue;
    next = pairSessionsInOrder(next, firstId, firstId, secondId);
  }
  return next;
}

export function moveSessionBlock(order: string[], draggedId: string, targetId: string, groups: SplitGroup[]): string[] {
  if (draggedId === targetId || !order.includes(draggedId) || !order.includes(targetId)) return order;
  const draggedGroup = findSplitGroup(groups, draggedId);
  const targetGroup = findSplitGroup(groups, targetId);
  if (draggedGroup && targetGroup?.id === draggedGroup.id) return order;
  const draggedIds = draggedGroup ? draggedGroup.sessionIds.filter((id) => order.includes(id)) : [draggedId];
  const targetIds = targetGroup ? targetGroup.sessionIds.filter((id) => order.includes(id)) : [targetId];
  const draggedStart = Math.min(...draggedIds.map((id) => order.indexOf(id)));
  const targetStart = Math.min(...targetIds.map((id) => order.indexOf(id)));
  const draggedSet = new Set(draggedIds);
  const remaining = order.filter((id) => !draggedSet.has(id));
  let insertionIndex = Math.min(...targetIds.map((id) => remaining.indexOf(id)).filter((index) => index >= 0));
  if (!Number.isFinite(insertionIndex)) return order;
  if (draggedStart < targetStart) insertionIndex += targetIds.length;
  remaining.splice(insertionIndex, 0, ...draggedIds);
  return normalizeSplitOrder(remaining, groups);
}

export function replaceSessionInOrder(order: string[], outgoingId: string, incomingId: string): string[] {
  const outgoingIndex = order.indexOf(outgoingId);
  const incomingIndex = order.indexOf(incomingId);
  if (outgoingIndex < 0 || incomingIndex < 0 || outgoingIndex === incomingIndex) return order;
  const next = [...order];
  next[outgoingIndex] = incomingId;
  next[incomingIndex] = outgoingId;
  return next;
}

export function loadSplitPreferences(): SplitPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PREFERENCES;
    const value = JSON.parse(stored) as Partial<SplitPreferences>;
    return {
      groups: Array.isArray(value.groups) ? value.groups as SplitGroup[] : [],
      allowEdgeDrop: value.allowEdgeDrop !== false
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveSplitPreferences(preferences: SplitPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A read-only or full storage area should not make tab management fail.
  }
}
