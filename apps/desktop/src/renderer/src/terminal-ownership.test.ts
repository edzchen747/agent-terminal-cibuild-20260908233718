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
const appSource = readFileSync(
  fileURLToPath(new URL("./App.tsx", import.meta.url)),
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

test("becoming visible re-announces, claiming only for a user-driven active tab", () => {
  // A visible-but-inactive split pane must join set S unclaimed, not
  // steal the grid merely by being shown - and neither may a tab the
  // host auto-selected when a cd moved the session into a project
  // (claimOnActivate false): that activation is the host following a
  // session somebody else is interacting with, so claiming would steal
  // the grid from under them (the phone that ran the cd).
  assert.ok(terminalPaneSource.includes("window.requestAnimationFrame(() => resizeRef.current(activeRef.current && claimOnActivateRef.current));"),
    "a visible-but-inactive split pane, and a host auto-selected tab, must join set S unclaimed, not steal the grid");
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

test("an activation claims only for a user-driven active tab", () => {
  // Selecting this tab is an explicit open of THIS terminal, so the
  // announce claims the PTY grid. The exception: a tab the host
  // auto-selected when a cd moved the session into a new project - the
  // user did not open the terminal, so the unclaimed announce keeps the
  // pane in set S (a successor candidate) without stealing the grid
  // from the client that is actually interacting (the phone that ran the
  // cd). A real interaction (a tab click, a click in the pane, typing)
  // claims through its own paths, and a tab click also clears the mark.
  assert.ok(terminalPaneSource.includes("resizeRef.current(claimOnActivateRef.current);"),
    "becoming active must claim only when the activation was user-driven (claimOnActivate)");
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

test("finishAttachment re-measures and claims for a user-driven active tab after the replay", () => {
  // A fresh active mount's attach claim (if any) predates the first paint.
  // Once the replay has painted, the pane's real size exists and opening
  // the tab is an interaction: claim it then. A same-size claim is a no-op
  // at the host (apply_session_grid skips an unchanged grid), so a
  // well-measured attach costs nothing. A host auto selected tab
  // (claimOnActivate false) resyncs unclaimed instead: claiming would
  // steal the grid from the client that is actually interacting.
  const finish = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const finishAttachment = () => {"),
    terminalPaneSource.indexOf("const replayPending = () => {")
  );
  assert.ok(finish.includes("settleLiveGrid();"),
    "a live grid that landed mid-drain must be settled before the post-replay resync");
  assert.ok(finish.includes("resizeRef.current(activeRef.current && claimOnActivateRef.current);"),
    "the post-replay resync must claim when this pane is a user-driven active tab");
});

test("a live grid broadcast that lands mid-replay is deferred, not stomped by the replay's last resize", () => {
  // The replay plan's segment resizes execute interleaved with live grid
  // broadcasts (xterm writes are async): when the host hands the grid back
  // to the returning desktop mid-replay, applying that broadcast in place
  // lets a plan resize that lands LATER stomp it, leaving the pane at the
  // last replayed segment's grid (the phone's 73x24) while the PTY is at
  // the desktop's. The broadcast is therefore recorded while the replay/
  // drain is in flight (merge.attached is false) and settled when the
  // replay/drain ends - once before the live drain writes (so the drained
  // chunks land at the grid the host produced them at) and once in
  // finishAttachment (for grids that land mid-drain).
  const offGrid = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const offGrid = "),
    terminalPaneSource.indexOf("const offMode = ")
  );
  assert.ok(offGrid.includes("lastLiveGrid = { cols, rows };"),
    "every live grid must be recorded so a mid-replay one cannot be lost");
  assert.ok(offGrid.includes("if (merge.attached) applyGridInPlace(cols, rows);"),
    "a live grid must only be applied in place after the drain; mid-replay it must wait");
  const planTail = terminalPaneSource.slice(
    terminalPaneSource.indexOf("if (op === undefined) {"),
    terminalPaneSource.indexOf("replayPending();")
  );
  assert.ok(planTail.includes("settleLiveGrid();"),
    "the recorded live grid must be settled before the pending drain writes its chunks");
});

test("the settle is a no-op when nothing was recorded, goes through the frame, and never touches a disposed terminal", () => {
  // Edge cases of the settle itself: (a) a fresh session's replay sees no
  // live grid, so a settle with nothing recorded must resize nothing -
  // the pane stays exactly where the plan left it; (b) the settle must go
  // through applyGridInPlace (ConsoleFrame alignment + zoom follow), never
  // a raw terminal.resize that would skip the scrollback protection;
  // (c) a pane that unmounted mid-replay must not have its disposed
  // terminal resized - the disposed guard must run before the settle.
  const settle = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const settleLiveGrid = () => {"),
    terminalPaneSource.indexOf("const offGrid = ")
  );
  assert.ok(settle.includes("if (lastLiveGrid !== null)"),
    "a settle with no recorded grid must be a no-op, not a stale resize");
  assert.ok(settle.includes("applyGridInPlace(lastLiveGrid.cols, lastLiveGrid.rows)"),
    "the settle must reuse the live-apply path so frame alignment and zoom follow");
  assert.ok(!settle.includes("terminal.resize"),
    "the settle must not bypass the ConsoleFrame with a raw resize");

  const planFn = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const runPlanOp = (index = 0) => {"),
    terminalPaneSource.indexOf("runPlanOp();")
  );
  assert.ok(planFn.indexOf("if (disposed) return;") < planFn.indexOf("settleLiveGrid();"),
    "the disposed guard must run before the settle, so an unmounted pane never resizes a disposed terminal");

  const finish = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const finishAttachment = () => {"),
    terminalPaneSource.indexOf("const replayPending = () => {")
  );
  assert.ok(finish.indexOf("settleLiveGrid();") < finish.indexOf("resizeRef.current(activeRef.current && claimOnActivateRef.current);"),
    "the buffer must settle at the host's grid before the post-replay resync announces it");
});

test("a cd that moves the active session away auto-selects its successor unclaimed", () => {
  // The window's project is UNCHANGED, but the tab it was showing left it:
  // a shell cd (typically from the phone) moved the session into another
  // project, and the host auto-selected a replacement. That activation is
  // host-driven, so the replacement pane must join set S UNCLAIMED -
  // claiming would steal the PTY grid from the client that ran the cd.
  // A tab the user closed is the user's own action: its successor still
  // claims as usual (only a LIVING departed session in another project
  // triggers the mark - a closed tab's `departed` lookup finds nothing).
  assert.ok(
    appSource.includes(
      "if (next !== null && next !== activeSessionId && departed && departed.projectId !== state.currentProjectId) {"
    ),
    "a live session that left the unchanged project must mark its auto-selected successor as host-driven (unclaimed)"
  );
  assert.ok(
    appSource.includes("autoActivated.add(next);"),
    "the marked successor's pane activates with claimOnActivate false"
  );
});

test("a window re-placed as a user placement clears its stale host auto-activation marks", () => {
  // A quiet window (created hidden for a session opened outside the
  // desktop) carries the host origin, and a user open of that project
  // surfaces the SAME window (core.rs `ensure_project_window_with_focus`
  // flips its origin host -> user and broadcasts). Without the clear, the
  // mark set at the window's host-origin boot survives the flip: the
  // auto-selected tab would stay claim-suppressed forever, and a
  // brand-new session's grid would sit at the PTY default - the terminal
  // looks frozen. The clear must run only when the origin itself
  // transitioned (a steady user-origin window keeps its cd-departure
  // marks), and only while the project is unchanged (a project change
  // re-marks from scratch in the host-origin branch).
  assert.ok(
    appSource.includes("const originChanged = previousProjectOriginRef.current !== state.currentProjectOrigin;"),
    "the window's origin transition must be tracked, not just its level"
  );
  assert.ok(
    appSource.includes("if (originChanged && state.currentProjectOrigin === \"user\") {\n        autoActivated.clear();\n      }"),
    "a host -> user origin flip on an unchanged project must drop the stale auto-activation marks"
  );
});

test("a pane that gains claimability after a suppressed mount re-claims the grid", () => {
  // The claim-suppressed mount (a quiet window's host origin, or a cd
  // successor) becomes claim-owed when the window is re-placed as a user
  // placement: the user's explicit open is an interaction, so the pane
  // must claim NOW. Without this, the shared grid stays at the PTY
  // default until a click or keystroke. The transition must be
  // edge-triggered (a steady claimOnActivate true must not re-announce),
  // and a pane still draining its replay must not double-claim -
  // finishAttachment claims the post-replay size itself.
  assert.ok(
    terminalPaneSource.includes("const gained = claimOnActivate && !previousClaimOnActivateRef.current;"),
    "the claim-ability gain must be edge-triggered off the previous prop value"
  );
  assert.ok(
    terminalPaneSource.includes("if (!gained || !activeRef.current || !visibleRef.current || replayingRef.current) return;"),
    "only an active, visible, settled pane re-claims; a mid-replay pane lets finishAttachment claim");
});

test("losing claimability while active never releases the pane's viewport", () => {
  // The claim-gain effect is the ONLY effect that reacts to
  // claimOnActivate transitions, and it acts only on a GAIN. A LOSS (a
  // fresh host mark on the active tab - e.g. another cd departs it) must
  // not release the viewport: the pane stays in set S as a successor
  // candidate, exactly as its unclaimed activation left it. Releasing on
  // loss would drop a pane the desktop is still showing, and the phone's
  // next resize would evict it.
  const effect = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const previousClaimOnActivateRef = useRef(claimOnActivate);"),
    terminalPaneSource.indexOf("}, [claimOnActivate]);")
  );
  assert.ok(effect.includes("resizeRef.current(true);"),
    "a claim-ability gain re-claims (announces the pane into set S with a claim)");
  assert.ok(!effect.includes("resizeRef.current(false)") && !effect.includes("releaseSessionViewport"),
    "a claim-ability loss must never unclaim or release the pane's viewport");
  assert.ok(
    effect.indexOf("previousClaimOnActivateRef.current = claimOnActivate;") <
    effect.indexOf("if (!gained || !activeRef.current || !visibleRef.current || replayingRef.current) return;"),
    "the previous-value update must run before the early return, so a LATER gain is still detected after a loss"
  );
});

test("a user click on an auto-activated tab makes it claim again", () => {
  // A tab the host auto-activated (a cd successor, or a quiet window's
  // auto-selected tab) activates unclaimed - but a real user click on
  // that tab is an explicit open of THIS terminal, so its mark must be
  // dropped and its next activation claims normally. Without the drop,
  // the tab would stay claim-suppressed until a click inside the pane or
  // a keystroke, and the terminal would look frozen after a tap.
  assert.ok(
    appSource.includes("autoActivatedSessionsRef.current.delete(session.id);"),
    "the tab's click handler must clear that tab's auto-activation mark"
  );
});

test("each pane receives the claim flag for its tab", () => {
  // The mark only has an effect if TerminalPane actually receives it: a
  // marked tab's pane must activate with claimOnActivate false (its
  // [active] effect, [visible] rAF and post-replay resync all gate on
  // it), and every unmarked pane's must be true.
  assert.ok(
    appSource.includes("claimOnActivate={!autoActivatedSessionsRef.current.has(session.id)}"),
    "each pane's claimOnActivate must be the negation of its tab's auto-activation mark"
  );
});

test("a host-placed change with no sessions marks nothing", () => {
  // An empty project (or one whose sessions all closed) has no
  // auto-selected successor: the host-origin branch must not add
  // `null` to the mark set - a null entry would make every pane's
  // `has(session.id)` lookup false and flip the whole set's meaning.
  assert.ok(
    appSource.includes("if (state.currentProjectOrigin === \"host\" && next !== null) autoActivated.add(next);"),
    "only a real (non-null) auto-selected successor gets the host mark"
  );
});

test("a closed tab's auto-selected successor claims, because only living sessions count as departed", () => {
  // The cd-departure mark fires only when the tab the window was showing
  // LEFT the project alive (a cd moved it elsewhere). When the tab
  // CLOSED, the user's own close picked the successor - a user action
  // that must claim. The distinction is the lookup: `departed` is
  // searched among LIVE sessions, so a closed tab is never found and
  // never marks its successor.
  assert.ok(
    appSource.includes("const departed = activeSessionId ? state.sessions.find((session) => session.id === activeSessionId) : undefined;"),
    "the departed tab must be looked up among live sessions, so a closed tab's successor is not marked"
  );
});

test("auto-activation marks for closed sessions are pruned while the project is unchanged", () => {
  // A mark survives only while its session is alive: the entries for
  // closed sessions are dropped on every unchanged-project pass, so a
  // stale entry can never suppress a later tab (or a project the user
  // navigates back to) until the next project switch clears the set.
  assert.ok(
    appSource.includes("if (!available.has(id)) autoActivated.delete(id);"),
    "entries for closed sessions must be pruned while the project is unchanged"
  );
});
