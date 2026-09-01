import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { breakStorage, breakStorageRemove, resetStorage } from "./test-support.mjs";

// The file uses a TypeScript parameter property (constructor(public
// readonly host)), which the plain type-stripping mode rejects, so the
// suite must run under `--experimental-transform-types` (see package.json).
// test-support.mjs is imported statically first: it installs the
// window.localStorage shim and the extensionless-.ts resolve hook the
// modules below need.
const { HostConnection } = await import("./connection.ts");
const { EmbeddedNodeEngine } = await import("./embedded-engine.ts");

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

test("removing a record rejects when the node identity cannot be dropped", async () => {
  // Edge of the delete path: the list write precedes the identity removal,
  // so a partial storage failure leaves the record deleted in storage even
  // though the call rejects.
  await HostConnection.recordHost(host());
  const restore = breakStorageRemove();
  try {
    await assert.rejects(() => HostConnection.removeSavedHostRecord("h1"), /storage unavailable/);
  } finally {
    restore();
  }
  assert.deepEqual(await HostConnection.savedHostRecords(), []);
});

// ---- open(): connection failure messages -----------------------------------

// A stand-in for the platform WebSocket: it captures the socket open() creates
// so a test can drive its error/close/timeout paths on demand instead of
// reaching for the network.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  url;
  readyState = 0;
  onopen = null;
  onerror = null;
  onclose = null;
  onmessage = null;
  lastSent = null;
  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  setOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(payload) {
    this.lastSent = payload;
  }
  /** Delivers one server message, replying to the most recent client message. */
  serve(message) {
    this.onmessage?.({ data: JSON.stringify({ ...message, requestId: JSON.parse(this.lastSent).requestId }) });
  }
  deliverServerMessage(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
  }
}

function withFakeWebSocket(run) {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  return Promise.resolve().then(run).finally(() => { globalThis.WebSocket = real; });
}

// open is private; the message tests reach it directly instead of building a
// full auth handshake.
function openFailure(connection, url, timeoutMs) {
  return connection["open"](url, timeoutMs).then(
    () => { throw new Error("the fake socket never opens"); },
    (error) => error
  );
}

const UNREACHABLE_HOST_MESSAGE = "Could not reach the desktop host. Connect both devices to the same WiFi network with internet access.";

test("a socket error rejects with the shared-network hint", async () => {
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const pending = openFailure(connection, "ws://192.168.1.5:47831", 60_000);
    FakeWebSocket.instances.at(-1).onerror?.();
    const error = await pending;
    assert.equal(error.message, UNREACHABLE_HOST_MESSAGE);
    connection.close();
  });
});

test("a stalled socket still rejects with the timeout message", async () => {
  // The hint only belongs to the error path; the timeout message is untouched.
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const error = await openFailure(connection, "ws://192.168.1.5:47831", 25);
    assert.equal(error.message, "The desktop connection attempt timed out.");
    assert.equal(FakeWebSocket.instances.at(-1).readyState, 3);
    connection.close();
  });
});

test("a socket that closes before opening rejects with the setup-close message", async () => {
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const pending = openFailure(connection, "ws://192.168.1.5:47831", 60_000);
    FakeWebSocket.instances.at(-1).onclose?.();
    const error = await pending;
    assert.equal(error.message, "The desktop connection closed during setup.");
    connection.close();
  });
});

test("connect rejects with the shared-network hint when the desktop cannot be reached", async () => {
  // End-to-end through the public API: a remote-only host whose socket errors
  // surfaces the hint in the rejection the app shows on the try-again screen.
  const realOnLine = globalThis.navigator.onLine;
  globalThis.navigator.onLine = true;
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host({ remoteEndpoint: "ws://h1.overlay.example:47831", remoteTransport: "direct" }));
    connection.embeddedEngine = { start: async () => ({}), stop: async () => {} };
    const pending = connection.connect().then(
      () => { throw new Error("connect should have failed"); },
      (error) => error
    );
    // The stubbed engine start resolves on a microtask, so the socket does
    // not exist yet; drain the queue until the fake socket is constructed.
    while (FakeWebSocket.instances.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    FakeWebSocket.instances.at(-1).onerror?.();
    const error = await pending;
    assert.equal(error.message, UNREACHABLE_HOST_MESSAGE);
    connection.close();
  }).finally(() => { globalThis.navigator.onLine = realOnLine; });
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

test("a native engine failure with an unknown code stays lanOnly and keeps the enrollment flag", async () => {
  // Force the native platform probe: the engine start goes through the
  // plugin proxy, which rejects in Node (UNIMPLEMENTED) with a code that is
  // not remote_host_unavailable. Only the engine's own peer-dial failure may
  // mark a host offline; an unknown failure must leave it at LAN only.
  const realIsNative = Capacitor.isNativePlatform;
  Capacitor.isNativePlatform = () => true;
  try {
    await HostConnection.recordHost(host({ remoteEnrolled: true }));
    const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
    assert.equal(verdict, "lanOnly");
    assert.equal((await HostConnection.savedHostRecords())[0]?.remoteEnrolled, true);
  } finally {
    Capacitor.isNativePlatform = realIsNative;
  }
});

test("an undefined enrollment flag counts as never registered", async () => {
  assert.equal(await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: undefined })), "lanOnly");
});

// ---- verifySavedHostRegistration: native engine failures ---------------------
//
// The real plugin proxy cannot run in Node, so each failure code is injected
// by patching the engine's prototype. The native platform probe is forced on
// so verification takes the native branch; the patched stop records that the
// engine is torn down even when the start rejected.

function withNativeEngineRejecting(code, run) {
  const realIsNative = Capacitor.isNativePlatform;
  const originalStart = EmbeddedNodeEngine.prototype.start;
  const originalStop = EmbeddedNodeEngine.prototype.stop;
  let stopped = 0;
  Capacitor.isNativePlatform = () => true;
  EmbeddedNodeEngine.prototype.start = async () => {
    throw Object.assign(new Error("engine rejected"), { code });
  };
  EmbeddedNodeEngine.prototype.stop = async () => { stopped += 1; };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Capacitor.isNativePlatform = realIsNative;
      EmbeddedNodeEngine.prototype.start = originalStart;
      EmbeddedNodeEngine.prototype.stop = originalStop;
    })
    .then(() => stopped);
}

test("a dropped phone node during verification marks the host unregistered everywhere", async () => {
  // Only the phone-side node is gone (revoked or expired) and the desktop is
  // on LAN: the row falls back to LAN only and both the launch default and
  // the hosts list lose the enrollment flag, so the next remote connection
  // re-registers instead of trusting the stale flag.
  await HostConnection.saveHost(host({ remoteEnrolled: true }));
  await HostConnection.recordHost(host({ remoteEnrolled: true }));
  await withNativeEngineRejecting("preauth_missing", async () => {
    const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
    assert.equal(verdict, "lanOnly");
  });
  assert.equal((await HostConnection.saved())?.remoteEnrolled, false);
  assert.equal((await HostConnection.savedHostRecords())[0]?.remoteEnrolled, false);
});

test("a dialed-but-refused desktop reports offline and keeps the enrollment flag", async () => {
  // Both nodes are registered; the desktop is simply down. The flag must
  // survive an offline verdict - the registration is still valid and the
  // next launch check should trust it again.
  await HostConnection.saveHost(host({ remoteEnrolled: true }));
  await HostConnection.recordHost(host({ remoteEnrolled: true }));
  await withNativeEngineRejecting("remote_host_unavailable", async () => {
    const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
    assert.equal(verdict, "offline");
  });
  assert.equal((await HostConnection.saved())?.remoteEnrolled, true);
  assert.equal((await HostConnection.savedHostRecords())[0]?.remoteEnrolled, true);
});

test("a desktop node missing from the netmap stays lanOnly and keeps the enrollment flag", async () => {
  // The peer is gone from the netmap (unregistered/reaped): LAN only, and no
  // flag mutation - the phone's own node did not prove its state either way.
  await HostConnection.recordHost(host({ remoteEnrolled: true }));
  await withNativeEngineRejecting("tsnet_host_not_found", async () => {
    const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
    assert.equal(verdict, "lanOnly");
  });
  assert.equal((await HostConnection.savedHostRecords())[0]?.remoteEnrolled, true);
});

test("the engine process is torn down even when its start rejected", async () => {
  let verdict;
  const stoppedCalls = await withNativeEngineRejecting("remote_host_unavailable", async () => {
    verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
  });
  assert.equal(verdict, "offline");
  assert.equal(stoppedCalls, 1);
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
  // The QR is consumed before any optimistic row: the guard rejects the
  // pairing before the desktop is recorded, so the hosts list stays clean.
  assert.deepEqual(await HostConnection.savedHostRecords(), []);
});

// ---- pair: optimistic host listing ------------------------------------------

const FAKE_DEVICE = { id: "phone", name: "Phone", platform: "android" };
const SNAPSHOT = { host: { id: "h1", name: "Desktop One" }, projects: [], sessions: [], devices: [], shells: [], defaultShellId: "" };

const pairPayload = (overrides = {}) => ({
  version: 1,
  hostId: "h1",
  hostName: "Desktop One",
  endpoint: "ws://192.168.1.5:47831",
  localEndpoint: "ws://192.168.1.5:47831",
  pairingToken: "token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides
});

const pump = () => new Promise((resolve) => setTimeout(resolve, 0));

async function untilSocket() {
  while (FakeWebSocket.instances.length === 0) await pump();
  return FakeWebSocket.instances.at(-1);
}

test("pair lists the desktop before the handshake and drops the row when the socket errors", async () => {
  await withFakeWebSocket(async () => {
    const pending = HostConnection.pair(pairPayload(), FAKE_DEVICE).then(
      () => { throw new Error("pairing should have failed"); },
      (error) => error
    );
    // The QR grant is the commit point: the row is visible before the
    // desktop answers, while the socket is still connecting.
    const socket = await untilSocket();
    const duringFlight = await HostConnection.savedHostRecords();
    assert.deepEqual(duringFlight.map((record) => record.id), ["h1"]);
    assert.equal(duringFlight[0].lastConnectedAt, undefined);
    socket.onerror?.();
    const error = await pending;
    assert.equal(error.message, UNREACHABLE_HOST_MESSAGE);
    // A failed pairing must not leave a phantom row behind.
    assert.deepEqual(await HostConnection.savedHostRecords(), []);
  });
});

test("a failed re-pairing keeps the desktop's existing row untouched", async () => {
  await HostConnection.recordHost(host({ remoteEnrolled: true }));
  await HostConnection.markHostConnected("h1");
  const stampedAt = (await HostConnection.savedHostRecords())[0].lastConnectedAt;
  assert.equal(typeof stampedAt, "number");
  await withFakeWebSocket(async () => {
    const pending = HostConnection.pair(pairPayload(), FAKE_DEVICE).then(
      () => { throw new Error("pairing should have failed"); },
      (error) => error
    );
    const socket = await untilSocket();
    socket.onerror?.();
    const error = await pending;
    assert.equal(error.message, UNREACHABLE_HOST_MESSAGE);
    const records = await HostConnection.savedHostRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "h1");
    assert.equal(records[0].remoteEnrolled, true);
    assert.equal(records[0].lastConnectedAt, stampedAt);
  });
});

test("a successful pairing commits the row, stamps it connected, and enrolls", async () => {
  await withFakeWebSocket(async () => {
    const pending = HostConnection.pair(pairPayload(), FAKE_DEVICE);
    const socket = await untilSocket();
    socket.setOpen();
    await pump();
    socket.serve({ type: "pair.accepted", deviceToken: "device-token", snapshot: SNAPSHOT });
    const connection = await pending;
    assert.equal(connection.host.deviceToken, "device-token");
    // The background enrollment picks up from here; stub the native node so
    // it resolves instead of reaching for a real engine.
    connection.embeddedEngine = { start: async () => ({ engineStarted: true }), stop: async () => {} };
    socket.serve({ type: "node.enrollment", authKey: "auth-key", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await pump();
    await pump();
    assert.equal(connection.remoteRegistrationState().status, "enrolled");
    connection.close();
    const records = await HostConnection.savedHostRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, "h1");
    assert.equal(records[0].deviceToken, "device-token");
    assert.equal(records[0].remoteEnrolled, true);
    assert.equal(typeof records[0].lastConnectedAt, "number");
  });
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
