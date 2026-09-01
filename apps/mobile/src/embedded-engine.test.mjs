import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { breakStorageRemove, resetStorage } from "./test-support.mjs";

const { EmbeddedNodeEngine } = await import("./embedded-engine.ts");

const EMPTY_KEY = "agent-terminal-embedded-node";
const ENGINE_KEY = (id) => `agent-terminal-embedded-node-${id}`;

beforeEach(() => resetStorage());
afterEach(() => resetStorage());

// ---- identity generation and persistence ------------------------------------

test("start mints a node identity on first use", async () => {
  const engine = new EmbeddedNodeEngine("h1");
  const state = await engine.start();
  assert.ok(state.privateKey.length > 0);
  assert.ok(state.nodeId.length > 0);
  assert.equal(state.engineStarted, false);
  assert.equal(state.proxyEndpoint, undefined);
});

test("the identity is persisted under a per-host key", async () => {
  await new EmbeddedNodeEngine("h1").start();
  const persisted = JSON.parse((await Preferences.get({ key: ENGINE_KEY("h1") })).value);
  assert.ok(persisted.privateKey.length > 0);
  assert.ok(persisted.nodeId.length > 0);
  assert.equal((await Preferences.get({ key: EMPTY_KEY })).value, null);
});

test("a second start on the same host reuses the stored identity", async () => {
  const engine = new EmbeddedNodeEngine("h1");
  const first = await engine.start();
  const second = await engine.start();
  assert.equal(second.privateKey, first.privateKey);
  assert.equal(second.nodeId, first.nodeId);
});

test("a fresh engine for the same host reuses the stored identity", async () => {
  await new EmbeddedNodeEngine("h1").start();
  const reloaded = await new EmbeddedNodeEngine("h1").start();
  const original = JSON.parse((await Preferences.get({ key: ENGINE_KEY("h1") })).value);
  assert.equal(reloaded.privateKey, original.privateKey);
  assert.equal(reloaded.nodeId, original.nodeId);
});

test("each host gets an isolated identity and storage key", async () => {
  await new EmbeddedNodeEngine("a").start();
  await new EmbeddedNodeEngine("b").start();
  const a = JSON.parse((await Preferences.get({ key: ENGINE_KEY("a") })).value);
  const b = JSON.parse((await Preferences.get({ key: ENGINE_KEY("b") })).value);
  assert.notEqual(a.nodeId, b.nodeId);
  assert.ok((await Preferences.get({ key: ENGINE_KEY("a") })).value);
  assert.ok((await Preferences.get({ key: ENGINE_KEY("b") })).value);
});

test("the legacy engine without a host uses the shared key", async () => {
  await new EmbeddedNodeEngine().start();
  const state = JSON.parse((await Preferences.get({ key: EMPTY_KEY })).value);
  assert.ok(state.privateKey.length > 0);
  assert.ok(state.nodeId.length > 0);
});

// ---- corrupt state ----------------------------------------------------------

test("a corrupt stored record is replaced with a fresh identity", async () => {
  await Preferences.set({ key: ENGINE_KEY("h1"), value: "{corrupt" });
  const state = await new EmbeddedNodeEngine("h1").start();
  const stored = JSON.parse((await Preferences.get({ key: ENGINE_KEY("h1") })).value);
  assert.equal(stored.privateKey, state.privateKey);
  assert.ok(state.privateKey.length > 0);
});

test("a partial stored record (key without node id) is replaced too", async () => {
  await Preferences.set({ key: ENGINE_KEY("h1"), value: JSON.stringify({ privateKey: "only-a-key" }) });
  const state = await new EmbeddedNodeEngine("h1").start();
  assert.ok(state.privateKey.length > 0);
  assert.ok(state.nodeId.length > 0);
});

// ---- start/stop semantics ---------------------------------------------------

test("start records the control URL and a fresh lastConnectedAt", async () => {
  const state = await new EmbeddedNodeEngine("h1").start("https://ctrl.example");
  assert.equal(state.controlUrl, "https://ctrl.example");
  assert.equal(typeof state.lastConnectedAt, "string");
  assert.ok(Date.parse(state.lastConnectedAt) <= Date.now() + 1000);
});

test("an overlay start without a native engine reports engineStarted false", async () => {
  const state = await new EmbeddedNodeEngine("h1").start();
  assert.equal(state.engineStarted, false);
  assert.equal(state.proxyEndpoint, undefined);
});

test("stop on the web platform is a safe no-op", async () => {
  const engine = new EmbeddedNodeEngine("h1");
  await engine.start();
  await assert.doesNotReject(() => engine.stop());
  assert.ok((await Preferences.get({ key: ENGINE_KEY("h1") })).value);
});

test("forget drops only that host's identity", async () => {
  await new EmbeddedNodeEngine("a").start();
  await new EmbeddedNodeEngine("b").start();
  await EmbeddedNodeEngine.forget("a");
  assert.equal((await Preferences.get({ key: ENGINE_KEY("a") })).value, null);
  assert.ok((await Preferences.get({ key: ENGINE_KEY("b") })).value);
});

test("forget of the legacy key is a safe no-op", async () => {
  await assert.doesNotReject(() => EmbeddedNodeEngine.forget("legacy"));
});

// ---- forget with the native stop path ---------------------------------------
//
// Forcing the native platform probe on means the stop call goes through the
// plugin proxy. In Node that proxy has no implementation, so the stop
// rejects (UNIMPLEMENTED) - the failure the fire-and-forget catch in forget
// must swallow without delaying or rejecting the unpair.
function withNativePlatform(run) {
  const real = Capacitor.isNativePlatform;
  Capacitor.isNativePlatform = () => true;
  return Promise.resolve().then(run).finally(() => { Capacitor.isNativePlatform = real; });
}

test("forget resolves and drops the identity even when the native stop fails", async () => {
  await new EmbeddedNodeEngine("h1").start();
  await new EmbeddedNodeEngine("h2").start();
  await withNativePlatform(async () => {
    await assert.doesNotReject(() => EmbeddedNodeEngine.forget("h1"));
  });
  assert.equal((await Preferences.get({ key: ENGINE_KEY("h1") })).value, null);
  // The failed stop must not leak into the sibling host's state.
  assert.ok((await Preferences.get({ key: ENGINE_KEY("h2") })).value);
});

test("forget of a host with no stored identity still fires the native stop", async () => {
  // The unpair must not depend on local state: the stop is best effort but
  // must still be attempted, and its failure must not reject the forget.
  await withNativePlatform(async () => {
    await assert.doesNotReject(() => EmbeddedNodeEngine.forget("ghost"));
  });
});

test("forget rejects when the stored identity itself cannot be removed", async () => {
  // Contrast with the stop failures above: the identity removal is the
  // primary purpose of forget, so a storage failure propagates.
  await new EmbeddedNodeEngine("h1").start();
  const restore = breakStorageRemove();
  try {
    await assert.rejects(() => EmbeddedNodeEngine.forget("h1"), /storage unavailable/);
  } finally {
    restore();
  }
  assert.ok((await Preferences.get({ key: ENGINE_KEY("h1") })).value);
});

test("generated identities use an unpadded url-safe key", async () => {
  const { privateKey } = await new EmbeddedNodeEngine("h1").start();
  assert.match(privateKey, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(privateKey, /=/);
});
