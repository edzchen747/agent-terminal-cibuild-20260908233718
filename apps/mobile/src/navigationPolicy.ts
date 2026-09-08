/**
 * Pure routing rules for the Android back key and gesture. App.tsx snapshots
 * its navigation state and hands it to `backButtonAction`, which decides what
 * the back control should do. Everything here is side-effect free so the
 * priority order and the hosts-page paths are unit tested in Node; the
 * listener in App.tsx only executes the returned action.
 */

export type AppStatus = "loading" | "pairing" | "connecting" | "connected" | "error";
export type ViewType = "home" | "hosts" | "ports" | "project" | "terminal";

export interface BackNavigationState {
  status: AppStatus;
  viewType: ViewType;
  showTerminalSettings: boolean;
  showSettings: boolean;
  /** A rename-project bottom sheet is open. */
  hasRenameSheet: boolean;
  /** A close-session bottom sheet is open. */
  hasCloseSessionSheet: boolean;
  showCreateProject: boolean;
  /** The user reached the pairing screen from the hosts page. */
  pairFromHosts: boolean;
  /** The hosts page finished loading and has no paired desktops. */
  hostsEmpty: boolean;
}

export type BackAction =
  | "closeTerminalSettings"
  | "closeSettings"
  | "closeRenameSheet"
  | "closeSessionSheet"
  | "closeCreateProject"
  | "backFromPairing"
  | "pairFromHosts"
  | "navToProject"
  | "navToHome"
  | "exitApp"
  | "ignore";

/**
 * Sheets close before anything else: an overlay always owns the back control
 * while it is open. The "pairing reached from the hosts page" branch must run
 * *before* the "not connected" guard - the user is on the pairing screen (not
 * connected) but back must restore the page it was opened from instead of
 * doing nothing or exiting the app.
 */
export function backButtonAction(state: BackNavigationState): BackAction {
  if (state.showTerminalSettings) return "closeTerminalSettings";
  if (state.showSettings) return "closeSettings";
  if (state.hasRenameSheet) return "closeRenameSheet";
  if (state.hasCloseSessionSheet) return "closeSessionSheet";
  if (state.showCreateProject) return "closeCreateProject";
  if (state.status === "pairing" && state.pairFromHosts) return "backFromPairing";
  if (state.status !== "connected") {
    // The hosts page is also reachable from the try-again screen; back leaves
    // it, the view resets, and the unchanged error status re-lands the user
    // on the try-again screen.
    if (state.status === "error" && state.viewType === "hosts") return hostsPageBackAction(state);
    return "ignore";
  }
  if (state.viewType === "terminal") return "navToProject";
  if (state.viewType === "hosts") return hostsPageBackAction(state);
  // The ports page is opened from the home bottom nav, so back always has the
  // home view to return to.
  if (state.viewType === "ports") return "navToHome";
  if (state.viewType === "project") return "navToHome";
  return "exitApp";
}

/**
 * Back on the hosts page: with a loaded, empty list there is no useful back
 * target - the try-again screen's "Try again" would just reload the app into
 * pairing with no saved desktop, and the home view is unreachable without a
 * connection - so the pairing screen opens instead. With any desktops
 * listed, back leaves the page for the home view / try-again screen.
 */
function hostsPageBackAction(state: BackNavigationState): BackAction {
  return state.hostsEmpty ? "pairFromHosts" : "navToHome";
}

/**
 * Whether the pairing screen shows its back control (the header button and
 * the back-swipe gesture). The screen is reached from the hosts page, and
 * back restores it - unless the hosts list is loaded and empty: there, back
 * would just open the pairing screen again (a loop), so the screen behaves
 * like a first launch and hides its back control.
 *
 * The Android back key is deliberately decoupled from this: it still acts
 * (backFromPairing) in every pairing state, because it is the only exit a
 * first-launch-style screen offers.
 */
export interface PairBackControlInput {
  /** The user reached the pairing screen from the hosts page. */
  pairFromHosts: boolean;
  /** The hosts page finished loading and has no paired desktops. */
  hostsEmpty: boolean;
}

export function pairScreenShowsBack(input: PairBackControlInput): boolean {
  return input.pairFromHosts && !input.hostsEmpty;
}

// ---- Back from the pairing screen: restoring the originating state --------

export interface PairingRestoreInput {
  /** Status captured when the pairing screen was opened. "error" means the
   * hosts page was reached from the try-again screen. */
  prePairStatus: "connected" | "error";
  /** The live connection's socket is open right now. */
  liveConnectionOpen: boolean;
  /** The live connection has received a desktop snapshot. */
  liveHasSnapshot: boolean;
}

export type PairingRestoreDecision = "restoreError" | "connected" | "reconnect";

/**
 * What back from the pairing screen should do, from the connection's current
 * reality (its events were held back while the pairing screen was open, so
 * the captured status alone cannot be trusted):
 *  - the pairing screen was opened over a failed connection ("error") →
 *    restore the try-again screen, even if the desktop recovered meanwhile;
 *  - a live socket is open *and* has a snapshot → back to the home view;
 *  - anything else (closed socket, still mid-handshake, stale snapshot)
 *    → reconnect through the saved-host lookup below.
 */
export function pairingRestoreDecision(input: PairingRestoreInput): PairingRestoreDecision {
  if (input.prePairStatus === "error") return "restoreError";
  if (input.liveConnectionOpen && input.liveHasSnapshot) return "connected";
  return "reconnect";
}

/**
 * The final step of the "reconnect" branch, once the saved-desktop lookup
 * resolves: a record exists → reconnect to it; no record (a phone that has
 * no saved desktop yet) → stay on the pairing screen so the user can scan
 * again, instead of stranding them on a try-again screen with nothing to
 * retry.
 */
export function pairingReconnectStep(hasSavedHost: boolean): "startHostConnection" | "stayOnPairing" {
  return hasSavedHost ? "startHostConnection" : "stayOnPairing";
}
