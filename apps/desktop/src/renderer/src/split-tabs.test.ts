import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSplitEdgeHintVisible, moveSessionBlock, normalizeSplitOrder, pairSessionsInOrder, reconcileSplitGroups, replaceSessionInOrder, type SplitEdgeHintState, type SplitGroup } from "./split-tabs.ts";

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

describe("split edge drop hint", () => {
  const base: SplitEdgeHintState = {
    dragging: { sessionId: "b", didMove: true },
    activeSessionId: "a",
    allowEdgeDrop: true,
    groups: [],
    dropSide: null
  };
  const split = (first: string, second: string, id = "split-1"): SplitGroup => ({ id, projectId: "project-1", sessionIds: [first, second], layout: "side-by-side", ratio: 0.5 });

  it("is hidden until the pointer crosses the drag threshold", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, dragging: { sessionId: "b", didMove: false } }), false);
    assert.equal(isSplitEdgeHintVisible(base), true);
  });

  it("is hidden when no tab press is in flight", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, dragging: null }), false);
  });

  it("is hidden when edge drop is disabled", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, allowEdgeDrop: false }), false);
  });

  it("is hidden when there is no active session", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, activeSessionId: null }), false);
  });

  it("is hidden when the active session is the one being dragged", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, dragging: { sessionId: "a", didMove: true } }), false);
  });

  it("is hidden when the active session is already in a split group", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, groups: [split("a", "c")] }), false);
  });

  it("is hidden when the dragged session is already in a split group", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, groups: [split("b", "c")] }), false);
  });

  it("is hidden while the pointer is inside an edge drop zone", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, dropSide: "left" }), false);
    assert.equal(isSplitEdgeHintVisible({ ...base, dropSide: "right" }), false);
  });

  it("is visible again once the pointer leaves the drop zone", () => {
    assert.equal(isSplitEdgeHintVisible({ ...base, dropSide: "left" }), false);
    assert.equal(isSplitEdgeHintVisible({ ...base, dropSide: null }), true);
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
