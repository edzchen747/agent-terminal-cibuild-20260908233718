import assert from "node:assert/strict";
import test from "node:test";
import { registrationCheckPlan } from "./registrationFlow.ts";

const PLANS = new Set([
  "stayEnrolled",
  "reEnroll",
  "markEnrolled",
  "keepStored",
  "retryOnce",
  "showFailed"
]);

test("the plan decides for every combination of inputs", () => {
  const cachedValues = [null, "verified", "lanOnly"];
  for (const cached of cachedValues) {
    for (const engineStarted of [false, true]) {
      for (const failed of [false, true]) {
        for (const dropped of [false, true]) {
          for (const retryOnTransientFailure of [false, true]) {
            const plan = registrationCheckPlan({
              cached,
              engineStarted,
              failed,
              dropped,
              retryOnTransientFailure
            });
            assert.ok(PLANS.has(plan), `unknown plan ${plan} for ${JSON.stringify({ cached, engineStarted, failed, dropped, retryOnTransientFailure })}`);
          }
        }
      }
    }
  }
});

test("a cached verified verdict skips the check no matter what the engine says", () => {
  for (const engineStarted of [false, true]) {
    for (const failed of [false, true]) {
      for (const dropped of [false, true]) {
        for (const retryOnTransientFailure of [false, true]) {
          assert.equal(
            registrationCheckPlan({ cached: "verified", engineStarted, failed, dropped, retryOnTransientFailure }),
            "stayEnrolled"
          );
        }
      }
    }
  }
});

test("a cached lanOnly verdict goes straight to re-registration", () => {
  for (const engineStarted of [false, true]) {
    for (const failed of [false, true]) {
      for (const dropped of [false, true]) {
        for (const retryOnTransientFailure of [false, true]) {
          assert.equal(
            registrationCheckPlan({ cached: "lanOnly", engineStarted, failed, dropped, retryOnTransientFailure }),
            "reEnroll"
          );
        }
      }
    }
  }
});

test("with no cache, a started engine confirms the registration", () => {
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: true, failed: false, dropped: false, retryOnTransientFailure: true }),
    "markEnrolled"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: true, failed: false, dropped: false, retryOnTransientFailure: false }),
    "markEnrolled"
  );
});

test("with no cache, no failure and no engine (browser build) keeps the stored verdict", () => {
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: false, dropped: false, retryOnTransientFailure: true }),
    "keepStored"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: false, dropped: false, retryOnTransientFailure: false }),
    "keepStored"
  );
});

test("a dropped node re-enrolls even on the retry pass", () => {
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: true, dropped: true, retryOnTransientFailure: true }),
    "reEnroll"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: true, dropped: true, retryOnTransientFailure: false }),
    "reEnroll"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: true, failed: true, dropped: true, retryOnTransientFailure: false }),
    "reEnroll"
  );
});

test("a first transient failure retries once, a repeated one surfaces the error", () => {
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: true, dropped: false, retryOnTransientFailure: true }),
    "retryOnce"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: true, dropped: false, retryOnTransientFailure: false }),
    "showFailed"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: true, failed: true, dropped: false, retryOnTransientFailure: true }),
    "retryOnce"
  );
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: true, failed: true, dropped: false, retryOnTransientFailure: false }),
    "showFailed"
  );
});

test("a dropped node wins over the retry flag, and cached verdicts beat failures", () => {
  assert.equal(
    registrationCheckPlan({ cached: null, engineStarted: false, failed: true, dropped: true, retryOnTransientFailure: true }),
    "reEnroll"
  );
  assert.equal(
    registrationCheckPlan({ cached: "verified", engineStarted: false, failed: true, dropped: true, retryOnTransientFailure: false }),
    "stayEnrolled"
  );
  assert.equal(
    registrationCheckPlan({ cached: "lanOnly", engineStarted: true, failed: false, dropped: false, retryOnTransientFailure: true }),
    "reEnroll"
  );
});
