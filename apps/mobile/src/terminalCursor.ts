/**
 * The mobile terminal routes all keyboard input through its own hidden IME
 * field, so xterm's internal textarea never receives a real focus event
 * (it is kept `display: none` to stay out of the hit/focus path). xterm only
 * renders and blinks the cursor after its textarea focus handler has run:
 * that handler initializes `isCursorInitialized`, marks the rows focused,
 * and fires the focus event that starts the blink animation. On mobile it
 * never runs, leaving the cursor cell invisible.
 *
 * Dispatch the focus/blur event on xterm's textarea directly so xterm
 * believes it owns focus (listeners fire whether or not the element can be
 * focused), while the real keyboard focus stays on the app's IME field.
 */
export function setTerminalCursorFocused(textarea: HTMLTextAreaElement | null | undefined, focused: boolean): void {
  if (!textarea) return;
  const EventClass = typeof FocusEvent !== "undefined" ? FocusEvent : Event;
  textarea.dispatchEvent(new EventClass(focused ? "focus" : "blur"));
}

export function activateTerminalCursor(textarea: HTMLTextAreaElement | null | undefined): void {
  setTerminalCursorFocused(textarea, true);
}

export function deactivateTerminalCursor(textarea: HTMLTextAreaElement | null | undefined): void {
  setTerminalCursorFocused(textarea, false);
}
