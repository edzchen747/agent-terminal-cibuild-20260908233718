import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedVerdict,
  rememberVerdict,
  registrationCacheTtlMs,
  removeVerdict
} from "./registrationCache.ts";

const NOW = 1_000_000_000_000;

test("cache TTLs are one minute for hosts-page pings and one hour for the startup check", () => {
  assert.equal(registrationCacheTtlMs("hostPing"), 60_000);
  assert.equal(registrationCacheTtlMs("nodeCheck"), 3_600_000);
});

test("cached verdict: a missing host has no verdict", () => {
  assert.equal(cachedVerdict({}, "host-a", NOW, 60_000), null);
  assert.equal(cachedVerdict(undefined, "host-a", NOW, 60_000), null);
});

test("cached verdict: an empty map has no verdict", () => {
  assert.equal(cachedVerdict({ other: { at: NOW, verdict: "verified" } }, "host-a", NOW, 60_000), null);
});

test("cached verdict: a fresh entry is returned", () => {
  const entries = { "host-a": { at: NOW - 5_000, verdict: "verified" } };
  assert.equal(cachedVerdict(entries, "host-a", NOW, 60_000), "verified");
  assert.equal(cachedVerdict(entries, "host-a", NOW, 60_000), "verified");
});

test("cached verdict: a `lanOnly` verdict is cached like any other", () => {
  const entries = { "host-a": { at: NOW - 30_000, verdict: "lanOnly" } };
  assert.equal(cachedVerdict(entries, "host-a", NOW, 3_600_000), "lanOnly");
});

test("cached verdict: an `offline` verdict is cached and replaced like any other", () => {
  // The offline verdict shares the same entry shape and expiration as the
  // other verdicts: a fresh one is returned and a later verdict overwrites.
  const entries = { "host-a": { at: NOW - 30_000, verdict: "offline" } };
  assert.equal(cachedVerdict(entries, "host-a", NOW, 60_000), "offline");
  assert.deepEqual(rememberVerdict(entries, "host-a", "verified", NOW)["host-a"], { at: NOW, verdict: "verified" });
  assert.deepEqual(rememberVerdict(entries, "host-b", "offline", NOW)["host-b"], { at: NOW, verdict: "offline" });
});

test("cached verdict: an expired entry is treated as absent", () => {
  const entries = { "host-a": { at: NOW - 60_000, verdict: "verified" } };
  assert.equal(cachedVerdict(entries, "host-a", NOW, 60_000), null);
});

test("cached verdict: expiry is exclusive - the exact TTL boundary is stale", () => {
  const entries = { "host-a": { at: NOW - 60_000, verdict: "verified" } };
  assert.equal(cachedVerdict(entries, "host-a", NOW, 60_000), null);
  assert.equal(cachedVerdict(entries, "host-a", NOW + 1000, 60_000), null);
  assert.equal(cachedVerdict(entries, "host-a", NOW - 60_000 + 1, 60_000), "verified");
  assert.equal(cachedVerdict(entries, "host-a", NOW - 60_000 - 1, 60_000), "verified");
});

test("cached verdict: a future recorded timestamp is not treated as expired", () => {
  const entries = { "host-a": { at: NOW + 5_000, verdict: "verified" } };
  assert.equal(cachedVerdict(entries, "host-a", NOW, 60_000), "verified");
});

test("remembering a verdict keeps every other host's entry", () => {
  const entries = { "host-a": { at: NOW - 5_000, verdict: "verified" } };
  const next = rememberVerdict(entries, "host-b", "lanOnly", NOW);

  assert.deepEqual(next["host-a"], { at: NOW - 5_000, verdict: "verified" });
  assert.deepEqual(next["host-b"], { at: NOW, verdict: "lanOnly" });
});

test("remembering a verdict overwrites only the same host's entry", () => {
  const entries = { "host-a": { at: NOW - 5_000, verdict: "verified" } };
  const next = rememberVerdict(entries, "host-a", "lanOnly", NOW);

  assert.deepEqual(next["host-a"], { at: NOW, verdict: "lanOnly" });
});

test("remembering into an empty or undefined map starts a new entry", () => {
  assert.deepEqual(rememberVerdict(undefined, "host-a", "verified", NOW), { "host-a": { at: NOW, verdict: "verified" } });
  assert.deepEqual(rememberVerdict({}, "host-a", "verified", NOW), { "host-a": { at: NOW, verdict: "verified" } });
});

test("removing a host's verdict keeps every other entry", () => {
  const entries = { "host-a": { at: NOW, verdict: "verified" }, "host-b": { at: NOW, verdict: "lanOnly" } };
  const next = removeVerdict(entries, "host-a");

  assert.deepEqual(next["host-a"], undefined);
  assert.deepEqual(next["host-b"], { at: NOW, verdict: "lanOnly" });
});

test("removing an absent id is a no-op", () => {
  const entries = { "host-a": { at: NOW, verdict: "verified" } };
  assert.deepEqual(removeVerdict(entries, "host-b"), entries);
  assert.deepEqual(removeVerdict(undefined, "host-a"), {});
});

test("the cache map is never mutated by remember or remove", () => {
  const entries = { "host-a": { at: NOW - 5_000, verdict: "verified" } };
  const snapshot = JSON.stringify(entries);
  rememberVerdict(entries, "host-b", "lanOnly", NOW);
  removeVerdict(entries, "host-a");

  assert.equal(JSON.stringify(entries), snapshot);
});
