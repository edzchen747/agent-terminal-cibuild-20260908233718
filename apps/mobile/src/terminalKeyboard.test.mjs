import assert from "node:assert/strict";
import test from "node:test";
import { keyboardOpenState, keyboardOpenByLayout, keyboardLayoutReference } from "./terminalKeyboard.ts";

test("a keyboard-sized visual viewport delta counts as open", () => {
  assert.equal(keyboardOpenState(640, 340), true);
  assert.equal(keyboardOpenState(640, 300), true);
});

test("chrome-level deltas stay closed", () => {
  assert.equal(keyboardOpenState(640, 620), false);
  assert.equal(keyboardOpenState(640, 600), false);
  assert.equal(keyboardOpenState(640, 500), false);
});

test("degenerate or zero heights are never open", () => {
  assert.equal(keyboardOpenState(0, 0), false);
  assert.equal(keyboardOpenState(640, 0), false);
  assert.equal(keyboardOpenState(0, 640), false);
});

test("a height loss at an unchanged width is the keyboard inset", () => {
  const reference = { width: 360, height: 700 };
  assert.equal(keyboardOpenByLayout({ width: 360, height: 560 }, reference), true);
  assert.equal(keyboardOpenByLayout({ width: 360, height: 460 }, reference), true);
  // A smaller loss is chrome, not a keyboard.
  assert.equal(keyboardOpenByLayout({ width: 360, height: 680 }, reference), false);
});

test("a width move is a hardware resize, never a keyboard", () => {
  const reference = { width: 360, height: 700 };
  assert.equal(keyboardOpenByLayout({ width: 640, height: 460 }, reference), false);
  assert.equal(keyboardOpenByLayout({ width: 320, height: 460 }, reference), false);
  // Degenerate layouts are never open.
  assert.equal(keyboardOpenByLayout({ width: 0, height: 0 }, reference), false);
});

test("no reference yet cannot prove a keyboard", () => {
  assert.equal(keyboardOpenByLayout({ width: 360, height: 460 }, null), false);
});

test("the keyboard-free reference tracks the tallest stable layout", () => {
  const start = { width: 360, height: 700 };
  let ref = keyboardLayoutReference(start, null);
  assert.deepEqual(ref, start);
  // A keyboard-close returns to the same size.
  ref = keyboardLayoutReference({ width: 360, height: 700 }, ref);
  assert.equal(ref.height, 700);
  // A real (larger) resize re-baselines upward.
  ref = keyboardLayoutReference({ width: 360, height: 780 }, ref);
  assert.equal(ref.height, 780);
  // A shrunken size keeps the reference (that is the keyboard).
  ref = keyboardLayoutReference({ width: 360, height: 560 }, ref);
  assert.equal(ref.height, 780);
  // A width move re-baselines to the new size entirely.
  ref = keyboardLayoutReference({ width: 640, height: 460 }, ref);
  assert.deepEqual(ref, { width: 640, height: 460 });
});
