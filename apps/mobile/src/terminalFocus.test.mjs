import assert from "node:assert/strict";
import test from "node:test";
import { terminalFocusAction } from "./terminalFocus.ts";

test("entering the terminal view activates the cursor without focusing the IME field", () => {
  // The regression guard for the auto-keyboard: a view entry (pager
  // swipe or mount while active) is never an explicit input gesture, so
  // it must not focus the IME field whose focus pops the Android soft
  // keyboard.
  assert.equal(terminalFocusAction({ active: true, explicitInput: false }), "cursor");
});

test("an explicit input gesture focuses the IME field", () => {
  assert.equal(terminalFocusAction({ active: true, explicitInput: true }), "input");
});

test("an inactive view focuses nothing", () => {
  // A background page must stay out of the focus path entirely, even if
  // a stale gesture event lands on it.
  assert.equal(terminalFocusAction({ active: false, explicitInput: false }), "none");
  assert.equal(terminalFocusAction({ active: false, explicitInput: true }), "none");
});

test("entry and attach-complete are treated as non-explicit", () => {
  // Both paths that re-focus on their own (view entry, session.attach
  // replay finishing) must land on the cursor-only action - they never
  // carry an explicit input intent.
  const entry = terminalFocusAction({ active: true, explicitInput: false });
  const attachComplete = terminalFocusAction({ active: true, explicitInput: false });
  assert.equal(entry, "cursor");
  assert.equal(attachComplete, "cursor");
});
