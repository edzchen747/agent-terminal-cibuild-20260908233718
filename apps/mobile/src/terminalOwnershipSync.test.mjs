import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function source(name) {
  return readFileSync(join(SRC_DIR, name), "utf8");
}

const terminal = source("MobileTerminal.tsx");
const connection = source("connection.ts");

test("a tap's claim survives coalescing with an already-queued layout announce", () => {
  // resize() used to drop the closure's own `force` flag into the rAF
  // callback, so a tap that landed while an unforced (layout-driven) frame
  // was already queued had its claim silently discarded - the queued
  // callback had already captured force=false. pendingForce must be a
  // variable both calls OR into, read only once the frame actually fires.
  assert.ok(terminal.includes("let pendingForce = false;"),
    "the claim flag must live outside the per-call closure so it survives coalescing");
  assert.ok(terminal.includes("pendingForce ||= force;"),
    "a later call's claim must never be lost to an earlier, already-queued unforced call");
  assert.ok(terminal.includes("const claim = pendingForce;\n        pendingForce = false;"),
    "the queued frame must read whichever call claimed, then reset for the next one");
});

test("opening the terminal view re-measures and re-claims once the page has actually laid out", () => {
  // The attach's own claim measures mid page-transition (or before first
  // paint) and can land at a stale or fallback size; a plain re-attach does
  // not fix that on its own, so becoming active must also schedule a fresh
  // claiming resize() once layout has settled.
  const activeGating = terminal.slice(terminal.indexOf("Set S membership follows the visible view"));
  assert.ok(activeGating.includes("claimFrame = window.requestAnimationFrame(() => {\n        claimFrame = undefined;\n        resizeRef.current(true);\n      });"),
    "becoming active (or foregrounding) must schedule a fresh claim after a layout pass");
  assert.ok(activeGating.includes("scheduleClaim();\n    const handleVisibility"),
    "the claim must be scheduled right away, not only on a later visibility flip");
  assert.ok(activeGating.includes("if (claimFrame !== undefined) window.cancelAnimationFrame(claimFrame);"),
    "a stale pending claim must never fire after a release that follows it (rapid flapping)");
});

test("leaving the terminal view forgets the last announced size", () => {
  // shouldSendResize suppresses an announce whose size has not changed;
  // without forgetting, a return to an unchanged-size page could see its
  // own claiming resize() suppressed by that stale memory.
  assert.ok(terminal.includes("forgetLastSizeRef.current();"),
    "leaving the page must forget the last announced size so a return always re-announces");
  assert.ok(terminal.includes("forgetLastSizeRef.current = () => {\n      lastSize = { cols: 0, rows: 0 };\n    };"),
    "forgetting must reset the coalescer's own memory of the last announced size");
});

test("backgrounding releases the viewport deterministically instead of waiting on the watchdog", () => {
  assert.ok(terminal.includes('connection.send({ type: "session.viewport.release", requestId: createRequestId(), sessionId: session.id });'),
    "the page going hidden while still active must explicitly leave set S");
  assert.ok(connection.includes("session.viewport.release"),
    "connection.ts's keepalive doc should account for the explicit release path");
});

test("every input path carries the sender's viewport, so typing always claims", () => {
  // An unclaimed session.input still applies under apply_owner_grid_for
  // only while the sender already owns the grid; carrying no dims at all
  // means the host cannot even record the announce, let alone claim with
  // it. Three call sites send session.input: the utility-key pad
  // (sendKeyData), xterm's own onData, and the native IME path (sendInput).
  const sendKeyData = terminal.slice(terminal.indexOf("const sendKeyData = "), terminal.indexOf("const vibrate = "));
  assert.ok(sendKeyData.includes("announcedGridRef.current()"),
    "sendKeyData must read the announced viewport through the ref bridge (it lives outside the terminal effect)");
  assert.ok(sendKeyData.includes("data, cols: dims?.cols, rows: dims?.rows"),
    "sendKeyData must forward cols/rows on session.input");

  const onDataHandler = terminal.slice(terminal.indexOf("const input = terminal.onData((data) => {"), terminal.indexOf("const handleNativeBeforeInput = "));
  assert.ok(onDataHandler.includes("const dims = announcedGrid();"),
    "xterm's onData (used for pasted/composed text) must measure the viewport too");
  assert.ok(onDataHandler.includes("data, cols: dims?.cols, rows: dims?.rows"),
    "xterm's onData must forward cols/rows on session.input");

  const sendInput = terminal.slice(terminal.indexOf("const sendInput = (data: string) => {"), terminal.indexOf("const flushPendingInput = "));
  assert.ok(sendInput.includes("cols: dims?.cols, rows: dims?.rows"),
    "the native IME input path must keep forwarding cols/rows on session.input");
});
