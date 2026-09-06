import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Grid-ownership wiring guards: the sizing bugs this covers were all client-
// side (the host's ownership policy in core.rs was already correct and
// symmetric between desktop and mobile) - a hidden tab that never released
// its viewport, and a claim that could be sent from outside the pane itself.
const terminalPaneSource = readFileSync(
  fileURLToPath(new URL("./TerminalPane.tsx", import.meta.url)),
  "utf8"
);

test("a hidden pane releases its viewport instead of silently keeping ownership", () => {
  // Every session's pane stays mounted for as long as its project is open
  // (App.tsx renders them all); only visibility toggles. Without an
  // explicit release, a desktop tab left showing session A while switching
  // to tab B would keep owning A's grid even though nothing is looking at
  // it - the phone could never take A back except through the watchdog,
  // which does not evict in-process desktop panes at all.
  assert.ok(terminalPaneSource.includes("window.agentTerminal.releaseSessionViewport(sessionId)"),
    "becoming invisible must release the viewport, not merely stop resizing");
  assert.ok(terminalPaneSource.includes("void pendingAttachRef.current.then(() => window.agentTerminal.releaseSessionViewport(sessionId));"),
    "the release must be sequenced after the in-flight attach, so it can never be overtaken by the claim attach may still register");
});

test("becoming visible re-announces, claiming only if this is also the active tab", () => {
  assert.ok(terminalPaneSource.includes("window.requestAnimationFrame(() => resizeRef.current(activeRef.current));"),
    "a visible-but-inactive split pane must join set S unclaimed, not steal the grid merely by being shown");
});

test("resize() no longer gates the announcement on being the active pane", () => {
  // A visible, non-active split pane must still be a candidate the host can
  // reselect onto (reselect_owner_on_departure) if the active pane leaves -
  // which requires it to actually be in set S.
  const resizeFn = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const resize = (claim = false) => {"),
    terminalPaneSource.indexOf("resizeRef.current = resize;")
  );
  assert.ok(!/if \(!activeRef\.current\) return;/.test(resizeFn),
    "resize() must not bail out for a visible, merely-inactive pane");
  assert.ok(resizeFn.includes("announceViewport(claim);"));
});

test("a pointerdown claims only when it lands inside this pane", () => {
  // A window-wide capture listener used to claim the grid for whatever pane
  // was active on ANY click in the app - the sidebar, the tab bar, another
  // pane's split toolbar - none of which are an interaction with the
  // session actually being resized.
  assert.ok(terminalPaneSource.includes("!hostRef.current?.contains(event.target)"),
    "the claiming pointerdown handler must be scoped to this pane's own host element");
});

test("an attach claims only a measured viewport, gated on visibility as well as being active", () => {
  // Claiming xterm's unfitted default grid (what terminal.cols/rows still
  // are before the first paint) would resize the shared PTY to a size the
  // pane never displayed. An unmeasured attach is a pure stream
  // subscription; finishAttachment claims with the real post-replay size.
  assert.ok(terminalPaneSource.includes("const claim = proposed !== null && visibleRef.current && activeRef.current;"),
    "the initial attach must not claim for a pane that is active but not (yet) visible, and must not claim an unmeasured viewport");
  assert.ok(terminalPaneSource.includes("window.agentTerminal.attachSession(sessionId, dims.cols, dims.rows, claim)"),
    "the attach's claim flag must be the measured-and-visible-and-active gate, not a raw visibility check");
});

test("finishAttachment re-measures and claims for the active tab after the replay", () => {
  // A fresh active mount's attach claim (if any) predates the first paint.
  // Once the replay has painted, the pane's real size exists and opening
  // the tab is an interaction: claim it then. A same-size claim is a no-op
  // at the host (apply_session_grid skips an unchanged grid), so a
  // well-measured attach costs nothing.
  const finish = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const finishAttachment = () => {"),
    terminalPaneSource.indexOf("const replayPending = () => {")
  );
  assert.ok(finish.includes("resizeRef.current(activeRef.current);"),
    "the post-replay resync must claim when this pane is the active tab");
});
