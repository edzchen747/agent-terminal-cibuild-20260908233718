import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectDragTransform, reorderBlock, shouldCommitProjectReorder, siblingShiftStep, type ProjectDragGeometry } from "./project-drag.ts";

const ROWS = ["alpha", "beta", "gamma", "delta", "echo"];
// Five rows at the sidebar's fixed 61px pitch.
const CENTERS = [100, 161, 222, 283, 344];

function drag(overrides: Partial<ProjectDragGeometry> = {}): ProjectDragGeometry {
  return { projectId: "alpha", startIndex: 0, targetIndex: 0, deltaY: 0, centers: CENTERS, ...overrides };
}

describe("reorder block", () => {
  it("moves an item down one slot, shifting the crossed item up", () => {
    assert.deepEqual(reorderBlock(ROWS, 0, 1), ["beta", "alpha", "gamma", "delta", "echo"]);
  });

  it("moves an item up one slot, shifting the crossed item down", () => {
    assert.deepEqual(reorderBlock(ROWS, 3, 2), ["alpha", "beta", "delta", "gamma", "echo"]);
  });

  it("moves an interior item to the top, settling in the target slot", () => {
    assert.deepEqual(reorderBlock(ROWS, 3, 0), ["delta", "alpha", "beta", "gamma", "echo"]);
  });

  it("moves an interior item to the bottom, settling in the target slot", () => {
    assert.deepEqual(reorderBlock(ROWS, 1, 4), ["alpha", "gamma", "delta", "echo", "beta"]);
  });

  it("moves the first item to the last slot and vice versa", () => {
    // The moved item settles in the target slot: removing it first shifts
    // the tail down, so the slot the item lands in is the target index, not
    // "before the item that was there".
    assert.deepEqual(reorderBlock(ROWS, 0, 4), ["beta", "gamma", "delta", "echo", "alpha"]);
    assert.deepEqual(reorderBlock(ROWS, 4, 0), ["echo", "alpha", "beta", "gamma", "delta"]);
  });

  it("leaves the order content-unchanged when the drop lands on the origin slot", () => {
    const next = reorderBlock(ROWS, 2, 2);
    assert.deepEqual(next, ROWS);
    assert.notEqual(next, ROWS);
  });

  it("never mutates the input list", () => {
    const input = [...ROWS];
    reorderBlock(input, 0, 4);
    assert.deepEqual(input, ROWS);
  });

  it("keeps every item exactly once for every origin and target slot", () => {
    for (let start = 0; start < ROWS.length; start++) {
      for (let target = 0; target < ROWS.length; target++) {
        const next = reorderBlock(ROWS, start, target);
        assert.deepEqual([...next].sort(), [...ROWS].sort(), `start=${start} target=${target}`);
      }
    }
  });

  it("handles a single-item list", () => {
    assert.deepEqual(reorderBlock(["solo"], 0, 0), ["solo"]);
  });

  it("handles an empty list", () => {
    assert.deepEqual(reorderBlock<string>([], 0, 0), []);
  });
});

describe("reorder commit guard", () => {
  // Spec: commit exactly when the release is a commit, the pointer crossed
  // the move threshold, and the drop slot differs from the origin. Every
  // combination of the three flags is asserted against that spec.
  it("matches the commit spec for every combination of flags", () => {
    for (const commit of [true, false]) {
      for (const didMove of [true, false]) {
        for (const [startIndex, targetIndex, differentSlot] of [[2, 2, false], [2, 4, true]] as const) {
          const expected = commit && didMove && differentSlot;
          assert.equal(
            shouldCommitProjectReorder({ commit, didMove, startIndex, targetIndex }),
            expected,
            `commit=${commit} didMove=${didMove} start=${startIndex} target=${targetIndex}`
          );
        }
      }
    }
  });

  it("never commits a cancelled drag, even when it moved far", () => {
    assert.equal(shouldCommitProjectReorder({ commit: false, didMove: true, startIndex: 0, targetIndex: 4 }), false);
  });

  it("never commits a press-and-release that never crossed the threshold", () => {
    assert.equal(shouldCommitProjectReorder({ commit: true, didMove: false, startIndex: 1, targetIndex: 1 }), false);
  });

  it("never commits a drop back onto the origin slot", () => {
    assert.equal(shouldCommitProjectReorder({ commit: true, didMove: true, startIndex: 3, targetIndex: 3 }), false);
  });
});

describe("sibling shift step", () => {
  // Uneven gaps so the full-pitch, half-pitch, and fallback paths all
  // produce different numbers: row centers at 100, 180, 220 (gaps 80/40).
  const UNEVEN = [100, 180, 220];

  it("uses the full neighbouring pitch at the first row", () => {
    assert.equal(siblingShiftStep(UNEVEN, 0), 80);
  });

  it("averages the two surrounding gaps for an interior origin", () => {
    assert.equal(siblingShiftStep(UNEVEN, 1), (180 - 100 + 220 - 180) / 2);
  });

  it("uses the full neighbouring pitch at the last row", () => {
    assert.equal(siblingShiftStep(UNEVEN, 2), 40);
  });

  it("treats a two-row list as two edges, not an interior", () => {
    assert.equal(siblingShiftStep([100, 161], 0), 61);
    assert.equal(siblingShiftStep([100, 161], 1), 61);
  });

  it("falls back to the fixed 61px row pitch when no neighbour exists", () => {
    assert.equal(siblingShiftStep([42], 0), 61);
    assert.equal(siblingShiftStep([], 0), 61);
  });

  it("ignores the direction of the gap so an odd centre order cannot invert the shift", () => {
    assert.equal(siblingShiftStep([220, 180, 100], 1), 60);
  });
});

describe("project drag row transforms", () => {
  it("moves no row when no drag is in flight", () => {
    assert.equal(projectDragTransform(null, "alpha", 0), undefined);
  });

  it("follows the pointer exactly on the dragged row, even past whole rows", () => {
    const d = drag({ deltaY: 122.5 });
    assert.equal(projectDragTransform(d, "alpha", 0), "translate3d(0,122.5px,0)");
  });

  it("moves only the dragged row when the pointer never crossed the threshold", () => {
    const d = drag();
    assert.equal(projectDragTransform(d, "alpha", 0), "translate3d(0,0px,0)");
    for (let index = 1; index < ROWS.length; index++) {
      assert.equal(projectDragTransform(d, ROWS[index]!, index), undefined, `index=${index}`);
    }
  });

  it("shifts the crossed rows up one row when dragging downward from the first row", () => {
    const d = drag({ startIndex: 0, targetIndex: 2, deltaY: 122 });
    assert.equal(projectDragTransform(d, "alpha", 0), "translate3d(0,122px,0)");
    assert.equal(projectDragTransform(d, "beta", 1), "translate3d(0,-61px,0)");
    assert.equal(projectDragTransform(d, "gamma", 2), "translate3d(0,-61px,0)");
    assert.equal(projectDragTransform(d, "delta", 3), undefined);
    assert.equal(projectDragTransform(d, "echo", 4), undefined);
  });

  it("shifts the crossed rows down one row when dragging upward to the last row", () => {
    const d = drag({ projectId: "echo", startIndex: 4, targetIndex: 2, deltaY: -122 });
    assert.equal(projectDragTransform(d, "echo", 4), "translate3d(0,-122px,0)");
    assert.equal(projectDragTransform(d, "beta", 1), undefined);
    assert.equal(projectDragTransform(d, "gamma", 2), "translate3d(0,61px,0)");
    assert.equal(projectDragTransform(d, "delta", 3), "translate3d(0,61px,0)");
    assert.equal(projectDragTransform(d, "alpha", 0), undefined);
  });

  it("shifts exactly the rows the drag crosses, never the origin row's neighbours", () => {
    // Interior origin: the rows above the origin that the drag does not
    // cross must stay put even though they sit next to the origin row.
    const d = drag({ projectId: "gamma", startIndex: 2, targetIndex: 4, deltaY: 122 });
    assert.equal(projectDragTransform(d, "alpha", 0), undefined);
    assert.equal(projectDragTransform(d, "beta", 1), undefined);
    assert.equal(projectDragTransform(d, "delta", 3), "translate3d(0,-61px,0)");
    assert.equal(projectDragTransform(d, "echo", 4), "translate3d(0,-61px,0)");
  });

  it("shifts a single row for a one-slot move at either direction", () => {
    const down = drag({ startIndex: 1, targetIndex: 2, deltaY: 61 });
    assert.equal(projectDragTransform(down, "gamma", 2), "translate3d(0,-61px,0)");
    assert.equal(projectDragTransform(down, "delta", 3), undefined);
    const up = drag({ projectId: "gamma", startIndex: 2, targetIndex: 1, deltaY: -61 });
    assert.equal(projectDragTransform(up, "beta", 1), "translate3d(0,61px,0)");
    assert.equal(projectDragTransform(up, "alpha", 0), undefined);
  });

  it("uses the row pitch around the origin, not a fixed step", () => {
    const centers = [100, 180, 220];
    const first = { projectId: "p0", startIndex: 0, targetIndex: 1, deltaY: 80, centers };
    assert.equal(projectDragTransform(first, "p1", 1), "translate3d(0,-80px,0)");
    const middle = { projectId: "p1", startIndex: 1, targetIndex: 2, deltaY: 40, centers };
    assert.equal(projectDragTransform(middle, "p2", 2), "translate3d(0,-60px,0)");
    const last = { projectId: "p2", startIndex: 2, targetIndex: 1, deltaY: -40, centers };
    assert.equal(projectDragTransform(last, "p1", 1), "translate3d(0,40px,0)");
  });

  it("identifies the dragged row by id, so a stale index cannot steal its transform", () => {
    // The render calls this with each row's current index; if the row's
    // index and the id disagreed, the id still wins and the row follows
    // the pointer instead of a sibling shift.
    const d = drag({ startIndex: 0, targetIndex: 1, deltaY: 30 });
    assert.equal(projectDragTransform(d, "alpha", 99), "translate3d(0,30px,0)");
  });
});