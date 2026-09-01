import assert from "node:assert/strict";
import test from "node:test";
import { backButtonAction, pairingReconnectStep, pairingRestoreDecision } from "./navigationPolicy.ts";

const connected = (viewType) => ({
  status: "connected",
  viewType,
  showTerminalSettings: false,
  showSettings: false,
  hasRenameSheet: false,
  hasCloseSessionSheet: false,
  showCreateProject: false,
  pairFromHosts: false,
  pairFromHome: false,
  hostsEmpty: false
});

// ---- Back navigation on a connected desktop --------------------------------

test("back from a terminal view returns to its project", () => {
  assert.equal(backButtonAction(connected("terminal")), "navToProject");
});

test("back from a project view returns home", () => {
  assert.equal(backButtonAction(connected("project")), "navToHome");
});

test("back on the home view exits the app", () => {
  assert.equal(backButtonAction(connected("home")), "exitApp");
});

test("back on the hosts page returns to the home view", () => {
  assert.equal(backButtonAction(connected("hosts")), "navToHome");
});

test("back on a hosts page with no paired desktops opens the pairing screen", () => {
  // With a loaded, empty list there is no useful back target: retrying with
  // no saved desktops would just reload the app into pairing, and the home
  // view is unreachable without a connection.
  const state = connected("hosts");
  state.hostsEmpty = true;
  assert.equal(backButtonAction(state), "pairFromHosts");
});

test("back on an empty hosts page reached from the try-again screen opens the pairing screen", () => {
  const state = connected("hosts");
  state.status = "error";
  state.hostsEmpty = true;
  assert.equal(backButtonAction(state), "pairFromHosts");
});

test("hostsEmpty only affects the hosts view", () => {
  const home = connected("home");
  home.hostsEmpty = true;
  assert.equal(backButtonAction(home), "exitApp");
  const withHosts = connected("hosts");
  withHosts.status = "error";
  assert.equal(backButtonAction(withHosts), "navToHome");
});

// ---- Sheet precedence --------------------------------------------------------

test("an open terminal-settings sheet closes before any view navigation", () => {
  const state = connected("terminal");
  state.showTerminalSettings = true;
  assert.equal(backButtonAction(state), "closeTerminalSettings");
});

test("an open settings sheet closes before view navigation", () => {
  const state = connected("project");
  state.showSettings = true;
  assert.equal(backButtonAction(state), "closeSettings");
});

test("the rename sheet closes before the close-session sheet", () => {
  const state = connected("project");
  state.hasRenameSheet = true;
  state.hasCloseSessionSheet = true;
  assert.equal(backButtonAction(state), "closeRenameSheet");
});

test("the close-session sheet closes when only it is open", () => {
  const state = connected("terminal");
  state.hasCloseSessionSheet = true;
  assert.equal(backButtonAction(state), "closeSessionSheet");
});

test("the create-project sheet is the lowest sheet priority but still wins over navigation", () => {
  const state = connected("home");
  state.showCreateProject = true;
  assert.equal(backButtonAction(state), "closeCreateProject");
});

test("terminal settings outrank settings, rename, close-session, and create-project", () => {
  const state = connected("home");
  state.showTerminalSettings = true;
  state.showSettings = true;
  state.hasRenameSheet = true;
  state.hasCloseSessionSheet = true;
  state.showCreateProject = true;
  assert.equal(backButtonAction(state), "closeTerminalSettings");
});

test("sheets close even while disconnected", () => {
  // Sheets can only be open while connected, but the policy must not depend on
  // that: a sheet always owns the back control, whatever the status says.
  const state = connected("home");
  state.status = "error";
  state.showSettings = true;
  assert.equal(backButtonAction(state), "closeSettings");
});

// ---- The "pair a new desktop" path from the hosts page and bottom nav ------

test("back on the pairing screen reached from the hosts page restores the hosts page", () => {
  const state = connected("home");
  state.status = "pairing";
  state.pairFromHosts = true;
  assert.equal(backButtonAction(state), "backFromPairing");
});

test("the hosts pairing path runs before the not-connected guard", () => {
  // status is "pairing", i.e. not connected: without the earlier branch this
  // would fall through to "ignore" and the user would be stranded on the
  // pairing screen.
  const state = connected("home");
  state.status = "pairing";
  state.pairFromHosts = true;
  assert.notEqual(backButtonAction(state), "ignore");
  assert.notEqual(backButtonAction(state), "exitApp");
});

test("a sheet still owns back while pairing from the hosts page", () => {
  const state = connected("home");
  state.status = "pairing";
  state.pairFromHosts = true;
  state.showCreateProject = true;
  assert.equal(backButtonAction(state), "closeCreateProject");
});

test("back on the pairing screen reached from the home bottom nav restores the home view", () => {
  const state = connected("home");
  state.status = "pairing";
  state.pairFromHome = true;
  assert.equal(backButtonAction(state), "backFromPairing");
});

test("a sheet still owns back while pairing from the home bottom nav", () => {
  const state = connected("home");
  state.status = "pairing";
  state.pairFromHome = true;
  state.showCreateProject = true;
  assert.equal(backButtonAction(state), "closeCreateProject");
});

test("the first-time pairing screen (no hosts-page or bottom-nav intent) ignores back", () => {
  const state = connected("home");
  state.status = "pairing";
  assert.equal(backButtonAction(state), "ignore");
});

test("a stale hosts-page or bottom-nav flag never fires while connected", () => {
  // If a flag outlives the pairing screen, the connected flow must behave as
  // though it were not there: the flags are only honored on the pairing
  // screen.
  const state = connected("home");
  state.pairFromHosts = true;
  state.pairFromHome = true;
  assert.equal(backButtonAction(state), "exitApp");
  const terminal = connected("terminal");
  terminal.pairFromHosts = true;
  terminal.pairFromHome = true;
  assert.equal(backButtonAction(terminal), "navToProject");
});

// ---- Non-connected, non-sheet states ----------------------------------------

test("back on the hosts page reached from the try-again screen goes back to it", () => {
  // The view resets but the error status does not, so the try-again screen is
  // what the user lands on.
  const state = connected("hosts");
  state.status = "error";
  assert.equal(backButtonAction(state), "navToHome");
});

test("back does nothing while the app is opening, connecting, or on the try-again page", () => {
  for (const status of ["loading", "connecting", "error", "pairing"]) {
    const state = connected("home");
    state.status = status;
    assert.equal(backButtonAction(state), "ignore", status);
  }
});

// ---- Back from the pairing screen: restoring the originating state --------

test("back over a failed connection restores the try-again screen even if the desktop recovered", () => {
  // The captured error wins over a live connection that reconnected while the
  // pairing screen was open: the user left the try-again screen, so back
  // lands back on it.
  const decision = pairingRestoreDecision({ prePairStatus: "error", liveConnectionOpen: true, liveHasSnapshot: true });
  assert.equal(decision, "restoreError");
});

test("back with a live socket and a snapshot returns to the home view", () => {
  const decision = pairingRestoreDecision({ prePairStatus: "connected", liveConnectionOpen: true, liveHasSnapshot: true });
  assert.equal(decision, "connected");
});

test("a closed socket with a stale snapshot reconnects instead of trusting the snapshot", () => {
  // A snapshot without an open socket belongs to the dead attempt; showing
  // "connected" would point at a connection that no longer exists.
  const decision = pairingRestoreDecision({ prePairStatus: "connected", liveConnectionOpen: false, liveHasSnapshot: true });
  assert.equal(decision, "reconnect");
});

test("an open socket that has not delivered its snapshot yet reconnects", () => {
  // Mid-handshake: the home view would render without a snapshot (App
  // returns null), so the safe landing is a fresh connection attempt.
  const decision = pairingRestoreDecision({ prePairStatus: "connected", liveConnectionOpen: true, liveHasSnapshot: false });
  assert.equal(decision, "reconnect");
});

test("no live connection at all reconnects", () => {
  const decision = pairingRestoreDecision({ prePairStatus: "connected", liveConnectionOpen: false, liveHasSnapshot: false });
  assert.equal(decision, "reconnect");
});

test("the full prePairStatus x socket x snapshot matrix is decided by the spec", () => {
  const spec = (input) => {
    if (input.prePairStatus === "error") return "restoreError";
    return input.liveConnectionOpen && input.liveHasSnapshot ? "connected" : "reconnect";
  };
  for (const prePairStatus of ["connected", "error"]) {
    for (const liveConnectionOpen of [false, true]) {
      for (const liveHasSnapshot of [false, true]) {
        const input = { prePairStatus, liveConnectionOpen, liveHasSnapshot };
        assert.equal(pairingRestoreDecision(input), spec(input), JSON.stringify(input));
      }
    }
  }
});

test("the reconnect step starts the saved host when a record exists", () => {
  assert.equal(pairingReconnectStep(true), "startHostConnection");
});

test("the reconnect step stays on the pairing screen when no host is saved", () => {
  // A phone with no saved desktop yet (pairing never succeeded) has nothing
  // to retry: back must not strand the user on a try-again screen.
  assert.equal(pairingReconnectStep(false), "stayOnPairing");
});

// ---- Exhaustive sweep: every status/view/overlay combination ----------------

test("every combination of status, view, and overlay satisfies the back-key spec", () => {
  const statuses = ["loading", "pairing", "connecting", "connected", "error"];
  const views = ["home", "hosts", "project", "terminal"];
  // The spec, stated independently of the implementation:
  //  1. an open sheet always owns back, in priority order
  //     terminal settings > settings > rename > close-session > create-project;
  //  2. on the pairing screen reached from the hosts page or the home
  //     bottom nav, with no sheet, back restores the originating page;
  //  3. the hosts page reached from the try-again screen (error status)
  //     returns there; with a loaded, empty list back opens the pairing
  //     screen instead (in both the error and connected cases);
  //  4. every other non-connected state ignores back;
  //  5. connected: terminal -> project, project/hosts -> home, home -> exit.
  const spec = (state) => {
    if (state.showTerminalSettings) return "closeTerminalSettings";
    if (state.showSettings) return "closeSettings";
    if (state.hasRenameSheet) return "closeRenameSheet";
    if (state.hasCloseSessionSheet) return "closeSessionSheet";
    if (state.showCreateProject) return "closeCreateProject";
    if (state.status === "pairing" && (state.pairFromHosts || state.pairFromHome)) return "backFromPairing";
    if (state.status !== "connected") {
      if (state.status === "error" && state.viewType === "hosts") return state.hostsEmpty ? "pairFromHosts" : "navToHome";
      return "ignore";
    }
    if (state.viewType === "terminal") return "navToProject";
    if (state.viewType === "hosts") return state.hostsEmpty ? "pairFromHosts" : "navToHome";
    if (state.viewType === "project") return "navToHome";
    return "exitApp";
  };
  const sheetOpen = (state) => state.showTerminalSettings || state.showSettings || state.hasRenameSheet || state.hasCloseSessionSheet || state.showCreateProject;
  for (const status of statuses) {
    for (const viewType of views) {
      for (let mask = 0; mask < 32; mask += 1) {
        for (const pairFromHosts of [false, true]) {
          for (const pairFromHome of [false, true]) {
            for (const hostsEmpty of [false, true]) {
              const state = {
                status,
                viewType,
                showTerminalSettings: Boolean(mask & 1),
                showSettings: Boolean(mask & 2),
                hasRenameSheet: Boolean(mask & 4),
                hasCloseSessionSheet: Boolean(mask & 8),
                showCreateProject: Boolean(mask & 16),
                pairFromHosts,
                pairFromHome,
                hostsEmpty
              };
              assert.equal(backButtonAction(state), spec(state), JSON.stringify(state));
              // exitApp is reachable only from the connected home view, no overlays.
              if (backButtonAction(state) === "exitApp") {
                assert.equal(status, "connected");
                assert.equal(viewType, "home");
                assert.equal(sheetOpen(state), false);
              }
              // backFromPairing is reachable only from the pairing screen
              // reached from the hosts page or the home bottom nav, with no
              // overlays, in any retained view.
              if (backButtonAction(state) === "backFromPairing") {
                assert.equal(status, "pairing");
                assert.ok(pairFromHosts || pairFromHome);
                assert.equal(sheetOpen(state), false);
              }
              // pairFromHosts is reachable only on a hosts view with a
              // loaded, empty list and no overlays, in the statuses where the
              // hosts view is reachable (connected, or the try-again error).
              if (backButtonAction(state) === "pairFromHosts") {
                assert.equal(viewType, "hosts");
                assert.equal(hostsEmpty, true);
                assert.equal(sheetOpen(state), false);
                assert.ok(status === "connected" || status === "error");
              }
              // The flags must never leak into a connected or non-pairing state.
              if ((pairFromHosts || pairFromHome) && (status !== "pairing" || sheetOpen(state))) {
                assert.notEqual(backButtonAction(state), "backFromPairing");
              }
            }
          }
        }
      }
    }
  }
});
