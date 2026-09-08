import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the host-persisted "come look" marker on the
// phone (the desktop's twin is lookHereSeed.test.ts in the renderer):
// a phone that connects AFTER the command finished still raises its
// 100% ring and static dot from snapshot.lookHereSessionIds. The
// host raises the flag only while no client is viewing the session
// (a viewer is the look itself), so the list never carries a marker
// for a terminal someone is sitting on. The seed is add-only and the
// ONLY raiser of the local holds - no client may detect the finished
// edge from its own event stream - and the open, new-command and
// cross-client view effects own the removals, so a stale in-flight
// snapshot can never drop a marker.

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function seedEffect() {
  const match = app.match(
    /useEffect\(\(\) => \{\s*const ids = snapshot\?\.lookHereSessionIds;[\s\S]*?\}, \[snapshot, view\]\);/
  );
  assert.ok(match, "the lookHereSessionIds seed effect is missing (or its deps drifted)");
  return match[0];
}

test("the seed effect adds the host's marker ids to the local hold", () => {
  const effect = seedEffect();
  assert.match(effect, /snapshot\?\.lookHereSessionIds/);
  assert.match(effect, /setCompletedHold\(\(current\) => \{/);
  assert.match(effect, /next\.add\(id\)/);
  assert.doesNotMatch(
    effect,
    /delete/,
    "the seed must be add-only: a stale snapshot must not drop a local marker"
  );
});

test("the seed skips the terminal this phone has open", () => {
  // The open terminal IS the look: the host raises no marker for it
  // (its finished edge is suppressed while it is viewed), so the list
  // can hold at most markers for sessions this phone is not on.
  const effect = seedEffect();
  assert.match(effect, /view\.type === "terminal" \? view\.sessionId : null/);
  assert.match(effect, /id !== activeSessionId/);
});

test("no client-side finished-edge detection raises a hold", () => {
  // The host is the marker's sole raiser: it raises the flag while no
  // client is viewing the session, so the phone that watched the finish
  // must not mark its own open terminal - and neither may it mark a
  // terminal ANOTHER client is sitting on. The phone only expires holds
  // (new command, session gone, a look from anywhere).
  assert.doesNotMatch(
    app,
    /taskbarJustCompleted/,
    "a local running -> clear edge must not raise the marker: the host's viewed-suppressed list is the only raiser"
  );
});

// ---- Edge cases: the hold's expirations and cross-client views ----

// The hold-expiry effect, isolated from the surrounding effects.
function expiryEffect() {
  const match = app.match(
    /useEffect\(\(\) => \{\s*const sessions = snapshot\?\.sessions;\s*if \(!sessions\) return;\s*const now = new Map<string, TaskbarProgress>\(\);[\s\S]*?\}, \[snapshot\]\);/
  );
  assert.ok(match, "the hold-expiry effect is missing (or its deps drifted)");
  return match[0];
}

// The cross-client view effect, isolated.
function viewEffect() {
  const match = app.match(
    /useEffect\(\(\) => \{\s*if \(!snapshot\) return;\s*const viewed = new Set<string>\(\);[\s\S]*?\}, \[snapshot\]\);/
  );
  assert.ok(match, "the cross-client view effect is missing (or its deps drifted)");
  return match[0];
}

test("a new command re-arms the session's ring and expires its hold", () => {
  // The connection patches every session.taskbar event into the
  // snapshot it holds, so the expiry sees the newest bar state: a
  // non-clear indicator is a new command, which is its own look at the
  // terminal, and the stale 100% ring must not sit on top of it.
  const effect = expiryEffect();
  assert.match(effect, /effective\.state !== "clear"/, "a non-clear indicator is a re-arm");
  assert.match(effect, /holds\.delete\(session\.id\)/);
});

test("a held session that leaves the host list loses its marker", () => {
  // A session gone from the host list (its project deleted) takes its
  // marker with it, so a deleted project can't keep a ghost 100% ring
  // alive on a terminal that no longer exists.
  const effect = expiryEffect();
  assert.match(effect, /!now\.has\(id\)/);
  assert.match(effect, /holds\.delete\(id\)/);
});

test("opening a held terminal resets its marker at once", () => {
  // Opening the terminal this phone shows ends the marker: the look it
  // asks for has happened.
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*if \(view\.type !== "terminal" \|\| !completedHold\.has\(view\.sessionId\)\) return;[\s\S]*?next\.delete\(view\.sessionId\);[\s\S]*?\}, \[view, completedHold\]\);/
  );
});

test("a look from any client - the desktop or another phone - kills the marker", () => {
  // The marker dies the moment the session enters ANY client's viewed
  // set. The effect must consume both the other devices' open-terminal
  // sets and the desktop windows' active tabs: one source alone would
  // leave the ring on while the other kind of client looks at the
  // terminal.
  const effect = viewEffect();
  assert.match(effect, /device\.viewingSessionIds \?\? \[\]/, "the other phones' open terminals count as looks");
  assert.match(
    effect,
    /snapshot\.desktopActiveSessionIds \?\? \[\]/,
    "the desktop windows' active tabs count as looks"
  );
  assert.match(effect, /next\.delete\(id\)/);
});

test("only a NEW look resets a marker", () => {
  // A terminal that was already viewed before the command finished (a
  // desktop background tab, a phone terminal that was already open)
  // would have suppressed the host's marker in the first place, so an
  // entry that was in the last snapshot's viewed set must not kill a
  // held marker: only an entry that appeared since is a look at the
  // finish.
  const effect = viewEffect();
  assert.match(effect, /!viewedBeforeRef\.current\.has\(id\)/);
});