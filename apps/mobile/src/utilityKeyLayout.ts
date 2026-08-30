/**
 * Layout constants driving the utility key rows and the math that keeps them
 * on screen.
 *
 * The terminal div is stretched to 100/scale% (so that, after its scaleX
 * squish, the same number of columns fits) and the shell pins that stretch
 * to a single grid column; the key rows therefore always lay out against
 * the real viewport width, never the widened terminal box.
 */
export const UTILITY_KEY_GAP_PX = 5;
export const UTILITY_KEY_MIN_BUTTON_WIDTH_PX = 38;
export const UTILITY_KEY_ROW_PADDING_PX = 10;
export const UTILITY_KEY_ROW_ONE_KEY_COUNT = 7;
export const UTILITY_KEY_ROW_TWO_KEY_COUNT = 8;

/** Total width a utility key row occupies for its keys on screen. */
export function utilityKeyRowMinWidth(keyCount: number): number {
  if (!Number.isInteger(keyCount) || keyCount <= 0) return 0;
  return keyCount * UTILITY_KEY_MIN_BUTTON_WIDTH_PX + (keyCount - 1) * UTILITY_KEY_GAP_PX + UTILITY_KEY_ROW_PADDING_PX;
}

/**
 * The width each button reaches inside a container of the given width:
 * padding and gaps are reserved first, free space is shared equally, and a
 * button never shrinks below its readable minimum.
 */
export function utilityKeyButtonWidth(containerWidthPx: number, keyCount: number): number {
  if (keyCount <= 0) return 0;
  const remaining = Math.max(0, containerWidthPx - UTILITY_KEY_ROW_PADDING_PX - (keyCount - 1) * UTILITY_KEY_GAP_PX);
  return Math.max(UTILITY_KEY_MIN_BUTTON_WIDTH_PX, remaining / keyCount);
}

/**
 * Whether both utility key rows fit a container of the given width without
 * horizontal overflow. The second row carries the most keys, so it is the
 * one that sets the minimum.
 */
export function utilityKeyRowsFit(containerWidthPx: number): boolean {
  return utilityKeyRowMinWidth(UTILITY_KEY_ROW_TWO_KEY_COUNT) <= containerWidthPx;
}
