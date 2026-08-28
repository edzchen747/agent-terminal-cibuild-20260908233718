export type GestureAxis = "pending" | "horizontal" | "vertical";

const INTENT_THRESHOLD_PX = 7;
const HORIZONTAL_BIAS = 1.2;

export function classifyGestureAxis(deltaX: number, deltaY: number): GestureAxis {
  if (Math.hypot(deltaX, deltaY) <= INTENT_THRESHOLD_PX) return "pending";
  return Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_BIAS ? "horizontal" : "vertical";
}
