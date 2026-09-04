import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Drift guard: the mobile terminal must render whichever shared scheme the
// host holds (TERMINAL_SCHEMES in @agentterminal/protocol), the same one the
// desktop terminal resolves, so the same session looks identical on phone and
// desktop.
const terminalSource = readFileSync(fileURLToPath(new URL("./MobileTerminal.tsx", import.meta.url)), "utf8");
const lower = terminalSource.toLowerCase();

test("the mobile terminal builds its xterm theme from the shared scheme", () => {
  assert.match(lower, /xtermthemefor/);
  assert.ok(lower.includes("theme: xtermthemefor("), "expected the xterm theme to come from xtermThemeFor(scheme)");
});

test("the mobile terminal takes the scheme as a prop instead of choosing one", () => {
  assert.match(terminalSource, /scheme: TerminalScheme/, "expected a scheme prop typed by the protocol");
  assert.match(lower, /terminal\.options\.theme = xtermthemefor\(scheme\)/, "expected a live repaint when the scheme changes");
});

test("the mobile terminal letterboxes in the scheme background, not a fixed black", () => {
  assert.match(terminalSource, /"--terminal-bg": scheme\.background/);
});

test("the mobile terminal pins no palette colors of its own", () => {
  // Every color must arrive through the scheme, so no hex literal belongs in
  // this file at all - not the old Campbell surface it used to hard-code, not
  // the mobile-only chrome colors, and not xterm's built-in Tango defaults.
  const literals = terminalSource.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(literals, [], `MobileTerminal must not pin colors: found ${literals.join(", ")}`);
});
