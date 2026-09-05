import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shellSwitchSessionOrder, shellSwitchSplitGroups } from "./shell-switch.ts";
import type { SplitGroup } from "./split-tabs.ts";

const group = (id: string, sessionIds: [string, string], overrides: Partial<SplitGroup> = {}): SplitGroup => ({
  id,
  projectId: "p1",
  sessionIds,
  layout: "side-by-side",
  ratio: 0.5,
  ...overrides
});

describe("shellSwitchSessionOrder", () => {
  describe("kept tab (the outgoing tab has output)", () => {
    it("opens the new tab after the last one and leaves the old tab in place", () => {
      // The reported bug: switching the shell of the first tab with output
      // must not shift the kept tab one position to the right.
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "c"], "a", "n", true),
        ["a", "b", "c", "n"]
      );
    });

    it("keeps a middle tab in place", () => {
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "c"], "b", "n", true),
        ["a", "b", "c", "n"]
      );
    });

    it("opens the new tab after the old one when the old tab is last", () => {
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b"], "b", "n", true),
        ["a", "b", "n"]
      );
    });

    it("handles a single-tab project", () => {
      assert.deepEqual(shellSwitchSessionOrder(["a"], "a", "n", true), ["a", "n"]);
    });

    it("does not duplicate a tab the state sync already appended", () => {
      // The host's broadcast may have run the sessionOrder reconcile before
      // this updater: the replacement is already at the tail.
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "n"], "a", "n", true),
        ["a", "b", "n"]
      );
    });

    it("moves a stale pre-appended replacement to the true tail", () => {
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "n", "b"], "a", "n", true),
        ["a", "b", "n"]
      );
    });

    it("leaves tabs of other projects untouched", () => {
      assert.deepEqual(
        shellSwitchSessionOrder(["a1", "b1", "a2", "b2"], "a2", "n", true),
        ["a1", "b1", "a2", "b2", "n"]
      );
    });

    it("falls back to the tail when the old tab is unknown locally", () => {
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b"], "gone", "n", true),
        ["a", "b", "n"]
      );
    });

    it("turns an empty order into just the new tab", () => {
      assert.deepEqual(shellSwitchSessionOrder([], "a", "n", true), ["n"]);
    });

    it("is idempotent when applied to an order that already opened the new tab", () => {
      const once = shellSwitchSessionOrder(["a", "b"], "a", "n", true);
      assert.deepEqual(shellSwitchSessionOrder(once, "a", "n", true), once);
    });

    it("survives a malformed order with duplicated ids", () => {
      // A stale local order may momentarily repeat an id; the updater must
      // not duplicate the replacement or drop kept tabs.
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "b"], "b", "n", true),
        ["a", "b", "b", "n"]
      );
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "n", "b"], "b", "n", true),
        ["a", "b", "b", "n"],
        "a pre-appended replacement is moved to the tail without duplicating it"
      );
    });

    it("appends each replacement at the tail across consecutive switches", () => {
      // The user switches the shell of the same kept tab twice: every new
      // tab lands after the last one and the kept tab never moves.
      let order = ["a", "b"];
      order = shellSwitchSessionOrder(order, "a", "n1", true);
      order = shellSwitchSessionOrder(order, "a", "n2", true);
      assert.deepEqual(order, ["a", "b", "n1", "n2"]);
    });
  });

  describe("closed tab (the outgoing tab has no output yet)", () => {
    it("takes over the first slot in place", () => {
      assert.deepEqual(shellSwitchSessionOrder(["a", "b", "c"], "a", "n", false), ["n", "b", "c"]);
    });

    it("takes over the middle slot in place", () => {
      assert.deepEqual(shellSwitchSessionOrder(["a", "b", "c"], "b", "n", false), ["a", "n", "c"]);
    });

    it("takes over the last slot in place", () => {
      assert.deepEqual(shellSwitchSessionOrder(["a", "b", "c"], "c", "n", false), ["a", "b", "n"]);
    });

    it("falls back to the tail when the old tab is missing locally", () => {
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b"], "gone", "n", false),
        ["a", "b", "n"]
      );
    });

    it("dedupes a pre-appended replacement and places it in the old slot", () => {
      // The state sync already appended the replacement; the closed-tab
      // semantics still want it in the old tab's slot, not at the tail.
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "n"], "a", "n", false),
        ["n", "b"]
      );
    });

    it("is stable after the state sync removed the closed tab", () => {
      // Same switch, but the reconcile already dropped the closed id: the
      // replacement stays where the sync put it - no duplicate, no move.
      assert.deepEqual(
        shellSwitchSessionOrder(["b", "n"], "a", "n", false),
        ["b", "n"]
      );
    });

    it("rewrites every duplicated occurrence of the old id in a malformed order", () => {
      // If a stale local order repeats the outgoing id, no occurrence of it
      // may survive the switch: the replacement takes over instead.
      assert.deepEqual(
        shellSwitchSessionOrder(["a", "b", "a", "c"], "a", "n", false),
        ["n", "b", "n", "c"]
      );
    });

    it("moves the slot with each consecutive switch of the active tab", () => {
      // Blank tab switched twice in a row: each replacement takes the slot
      // of the tab it replaces, so the position of the active pane is
      // stable across switches.
      let order = ["a", "b", "c"];
      order = shellSwitchSessionOrder(order, "a", "n1", false);
      order = shellSwitchSessionOrder(order, "n1", "n2", false);
      assert.deepEqual(order, ["n2", "b", "c"]);
    });
  });
});

describe("shellSwitchSplitGroups", () => {
  it("returns the groups unchanged when there are no groups", () => {
    assert.deepEqual(shellSwitchSplitGroups([], "a", "n", false), []);
  });

  it("returns the groups unchanged when the outgoing tab is not split", () => {
    const groups = [group("g1", ["a", "b"])];
    assert.equal(shellSwitchSplitGroups(groups, "c", "n", true), groups);
    assert.equal(shellSwitchSplitGroups(groups, "c", "n", false), groups, "same reference when nothing applies");
  });

  it("keeps the split intact when the old pane keeps its history", () => {
    // The kept pane remains part of the split; the new tab opens standalone
    // after the last one, so no group may reference the replacement.
    const groups = [group("g1", ["a", "b"]), group("g2", ["c", "d"])];
    const next = shellSwitchSplitGroups(groups, "a", "n", true);
    assert.deepEqual(next.map((item) => item.sessionIds), [["a", "b"], ["c", "d"]]);
    assert.ok(next.every((item) => !item.sessionIds.includes("n")));
  });

  it("swaps the replacement into the first pane of the split when the old pane is closed", () => {
    const next = shellSwitchSplitGroups([group("g1", ["a", "b"])], "a", "n", false);
    assert.deepEqual(next.map((item) => item.sessionIds), [["n", "b"]]);
  });

  it("swaps the replacement into the second pane of the split", () => {
    const next = shellSwitchSplitGroups([group("g1", ["a", "b"])], "b", "n", false);
    assert.deepEqual(next.map((item) => item.sessionIds), [["a", "n"]]);
  });

  it("preserves the group identity, layout and ratio of the rewritten split", () => {
    const [rewritten] = shellSwitchSplitGroups([group("g1", ["a", "b"], { layout: "stacked", ratio: 0.62 })], "a", "n", false);
    assert.ok(rewritten, "the split is rewritten in place");
    assert.equal(rewritten.id, "g1");
    assert.equal(rewritten.layout, "stacked");
    assert.equal(rewritten.ratio, 0.62);
  });

  it("keeps every other group untouched", () => {
    const next = shellSwitchSplitGroups([group("g1", ["a", "b"]), group("g2", ["c", "d"])], "c", "n", false);
    assert.deepEqual(next.map((item) => item.sessionIds), [["a", "b"], ["n", "d"]]);
    assert.deepEqual(next.map((item) => item.id), ["g1", "g2"], "the rewritten group is placed after the untouched groups");
  });

  it("re-joining a switch that was already applied is a no-op", () => {
    // selectShell is guarded against double runs, but the updater must stay
    // safe if it is: the replacement already sits in the pane, so the
    // second application leaves the groups exactly where the first put them.
    const once = shellSwitchSplitGroups([group("g1", ["a", "b"])], "a", "n", false);
    const twice = shellSwitchSplitGroups(once, "n", "n", false);
    assert.deepEqual(twice.map((item) => item.sessionIds), [["n", "b"]]);
  });

  it("leaves the groups alone when the outgoing tab no longer belongs to any group", () => {
    // The outgoing tab was already closed and its pane rewritten by an
    // earlier updater run: nothing still references it, so the caller's
    // array is returned untouched.
    const groups = [group("g1", ["n", "b"])];
    const next = shellSwitchSplitGroups(groups, "a", "m", false);
    assert.equal(next, groups);
  });
});

describe("tab order and split groups together", () => {
  it("kept switch: the split keeps the old pane and the new tab lands after the last one", () => {
    const order = ["a", "b", "c"];
    const groups = [group("g1", ["a", "c"])];
    const nextOrder = shellSwitchSessionOrder(order, "a", "n", true);
    const nextGroups = shellSwitchSplitGroups(groups, "a", "n", true);
    assert.deepEqual(nextOrder, ["a", "b", "c", "n"]);
    assert.deepEqual(nextGroups.map((item) => item.sessionIds), [["a", "c"]], "the old pane stays in the split");
  });

  it("closed switch: the new tab takes the old slot and joins the split in place", () => {
    const order = ["a", "b", "c"];
    const groups = [group("g1", ["a", "c"])];
    assert.deepEqual(shellSwitchSessionOrder(order, "a", "n", false), ["n", "b", "c"]);
    assert.deepEqual(
      shellSwitchSplitGroups(groups, "a", "n", false).map((item) => item.sessionIds),
      [["n", "c"]]
    );
  });
});
