import assert from "node:assert/strict";
import test from "node:test";
import { classifyGestureAxis, shouldBridgeTapClick, shouldBridgeTapControl, shouldSwallowTrailingClick, TAP_MAX_DURATION_MS, TAP_MAX_MOVE_PX } from "./gesture.ts";

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

const plainControl = {
  nearestControl: "button",
  insideBottomSheet: false,
  insideExtraKeys: false,
  isDragHandle: false
};

test("the first tap after a simulated fast flick is bridged on a plain button", () => {
  assert.equal(shouldBridgeTapClick(baseTap), true);
  assert.equal(shouldBridgeTapControl(plainControl), true);
});

test("the first tap after a simulated fast flick is bridged on links, labels, summaries and role buttons", () => {
  for (const nearestControl of ["link", "label", "summary", "roleButton"]) {
    assert.equal(shouldBridgeTapControl({ ...plainControl, nearestControl }), true);
  }
});

test("a tap on sheet content is not turned into a backdrop dismissal", () => {
  assert.equal(shouldBridgeTapControl({ ...plainControl, nearestControl: "backdrop", insideBottomSheet: true }), false);
  assert.equal(shouldBridgeTapControl({ ...plainControl, nearestControl: "backdrop", insideBottomSheet: false }), true);
});

test("controls that own their pointer sequence are never double-activated", () => {
  assert.equal(shouldBridgeTapControl({ ...plainControl, insideExtraKeys: true }), false);
  assert.equal(shouldBridgeTapControl({ ...plainControl, isDragHandle: true }), false);
});

test("no control under the tap means nothing is synthesized", () => {
  assert.equal(shouldBridgeTapControl({ ...plainControl, nearestControl: null }), false);
});

test("the trailing click of a bridged tap is swallowed only near the tap", () => {
  assert.equal(shouldSwallowTrailingClick({ armed: true, nearTap: true }), true);
  assert.equal(shouldSwallowTrailingClick({ armed: true, nearTap: false }), false);
});

test("an unarmed guard never swallows a click", () => {
  assert.equal(shouldSwallowTrailingClick({ armed: false, nearTap: true }), false);
});
