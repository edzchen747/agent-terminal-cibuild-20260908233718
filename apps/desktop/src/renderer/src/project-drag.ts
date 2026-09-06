/**
 * The geometry of an in-flight project-sidebar drag, with the DOM
 * bookkeeping (pointer id, start position, move threshold, release flag)
 * stripped off so the pure decisions stay testable.
 */
export interface ProjectDragGeometry {
  projectId: string;
  startIndex: number;
  targetIndex: number;
  /** How far the pointer has travelled from the drag start, in px. */
  deltaY: number;
  /** The viewport center (px) of every project row, measured at drag start. */
  centers: readonly number[];
}

/**
 * The list after moving the item at startIndex into the targetIndex slot:
 * the items the move crosses shift one slot toward the origin. A new array
 * is returned and the input is never mutated; a drop onto the origin slot
 * leaves the order untouched (in a fresh array, so callers can still
 * detect "no change" by comparing contents).
 */
export function reorderBlock<T>(items: readonly T[], startIndex: number, targetIndex: number): T[] {
  const next = [...items];
  next.splice(targetIndex, 0, ...next.splice(startIndex, 1));
  return next;
}

/**
 * Whether a released project drag commits a reorder: the release must be a
 * commit (pointer-up) rather than a cancel, the pointer must have crossed
 * the move threshold, and the drop slot must differ from the origin. A
 * press-and-release that never moved, a cancelled gesture, and a drop back
 * onto the origin all leave the order alone.
 */
export function shouldCommitProjectReorder(input: {
  commit: boolean;
  didMove: boolean;
  startIndex: number;
  targetIndex: number;
}): boolean {
  return input.commit && input.didMove && input.targetIndex !== input.startIndex;
}

/**
 * How far a crossed sibling row shifts to make room for the drag: the row
 * pitch around the drag's origin - a full pitch at the list's edges, the
 * average of the two surrounding gaps for an interior origin. A list with
 * fewer than two rows has no pitch to measure, so the sidebar's fixed row
 * pitch (58px row + 3px margin) stands in.
 */
export function siblingShiftStep(centers: readonly number[], startIndex: number): number {
  if (centers.length < 2) return 61;
  const gap = centers[Math.min(startIndex + 1, centers.length - 1)]! - centers[Math.max(0, startIndex - 1)]!;
  return Math.abs(gap) / (startIndex > 0 && startIndex < centers.length - 1 ? 2 : 1);
}

/**
 * The transform a project row gets while a drag is in flight. The dragged
 * row follows the pointer one-to-one (its CSS transition is disabled while
 * dragging, so no animation lags it); the rows the drag crosses shift by
 * one row to make room, which the transform transition animates into the
 * sibling-shift slide; every other row stays put.
 */
export function projectDragTransform(drag: ProjectDragGeometry | null, projectId: string, index: number): string | undefined {
  if (!drag) return undefined;
  if (projectId === drag.projectId) return `translate3d(0,${drag.deltaY}px,0)`;
  const step = siblingShiftStep(drag.centers, drag.startIndex);
  if (drag.startIndex < drag.targetIndex && index > drag.startIndex && index <= drag.targetIndex) return `translate3d(0,-${step}px,0)`;
  if (drag.startIndex > drag.targetIndex && index >= drag.targetIndex && index < drag.startIndex) return `translate3d(0,${step}px,0)`;
  return undefined;
}