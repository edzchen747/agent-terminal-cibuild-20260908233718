export interface SidebarPreferences {
  /** Collapse the project sidebar when the user clicks elsewhere or opens a project. */
  autoCollapse: boolean;
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
 */
export function shouldCollapseSidebar(open: boolean, autoCollapse: boolean, inside: boolean, isProject: boolean, isToggle = false): boolean {
  if (isToggle) return false;
  if (!open || !autoCollapse) return false;
  return !inside || isProject;
}
