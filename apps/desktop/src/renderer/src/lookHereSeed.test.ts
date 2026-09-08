import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the host-persisted "come look" marker on the
// desktop. The marker is stored on the host (the finished taskbar edge
// raises it, viewing or re-arming drops it) and rides every snapshot in
// state.lookHereSessionIds; a window (re)loaded after the command
// finished seeds its static completed dots from that list. The seed is
// ADD-ONLY: removals belong to the open-tab and cross-client view
// effects, so a stale in-flight snapshot can never drop a locally-
// detected marker.

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
  // The tab this window is showing IS the look: a marker for it is the
  // local edge's business, not the host's list's.
  assert.match(seedEffect(), /id !== activeSessionId/);
});

test("the seed reruns when the snapshot or the active tab changes", () => {
  assert.match(
    app,
    /useEffect\(\(\) => \{\s*const ids = state\?\.lookHereSessionIds;[\s\S]*?\}, \[state, activeSessionId\]\);/
  );
});