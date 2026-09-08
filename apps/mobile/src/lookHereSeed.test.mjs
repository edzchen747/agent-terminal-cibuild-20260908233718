import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the host-persisted "come look" marker on the
// phone (the desktop's twin is lookHereSeed.test.ts in the renderer):
// a phone that connects AFTER the command finished still raises its
// 100% ring and static dot from snapshot.lookHereSessionIds. The seed
// is add-only - the open, new-command and cross-client view effects own
// the removals - so a stale in-flight snapshot can never drop a
// locally-detected marker.

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
  // The open terminal IS the look: a marker for its session belongs to
  // the local edge, not to the host's list.
  const effect = seedEffect();
  assert.match(effect, /view\.type === "terminal" \? view\.sessionId : null/);
  assert.match(effect, /id !== activeSessionId/);
});