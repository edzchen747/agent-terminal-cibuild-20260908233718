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
