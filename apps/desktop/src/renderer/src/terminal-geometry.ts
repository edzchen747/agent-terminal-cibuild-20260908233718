/** A terminal grid in cells. */
export interface Grid { cols: number; rows: number }
/** A box in CSS pixels. */
export interface Size { width: number; height: number }

/**
 * Clamp a FitAddon proposal to the pane's content box.
 *
 * `proposeDimensions()` measures `getComputedStyle(parent)`, which under the
 * app's `* { box-sizing: border-box }` is the pane's *border* box, and then
 * subtracts only the padding of the terminal element itself - which has none,
 * because the letterbox padding lives on `.terminal-pane`. So the proposal
 * counts that padding as usable and can be a whole row (or column) too
 * generous: the surplus row renders below the pane, where the status bar
 * paints over it. How much is left over depends on the window height, which
 * is why a half-screen snap cuts a visible strip while a maximized window
 * hides a couple of pixels.
 *
 * The proposal is only ever narrowed here: the addon's own allowance (it
 * reserves the scrollbar width in the column count) still applies.
 */
export function gridWithinPane(proposed: Grid, content: Size, cell: Size | null): Grid {
  if (!usableSize(cell) || !usableSize(content)) return proposed;
  return {
    cols: Math.max(2, Math.min(proposed.cols, cellsWithin(content.width, cell.width))),
    rows: Math.max(1, Math.min(proposed.rows, cellsWithin(content.height, cell.height)))
  };
}

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
