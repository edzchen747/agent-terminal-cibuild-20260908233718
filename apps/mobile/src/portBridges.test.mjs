import assert from "node:assert/strict";
import test from "node:test";
import { bridgesFor, bridgingEnabledFor, phoneBridgeSpecs, sameBridgeSpecs } from "./portBridges.ts";

const DEVICE = "phone-a";

function snapshot({ bridges = [], enabled = true, statuses = {}, host = "100.64.0.1" } = {}) {
  return {
    host: { id: "host-1", name: "Workstation", version: "0.3.5" },
    projects: [],
    sessions: [],
    devices: [
      { id: DEVICE, name: "Pixel", platform: "android", addedAt: "", lastSeenAt: "", portBridging: { enabled, bridges } },
      { id: "other", name: "Tablet", platform: "android", addedAt: "", lastSeenAt: "" }
    ],
    shells: [],
    defaultShellId: "cmd",
    portBridgeStatuses: { [DEVICE]: statuses[DEVICE] ?? [] },
    ...(host ? { hostTailnetAddress: host } : {})
  };
}

const active = (id) => ({ bridgeId: id, state: "active" });

test("a bridge the desktop serves opens a loopback listener that dials the desktop", () => {
  const specs = phoneBridgeSpecs(
    snapshot({ bridges: [{ id: "b1", port: 5173, server: "host" }], statuses: { [DEVICE]: [active("b1")] } }),
    DEVICE
  );
  assert.deepEqual(specs, [
    { id: "b1", mode: "listen-local", listen: "127.0.0.1:5173", target: "100.64.0.1:5173" }
  ]);
});

test("a bridge this phone serves accepts on the tailnet and only from the desktop", () => {
  const specs = phoneBridgeSpecs(
    snapshot({ bridges: [{ id: "b1", port: 9000, server: "client" }], statuses: { [DEVICE]: [active("b1")] } }),
    DEVICE
  );
  assert.deepEqual(specs, [
    { id: "b1", mode: "listen-tsnet", port: 9000, target: "127.0.0.1:9000", peer: "100.64.0.1" }
  ]);
});

test("a port the desktop did not award never opens a listener here", () => {
  // Opening one would give the phone a socket that accepts connections and
  // forwards them nowhere.
  const statuses = { [DEVICE]: [{ bridgeId: "b1", state: "conflict", detail: "taken" }] };
  assert.deepEqual(
    phoneBridgeSpecs(snapshot({ bridges: [{ id: "b1", port: 5173, server: "host" }], statuses }), DEVICE),
    []
  );
  // A bridge with no status at all is not active either.
  assert.deepEqual(
    phoneBridgeSpecs(snapshot({ bridges: [{ id: "b1", port: 5173, server: "host" }] }), DEVICE),
    []
  );
});

test("bridging switched off builds nothing at all", () => {
  const statuses = { [DEVICE]: [active("b1")] };
  assert.deepEqual(
    phoneBridgeSpecs(snapshot({ enabled: false, bridges: [{ id: "b1", port: 5173, server: "host" }], statuses }), DEVICE),
    []
  );
  assert.equal(bridgingEnabledFor(snapshot({ enabled: false }), DEVICE), false);
  assert.equal(bridgingEnabledFor(snapshot(), DEVICE), true);
});

test("without the desktop's overlay address only the listening half is built", () => {
  const bridges = [
    { id: "reach", port: 5173, server: "host" },
    { id: "serve", port: 9000, server: "client" }
  ];
  const statuses = { [DEVICE]: [active("reach"), active("serve")] };
  const specs = phoneBridgeSpecs(snapshot({ bridges, statuses, host: "" }), DEVICE);
  // There is nothing to dial, so no local listener is opened; the tailnet
  // listener still works, just without a peer allowlist.
  assert.deepEqual(specs, [{ id: "serve", mode: "listen-tsnet", port: 9000, target: "127.0.0.1:9000" }]);
});

test("a device the host does not know about, or no snapshot, builds nothing", () => {
  assert.deepEqual(phoneBridgeSpecs(undefined, DEVICE), []);
  assert.deepEqual(phoneBridgeSpecs(snapshot(), "unknown"), []);
  assert.deepEqual(bridgesFor(undefined, DEVICE), []);
  // A device from a host that predates the feature reads as switched off.
  assert.equal(bridgingEnabledFor(snapshot(), "other"), false);
});

test("an unchanged desired set is recognised so the node's file is not rewritten", () => {
  const one = [{ id: "b1", mode: "listen-local", listen: "127.0.0.1:1", target: "100.64.0.1:1" }];
  assert.equal(sameBridgeSpecs(one, [...one]), true);
  assert.equal(sameBridgeSpecs(one, []), false);
  assert.equal(sameBridgeSpecs(one, [{ ...one[0], target: "100.64.0.2:1" }]), false);
});
