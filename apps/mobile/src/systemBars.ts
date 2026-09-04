import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import type { ResolvedTheme } from "./theme";

/**
 * Tell Android which way to draw the status and navigation bar content.
 *
 * The app draws edge to edge behind transparent system bars, so their icons
 * and clock sit directly on whichever palette the web layer is painting.
 * Android cannot work that out for itself: the HTML theme-color meta tag has
 * no effect there and the activity theme is fixed at build time, so the bar
 * content stayed light whatever the app was showing and disappeared against
 * the light theme's near-white background.
 *
 * Capacitor's own SystemBars plugin carries this across the bridge, so no
 * custom native plugin is needed - and the name is already taken by it, which
 * is why registering one would silently bind to its web stub instead.
 *
 * Note the inversion in Capacitor's vocabulary: its style names the *content*,
 * so a light app theme needs `Light` (dark content on a light background).
 *
 * A no-op off device, and on a native build too old to implement it: the bars
 * simply keep whatever appearance they had.
 */
export async function syncSystemBars(theme: ResolvedTheme): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await SystemBars.setStyle({ style: theme === "light" ? SystemBarsStyle.Light : SystemBarsStyle.Dark });
  } catch {
    // Unavailable on this platform or native build: leave the bars alone.
  }
}
