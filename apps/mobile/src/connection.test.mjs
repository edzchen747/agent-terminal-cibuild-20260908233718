import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { Preferences } from "@capacitor/preferences";
import { breakStorage, resetStorage } from "./test-support.mjs";

// The file uses a TypeScript parameter property (constructor(public
// readonly host)), which the plain type-stripping mode rejects, so the
// suite must run under `--experimental-transform-types` (see package.json).
// test-support.mjs is imported statically first: it installs the
// window.localStorage shim and the extensionless-.ts resolve hook the
// modules below need.
const { HostConnection } = await import("./connection.ts");

const HOST_KEY = "agent-terminal-host";
const HOSTS_KEY = "agent-terminal-hosts";
const ENGINE_KEY = (id) => `agent-terminal-embedded-node-${id}`;

const host = (overrides = {}) => ({
  id: "h1",
  name: "Desktop One",
  endpoint: "ws://192.168.1.5:47831",
  deviceId: "phone-1",
  deviceToken: "token-1",
  ...overrides
});

beforeEach(() => resetStorage());
afterEach(() => resetStorage());

// ---- savedHostRecords: parsing and defense ---------------------------------

test("savedHostRecords returns an empty list when nothing is stored", async () => {
  assert.deepEqual(await HostConnection.savedHostRecords(), []);
});

test("savedHostRecords tolerates a corrupt value", async () => {
  await Preferences.set({ key: HOSTS_KEY, value: "{not json" });
  assert.deepEqual(await HostConnection.savedHostRecords(), []);
});

test("savedHostRecords ignores a non-array value", async () => {
  for (const value of ['{"a":1}', '"text"', "42"]) {
    await Preferences.set({ key: HOSTS_KEY, value });
    assert.deepEqual(await HostConnection.savedHostRecords(), [], value);
  }
});

test("savedHostRecords drops malformed entries and keeps the valid ones", async () => {
  const good = { ...host(), remoteEnrolled: true, lastConnectedAt: 1234 };
  await Preferences.set({
    key: HOSTS_KEY,
    value: JSON.stringify([
      good,
      null,
      { name: "No id" },
      { id: 7, name: "Numeric id" },
      { id: "no-name" },
      { id: "b", name: "Short" }
    ])
  });
  const records = await HostConnection.savedHostRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], good);
  assert.deepEqual(records[1], { id: "b", name: "Short" });
});

// ---- recordHost: append and upsert -----------------------------------------

test("recordHost appends a new desktop without a connected timestamp", async () => {
  await HostConnection.recordHost(host());
  const records = await HostConnection.savedHostRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "h1");
  assert.equal(records[0].lastConnectedAt, undefined);
});

test("recordHost upserts in place, refreshing fields but preserving the timestamp", async () => {
  await HostConnection.recordHost(host());
  await HostConnection.markHostConnected("h1");
  const before = (await HostConnection.savedHostRecords())[0];
  await HostConnection.recordHost({ ...host(), name: "Renamed", deviceToken: "token-2" });
  const after = (await HostConnection.savedHostRecords())[0];
  assert.equal(after.id, "h1");
  assert.equal(after.name, "Renamed");
  assert.equal(after.deviceToken, "token-2");
  assert.equal(after.lastConnectedAt, before.lastConnectedAt);
});

test("recordHost keeps every other entry untouched", async () => {
  await HostConnection.recordHost(host());
  await HostConnection.recordHost({ ...host({ id: "h2", name: "Two" }) });
  await HostConnection.recordHost({ ...host(), name: "Updated" });
  const records = await HostConnection.savedHostRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(records[1], { ...host({ id: "h2", name: "Two" }) });
});

test("recordHost never resurrects a removed record's timestamp", async () => {
  await HostConnection.recordHost(host());
  await HostConnection.markHostConnected("h1");
  const records = await HostConnection.removeSavedHostRecord("h1");
  assert.equal(records.length, 0);
  await HostConnection.recordHost(host());
  const readded = (await HostConnection.savedHostRecords())[0];
  assert.equal(readded.lastConnectedAt, undefined);
});

// ---- markHostConnected ------------------------------------------------------

test("markHostConnected is a no-op for an unknown desktop", async () => {
  await HostConnection.recordHost(host());
  await HostConnection.markHostConnected("nope");
  const records = await HostConnection.savedHostRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].lastConnectedAt, undefined);
});

test("markHostConnected stamps the matching record without touching others", async () => {
  await HostConnection.recordHost(host());
  await HostConnection.recordHost({ ...host({ id: "h2", name: "Two" }) });
  await HostConnection.markHostConnected("h2");
  const records = await HostConnection.savedHostRecords();
  assert.equal(records[0].id, "h1");
  assert.equal(records[0].lastConnectedAt, undefined);
  assert.equal(typeof records[1].lastConnectedAt, "number");
  assert.ok(records[1].lastConnectedAt <= Date.now());
});

// ---- removeSavedHostRecord --------------------------------------------------

test("removeSavedHostRecord drops the entry, its node identity, and returns the remainder", async () => {
  await HostConnection.recordHost(host({ id: "a" }));
  await HostConnection.recordHost(host({ id: "b", name: "Two" }));
  const { EmbeddedNodeEngine } = await import("./embedded-engine.ts");
  await new EmbeddedNodeEngine("a").start();
  assert.notEqual((await Preferences.get({ key: ENGINE_KEY("a") })).value, null);

  const remaining = await HostConnection.removeSavedHostRecord("a");
  assert.deepEqual(remaining.map((record) => record.id), ["b"]);
  assert.equal((await Preferences.get({ key: ENGINE_KEY("a") })).value, null);
  assert.equal((await Preferences.get({ key: ENGINE_KEY("b") })).value, null);
});

test("removeSavedHostRecord repoints the launch default to the most recent survivor", async () => {
  await HostConnection.saveHost(host({ id: "old" }));
  await HostConnection.recordHost(host({ id: "old" }));
  await HostConnection.recordHost(host({ id: "recent", name: "Recent" }));
  await HostConnection.recordHost(host({ id: "stale", name: "Stale" }));
  await HostConnection.markHostConnected("recent");
  await HostConnection.markHostConnected("stale");

  await HostConnection.removeSavedHostRecord("old");
  const saved = await HostConnection.saved();
  assert.equal(saved?.id, "recent");
  assert.deepEqual((await HostConnection.savedHostRecords()).map((record) => record.id), ["recent", "stale"]);
});

test("removeSavedHostRecord drops the launch default when nothing survives", async () => {
  await HostConnection.saveHost(host());
  await HostConnection.recordHost(host());
  await HostConnection.removeSavedHostRecord("h1");
  assert.equal(await HostConnection.saved(), null);
});

test("removeSavedHostRecord leaves the default alone when another desktop is removed", async () => {
  await HostConnection.saveHost(host());
  await HostConnection.recordHost(host());
  await HostConnection.recordHost(host({ id: "h2", name: "Two" }));
  await HostConnection.removeSavedHostRecord("h2");
  assert.equal((await HostConnection.saved())?.id, "h1");
});

test("removeSavedHostRecord is a no-op for an unknown id", async () => {
  await HostConnection.saveHost(host());
  await HostConnection.recordHost(host());
  const { EmbeddedNodeEngine } = await import("./embedded-engine.ts");
  await new EmbeddedNodeEngine("h1").start();
  const remaining = await HostConnection.removeSavedHostRecord("ghost");
  assert.equal(remaining.length, 1);
  assert.equal((await HostConnection.saved())?.id, "h1");
  assert.notEqual((await Preferences.get({ key: ENGINE_KEY("h1") })).value, null);
});

// ---- verifySavedHostRegistration --------------------------------------------

test("a never-registered desktop returns lanOnly and never starts a node", async () => {
  const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: false }));
  assert.equal(verdict, "lanOnly");
  assert.equal((await Preferences.get({ key: ENGINE_KEY("h1") })).value, null);
  assert.equal((await HostConnection.savedHostRecords())[0]?.remoteEnrolled, undefined);
});

test("an enrolled desktop verifies on the web platform without a native engine", async () => {
  const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
  assert.equal(verdict, "verified");
});

test("verification never mutates the persisted enrollment flag on the web platform", async () => {
  await HostConnection.saveHost(host({ remoteEnrolled: true }));
  await HostConnection.recordHost(host({ remoteEnrolled: true }));
  await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
  assert.equal((await HostConnection.saved())?.remoteEnrolled, true);
  assert.equal((await HostConnection.savedHostRecords())[0]?.remoteEnrolled, true);
});

test("an undefined enrollment flag counts as never registered", async () => {
  assert.equal(await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: undefined })), "lanOnly");
});

// ---- saved: launch default protection ---------------------------------------

test("saved returns the launch default across record mutations", async () => {
  await HostConnection.saveHost(host());
  await HostConnection.recordHost(host({ id: "h2", name: "Two" }));
  await HostConnection.removeSavedHostRecord("h2");
  assert.deepEqual(await HostConnection.saved(), host());
});

test("saved purges a legacy shared nodeAuthKey from storage", async () => {
  await Preferences.set({ key: HOST_KEY, value: JSON.stringify({ ...host(), nodeAuthKey: "leaked-key" }) });
  const saved = await HostConnection.saved();
  assert.equal(saved?.nodeAuthKey, undefined);
  const persisted = JSON.parse((await Preferences.get({ key: HOST_KEY })).value);
  assert.equal(persisted.nodeAuthKey, undefined);
});

test("saved returns null for a missing or corrupt launch default", async () => {
  assert.equal(await HostConnection.saved(), null);
  await Preferences.set({ key: HOST_KEY, value: "not json" });
  assert.equal(await HostConnection.saved(), null);
});

// ---- pair: the same-LAN guard ----------------------------------------------

test("pairing to a remote-only desktop without a LAN endpoint is rejected", async () => {
  const payload = {
    hostId: "h1",
    hostName: "Desktop One",
    pairingToken: "token",
    endpoint: "ws://192.168.1.5:47831",
    transport: "overlay",
    remoteEndpoint: "ws://h1.example:47831",
    remoteTransport: "overlay",
    controlUrl: "https://control.example"
  };
  await assert.rejects(
    HostConnection.pair(payload, { id: "phone", name: "Phone", platform: "android" }),
    /must be completed while the phone and desktop are on the same LAN/i
  );
});

// ---- saveHost / forget round trip -------------------------------------------

test("saveHost and forget round-trip the launch default", async () => {
  await HostConnection.saveHost(host());
  assert.equal((await HostConnection.saved())?.id, "h1");
  await HostConnection.forget();
  assert.equal(await HostConnection.saved(), null);
});

// ---- storage outage ---------------------------------------------------------

test("host record writes are safe when storage throws", async () => {
  const restore = breakStorage();
  try {
    await assert.rejects(HostConnection.recordHost(host()));
  } finally {
    restore();
  }
});
