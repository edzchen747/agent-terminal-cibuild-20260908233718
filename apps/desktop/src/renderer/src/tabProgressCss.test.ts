import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the tab progress bar's theme-aware track. The
// original bug: the track was mixed toward BLACK, and in the light
// theme the tab's text (and therefore the fill) is dark, so the bar
// read as an invisible dark grey strip on unselected tabs. The track
// now mixes toward the tab's own surface, so both themes show a faint
// track the fill stands out against. The bar's logic (what a tab
// draws) is covered by session-taskbar.test.ts.

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("the track is mixed toward the tab's surface, never toward black", () => {
  const track = css.match(/\.tab-progress \{[^}]*\}/);
  assert.ok(track, "the .tab-progress rule is missing");
  assert.match(
    track[0],
    /background: color-mix\(in srgb, currentColor 30%, var\(--surface-raised\)\);/,
    "the track must mix toward the tab's raised surface (theme-aware)"
  );
  assert.doesNotMatch(
    track[0],
    /color-mix\(in srgb, currentColor 30%, black\)/,
    "a black-mixed track is the dark-strip bug in the light theme"
  );
});

test("the fill is the tab's own text colour and tracks the percentage", () => {
  const fill = css.match(/\.tab-progress::before \{[^}]*\}/);
  assert.ok(fill, "the .tab-progress::before rule is missing");
  assert.match(fill[0], /background: currentColor/);
  assert.match(fill[0], /width: var\(--tab-fill, 100%\)/);
  assert.match(fill[0], /transition: width \.25s ease/);
});

test("an unmeasured command sweeps a 35% band across the track", () => {
  assert.match(css, /\.tab-progress\.is-pulse::before \{[^}]*width: 35%;[^}]*animation: tab-progress-sweep 1\.4s linear infinite;[^}]*\}/);
  assert.match(css, /@keyframes tab-progress-sweep \{ from \{ left: -35%; \} to \{ left: 100%; \} \}/);
});

test("reduced motion stills the sweep and the running dot", () => {
  const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g);
  const block = (blocks ?? []).find((rule) => rule.includes(".tab-progress.is-pulse::before"));
  assert.ok(block, "the reduced-motion block for the bar is missing");
  assert.match(block!, /\.tab-progress\.is-pulse::before \{ animation: none; left: 0; \}/);
  assert.match(block!, /\.tab-status-dot\.is-running \{ animation: none; \}/);
});