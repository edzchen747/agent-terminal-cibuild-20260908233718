import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devicesByLastConnected, deviceHasBridgeWarning } from "./port-bridges.ts";

const device = (
  id: string,
  name: string,
  lastSeenAt: string,
  online = false
) => ({ id, name, platform: "android" as const, addedAt: "2026-01-01T00:00:00Z", lastSeenAt, online });

describe("port bridge device order", () => {
  it("lists the most recently connected device first", () => {
    const devices = [
      device("old", "Old", "2026-09-01T00:00:00Z"),
      device("new", "New", "2026-09-09T00:00:00Z"),
      device("mid", "Mid", "2026-09-05T00:00:00Z")
    ];
    assert.deepEqual(devicesByLastConnected(devices).map((entry) => entry.id), ["new", "mid", "old"]);
  });

  it("puts a connected device above every idle one", () => {
    // An idle device's lastSeenAt stops advancing the moment it drops, so a
    // device that is connected right now can still have the older timestamp.
    const devices = [
      device("idle", "Idle", "2026-09-09T00:00:00Z"),
      device("live", "Live", "2026-09-01T00:00:00Z", true)
    ];
    assert.deepEqual(devicesByLastConnected(devices).map((entry) => entry.id), ["live", "idle"]);
  });

  it("breaks a tie by name so the order never flickers between renders", () => {
    const devices = [
      device("b", "Beta", "2026-09-09T00:00:00Z"),
      device("a", "Alpha", "2026-09-09T00:00:00Z")
    ];
    assert.deepEqual(devicesByLastConnected(devices).map((entry) => entry.name), ["Alpha", "Beta"]);
  });

  it("does not mutate the list it was given", () => {
    const devices = [
      device("old", "Old", "2026-09-01T00:00:00Z"),
      device("new", "New", "2026-09-09T00:00:00Z")
    ];
    devicesByLastConnected(devices);
    assert.deepEqual(devices.map((entry) => entry.id), ["old", "new"]);
  });
});

describe("port bridge warning rollup", () => {
  const configured = {
    id: "phone",
    portBridging: { enabled: true, bridges: [{ id: "a", port: 8080, server: "host" as const }] }
  };

  it("marks a device whose port lost the race for the number", () => {
    assert.equal(
      deviceHasBridgeWarning(configured, { phone: [{ bridgeId: "a", state: "conflict" }] }),
      true
    );
  });

  it("leaves a working or still-pending bridge unmarked", () => {
    assert.equal(deviceHasBridgeWarning(configured, { phone: [{ bridgeId: "a", state: "active" }] }), false);
    assert.equal(deviceHasBridgeWarning(configured, { phone: [{ bridgeId: "a", state: "pending" }] }), false);
    assert.equal(deviceHasBridgeWarning(configured, undefined), false);
  });

  it("stays quiet while bridging is switched off for the device", () => {
    // The bridges are not meant to be up, so a stale status must not raise a
    // warning the user cannot act on.
    const off = { ...configured, portBridging: { ...configured.portBridging, enabled: false } };
    assert.equal(deviceHasBridgeWarning(off, { phone: [{ bridgeId: "a", state: "conflict" }] }), false);
  });
});
