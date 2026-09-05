/** A terminal grid in cells. */
export interface Grid { cols: number; rows: number }
/** A box in CSS pixels. */
export interface Size { width: number; height: number }

/**
 * A measurement is usable when both axes are finite and positive: a pane the
 * layout has not sized yet, or one whose computed padding came back empty
 * (`parseFloat("")`), must leave the proposal alone rather than clamp it to
 * the 2x1 floor.
 */
function usableSize(size: Size | null): size is Size {
  return !!size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

/**
 * Whole cells within a span. The cell size is measured from the rendered
 * grid, so an exact fit can land a hair under the boundary in floating point
 * (65 x 16.1026 reading as 1064.9999...); a hundredth of a pixel of slack
 * keeps that row instead of dropping it, and is far too small to overflow.
 */
function cellsWithin(span: number, cellSize: number): number {
  return Math.floor((span + 0.01) / cellSize);
}

/**
 * The grid a content box holds at a given cell size (floor: 2 cols x 1 row).
 * `content` must already exclude any letterbox padding around the grid - the
 * caller measures the terminal element's own content box, not its border box
 * (a border-box parent, under `* { box-sizing: border-box }`, counts padding
 * as usable space it is not).
 *
 * Null (never the floored grid) when either measurement is not yet usable,
 * so a caller can fall back to its own default instead of clamping to the
 * floor before anything has actually been laid out or painted.
 */
export function gridForContent(content: Size, cell: Size | null): Grid | null {
  if (!usableSize(cell) || !usableSize(content)) return null;
  return {
    cols: Math.max(2, cellsWithin(content.width, cell.width)),
    rows: Math.max(1, cellsWithin(content.height, cell.height))
  };
}

// Zoom fills a pane by growing/shrinking xterm's fontSize, never by touching
// the announced viewport: the announcement is always computed from the BASE
// cell metrics (see gridForContent above), so raising the font size can never
// feed back into a smaller announced grid. Without that separation, zooming
// in would shrink the announced grid, which would shrink the host PTY grid
// (the minimum boundary over viewing clients), which would zoom in further -
// a ratchet that collapses the session to a couple of columns.
const ZOOM_TOLERANCE_PX = 0.05;
const MIN_ZOOM_FONT_SIZE = 4;
const MAX_ZOOM_FONT_SIZE = 400;

/**
 * The next font size for `grid` to fill `content` while keeping its cell
 * aspect ratio, given the cell size measured at `fontSize`. xterm's cell
 * metrics scale linearly with font size, so scaling by
 * `min(content.w / gridWidth, content.h / gridHeight)` (measured at the
 * current font size) converges the grid onto the content box's tighter axis
 * without distorting the cell.
 *
 * Returns null - the signal a caller's fixed-point correction loop uses to
 * stop - when a measurement is unusable, the grid is empty, or the change is
 * under a 0.05px tolerance (glyph-advance rounding between font sizes would
 * otherwise let the loop oscillate forever over sub-pixel noise). The result
 * is clamped to a [4px, 400px] sanity band; there is no cap on zooming in
 * beyond that.
 */
export function zoomedFontSize(fontSize: number, grid: Grid, cell: Size | null, content: Size | null): number | null {
  if (!(Number.isFinite(fontSize) && fontSize > 0)) return null;
  if (!usableSize(cell) || !usableSize(content)) return null;
  if (!(grid.cols > 0 && grid.rows > 0)) return null;
  const gridWidth = grid.cols * cell.width;
  const gridHeight = grid.rows * cell.height;
  if (!(gridWidth > 0 && gridHeight > 0)) return null;
  const scale = Math.min(content.width / gridWidth, content.height / gridHeight);
  if (!(Number.isFinite(scale) && scale > 0)) return null;
  const next = Math.round(fontSize * scale * 100) / 100;
  if (Math.abs(next - fontSize) < ZOOM_TOLERANCE_PX) return null;
  return Math.min(MAX_ZOOM_FONT_SIZE, Math.max(MIN_ZOOM_FONT_SIZE, next));
}
