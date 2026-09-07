import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function source(name) {
  // The working tree may be checked out with CRLF terminators while these
  // source-grep assertions use "\n"; normalize so they hold under either.
  return readFileSync(join(SRC_DIR, name), "utf8").replace(/\r\n/g, "\n");
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

test("the baseline cell exists even when the baseline font never paints", () => {
  // captureBaseCell used to record a cell only while the emulator painted
  // at TERMINAL_FONT_SIZE - which only happens before the first host grid
  // lands. Once the fill pass moves the font, baseCell stayed null forever
  // (or the terminal simply never painted at the baseline), announcedGrid()
  // returned null, and every claiming resize silently no-opped: opening
  // the terminal on the phone resized the PTY only when a desktop tab
  // happened to hold the grid. When the live font is not the baseline, the
  // face must be probed at the baseline font instead (same mirror-span
  // pattern calibrateAccessibilityMetrics uses).
  const capture = terminal.slice(terminal.indexOf("const captureBaseCell = () => {"), terminal.indexOf("const proposeGrid = () => {"));
  assert.ok(capture.includes("probe.className = \"xterm-char-measure-element\";"),
    "a non-baseline font must be replaced by a probe of the face at TERMINAL_FONT_SIZE");
  assert.ok(capture.includes("probe.style.fontSize = `${TERMINAL_FONT_SIZE}px`;"),
    "the probe must measure at the baseline font, not at the live fill size");
  assert.ok(capture.includes("const width = probe.offsetWidth / 32;"),
    "the probe must report layout-space (pre-squish) - what cellSize() and the announcement both use");
  assert.ok(capture.includes("baseCell = { width, height: TERMINAL_FONT_SIZE };"),
    "the probed cell must become the announcement's baseline reference");
  assert.ok(capture.includes("fontSize === TERMINAL_FONT_SIZE"),
    "a direct capture at the baseline font must keep being taken (it is the most exact source)");
});

test("the attach claim only carries a measured viewport", () => {
  // claim: true unconditionally would claim xterm's unfitted default
  // (80x24 - what terminal.cols/rows still are before the first paint)
  // for the phone, resizing the shared PTY to a size it never displayed.
  // An unmeasured attach is a pure stream subscription; the post-replay
  // claiming resize takes the grid over with a real measurement.
  assert.ok(terminal.includes("const announced = announcedGrid();"),
    "the attach must check whether the viewport was actually measured");
  assert.ok(terminal.includes("claim: announced !== null"),
    "only a measured viewport may be claimed on attach");
});

test("finishAttachment re-measures and claims after the replay, so a fresh open always lands the phone's grid", () => {
  // The attach's claim (when it had one) measured mid-transition, and the
  // [active] effect's rAF claim usually fires before the attach reply has
  // even arrived. Once the replay has painted the host grid and the fill
  // pass settled, the real post-replay measurement exists: opening the
  // view is an interaction, so claim it then. A same-size claim is a no-op
  // at the host (apply_session_grid skips an unchanged grid), so a
  // well-measured attach costs nothing.
  const finish = terminal.slice(terminal.indexOf("const finishAttachment = () => {"), terminal.indexOf("const replayPendingOutput = () => {"));
  assert.ok(finish.includes("if (activeRef.current) resize(true);"),
    "a fresh open (or reconnect) must claim with the post-replay measurement");
});

test("organic viewport announces are suppressed for the whole journal replay", () => {
  // The desktop's replay gate (merge.attached) was ported only as the
  // blocking overlay: with the overlay hiding the reflow storm, the
  // ResizeObserver kept announcing - and the tap/slider claims kept
  // claiming - the container grid segment by segment mid-replay, stamping
  // the PTY (and re-stamping every other client) until the grid started
  // flip-flopping between the clients. The queued frame must still run
  // the fill pass (applyZoom is render-only and the replay has to paint),
  // then drop the announce while the replay gate is down.
  const resizeFn = terminal.slice(terminal.indexOf("const resize = (force = false) => {"), terminal.indexOf("resizeRef.current = resize;"));
  const fillPass = resizeFn.indexOf("applyZoom();");
  const gate = resizeFn.indexOf("if (!initialized) return;");
  const announce = resizeFn.indexOf("const dims = announcedGrid();");
  const send = resizeFn.indexOf('connection.send({ type: "session.resize"');
  assert.ok(fillPass >= 0 && gate > fillPass && announce > gate && send > announce,
    "the frame must run the fill pass, then gate the announce (and therefore the send) on the replay gate");
  assert.ok(resizeFn.includes("const claim = pendingForce;\n        pendingForce = false;"),
    "the claim flag must be read and reset before the gate, so a swallowed frame never latches a stale claim");
  // The gate must be a variable declared BEFORE resize (startAttachment
  // lowers it, finishAttachment lifts it), not a closure that only works
  // by call-order luck.
  const declaration = terminal.indexOf("let initialized = false;");
  assert.ok(declaration >= 0 && declaration < terminal.indexOf("const resize = (force = false) => {"),
    "the replay gate must be hoisted above resize() so its suppression is not call-order luck");
  assert.strictEqual(terminal.match(/let initialized = false;/g)?.length, 1,
    "the gate must be declared exactly once (the old later declaration would shadow nothing and confuse the reader)");
  // And the gate must lift exactly once, per attach: finishAttachment is
  // the only place that re-announces after the drain (plus the failed-
  // attach path below), so the re-announce cannot double up either.
  const finish = terminal.slice(terminal.indexOf("const finishAttachment = () => {"), terminal.indexOf("const replayPendingOutput = () => {"));
  const lift = finish.indexOf("initialized = true;");
  const reClaim = finish.indexOf("if (activeRef.current) resize(true);");
  assert.ok(lift >= 0 && reClaim > lift,
    "finishAttachment must lift the gate, then re-announce with a fresh claiming measurement - exactly once");
});

test("tap claims are suppressed while a journal replay is in flight", () => {
  // A tap mid-replay measures a size the replayed segments are still
  // driving; claiming it would stamp the PTY mid-replay. finishAttachment
  // claims once the drain is done, so the tap is never simply lost (the
  // desktop gates its pointerdown claim on merge.attached the same way).
  const pointerUp = terminal.slice(terminal.indexOf("const handlePointerUp = (event: PointerEvent) => {"), terminal.indexOf("const handlePointerCancel = "));
  assert.ok(pointerUp.includes("if (initialized) resize(true);"),
    "the mouse tap's claim must wait for the replay gate to lift");
  const touchEnd = terminal.slice(terminal.indexOf("const handleTouchEnd = (event: TouchEvent) => {"), terminal.indexOf("const handleTouchCancel = () => {"));
  assert.ok(touchEnd.includes("if (initialized) resize(true);"),
    "the touch tap's claim must wait for the replay gate to lift");
});

test("a failed attach runs finishAttachment, so the replay gate never latches shut", () => {
  // With the announce gate in place a bare setReplaying(false) here would
  // leave initialized false forever: the phone could never announce again
  // (every resize frame, tap and slider claim would be swallowed). The
  // desktop closes the lifecycle on this path through finishAttachment
  // too: overlay lifted, gate re-opened, and the post-drain re-claim -
  // and any later tap - can still announce.
  const catchBlock = terminal.slice(terminal.indexOf("}).catch((cause) => {"), terminal.indexOf("attachmentPromise = pending;"));
  assert.ok(catchBlock.includes("finishAttachment();"),
    "the failed-attach path must run finishAttachment, not a bare overlay lift");
  assert.ok(!catchBlock.includes("setReplaying(false)"),
    "the overlay lift must come from finishAttachment, which also re-opens the gate");
  assert.ok(catchBlock.includes("Could not attach terminal"),
    "the red error must still be written after the gate re-opens");
});

test("the startAttachment re-entrancy guard is real", () => {
  // attachmentPromise was declared, read by the guard, and cleared by
  // .then/.catch - but never ASSIGNED, so the guard at the top of
  // startAttachment never fired. Android flaps visibility freely and
  // startAttachment is called from mount, connected, the active effect and
  // visibilitychange; every overlapping call reset the replay state,
  // re-raised the overlay, and ended in its own duplicate claiming resize
  // (the duplicate claim in the sync log). The in-flight promise must be
  // stored so the second call bails, and cleanup's detach sequences after
  // it (it always read undefined before, so it raced the attach).
  const guard = terminal.slice(terminal.indexOf("let attachmentPromise: Promise<unknown> | undefined;"), terminal.indexOf("const announced = announcedGrid();"));
  assert.ok(guard.includes("if (disposed || attachmentPromise !== undefined) return;"),
    "an in-flight attach must suppress a second startAttachment");
  assert.ok(terminal.includes("const pending = connection.request({\n        type: \"session.attach\","),
    "the attach's own promise must be captured, not fire-and-forget");
  assert.ok(terminal.includes("attachmentPromise = pending;"),
    "the guard and cleanup must see the in-flight promise");
  assert.ok(terminal.includes("void (attachmentPromise ?? Promise.resolve())\n        .finally(() => connection.send({ type: \"session.detach\", requestId: createRequestId(), sessionId: session.id }))"),
    "cleanup must still sequence the detach after the in-flight attach");
});

test("the announced viewport is scale-invariant", () => {
  // (offsetWidth - padding) * scale drifted 8 * (1 - scale) with the paint
  // scale (the 8px unscaled padding frame), and the integer offsetWidth
  // added rounding on top: a fill-pass scale change moved the announced
  // width, which moved the announced cols (gridForContent floors it),
  // which moved the grid, which moved the scale again - a self-sustaining
  // loop. Measure the post-transform box in visual space and subtract the
  // padding as an unscaled frame, so renderScale cancels exactly; the
  // fractional rect also drops the integer rounding. The width
  // under-reports the painted width by 8 * (1 - scale), at most 8px - the
  // safe direction (fewer columns, never a clip). Height has no vertical
  // transform, so it keeps the integer offsetHeight.
  const box = terminal.slice(terminal.indexOf("const visualContentBox = (): Size | null => {"), terminal.indexOf("// One UNSQUISHED cell"));
  assert.ok(box.includes("hostElement.getBoundingClientRect()"),
    "the width must come from the post-transform box, not the layout box");
  assert.ok(box.includes("const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);"),
    "the padding must be subtracted as an unscaled frame from the visual width");
  assert.ok(box.includes("const height = hostElement.offsetHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);"),
    "height keeps the integer offsetHeight (no vertical transform)");
  assert.ok(!box.includes("renderScaleRef") && !box.includes("offsetWidth"),
    "the announced viewport must not depend on the live paint scale");
});

test("an overlapping startAttachment must not touch the in-flight replay", () => {
  // The guard must run before ANY replay state is reset: the reported bug
  // was that overlapping calls (mount, connected, the active effect and
  // visibilitychange all firing around an Android flap) reset
  // appliedUpTo/pendingOutput and re-raised the overlay of the replay that
  // was already running - and each one ended in its own duplicate claiming
  // resize (the doubled claim in the sync log).
  const attach = terminal.slice(terminal.indexOf("const startAttachment = () => {"), terminal.indexOf("const announced = announcedGrid();"));
  const guard = attach.indexOf("if (disposed || attachmentPromise !== undefined) return;");
  const lowerGate = attach.indexOf("initialized = false;");
  const raiseOverlay = attach.indexOf("setReplaying(true);");
  const resetQueue = attach.indexOf("pendingOutput.length = 0;");
  assert.ok(guard >= 0 && guard < lowerGate && guard < raiseOverlay && guard < resetQueue,
    "the guard must precede every replay-state mutation an overlapping call used to make");
});

test("a claim latched mid-replay is consumed, never carried across the gate", () => {
  // The frame reads AND resets pendingForce before the replay gate, so a
  // force latched while a replay is in flight is dropped by the swallowed
  // frame instead of leaking into the post-replay frame and claiming a
  // stale measurement. The post-drain claim is finishAttachment's own
  // forcing resize (a fresh measurement), so nothing is owed by the
  // latched force.
  const resizeFn = terminal.slice(terminal.indexOf("const resize = (force = false) => {"), terminal.indexOf("resizeRef.current = resize;"));
  const reset = resizeFn.indexOf("pendingForce = false;");
  const gate = resizeFn.indexOf("if (!initialized) return;");
  assert.ok(reset >= 0 && reset < gate,
    "the claim flag must be read and reset before the gate, so a swallowed frame drops the force it just read");
  const finish = terminal.slice(terminal.indexOf("const finishAttachment = () => {"), terminal.indexOf("const replayPendingOutput = () => {"));
  assert.ok(finish.includes("if (activeRef.current) resize(true);"),
    "the post-drain claim is a fresh forcing resize, not a force latched during the replay");
});

test("the replay gate has exactly one lowering site and exactly one lifting site", () => {
  // startAttachment lowers the gate, and it must do so for EVERY attach -
  // a reconnect or re-foreground must re-gate its replay, or a second
  // replay would stamp the PTY segment by segment again. finishAttachment
  // is the only lifter, so the post-drain announce cannot double up and
  // no other path can silently re-open the gate.
  const attach = terminal.slice(terminal.indexOf("const startAttachment = () => {"), terminal.indexOf("const announced = announcedGrid();"));
  assert.ok(attach.includes("initialized = false;"),
    "every attach - mount, reconnect, re-foreground - must lower the gate for its replay");
  assert.strictEqual(terminal.split("\n      initialized = false;\n").length - 1, 1,
    "exactly one site may lower the gate (startAttachment, after the re-entrancy guard - not the declaration)");
  assert.strictEqual(terminal.split("initialized = true;").length - 1, 1,
    "exactly one site may lift the gate (finishAttachment)");
});

test("a failed attach does not wedge the re-entrancy guard", () => {
  // A kill-mid-attach must leave the guard clear: if attachmentPromise
  // stayed set after the failure, every later attach attempt - host
  // restarted, user taps again, app re-foregrounds - would bail at the
  // guard and the phone could never re-attach.
  const thenBlock = terminal.slice(terminal.indexOf("}).then((message) => {"), terminal.indexOf("}).catch((cause) => {"));
  assert.ok(thenBlock.includes("attachmentPromise = undefined;"),
    "a settled attach must clear the guard so the next attach can start");
  const catchBlock = terminal.slice(terminal.indexOf("}).catch((cause) => {"), terminal.indexOf("attachmentPromise = pending;"));
  const clear = catchBlock.indexOf("attachmentPromise = undefined;");
  const reOpen = catchBlock.indexOf("finishAttachment();");
  assert.ok(clear >= 0 && reOpen > clear,
    "a failed attach must clear the guard, so a retry can start (and the gate re-opens only after the clear)");
});

test("a disposed component never re-opens the gate or paints the error", () => {
  // The catch's disposed check must come before finishAttachment (which
  // would run resize() and the focus hand-off inside a disposed effect)
  // and before the red terminal.write (a disposed xterm instance must not
  // be painted).
  const catchBlock = terminal.slice(terminal.indexOf("}).catch((cause) => {"), terminal.indexOf("attachmentPromise = pending;"));
  const disposed = catchBlock.indexOf("if (disposed) return;");
  const reOpen = catchBlock.indexOf("finishAttachment();");
  const errorWrite = catchBlock.indexOf("terminal.write(");
  assert.ok(disposed >= 0 && disposed < reOpen && reOpen < errorWrite,
    "the disposed check must precede both the gate re-open and the error write");
});

test("the fill pass and the announcement share one measured box", () => {
  // The ratchet ran while the two paths could measure different boxes: a
  // fill-pass scale change moved one without the other. Both must consume
  // visualContentBox(), so whatever the box reports, the paint and the
  // announcement move together - and after the post-transform rewrite,
  // together at all.
  const applyZoom = terminal.slice(terminal.indexOf("const applyZoom = "), terminal.indexOf("let resizeFrame: number | undefined;"));
  assert.ok(applyZoom.includes("const content = visualContentBox();"),
    "the fill pass must measure the same box the announcement measures");
  const propose = terminal.slice(terminal.indexOf("const proposeGrid = () => {"), terminal.indexOf("const announcedGrid = () => {"));
  assert.ok(propose.includes("const content = visualContentBox();"),
    "the announced viewport must come from the same box the fill pass fits");
});

test("a zero-sized box still announces nothing", () => {
  // A host element that has not laid out (the WebView hidden mid-attach)
  // must degrade to the unmeasured attach - claim deferred to the
  // post-replay resize - never to a zero-column claim that would resize
  // the shared PTY to nothing.
  const box = terminal.slice(terminal.indexOf("const visualContentBox = (): Size | null => {"), terminal.indexOf("// One UNSQUISHED cell"));
  assert.ok(box.includes("if (!(width > 0 && height > 0)) return null;"),
    "a non-positive box must stay unmeasurable, not announce a degenerate grid");
});

test("a tap mid-replay still focuses the terminal; it only loses its claim", () => {
  // The gate suppresses the grid claim, not the interaction: a tap during
  // replay must still hand focus to the IME field (the user is typing
  // into the terminal even mid-replay); only the resize claim is deferred
  // to finishAttachment.
  const pointerUp = terminal.slice(terminal.indexOf("const handlePointerUp = (event: PointerEvent) => {"), terminal.indexOf("const handlePointerCancel = "));
  const focus = pointerUp.indexOf("applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));");
  const claim = pointerUp.indexOf("if (initialized) resize(true);");
  assert.ok(focus >= 0 && focus < claim,
    "the tap's focus hand-off must run un-gated, before the gated claim");
});
