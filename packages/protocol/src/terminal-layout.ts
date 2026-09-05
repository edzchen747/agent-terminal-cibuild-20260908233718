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
 * The largest grid the host will size a PTY to (`SESSION_MAX_COLS` /
 * `SESSION_MAX_ROWS` in apps/desktop/src-tauri/src/core.rs, which clamps to
 * the same numbers; the two are pinned together by
 * apps/desktop/src/renderer/src/grid-limits.test.ts).
 *
 * A host policy, not a layout fact: the bound is there because a resize makes
 * ConPTY repaint its whole viewport to every client, and because xterm
 * allocates its scrollback per column. Applied HERE, on the client, so a
 * client can never announce a grid the host would silently rewrite - an
 * announcement that comes back different is what tells a client another
 * client owns the grid, so a silent rewrite reads as a loss of ownership and
 * drops the pane into its fill path. A pane that has hit the ceiling simply
 * stops gaining cells and letterboxes the remainder at its true size.
 */
export const MAX_TERMINAL_COLS = 1600;
export const MAX_TERMINAL_ROWS = 500;

/**
 * The grid a content box holds at a given cell size (floor: 2 cols x 1 row,
 * ceiling: MAX_TERMINAL_COLS x MAX_TERMINAL_ROWS).
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
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(2, cellsWithin(content.width, cell.width))),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(1, cellsWithin(content.height, cell.height)))
  };
}

// Zoom fills a pane by growing/shrinking xterm's fontSize, never by touching
// the announced viewport: the announcement is always computed from the BASE
// cell metrics (see gridForContent above), so raising the font size can never
// feed back into a smaller announced grid. Without that separation, zooming
// in would shrink the announced grid, which would shrink the host PTY grid
// (which follows the owning client verbatim), which would zoom in further -
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

/**
 * The horizontal cell scale to actually paint on a phone, where the user's
 * character-width slider sets how NARROW the cells may go, not how narrow
 * they must be.
 *
 * The announced viewport is computed at the slider's density
 * (`gridForContent` with a `cell.width * userScale`), so when the phone owns
 * the PTY grid it gets exactly the columns it asked for and this returns
 * `userScale` - the slider behaves as set. When the grid it actually renders
 * is NARROWER than that (another client owns a smaller grid), squishing to
 * the slider value would leave dead space down the right-hand side, so the
 * cells relax back towards their natural width until the grid spans the box,
 * bounded by 1 (never wider than the font's own metrics).
 *
 * `cell` is measured at the CURRENT font size and `content` is the visual
 * box, both in the same space; deriving the paint scale from the rendered
 * grid (and the announcement from the slider) is what keeps the two from
 * feeding back into each other. Null when a measurement is unusable.
 */
export function squishScaleToFill(grid: Grid, cell: Size | null, content: Size | null, userScale: number): number | null {
  if (!usableSize(cell) || !usableSize(content)) return null;
  if (!(grid.cols > 0)) return null;
  if (!(Number.isFinite(userScale) && userScale > 0)) return null;
  const gridWidth = grid.cols * cell.width;
  if (!(gridWidth > 0)) return null;
  const fill = content.width / gridWidth;
  if (!(Number.isFinite(fill) && fill > 0)) return null;
  return Math.min(1, Math.max(Math.min(userScale, 1), fill));
}
