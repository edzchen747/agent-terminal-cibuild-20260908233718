import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project, TerminalSession } from "@agentterminal/protocol";
import { departedProjects, projectListEntries, type LeavingProject } from "./project-leave.ts";

function project(id: string): Project {
  return { id, name: id, path: `C:/work/${id}`, persistent: true };
}

function session(id: string, projectId: string, status: "running" | "exited" = "running"): TerminalSession {
  return { id, projectId, title: id, cwd: "C:/", shellId: "powershell", status, createdAt: "2026-01-01T00:00:00Z" };
}

function leaving(projectId: string, index: number, count = 0): LeavingProject {
  return { project: project(projectId), index, count };
}

describe("departed projects", () => {
  it("reports the removed project pinned to the index it held", () => {
    const previous = [project("a"), project("b"), project("c")];
    const current = [project("a"), project("c")];
    const leavings = departedProjects(previous, current, []);
    assert.equal(leavings.length, 1);
    assert.equal(leavings[0]?.project.id, "b");
    assert.equal(leavings[0]?.index, 1);
  });

  it("reports several removals, each with its old index", () => {
    const previous = [project("a"), project("b"), project("c"), project("d")];
    const current = [project("b")];
    const leavings = departedProjects(previous, current, []);
    assert.deepEqual(leavings.map((entry) => [entry.project.id, entry.index]), [["a", 0], ["c", 2], ["d", 3]]);
  });

  it("reports nothing when only the order changed", () => {
    const previous = [project("a"), project("b")];
    const current = [project("b"), project("a")];
    assert.equal(departedProjects(previous, current, []).length, 0);
  });

  it("captures the running-session count the card showed when it left", () => {
    const previous = [project("a"), project("b")];
    const sessions = [session("s1", "b"), session("s2", "b"), session("s3", "b", "exited")];
    const leavings = departedProjects(previous, [project("a")], sessions);
    assert.equal(leavings.length, 1);
    assert.equal(leavings[0]?.count, 2);
  });

  it("reports nothing when a project is added", () => {
    const previous = [project("a")];
    const current = [project("a"), project("b")];
    assert.equal(departedProjects(previous, current, []).length, 0);
  });

  it("reports nothing when the previous list is empty", () => {
    assert.equal(departedProjects([], [project("a")], []).length, 0);
  });

  it("reports nothing when nothing left, even with different array references", () => {
    const previous = [project("a"), project("b")];
    const current = [project("a"), project("b")];
    assert.equal(departedProjects(previous, current, []).length, 0);
    assert.equal(departedProjects(previous, previous, []).length, 0);
  });

  it("reports every project when the list was emptied", () => {
    const previous = [project("a"), project("b"), project("c")];
    const leavings = departedProjects(previous, [], []);
    assert.deepEqual(leavings.map((entry) => [entry.project.id, entry.index]), [["a", 0], ["b", 1], ["c", 2]]);
  });

  it("does not count sessions of other projects toward the leaving count", () => {
    const previous = [project("a"), project("b")];
    const sessions = [session("s1", "a"), session("s2", "a"), session("s3", "b"), session("s4", "c")];
    const leavings = departedProjects(previous, [project("b")], sessions);
    assert.equal(leavings.length, 1);
    assert.equal(leavings[0]?.count, 2);
  });

  it("captures zero when the leaving project had no running sessions", () => {
    const previous = [project("a"), project("b")];
    const leavings = departedProjects(previous, [project("a")], [session("s1", "a", "exited")]);
    assert.equal(leavings[0]?.count, 0);
  });
});

describe("project list entries", () => {
  it("lists live projects in order with no ghosts", () => {
    const entries = projectListEntries([project("a"), project("b")], []);
    assert.deepEqual(entries, [
      { kind: "live", project: project("a"), index: 0 },
      { kind: "live", project: project("b"), index: 1 }
    ]);
  });

  it("splices a ghost into the slot the project used to hold", () => {
    // "b" left between "a" and "c": the ghost renders in the middle while
    // the live cards fill the remaining slots.
    const entries = projectListEntries([project("a"), project("c")], [leaving("b", 1)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? `ghost:${entry.entry.project.id}` : `live:${entry.project.id}:${entry.index}`),
      ["live:a:0", "ghost:b", "live:c:1"]);
  });

  it("keeps live indices pointing at the live list, not the render position", () => {
    const entries = projectListEntries([project("a"), project("c")], [leaving("b", 0)]);
    const live = entries.filter((entry) => entry.kind === "live") as Extract<(typeof entries)[number], { kind: "live" }>[];
    assert.deepEqual(live.map((entry) => [entry.project.id, entry.index]), [["a", 0], ["c", 1]]);
  });

  it("seats several ghosts in their old slots at once", () => {
    const entries = projectListEntries([project("b")], [leaving("a", 0), leaving("c", 2)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? `ghost:${entry.entry.project.id}` : `live:${entry.project.id}`),
      ["ghost:a", "live:b", "ghost:c"]);
  });

  it("seats a ghost in the last slot", () => {
    const entries = projectListEntries([project("a"), project("b")], [leaving("c", 2)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? "ghost" : `live:${entry.project.id}`),
      ["live:a", "live:b", "ghost"]);
  });

  it("ignores a ghost whose project is back in the list", () => {
    const entries = projectListEntries([project("a"), project("b")], [leaving("b", 1)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? "ghost" : `live:${entry.project.id}`),
      ["live:a", "live:b"]);
  });

  it("renders nothing when there are no live projects and no ghosts", () => {
    assert.deepEqual(projectListEntries([], []), []);
  });

  it("renders ghosts alone when every project left", () => {
    const entries = projectListEntries([], [leaving("a", 0), leaving("b", 1), leaving("c", 2)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? `ghost:${entry.entry.project.id}` : "live"),
      ["ghost:a", "ghost:b", "ghost:c"]);
  });

  it("seats ghosts against a list that also gained a project", () => {
    // "a" and "b" left and a new project "x" joined: the ghosts still hold
    // their old slots, and the live cards keep their live-list indices.
    const entries = projectListEntries([project("x"), project("c")], [leaving("a", 0), leaving("b", 1)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? `ghost:${entry.entry.project.id}` : `live:${entry.project.id}:${entry.index}`),
      ["ghost:a", "ghost:b", "live:x:0", "live:c:1"]);
  });

  it("seats a ghost into the first slot of a longer list", () => {
    const entries = projectListEntries([project("b"), project("c"), project("d")], [leaving("a", 0)]);
    assert.deepEqual(entries.map((entry) => entry.kind === "leaving" ? "ghost:a" : `live:${entry.project.id}:${entry.index}`),
      ["ghost:a", "live:b:0", "live:c:1", "live:d:2"]);
  });

  it("drops a stale ghost pinned beyond the live list instead of rendering a blank row", () => {
    const entries = projectListEntries([project("a")], [leaving("z", 9)]);
    assert.deepEqual(entries, [{ kind: "live", project: project("a"), index: 0 }]);
  });

  it("drops a negative ghost index the same way", () => {
    const entries = projectListEntries([project("a")], [leaving("z", -1)]);
    assert.deepEqual(entries, [{ kind: "live", project: project("a"), index: 0 }]);
  });
});