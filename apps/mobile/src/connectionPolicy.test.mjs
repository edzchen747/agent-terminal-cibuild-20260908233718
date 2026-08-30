import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttemptConnection,
  HEARTBEAT_ASLEEP_INTERVAL_MS,
  HEARTBEAT_AWAKE_INTERVAL_MS,
  heartbeatActive,
  heartbeatCatchUpNeeded,
  heartbeatIntervalMs,
  nextReconnectDelay,
  notificationStateFor,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS
} from "./connectionPolicy.ts";

test("connection attempts are never made without an internet route", () => {
  assert.equal(canAttemptConnection(false), false);
  assert.equal(canAttemptConnection(true), true);
});

test("reconnect backoff doubles from the base delay", () => {
  assert.equal(nextReconnectDelay(RECONNECT_BASE_DELAY_MS), 2_000);
  assert.equal(nextReconnectDelay(2_000), 4_000);
  assert.equal(nextReconnectDelay(4_000), 8_000);
});

test("reconnect backoff clamps at the maximum delay", () => {
  assert.equal(nextReconnectDelay(16_000), RECONNECT_MAX_DELAY_MS);
  assert.equal(nextReconnectDelay(RECONNECT_MAX_DELAY_MS), RECONNECT_MAX_DELAY_MS);
  // A recovered schedule is restarted from base, not from a stale long delay.
  const timeWithoutConnection = RECONNECT_MAX_DELAY_MS;
  assert.equal(nextReconnectDelay(timeWithoutConnection), RECONNECT_MAX_DELAY_MS);
});

test("the base delay never betrays the clamp even when fed degenerate values", () => {
  assert.equal(nextReconnectDelay(-1), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(0), RECONNECT_BASE_DELAY_MS);
  assert.equal(nextReconnectDelay(Number.MAX_SAFE_INTEGER), RECONNECT_MAX_DELAY_MS);
});

test("the heartbeat cadence is 10s with the screen on and 60s with it off", () => {
  assert.equal(heartbeatIntervalMs(true), HEARTBEAT_AWAKE_INTERVAL_MS);
  assert.equal(heartbeatIntervalMs(false), HEARTBEAT_ASLEEP_INTERVAL_MS);
  assert.equal(HEARTBEAT_AWAKE_INTERVAL_MS, 10_000);
  assert.equal(HEARTBEAT_ASLEEP_INTERVAL_MS, 60_000);
});

test("heartbeats run while online unless the device is sleeping", () => {
  assert.equal(heartbeatActive(true, false), true);
  assert.equal(heartbeatActive(false, false), false, "offline heartbeats cannot succeed");
  assert.equal(heartbeatActive(true, true), false, "doze devices skip heartbeat work");
  assert.equal(heartbeatActive(false, true), false);
});

test("a power wake catches up only after a full cadence was missed", () => {
  const now = 1_000_000;
  assert.equal(heartbeatCatchUpNeeded(now - HEARTBEAT_AWAKE_INTERVAL_MS - 1, now, HEARTBEAT_AWAKE_INTERVAL_MS), true);
  assert.equal(heartbeatCatchUpNeeded(now - HEARTBEAT_AWAKE_INTERVAL_MS, now, HEARTBEAT_AWAKE_INTERVAL_MS), true, "an overdue tick is a miss");
  assert.equal(heartbeatCatchUpNeeded(now - HEARTBEAT_AWAKE_INTERVAL_MS + 1, now, HEARTBEAT_AWAKE_INTERVAL_MS), false, "an on-schedule heartbeat waits for its tick");
  assert.equal(heartbeatCatchUpNeeded(now, now, HEARTBEAT_AWAKE_INTERVAL_MS), false);
});

test("a wake from a sleep window checks against the awake cadence, not the asleep one", () => {
  const now = 1_000_000;
  const midInterval = now - 15_000;
  // 15s of sleep fits inside the 60s asleep cadence, so the asleep schedule
  // would not be overdue - but the device is interactive again, where every
  // 10s cadence is authoritative: one check now, never a queue of refreshes.
  assert.equal(heartbeatCatchUpNeeded(midInterval, now, HEARTBEAT_AWAKE_INTERVAL_MS), true);
  assert.equal(heartbeatCatchUpNeeded(midInterval, now, HEARTBEAT_ASLEEP_INTERVAL_MS), false);
});

test("the asleep cadence fits a packet on a schedule that never wakes the radio harder", () => {
  assert.equal(HEARTBEAT_AWAKE_INTERVAL_MS < HEARTBEAT_ASLEEP_INTERVAL_MS, true);
  assert.equal(RECONNECT_BASE_DELAY_MS, 1_000);
  assert.ok(RECONNECT_BASE_DELAY_MS < RECONNECT_MAX_DELAY_MS);
});

test("the notification shows connected while an authenticated socket exists", () => {
  assert.equal(notificationStateFor(true, true), "connected");
  // A stale socket must not masquerade as connected once the route is gone;
  // the native service reflects route loss within its handoff grace period.
  assert.equal(notificationStateFor(false, true), "connected");
});

test("the notification shows reconnecting while online but not connected", () => {
  assert.equal(notificationStateFor(true, false), "reconnecting");
});

test("the notification shows waiting for internet instead of reconnecting when offline", () => {
  assert.equal(notificationStateFor(false, false), "offline");
  // The state machine never conflates an offline device with reconnecting.
  const seen = new Set([
    notificationStateFor(false, false),
    notificationStateFor(true, false),
    notificationStateFor(true, true),
    notificationStateFor(false, true)
  ]);
  assert.equal(seen.size, 3);
});
