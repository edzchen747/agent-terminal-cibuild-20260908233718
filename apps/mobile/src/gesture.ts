export type GestureAxis = "pending" | "horizontal" | "vertical";

const INTENT_THRESHOLD_PX = 7;
const HORIZONTAL_BIAS = 1.2;

export const TAP_MAX_MOVE_PX = 12;
export const TAP_MAX_DURATION_MS = 400;

export function classifyGestureAxis(deltaX: number, deltaY: number): GestureAxis {
  if (Math.hypot(deltaX, deltaY) <= INTENT_THRESHOLD_PX) return "pending";
  return Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_BIAS ? "horizontal" : "vertical";
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
