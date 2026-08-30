import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_SIZE, calibratedSquishFontSize, squishAdvanceRatio, squishedCharAdvance, squishFontSize, squishInverse, squishLineHeight, squishNetScale, squishWidthPercent } from "./terminalSquish.ts";

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

test("a DOM advance that disagrees with the canvas cell width is folded into the squished font", () => {
  // The canvas measures a single 'W' while each accessibility row resolves
  // its own face/rounding. If the row text at 12px is wider than the cell
  // width, the calibrated font shrinks by that ratio so the row advance
  // still lands on the canvas cells.
  const cellWidth = 7.03125;
  const domAdvance = 7.201171875; // e.g. Roboto Mono at the same size
  const ratio = squishAdvanceRatio(cellWidth, domAdvance);
  assertMachineEqual(ratio, cellWidth / domAdvance);
  const fontSize = calibratedSquishFontSize(0.65, ratio);
  assert.equal(fontSize, `${TERMINAL_FONT_SIZE * 0.65 * ratio}px`);
  // calibrated font-size * (ratio-consistent DOM advance per px) == cellWidth * scale
  assertMachineEqual(Number.parseFloat(fontSize) * (domAdvance / TERMINAL_FONT_SIZE), cellWidth * 0.65);
});

test("identical canvas and DOM advances leave the squished font unchanged", () => {
  assert.equal(squishAdvanceRatio(7.03125, 7.03125), 1);
  assert.equal(calibratedSquishFontSize(0.8, 1), squishFontSize(0.8));
});

test("a narrower DOM advance is sized up until the row lands on the canvas cells", () => {
  // Mirror case of the drift above: the layer's face is narrower than the
  // terminal's cell width, so the calibrated size grows by the ratio to lock
  // the row advance onto the squished cell width.
  const cellWidth = 7.201171875;
  const domAdvance = 7.03125;
  const ratio = squishAdvanceRatio(cellWidth, domAdvance);
  assertMachineEqual(ratio, cellWidth / domAdvance);
  assert.ok(ratio > 1);
  const fontSize = calibratedSquishFontSize(0.8, ratio);
  // calibrated font-size * (DOM advance per px of font size) == cellWidth * scale
  assertMachineEqual(Number.parseFloat(fontSize) * (domAdvance / TERMINAL_FONT_SIZE), cellWidth * 0.8);
});

test("calibration clamps wild ratios and ignores degenerate inputs", () => {
  assert.equal(squishAdvanceRatio(7, 3), 1.25);
  assert.equal(squishAdvanceRatio(7, 1), 1.25);
  const loose = squishAdvanceRatio(3, 7);
  assertMachineEqual(loose, 0.8);
  assert.equal(squishAdvanceRatio(0, 7), undefined);
  assert.equal(squishAdvanceRatio(7, 0), undefined);
  assert.equal(squishAdvanceRatio(Number.NaN, 7), undefined);
  assert.equal(calibratedSquishFontSize(0.65, undefined), squishFontSize(0.65));
  assert.equal(calibratedSquishFontSize(0.65, 0), squishFontSize(0.65));
});

test("band boundary ratios survive and non-finite measurements fall back cleanly", () => {
  assertMachineEqual(squishAdvanceRatio(9, 7.2), 1.25);
  assertMachineEqual(squishAdvanceRatio(5.76, 7.2), 0.8);
  assert.equal(squishAdvanceRatio(Number.POSITIVE_INFINITY, 7), undefined);
  assert.equal(squishAdvanceRatio(7, Number.POSITIVE_INFINITY), undefined);
  assert.equal(squishAdvanceRatio(-4, 7), undefined);
  assert.equal(squishAdvanceRatio(7, -4), undefined);
});

test("calibrated sizing degrades to the plain squish on bad scale or ratio inputs", () => {
  for (const scale of [0, -0.65, Number.NaN]) {
    assert.equal(calibratedSquishFontSize(scale, 1), squishFontSize(scale));
  }
  assert.equal(calibratedSquishFontSize(0.65, Number.NaN), squishFontSize(0.65));
  assert.equal(calibratedSquishFontSize(0.65, -1), squishFontSize(0.65));
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
