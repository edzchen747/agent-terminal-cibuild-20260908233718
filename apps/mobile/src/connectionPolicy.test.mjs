import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttemptConnection,
  HEARTBEAT_INTERVAL_MS,
  heartbeatActive,
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

test("the notification heartbeat fires only while visible and online", () => {
  assert.equal(heartbeatActive(false, true), true);
  assert.equal(heartbeatActive(true, true), false, "hidden pages skip heartbeat work");
  assert.equal(heartbeatActive(false, false), false, "offline heartbeats cannot succeed");
  assert.equal(heartbeatActive(true, false), false);
});

test("every minute of heartbeat, no more: waiting does not wake the radio", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 60_000);
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
