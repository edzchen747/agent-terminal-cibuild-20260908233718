import assert from "node:assert/strict";
import test from "node:test";
import { FONT_WIDTH_MAX, FONT_WIDTH_MIN, FONT_WIDTH_STEP, normalizeFontWidthPercent } from "./fontWidth.ts";

test("the slider grid ends and step agree", () => {
  // The range ends must sit on the grid and the step must tile the
  // range exactly, or the slider's last position would land short of
  // the maximum.
  assert.equal((FONT_WIDTH_MAX - FONT_WIDTH_MIN) % FONT_WIDTH_STEP, 0);
  assert.equal(normalizeFontWidthPercent(FONT_WIDTH_MIN), FONT_WIDTH_MIN);
  assert.equal(normalizeFontWidthPercent(FONT_WIDTH_MAX), FONT_WIDTH_MAX);
});

test("values already on the step grid are unchanged", () => {
  for (let value = FONT_WIDTH_MIN; value <= FONT_WIDTH_MAX; value += FONT_WIDTH_STEP) {
    assert.equal(normalizeFontWidthPercent(value), value);
  }
});

test("a value saved at 1% granularity snaps to the nearest step", () => {
  assert.equal(normalizeFontWidthPercent(73), 75);
  assert.equal(normalizeFontWidthPercent(72), 70);
  assert.equal(normalizeFontWidthPercent(99), 100);
  assert.equal(normalizeFontWidthPercent(66), 65);
  assert.equal(normalizeFontWidthPercent(88), 90);
});

test("out-of-range values land on the nearest range end", () => {
  assert.equal(normalizeFontWidthPercent(40), FONT_WIDTH_MIN);
  assert.equal(normalizeFontWidthPercent(200), FONT_WIDTH_MAX);
  assert.equal(normalizeFontWidthPercent(64), FONT_WIDTH_MIN);
  assert.equal(normalizeFontWidthPercent(101), FONT_WIDTH_MAX);
});

test("every value in the range normalizes onto the step grid", () => {
  for (let value = FONT_WIDTH_MIN; value <= FONT_WIDTH_MAX; value += 1) {
    const snapped = normalizeFontWidthPercent(value);
    assert.ok(snapped >= FONT_WIDTH_MIN && snapped <= FONT_WIDTH_MAX);
    assert.equal((snapped - FONT_WIDTH_MIN) % FONT_WIDTH_STEP, 0);
  }
});
