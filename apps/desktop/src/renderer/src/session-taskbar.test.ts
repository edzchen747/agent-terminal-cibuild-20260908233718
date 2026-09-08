import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskbarProgress, TerminalSession } from "@agentterminal/protocol";
import {
  CLEAR_TASKBAR_PROGRESS,
  applyTaskbarEvent,
  mergeTaskbar,
  sameTaskbarProgress,
  tabProgressModel,
  taskbarHasProgress,
  taskbarJustCompleted,
  taskbarOf,
} from "./session-taskbar.ts";

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

function taskbar(state: TaskbarProgress["state"], progress?: number): TaskbarProgress {
  return progress === undefined ? { state } : { state, progress };
}

function map(entries: Record<string, TaskbarProgress> = {}): ReadonlyMap<string, TaskbarProgress> {
  return new Map(Object.entries(entries));
}

describe("state helpers", () => {
  it("only value, error, and paused carry a progress field", () => {
    assert.equal(taskbarHasProgress(taskbar("value", 40)), true);
    assert.equal(taskbarHasProgress(taskbar("error", 40)), true);
    assert.equal(taskbarHasProgress(taskbar("paused", 40)), true);
    assert.equal(taskbarHasProgress(taskbar("indeterminate")), false);
    assert.equal(taskbarHasProgress(CLEAR_TASKBAR_PROGRESS), false);
  });

  it("a session without a taskbar state defaults to clear", () => {
    assert.deepEqual(taskbarOf(session("s1", "p1")), CLEAR_TASKBAR_PROGRESS);
  });

  it("a session state is the same when every field matches", () => {
    assert.equal(sameTaskbarProgress(taskbar("value", 40), taskbar("value", 40)), true);
    assert.equal(sameTaskbarProgress(taskbar("value", 40), taskbar("value", 41)), false);
    assert.equal(sameTaskbarProgress(taskbar("error", 40), taskbar("value", 40)), false);
  });
});

describe("applying a taskbar event", () => {
  it("records the new state", () => {
    const next = applyTaskbarEvent(map(), "s1", taskbar("value", 40));
    assert.deepEqual(next.get("s1"), taskbar("value", 40));
  });

  it("returns the same map when nothing changed, so the UI does not re-render", () => {
    const current = map({ s1: taskbar("value", 40) });
    assert.equal(applyTaskbarEvent(current, "s1", taskbar("value", 40)), current);
  });

  it("treats a clear event for an unseen session as a no-op", () => {
    // A fresh tab starts clear on the host, so the event carries no
    // information the map lacks.
    const current = map();
    assert.equal(applyTaskbarEvent(current, "s1", CLEAR_TASKBAR_PROGRESS), current);
  });

  it("records a session the map has never seen without disturbing the others", () => {
    const next = applyTaskbarEvent(map({ s1: taskbar("indeterminate") }), "s2", taskbar("error", 80));
    assert.deepEqual(next.get("s1"), taskbar("indeterminate"));
    assert.deepEqual(next.get("s2"), taskbar("error", 80));
  });

  it("does not mutate the map it was given", () => {
    const current = map({ s1: taskbar("paused", 10) });
    applyTaskbarEvent(current, "s1", taskbar("clear"));
    assert.deepEqual(current.get("s1"), taskbar("paused", 10));
  });

  it("keeps the clear entry on a clear event, leaving the others alone", () => {
    // The clear must survive in the map: a snapshot in flight was built
    // before the clear transition and still carries the old state, and
    // the (newer) event has to win in the merge that follows.
    const next = applyTaskbarEvent(
      map({ s1: taskbar("value", 40), s2: taskbar("indeterminate") }),
      "s1",
      CLEAR_TASKBAR_PROGRESS
    );
    assert.deepEqual(next.get("s1"), CLEAR_TASKBAR_PROGRESS);
    assert.deepEqual(next.get("s2"), taskbar("indeterminate"));
  });

  it("a percentage change is a change", () => {
    const current = map({ s1: taskbar("value", 40) });
    const next = applyTaskbarEvent(current, "s1", taskbar("value", 42));
    assert.notEqual(next, current);
    assert.deepEqual(next.get("s1"), taskbar("value", 42));
  });
});

describe("merging a snapshot", () => {
  it("adopts the snapshot state for a session it has not heard about", () => {
    const merged = mergeTaskbar(map(), [session("s1", "p1", { taskbar: taskbar("value", 30) })]);
    assert.deepEqual(merged.get("s1"), taskbar("value", 30));
  });

  it("keeps a state an event already set, since the event is the newer of the two", () => {
    // The snapshot that reports this session indeterminate was already
    // in flight when the value event landed; adopting it would flicker
    // the tab ring back to a spinner.
    const current = map({ s1: taskbar("value", 50) });
    const merged = mergeTaskbar(current, [session("s1", "p1", { taskbar: taskbar("indeterminate") })]);
    assert.deepEqual(merged.get("s1"), taskbar("value", 50));
  });

  it("clears an indicator the session was still holding when its shell exited", () => {
    // An exited tab kept for inspection gets one final clear from the
    // host; the snapshot must not resurrect a spinner the process no
    // longer owns. Exited sessions take the snapshot's verdict, so the
    // map's old entry is dropped.
    const current = map({ s1: taskbar("indeterminate") });
    const merged = mergeTaskbar(current, [session("s1", "p1", { status: "exited", exitCode: 1 })]);
    assert.equal(merged.get("s1"), undefined);
  });

  it("a stale snapshot cannot resurrect a cleared state of a running session", () => {
    // The snapshot that still reports the spinner was built before the
    // clear event landed; the clear entry the event left in the map is
    // newer and must win, or the tab would keep pulsing after the
    // command finished.
    const cleared = applyTaskbarEvent(map({ s1: taskbar("indeterminate") }), "s1", CLEAR_TASKBAR_PROGRESS);
    const merged = mergeTaskbar(cleared, [session("s1", "p1", { taskbar: taskbar("indeterminate") })]);
    assert.deepEqual(merged.get("s1"), CLEAR_TASKBAR_PROGRESS);
  });

  it("drops sessions that are gone", () => {
    const merged = mergeTaskbar(map({ s1: taskbar("value", 10), s2: taskbar("value", 20) }), [session("s1", "p1")]);
    assert.deepEqual([...merged.keys()], ["s1"]);
  });

  it("returns the same map when the snapshot changes nothing", () => {
    const current = map({ s1: taskbar("value", 10) });
    assert.equal(mergeTaskbar(current, [session("s1", "p1", { taskbar: taskbar("value", 10) })]), current);
  });

  it("returns the same map when an unseen session is already clear", () => {
    const current = map();
    assert.equal(mergeTaskbar(current, [session("s1", "p1")]), current);
  });

  it("empties a map when the last session closes", () => {
    assert.equal(mergeTaskbar(map({ s1: taskbar("value", 10) }), []).size, 0);
  });

  it("keeps a held state for a running session the snapshot does not mention", () => {
    // A snapshot taken before the event it carries was generated has no
    // taskbar field yet; a running session keeps what the event told us.
    const merged = mergeTaskbar(map({ s1: taskbar("indeterminate") }), [session("s1", "p1")]);
    assert.deepEqual(merged.get("s1"), taskbar("indeterminate"));
  });

  it("takes the snapshot's verdict for a non-running session, over a held state", () => {
    // The host pushed one final clear for the tab it kept open, so the
    // snapshot's state - not a spinner the event still holds - is what
    // the tab shows.
    const merged = mergeTaskbar(
      map({ s1: taskbar("indeterminate") }),
      [session("s1", "p1", { status: "exited", exitCode: 1, taskbar: taskbar("value", 50) })]
    );
    assert.deepEqual(merged.get("s1"), taskbar("value", 50));
  });
});

describe("the tab's dot and progress bar", () => {
  const running = session("s1", "p1");
  const idle = session("s1", "p1", { activity: "idle" });
  const failed = session("s1", "p1", { status: "exited", exitCode: 1 });
  const cleanExit = session("s1", "p1", { status: "exited", exitCode: 0 });

  it("the active tab draws nothing: its underline is the active indicator", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: true, session: running, taskbar: taskbar("value", 50) }),
      { dot: null, bar: null, fill: null }
    );
  });

  it("an explicit progress percentage fills the bar and keeps the green dot", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("value", 42) }),
      { dot: "running", bar: "value", fill: 42 }
    );
  });

  it("a running command without a percentage blinks the dot and pulses the bar", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("indeterminate") }),
      { dot: "running", bar: "pulse", fill: null }
    );
  });

  it("a paused command keeps the blinking dot and holds its percentage", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("paused", 60) }),
      { dot: "running", bar: "value", fill: 60 }
    );
  });

  it("a failed command shows the red dot and no bar", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("error", 30) }),
      { dot: "error", bar: null, fill: null }
    );
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: failed, taskbar: CLEAR_TASKBAR_PROGRESS }),
      { dot: "error", bar: null, fill: null }
    );
  });

  it("an unknown exit code counts as a failure", () => {
    const unknown = session("s1", "p1", { status: "exited" });
    assert.equal(tabProgressModel({ isActive: false, session: unknown, taskbar: CLEAR_TASKBAR_PROGRESS }).dot, "error");
  });

  it("a normal idle tab shows the empty circle and a 0% bar, dim track only", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: idle, taskbar: CLEAR_TASKBAR_PROGRESS }),
      { dot: "idle", bar: "value", fill: 0 }
    );
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: CLEAR_TASKBAR_PROGRESS, activity: "active" }),
      { dot: "running", bar: "pulse", fill: null }
    );
  });

  it("a command that just finished while the tab was unselected holds the bar at 100% with a static green dot", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: idle, taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
      { dot: "completed", bar: "full", fill: null }
    );
    // A command that is running again takes over: the progress bar
    // wins, the hold is ignored.
    assert.deepEqual(
      tabProgressModel({
        isActive: false,
        session: running,
        taskbar: taskbar("indeterminate"),
        activity: "active",
        justCompleted: true
      }),
      { dot: "running", bar: "pulse", fill: null }
    );
  });

  it("a clean exit kept open for inspection draws nothing", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: cleanExit, taskbar: CLEAR_TASKBAR_PROGRESS }),
      { dot: null, bar: null, fill: null }
    );
  });
});

describe("model edge cases", () => {
  const running = session("s1", "p1");
  const failedExit = session("s1", "p1", { status: "exited", exitCode: 1 });
  const failedExitUnknown = session("s1", "p1", { status: "exited" });
  const cleanExitKept = session("s1", "p1", { status: "exited", exitCode: 0 });
  const finishedIdle = session("s1", "p1", { activity: "idle" });

  it("a failure is never dressed up as the come-look marker", () => {
    // The error state lingers until the next command starts.
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("error", 30), justCompleted: true }),
      { dot: "error", bar: null, fill: null }
    );
    // A non-zero exit keeps its red dot even if a hold was recorded.
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: failedExit, taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
      { dot: "error", bar: null, fill: null }
    );
    // An unknown exit code counts as a failure too.
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: failedExitUnknown, taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
      { dot: "error", bar: null, fill: null }
    );
  });

  it("a clean exit kept open for inspection draws nothing, marker or not", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: cleanExitKept, taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
      { dot: null, bar: null, fill: null }
    );
  });

  it("the active tab ignores the marker: its underline is the indicator", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: true, session: finishedIdle, taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
      { dot: null, bar: null, fill: null }
    );
  });

  it("the marker draws immediately, before the activity's busy badge leaves its grace window", () => {
    // The host's activity machine lingers "active" for a grace period
    // after output stops, but the taskbar's running -> clear edge is the
    // truth of "the command finished": the marker must not flash as a
    // blinking running command while the activity badge catches up.
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: CLEAR_TASKBAR_PROGRESS, activity: "active", justCompleted: true }),
      { dot: "completed", bar: "full", fill: null }
    );
  });

  it("a value or paused state without a percentage fills at 0%", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("value") }),
      { dot: "running", bar: "value", fill: 0 }
    );
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("paused") }),
      { dot: "running", bar: "value", fill: 0 }
    );
  });

  it("an explicit percentage outlives its command until the host clears it", () => {
    // The program reported a percentage and the shell is idle again: the
    // report is still the newest fact (the host keeps explicit state
    // until the next report or exit), so the bar holds the number.
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: finishedIdle, taskbar: taskbar("value", 64), activity: "idle" }),
      { dot: "running", bar: "value", fill: 64 }
    );
  });

  it("a lingering error wins over a command that is just starting", () => {
    assert.deepEqual(
      tabProgressModel({ isActive: false, session: running, taskbar: taskbar("error", 0), activity: "active" }),
      { dot: "error", bar: null, fill: null }
    );
  });
});

describe("the just-completed edge", () => {
  it("fires on the running -> clear transition only", () => {
    assert.equal(taskbarJustCompleted(taskbar("indeterminate"), CLEAR_TASKBAR_PROGRESS), true);
    assert.equal(taskbarJustCompleted(taskbar("value", 42), CLEAR_TASKBAR_PROGRESS), true);
    assert.equal(taskbarJustCompleted(taskbar("paused", 42), CLEAR_TASKBAR_PROGRESS), true);
    assert.equal(taskbarJustCompleted(taskbar("error", 30), CLEAR_TASKBAR_PROGRESS), true);
    assert.equal(taskbarJustCompleted(CLEAR_TASKBAR_PROGRESS, CLEAR_TASKBAR_PROGRESS), false);
    assert.equal(taskbarJustCompleted(CLEAR_TASKBAR_PROGRESS, taskbar("indeterminate")), false);
    assert.equal(taskbarJustCompleted(taskbar("indeterminate"), taskbar("value", 10)), false);
    assert.equal(taskbarJustCompleted(taskbar("value", 10), taskbar("value", 20)), false);
  });
});