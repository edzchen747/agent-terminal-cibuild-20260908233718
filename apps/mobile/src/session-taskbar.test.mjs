import assert from "node:assert/strict";
import test from "node:test";
import { CLEAR_TASKBAR_PROGRESS, sessionProgressModel, taskbarJustCompleted, taskbarOf } from "./session-taskbar.ts";

function session(extra = {}) {
  return {
    id: "s1",
    projectId: "p1",
    title: "s1",
    cwd: "C:/",
    shellId: "powershell",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    ...extra
  };
}

function taskbar(state, progress) {
  return progress === undefined ? { state } : { state, progress };
}

// ---- The state helpers ------------------------------------------------------

test("a session without a taskbar state defaults to clear", () => {
  assert.deepEqual(taskbarOf(session()), CLEAR_TASKBAR_PROGRESS);
  assert.deepEqual(taskbarOf(session({ taskbar: taskbar("value", 30) })), taskbar("value", 30));
});

test("only a running -> clear transition is the finished edge", () => {
  for (const running of ["value", "indeterminate", "paused"]) {
    assert.equal(taskbarJustCompleted(taskbar(running), CLEAR_TASKBAR_PROGRESS), true, `${running} -> clear`);
  }
  // A failed command's marker clearing is the finished edge too: the
  // next command's first report (or exit) moves the machine out of the
  // error state, and that is a command boundary.
  assert.equal(taskbarJustCompleted(taskbar("error", 30), CLEAR_TASKBAR_PROGRESS), true, "error -> clear");
  assert.equal(taskbarJustCompleted(CLEAR_TASKBAR_PROGRESS, CLEAR_TASKBAR_PROGRESS), false);
  assert.equal(taskbarJustCompleted(CLEAR_TASKBAR_PROGRESS, taskbar("value", 5)), false);
  assert.equal(taskbarJustCompleted(taskbar("value", 40), taskbar("value", 55)), false);
});

// ---- The dot and the ring ---------------------------------------------------

test("an explicit progress percentage fills the ring and keeps the blinking dot", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("value", 42) }),
    { dot: "running", ring: "value", fill: 42 }
  );
  // A value state with no number still carries a 0% fill, not a pulse.
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("value") }),
    { dot: "running", ring: "value", fill: 0 }
  );
});

test("a running command without a percentage blinks the dot and pulses the ring", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("indeterminate") }),
    { dot: "running", ring: "pulse", fill: null }
  );
});

test("a paused command keeps the blinking dot and holds its percentage", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("paused", 60) }),
    { dot: "running", ring: "value", fill: 60 }
  );
});

test("a failed command shows the red dot and no ring", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("error", 30) }),
    { dot: "error", ring: null, fill: null }
  );
  // An exited shell that failed: the marker stays until the next command.
  assert.deepEqual(
    sessionProgressModel({ session: session({ status: "exited", exitCode: 1 }), taskbar: CLEAR_TASKBAR_PROGRESS }),
    { dot: "error", ring: null, fill: null }
  );
  // An unknown exit code counts as a failure.
  assert.equal(
    sessionProgressModel({ session: session({ status: "exited" }), taskbar: CLEAR_TASKBAR_PROGRESS }).dot,
    "error"
  );
});

test("a cleanly exited session draws neither dot nor ring", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session({ status: "exited", exitCode: 0 }), taskbar: CLEAR_TASKBAR_PROGRESS }),
    { dot: null, ring: null, fill: null }
  );
});

test("the host's active reading blinks the dot and pulses the ring without a percentage", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session({ activity: "active" }), taskbar: CLEAR_TASKBAR_PROGRESS }),
    { dot: "running", ring: "pulse", fill: null }
  );
});

test("the just-finished marker holds the 100% bright ring and a static dot", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
    { dot: "completed", ring: "full", fill: null }
  );
});

test("a normal idle session shows the empty circle and only the dim track", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: CLEAR_TASKBAR_PROGRESS }),
    { dot: "idle", ring: "value", fill: 0 }
  );
});

test("a live command outranks the just-finished marker, a lingering activity reading does not", () => {
  // The marker is only for a command that has stopped. An explicit taskbar
  // state (a new command is reporting) means the ring goes back to
  // progress, but the host's activity busy badge lingers in its grace
  // window after the command finishes - it must not hold the marker off,
  // so the marker draws immediately even while the activity still reads
  // "active".
  assert.deepEqual(
    sessionProgressModel({ session: session({ activity: "active" }), taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
    { dot: "completed", ring: "full", fill: null }
  );
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("value", 10), justCompleted: true }),
    { dot: "running", ring: "value", fill: 10 }
  );
});

// ---- Marker edge cases ------------------------------------------------------

test("a failure is never dressed up as the come-look marker", () => {
  // The host's taskbar machine still holds the error state.
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("error", 30), justCompleted: true }),
    { dot: "error", ring: null, fill: null }
  );
  // A non-zero exit keeps its red dot even if a marker was recorded.
  assert.deepEqual(
    sessionProgressModel({ session: session({ status: "exited", exitCode: 1 }), taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
    { dot: "error", ring: null, fill: null }
  );
  // An unknown exit code counts as a failure too.
  assert.deepEqual(
    sessionProgressModel({ session: session({ status: "exited" }), taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
    { dot: "error", ring: null, fill: null }
  );
});

test("a clean exit kept for inspection draws nothing, marker or not", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session({ status: "exited", exitCode: 0 }), taskbar: CLEAR_TASKBAR_PROGRESS, justCompleted: true }),
    { dot: null, ring: null, fill: null }
  );
});

test("the percentage boundaries fill the ring exactly", () => {
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("value", 0) }),
    { dot: "running", ring: "value", fill: 0 }
  );
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("value", 100) }),
    { dot: "running", ring: "value", fill: 100 }
  );
  // A paused command holds its percentage at the same boundaries.
  assert.deepEqual(
    sessionProgressModel({ session: session(), taskbar: taskbar("paused", 100) }),
    { dot: "running", ring: "value", fill: 100 }
  );
});