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

// fontSize is the terminal's CURRENT font size, not always TERMINAL_FONT_SIZE:
// the zoom feature raises or lowers it to fill the pane (see applyZoom in
// MobileTerminal.tsx), and the squish must track whatever that live value is.
export function squishFontSize(fontSize: number, scale: number): string {
  return `${fontSize * scale}px`;
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

export function calibratedSquishFontSize(fontSize: number, scale: number, ratio: number | undefined): string {
  if (!(Number.isFinite(scale) && scale > 0)) return squishFontSize(fontSize, scale);
  const safeRatio = ratio ?? 0;
  if (!(Number.isFinite(safeRatio) && safeRatio > 0)) return squishFontSize(fontSize, scale);
  return `${fontSize * scale * safeRatio}px`;
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

// xterm's mouse tracking (the reports a TUI receives for a tap) reads the tap
// through the terminal's POST-transform box - getBoundingClientRect - but then
// divides by its PRE-transform (layout) cell width. On the squished wrapper
// the two spaces differ by exactly the scaleX scale, so a tap reports a column
// offset from the finger by that factor. Map a viewport (visual) x coordinate
// back through the wrapper scale, anchored at the terminal's own (unmoved, the
// transform origin sits on its left edge) left edge, so the coordinate xterm
// reads is in the same layout space as its cell width and the click lands on
// the cell the finger is actually over.
export function inverseSquishClientX(clientX: number, elementLeft: number, scale: number): number {
  if (!(Number.isFinite(clientX)) || !Number.isFinite(elementLeft)) return clientX;
  if (!(Number.isFinite(scale) && scale > 0) || scale === 1) return clientX;
  return elementLeft + (clientX - elementLeft) / scale;
}

// The screenshot in the accessibility layer is at squishFontSize(scale), so a
// character that is cellWidth px wide at base font size occupies cellWidth *
// scale in that layer's layout - the same advance the scaled canvas glyphs
// have. That is why the native handle anchors line up with the highlight.
export function squishedCharAdvance(cellWidth: number, scale: number): number {
  return cellWidth * scale;
}
