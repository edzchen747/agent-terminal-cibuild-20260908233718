import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_SIZE, squishedCharAdvance, squishFontSize, squishInverse, squishLineHeight, squishNetScale, squishWidthPercent } from "./terminalSquish.ts";

const BASE_CELL_WIDTH = 7.2;

function assertMachineEqual(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 2, `${actual} !== ${expected}`);
}

test("the accessibility font size tracks the scale linearly so its layout matches the scaled cells", () => {
  // The screen-reader layer must lay each character out at the same advance
  // the scaled canvas glyphs have. With real glyph metrics at font size
  // 12 * scale, a base-cell character lands at cellWidth * scale - exactly
  // the visible squished cell width the terminal paints.
  for (const scale of [0.65, 0.8, 1]) {
    assert.equal(squishFontSize(scale), `${TERMINAL_FONT_SIZE * scale}px`);
    assert.equal(squishedCharAdvance(BASE_CELL_WIDTH, scale), BASE_CELL_WIDTH * scale);
  }
  assertMachineEqual(squishedCharAdvance(7.03, 0.65), 7.03 * 0.65);
});

test("the inverse scale cancels the wrapper scale so layout, paint, and handle anchors coincide", () => {
  // The terminal is painted through scaleX(scale); the accessibility layer
  // cancels it with scaleX(1/scale). The composed transform must be net
  // identity, otherwise the invisible selection layer drifts from the cells.
  for (const scale of [0.65, 0.8, 1]) {
    assert.equal(squishInverse(scale), 1 / scale);
    assert.equal(squishNetScale(scale), 1);
  }
});

test("the wrapper width stretches the layout so squished text shows more columns", () => {
  assert.equal(squishWidthPercent(1), "100%");
  assert.equal(squishWidthPercent(0.65), "153.84615384615384%");
});

test("an invalid scale defaults the squish to no-op instead of breaking", () => {
  // A zero or negative scale would divide by zero in the width/line-height
  // math and should degrade to the unsquished terminal.
  assert.equal(squishInverse(0), 1);
  assert.equal(squishInverse(-1), 1);
  assertMachineEqual(squishInverse(0.65), 1 / 0.65);
});

test("unity scale leaves the terminal and its accessibility layer unchanged", () => {
  assert.equal(squishFontSize(1), "12px");
  assert.equal(squishLineHeight(1), "1");
  assert.equal(squishWidthPercent(1), "100%");
  assert.equal(squishNetScale(1), 1);
});

test("screen-reader rows keep the original cell height despite the smaller glyph font", () => {
  // The tree sets line-height: 1/scale so the line box stays
  // 12px * scale * (1/scale) = 12px, the same height as the unscaled cell.
  const lineHeightMultiplier = Number(squishLineHeight(0.65));
  assert.equal((TERMINAL_FONT_SIZE * 0.65) * lineHeightMultiplier, TERMINAL_FONT_SIZE);
});
