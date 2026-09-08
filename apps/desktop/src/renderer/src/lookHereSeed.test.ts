import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the host-persisted "come look" marker on the
// desktop. The marker is stored on the host: a finished taskbar edge
// raises it ONLY while no client is viewing the session (a viewer is
// the look itself), viewing or re-arming drops it, and the flag rides
// every snapshot in state.lookHereSessionIds. A window (re)loaded after
// the command finished seeds its static completed dots from that list.
// The seed is ADD-ONLY and the ONLY raiser of the local holds - no
// client may detect the finished edge from its own event stream and
// raise a marker another client's viewer already accounted for - and
// removals belong to the open-tab, new-command and cross-client view
// effects, so a stale in-flight snapshot can never drop a marker.

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

// The seed effect, isolated from the surrounding effects.
function seedEffect(): string {
  const match = app.match(
    /useEffect\(\(\) => \{\s*const ids = state\?\.lookHereSessionIds;[\s\S]*?\}, \[state, activeSessionId\]\);/
  );
  assert.ok(match, "the lookHereSessionIds seed effect is missing (or its deps drifted)");
  return match[0];
}

test("the seed effect adds the host's marker ids to the local hold", () => {
  const effect = seedEffect();
  assert.match(effect, /state\?\.lookHereSessionIds/);
  assert.match(effect, /setCompletedHold\(\(current\) => \{/);
  // The updater adds ids and only ids.
  assert.match(effect, /next\.add\(id\)/);
  assert.doesNotMatch(
    effect,
    /delete/,
    "the seed must be add-only: a stale snapshot must not drop a local marker"
  );
});

test("the seed skips the window's active tab", () => {
  // The tab this window is showing IS the look: the host raises no
  // marker for it (its finished edge is suppressed while it is viewed),
  // so the list can hold at most markers for the OTHER tabs.
  assert.match(seedEffect(), /id !== activeSessionId/);
});

test("no client-side finished-edge detection raises a hold", () => {
  // The host is the marker's sole raiser: it raises the flag while no
  // client is viewing the session, so a window that watched the finish
  // must not mark the tab of its own - and neither may the window mark
  // a tab ANOTHER client is sitting on. The client only expires holds
  // (new command, session gone, a look from anywhere).
  assert.doesNotMatch(
    app,
    /taskbarJustCompleted/,
    "a local running -> clear edge must not raise the marker: the host's viewed-suppressed list is the only raiser"
  );
});

test("the seed reruns when the snapshot or the active tab changes", () => {
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*const ids = state\?\.lookHereSessionIds;[\s\S]*?\}, \[state, activeSessionId\]\);/
  );
});

// ---- Edge cases: the hold's expirations and cross-client views ----

// The hold-expiry effect, isolated from the surrounding effects.
function expiryEffect(): string {
  const match = app.match(
    /useEffect\(\(\) => \{\s*const sessions = state\?\.sessions;\s*if \(!sessions\) return;\s*const now = new Map<string, TaskbarProgress>\(\);[\s\S]*?\}, \[state, taskbarBySession\]\);/
  );
  assert.ok(match, "the hold-expiry effect is missing (or its deps drifted)");
  return match[0];
}

// The cross-client view effect, isolated.
function viewEffect(): string {
  const match = app.match(
    /useEffect\(\(\) => \{\s*if \(!state\) return;\s*const viewed = new Set<string>\(\);[\s\S]*?\}, \[state\]\);/
  );
  assert.ok(match, "the cross-client view effect is missing (or its deps drifted)");
  return match[0];
}

test("a new command re-arms the tab's bar and expires its hold", () => {
  // The host's list is add-only, so the client must drop the hold the
  // moment the tab's indicator goes non-clear again: a new command is
  // its own look at the tab, and a stale 100% ring would sit on top
  // of the new command's progress.
  const effect = expiryEffect();
  assert.match(effect, /effective\.state !== "clear"/, "a non-clear indicator is a re-arm");
  assert.match(effect, /holds\.delete\(session\.id\)/);
});

test("a held session that leaves the project loses its marker", () => {
  // A session gone from the host list (its project deleted) takes its
  // marker with it, so a deleted project can't keep a ghost 100% bar
  // alive on a tab that no longer exists.
  const effect = expiryEffect();
  assert.match(effect, /!now\.has\(id\)/);
  assert.match(effect, /holds\.delete\(id\)/);
});

test("opening a held tab resets its marker at once", () => {
  // Every entry point into the tab (a tab click, a console handoff, a
  // phone focus) ends the marker: the look it asks for has happened.
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*if \(!activeSessionId\) return;\s*setCompletedHold\(\(current\) => \{[\s\S]*?next\.delete\(activeSessionId\);[\s\S]*?\}, \[activeSessionId\]\);/
  );
});

test("a look from any client - a phone or another window - kills the marker", () => {
  // The marker dies the moment the session enters ANY client's viewed
  // set. The effect must consume both the devices' open-terminal sets
  // and the other windows' active tabs: phones' sets alone would leave
  // the marker on while a desktop window is looking at the session.
  const effect = viewEffect();
  assert.match(effect, /device\.viewingSessionIds \?\? \[\]/, "the devices' open terminals count as looks");
  assert.match(
    effect,
    /state\.desktopActiveSessionIds \?\? \[\]/,
    "the other windows' active tabs count as looks"
  );
  assert.match(effect, /next\.delete\(id\)/);
});

test("only a NEW look resets a marker", () => {
  // A session that was already viewed before the command finished (a
  // background tab, a phone terminal that was already open) would have
  // suppressed the host's marker in the first place, so an entry that
  // was in the last snapshot's viewed set must not kill a held marker:
  // only an entry that appeared since is a look at the finish.
  const effect = viewEffect();
  assert.match(effect, /!viewedRef\.current\.has\(id\)/);
});