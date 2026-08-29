export interface TerminalSize { cols: number; rows: number; }

/**
 * Decide whether a fitted terminal size must be asserted to the host.
 *
 * A forced fit (tap, refocus, or any keystroke) asserts unconditionally:
 * another client, or a lost message, may have moved the host PTY away from
 * this client's size, and a locally unchanged fit cannot detect that. This
 * mirrors the desktop write path, which reasserts its own dimensions on
 * every key.
 *
 * An unforced ResizeObserver fit asserts only when the fit actually
 * changed, so layout observers that fire without a real size change do not
 * spam the host with identical resizes.
 */
export function shouldSendResize(force: boolean, cols: number, rows: number, last: TerminalSize): boolean {
  return force || cols !== last.cols || rows !== last.rows;
}
