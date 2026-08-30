import assert from "node:assert/strict";
import test from "node:test";
import { createUtilityKeyPad } from "./utilityKeys.ts";

const ctrl = { id: "ctrl", label: "Ctrl", modifier: "ctrl" };
const alt = { id: "alt", label: "Alt", modifier: "alt" };
const shift = { id: "shift", label: "Shift", modifier: "shift" };
const tab = { id: "tab", label: "Tab", value: "\t" };
const left = { id: "left", label: "←", value: "\x1b[D", instant: true };
const right = { id: "right", label: "→", value: "\x1b[C", instant: true };
const up = { id: "up", label: "↑", value: "\x1b[A", instant: true };
const pipe = { id: "pipe", label: "|", value: "|" };

test("a held modifier fires with each arrow tap while the modifier stays held", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], selected: [] }, data: null });
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], selected: [] }, data: "\x1b[1;5A" });
  pad.release("up");
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], selected: [] }, data: "\x1b[1;5A" });
});

test("releasing a held modifier latches it with a countdown", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], selected: ["ctrl"] }, data: null });
  assert.deepEqual(pad.expire(), { state: { held: [], selected: [] }, data: null });
});

test("a modifier latched by release still forms an arrow chord", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.press(left), { state: { held: ["left"], selected: [] }, data: "\x1b[1;5D" });
});

test("instant keys fire immediately and never enter the countdown stack", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(left), { state: { held: ["left"], selected: [] }, data: "\x1b[D" });
  pad.release("left");
  assert.deepEqual(pad.press(left), { state: { held: ["left"], selected: [] }, data: "\x1b[D" });
  pad.release("left");
  assert.deepEqual(pad.expire(), { state: { held: [], selected: [] }, data: null });
});

test("instant keys fire the stacked chord before them", () => {
  const pad = createUtilityKeyPad();
  pad.press(shift);
  pad.release("shift");
  assert.deepEqual(pad.press(right), { state: { held: ["right"], selected: [] }, data: "\x1b[1;2C" });
});

test("held modifiers combine with latched modifiers on an instant key", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  pad.press(alt);
  assert.deepEqual(pad.press(left), { state: { held: ["alt", "left"], selected: [] }, data: "\x1b[1;7D" });
});

test("holding a modifier over a latched value key burns the value key into the chord", () => {
  const pad = createUtilityKeyPad();
  pad.press(shift);
  pad.release("shift");
  pad.press(pipe);
  // The latched pipe is fired together with the held-ctrl chord: the stack's
  // modifiers shift combine with the held ctrl, so the arrow fires as ctrl+shift.
  pad.press(ctrl);
  const result = pad.press(up);
  assert.deepEqual(result.data, "|\x1b[1;6A");
});

test("countdown expiration fires a multi-key stack and clears it", () => {
  const pad = createUtilityKeyPad();
  pad.press(shift);
  pad.release("shift");
  pad.press(tab);
  pad.release("tab");
  assert.deepEqual(pad.expire(), { state: { held: [], selected: [] }, data: "\x1b[Z" });
});

test("a latched value key fired immediately does not stack on itself", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], selected: ["pipe"] }, data: "|" });
  pad.release("pipe");
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], selected: [] }, data: null });
  pad.release("pipe");
  assert.deepEqual(pad.expire(), { state: { held: [], selected: [] }, data: null });
});

test("consuming terminal input applies latched modifiers and clears the stack", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.consume("d"), { state: { held: [], selected: [] }, data: "\x04" });
});

test("consuming terminal input applies a held modifier without clearing the hold", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  assert.deepEqual(pad.consume("d"), { state: { held: ["ctrl"], selected: [] }, data: "\x04" });
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], selected: ["ctrl"] }, data: null });
});

test("releasing a key that was never held is a no-op", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], selected: [] }, data: null });
});

test("tapping a latched modifier again toggles the latch off", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], selected: ["ctrl"] }, data: null });
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], selected: [] }, data: null });
});

test("pressing a latched value key while a modifier is held does not fire it twice", () => {
  const pad = createUtilityKeyPad();
  pad.press(pipe);
  pad.release("pipe");
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], selected: ["pipe"] }, data: null });
  // Ctrl held over a latched pipe: the new pipe press replaces the latch, so
  // only one "|" goes out with the held ctrl.
  const result = pad.press(pipe);
  assert.equal(result.data, "|");
  assert.deepEqual(result.state, { held: ["ctrl", "pipe"], selected: [] });
});

test("reset drops every hooked key without firing anything", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.press(shift);
  pad.release("ctrl");
  pad.press(tab);
  assert.deepEqual(pad.reset(), { state: { held: [], selected: [] }, data: null });
  assert.deepEqual(pad.press(left), { state: { held: ["left"], selected: [] }, data: "\x1b[D" });
});
