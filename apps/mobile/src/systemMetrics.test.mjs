import assert from "node:assert/strict";
import test from "node:test";
import "./test-support.mjs";

// Node has no native bridge, so Capacitor reports the web platform and the
// system metrics path must fall back to the default constant instead of
// hanging or throwing on the missing plugin.
const { systemHoldThresholdMs } = await import("./systemMetrics.ts");
const { MODIFIER_HOLD_THRESHOLD_MS } = await import("./utilityKeys.ts");

test("off device (web platform) the hold threshold falls back to the default constant", async () => {
  assert.equal(await systemHoldThresholdMs(), MODIFIER_HOLD_THRESHOLD_MS);
});

test("an unreachable native plugin also falls back instead of rejecting", async () => {
  // Simulate the native platform without a working SystemMetrics plugin.
  const { Capacitor } = await import("@capacitor/core");
  const original = Capacitor.isNativePlatform.bind(Capacitor);
  Capacitor.isNativePlatform = () => true;
  try {
    assert.equal(await systemHoldThresholdMs(), MODIFIER_HOLD_THRESHOLD_MS);
  } finally {
    Capacitor.isNativePlatform = original;
  }
});
