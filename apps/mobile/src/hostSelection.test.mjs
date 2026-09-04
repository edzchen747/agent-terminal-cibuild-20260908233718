import assert from "node:assert/strict";
import test from "node:test";
import { sortHostsByLastConnected, defaultHostAfterRemoval, lastConnectedLabel, hostRowRegistrationStatus, hostRowStatusLabel, hostsPageCheckPlan, registrationDisplayStatusFor, REGISTRATION_STATUS_LABELS } from "./hostSelection.ts";

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

test("hosts list: equal timestamps keep insertion order", () => {
  const hosts = [
    { id: "x", lastConnectedAt: NOW - 2 * day },
    { id: "y", lastConnectedAt: NOW - 2 * day }
  ];
  assert.deepEqual(sortHostsByLastConnected(hosts).map((host) => host.id), ["x", "y"]);
});

test("hosts list: a zero timestamp sorts as never connected", () => {
  const hosts = [
    { id: "a", lastConnectedAt: 0 },
    { id: "b", lastConnectedAt: NOW - 1 * day }
  ];
  assert.deepEqual(sortHostsByLastConnected(hosts).map((host) => host.id), ["b", "a"]);
});

test("hosts list: sorting never mutates the caller's array", () => {
  const hosts = [
    { id: "a", lastConnectedAt: NOW - 3 * day },
    { id: "b", lastConnectedAt: NOW - 1 * day }
  ];
  const snapshot = JSON.stringify(hosts);
  sortHostsByLastConnected(hosts);
  assert.equal(JSON.stringify(hosts), snapshot);
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

test("default host after removal: a tied most-recent timestamp picks the first survivor", () => {
  const remaining = [
    { id: "a", lastConnectedAt: NOW - 1 * day },
    { id: "b", lastConnectedAt: NOW - 1 * day }
  ];
  assert.equal(defaultHostAfterRemoval(remaining)?.id, "a");
});

test("last connected label uses relative buckets", () => {
  assert.equal(lastConnectedLabel(undefined, NOW), "Never");
  assert.equal(lastConnectedLabel(NOW - 30_000, NOW), "Just now");
  assert.equal(lastConnectedLabel(NOW - 9 * 60_000, NOW), "9 min ago");
  assert.equal(lastConnectedLabel(NOW - 5 * 3_600_000, NOW), "5 hours ago");
  assert.equal(lastConnectedLabel(NOW - 3 * day, NOW), "3 days ago");
});

test("last connected label snaps every bucket boundary", () => {
  assert.equal(lastConnectedLabel(NOW, NOW), "Just now");
  assert.equal(lastConnectedLabel(NOW - 59_999, NOW), "Just now");
  assert.equal(lastConnectedLabel(NOW - 60_000, NOW), "1 min ago");
  assert.equal(lastConnectedLabel(NOW - 3_599_999, NOW), "59 min ago");
  assert.equal(lastConnectedLabel(NOW - 3_600_000, NOW), "1 hours ago");
  assert.equal(lastConnectedLabel(NOW - 86_399_999, NOW), "23 hours ago");
  assert.equal(lastConnectedLabel(NOW - 86_400_000, NOW), "1 days ago");
  assert.equal(lastConnectedLabel(NOW - 6 * day, NOW), "6 days ago");
});

test("a future timestamp clamps to 'Just now' like a clock-skewed host", () => {
  assert.equal(lastConnectedLabel(NOW + 3_600_000, NOW), "Just now");
});

test("a zero timestamp is treated as never", () => {
  assert.equal(lastConnectedLabel(0, NOW), "Never");
});

test("last connected label falls back to a date for old hosts", () => {
  assert.equal(lastConnectedLabel(NOW - 30 * day, NOW), new Date(NOW - 30 * day).toLocaleDateString());
});

test("host row registration: a never-registered host shows LAN only immediately", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: undefined, isCurrent: false, liveStatus: "enrolled", check: undefined }), "unregistered");
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: false, isCurrent: false, liveStatus: "enrolled", check: undefined }), "unregistered");
});

test("host row registration: a registered host stays checking until the check returns", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "enrolled", check: undefined }), "pending");
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "enrolled", check: "checking" }), "pending");
});

test("host row registration: only a verified check shows ready", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "unregistered", check: "verified" }), "enrolled");
});

test("host row registration: a tsnet-timeout check shows Error", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "unregistered", check: "error" }), "error");
  assert.equal(hostRowStatusLabel("error", false), "Error");
  assert.equal(hostRowStatusLabel("error", true), "Error");
});

test("host row registration: an error verdict stays authoritative over a cleared flag", () => {
  // A check that read "Error" is the freshest fact we have - even a row that
  // lost its enrollment flag (or never had one) shows the check's verdict,
  // because a hung tsnet is more informative than a stale LAN-only badge.
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: false, isCurrent: false, liveStatus: "failed", check: "error" }), "error");
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: undefined, isCurrent: false, liveStatus: "enrolled", check: "error" }), "error");
});

test("host row registration: the live desktop's badge never shows a check error", () => {
  // The connected desktop's badge mirrors the live session state, never the
  // background check's verdict.
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: true, liveStatus: "enrolled", check: "error" }), "enrolled");
});

test("host row registration: a failed check falls back to LAN only even when previously registered", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "enrolled", check: "lanOnly" }), "unregistered");
});

test("host row registration: a check that found the registered desktop down shows offline", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "enrolled", check: "offline" }), "offline");
});

test("host row registration: the connected desktop uses its live registration state", () => {
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: true, liveStatus: "pending", check: undefined }), "pending");
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: true, liveStatus: "failed", check: undefined }), "failed");
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: false, isCurrent: true, liveStatus: "offline", check: undefined }), "offline");
});

test("registration labels cover every display status exactly once", () => {
  assert.deepEqual(REGISTRATION_STATUS_LABELS, {
    unregistered: "LAN only",
    pending: "Registering",
    enrolled: "Ready",
    failed: "Failed",
    offline: "Offline",
    error: "Error"
  });
});

test("registration display status follows the live verdict while online", () => {
  for (const status of ["unregistered", "pending", "enrolled", "failed"]) {
    assert.equal(registrationDisplayStatusFor(status, true), status);
  }
});

test("registration display status shows offline for every verdict while the phone has no route", () => {
  for (const status of ["unregistered", "pending", "enrolled", "failed"]) {
    assert.equal(registrationDisplayStatusFor(status, false), "offline");
  }
});

test("host row labels: a checking row says Checking but the live row says Registering", () => {
  assert.equal(hostRowStatusLabel("pending", true), "Registering");
  assert.equal(hostRowStatusLabel("pending", false), "Checking");
  assert.equal(hostRowStatusLabel("enrolled", false), "Ready");
  assert.equal(hostRowStatusLabel("unregistered", false), "LAN only");
  assert.equal(hostRowStatusLabel("failed", false), "Failed");
  assert.equal(hostRowStatusLabel("offline", false), "Offline");
});

test("host row labels: a checked row with a live check verdict that never finished - edge cases", () => {
  // A host whose check returned verified shows Ready even when the flag got
  // cleared underneath it (the check result is the authoritative verdict).
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: false, isCurrent: false, liveStatus: "failed", check: "verified" }), "enrolled");
  // A row the check explicitly marked LAN only never shows Ready, even when
  // a stale flag says otherwise.
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "enrolled", check: "lanOnly" }), "unregistered");
  // A registered host with no check result yet stays checking, not failed.
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: false, liveStatus: "failed", check: undefined }), "pending");
  // An offline verdict is equally authoritative over a cleared flag.
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: false, isCurrent: false, liveStatus: "failed", check: "offline" }), "offline");
  // The live desktop's badge never takes the background check, offline or not.
  assert.equal(hostRowRegistrationStatus({ remoteEnrolled: true, isCurrent: true, liveStatus: "enrolled", check: "offline" }), "enrolled");
});

// ---- hostsPageCheckPlan: registration-check targeting ------------------------

test("checks plan: the live desktop and never-registered hosts are skipped", () => {
  const records = [
    { id: "live", remoteEnrolled: true },
    { id: "never", remoteEnrolled: undefined },
    { id: "flagless", remoteEnrolled: false },
    { id: "enrolled-a", remoteEnrolled: true },
    { id: "enrolled-b", remoteEnrolled: true }
  ];
  const plan = hostsPageCheckPlan({ records, liveHostId: "live", cached: new Map(), force: false });
  assert.deepEqual(plan.pending.map((record) => record.id), ["enrolled-a", "enrolled-b"]);
  assert.deepEqual(plan.toVerify.map((record) => record.id), ["enrolled-a", "enrolled-b"]);
  assert.deepEqual([...plan.states], [["enrolled-a", "checking"], ["enrolled-b", "checking"]]);
});

test("checks plan: a plain visit reuses cached verdicts instead of re-verifying", () => {
  const records = [
    { id: "a", remoteEnrolled: true },
    { id: "b", remoteEnrolled: true },
    { id: "c", remoteEnrolled: true }
  ];
  const cached = new Map([
    ["a", "verified"],
    ["b", "lanOnly"]
  ]);
  const plan = hostsPageCheckPlan({ records, liveHostId: null, cached, force: false });
  assert.deepEqual(plan.toVerify.map((record) => record.id), ["c"]);
  assert.deepEqual([...plan.states], [
    ["a", "verified"],
    ["b", "lanOnly"],
    ["c", "checking"]
  ]);
});

test("checks plan: a stale cache entry is never trusted on a plain visit", () => {
  const records = [{ id: "old", remoteEnrolled: true }];
  const plan = hostsPageCheckPlan({ records, liveHostId: undefined, cached: new Map(), force: false });
  assert.deepEqual(plan.toVerify.map((record) => record.id), ["old"]);
  assert.equal(plan.states.get("old"), "checking");
  // A cached lanOnly verdict holds its host back from the round entirely.
  assert.deepEqual(hostsPageCheckPlan({ records, liveHostId: undefined, cached: new Map([["old", "lanOnly"]]), force: false }).toVerify, []);
  // A cached offline verdict holds its host back just the same.
  assert.deepEqual(hostsPageCheckPlan({ records, liveHostId: undefined, cached: new Map([["old", "offline"]]), force: false }).toVerify, []);
});

test("checks plan: a cached tsnet-timeout verdict keeps the host in error", () => {
  const records = [{ id: "e", remoteEnrolled: true }];
  // A cached error verdict holds the host back from a plain-visit round.
  const plan = hostsPageCheckPlan({ records, liveHostId: null, cached: new Map([["e", "error"]]), force: false });
  assert.deepEqual(plan.toVerify, []);
  assert.equal(plan.states.get("e"), "error");
  // A manual refresh re-verifies the host despite the cached error.
  assert.deepEqual(hostsPageCheckPlan({ records, liveHostId: null, cached: new Map([["e", "error"]]), force: true }).toVerify.map((record) => record.id), ["e"]);
});

test("checks plan: a cached verdict never reaches a never-registered host", () => {
  // The plan consults the cache only for registered hosts; a stray cached
  // verdict for an unregistered row must not leak into its state.
  const records = [
    { id: "u", remoteEnrolled: false },
    { id: "r", remoteEnrolled: true }
  ];
  const plan = hostsPageCheckPlan({ records, liveHostId: null, cached: new Map([["u", "error"], ["r", "error"]]), force: false });
  assert.equal(plan.states.has("u"), false);
  assert.equal(plan.states.get("r"), "error");
  assert.deepEqual(plan.toVerify, []);
});

test("checks plan: a manual refresh forces verification for every registered host", () => {
  const records = [
    { id: "live", remoteEnrolled: true },
    { id: "a", remoteEnrolled: true },
    { id: "b", remoteEnrolled: true }
  ];
  const cached = new Map([
    ["a", "verified"],
    ["b", "lanOnly"]
  ]);
  const plan = hostsPageCheckPlan({ records, liveHostId: "live", cached, force: true });
  assert.deepEqual(plan.pending.map((record) => record.id), ["a", "b"]);
  assert.deepEqual(plan.toVerify.map((record) => record.id), ["a", "b"]);
  assert.deepEqual([...plan.states], [["a", "checking"], ["b", "checking"]]);
});

test("checks plan: empty records and empty caches stay no-ops", () => {
  const empty = hostsPageCheckPlan({ records: [], liveHostId: null, cached: new Map(), force: false });
  assert.deepEqual(empty.pending, []);
  assert.deepEqual(empty.toVerify, []);
  assert.equal(empty.states.size, 0);
  // A cache entry for a record that is not in the list does nothing.
  const phantom = hostsPageCheckPlan({ records: [], liveHostId: null, cached: new Map([["ghost", "verified"]]), force: false });
  assert.deepEqual(phantom.toVerify, []);
  assert.equal(phantom.states.size, 0);
});

test("checks plan: never mutates the caller's cache or records", () => {
  const records = [{ id: "a", remoteEnrolled: true }];
  const cached = new Map([["a", "verified"]]);
  const cacheSizeBefore = cached.size;
  const recordsJson = JSON.stringify(records);
  hostsPageCheckPlan({ records, liveHostId: null, cached, force: true });
  assert.equal(cached.size, cacheSizeBefore);
  assert.equal(cached.get("a"), "verified");
  assert.equal(JSON.stringify(records), recordsJson);
});
