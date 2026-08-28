import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moveSessionBlock, normalizeSplitOrder, pairSessionsInOrder, reconcileSplitGroups, replaceSessionInOrder, type SplitGroup } from "./split-tabs.ts";

const split = (first: string, second: string, id = "split-1"): SplitGroup => ({
  id,
  projectId: "project-1",
  sessionIds: [first, second],
  layout: "side-by-side",
  ratio: 0.5
});

describe("split tab ordering", () => {
  it("places a new pair at the anchor tab while preserving visual order", () => {
    assert.deepEqual(pairSessionsInOrder(["a", "b", "c", "d"], "c", "b", "c"), ["a", "b", "c", "d"]);
    assert.deepEqual(pairSessionsInOrder(["a", "b", "c", "d"], "b", "c", "b"), ["a", "c", "b", "d"]);
  });

  it("normalizes persisted split tabs back into contiguous pairs", () => {
    assert.deepEqual(normalizeSplitOrder(["a", "c", "b", "d"], [split("a", "b")]), ["a", "b", "c", "d"]);
  });

  it("moves a pair as one tab-strip unit", () => {
    assert.deepEqual(moveSessionBlock(["a", "b", "c", "d"], "a", "d", [split("a", "b")]), ["c", "d", "a", "b"]);
    assert.deepEqual(moveSessionBlock(["a", "b", "c", "d"], "d", "a", [split("a", "b")]), ["d", "a", "b", "c"]);
  });

  it("swaps a replacement tab into the pair position", () => {
    assert.deepEqual(replaceSessionInOrder(["a", "b", "c"], "b", "c"), ["a", "c", "b"]);
  });
});

describe("split tab reconciliation", () => {
  it("drops invalid, cross-project, and duplicate groups", () => {
    const groups = [split("a", "b"), split("a", "c", "duplicate"), split("c", "d", "cross")];
    const sessions = [
      { id: "a", projectId: "project-1" },
      { id: "b", projectId: "project-1" },
      { id: "c", projectId: "project-1" },
      { id: "d", projectId: "project-2" }
    ];
    assert.deepEqual(reconcileSplitGroups(groups, sessions).map((group) => group.id), ["split-1"]);
  });
});
