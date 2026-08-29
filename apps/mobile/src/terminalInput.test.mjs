import assert from "node:assert/strict";
import test from "node:test";
import { androidImeKeydownInput, claimNativeInput, isCursorPositionReport, nativeTerminalInput, shouldDeferToNativeInput } from "./terminalInput.ts";

test("a matching native event replaces, rather than drops, the queued xterm character", () => {
  const terminal = [{ data: "a", at: 10 }];

  assert.equal(claimNativeInput({ data: "a", at: 15 }, terminal), "a");
  assert.deepEqual(terminal, []);
});

test("recognizes xterm cursor-position replies as terminal control data", () => {
  assert.equal(isCursorPositionReport("\x1b[12;34R"), true);
  assert.equal(isCursorPositionReport("\x1b[?12;34R"), true);
  assert.equal(isCursorPositionReport("\x1b[12;34C"), false);
  assert.equal(isCursorPositionReport("\x1b[12;34Rtail"), false);
});

test("an authoritative native event replaces a phantom xterm event", () => {
  const terminal = [{ data: "Process", at: 10 }];

  assert.equal(claimNativeInput({ data: "p", at: 15 }, terminal), "p");
  assert.deepEqual(terminal, []);
});

test("Android Backspace remains available through both input paths", () => {
  assert.equal(nativeTerminalInput({ data: null, inputType: "deleteContentBackward", isComposing: false }), "\x7f");
  assert.equal(androidImeKeydownInput({ type: "keydown", key: "Backspace", keyCode: 229, isComposing: false }), "\x7f");
});

test("only printable IME keydowns defer to native input", () => {
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "a", keyCode: 229, isComposing: false }), true);
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "Process", keyCode: 229, isComposing: false }), false);
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "Unidentified", keyCode: 229, isComposing: false }), false);
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "Process", keyCode: 229, isComposing: true }), false);
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "Backspace", keyCode: 229, isComposing: false }), false);
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "Enter", keyCode: 229, isComposing: false }), false);
  assert.equal(shouldDeferToNativeInput({ type: "keydown", key: "a", keyCode: 65, isComposing: false }), false);
  assert.equal(androidImeKeydownInput({ type: "keydown", key: "Enter", keyCode: 229, isComposing: false }), "\r");
});
