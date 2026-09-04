import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectedDevices } from "./statusbar.ts";
import type { AuthorizedDevice } from "@agentterminal/protocol";

const device = (name: string, online: boolean, viewingSessionIds: string[] = []): AuthorizedDevice =>
  ({ id: name, name, platform: "ios", addedAt: "now", lastSeenAt: "now", online, viewingSessionIds });

describe("connectedDevices", () => {
  it("lists every connected device in pairing order", () => {
    const listed = connectedDevices([device("Device1", true), device("Device3", true)], []);
    assert.deepEqual(listed.map((entry) => entry.name), ["Device1", "Device3"]);
  });

  it("leaves paired-but-offline devices out", () => {
    const listed = connectedDevices([device("Device1", true), device("Device2", false)], []);
    assert.deepEqual(listed.map((entry) => entry.name), ["Device1"]);
  });

  it("treats a device with no online flag as offline", () => {
    assert.deepEqual(connectedDevices([{ id: "d", name: "Device1", platform: "android", addedAt: "now", lastSeenAt: "now" }], []), []);
  });

  it("marks a device viewing one of the terminals on screen", () => {
    const listed = connectedDevices([device("Device1", true, ["s2"]), device("Device2", true, ["s9"])], ["s1", "s2"]);
    assert.deepEqual(listed.map((entry) => entry.sharesTerminal), [true, false]);
  });

  it("shares no terminal when the device has none open", () => {
    assert.deepEqual(connectedDevices([device("Device1", true)], ["s1"]).map((entry) => entry.sharesTerminal), [false]);
  });

  it("shares no terminal when this window has none on screen", () => {
    assert.deepEqual(connectedDevices([device("Device1", true, ["s1"])], []).map((entry) => entry.sharesTerminal), [false]);
  });
});
