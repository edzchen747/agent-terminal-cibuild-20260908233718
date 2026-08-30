import assert from "node:assert/strict";
import test from "node:test";
import { activateTerminalCursor, deactivateTerminalCursor, setTerminalCursorFocused } from "./terminalCursor.ts";

function createFakeTextarea() {
  const listeners = [];
  const dispatched = [];
  return {
    dispatched,
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
    dispatchEvent(event) {
      for (const entry of listeners) {
        if (entry.type === event.type) entry.listener(event);
      }
      dispatched.push({ type: event.type, trusted: event.isTrusted });
      return true;
    }
  };
}

test("focusing the dedicated IME field also fires xterm's textarea focus handler", () => {
  const textarea = createFakeTextarea();
  let focusedEvents = 0;
  textarea.addEventListener("focus", () => { focusedEvents += 1; });

  activateTerminalCursor(textarea);

  assert.equal(dispatchedLength(textarea), 1);
  assert.equal(textarea.dispatched[0].type, "focus");
  assert.equal(focusedEvents, 1);
});

test("blurring the dedicated IME field fires xterm's textarea blur handler", () => {
  const textarea = createFakeTextarea();
  let blurredEvents = 0;
  textarea.addEventListener("blur", () => { blurredEvents += 1; });

  deactivateTerminalCursor(textarea);

  assert.equal(textarea.dispatched[0].type, "blur");
  assert.equal(blurredEvents, 1);
});

test("a missing textarea is a no-op instead of a crash", () => {
  assert.doesNotThrow(() => activateTerminalCursor(null));
  assert.doesNotThrow(() => deactivateTerminalCursor(null));
  assert.doesNotThrow(() => setTerminalCursorFocused(null, true));
  assert.doesNotThrow(() => setTerminalCursorFocused(null, false));
});

test("the dispatched event reaches xterm listeners through dispatchEvent", () => {
  // xterm attaches its focus/blur handlers with addEventListener on its
  // textarea; dispatchEvent delivers to those regardless of isTrusted.
  const textarea = createFakeTextarea();
  let seen = null;
  textarea.addEventListener("focus", (event) => { seen = { type: event.type, bubbles: event.bubbles }; });

  setTerminalCursorFocused(textarea, true);

  assert.deepEqual(seen, { type: "focus", bubbles: false });
});

function dispatchedLength(textarea) {
  return textarea.dispatched.length;
}
