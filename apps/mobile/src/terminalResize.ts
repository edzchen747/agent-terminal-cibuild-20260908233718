export interface TerminalSize { cols: number; rows: number; }

/**
 * Decide whether an announced viewport size must be sent to the host.
 *
 * The host PTY grid is the minimum boundary over the clients viewing the
 * session, so a client announces its container's fitted size (never asserted
 * to seize the grid). An unforced announcement sends only when the fit
 * actually changed, so layout observers that fire without a real size change
 * do not spam the host with identical resizes.
 */
export function shouldSendResize(cols: number, rows: number, last: TerminalSize): boolean {
  return cols !== last.cols || rows !== last.rows;
}

/**
 * The viewport announced for a terminal area. While the software keyboard
 * is open one row is subtracted: the keyboard inset overlaps the measured
 * fit's last row, and the shortened grid keeps the last visible line clear
 * of the keyboard (never below a single row).
 */
export function announcedViewport(dims: TerminalSize, keyboardOpen: boolean): TerminalSize {
  if (!keyboardOpen) return { ...dims };
  return { cols: dims.cols, rows: Math.max(1, dims.rows - 1) };
}
