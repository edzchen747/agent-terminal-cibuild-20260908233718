/**
 * The desktop keyboard-ownership policy.
 *
 * The active terminal pane owns the document keyboard: a click on window
 * chrome (the sidebar, title bar, tab bar, status bar, or the document
 * itself) must not pull the keyboard off the shell. Only blocking overlays
 * - the modals (pair, settings, devices, rename, and the per-pane link
 * confirm) and the split context menu - take the keyboard while they are
 * open, and the keyboard is handed back to the terminal when the last one
 * closes. Input controls (the find input, the shell picker, a settings
 * input, the rename field) keep the keyboard the user moved it to.
 *
 * App.tsx runs the policy: it classifies where document focus has settled
 * (classifyKeyboardFocus) and asks shouldReturnKeyboardToTerminal whether
 * the keyboard should go back to the active terminal pane.
 */

/**
 * Where document focus currently sits, in the terms of the policy.
 *
 * - "terminal": the active pane's own input surface (xterm's helper
 *   textarea). The keyboard is already where it belongs.
 * - "control": a text control that is not the terminal's - the find input,
 *   the shell picker, a settings input, the rename field. The keyboard was
 *   moved there deliberately and stays there.
 * - "overlay": inside an overlay region - a modal, the split context menu,
 *   or a pane's find bar. A blocking overlay owns the keyboard while it is
 *   open; the find bar does not block, so a keyboard that settles there is
 *   still returned to the terminal.
 * - "chrome": anywhere else - a button, a project row, the title bar, or
 *   the document itself. The keyboard was pulled off the terminal by a
 *   click on window chrome.
 */
export type FocusPlacement = "terminal" | "control" | "overlay" | "chrome";

/** What a focused element contributes to the placement classification. */
export interface FocusPlacementInput {
  /** The element is the terminal's own input surface (xterm's helper textarea). */
  readonly isTerminalSurface: boolean;
  /** The element is a text control (input, select, or textarea). */
  readonly isControl: boolean;
  /** The element is inside an overlay region (a modal, the split menu, or a find bar). */
  readonly insideOverlay: boolean;
}

/**
 * Classify where document focus has settled.
 *
 * The precedence matters: the terminal's helper textarea is itself a
 * textarea, so the terminal-surface check must win; the find input sits in
 * the find-bar overlay but is a control, and a control keeps the keyboard
 * it was given.
 */
export function classifyKeyboardFocus({ isTerminalSurface, isControl, insideOverlay }: FocusPlacementInput): FocusPlacement {
  if (isTerminalSurface) return "terminal";
  if (isControl) return "control";
  if (insideOverlay) return "overlay";
  return "chrome";
}

export interface KeyboardSettlement {
  /** Where document focus currently sits. */
  readonly focus: FocusPlacement;
  /** Whether a blocking overlay (a modal or the split menu) is on screen. */
  readonly overlayOpen: boolean;
}

/**
 * Whether the keyboard should be handed back to the active terminal pane.
 *
 * Spec: return it exactly when it has settled on window chrome, or on the
 * non-blocking find bar. Never while a blocking overlay is on screen -
 * that overlay's own close path restores the terminal - and never from the
 * terminal or an input control, where the keyboard already sits where it
 * belongs.
 */
export function shouldReturnKeyboardToTerminal({ focus, overlayOpen }: KeyboardSettlement): boolean {
  if (focus === "terminal" || focus === "control") return false;
  if (overlayOpen) return false;
  return true;
}

/**
 * The keyboard handle a terminal pane registers with the app's policy: take
 * the document keyboard (focus) or give it up (blur).
 */
export interface TerminalKeyboardHandle {
  focus: () => void;
  blur: () => void;
}