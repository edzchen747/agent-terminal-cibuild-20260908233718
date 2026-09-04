import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gridWithinPane } from "./terminal-geometry.ts";

const cell = { width: 8.05, height: 16.1026 };

describe("gridWithinPane", () => {
  it("drops the row the pane's padding bought (half-screen snap)", () => {
    // Measured: stack 1067.12 tall, 14px of vertical pane padding, so the
    // addon proposed 66 rows for a content box that holds 65.
    const grid = gridWithinPane({ cols: 129, rows: 66 }, { width: 1050, height: 1067.12 - 14 }, cell);
    assert.equal(grid.rows, 65);
  });

  it("keeps a proposal that already fits the content box", () => {
    const grid = gridWithinPane({ cols: 113, rows: 38 }, { width: 922, height: 623.51 }, cell);
    assert.deepEqual(grid, { cols: 113, rows: 38 });
  });

  it("narrows the column count the same way", () => {
    const grid = gridWithinPane({ cols: 116, rows: 38 }, { width: 922, height: 623.51 }, cell);
    assert.equal(grid.cols, 114);
  });

  it("never widens a proposal the addon made smaller", () => {
    const grid = gridWithinPane({ cols: 60, rows: 20 }, { width: 922, height: 623.51 }, cell);
    assert.deepEqual(grid, { cols: 60, rows: 20 });
  });

  it("keeps the proposal when the cell size is not measurable yet", () => {
    assert.deepEqual(gridWithinPane({ cols: 80, rows: 24 }, { width: 922, height: 623.51 }, null), { cols: 80, rows: 24 });
    assert.deepEqual(gridWithinPane({ cols: 80, rows: 24 }, { width: 922, height: 623.51 }, { width: 0, height: 0 }), { cols: 80, rows: 24 });
  });

  it("keeps a row whose fit is exact but lands under it in floating point", () => {
    const exact = { width: 8, height: 16.1026 };
    const grid = gridWithinPane({ cols: 100, rows: 65 }, { width: 800, height: 65 * exact.height }, exact);
    assert.deepEqual(grid, { cols: 100, rows: 65 });
  });

  it("keeps the proposal when the pane has not been measured yet", () => {
    // A pane the layout has not sized reports 0; computed padding on a
    // detached element parses to NaN. Neither is grounds for clamping.
    assert.deepEqual(gridWithinPane({ cols: 80, rows: 24 }, { width: 0, height: 623.51 }, cell), { cols: 80, rows: 24 });
    assert.deepEqual(gridWithinPane({ cols: 80, rows: 24 }, { width: Number.NaN, height: Number.NaN }, cell), { cols: 80, rows: 24 });
    assert.deepEqual(gridWithinPane({ cols: 80, rows: 24 }, { width: 922, height: 623.51 }, { width: Number.NaN, height: 16 }), { cols: 80, rows: 24 });
  });

  it("keeps the proposal when a measurement is negative", () => {
    assert.deepEqual(gridWithinPane({ cols: 80, rows: 24 }, { width: 922, height: -14 }, cell), { cols: 80, rows: 24 });
  });

  it("floors a pane too small for the minimum grid", () => {
    const grid = gridWithinPane({ cols: 80, rows: 24 }, { width: 9, height: 12 }, cell);
    assert.deepEqual(grid, { cols: 2, rows: 1 });
  });
});
