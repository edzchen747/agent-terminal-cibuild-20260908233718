import assert from "node:assert/strict";
import test from "node:test";
import { sortHostsByLastConnected, defaultHostAfterRemoval, lastConnectedLabel } from "./hostSelection.ts";

const day = 86_400_000;
const NOW = 1_000_000_000_000;

test("hosts list: most recently connected first, stable otherwise", () => {
  const hosts = [
    { id: "a", lastConnectedAt: NOW - 3 * day },
    { id: "b", lastConnectedAt: NOW - 1 * day },
    { id: "c" },
    { id: "d", lastConnectedAt: NOW - 3 * day },
    { id: "e" }
  ];
  assert.deepEqual(sortHostsByLastConnected(hosts).map((host) => host.id), ["b", "a", "d", "c", "e"]);
});

test("hosts list: an empty list stays empty", () => {
  assert.deepEqual(sortHostsByLastConnected([]), []);
});

test("default host after removal is the most recent survivor", () => {
  const remaining = [
    { id: "a", lastConnectedAt: NOW - 5 * day },
    { id: "b", lastConnectedAt: NOW - 1 * day }
  ];
  assert.equal(defaultHostAfterRemoval(remaining)?.id, "b");
});

test("default host after removal is null when nothing remains", () => {
  assert.equal(defaultHostAfterRemoval([]), null);
});

test("default host after removal: a missing timestamp counts as oldest", () => {
  const remaining = [
    { id: "a" },
    { id: "b", lastConnectedAt: NOW - 9 * day }
  ];
  assert.equal(defaultHostAfterRemoval(remaining)?.id, "b");
});

test("last connected label uses relative buckets", () => {
  assert.equal(lastConnectedLabel(undefined, NOW), "Never");
  assert.equal(lastConnectedLabel(NOW - 30_000, NOW), "Just now");
  assert.equal(lastConnectedLabel(NOW - 9 * 60_000, NOW), "9 min ago");
  assert.equal(lastConnectedLabel(NOW - 5 * 3_600_000, NOW), "5 hours ago");
  assert.equal(lastConnectedLabel(NOW - 3 * day, NOW), "3 days ago");
});

test("last connected label falls back to a date for old hosts", () => {
  assert.equal(lastConnectedLabel(NOW - 30 * day, NOW), new Date(NOW - 30 * day).toLocaleDateString());
});
