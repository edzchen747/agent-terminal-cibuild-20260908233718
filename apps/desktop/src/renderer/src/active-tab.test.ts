import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneRememberedActiveSessions, rememberProjectActiveSession, resolveProjectActiveSession, type ResolveProjectActiveSessionInput } from "./active-tab.ts";

const remembered = (entries: Array<[string, string]>) => {
  const map = new Map<string, string>();
  for (const [projectId, sessionId] of entries) rememberProjectActiveSession(map, projectId, sessionId);
  return map;
};

const resolve = (overrides: Partial<ResolveProjectActiveSessionInput> = {}) =>
  resolveProjectActiveSession({
    projectId: "p1",
    activeSessionId: null,
    projectSessionIds: ["s1", "s2", "s3"],
    rememberedByProject: new Map<string, string>(),
    ...overrides
  });

describe("resolving the active tab for a project", () => {
  it("keeps the current selection when it belongs to the shown project", () => {
    assert.equal(resolve({ activeSessionId: "s2" }), "s2");
  });

  it("restores the remembered tab when the selection belongs to another project", () => {
    assert.equal(
      resolve({ activeSessionId: "z9", rememberedByProject: remembered([["p1", "s2"]]) }),
      "s2",
    );
  });

  it("prefers the remembered tab over the last tab", () => {
    assert.equal(resolve({ rememberedByProject: remembered([["p1", "s1"]]) }), "s1");
  });

  it("falls back to the last tab when nothing is remembered", () => {
    assert.equal(resolve(), "s3");
  });

  it("falls back to the last tab when the remembered tab no longer exists", () => {
    assert.equal(resolve({ rememberedByProject: remembered([["p1", "s-closed"]]) }), "s3");
  });

  it("ignores a memory that belongs to another project", () => {
    assert.equal(
      resolve({ rememberedByProject: remembered([["p2", "s2"]]) }),
      "s3",
      "p2's remembered tab is not offered for p1"
    );
  });

  it("returns null when the project has no sessions", () => {
    assert.equal(resolve({ projectSessionIds: [], rememberedByProject: remembered([["p1", "s1"]]) }), null);
  });

  it("treats an empty selection as stale and restores the remembered tab", () => {
    assert.equal(resolve({ activeSessionId: null, rememberedByProject: remembered([["p1", "s2"]]) }), "s2");
  });
});

describe("switching between projects", () => {
  it("restores each project's last selected tab on a round trip", () => {
    const map = new Map<string, string>();
    // The user looks at s2 in p1 and at s7 in p2.
    let shown = resolve({ projectId: "p1", activeSessionId: null, projectSessionIds: ["s1", "s2", "s3"], rememberedByProject: map });
    assert.equal(shown, "s3");
    shown = "s2";
    rememberProjectActiveSession(map, "p1", shown);
    shown = resolve({ projectId: "p2", activeSessionId: "s2", projectSessionIds: ["s5", "s6", "s7"], rememberedByProject: map });
    assert.equal(shown, "s7", "first visit to p2 falls back to the last tab");
    shown = "s5";
    rememberProjectActiveSession(map, "p2", shown);
    // Back to p1: the tab the user last looked at there comes back.
    shown = resolve({ projectId: "p1", activeSessionId: "s5", projectSessionIds: ["s1", "s2", "s3"], rememberedByProject: map });
    assert.equal(shown, "s2");
    // And back to p2 again.
    shown = resolve({ projectId: "p2", activeSessionId: "s2", projectSessionIds: ["s5", "s6", "s7"], rememberedByProject: map });
    assert.equal(shown, "s5");
  });

  it("falls back to the last remaining tab when the remembered tab was closed", () => {
    const map = new Map<string, string>();
    let shown = resolve({ projectId: "p1", activeSessionId: "s2", projectSessionIds: ["s1", "s2", "s3"], rememberedByProject: map });
    assert.equal(shown, "s2");
    rememberProjectActiveSession(map, "p1", shown);
    // s2 exits and leaves the tab list, so its memory is stale: the
    // window falls back to the last remaining tab.
    shown = resolve({ projectId: "p1", activeSessionId: "s2", projectSessionIds: ["s1", "s3"], rememberedByProject: map });
    assert.equal(shown, "s3");
  });

  it("restores every project's tab across a three-project round trip", () => {
    const map = new Map<string, string>();
    const projects = [
      { projectId: "p1", ids: ["a1", "a2", "a3"], pick: "a1" },
      { projectId: "p2", ids: ["b1", "b2"], pick: "b1" },
      { projectId: "p3", ids: ["c1", "c2", "c3", "c4"], pick: "c1" },
    ];
    // First pass: the user picks a non-last tab in each project.
    for (const project of projects) rememberProjectActiveSession(map, project.projectId, project.pick);
    // Second pass: the stale selection must restore each project's pick,
    // never the last tab.
    let shown: string | null;
    for (const project of projects) {
      shown = resolve({ projectId: project.projectId, activeSessionId: "stale", projectSessionIds: project.ids, rememberedByProject: map });
      assert.equal(shown, project.pick, `${project.projectId} restores its picked tab`);
    }
  });
});

describe("edge cases", () => {
  it("treats a single-session project as both remembered and last tab", () => {
    const map = new Map<string, string>();
    assert.equal(resolve({ projectId: "p1", projectSessionIds: ["only"], rememberedByProject: map }), "only");
    // Leave and come back: the memory still points at the only tab.
    rememberProjectActiveSession(map, "p1", "only");
    assert.equal(resolve({ projectId: "p2", activeSessionId: "only", projectSessionIds: ["x1", "x2"], rememberedByProject: map }), "x2");
    assert.equal(resolve({ projectId: "p1", activeSessionId: "x2", projectSessionIds: ["only"], rememberedByProject: map }), "only");
  });

  it("keeps the current selection even when a different project's memory holds the same id", () => {
    // p2's memory happens to hold the same id as p1's current tab; p1
    // must keep showing its own current selection, untouched by p2.
    assert.equal(
      resolve({ activeSessionId: "s2", rememberedByProject: remembered([["p2", "s2"]]) }),
      "s2",
    );
  });

  it("lets a valid current selection win over a stale memory of the same project", () => {
    // The memory is stale (s9 no longer exists); the current selection s2
    // belongs to p1, so it is kept and the stale memory is not offered.
    assert.equal(
      resolve({ activeSessionId: "s2", rememberedByProject: remembered([["p1", "s9"], ["p2", "z9"]]) }),
      "s2",
    );
  });

  it("falls back to the last tab when both the selection and the memory are stale", () => {
    assert.equal(
      resolve({ activeSessionId: "gone-1", rememberedByProject: remembered([["p1", "gone-2"]]) }),
      "s3",
    );
  });

  it("returns null with a stale selection when the shown project has no sessions", () => {
    assert.equal(
      resolve({ activeSessionId: "z9", projectSessionIds: [], rememberedByProject: remembered([["p1", "s1"]]) }),
      null,
    );
  });

  it("falls back to the last tab when the memory map has no entry for the project at all", () => {
    assert.equal(
      resolve({ rememberedByProject: remembered([["p9", "s1"]]) }),
      "s3",
      "p9's entry does not help p1"
    );
  });

  it("returns the last tab unchanged when the remembered tab is the last tab", () => {
    assert.equal(resolve({ rememberedByProject: remembered([["p1", "s3"]]) }), "s3");
  });

  it("survives duplicate session ids in the tab list", () => {
    // A malformed tab list with a duplicated id still resolves: the
    // remembered id matches, so it is returned.
    assert.equal(
      resolve({ projectSessionIds: ["s1", "s2", "s2", "s3"], rememberedByProject: remembered([["p1", "s2"]]) }),
      "s2",
    );
  });

  describe("pruning memories", () => {
    it("accepts any iterable of project ids, not just arrays", () => {
      const fromSet = remembered([["p1", "s1"], ["p2", "s7"]]);
      pruneRememberedActiveSessions(fromSet, new Set(["p1"]));
      assert.deepEqual([...fromSet.entries()], [["p1", "s1"]]);

      const fromGenerator = remembered([["p1", "s1"], ["p2", "s7"], ["p3", "s8"]]);
      pruneRememberedActiveSessions(fromGenerator, (function*() { yield "p3"; })());
      assert.deepEqual([...fromGenerator.entries()], [["p3", "s8"]]);
    });

    it("is idempotent: pruning the same set twice changes nothing", () => {
      const map = remembered([["p1", "s1"], ["p2", "s7"]]);
      pruneRememberedActiveSessions(map, ["p1"]);
      const afterFirst = [...map.entries()];
      pruneRememberedActiveSessions(map, ["p1"]);
      assert.deepEqual([...map.entries()], afterFirst);
    });

    it("forgets a deleted project, so its return starts fresh at the last tab", () => {
      const map = remembered([["p1", "s2"], ["p2", "s5"]]);
      pruneRememberedActiveSessions(map, ["p1"]);
      // p2 was deleted; when it comes back with a fresh session list,
      // no memory is restored and the window shows the last tab.
      assert.equal(
        resolve({ projectId: "p2", activeSessionId: "s2", projectSessionIds: ["n1", "n2"], rememberedByProject: map }),
        "n2",
      );
    });
  });
});

describe("remembered tab memories", () => {
  it("overwrites the memory with the newest selection", () => {
    const map = new Map<string, string>();
    rememberProjectActiveSession(map, "p1", "s1");
    rememberProjectActiveSession(map, "p1", "s2");
    assert.equal(map.get("p1"), "s2");
  });

  it("keeps one memory per project", () => {
    const map = remembered([["p1", "s1"], ["p2", "s7"]]);
    assert.deepEqual([...map.entries()], [["p1", "s1"], ["p2", "s7"]]);
  });

  it("prunes memories for projects that no longer exist", () => {
    const map = remembered([["p1", "s1"], ["p2", "s7"]]);
    pruneRememberedActiveSessions(map, ["p1", "p3"]);
    assert.deepEqual([...map.entries()], [["p1", "s1"]]);
  });

  it("empties the memory when every project is gone", () => {
    const map = remembered([["p1", "s1"]]);
    pruneRememberedActiveSessions(map, []);
    assert.equal(map.size, 0);
  });
});
