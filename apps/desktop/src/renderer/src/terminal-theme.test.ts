import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Drift guard: the desktop terminal must render the shared Windows Terminal
// "Campbell" palette (TERMINAL_ANSI_THEME in @agentterminal/protocol) instead
// of a per-client themed palette or xterm's built-in defaults. If any of
// these regress, the desktop terminal stops matching the native Windows
// terminal and the mobile companion.
const terminalPaneSource = readFileSync(
  fileURLToPath(new URL("./TerminalPane.tsx", import.meta.url)),
  "utf8"
);

const lower = terminalPaneSource.toLowerCase();

test("the desktop terminal spreads the shared ANSI theme into its xterm theme", () => {
  assert.match(lower, /terminal_ansi_theme/);
  assert.ok(lower.includes("...terminal_ansi_theme"), "expected the xterm theme to spread TERMINAL_ANSI_THEME");
});

test("the desktop terminal uses the Campbell background and foreground", () => {
  assert.ok(lower.includes('"#0c0c0c"'), "expected the Campbell background #0C0C0C");
  assert.ok(lower.includes('"#cccccc"'), "expected the Campbell foreground #CCCCCC");
});

test("the desktop terminal has no leftover themed palette colors", () => {
  // Washed-out pastel palette that previously made the desktop look lighter
  // than the native terminal.
  for (const hex of ["#7aa2f7", "#8bd49c", "#9ab7ff", "#f07178", "#a5e8b3", "#090b10", "#d9deea", "#89e6d1"]) {
    assert.ok(!lower.includes(hex), `${hex} must not reappear in the desktop terminal theme`);
  }
});

test("the desktop terminal does not hard-code xterm's built-in default colors", () => {
  // xterm 6's DEFAULT_ANSI_COLORS (Tango). These stay in the xterm library as
  // an internal fallback table, but must not be pinned into our theme: the
  // palette is pinned in @agentterminal/protocol so every client shares it.
  for (const hex of ["#2e3436", "#3465a4", "#eeeeec", "#4e9a06"]) {
    assert.ok(!lower.includes(hex), `${hex} must not be pinned into the desktop terminal theme`);
  }
});
