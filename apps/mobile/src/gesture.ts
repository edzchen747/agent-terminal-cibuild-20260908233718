export type GestureAxis = "pending" | "horizontal" | "vertical";

const INTENT_THRESHOLD_PX = 7;
const HORIZONTAL_BIAS = 1.2;

export const TAP_MAX_MOVE_PX = 12;
export const TAP_MAX_DURATION_MS = 400;

export const SHEET_DISMISS_DISTANCE_PX = 72;
export const SHEET_DISMISS_MIN_FLICK_PX = 24;
export const SHEET_DISMISS_VELOCITY_PX_MS = 0.55;

/**
 * The shared commit feel for every horizontal swipe in the app: the pager's
 * page transitions and the back swipes on the hosts page and the pairing
 * screen all navigate when a drag clears 22% of the view's width, or when
 * the release is faster than 0.55 px/ms; anything shorter snaps back.
 */
export const SWIPE_COMMIT_DISTANCE_RATIO = 0.22;
export const SWIPE_COMMIT_VELOCITY_PX_MS = 0.55;

/**
 * Whether a tracked vertical swipe over an overlay has enough distance or
 * speed to commit its dismissal. Short drags snap the sheet back; a quick
 * flick closes it even when the distance is small.
 */
export function shouldCommitSheetDismiss(input: {
  cancelled: boolean;
  distancePx: number;
  velocityPxPerMs: number;
}): boolean {
  if (input.cancelled || input.distancePx <= 0) return false;
  if (input.distancePx >= SHEET_DISMISS_DISTANCE_PX) return true;
  return input.velocityPxPerMs >= SHEET_DISMISS_VELOCITY_PX_MS && input.distancePx >= SHEET_DISMISS_MIN_FLICK_PX;
}

export function classifyGestureAxis(deltaX: number, deltaY: number, horizontalBias: number = HORIZONTAL_BIAS): GestureAxis {
  if (Math.hypot(deltaX, deltaY) <= INTENT_THRESHOLD_PX) return "pending";
  return Math.abs(deltaX) > Math.abs(deltaY) * horizontalBias ? "horizontal" : "vertical";
}

/**
 * A drag that begins on the character-width slider is a thumb pull along the
 * track: any downward drift must not claim the sheet-dismissal gesture, so
 * the horizontal axis wins until the movement is clearly vertical.
 */
export const SHEET_SLIDER_HORIZONTAL_BIAS = 0.6;

/**
 * Whether the chain of ancestors from a tap up to an overlay's sheet root
 * contains a scrolling section. Only an ordered overflow-y chain is needed:
 * the first auto/scroll container marks a region that scrolls natively (the
 * folder picker's directory list), in which case the swipe-down dismissal
 * must not be registered. A chain of only visible/hidden/clip values leaves
 * the gesture free, so a swipe down starting on the character-width slider
 * still dismisses.
 */
export function hasScrollableSheetAncestor(overflowYChain: readonly string[]): boolean {
  return overflowYChain.some((value) => value === "auto" || value === "scroll");
}

/**
 * Whether a pointer-up is a taut tap whose activation must be fired directly,
 * because Chromium's fling recognizer may swallow the click it would normally
 * deliver after a touch drag. When true the caller runs the click activation
 * itself (with a swallow guard for the trailing click), so a tap after any
 * swipe works on the first attempt, whenever the user lets go.
 */
export function shouldBridgeTapClick(input: {
  eventType: string;
  pointerType: string;
  isPrimary: boolean;
  horizontal: boolean;
  startedAt: number;
  now: number;
  movePx: number;
}): boolean {
  return input.eventType === "pointerup"
    && input.pointerType === "touch"
    && input.isPrimary
    && !input.horizontal
    && input.now - input.startedAt <= TAP_MAX_DURATION_MS
    && input.movePx <= TAP_MAX_MOVE_PX;
}

/**
 * A tap on the terminal body is the one gesture that may focus the IME
 * field and pop the mobile keyboard; a swipe (scroll) or a hold
 * (word-selection) must leave the keyboard alone. pointerdown/touchstart
 * fire at the START of every gesture, so the commit happens when the
 * gesture ENDS, and only while it still reads as a tap:
 *
 * - mouse: a short press that barely moved (the shared tap slop and the
 *   shared tap window, so a tap means the same thing everywhere in the
 *   app). A held or dragged button is a swipe/hold, not a tap.
 * - touch: the terminal arms a long-press (word-selection) timer only for
 *   a plain press - no pre-existing selection, not the scrollbar - and
 *   movement cancels it. So "timer still pending" is exactly "the finger
 *   stayed put and was released inside the hold window": a fired timer
 *   was a word-selection hold, a cancelled one a swipe.
 */
export function commitTapOnGestureEnd(input: {
  pointerType: string;
  /** How far the pointer travelled from where the gesture started. */
  movePx: number;
  /** How long the gesture lasted before release. */
  durationMs: number;
  /** Touch only: whether the long-press timer is still pending. */
  touchLongPressPending?: boolean;
}): boolean {
  if (input.pointerType === "touch") {
    return input.touchLongPressPending === true && input.movePx <= TAP_MAX_MOVE_PX;
  }
  return input.movePx <= TAP_MAX_MOVE_PX && input.durationMs <= TAP_MAX_DURATION_MS;
}

export interface TapControlInfo {
  /** The tap's own closest interactive ancestor kind, or null. */
  nearestControl: "button" | "link" | "summary" | "label" | "roleButton" | "backdrop" | null;
  /** Whether the tap itself landed on bottom-sheet content. */
  insideBottomSheet: boolean;
  /** Whether the tap landed inside the terminal function key rows. */
  insideExtraKeys: boolean;
  /** Whether the nearest control is the project reorder handle. */
  isDragHandle: boolean;
}

/**
 * Whether the control under a bridged tap may be activated by synthesizing a
 * click. Only real interactive controls qualify; controls that own their
 * pointer sequence (terminal function keys, reorder handles) would run twice,
 * and a tap on sheet content must not be turned into a backdrop dismissal.
 */
export function shouldBridgeTapControl(control: TapControlInfo): boolean {
  if (!control.nearestControl) return false;
  if (control.nearestControl === "backdrop" && control.insideBottomSheet) return false;
  if (control.insideExtraKeys) return false;
  if (control.isDragHandle) return false;
  return true;
}

/**
 * Whether a click event that trails a bridged tap must be swallowed. The
 * guard is one-shot: if the click is not the one it waits for, it still
 * disarms and the fresh interaction passes through.
 */
export function shouldSwallowTrailingClick(input: {
  armed: boolean;
  nearTap: boolean;
}): boolean {
  return input.armed && input.nearTap;
}
