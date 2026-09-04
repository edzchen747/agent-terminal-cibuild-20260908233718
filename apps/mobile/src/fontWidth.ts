// The grid shared by the terminal character-width slider and its
// persisted value: the slider snaps to FONT_WIDTH_STEP, and a value
// saved at the old 1%-granularity is rounded back onto that grid on
// load so the thumb never parks between steps. The constants are the
// single source of truth for both the slider attributes and this
// normalization, so the two can never disagree about the grid.
export const FONT_WIDTH_MIN = 65;
export const FONT_WIDTH_MAX = 100;
export const FONT_WIDTH_STEP = 5;

/**
 * Clamp a persisted width percent into the slider's range and snap it
 * onto the step grid. The ends of the range sit on the grid, so any
 * out-of-range value lands on the nearest end.
 */
export function normalizeFontWidthPercent(value: number): number {
  const clamped = Math.max(FONT_WIDTH_MIN, Math.min(FONT_WIDTH_MAX, value));
  return Math.round((clamped - FONT_WIDTH_MIN) / FONT_WIDTH_STEP) * FONT_WIDTH_STEP + FONT_WIDTH_MIN;
}
