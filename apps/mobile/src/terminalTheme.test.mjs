import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Drift guard: the mobile terminal must render the shared Windows Terminal
// "Campbell" palette (TERMINAL_ANSI_THEME in @agentterminal/protocol), the
// same one the desktop terminal pins, so the same session looks identical on
// phone and desktop.
const terminalSource = readFileSync(fileURLToPath(new URL("./MobileTerminal.tsx", import.meta.url)), "utf8");
const lower = terminalSource.toLowerCase();

test("the mobile terminal spreads the shared ANSI theme into its xterm theme", () => {
  assert.match(lower, /terminal_ansi_theme/);
  assert.ok(lower.includes("...terminal_ansi_theme"), "expected the xterm theme to spread TERMINAL_ANSI_THEME");
});

test("the mobile terminal uses the Campbell background and foreground", () => {
  assert.ok(lower.includes('"#0c0c0c"'), "expected the Campbell background #0C0C0C");
  assert.ok(lower.includes('"#cccccc"'), "expected the Campbell foreground #CCCCCC");
});

test("the mobile terminal has no leftover themed palette colors", () => {
  // The old mobile-only chrome colors and any xterm built-in defaults must
  // not come back: the palette is pinned in @agentterminal/protocol.
  for (const hex of ["#080b0f", "#d7dce6", "#79ddc7", "#2e3436", "#3465a4", "#eeeeec"]) {
    assert.ok(!lower.includes(hex), `${hex} must not reappear in the mobile terminal theme`);
  }
});
