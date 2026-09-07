export interface SidebarPreferences {
  /** Collapse the project sidebar when the user clicks elsewhere or opens a project. */
  autoCollapse: boolean;
}

/**
 * Window width (CSS px) at or below which the project sidebar becomes an
 * overlay drawer instead of taking flex space. Must stay in sync with the
 * 900px media query in styles.css.
 */
export const NARROW_SIDEBAR_WIDTH = 900;

/** Whether a given window width is in the narrow overlay-drawer layout. */
export function isNarrowLayout(width: number): boolean {
  return width <= NARROW_SIDEBAR_WIDTH;
}

/**
 * The narrow layout implicitly enables auto-collapse so the terminal keeps
 * the full width, regardless of the saved preference.
 */
export function effectiveAutoCollapse(setting: boolean, narrow: boolean): boolean {
  return setting || narrow;
}

/**
 * Entering the narrow layout implicitly enables auto-collapse, so an
 * already-open sidebar collapses and the terminal gets the space back. Widen
 * the window and the sidebar stays in whatever state it was in.
 */
export function sidebarOpenAfterNarrowLayout(open: boolean, narrow: boolean): boolean {
  return narrow ? false : open;
}

/**
 * Turning auto-collapse back off reopens the sidebar so the user can see
 * that it is visible again. Turning it on leaves the sidebar as-is.
 */
export function sidebarOpenAfterAutoCollapseToggle(open: boolean, autoCollapse: boolean): boolean {
  return autoCollapse ? open : true;
}

/**
 * The user started typing into the terminal - the same "I am working in the
 * terminal now" signal the auto-collapse click behavior reacts to: collapse
 * an open sidebar so the terminal gets the space back. Auto collapse off
 * leaves the sidebar in whatever state it was in.
 */
export function sidebarOpenAfterTerminalInput(open: boolean, autoCollapse: boolean): boolean {
  return autoCollapse ? false : open;
}

const STORAGE_KEY = "agent-terminal.desktop.sidebar.v1";
const DEFAULT_PREFERENCES: SidebarPreferences = { autoCollapse: true };

export function loadSidebarPreferences(): SidebarPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PREFERENCES;
    const value = JSON.parse(stored) as Partial<SidebarPreferences>;
    return { autoCollapse: value.autoCollapse !== false };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveSidebarPreferences(preferences: SidebarPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A read-only or full storage area should not make the sidebar misbehave.
  }
}

/**
 * Whether a click should collapse the sidebar. Only active while the sidebar
 * is open and auto-collapse is enabled: clicks outside the sidebar, or on a
 * project within it, collapse it, while interactions inside the sidebar (the
 * add-project controls, drag handles, and rename buttons) leave it open.
 * Clicks on the sidebar toggle itself are the user's explicit control of the
 * state, so the auto-collapse never fights them.
 * The rename-project overlay is presented as part of the project sidebar
 * flow, so clicks anywhere on it (its form or backdrop) never collapse the
 * sidebar either.
 */
export function shouldCollapseSidebar(open: boolean, autoCollapse: boolean, inside: boolean, isProject: boolean, isToggle = false, inProjectOverlay = false): boolean {
  if (isToggle || inProjectOverlay) return false;
  if (!open || !autoCollapse) return false;
  return !inside || isProject;
}
