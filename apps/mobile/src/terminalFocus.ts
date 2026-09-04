// Decides who owns input focus when the mobile terminal view is entered,
// re-attached, or receives an explicit gesture.
//
// Entering a terminal view must not bring up the software keyboard: on
// Android, focusing the hidden IME field is what pops the keyboard. The
// xterm cursor cell still needs to believe it owns focus or it stops
// blinking (see terminalCursor.ts), so entry activates the cursor ALONE
// and leaves the IME field unfocused. The keyboard follows only a
// committed tap - a tap on the terminal body or a utility-key press -
// which focuses the IME field. A swipe or a hold must NOT pop the
// keyboard, so a terminal tap commits only when its gesture ENDS as a
// tap (gesture.ts: commitTapOnGestureEnd), never on the gesture's first
// moment.

export type TerminalFocusAction = "input" | "cursor" | "none";

/**
 * @param active        the terminal page is the active view right now.
 * @param explicitInput the call came from a user gesture that intends to
 *                      type (a tap on the terminal, a utility key).
 */
export function terminalFocusAction({ active, explicitInput }: { active: boolean; explicitInput: boolean }): TerminalFocusAction {
  if (!active) return "none";
  return explicitInput ? "input" : "cursor";
}
