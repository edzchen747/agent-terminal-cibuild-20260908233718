import assert from "node:assert/strict";
import test from "node:test";
import { guardUtilityKeySelection } from "./utilityKeySelection.ts";

function createFakeElement() {
  const styles = new Map();
  const listeners = {};
  return {
    style: {
      get _entries() {
        return styles;
      },
      set userSelect(value) {
        styles.set("user-select", value);
      },
      setProperty(name, value) {
        styles.set(name, value);
      }
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    listeners
  };
}

test("guarding a utility key disables text selection on every style surface", () => {
  const element = createFakeElement();
  guardUtilityKeySelection(element);
  assert.equal(element.style._entries.get("user-select"), "none");
  assert.equal(element.style._entries.get("-webkit-user-select"), "none");
  assert.equal(element.style._entries.get("-webkit-touch-callout"), "none");
});

test("the selectstart listener cancels a native selection attempt", () => {
  const element = createFakeElement();
  guardUtilityKeySelection(element);
  let prevented = false;
  element.listeners.selectstart({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test("guarding a missing element is a no-op", () => {
  assert.doesNotThrow(() => guardUtilityKeySelection(null));
  assert.doesNotThrow(() => guardUtilityKeySelection(undefined));
});

test("long-press word selection after a sweep still never leaves the label selectable", () => {
  // Simulates the sequence behind the reported bug: the label text is
  // selected, the selection menu appears, and the user dismisses it and
  // long-presses again. Guarding each re-render must keep the guard on.
  const element = createFakeElement();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    guardUtilityKeySelection(element);
  }
  let prevented = false;
  element.listeners.selectstart({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(element.style._entries.get("user-select"), "none");
});
