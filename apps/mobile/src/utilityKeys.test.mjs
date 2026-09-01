import assert from "node:assert/strict";
import test from "node:test";
import { createUtilityKeyPad, MODIFIER_HOLD_THRESHOLD_MS } from "./utilityKeys.ts";

// A clock the tests advance by hand, so tap (< threshold) and hold
// (>= threshold) releases are deterministic instead of wall-clock dependent.
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    advance(ms) { time += ms; }
  };
}

const ctrl = { id: "ctrl", label: "Ctrl", modifier: "ctrl" };
const alt = { id: "alt", label: "Alt", modifier: "alt" };
const shift = { id: "shift", label: "Shift", modifier: "shift" };
const tab = { id: "tab", label: "Tab", value: "\t" };
const pipe = { id: "pipe", label: "|", value: "|" };
const left = { id: "left", label: "←", value: "\x1b[D" };
const up = { id: "up", label: "↑", value: "\x1b[A" };
const right = { id: "right", label: "→", value: "\x1b[C" };
const down = { id: "down", label: "↓", value: "\x1b[B" };

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

test("a held modifier fires with each keypress while held, and drops off when released after the hold", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(100);
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], latched: [] }, data: "\x1b[1;5A" });
  pad.release("up");
  clock.advance(100);
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], latched: [] }, data: "\x1b[1;5A" });
  pad.release("up");
  // Lifting a detected hold drops the modifier, not re-latches it, even
  // though chords already fired while it was held; the next press is plain.
  clock.advance(100);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[A" });
});

test("a modifier tapped with no keypress latches on release, like a tap", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(shift);
  clock.advance(50);
  assert.deepEqual(pad.release("shift"), { state: { held: [], latched: ["shift"] }, data: null });
  assert.deepEqual(pad.press(right), { state: { held: ["right"], latched: [] }, data: "\x1b[1;2C" });
});

test("a modifier held past the threshold with no keypress drops off on release", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(shift);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("shift"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(right), { state: { held: ["right"], latched: [] }, data: "\x1b[C" });
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

test("a held modifier combines with latched modifiers on a keypress, and the hold drops on release", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  pad.release("ctrl");
  clock.advance(50);
  pad.press(alt);
  clock.advance(50);
  assert.deepEqual(pad.press(left), { state: { held: ["alt", "left"], latched: [] }, data: "\x1b[1;7D" });
  pad.release("left");
  // The latched ctrl was consumed by the chord; lifting the held alt drops
  // it too, so nothing stays armed and the next press is plain.
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS - 50);
  assert.deepEqual(pad.release("alt"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(down), { state: { held: ["down"], latched: [] }, data: "\x1b[B" });
});

test("consuming typed input applies latched modifiers and clears them", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.consume("d"), { state: { held: [], latched: [] }, data: "\x04" });
});

test("consuming typed input applies a held modifier without clearing the hold, and the hold drops on release", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  assert.deepEqual(pad.consume("d"), { state: { held: ["ctrl"], latched: [] }, data: "\x04" });
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS - 50);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
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

test("releasing after a reset is a no-op even for keys that were held", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.reset();
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("holding a latched modifier and releasing it cancels the latch without re-latching", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  pad.release("ctrl");
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl"] });
  // Going down on the already-latched key records the latch; lifting must
  // toggle it off, not stack a second latch on top.
  clock.advance(50);
  assert.deepEqual(pad.press(ctrl), { state: { held: ["ctrl"], latched: ["ctrl"] }, data: null });
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS - 100);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[A" });
});

test("holding an already-latched modifier past the threshold and releasing it also cancels the latch", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  pad.release("ctrl");
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl"] });
  clock.advance(50);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("tapping one of several latched modifiers toggles only that one off", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  pad.press(alt);
  pad.release("alt");
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl", "alt"] });
  pad.press(ctrl);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: ["alt"] }, data: null });
  // Only alt survives: the chord carries alt (code 3), not ctrl.
  assert.deepEqual(pad.press(down), { state: { held: ["down"], latched: [] }, data: "\x1b[1;3B" });
});

test("two held modifiers drop on release in turn and the next press is plain", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  pad.press(alt);
  clock.advance(50);
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "alt", "up"], latched: [] }, data: "\x1b[1;7A" });
  pad.release("up");
  // Lifting each detected hold drops its modifier; nothing re-latches.
  // alt went down 50ms before the hold window closed, so advance to t=350.
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS - 50);
  pad.release("alt");
  clock.advance(50);
  pad.release("ctrl");
  assert.deepEqual(pad.state(), { held: [], latched: [] });
  assert.deepEqual(pad.press(right), { state: { held: ["right"], latched: [] }, data: "\x1b[C" });
  pad.release("right");
  // Both modifiers were dropped by the holds; the next press is plain.
  assert.deepEqual(pad.press(down), { state: { held: ["down"], latched: [] }, data: "\x1b[B" });
});

test("a held modifier interleaved with a latched one resets together on a keypress, and the hold drops on release", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(alt);
  clock.advance(50);
  pad.release("alt");
  clock.advance(50);
  pad.press(ctrl);
  clock.advance(50);
  assert.deepEqual(pad.state(), { held: ["ctrl"], latched: ["alt"] });
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], latched: [] }, data: "\x1b[1;7A" });
  pad.release("up");
  // The latched alt was consumed; lifting the held ctrl (down since t=100,
  // lifted at t=450) drops it too, so nothing stays armed and the next
  // press is plain.
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(down), { state: { held: ["down"], latched: [] }, data: "\x1b[B" });
});

test("all three latched modifiers combine into one arrow chord", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  pad.press(alt);
  pad.release("alt");
  pad.press(shift);
  pad.release("shift");
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl", "alt", "shift"] });
  // shift(1) + alt(2) + ctrl(4) + base 1 = modifier code 8.
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[1;8A" });
  pad.release("up");
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("a latched modifier fires a non-arrow chord and then stops applying", () => {
  const pad = createUtilityKeyPad();
  pad.press(shift);
  pad.release("shift");
  assert.deepEqual(pad.press(tab), { state: { held: ["tab"], latched: [] }, data: "\x1b[Z" });
  pad.release("tab");
  // The latch was consumed by the shift-tab chord: the next tab is plain.
  assert.deepEqual(pad.press(tab), { state: { held: ["tab"], latched: [] }, data: "\t" });
});

test("a latched alt escapes a plain character", () => {
  const pad = createUtilityKeyPad();
  pad.press(alt);
  pad.release("alt");
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: "\x1b|" });
});

test("only the first typed character of a burst receives the latched modifier", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.consume("c"), { state: { held: [], latched: [] }, data: "\x03" });
  assert.deepEqual(pad.consume("d"), { state: { held: [], latched: [] }, data: "d" });
});

test("pressing a value key that is already held is a no-op", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: "|" });
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: null });
  assert.deepEqual(pad.release("pipe"), { state: { held: [], latched: [] }, data: null });
});

test("a dynamically updated threshold is consulted on each release", () => {
  // Mirrors MobileTerminal: the pad starts on the default threshold and
  // the Android system's long-press timeout may replace it mid-session.
  const clock = fakeClock();
  let threshold = MODIFIER_HOLD_THRESHOLD_MS;
  const pad = createUtilityKeyPad(clock.now, () => threshold);
  pad.press(ctrl);
  clock.advance(200);
  threshold = 500; // the system value arrives mid-hold
  clock.advance(200);
  pad.release("ctrl"); // down 400ms < the new 500ms threshold: a tap latches
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl"] });
  clock.advance(50);
  pad.press(ctrl);
  clock.advance(50);
  pad.release("ctrl"); // quick tap on the armed key toggles the latch off
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("release at exactly the updated threshold counts as a hold", () => {
  const clock = fakeClock();
  let threshold = MODIFIER_HOLD_THRESHOLD_MS;
  const pad = createUtilityKeyPad(clock.now, () => threshold);
  pad.press(ctrl);
  threshold = 1000;
  clock.advance(1000);
  pad.release("ctrl"); // exactly 1000ms >= 1000ms: a detected hold drops
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("state snapshots are independent of later mutation", () => {
  const pad = createUtilityKeyPad();
  pad.press(ctrl);
  pad.release("ctrl");
  const snapshot = pad.state();
  pad.press(up);
  pad.release("up");
  assert.deepEqual(snapshot, { held: [], latched: ["ctrl"] });
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("a cancelled hold drops the moment the pointer is cancelled", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  // The finger slid off the key and the platform took the gesture away:
  // no pointerup will ever arrive, but the key must not outlive the
  // finger either, so the detected hold drops with the cancel.
  assert.deepEqual(pad.cancel("ctrl"), { state: { held: [], latched: [] }, data: null });
  // Nothing lingers: the next keypress is plain.
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[A" });
  pad.release("up");
});

test("a key pressed after a cancelled hold behaves as a fresh press", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.cancel("ctrl"); // the hold drops, nothing is re-tracked
  // A new press on the same key starts a plain hold; releasing it after
  // the threshold drops it again.
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[A" });
});

test("a quick cancelled tap keeps the tap-toggle semantics", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  assert.deepEqual(pad.cancel("ctrl"), { state: { held: [], latched: ["ctrl"] }, data: null });
});

test("cancelling a value key just drops it, as a release does", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: "|" });
  assert.deepEqual(pad.cancel("pipe"), { state: { held: [], latched: [] }, data: null });
});

test("cancelling a key that is not held is a no-op", () => {
  const pad = createUtilityKeyPad();
  assert.deepEqual(pad.cancel("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("a cancelled hold leaves no modifier on typed input", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.cancel("ctrl");
  // The hold dropped with the cancel, so typing is plain text.
  assert.deepEqual(pad.consume("d"), { state: { held: [], latched: [] }, data: "d" });
});

test("cancelling a hold leaves live holds untouched", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.cancel("ctrl");
  pad.press(alt);
  assert.deepEqual(pad.state(), { held: ["alt"], latched: [] });
  // The live alt hold (down since t=300) drops normally on release.
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("alt"), { state: { held: [], latched: [] }, data: null });
});

test("a cancelled hold clears a latch from an earlier tap", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  pad.release("ctrl"); // tap latches ctrl on
  assert.deepEqual(pad.state(), { held: [], latched: ["ctrl"] });
  clock.advance(50);
  pad.press(ctrl); // go down on the armed key again
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.cancel("ctrl"); // the detected hold drops, and cancels the latch
  assert.deepEqual(pad.state(), { held: [], latched: [] });
  assert.deepEqual(pad.press(up), { state: { held: ["up"], latched: [] }, data: "\x1b[A" });
});

test("cancelling the key that completed a chord keeps the held modifier active", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.press(up), { state: { held: ["ctrl", "up"], latched: [] }, data: "\x1b[1;5A" });
  // The up-arrow pointer slid off: cancel it. The chord already fired,
  // but the ctrl hold is still live and must survive up's cancel.
  assert.deepEqual(pad.cancel("up"), { state: { held: ["ctrl"], latched: [] }, data: null });
  // The still-held ctrl keeps applying to the next keypress...
  assert.deepEqual(pad.press(left), { state: { held: ["ctrl", "left"], latched: [] }, data: "\x1b[1;5D" });
  pad.release("left");
  // ...and the hold drops when ctrl's own pointer lifts after the threshold.
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("cancelling one of two held modifiers keeps the other", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.press(alt);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  // The ctrl pointer slid off; alt is still being held on its own pointer.
  assert.deepEqual(pad.cancel("ctrl"), { state: { held: ["alt"], latched: [] }, data: null });
  // Only alt arms the next chord; the cancelled ctrl is not latched.
  assert.deepEqual(pad.press(up), { state: { held: ["alt", "up"], latched: [] }, data: "\x1b[1;3A" });
  pad.release("up");
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  assert.deepEqual(pad.release("alt"), { state: { held: [], latched: [] }, data: null });
});

test("a quick cancelled tap of a value key sends nothing", () => {
  const pad = createUtilityKeyPad();
  // The value already fired on press; the cancel only drops the press.
  assert.deepEqual(pad.press(pipe), { state: { held: ["pipe"], latched: [] }, data: "|" });
  assert.deepEqual(pad.cancel("pipe"), { state: { held: [], latched: [] }, data: null });
  assert.deepEqual(pad.state(), { held: [], latched: [] });
});

test("releasing a cancelled key is a no-op", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.cancel("ctrl"); // the hold already dropped with the cancel
  // A late pointerup for the dead pointer (or any other stray release)
  // must not disturb the state a second time.
  assert.deepEqual(pad.release("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("a second cancel of the same key is a no-op", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(MODIFIER_HOLD_THRESHOLD_MS);
  pad.cancel("ctrl");
  assert.deepEqual(pad.cancel("ctrl"), { state: { held: [], latched: [] }, data: null });
});

test("a cancelled quick tap on a latched modifier toggles the latch off", () => {
  const clock = fakeClock();
  const pad = createUtilityKeyPad(clock.now);
  pad.press(ctrl);
  clock.advance(50);
  pad.release("ctrl"); // tap latches ctrl on
  clock.advance(50);
  pad.press(ctrl); // go down on the armed key again
  clock.advance(50); // still under the threshold: this is a tap
  // The pointer slid off before the lift: cancel ends with release
  // semantics, and because the key was latched at press, the tap
  // toggles the latch off.
  assert.deepEqual(pad.cancel("ctrl"), { state: { held: [], latched: [] }, data: null });
});
