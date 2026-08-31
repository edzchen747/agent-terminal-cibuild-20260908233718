import assert from "node:assert/strict";
import test from "node:test";
import { backButtonAction } from "./navigationPolicy.ts";

const connected = (viewType) => ({
  status: "connected",
  viewType,
  showTerminalSettings: false,
  showSettings: false,
  hasRenameSheet: false,
  hasCloseSessionSheet: false,
  showCreateProject: false,
  pairFromHosts: false
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

// ---- The "pair a new desktop" path from the hosts page ----------------------

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

test("the first-time pairing screen (no hosts-page intent) ignores back", () => {
  const state = connected("home");
  state.status = "pairing";
  assert.equal(backButtonAction(state), "ignore");
});

test("a stale hosts-page flag never fires while connected", () => {
  // If the flag outlives the pairing screen, the connected flow must behave as
  // though it were not there: the flag is only honored on the pairing screen.
  const state = connected("home");
  state.pairFromHosts = true;
  assert.equal(backButtonAction(state), "exitApp");
  const terminal = connected("terminal");
  terminal.pairFromHosts = true;
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

// ---- Exhaustive sweep: every status/view/overlay combination ----------------

test("every combination of status, view, and overlay satisfies the back-key spec", () => {
  const statuses = ["loading", "pairing", "connecting", "connected", "error"];
  const views = ["home", "hosts", "project", "terminal"];
  // The spec, stated independently of the implementation:
  //  1. an open sheet always owns back, in priority order
  //     terminal settings > settings > rename > close-session > create-project;
  //  2. on the pairing screen reached from the hosts page, with no sheet,
  //     back restores the hosts page;
  //  3. the hosts page reached from the try-again screen (error status)
  //     returns there;
  //  4. every other non-connected state ignores back;
  //  5. connected: terminal -> project, project/hosts -> home, home -> exit.
  const spec = (state) => {
    if (state.showTerminalSettings) return "closeTerminalSettings";
    if (state.showSettings) return "closeSettings";
    if (state.hasRenameSheet) return "closeRenameSheet";
    if (state.hasCloseSessionSheet) return "closeSessionSheet";
    if (state.showCreateProject) return "closeCreateProject";
    if (state.status === "pairing" && state.pairFromHosts) return "backFromPairing";
    if (state.status !== "connected") {
      if (state.status === "error" && state.viewType === "hosts") return "navToHome";
      return "ignore";
    }
    if (state.viewType === "terminal") return "navToProject";
    if (state.viewType === "project" || state.viewType === "hosts") return "navToHome";
    return "exitApp";
  };
  const sheetOpen = (state) => state.showTerminalSettings || state.showSettings || state.hasRenameSheet || state.hasCloseSessionSheet || state.showCreateProject;
  for (const status of statuses) {
    for (const viewType of views) {
      for (let mask = 0; mask < 32; mask += 1) {
        for (const pairFromHosts of [false, true]) {
          const state = {
            status,
            viewType,
            showTerminalSettings: Boolean(mask & 1),
            showSettings: Boolean(mask & 2),
            hasRenameSheet: Boolean(mask & 4),
            hasCloseSessionSheet: Boolean(mask & 8),
            showCreateProject: Boolean(mask & 16),
            pairFromHosts
          };
          assert.equal(backButtonAction(state), spec(state));
          // exitApp is reachable only from the connected home view, no overlays.
          if (backButtonAction(state) === "exitApp") {
            assert.equal(status, "connected");
            assert.equal(viewType, "home");
            assert.equal(sheetOpen(state), false);
          }
          // backFromPairing is reachable only from the pairing screen reached
          // from the hosts page, with no overlays, in any retained view.
          if (backButtonAction(state) === "backFromPairing") {
            assert.equal(status, "pairing");
            assert.equal(pairFromHosts, true);
            assert.equal(sheetOpen(state), false);
          }
          // The flag must never leak into a connected or non-pairing state.
          if (pairFromHosts && (status !== "pairing" || sheetOpen(state))) {
            assert.notEqual(backButtonAction(state), "backFromPairing");
          }
        }
      }
    }
  }
});
