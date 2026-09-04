import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Drift guard: the desktop terminal must render whichever shared scheme the
// host holds (TERMINAL_SCHEMES in @agentterminal/protocol) rather than a
// palette of its own. If any of these regress, the desktop terminal stops
// matching the mobile companion viewing the same session.
const terminalPaneSource = readFileSync(
  fileURLToPath(new URL("./TerminalPane.tsx", import.meta.url)),
  "utf8"
);

const lower = terminalPaneSource.toLowerCase();

test("the desktop terminal builds its xterm theme from the shared scheme", () => {
  assert.match(lower, /xtermthemefor/);
  assert.ok(lower.includes("theme: xtermthemefor("), "expected the xterm theme to come from xtermThemeFor(scheme)");
});

test("the desktop terminal takes the scheme as a prop instead of choosing one", () => {
  assert.match(terminalPaneSource, /scheme: TerminalScheme/, "expected a scheme prop typed by the protocol");
  assert.match(lower, /terminal\.options\.theme = xtermthemefor\(scheme\)/, "expected a live repaint when the scheme changes");
});

test("the desktop terminal letterboxes in the scheme background, not a fixed black", () => {
  assert.match(terminalPaneSource, /"--terminal-bg": scheme\.background/);
});

test("the desktop terminal pins no palette colors of its own", () => {
  // Every color must arrive through the scheme, so no hex literal belongs in
  // this file at all - not the old Campbell surface it used to hard-code, not
  // a themed palette, and not xterm's built-in Tango defaults.
  const literals = terminalPaneSource.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(literals, [], `TerminalPane must not pin colors: found ${literals.join(", ")}`);
});
