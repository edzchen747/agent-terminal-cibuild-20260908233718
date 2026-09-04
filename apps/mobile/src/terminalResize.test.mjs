import assert from "node:assert/strict";
import test from "node:test";
import { announcedViewport, shouldSendResize } from "./terminalResize.ts";

test("an announcement sends a resize only when the size changed", () => {
  const last = { cols: 80, rows: 24 };

  assert.equal(shouldSendResize(80, 24, last), false);
  assert.equal(shouldSendResize(100, 24, last), true);
  assert.equal(shouldSendResize(80, 30, last), true);
});

test("the keyboard-open viewport gives up exactly one row", () => {
  const dims = { cols: 45, rows: 25 };
  assert.deepEqual(announcedViewport(dims, true), { cols: 45, rows: 24 });
  // The columns are untouched.
  assert.deepEqual(announcedViewport({ cols: 120, rows: 30 }, true), { cols: 120, rows: 29 });
});

test("the keyboard-closed viewport is the plain fit", () => {
  assert.deepEqual(announcedViewport({ cols: 45, rows: 25 }, false), { cols: 45, rows: 25 });
});

test("the keyboard-ledger never drops below one row", () => {
  assert.deepEqual(announcedViewport({ cols: 45, rows: 1 }, true), { cols: 45, rows: 1 });
  assert.deepEqual(announcedViewport({ cols: 45, rows: 0 }, true), { cols: 45, rows: 1 });
});

test("announcements do not mutate the caller's dims", () => {
  const dims = { cols: 45, rows: 25 };
  announcedViewport(dims, true);
  assert.deepEqual(dims, { cols: 45, rows: 25 });
});
