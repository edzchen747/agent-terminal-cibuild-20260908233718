/**
 * Desktop terminal zoom: a discrete ladder of scale factors applied to the
 * BASE cell metrics before the viewport is announced.
 *
 * Zoom is a cell-size change, not a rendering trick. The pane announces the
 * grid that fits its content box at `baseCell * zoom` (see gridForContent),
 * so zooming in announces FEWER, bigger cells and zooming out announces more,
 * smaller ones - which is what makes it survive the trip through the host:
 * the PTY grid genuinely changes, every viewing client (a phone included)
 * follows that grid the way it follows any other resize, and the pane's own
 * fill pass (zoomedFontSize) grows the font to paint the smaller grid across
 * the same pane. Scaling the font directly instead would leave the announced
 * grid - and therefore every other client - untouched, so the zoom would be
 * invisible to the session.
 *
 * The ladder is finer at the bottom than the top because zoom is perceived
 * multiplicatively: a 5% step is a sixth of the range at 25% but a fortieth
 * of it at 200%, so the steps widen (5 -> 10 -> 25) to keep each press worth
 * roughly the same visible jump.
 */

import { MAX_ZOOM_FONT_SIZE, MIN_ZOOM_FONT_SIZE, type Size } from "./terminal-layout.js";

/** The zoom the desktop's fixed baseline cell size represents. */
export const BASELINE_TERMINAL_ZOOM = 100 as const;

/** Every zoom stop, ascending, as a percentage of the baseline cell size. */
export const TERMINAL_ZOOM_STEPS: readonly number[] = [
  25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200
];

export const MIN_TERMINAL_ZOOM = TERMINAL_ZOOM_STEPS[0]!;
export const MAX_TERMINAL_ZOOM = TERMINAL_ZOOM_STEPS[TERMINAL_ZOOM_STEPS.length - 1]!;

/**
 * The stop to settle a percentage on: the nearest one, ties going to the
 * lower (more conservative) stop. Non-finite input falls back to the
 * baseline, so a corrupt stored value can never strand a pane off the ladder.
 */
export function nearestTerminalZoom(percent: number): number {
  if (!Number.isFinite(percent)) return BASELINE_TERMINAL_ZOOM;
  let best = TERMINAL_ZOOM_STEPS[0]!;
  for (const step of TERMINAL_ZOOM_STEPS) {
    if (Math.abs(step - percent) < Math.abs(best - percent)) best = step;
  }
  return best;
}

/**
 * One step in or out from `percent`, clamped at the ends of the ladder.
 *
 * Anchored on the neighbouring stop rather than on an index, so a value that
 * is off the ladder entirely (a stale setting, a ladder that changed between
 * releases) still moves exactly one stop in the asked-for direction instead
 * of snapping past it.
 */
export function steppedTerminalZoom(percent: number, direction: number): number {
  const from = Number.isFinite(percent) ? percent : BASELINE_TERMINAL_ZOOM;
  if (direction > 0) {
    for (const step of TERMINAL_ZOOM_STEPS) if (step > from) return step;
    return MAX_TERMINAL_ZOOM;
  }
  if (direction < 0) {
    for (let i = TERMINAL_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
      const step = TERMINAL_ZOOM_STEPS[i]!;
      if (step < from) return step;
    }
    return MIN_TERMINAL_ZOOM;
  }
  return nearestTerminalZoom(from);
}

/**
 * The font size a zoom stop paints at.
 *
 * A pure function of the stop and the pane's baseline size - nothing about
 * the grid, the pane's box, or the current cell feeds into it. That is the
 * whole point: because the font size cannot be derived from the grid, the
 * grid is free to be derived from a REAL measurement of the cell at this
 * size, rather than extrapolated from the baseline cell. xterm requantises
 * glyph advance and line height independently at each size, so an
 * extrapolated cell is wrong by a fraction that changes from stop to stop -
 * which is felt as the cell (and the letterbox around it) changing shape as
 * you zoom.
 *
 * Clamped into the same [MIN_ZOOM_FONT_SIZE, MAX_ZOOM_FONT_SIZE] band the fill
 * pass uses: the bottom stops of the ladder are small enough to land under a
 * browser's own minimum font size, where the DOM renderer's glyphs stop
 * shrinking but its cells do not and the text collapses into an overlapping
 * smear. A stop that hits the floor simply stops getting smaller.
 */
export function terminalZoomFontSize(baseFontSize: number, percent: number): number {
  if (!(Number.isFinite(baseFontSize) && baseFontSize > 0)) return 0;
  const size = Math.round(baseFontSize * nearestTerminalZoom(percent)) / 100;
  return Math.min(MAX_ZOOM_FONT_SIZE, Math.max(MIN_ZOOM_FONT_SIZE, size));
}

/**
 * `cell` linearly scaled from `fromFontSize` to `toFontSize`.
 *
 * Strictly an interim estimate, for the frame between asking for a stop and
 * having painted at it. It is the approximation described above, so a caller
 * must replace it with a real measurement once the stop has rendered rather
 * than keep announcing from it.
 */
export function extrapolatedCell(cell: Size | null, fromFontSize: number, toFontSize: number): Size | null {
  if (!cell) return null;
  if (!(Number.isFinite(fromFontSize) && fromFontSize > 0)) return null;
  if (!(Number.isFinite(toFontSize) && toFontSize > 0)) return null;
  const ratio = toFontSize / fromFontSize;
  return { width: cell.width * ratio, height: cell.height * ratio };
}
