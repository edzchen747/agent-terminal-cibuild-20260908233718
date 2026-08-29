import assert from "node:assert/strict";
import test from "node:test";
import { shouldSendResize } from "./terminalResize.ts";

test("a forced fit sends a resize even when the local size is unchanged", () => {
  // The regression behind mobile key input not resizing the PTY: another
  // client (or a lost message) moved the host PTY size while this client's
  // local fit stayed the same. A plain observer fit would detect no local
  // change and stay silent; forced input paths must still reassert.
  const last = { cols: 80, rows: 24 };

  assert.equal(shouldSendResize(true, 80, 24, last), true);
});

test("an unforced fit sends a resize only when the size changed", () => {
  const last = { cols: 80, rows: 24 };

  assert.equal(shouldSendResize(false, 80, 24, last), false);
  assert.equal(shouldSendResize(false, 100, 24, last), true);
  assert.equal(shouldSendResize(false, 80, 30, last), true);
});
