import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionActivity, TerminalSession } from "@agentterminal/protocol";
import { applyActivityEvent, mergeActivity, projectActivitySummary } from "./session-activity.ts";

function session(
  id: string,
  projectId: string,
  extra: Partial<TerminalSession> = {}
): TerminalSession {
  return {
    id,
    projectId,
    title: id,
    cwd: "C:/",
    shellId: "powershell",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    ...extra
  };
}

function map(entries: Record<string, SessionActivity> = {}): ReadonlyMap<string, SessionActivity> {
  return new Map(Object.entries(entries));
}

describe("applying an activity event", () => {
  it("records the new state", () => {
    const next = applyActivityEvent(map(), "s1", "active");
    assert.equal(next.get("s1"), "active");
  });

  it("returns the same map when nothing changed, so the UI does not re-render", () => {
    const current = map({ s1: "active" });
    assert.equal(applyActivityEvent(current, "s1", "active"), current);
  });

  it("records a session the map has never seen without disturbing the others", () => {
    const next = applyActivityEvent(map({ s1: "active" }), "s2", "idle");
    assert.equal(next.get("s1"), "active");
    assert.equal(next.get("s2"), "idle");
  });

  it("accepts an event for a session no snapshot has arrived for yet", () => {
    // The host announces the change and broadcasts the snapshot
    // separately; a brand new tab can be told it is busy first.
    const next = applyActivityEvent(map(), "s1", "active");
    assert.deepEqual([...next], [["s1", "active"]]);
  });

  it("does not mutate the map it was given", () => {
    const current = new Map<string, SessionActivity>([["s1", "idle"]]);
    applyActivityEvent(current, "s1", "active");
    assert.equal(current.get("s1"), "idle");
  });
});

describe("merging a snapshot", () => {
  it("adopts the snapshot state for a session it has not heard about", () => {
    const merged = mergeActivity(map(), [session("s1", "p1", { activity: "active" })]);
    assert.equal(merged.get("s1"), "active");
  });

  it("keeps a state an event already set, since the event is the newer of the two", () => {
    // The snapshot that reports this session idle was already in flight
    // when the activity event landed; adopting it would flicker the badge.
    const current = map({ s1: "active" });
    const merged = mergeActivity(current, [session("s1", "p1", { activity: "idle" })]);
    assert.equal(merged.get("s1"), "active");
  });

  it("clears a badge the session was still holding when its shell exited", () => {
    // The host stops sweeping an exited session, so no activity event is
    // coming to clear it - only the snapshot can.
    const current = map({ s1: "active" });
    const merged = mergeActivity(current, [session("s1", "p1", { status: "exited", exitCode: 0 })]);
    assert.equal(merged.get("s1"), "idle");
  });

  it("drops sessions that are gone", () => {
    const merged = mergeActivity(map({ s1: "active", s2: "active" }), [session("s1", "p1")]);
    assert.deepEqual([...merged.keys()], ["s1"]);
  });

  it("returns the same map when the snapshot changes nothing", () => {
    const current = map({ s1: "active" });
    assert.equal(mergeActivity(current, [session("s1", "p1", { activity: "active" })]), current);
  });

  it("returns the same empty map for a host with no sessions", () => {
    const current = map();
    assert.equal(mergeActivity(current, []), current);
  });

  it("empties a map when the last session closes", () => {
    assert.equal(mergeActivity(map({ s1: "active" }), []).size, 0);
  });

  it("re-adopts the snapshot for a session id that came back", () => {
    // Session ids are UUIDs so this cannot happen in practice, but the
    // merge must not depend on that: nothing here is keyed on identity
    // beyond the id itself.
    const merged = mergeActivity(map({ s1: "active" }), [session("s1", "p1", { status: "exited", exitCode: 0 })]);
    assert.equal(merged.get("s1"), "idle");
  });
});

describe("the project sidebar rollup", () => {
  const sessions = [
    session("s1", "p1"),
    session("s2", "p1"),
    session("s3", "p1"),
    session("s4", "p2"),
    session("s5", "p1", { status: "exited", exitCode: 1 })
  ];

  it("scopes the count to the project and to the events this window has seen", () => {
    const summary = projectActivitySummary(sessions, map({ s1: "active", s4: "active" }), "p1");
    assert.equal(summary.active, 1);
    assert.equal(summary.running, 3, "the exited tab is not one of the three");
    assert.equal(summary.label, "1 of 3 sessions active");
  });

  it("falls back to the snapshot state for a session with no event yet", () => {
    const withState = [session("s1", "p1", { activity: "active" }), session("s2", "p1")];
    assert.equal(projectActivitySummary(withState, map(), "p1").active, 1);
  });

  it("reads zero for a project the window is not showing any sessions of", () => {
    assert.deepEqual(projectActivitySummary(sessions, map({ s1: "active" }), "p3"), {
      active: 0,
      running: 0,
      label: "No active sessions"
    });
  });

  it("lets an event outrank the snapshot in both directions", () => {
    const withState = [session("s1", "p1", { activity: "active" }), session("s2", "p1", { activity: "active" })];
    const summary = projectActivitySummary(withState, map({ s1: "idle" }), "p1");
    assert.equal(summary.active, 1, "the event that cleared s1 is newer than the snapshot");
    assert.equal(summary.label, "1 of 2 sessions active");
  });
});
