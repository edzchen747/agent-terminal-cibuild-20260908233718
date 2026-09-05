import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from "@agentterminal/protocol";

/**
 * The largest grid a client may announce lives in two places: here, on the
 * clients, and as SESSION_MAX_COLS/ROWS in the Rust host, which clamps every
 * resize to it.
 *
 * They have to agree. A client whose ceiling is HIGHER announces grids the
 * host silently rewrites, and a rewritten announcement is precisely the signal
 * a client reads as "another client owns this grid" - so the pane loses its
 * exact zoom rendering and drops into its fill path, which is the bug this
 * pairing was introduced to fix. A client whose ceiling is LOWER just leaves
 * usable cells on the table.
 *
 * Read out of core.rs rather than duplicated as a literal, so the assertion
 * cannot drift the way the constants can.
 */
const CORE_RS = fileURLToPath(new URL("../../../src-tauri/src/core.rs", import.meta.url));

function hostConstant(name: string): number {
  const source = readFileSync(CORE_RS, "utf8");
  const declared = source.match(new RegExp(`const ${name}: u16 = ([0-9_]+);`))?.[1];
  assert.ok(declared, `${name} is not declared in core.rs - was it renamed?`);
  return Number(declared.replaceAll("_", ""));
}

test("the client's column ceiling is the host's", () => {
  assert.equal(MAX_TERMINAL_COLS, hostConstant("SESSION_MAX_COLS"));
});

test("the client's row ceiling is the host's", () => {
  assert.equal(MAX_TERMINAL_ROWS, hostConstant("SESSION_MAX_ROWS"));
});

test("the ceiling clears a fully zoomed-out ultrawide pane", () => {
  // The case that raised these limits: a 3440x1440 window at the 25% zoom
  // stop asks for roughly 1460x460 (a ~3070px content box over a ~2.1px
  // cell). The ceiling has to sit above that, or the smallest stops stop
  // gaining columns - the original symptom.
  assert.ok(MAX_TERMINAL_COLS >= 1_460, `${MAX_TERMINAL_COLS} cols is under an ultrawide pane at 25%`);
  assert.ok(MAX_TERMINAL_ROWS >= 460, `${MAX_TERMINAL_ROWS} rows is under an ultrawide pane at 25%`);
});
