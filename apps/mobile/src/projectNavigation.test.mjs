import assert from "node:assert/strict";
import test from "node:test";
import { backProjectId, resolveViewGeometry } from "./projectNavigation.ts";

const project = (id) => ({ id, name: id, path: `C:\\Work\\${id}`, persistent: true, created_at: null });

const session = (id, projectId) => ({
  id,
  projectId,
  title: "PowerShell",
  cwd: `C:\\Work\\${projectId}`,
  shellId: "powershell",
  status: "running",
  created_at: "now",
  exit_code: null
});

const snapshot = (projects, sessions) => ({ projects, sessions });

const geometry = (snapshotValue, viewType, requestedProjectId, requestedSessionId) =>
  resolveViewGeometry(snapshotValue, { viewType, requestedProjectId, requestedSessionId });

// ---- A terminal view follows its session across project moves --------------

test("a cd that reassigns the tab to another project keeps the terminal view open", () => {
  const view = geometry(snapshot([project("a"), project("b")], [session("s1", "b")]), "terminal", "a", "s1");
  assert.equal(view.activeSession?.id, "s1");
  assert.equal(view.activeProject?.id, "b", "the project shown is the session's current one");
  assert.equal(view.pageCount, 3, "home + project + terminal pages are all present");
  assert.equal(view.currentPage, 2, "the terminal page stays the current page");
});

test("a moved terminal session keeps the pager when its old project was retired", () => {
  // The cd moved the last session out of the temporary project "old", which
  // the desktop then retired: only the new project remains in the snapshot.
  const view = geometry(snapshot([project("b")], [session("s1", "b")]), "terminal", "a", "s1");
  assert.equal(view.activeSession?.id, "s1");
  assert.equal(view.activeProject?.id, "b");
  assert.equal(view.pageCount, 3);
  assert.equal(view.currentPage, 2, "the user is not kicked back to another page");
});

test("a terminal view resolves its session by id regardless of its project", () => {
  const view = geometry(snapshot([project("a"), project("b")], [session("s1", "b")]), "terminal", "a", "s1");
  assert.equal(view.activeSession?.id, "s1");
  assert.notEqual(view.activeSession?.projectId, "a");
});

// ---- Back from the terminal view lands on the session's live project -------

test("back from a moved terminal session lands on the new project", () => {
  assert.equal(backProjectId(snapshot([project("a"), project("b")], [session("s1", "b")]), { sessionId: "s1", projectId: "a" }), "b");
});

test("back from a moved terminal session lands on the new project even when the old one was retired", () => {
  assert.equal(backProjectId(snapshot([project("b")], [session("s1", "b")]), { sessionId: "s1", projectId: "a" }), "b");
});

test("back falls back to the opened project when the session is gone", () => {
  assert.equal(backProjectId(snapshot([project("a")], []), { sessionId: "s1", projectId: "a" }), "a");
});

test("back falls back to the opened project when no snapshot is available", () => {
  assert.equal(backProjectId(null, { sessionId: "s1", projectId: "a" }), "a");
});

test("back from a never-moved terminal session lands on its own project", () => {
  assert.equal(backProjectId(snapshot([project("a")], [session("s1", "a")]), { sessionId: "s1", projectId: "a" }), "a");
});

// ---- The other pages still gate sessions to their project -------------------

test("a project page never resolves a session that was moved out of it", () => {
  const view = geometry(snapshot([project("a"), project("b")], [session("s1", "b")]), "project", "b", "s1");
  assert.equal(view.activeSession?.id, "s1", "the session lives in the shown project");
  const other = geometry(snapshot([project("a"), project("b")], [session("s1", "b")]), "project", "a", "s1");
  assert.equal(other.activeSession, undefined, "a project page does not cross project lines");
  assert.equal(other.activeProject?.id, "a");
  assert.equal(other.pageCount, 2, "no terminal page exists for a foreign session");
  assert.equal(other.currentPage, 1);
});

test("a home page gates its selected session to the selected project", () => {
  const view = geometry(snapshot([project("a"), project("b")], [session("s1", "b")]), "home", "a", "s1");
  assert.equal(view.activeSession, undefined, "a session from another project is not previewed");
  assert.equal(view.activeProject?.id, "a");
});

test("a home page with no matching project resolves the session by id only", () => {
  // Full snapshot contract keeps sessions inside listed projects, but a
  // project that vanished while its session lives on must not change page
  // geometry beyond what is really there.
  const view = geometry(snapshot([project("b")], [session("s1", "b")]), "home", "a", "s1");
  assert.equal(view.activeSession?.id, "s1");
  assert.equal(view.activeProject, undefined);
  assert.equal(view.pageCount, 1, "without the project there is no project page");
  assert.equal(view.currentPage, 0);
});

// ---- Page geometry stays consistent for swipes from the terminal page ------

test("swiping back from a moved terminal session targets the new project page", () => {
  const view = geometry(snapshot([project("a"), project("b")], [session("s1", "b")]), "terminal", "a", "s1");
  // Pager swipe to page 1 uses activeProject exactly as finishSwipe does.
  assert.equal(view.activeProject?.id, "b");
  assert.equal(view.pageCount, 3, "moving between the three pages is still possible");
});
