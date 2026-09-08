import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceListEntryModal, nextModalAfterPairing, nextModalOnEscape, pairModalEscapeTarget } from "./modal-navigation.ts";

describe("devices button entry", () => {
  it("skips the devices list and opens the pairing QR when no device is paired", () => {
    assert.equal(deviceListEntryModal(0), "pair");
  });

  it("opens the devices list when at least one device is paired", () => {
    assert.equal(deviceListEntryModal(1), "devices");
    assert.equal(deviceListEntryModal(7), "devices");
  });

  it("opens the pairing QR for malformed counts too", () => {
    assert.equal(deviceListEntryModal(-1), "pair");
  });
});

describe("desktop modal escape", () => {
  it("is a no-op when no modal is open", () => {
    assert.equal(nextModalOnEscape(null, false, 0), null);
    assert.equal(nextModalOnEscape(null, true, 5), null);
  });

  it("closes the settings modal", () => {
    assert.equal(nextModalOnEscape("settings", false, 0), null);
    assert.equal(nextModalOnEscape("settings", true, 5), null);
  });

  it("closes the devices modal, even when a revoke emptied the list", () => {
    assert.equal(nextModalOnEscape("devices", false, 0), null);
    assert.equal(nextModalOnEscape("devices", false, 3), null);
    assert.equal(nextModalOnEscape("devices", true, 3), null);
  });

  it("goes back to the devices list from the pairing QR when devices exist", () => {
    assert.equal(nextModalOnEscape("pair", false, 1), "devices");
    assert.equal(nextModalOnEscape("pair", true, 100), "devices");
  });

  it("closes instead of showing an empty devices list when none are paired", () => {
    assert.equal(nextModalOnEscape("pair", false, 0), null);
    assert.equal(nextModalOnEscape("pair", true, 0), null);
  });

  it("steps back from a device's port list to the Port Bridge page", () => {
    assert.equal(nextModalOnEscape("bridgeDevice", false, 1), "bridges");
    assert.equal(nextModalOnEscape("bridgeDevice", true, 1), "bridges");
  });

  it("closes the Port Bridge page", () => {
    assert.equal(nextModalOnEscape("bridges", false, 1), null);
    assert.equal(nextModalOnEscape("bridges", false, 0), null);
  });

  it("closes the rename modal before a rename is in flight", () => {
    assert.equal(nextModalOnEscape("rename", false, 0), null);
    assert.equal(nextModalOnEscape("rename", false, 2), null);
  });

  it("keeps the rename modal while a rename is in flight", () => {
    assert.equal(nextModalOnEscape("rename", true, 0), "rename");
    assert.equal(nextModalOnEscape("rename", true, 2), "rename");
  });
});

describe("pairing modal close without pairing", () => {
  it("returns to the devices list when devices exist", () => {
    assert.equal(pairModalEscapeTarget(1), "devices");
  });

  it("closes to the app shell when the list was empty", () => {
    assert.equal(pairModalEscapeTarget(0), null);
  });
});

describe("desktop modal after pairing succeeds", () => {
  it("closes both the QR modal and the devices page, returning to the shell", () => {
    assert.equal(nextModalAfterPairing("pair"), null);
  });

  it("leaves other modals untouched", () => {
    assert.equal(nextModalAfterPairing("settings"), "settings");
    assert.equal(nextModalAfterPairing("devices"), "devices");
    assert.equal(nextModalAfterPairing("bridges"), "bridges");
    assert.equal(nextModalAfterPairing("bridgeDevice"), "bridgeDevice");
    assert.equal(nextModalAfterPairing("rename"), "rename");
  });

  it("stays closed when no modal is open", () => {
    assert.equal(nextModalAfterPairing(null), null);
  });
});
