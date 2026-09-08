import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guards for the session progress ring's CSS and SVG shape.
// The ring's geometry (a half-size ring stuck to the icon's top-left, a
// fill starting at the top-left corner instead of the top centre, a
// dark track on the phone, a pulse that glitched on fast-updating
// progress) were all verified in a real browser before the fixes; this
// test pins the source-level invariants so they cannot silently drift
// back. The logic of what a session row draws is covered by
// session-taskbar.test.mjs.

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const cssRules = css; // searched as raw text; the styles are single-line rules

// ---- The ring's geometry ----------------------------------------------------

test("the fill's outline starts at the top centre and is shared by every ring element", () => {
  // A <rect>'s dash always starts at its top-left corner; the fill is a
  // <path> that starts at the top centre (21, 1.5 in the 42x42 viewBox)
  // and runs clockwise, so the percent fill reads like a gauge from
  // twelve o'clock. The fill, the pulse's mask copy, and the pulse band
  // all reuse ONE constant, so they line up exactly.
  const constant = app.match(/const SESSION_RING_OUTLINE =\s*\n?\s*"([^"]+)"/);
  assert.ok(constant, "the outline must live in a single shared constant");
  assert.ok(
    constant[1].startsWith("M 21 1.5 "),
    "the outline must start at the top centre (21, 1.5)"
  );
  assert.ok(
    constant[1].endsWith("Z"),
    "the outline must close back on itself"
  );
  // Every ring element that draws or masks the outline uses the constant.
  const uses = app.match(/d=\{SESSION_RING_OUTLINE\}/g);
  assert.ok(uses && uses.length >= 3, "fill, mask copy, and pulse band all use the shared outline");
  // No inline copy of the path data may survive: a second literal would
  // drift from the constant and misalign the pulse with the fill.
  const literals = app.match(/d="M 21 1\.5/g);
  assert.equal(literals, null, "the outline must not be inlined anywhere");
});

test("the ring is normalised to 100 so dash values are percents", () => {
  assert.match(app, /<rect className="session-ring-track"[^>]*pathLength=\{100\}/);
  assert.match(app, /className="session-ring-fill"[^>]*pathLength=\{100\}/);
});

test("the pulse's mask is unique per session row", () => {
  // SVG ids are document-global; the session list renders many rings at
  // once, so the mask id must be derived from the session's id.
  assert.match(app, /session-ring-mask-\$\{id\}/);
  assert.match(app, /mask=\{`url\(#\$\{maskId\}\)`\}/);
});

test("the pulse renders only for a real percentage", () => {
  // An idle session's ring is a 0% fill: the mask and the pulse band
  // must both be gated off, or the band would loop an empty region.
  const gates = app.match(/model\.ring === "value" && pct > 0/g);
  assert.ok(gates && gates.length >= 2, "mask and pulse band are gated on value state with a positive fill");
});

// ---- The ring's placement over the icon ------------------------------------

test("the ring sits flush around the icon, not half-size in the top-left", () => {
  // The original bug: a plain `.session-ring` rule lost the fight to
  // `.session-icon`'s box sizing, and the ring rendered half-size in
  // the icon's top-left corner. The specific `.session-icon .session-ring`
  // rule (2 classes beats 1) owns the geometry: the 42px box (36px icon
  // + 3px stroke) offset by -3px, flush outside the icon's outline.
  assert.match(cssRules, /\.session-icon \.session-ring \{[^}]*position: absolute; left: -3px; top: -3px; width: 42px; height: 42px/);
});

// ---- The ring's colouring ----------------------------------------------------

test("the phone paints only the fill: the track is transparent", () => {
  assert.match(cssRules, /\.session-ring \.session-ring-track \{ stroke: transparent; \}/);
});

test("the fill is the icon's colour at half strength", () => {
  assert.match(cssRules, /\.session-ring \.session-ring-fill \{ stroke: currentColor; opacity: \.5; transition: stroke-dasharray \.25s ease; \}/);
});

// ---- The value-state pulse ---------------------------------------------------

test("the value pulse is a constant-speed band masked to the fill", () => {
  // The pulse must not depend on the percentage: the band runs the
  // indeterminate sweep's keyframes (a full 100-unit loop) at a fixed
  // duration, and only the MASK follows the fill. A keyframe that reads
  // a percentage var, or an animation whose duration scales with the
  // fill, restarts or stutters when the percentage ticks - the original
  // glitch this replaced.
  const comet = cssRules.match(/\.session-ring\.is-value \.session-ring-comet \{[^}]*\}/);
  assert.ok(comet, "the value-state band rule is missing");
  assert.match(comet[0], /stroke-dasharray: 12 88/);
  assert.match(comet[0], /animation: session-ring-sweep 1\.4s linear infinite/);
  // Half strength, the same as the fill: a gentle brightening, not a
  // bright comet.
  assert.match(comet[0], /opacity: \.5/);
  // The keyframes are the constant full loop, and nothing else may
  // animate the band.
  assert.match(cssRules, /@keyframes session-ring-sweep \{ from \{ stroke-dashoffset: 0; \} to \{ stroke-dashoffset: -100; \} \}/);
  assert.equal(cssRules.match(/session-ring-comet-sweep/g), null, "the percentage-driven keyframes must stay removed");
});

test("the pulse's mask copy tracks the fill", () => {
  // White = fully visible in the mask; transitioned exactly like the
  // fill, so the pulse region grows with the progress.
  assert.match(cssRules, /\.session-ring \.session-ring-mask-fill \{ fill: none; stroke: #fff; stroke-width: 3; transition: stroke-dasharray \.25s ease; \}/);
});

test("reduced motion drops the pulse, keeps the fill", () => {
  // The media block is a single line in this file; capture to end of
  // line (a naive `[^}]*` would stop at the first inner rule's brace).
  const block = cssRules.match(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\}/);
  assert.ok(block, "the reduced-motion block is missing");
  assert.match(block[0], /\.session-ring\.is-value \.session-ring-comet \{ display: none; \}/);
  assert.match(block[0], /\.session-ring\.is-pulse \.session-ring-fill \{ animation: none; \}/);
});