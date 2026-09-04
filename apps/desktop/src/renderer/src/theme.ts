/** How the app chooses its color scheme. "system" follows the OS setting. */
export type ThemePreference = "light" | "dark" | "system";

/** The scheme actually painted once a preference is resolved. */
export type ResolvedTheme = "light" | "dark";

/** Selectable preferences, in the order the settings control lists them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark"
};

/** Media query the "system" preference follows. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Window background per theme, mirroring --app-bg in styles.css. The titlebar
 * meta color is kept in sync with it so the window chrome does not flash the
 * other theme's background while the app boots.
 */
export const THEME_BACKGROUNDS: Record<ResolvedTheme, string> = {
  dark: "#090b10",
  light: "#f5f7fb"
};

const STORAGE_KEY = "agent-terminal.desktop.theme.v1";
const DEFAULT_PREFERENCE: ThemePreference = "system";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** The scheme to paint for a preference, given the current OS setting. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function loadThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // A read-only or full storage area should not make the theme misbehave;
    // the choice simply does not survive a restart.
  }
}

/**
 * Paint a resolved theme. The palette is selected by the data-theme attribute
 * (styles.css defines the light overrides under it), so both the CSS variables
 * and the native form-control rendering switch in one step.
 */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BACKGROUNDS[theme]);
}

/** The theme to paint on boot, before React mounts, so there is no flash. */
export function applyStoredTheme(): ResolvedTheme {
  const theme = resolveTheme(loadThemePreference(), window.matchMedia(SYSTEM_DARK_QUERY).matches);
  applyTheme(theme);
  return theme;
}
