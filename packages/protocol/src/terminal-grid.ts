/**
 * Applying the host's grid to an emulator without losing - or duplicating -
 * history.
 *
 * The Windows console and xterm.js disagree about what growing a viewport
 * means, and every SIGWINCH ends with ConPTY redrawing its whole viewport
 * from home, so the disagreement is written straight over the client's buffer:
 *
 * - ConPTY keeps its screen anchored at the TOP of the viewport and pads the
 *   rows it gained with blanks at the bottom. Its scrollback stays put.
 * - xterm.js grows by pulling lines back OUT of the scrollback into the
 *   viewport, so `baseY` drops by the number of rows gained.
 *
 * The lines xterm restored are then overwritten - by the blank rows ConPTY
 * padded its own view with - and that history is gone. It happens on any
 * shrink-and-grow of a session's grid, which is exactly what a phone taking
 * the grid over and handing it back looks like.
 *
 * The fix is to line the client's frame up with the console's before the
 * repaint lands: the repaint says how many rows of content the console has
 * (its cursor sits on the last one), so anything the client holds above that
 * is history the repaint will NOT redraw, and belongs in the scrollback.
 * Push exactly those lines back and the repaint overwrites blank rows and its
 * own content, never history - and never a second copy of it either, which is
 * what compensating by "rows xterm reclaimed" instead would leave behind.
 */

/** The parts of an xterm.js terminal this needs. */
export interface FrameTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly baseY: number;
      readonly type?: string;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  resize(cols: number, rows: number): void;
  write(data: string, done?: () => void): void;
}

/** `CSI ?25l`, the pen ConPTY draws with, then a home. */
const REPAINT_HEAD = /^\x1b\[\?25l(?:\x1b\[[0-9;:]*m)*\x1b\[(?:H|1;1H)/;
/**
 * The absolute cursor placement a repaint signs off with, anchored on the
 * show-cursor that closes it rather than on the end of the chunk: the shell's
 * own prompt fixup can follow the repaint inside the same chunk (the host
 * merges writes that land within a couple of milliseconds of each other).
 */
const REPAINT_CURSOR = /\x1b\[(\d+);\d+H\x1b\[\?25h/;

/**
 * How many rows of content the console has, read off the repaint it sent
 * after a resize, or null when `chunk` is not a resize repaint at all.
 *
 * A repaint ends by putting the cursor back where the console's is, and for a
 * shell that is the last row it drew anything on. When it signs off with
 * relative motion instead, the cursor is wherever the drawing ended - the
 * bottom of the screen - so the console has no blank rows to account for.
 */
export function consoleContentRows(chunk: string, rows: number): number | null {
  if (!REPAINT_HEAD.test(chunk)) return null;
  const cursor = chunk.match(REPAINT_CURSOR);
  if (!cursor) return rows;
  return Math.min(rows, Math.max(1, Number(cursor[1])));
}

/** Rows of the viewport holding content, ignoring blank rows at the bottom. */
export function viewportContentRows(terminal: FrameTerminal): number {
  const buffer = terminal.buffer.active;
  for (let row = terminal.rows - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(buffer.baseY + row);
    if (line && line.translateToString(true).trim() !== "") return row + 1;
  }
  return 0;
}

/**
 * Move `push` lines from the top of the viewport into the scrollback, leaving
 * that many blank rows at the bottom.
 *
 * A line feed on the last row is the only thing that scrolls a line INTO the
 * scrollback (`CSI S` deletes it instead), so the cursor is parked there for
 * the duration. DECSC/DECRC save the cursor's place in the BUFFER rather than
 * on screen, so it comes back on the same content it was on - no correction
 * for the rows that moved, and a repaint that never arrives cannot strand it
 * at the bottom.
 */
export function scrollIntoScrollback(push: number, rows: number): string {
  if (!(push > 0) || !(rows > 0)) return "";
  return `\x1b7\x1b[${rows};1H${"\n".repeat(push)}\x1b8`;
}

/**
 * One emulator's view of the console's frame. Owns the "a grid change just
 * happened, the repaint is the next thing to arrive" state, so a client only
 * has to route its grid changes and its stream writes through it.
 */
export class ConsoleFrame {
  #awaitingRepaint = false;

  /**
   * Resize to the host's grid. Returns whether the emulator actually changed
   * size, so a caller can keep its own "only on a real change" bookkeeping.
   */
  applyGrid(terminal: FrameTerminal, cols: number, rows: number): boolean {
    if (cols === terminal.cols && rows === terminal.rows) return false;
    terminal.resize(cols, rows);
    this.#awaitingRepaint = true;
    return true;
  }

  /**
   * What to write before `data` to line this emulator's frame up with the
   * console's. Empty unless `data` is the repaint answering a grid change
   * this instance applied - so an ordinary chunk, a second chunk after the
   * repaint, or a full-screen redraw from a TUI (which owns the alternate
   * screen, where there is no scrollback to protect) all pass through
   * untouched.
   */
  alignmentFor(terminal: FrameTerminal, data: string): string {
    if (!this.#awaitingRepaint || !data) return "";
    this.#awaitingRepaint = false;
    if (terminal.buffer.active.type === "alternate") return "";
    const consoleRows = consoleContentRows(data, terminal.rows);
    if (consoleRows === null) return "";
    return scrollIntoScrollback(viewportContentRows(terminal) - consoleRows, terminal.rows);
  }
}

/** Write one chunk of the host's stream, frame-aligned if it is a repaint. */
export function writeHostChunk(
  frame: ConsoleFrame,
  terminal: FrameTerminal,
  data: string,
  done?: () => void
): void {
  const alignment = frame.alignmentFor(terminal, data);
  if (alignment) terminal.write(alignment);
  terminal.write(data, done);
}
