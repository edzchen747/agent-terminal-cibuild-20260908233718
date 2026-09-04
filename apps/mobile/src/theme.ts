/** How the app chooses its color scheme. "system" follows the phone setting. */
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
 * App background per theme, mirroring --app-bg in styles.css. The theme-color
 * meta tag tracks it so the Android status and navigation bars match the
 * painted app instead of flashing the other theme.
 */
export const THEME_BACKGROUNDS: Record<ResolvedTheme, string> = {
  dark: "#090c11",
  light: "#f5f7fb"
};

/**
 * The theme is read synchronously on boot so the first paint is already in the
 * right palette, which rules out Capacitor Preferences (async). localStorage is
 * backed by the same WebView profile and survives app restarts.
 */
const STORAGE_KEY = "agent-terminal.mobile.theme.v1";
const DEFAULT_PREFERENCE: ThemePreference = "system";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** The scheme to paint for a preference, given the current phone setting. */
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
    // A blocked storage area should not make the theme misbehave; the choice
    // simply does not survive a restart.
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
