import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextModalAfterPairing, nextModalOnEscape } from "./modal-navigation.ts";

describe("desktop modal escape", () => {
  it("is a no-op when no modal is open", () => {
    assert.equal(nextModalOnEscape(null, false), null);
    assert.equal(nextModalOnEscape(null, true), null);
  });

  it("closes the settings modal", () => {
    assert.equal(nextModalOnEscape("settings", false), null);
    assert.equal(nextModalOnEscape("settings", true), null);
  });

  it("closes the devices modal", () => {
    assert.equal(nextModalOnEscape("devices", false), null);
    assert.equal(nextModalOnEscape("devices", true), null);
  });

  it("goes back to the devices list from the pairing QR", () => {
    assert.equal(nextModalOnEscape("pair", false), "devices");
    assert.equal(nextModalOnEscape("pair", true), "devices");
  });

  it("closes the rename modal before a rename is in flight", () => {
    assert.equal(nextModalOnEscape("rename", false), null);
  });

  it("keeps the rename modal while a rename is in flight", () => {
    assert.equal(nextModalOnEscape("rename", true), "rename");
  });
});

describe("desktop modal after pairing succeeds", () => {
  it("returns to the devices list from the pairing QR", () => {
    assert.equal(nextModalAfterPairing("pair"), "devices");
  });

  it("leaves other modals untouched", () => {
    assert.equal(nextModalAfterPairing("settings"), "settings");
    assert.equal(nextModalAfterPairing("devices"), "devices");
    assert.equal(nextModalAfterPairing("rename"), "rename");
  });

  it("stays closed when no modal is open", () => {
    assert.equal(nextModalAfterPairing(null), null);
  });
});
