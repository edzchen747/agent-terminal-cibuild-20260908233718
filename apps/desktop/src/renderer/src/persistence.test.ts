import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectPersistenceAction, projectRowOpensOnKey } from "./persistence.ts";

describe("project persistence toggle decision", () => {
  it("unsaves a saved (persistent) project", () => {
    const action = projectPersistenceAction(true);
    assert.equal(action.nextPersistent, false);
  });

  it("saves a temporary (non-persistent) project", () => {
    const action = projectPersistenceAction(false);
    assert.equal(action.nextPersistent, true);
  });

  it("inverts the flag, so toggling twice returns to the starting state", () => {
    for (const starting of [true, false]) {
      const first = projectPersistenceAction(starting);
      assert.equal(first.nextPersistent, !starting);
      const second = projectPersistenceAction(first.nextPersistent);
      assert.equal(second.nextPersistent, starting);
    }
  });

  it("labels the action to stop saving a saved project", () => {
    const action = projectPersistenceAction(true);
    assert.equal(action.tooltip, "Stop saving this project");
    assert.equal(action.shortLabel, "Unsave");
  });

  it("labels the action to save a temporary project", () => {
    const action = projectPersistenceAction(false);
    assert.equal(action.tooltip, "Save this temporary project");
    assert.equal(action.shortLabel, "Save project");
  });
});

describe("project row keyboard activation", () => {
  const row = {};
  const nestedControl = {};

  it("opens the project on Enter when the row itself has focus", () => {
    assert.equal(projectRowOpensOnKey(row, row, "Enter"), true);
  });

  it("opens the project on Space when the row itself has focus", () => {
    assert.equal(projectRowOpensOnKey(row, row, " "), true);
  });

  it("does not open on any key other than Enter and Space, even when the row has focus", () => {
    for (const key of ["a", "b", "x", "Escape", "Tab", "ArrowDown", "ArrowUp"]) {
      assert.equal(projectRowOpensOnKey(row, row, key), false, `unexpected open on key ${JSON.stringify(key)}`);
    }
  });

  it("does not open on Enter when a nested control has focus", () => {
    assert.equal(projectRowOpensOnKey(nestedControl, row, "Enter"), false);
  });

  it("does not open on Space when a nested control has focus", () => {
    assert.equal(projectRowOpensOnKey(nestedControl, row, " "), false);
  });

  it("opens only when target and currentTarget are the same reference", () => {
    const row = {};
    const nested = {};
    // Same reference: the row itself holds focus, so the activating keys open.
    assert.equal(projectRowOpensOnKey(row, row, "Enter"), true);
    assert.equal(projectRowOpensOnKey(row, row, " "), true);
    // A different reference (a nested control) never opens, even on Enter/Space.
    assert.equal(projectRowOpensOnKey(nested, row, "Enter"), false);
    assert.equal(projectRowOpensOnKey(nested, row, " "), false);
    // Two distinct object literals are different references, so they never match.
    assert.equal(projectRowOpensOnKey({}, {}, "Enter"), false);
    assert.equal(projectRowOpensOnKey({}, {}, " "), false);
  });
});