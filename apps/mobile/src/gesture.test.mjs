import assert from "node:assert/strict";
import test from "node:test";
import { classifyGestureAxis, shouldBridgeTapClick, TAP_MAX_DURATION_MS, TAP_MAX_MOVE_PX } from "./gesture.ts";

test("gesture intent waits through initial touch jitter", () => {
  assert.equal(classifyGestureAxis(5, 4), "pending");
});

test("vertical terminal scrolling tolerates horizontal finger drift", () => {
  assert.equal(classifyGestureAxis(9, 8), "vertical");
  assert.equal(classifyGestureAxis(10, 20), "vertical");
});

test("a clearly horizontal movement selects page navigation", () => {
  assert.equal(classifyGestureAxis(13, 5), "horizontal");
  assert.equal(classifyGestureAxis(-13, 5), "horizontal");
});

const baseTap = {
  eventType: "pointerup",
  pointerType: "touch",
  isPrimary: true,
  horizontal: false,
  now: 1200,
  startedAt: 950,
  movePx: 3
};

test("a taut touch tap is always bridged, no matter when it follows a swipe", () => {
  assert.equal(shouldBridgeTapClick(baseTap), true);
});

test("a slow release is a scroll-ish gesture, not a tap", () => {
  assert.equal(shouldBridgeTapClick({ ...baseTap, now: baseTap.startedAt + TAP_MAX_DURATION_MS + 1 }), false);
});

test("a moving tap can be a drag, not a click", () => {
  assert.equal(shouldBridgeTapClick({ ...baseTap, movePx: TAP_MAX_MOVE_PX + 1 }), false);
});

test("gesture attempts that became a horizontal swipe do not bridge", () => {
  assert.equal(shouldBridgeTapClick({ ...baseTap, horizontal: true }), false);
});

test("mouse, secondary pointers, cancels and moves are ignored", () => {
  assert.equal(shouldBridgeTapClick({ ...baseTap, pointerType: "mouse" }), false);
  assert.equal(shouldBridgeTapClick({ ...baseTap, isPrimary: false }), false);
  assert.equal(shouldBridgeTapClick({ ...baseTap, eventType: "pointercancel" }), false);
});
