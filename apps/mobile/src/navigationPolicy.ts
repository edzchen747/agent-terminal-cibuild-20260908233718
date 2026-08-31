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
 * while it is open. The "pairing reached from the hosts page" branch must run
 * *before* the "not connected" guard - the user is on the pairing screen (not
 * connected) but back must restore the hosts page instead of doing nothing or
 * exiting the app.
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
    if (state.status === "error" && state.viewType === "hosts") return "navToHome";
    return "ignore";
  }
  if (state.viewType === "terminal") return "navToProject";
  if (state.viewType === "project" || state.viewType === "hosts") return "navToHome";
  return "exitApp";
}
