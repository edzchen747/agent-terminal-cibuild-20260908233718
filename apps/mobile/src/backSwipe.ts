// Commit thresholds that mirror the pager's page-swipe commit (gesture.ts,
// SWIPE_COMMIT_DISTANCE_RATIO / SWIPE_COMMIT_VELOCITY_PX_MS) so back swipes
// feel identical to pager swipes. They are duplicated here (not imported)
// because this module runs directly under Node's .mjs tests, which cannot
// resolve extensionless relative imports; backSwipe.test.mjs pins the two
// sets equal so they cannot drift apart.
export const BACK_SWIPE_COMMIT_DISTANCE_RATIO = 0.22;
export const BACK_SWIPE_COMMIT_VELOCITY_PX_MS = 0.55;

/**
 * Pure commit rule for the back swipe on the hosts page and the pairing
 * screen (App.tsx tracks the pointer, this decides the outcome). Only a
 * rightward - back - swipe can commit, and only when it clears the shared
 * distance threshold or is a fast enough flick; a leftward (forward) swipe
 * never commits, because these views have no forward target to navigate
 * into. A cancelled gesture never commits.
 */
export interface BackSwipeCommitInput {
  cancelled: boolean;
  /** Horizontal movement from the start, positive when the finger moved right. */
  deltaX: number;
  /** The view's width in CSS pixels. */
  widthPx: number;
  /** Horizontal velocity at release. */
  velocityPxPerMs: number;
}

export function shouldCommitBackSwipe(input: BackSwipeCommitInput): boolean {
  if (input.cancelled || input.deltaX <= 0) return false;
  if (input.deltaX >= input.widthPx * BACK_SWIPE_COMMIT_DISTANCE_RATIO) return true;
  return input.velocityPxPerMs >= BACK_SWIPE_COMMIT_VELOCITY_PX_MS;
}