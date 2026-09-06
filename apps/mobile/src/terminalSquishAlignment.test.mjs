import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function source(name) {
  return readFileSync(join(SRC_DIR, name), "utf8");
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("the accessibility calibration measures the real cell width and DOM advance", () => {
  // The terminal cannot assume its DOM glyph advance is cellWidth * scale: it
  // must read the width xterm actually painted on the accessibility layer and
  // the advance this WebView really lays out, then fold the ratio into the
  // squished font size (see terminalSquish.squishAdvanceRatio).
  const terminal = source("MobileTerminal.tsx");

  assert.ok(terminal.includes('hostElement.querySelector<HTMLElement>(".xterm-accessibility")'),
    "cell width must come from xterm's own accessibility container");
  assert.ok(terminal.includes('hostElement.querySelector<HTMLElement>(".xterm-accessibility-tree")'),
    "the advance mirror must live in the row layer so fonts resolve identically");
  assert.ok(terminal.includes("Number.parseFloat(a11y.style.width)"),
    "the container width is the css-pixel canvas width, cellWidth * cols");
  assert.ok(terminal.includes("const cellWidth = containerWidth / terminal.cols"),
    "the cell width must be divided by the current column count");
  assert.ok(terminal.includes("const currentFontSize = terminal.options.fontSize ?? TERMINAL_FONT_SIZE"),
    "the calibration must read the terminal's live font size, not assume it is still the base");

  assert.ok(terminal.includes('mirror.className = "xterm-char-measure-element"'),
    "the advance must be measured with xterm's hide-offscreen measure element");
  assert.ok(terminal.includes("mirror.style.fontFamily = TERMINAL_FONT_FAMILY"),
    "the mirror span must use the exact terminal font stack");
  assert.ok(terminal.includes("mirror.style.fontSize = `${currentFontSize}px`"),
    // Zoom (see applyZoom) raises or lowers xterm's font size to fill the
    // pane, so the base TERMINAL_FONT_SIZE would drift from reality once
    // zoomed - the advance must track whatever size is currently applied.
    "the advance must be measured at the terminal's current (possibly zoomed) font size");
  assert.ok(terminal.includes('mirror.textContent = "W".repeat(32)'),
    "the advance must be averaged over repeated glyphs to stay sub-pixel");
  assert.ok(terminal.includes("mirror.getBoundingClientRect().width / 32"),
    "fractional rect width keeps the sub-pixel precision offsetWidth loses");
  assert.ok(terminal.includes("mirror.remove()"), "the mirror span must not leak into the layer");
});

test("the measured ratio is fed into the squished font size the reference CSS consumes", () => {
  // f24cb46 laid out the accessibility text at the squished cell metrics and
  // cancelled the wrapper scale on that layer. The calibrated font size must
  // reach that layer through the same --terminal-squish-font-size variable.
  const terminal = source("MobileTerminal.tsx");
  const styles = source("styles.css");

  assert.ok(terminal.includes("a11yAdvanceRatioRef.current = squishAdvanceRatio(cellWidth, domAdvance)"),
    "the ratio must be clamped by squishAdvanceRatio, not applied raw");
  assert.ok(terminal.includes('hostElement.style.setProperty("--terminal-squish-font-size", calibratedSquishFontSize(currentFontSize, renderScaleRef.current, a11yAdvanceRatioRef.current))'),
    "the calibrated size must be painted immediately, without waiting for a render");
  assert.ok(terminal.includes("calibratedSquishFontSize(currentFontSize, renderScale, a11yAdvanceRatioRef.current)"),
    "renders must repeat the calibrated size, at the live font size, so slider updates and zoom changes both keep it");
  assert.ok(terminal.includes("const a11yAdvanceRatioRef = useRef<number | undefined>(undefined)"),
    "an uncalibrated layer must fall back to the plain squish, not a stale value");

  assert.ok(styles.includes("font-size: var(--terminal-squish-font-size, 12px)"),
    "the reference CSS rule must consume the squished font variable");
  assert.ok(styles.includes("transform: scaleX(var(--terminal-squish-inverse, 1))"),
    "the reference wrapper-scale cancellation must stay intact");
});

test("calibration guards missing layout and re-runs on every refit", () => {
  const terminal = source("MobileTerminal.tsx");

  assert.ok(terminal.includes("if (!a11y || !tree || terminal.cols <= 0) return"),
    "a not-yet-laid-out accessibility layer must not be measured");
  assert.ok(terminal.includes("if (!(containerWidth > 0)) return"),
    "an unset container width must not poison the ratio");

  // Open, forced resize and animated resize all refit; each must recalibrate.
  const calibrations = countOccurrences(terminal, "calibrateAccessibilityMetrics();");
  assert.ok(calibrations >= 3, `expected recalibration after open and both refits, found ${calibrations}`);
});

test("calibration binding survives the preloaded-font gate and lives near the Terminal", () => {
  const terminal = source("MobileTerminal.tsx");
  const gateIndex = terminal.indexOf("calibrateAccessibilityMetrics();");
  const openIndex = terminal.indexOf("terminal.open(hostElement)");
  const fitIndex = terminal.indexOf("fit.fit();");

  assert.ok(gateIndex > openIndex && gateIndex > fitIndex,
    "the calibration must run after xterm owns the DOM and has fitted the terminal");
});

test("the slider drives the announcement and the paint scale drives the rendering", () => {
  // The two must never swap: the announced viewport is derived from the
  // user's slider (a fixed input), and the painted scale is derived from the
  // grid the host actually gave back. Deriving the announcement from what is
  // painted would let a relaxed squish shrink the grid, which would relax it
  // further - the same ratchet the base-cell rule prevents for zoom.
  const terminal = source("MobileTerminal.tsx");

  assert.ok(terminal.includes("return gridForContent(content, { width: baseCell.width * fontWidthScaleRef.current, height: baseCell.height });"),
    "the announcement must ask for columns at the SLIDER's density, not the painted one");
  assert.ok(terminal.includes("applyRenderScale(squishScaleToFill(grid, cell, content, userScale))"),
    "the painted scale must come from the rendered grid against the visual box");
  assert.ok(terminal.includes("const width = layoutWidth * renderScaleRef.current;"),
    "the visual box must be the layout box times the painted scale, so it is stable across scale changes");
  assert.ok(terminal.includes("const renderScaleRef = useRef(fontWidthScale);"),
    "the painted scale starts at the slider value and relaxes from there");
});

test("interactions claim the pty grid so the phone can actually get the columns it asks for", () => {
  // Under the host's ownership policy an unclaimed announce from a non-owner
  // changes nothing, so every real interaction on the phone - a tap, opening
  // the terminal, dragging the character-width slider - has to claim.
  const terminal = source("MobileTerminal.tsx");

  assert.ok(terminal.includes("connection.send({ type: \"session.resize\", sessionId: session.id, cols: dims.cols, rows: dims.rows, claim });"),
    "a forced (interaction-driven) announce claims; a layout announce does not");
  assert.ok(terminal.includes("claim: announced !== null"),
    "attaching - the user explicitly opening this terminal - claims the grid (with a measured viewport; an unmeasured attach defers the claim to the post-replay resize)");
  assert.ok(terminal.includes("if (activeRef.current) resizeRef.current(true);"),
    "a character-width change is an interaction with this terminal, so it claims too");
});

test("the squished accessibility layer is laid out inside the scaled wrapper", () => {
  // The reference fix composes the wrapper scaleX(scale) with the layer's
  // scaleX(1/scale). The wrapper must keep serving both the canvas and the
  // accessibility layer, and the layer must invert that scale.
  const terminal = source("MobileTerminal.tsx");
  const styles = source("styles.css");

  assert.ok(terminal.includes("transform: `scaleX(${renderScale})`"),
    "the wrapper must keep scaling the terminal and its accessibility layer");
  assert.ok(terminal.includes("width: squishWidthPercent(renderScale)"),
    "the wrapper must keep stretching the layout so squished columns fit");
  assert.ok(styles.includes(".mobile-terminal .xterm .xterm-accessibility-tree > div { transform: none !important; }"),
    "xterm's own double-correcting row transforms must stay disabled");
});
