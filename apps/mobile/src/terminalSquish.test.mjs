import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_SIZE, calibratedSquishFontSize, inverseSquishClientX, squishAdvanceRatio, squishedCharAdvance, squishFontSize, squishInverse, squishLineHeight, squishNetScale, squishWidthPercent } from "./terminalSquish.ts";

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
    assert.equal(squishFontSize(TERMINAL_FONT_SIZE, scale), `${TERMINAL_FONT_SIZE * scale}px`);
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
  const fontSize = calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.65, ratio);
  assert.equal(fontSize, `${TERMINAL_FONT_SIZE * 0.65 * ratio}px`);
  // calibrated font-size * (ratio-consistent DOM advance per px) == cellWidth * scale
  assertMachineEqual(Number.parseFloat(fontSize) * (domAdvance / TERMINAL_FONT_SIZE), cellWidth * 0.65);
});

test("identical canvas and DOM advances leave the squished font unchanged", () => {
  assert.equal(squishAdvanceRatio(7.03125, 7.03125), 1);
  assert.equal(calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.8, 1), squishFontSize(TERMINAL_FONT_SIZE, 0.8));
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
  const fontSize = calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.8, ratio);
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
  assert.equal(calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.65, undefined), squishFontSize(TERMINAL_FONT_SIZE, 0.65));
  assert.equal(calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.65, 0), squishFontSize(TERMINAL_FONT_SIZE, 0.65));
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
    assert.equal(calibratedSquishFontSize(TERMINAL_FONT_SIZE, scale, 1), squishFontSize(TERMINAL_FONT_SIZE, scale));
  }
  assert.equal(calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.65, Number.NaN), squishFontSize(TERMINAL_FONT_SIZE, 0.65));
  assert.equal(calibratedSquishFontSize(TERMINAL_FONT_SIZE, 0.65, -1), squishFontSize(TERMINAL_FONT_SIZE, 0.65));
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
  assert.equal(squishFontSize(TERMINAL_FONT_SIZE, 1), "12px");
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

test("the squished font size tracks the terminal's live, possibly-zoomed font size, not just the base", () => {
  // The zoom feature (see applyZoom in MobileTerminal.tsx) raises or lowers
  // xterm's font size to fill the pane; the accessibility calibration must
  // scale from whatever that current value is, not a hard-coded base.
  const zoomedFontSize = 19.5;
  assert.equal(squishFontSize(zoomedFontSize, 0.8), `${zoomedFontSize * 0.8}px`);
  const ratio = 1.1;
  const fontSize = calibratedSquishFontSize(zoomedFontSize, 0.8, ratio);
  assert.equal(fontSize, `${zoomedFontSize * 0.8 * ratio}px`);
});

test("the inverse squish maps a viewport tap back through the wrapper scale", () => {
  // xterm reads a tap's x through the post-transform (visual) box but divides
  // by its pre-transform (layout) cell width, so the two must be reconciled.
  // A visual offset from the terminal's (unmoved) left edge is a LAYOUT offset
  // divided by the scale, so the remapped x anchors the visual offset back at
  // the left edge scaled by 1/scale.
  const left = 100;
  // scale < 1 (squished, wider than the layout): a tap nearer the right edge
  // is closer to the left edge in layout space than in visual space.
  assertMachineEqual(inverseSquishClientX(left + 90, left, 0.5), left + 180);
  // scale > 1 (stretched): a tap is farther from the left edge in layout space.
  assertMachineEqual(inverseSquishClientX(left + 30, left, 3), left + 10);
  // The remap is a pure re-anchor: clientX maps to the same visual point.
  assertMachineEqual(inverseSquishClientX(left + 42, left, 0.65), left + (42 / 0.65));
});

test("a unity or invalid scale leaves the tap coordinate unchanged", () => {
  const left = 12;
  // scale === 1 is the unsquished terminal: the coordinate must pass through
  // untouched, so a no-squish phone is never affected by the remap.
  assert.equal(inverseSquishClientX(200, left, 1), 200);
  // A degenerate scale (0, negative, NaN) must not divide by zero or poison
  // the coordinate - it degrades to the un-remapped value.
  for (const scale of [0, -1, Number.NaN]) {
    assert.equal(inverseSquishClientX(200, left, scale), 200);
  }
  // Non-finite inputs must pass through rather than produce NaN.
  assert.equal(inverseSquishClientX(Number.NaN, left, 0.5), Number.NaN);
  assert.equal(inverseSquishClientX(200, Number.NaN, 0.5), 200);
});

test("the remap is the exact inverse of the forward squish (net identity round-trip)", () => {
  // A layout x paints at visual x = left + (layoutX - left) * scale. Running
  // that visual coordinate through inverseSquishClientX must recover the
  // original layout x - the forward and inverse transforms cancel - for any
  // left, any positive scale, and any layout x (including outside the box).
  const cases = [
    { left: 100, scale: 0.5, xs: [0, 50, 100, 200, 300, 1000] },
    { left: 0, scale: 1, xs: [-3, 0, 1, 42] },
    { left: 0, scale: 2.5, xs: [0, 16, 64, 1024] },
    { left: 0, scale: 0.65, xs: [0, 7.2, 7.03125, 403.2] } // fractional/sub-pixel cells
  ];
  for (const { left, scale, xs } of cases) {
    for (const layoutX of xs) {
      const visualX = left + (layoutX - left) * scale;
      assertMachineEqual(inverseSquishClientX(visualX, left, scale), layoutX,
        `round-trip failed for left=${left} scale=${scale} layoutX=${layoutX}`);
    }
  }
});

test("a tap on the terminal's left edge is the fixed point of the remap", () => {
  // The transform origin sits on the left edge, so that edge does not move
  // under the scaleX. A tap exactly on it must map to itself for ANY scale
  // (including the squished and stretched cases), and a tap anywhere on a
  // degenerate box (clientX === elementLeft) is a no-op.
  for (const scale of [0.1, 0.5, 0.65, 1.5, 3]) {
    assertMachineEqual(inverseSquishClientX(250, 250, scale), 250);
  }
});

test("taps outside the terminal's right edge keep remapping linearly", () => {
  // A drag that runs off the right edge still reports a column (xterm clamps
  // it to the last one), so the remap must stay a valid linear map there too -
  // it must not saturate, flip, or produce NaN for large positive offsets.
  const left = 100;
  assertMachineEqual(inverseSquishClientX(left + 100000, left, 0.5), left + 200000);
  assertMachineEqual(inverseSquishClientX(left + 100000, left, 4), left + 25000);
  // And a tap far to the LEFT of the element (negative offset) maps left of
  // the element in layout space as well - the offset just grows by 1/scale.
  assertMachineEqual(inverseSquishClientX(left - 40, left, 0.5), left - 80);
});

test("a negative elementLeft (scrolled / off-screen terminal) still remaps correctly", () => {
  // The page can be scrolled so the terminal's viewport x is negative. The
  // remap is anchored at that left edge, so a negative left must not break the
  // round-trip or the arithmetic.
  const left = -120;
  for (const layoutX of [-400, -120, 0, 300]) {
    const visualX = left + (layoutX - left) * 0.75;
    assertMachineEqual(inverseSquishClientX(visualX, left, 0.75), layoutX);
  }
  // A clientX of 0 (the viewport origin) with a negative left is a plain
  // linear offset from the left edge.
  assertMachineEqual(inverseSquishClientX(0, -100, 0.5), -100 + 200);
});

test("infinite and non-finite coordinates and scales degrade to pass-through", () => {
  // Infinity / -Infinity coordinates are not finite, so they must pass
  // through untouched rather than turn into NaN.
  assert.equal(inverseSquishClientX(Number.POSITIVE_INFINITY, 100, 0.5), Number.POSITIVE_INFINITY);
  assert.equal(inverseSquishClientX(Number.NEGATIVE_INFINITY, 100, 0.5), Number.NEGATIVE_INFINITY);
  // An infinite elementLeft is not finite either - pass through the clientX.
  assert.equal(inverseSquishClientX(200, Number.POSITIVE_INFINITY, 0.5), 200);
  // An infinite or non-finite scale must not be divided: the coordinate is
  // returned un-remapped (the same path as a scale of 0).
  for (const scale of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
    assert.equal(inverseSquishClientX(200, 100, scale), 200);
  }
});

test("a negative-zero scale is treated as a degenerate scale (no-op)", () => {
  // -0 > 0 is false, so -0 takes the same safe path as 0: no division, the
  // coordinate passes through. This guards against a scale of -0 sneaking in
  // and producing a sign-flipped division.
  assert.equal(inverseSquishClientX(200, 100, -0), 200);
});

test("extreme (very small / very large) scales stay numerically sane", () => {
  // The fill pass clamps the scale into a sane band, but the helper must not
  // overflow or underflow on an extreme input: a tiny scale magnifies the
  // offset by 1/scale and a huge one shrinks it, both still finite and exact.
  const left = 100;
  assertMachineEqual(inverseSquishClientX(left + 1, left, 0.001), left + 1000);
  assertMachineEqual(inverseSquishClientX(left + 1000, left, 1000), left + 1);
  // Sub-pixel inputs stay sub-pixel (no rounding to integer pixels).
  assertMachineEqual(inverseSquishClientX(100.5, 100, 0.5), 101);
  assertMachineEqual(inverseSquishClientX(100.25, 100, 0.5), 100.5);
});
