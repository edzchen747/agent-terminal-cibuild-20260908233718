import assert from "node:assert/strict";
import test from "node:test";
import { shouldCommitBackSwipe, BACK_SWIPE_COMMIT_DISTANCE_RATIO, BACK_SWIPE_COMMIT_VELOCITY_PX_MS } from "./backSwipe.ts";
import { SWIPE_COMMIT_DISTANCE_RATIO, SWIPE_COMMIT_VELOCITY_PX_MS } from "./gesture.ts";

const VIEW_WIDTH = 400;

test("back swipe thresholds stay pinned to the pager's shared commit feel", () => {
  // backSwipe.ts duplicates these so Node can run it without extensionless
  // imports; this pin keeps the back swipe and the pager swiping identically.
  assert.equal(BACK_SWIPE_COMMIT_DISTANCE_RATIO, SWIPE_COMMIT_DISTANCE_RATIO);
  assert.equal(BACK_SWIPE_COMMIT_VELOCITY_PX_MS, SWIPE_COMMIT_VELOCITY_PX_MS);
});

test("a rightward drag past the distance threshold commits", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: VIEW_WIDTH * SWIPE_COMMIT_DISTANCE_RATIO + 1, widthPx: VIEW_WIDTH, velocityPxPerMs: 0.01 }), true);
});

test("a rightward drag commits exactly at the distance boundary", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: VIEW_WIDTH * SWIPE_COMMIT_DISTANCE_RATIO, widthPx: VIEW_WIDTH, velocityPxPerMs: 0 }), true);
});

test("a slow short rightward drag snaps back", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 40, widthPx: VIEW_WIDTH, velocityPxPerMs: 0.1 }), false);
});

test("a fast flick commits even when the view barely moved", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 20, widthPx: VIEW_WIDTH, velocityPxPerMs: SWIPE_COMMIT_VELOCITY_PX_MS }), true);
});

test("a flick that is slightly too slow snaps back", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 20, widthPx: VIEW_WIDTH, velocityPxPerMs: SWIPE_COMMIT_VELOCITY_PX_MS - 0.01 }), false);
});

test("leftward and zero-movement swipes never commit, no matter how fast", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: -VIEW_WIDTH, widthPx: VIEW_WIDTH, velocityPxPerMs: 5 }), false);
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 0, widthPx: VIEW_WIDTH, velocityPxPerMs: 5 }), false);
});

test("a cancelled gesture never commits", () => {
  assert.equal(shouldCommitBackSwipe({ cancelled: true, deltaX: VIEW_WIDTH, widthPx: VIEW_WIDTH, velocityPxPerMs: 5 }), false);
});

test("the distance threshold scales with the view width", () => {
  // The rule is a fraction of the view, not a pixel count: the same 100px
  // drag commits on a phone-width view (27.8% of 360) but falls short on a
  // wider one (16.7% of 600) and, flick-free, snaps back.
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 100, widthPx: 360, velocityPxPerMs: 0 }), true);
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 100, widthPx: 600, velocityPxPerMs: 0 }), false);
});

test("a drag one pixel short of the threshold and below flick speed snaps back", () => {
  // The commit boundary is inclusive (exactly at the threshold commits, as
  // pinned above); one pixel short with a sub-flick release must not.
  assert.equal(shouldCommitBackSwipe({
    cancelled: false,
    deltaX: VIEW_WIDTH * SWIPE_COMMIT_DISTANCE_RATIO - 1,
    widthPx: VIEW_WIDTH,
    velocityPxPerMs: SWIPE_COMMIT_VELOCITY_PX_MS - 0.01
  }), false);
});

test("invalid or out-of-band readings never commit", () => {
  // A NaN displacement (a missing touch point) and a negative velocity are
  // invalid gesture data: the safe answer is to spring back, not to leave.
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: Number.NaN, widthPx: VIEW_WIDTH, velocityPxPerMs: 0.1 }), false);
  assert.equal(shouldCommitBackSwipe({ cancelled: false, deltaX: 40, widthPx: VIEW_WIDTH, velocityPxPerMs: -5 }), false);
});