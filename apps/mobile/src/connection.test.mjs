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
const { HostConnection, HOST_CHECK_TIMEOUT_MS } = await import("./connection.ts");
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

// ---- session event routing -------------------------------------------------

test("session.output and session.grid arrive as typed events with raw payloads", async () => {
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const outputs = [];
    const grids = [];
    const modes = [];
    connection.on("output", (event) => outputs.push(event));
    connection.on("grid", (event) => grids.push(event));
    connection.on("mode", (event) => modes.push(event));
    const opening = connection["open"]("ws://192.168.1.5:47831", 2_000);
    FakeWebSocket.instances.at(-1).setOpen();
    await opening;

    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "session.output",
      sessionId: "s1",
      data: "hello\r\n",
      offset: 337
    });
    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "session.grid",
      sessionId: "s1",
      cols: 72,
      rows: 26,
      offset: 636
    });
    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "session.output",
      sessionId: "s1",
      data: "world\r\n",
      offset: 343
    });
    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "session.mode",
      sessionId: "s1",
      mode: "fullscreen",
      offset: 900
    });
    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "session.mode",
      sessionId: "s1",
      mode: "canonical",
      offset: 910
    });
    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "snapshot",
      requestId: "r1",
      snapshot: { host: { id: "h1", name: "Desktop One", version: "0.3.5" }, projects: [], sessions: [], devices: [], shells: [], defaultShellId: "" }
    });

    assert.deepEqual(outputs, [
      { sessionId: "s1", data: "hello\r\n", offset: 337 },
      { sessionId: "s1", data: "world\r\n", offset: 343 }
    ]);
    assert.deepEqual(grids, [{ sessionId: "s1", cols: 72, rows: 26, offset: 636 }]);
    assert.deepEqual(modes, [
      { sessionId: "s1", mode: "fullscreen", offset: 900 },
      { sessionId: "s1", mode: "canonical", offset: 910 }
    ]);
    connection.close();
  });
});

test("session stream messages from other sessions do not cross into the terminal", async () => {
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const outputs = [];
    connection.on("output", (event) => outputs.push(event));
    const opening = connection["open"]("ws://192.168.1.5:47831", 2_000);
    FakeWebSocket.instances.at(-1).setOpen();
    await opening;
    FakeWebSocket.instances.at(-1).deliverServerMessage({
      type: "session.output",
      sessionId: "other",
      data: "noise",
      offset: 0
    });

    // Routing is per-session in the terminal component; the transport must
    // not swallow or alter session ids - the terminal filters on them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(outputs, [{ sessionId: "other", data: "noise", offset: 0 }]);
    connection.close();
  });
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

// ---- verifySavedHostRegistration: two-step tsnet + device ping ---------------
//
// The check is now two steps: (1) the tsnet engine must start and report an
// address, then (2) a single WebSocket open to the device endpoint confirms it
// is actually online. The device ping has no timer of its own; the whole check
// is bounded by one shared deadline. These tests drive a resolving engine so
// the ping path is reached, and a fake WebSocket so the ping is observable.

function withNativeEngineResolving(startResult, run) {
  const realIsNative = Capacitor.isNativePlatform;
  const originalStart = EmbeddedNodeEngine.prototype.start;
  const originalStop = EmbeddedNodeEngine.prototype.stop;
  let stopped = 0;
  Capacitor.isNativePlatform = () => true;
  EmbeddedNodeEngine.prototype.start = async () => startResult;
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

// The ping's socket is created one tick after the (instant) engine start;
// flush a macrotask so the FakeWebSocket instance exists before driving it.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a responding tsnet plus a live device ping verifies the host", async () => {
  const stopped = await withNativeEngineResolving({ engineStarted: true, proxyEndpoint: "ws://127.0.0.1:39478" }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
      await tick();
      FakeWebSocket.instances.at(-1).setOpen(); // device answers the ping
      assert.equal(await promise, "verified");
    });
  });
  assert.equal(stopped, 1); // the engine is torn down even on the success path
});

test("a responding tsnet with an unreachable device reports offline", async () => {
  await withNativeEngineResolving({ engineStarted: true, proxyEndpoint: "ws://127.0.0.1:39478" }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
      await tick();
      FakeWebSocket.instances.at(-1).onerror?.(); // device refuses the ping
      assert.equal(await promise, "offline");
    });
  });
});

test("the device ping is bounded by the check deadline, not its own timer", async () => {
  // tsnet answers instantly, leaving almost no budget for the ping. The ping
  // socket never opens, so the shared deadline - not any ping timer - reads
  // the host as offline. This is the "the check timeout governs the ping"
  // behavior: a slow device is treated as offline when the check window closes.
  await withNativeEngineResolving({ engineStarted: true, proxyEndpoint: "ws://127.0.0.1:39478" }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }), 50);
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the 50ms deadline pass
      assert.equal(await promise, "offline");
    });
  });
});

test("the hosts-page check budget is 10 seconds", () => {
  assert.equal(HOST_CHECK_TIMEOUT_MS, 10_000);
});

test("the device ping falls back to the record's remote endpoint when tsnet gives no proxy", async () => {
  await withNativeEngineResolving({ engineStarted: true }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(
        host({ remoteEnrolled: true, remoteEndpoint: "ws://h1.office-tailnet.net:47831" })
      );
      await tick();
      assert.equal(FakeWebSocket.instances.at(-1).url, "ws://h1.office-tailnet.net:47831");
      FakeWebSocket.instances.at(-1).setOpen();
      assert.equal(await promise, "verified");
    });
  });
});

test("the device ping falls back to the default overlay endpoint when no endpoint is configured", async () => {
  await withNativeEngineResolving({ engineStarted: true }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
      await tick();
      assert.equal(FakeWebSocket.instances.at(-1).url, "ws://h1.agent-terminal.internal:47831");
      FakeWebSocket.instances.at(-1).setOpen();
      assert.equal(await promise, "verified");
    });
  });
});

test("a device that answers after the check deadline has passed still reads offline", async () => {
  // tsnet answers instantly; the socket opens one tick past the 50ms
  // deadline. The late answer is ignored - by the time it arrives the
  // shared deadline has already read the host as offline.
  await withNativeEngineResolving({ engineStarted: true, proxyEndpoint: "ws://127.0.0.1:39478" }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }), 50);
      await new Promise((resolve) => setTimeout(resolve, 60));
      FakeWebSocket.instances.at(-1).setOpen(); // late answer
      assert.equal(await promise, "offline");
    });
  });
});

test("the first ping event wins and the probe socket is closed on success", async () => {
  // onerror after onopen must not flip a verified result, and the probe
  // socket must be torn down so it cannot linger.
  await withNativeEngineResolving({ engineStarted: true, proxyEndpoint: "ws://127.0.0.1:39478" }, async () => {
    await withFakeWebSocket(async () => {
      const promise = HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
      await tick();
      const socket = FakeWebSocket.instances.at(-1);
      socket.setOpen();
      assert.equal(await promise, "verified");
      socket.onerror?.(); // too late: the probe already settled
      assert.equal(socket.readyState, 3);
    });
  });
});

test("the engine is torn down even when the tsnet wait times out", async () => {
  const realIsNative = Capacitor.isNativePlatform;
  const originalStart = EmbeddedNodeEngine.prototype.start;
  const originalStop = EmbeddedNodeEngine.prototype.stop;
  let stopped = 0;
  Capacitor.isNativePlatform = () => true;
  EmbeddedNodeEngine.prototype.start = () => new Promise(() => {}); // tsnet hangs
  EmbeddedNodeEngine.prototype.stop = async () => { stopped += 1; };
  try {
    const verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }), 50);
    assert.equal(verdict, "error");
  } finally {
    Capacitor.isNativePlatform = realIsNative;
    EmbeddedNodeEngine.prototype.start = originalStart;
    EmbeddedNodeEngine.prototype.stop = originalStop;
  }
  assert.equal(stopped, 1);
});

test("a tsnet that reports no started engine falls back to LAN only", async () => {
  let verdict;
  await withNativeEngineResolving({ engineStarted: false }, async () => {
    verdict = await HostConnection.verifySavedHostRegistration(host({ remoteEnrolled: true }));
  });
  assert.equal(verdict, "lanOnly");
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

// ---- viewport keepalive -----------------------------------------------------
// A bare ping every second while a terminal page is attached keeps the phone
// in the host's viewport set S; the tick is skipped while the app is hidden,
// so a backgrounded phone drops back out of S within the host's watchdog.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pairedConnection(collect) {
  const pending = HostConnection.pair(pairPayload(), FAKE_DEVICE);
  const socket = await untilSocket();
  const originalSend = socket.send.bind(socket);
  socket.send = (payload) => {
    collect(payload);
    originalSend(payload);
  };
  socket.setOpen();
  await pump();
  socket.serve({ type: "pair.accepted", deviceToken: "device-token", snapshot: SNAPSHOT });
  const connection = await pending;
  // The background enrollment must not reach for a real node engine.
  connection.embeddedEngine = { start: async () => ({ engineStarted: true }), stop: async () => {} };
  socket.serve({ type: "node.enrollment", authKey: "auth-key", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await pump();
  await pump();
  return connection;
}

const pingCount = (sent) => sent.filter((payload) => JSON.parse(payload).type === "ping").length;

test("the viewport keepalive pings once a second and silences on stop", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  try {
    await withFakeWebSocket(async () => {
      const sent = [];
      const connection = await pairedConnection((payload) => sent.push(payload));
      connection.startViewportKeepalive();
      await sleep(1_350);
      assert.equal(pingCount(sent), 1, "one ping must land within the first interval");
      connection.stopViewportKeepalive();
      await sleep(1_350);
      assert.equal(pingCount(sent), 1, "stop must silence the keepalive");
      connection.close();
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("the viewport keepalive skips while the app is hidden and resumes on visibility", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: true };
  try {
    await withFakeWebSocket(async () => {
      const sent = [];
      const connection = await pairedConnection((payload) => sent.push(payload));
      connection.startViewportKeepalive();
      await sleep(1_350);
      assert.equal(pingCount(sent), 0, "a hidden app must not ping");
      globalThis.document.hidden = false;
      await sleep(1_350);
      assert.equal(pingCount(sent), 1, "visibility must resume the pings");
      connection.close();
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("restarting the viewport keepalive does not double the tick", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  try {
    await withFakeWebSocket(async () => {
      const sent = [];
      const connection = await pairedConnection((payload) => sent.push(payload));
      connection.startViewportKeepalive();
      connection.startViewportKeepalive();
      await sleep(1_350);
      assert.equal(pingCount(sent), 1, "a re-start must replace the interval, not stack it");
      connection.close();
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

// ---- Taskbar events patch every held session --------------------------------
//
// The host broadcasts session.taskbar events to every remote client, not
// just attached ones: a phone in its tabs view sees progress it never
// attached to, and the running -> clear edge with its "come look" marker.
// The patch must therefore reach the held snapshot's sessions, not only the
// open terminal's.

test("a taskbar event patches the held snapshot's sessions, attached or not", async () => {
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const snapshots = [];
    connection.on("snapshot", (snapshot) => snapshots.push(snapshot));
    const opening = connection["open"]("ws://192.168.1.5:47831", 2_000);
    const socket = FakeWebSocket.instances.at(-1);
    socket.setOpen();
    await opening;

    // Hold a two-session snapshot, like the tabs view does.
    socket.deliverServerMessage({
      type: "snapshot",
      snapshot: {
        host: { id: "h1", name: "Desktop One", version: "0.3.5" },
        projects: [],
        sessions: [{ id: "s1" }, { id: "s2" }],
        devices: [],
        shells: [],
        defaultShellId: ""
      }
    });

    // An unattached session's progress must land in the held snapshot,
    // and the listeners must see the patch.
    socket.deliverServerMessage({ type: "session.taskbar", sessionId: "s2", taskbar: { state: "value", progress: 40 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = connection["snapshot"];
    assert.equal(held.sessions.find((session) => session.id === "s2").taskbar.state, "value");
    assert.equal(held.sessions.find((session) => session.id === "s1").taskbar, undefined, "an untouched session gains no taskbar");
    assert.equal(snapshots.length, 2, "snapshot listeners see the initial snapshot and the patch");
    connection.close();
  });
});

test("a taskbar event for an unknown session, or before any snapshot, is dropped", async () => {
  await withFakeWebSocket(async () => {
    const connection = new HostConnection(host());
    const opening = connection["open"]("ws://192.168.1.5:47831", 2_000);
    const socket = FakeWebSocket.instances.at(-1);
    socket.setOpen();
    await opening;

    // Before any snapshot is held, the patch has nothing to patch.
    socket.deliverServerMessage({ type: "session.taskbar", sessionId: "s1", taskbar: { state: "clear" } });
    assert.equal(connection["snapshot"], undefined);

    // And after a snapshot, a session it does not contain is ignored:
    // the patch never invents sessions.
    socket.deliverServerMessage({
      type: "snapshot",
      snapshot: {
        host: { id: "h1", name: "Desktop One", version: "0.3.5" },
        projects: [],
        sessions: [{ id: "s1" }],
        devices: [],
        shells: [],
        defaultShellId: ""
      }
    });
    socket.deliverServerMessage({ type: "session.taskbar", sessionId: "gone", taskbar: { state: "value", progress: 7 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(connection["snapshot"].sessions.length, 1);
    connection.close();
  });
});
