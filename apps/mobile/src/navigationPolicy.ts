/**
 * Pure routing rules for the Android back key and gesture. App.tsx snapshots
 * its navigation state and hands it to `backButtonAction`, which decides what
 * the back control should do. Everything here is side-effect free so the
 * priority order and the hosts-page paths are unit tested in Node; the
 * listener in App.tsx only executes the returned action.
 */

export type AppStatus = "loading" | "pairing" | "connecting" | "connected" | "error";
export type ViewType = "home" | "hosts" | "project" | "terminal";

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
  /** The user reached the pairing screen from the home view's bottom nav. */
  pairFromHome: boolean;
}

export type BackAction =
  | "closeTerminalSettings"
  | "closeSettings"
  | "closeRenameSheet"
  | "closeSessionSheet"
  | "closeCreateProject"
  | "backFromPairing"
  | "navToProject"
  | "navToHome"
  | "exitApp"
  | "ignore";

/**
 * Sheets close before anything else: an overlay always owns the back control
 * while it is open. The "pairing reached from the hosts page or the home
 * bottom nav" branch must run *before* the "not connected" guard - the user
 * is on the pairing screen (not connected) but back must restore the page the
 * pairing screen was opened from instead of doing nothing or exiting the app.
 */
export function backButtonAction(state: BackNavigationState): BackAction {
  if (state.showTerminalSettings) return "closeTerminalSettings";
  if (state.showSettings) return "closeSettings";
  if (state.hasRenameSheet) return "closeRenameSheet";
  if (state.hasCloseSessionSheet) return "closeSessionSheet";
  if (state.showCreateProject) return "closeCreateProject";
  if (state.status === "pairing" && (state.pairFromHosts || state.pairFromHome)) return "backFromPairing";
  if (state.status !== "connected") {
    // The hosts page is also reachable from the try-again screen; back leaves
    // it, the view resets, and the unchanged error status re-lands the user
    // on the try-again screen.
    if (state.status === "error" && state.viewType === "hosts") return "navToHome";
    return "ignore";
  }
  if (state.viewType === "terminal") return "navToProject";
  if (state.viewType === "project" || state.viewType === "hosts") return "navToHome";
  return "exitApp";
}

// ---- Back from the pairing screen: restoring the originating state --------

export interface PairingRestoreInput {
  /** Status captured when the pairing screen was opened. "error" means the
   * hosts page was reached from the try-again screen; the bottom-nav path
   * always captures "connected". */
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
