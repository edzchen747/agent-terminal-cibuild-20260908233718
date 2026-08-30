import assert from "node:assert/strict";
import test from "node:test";
import { classifyGestureAxis, hasScrollableSheetAncestor, shouldBridgeTapClick, shouldBridgeTapControl, shouldCommitSheetDismiss, shouldSwallowTrailingClick, SHEET_DISMISS_DISTANCE_PX, SHEET_DISMISS_MIN_FLICK_PX, SHEET_DISMISS_VELOCITY_PX_MS, SHEET_SLIDER_HORIZONTAL_BIAS, TAP_MAX_DURATION_MS, TAP_MAX_MOVE_PX } from "./gesture.ts";

test("gesture intent waits through initial touch jitter", () => {
  assert.equal(classifyGestureAxis(5, 4), "pending");
  assert.equal(classifyGestureAxis(5, 4, SHEET_SLIDER_HORIZONTAL_BIAS), "pending");
});

test("vertical terminal scrolling tolerates horizontal finger drift", () => {
  assert.equal(classifyGestureAxis(9, 8), "vertical");
  assert.equal(classifyGestureAxis(10, 20), "vertical");
});

test("a clearly horizontal movement selects page navigation", () => {
  assert.equal(classifyGestureAxis(13, 5), "horizontal");
  assert.equal(classifyGestureAxis(-13, 5), "horizontal");
});

test("a slider thumb pull stays horizontal despite downward drift", () => {
  assert.equal(classifyGestureAxis(30, 25, SHEET_SLIDER_HORIZONTAL_BIAS), "horizontal");
  assert.equal(classifyGestureAxis(20, 30, SHEET_SLIDER_HORIZONTAL_BIAS), "horizontal");
});

test("only a clearly vertical movement claims a drag that started on the slider", () => {
  assert.equal(classifyGestureAxis(10, 30, SHEET_SLIDER_HORIZONTAL_BIAS), "vertical");
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

test("a sheet drag past the distance threshold commits the dismissal", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: SHEET_DISMISS_DISTANCE_PX + 1, velocityPxPerMs: 0.01 }), true);
});

test("a sheet drag commits exactly at the distance boundary", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: SHEET_DISMISS_DISTANCE_PX, velocityPxPerMs: 0 }), true);
});

test("a slow short sheet drag snaps back", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: 30, velocityPxPerMs: 0.1 }), false);
});

test("a quick flick commits even when the sheet moved only a little", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: 26, velocityPxPerMs: 1.1 }), true);
});

test("a flick commits exactly at both flick boundaries", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: SHEET_DISMISS_MIN_FLICK_PX, velocityPxPerMs: SHEET_DISMISS_VELOCITY_PX_MS }), true);
});

test("a flick at the minimum distance is rejected when too slow", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: SHEET_DISMISS_MIN_FLICK_PX, velocityPxPerMs: SHEET_DISMISS_VELOCITY_PX_MS - 0.01 }), false);
});

test("a fast flick is rejected when slightly under the minimum distance", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: SHEET_DISMISS_MIN_FLICK_PX - 1, velocityPxPerMs: 2 }), false);
});

test("a flick that barely moves is not enough to dismiss", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: 5, velocityPxPerMs: 3 }), false);
});

test("cancelled or non-moving sheet gestures never dismiss", () => {
  assert.equal(shouldCommitSheetDismiss({ cancelled: true, distancePx: 200, velocityPxPerMs: 2 }), false);
  assert.equal(shouldCommitSheetDismiss({ cancelled: false, distancePx: 0, velocityPxPerMs: 0 }), false);
});

test("the directory list chain marks the sheet region as scrolling", () => {
  assert.equal(hasScrollableSheetAncestor(["visible", "auto", "visible"]), true);
  assert.equal(hasScrollableSheetAncestor(["scroll", "visible"]), true);
});

test("the character-width slider chain never marks the region as scrolling", () => {
  assert.equal(hasScrollableSheetAncestor(["visible", "visible", "visible"]), false);
  assert.equal(hasScrollableSheetAncestor(["hidden", "clip", "visible"]), false);
  assert.equal(hasScrollableSheetAncestor([]), false);
});
