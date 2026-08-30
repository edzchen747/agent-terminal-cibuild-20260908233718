import assert from "node:assert/strict";
import test from "node:test";
import { createUtilityKeyPad } from "./utilityKeys.ts";

const ctrl = { id: "ctrl", label: "Ctrl", modifier: "ctrl" };
const alt = { id: "alt", label: "Alt", modifier: "alt" };
const shift = { id: "shift", label: "Shift", modifier: "shift" };
const tab = { id: "tab", label: "Tab", value: "\t" };
const pipe = { id: "pipe", label: "|", value: "|" };
const left = { id: "left", label: "←", value: "\x1b[D" };
const up = { id: "up", label: "↑", value: "\x1b[A" };
const right = { id: "right", label: "→", value: "\x1b[C" };

test("pressing a modifier sends no input on its own", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], latched: [] }, data: null });
});

test("tapping a modifier latches it on, and it stays armed without a countdown", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: ["ctrl"] }, data: null });
  // No expiration exists anymore: the latch simply persists until a key
  // fires the chord or the modifier is tapped again.
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl"] });
});

test("tapping a latched modifier toggles it off", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], latched: ["ctrl"] }, data: null });
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("a latched modifier fires the next keypress as a chord and resets", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[1;5A" });
  pad.release("up");
  // The latch was consumed by the chord: the next press is a plain key.
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[A" });
});

test("multiple latched modifiers combine and reset together", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  pad.press(alt);
  pad.release("alt");
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl", "alt"] });
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[1;7A" });
});

test("a held modifier fires with each keypress while held, and re-latches when released after a chord", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], latched: [] }, data: "\x1b[1;5A" });
  pad.release("up");
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], latched: [] }, data: "\x1b[1;5A" });
  pad.release("up");
  // Lifting a held modifier re-latches it, even though chords already
  // fired while it was held; tap it again to toggle the latch off.
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: ["ctrl"] }, data: null });
});

test("a modifier held with no keypress latches on release, like a tap", () => {
  const pad = createUtilityKeyPad();
  pad.press(shift);
  assert.deepEqual(pad.release("shift"), { state: { held: [], latched: ["shift"] }, data: null });
  assert.deepEqual(pad.press(right), { state: { held: ["right"], latched: [] }, data: "\x1b[1;2C" });
});

test("value keys fire immediately and never stack", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: "|" });
  pad.release("pipe");
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: "|" });
  pad.release("pipe");
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("a keypress resets every latched modifier", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  pad.press(shift);
  pad.release("shift");
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl", "shift"] });
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[1;6A" });
  pad.release("up");
  assert.deepEqual(pad.press(tab), { state: { held: ["tab"], latched: [] }, data: "\t" });
});

test("a held modifier combines with latched modifiers on a keypress", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  pad.press(alt);
  assert.deepEqual(pad.press(left), { state: { held: ["alt", "left"], latched: [] }, data: "\x1b[1;7D" });
  pad.release("left");
  // The latched ctrl was consumed by the chord; the held alt re-latches on
  // release, so exactly alt stays armed.
  assert.deepEqual(pad.release("alt"), { state: { held: [], latched: ["alt"] }, data: null });
});

test("consuming typed input applies latched modifiers and clears them", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.consume("d"), { state: { held: [], latched: [] }, data: "\x04" });
});

test("consuming typed input applies a held modifier without clearing the hold, and the release re-latches", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  assert.deepEqual(pad.consume("d"), { state: { held: ["ctrl"], latched: [] }, data: "\x04" });
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: ["ctrl"] }, data: null });
});

test("releasing a key that was never held is a no-op", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("pressing a key that is already held is a no-op", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], latched: [] }, data: null });
});

test("reset drops every held and latched key without firing anything", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.press(shift);
  pad.release("ctrl");
  pad.press(tab);
  assert.deepEqual(pad.reset(), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(left), { state: { held: ["left"], latched: [] }, data: "\x1b[D" });
});
