import assert from "node:assert/strict";
import test from "node:test";
import { classifyGestureAxis } from "./gesture.ts";

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
