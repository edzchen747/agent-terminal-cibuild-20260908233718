export const TERMINAL_FONT_SIZE = 12;

// The terminal is squished horizontally by a scaleX(fontWidthScale) wrapper
// whose width is 100 / fontWidthScale so the same number of columns paints at
// the final size. Android's native selection handles anchor to the
// accessibility layer's real layout rects (ignoring CSS transforms) while the
// painted highlight follows them. To reconcile both, the accessibility text is
// laid out with real glyph metrics at the final visual cell size and the
// wrapper scale is cancelled on that same layer, so layout, paint, and handle
// anchors all coincide with the visible cells.

export function squishWidthPercent(scale: number): string {
  return `${100 / scale}%`;
}

export function squishFontSize(scale: number): string {
  return `${TERMINAL_FONT_SIZE * scale}px`;
}

// The accessibility layer can never assume its DOM glyph advance is exactly the
// terminal's measured cell width * scale: the canvas measures a single 'W' at
// the base size while each accessibility row may resolve a different face or
// rounding for a given character (bundled subsets, device fallbacks, WebView
// font scaling). Keep the ratio between the layer's real advance and the
// canvas cell width and fold it into the squished font size, so the text
// advance at font size 12 * scale * ratio lands exactly on cells that are
// cellWidth * scale wide.
const CALIBRATION_RATIO_BAND: readonly [number, number] = [0.8, 1.25];

export function squishAdvanceRatio(cellWidth: number, domAdvance: number): number | undefined {
  if (!(Number.isFinite(cellWidth) && Number.isFinite(domAdvance) && cellWidth > 0 && domAdvance > 0)) return undefined;
  const ratio = cellWidth / domAdvance;
  return Math.min(CALIBRATION_RATIO_BAND[1], Math.max(CALIBRATION_RATIO_BAND[0], ratio));
}

export function calibratedSquishFontSize(scale: number, ratio: number | undefined): string {
  if (!(Number.isFinite(scale) && scale > 0)) return squishFontSize(scale);
  const safeRatio = ratio ?? 0;
  if (!(Number.isFinite(safeRatio) && safeRatio > 0)) return squishFontSize(scale);
  return `${TERMINAL_FONT_SIZE * scale * safeRatio}px`;
}

export function squishLineHeight(scale: number): string {
  return `${1 / scale}`;
}

export function squishInverse(scale: number): number {
  return scale > 0 ? 1 / scale : 1;
}

// Wrapper scaleX(scale) composed with the accessibility layer's inverse
// scaleX(1/scale) must map layout coordinates through net identity, so the
// invisible screen-reader text cells land exactly on the visible canvas cells.
export function squishNetScale(scale: number): number {
  return squishInverse(scale) * scale;
}

// The screenshot in the accessibility layer is at squishFontSize(scale), so a
// character that is cellWidth px wide at base font size occupies cellWidth *
// scale in that layer's layout - the same advance the scaled canvas glyphs
// have. That is why the native handle anchors line up with the highlight.
export function squishedCharAdvance(cellWidth: number, scale: number): number {
  return cellWidth * scale;
}
