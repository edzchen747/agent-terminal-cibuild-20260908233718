import assert from "node:assert/strict";
import test from "node:test";
import { UTILITY_KEY_GAP_PX, UTILITY_KEY_MIN_BUTTON_WIDTH_PX, UTILITY_KEY_ROW_PADDING_PX, UTILITY_KEY_ROW_TWO_KEY_COUNT, utilityKeyButtonWidth, utilityKeyRowMinWidth, utilityKeyRowsFit } from "./utilityKeyLayout.ts";

const NARROW_DEVICE = 360;
const TYPICAL_DEVICE = 412;

test("the second row minimum width fits the narrowest common device", () => {
  // The second row is the widest (8 keys). A 360px device must be able to
  // show every key without horizontal overflow.
  assert.equal(utilityKeyRowsFit(TYPICAL_DEVICE), true);
  assert.equal(utilityKeyRowsFit(NARROW_DEVICE), true);
});

test("the row with the most keys sets the fit threshold", () => {
  // Row one has one key fewer, so if row two fits then row one fits too.
  assert.equal(utilityKeyRowMinWidth(7) < utilityKeyRowMinWidth(UTILITY_KEY_ROW_TWO_KEY_COUNT), true);
  const threshold = utilityKeyRowMinWidth(UTILITY_KEY_ROW_TWO_KEY_COUNT);
  assert.equal(utilityKeyRowsFit(threshold), true);
  assert.equal(utilityKeyRowsFit(threshold - 1), false);
});

test("buttons never shrink below the readable minimum", () => {
  // 320px leaves only (320 - 45 padding/gaps) / 8 ≈ 34px per button, so the
  // result must clamp to the readable floor instead of going smaller.
  const tiny = utilityKeyButtonWidth(320, UTILITY_KEY_ROW_TWO_KEY_COUNT);
  assert.equal(tiny, UTILITY_KEY_MIN_BUTTON_WIDTH_PX);
  assert.equal(utilityKeyButtonWidth(10, UTILITY_KEY_ROW_TWO_KEY_COUNT), UTILITY_KEY_MIN_BUTTON_WIDTH_PX);
});

test("buttons share the space equally inside a fitting container", () => {
  const width = 500;
  const buttons = utilityKeyButtonWidth(width, UTILITY_KEY_ROW_TWO_KEY_COUNT);
  assert.ok(buttons > UTILITY_KEY_MIN_BUTTON_WIDTH_PX);
  const total = buttons * UTILITY_KEY_ROW_TWO_KEY_COUNT + (UTILITY_KEY_ROW_TWO_KEY_COUNT - 1) * UTILITY_KEY_GAP_PX + UTILITY_KEY_ROW_PADDING_PX;
  assert.ok(total <= width);
  assert.ok(total > width - UTILITY_KEY_GAP_PX);
});

test("invalid key counts cannot overflow the row silently", () => {
  assert.equal(utilityKeyRowMinWidth(0), 0);
  assert.equal(utilityKeyRowMinWidth(-1), 0);
  assert.equal(utilityKeyRowMinWidth(2.5), 0);
  assert.equal(utilityKeyButtonWidth(412, 0), 0);
});
