import assert from "node:assert/strict";
import test from "node:test";
import { isRetryingSavedHost } from "./connectionFlow.ts";

// ---- Connecting splash: cancel button and desktop name gating ---------------

test("the splash offers cancel and the desktop name only while retrying a saved host", () => {
  assert.equal(isRetryingSavedHost("connecting", true), true);
});

test("the initial app-open load never offers cancel", () => {
  // There is no saved desktop yet on first open; cancelling would only strand
  // the user with no meaningful try-again target.
  assert.equal(isRetryingSavedHost("loading", false), false);
});

test("an in-flight QR pairing (no live connection) never offers cancel", () => {
  assert.equal(isRetryingSavedHost("connecting", false), false);
});

test("every other status never offers cancel, with or without a live connection", () => {
  for (const status of ["loading", "pairing", "connected", "error"]) {
    assert.equal(isRetryingSavedHost(status, true), false, status);
    assert.equal(isRetryingSavedHost(status, false), false, status);
  }
});

test("the full status x connection matrix yields exactly one true cell", () => {
  const statuses = ["loading", "pairing", "connecting", "connected", "error"];
  const trues = statuses.flatMap((status) => [true, false].map((has) => ({ status, has, value: isRetryingSavedHost(status, has) })));
  const hits = trues.filter((cell) => cell.value);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { status: "connecting", has: true, value: true });
});
