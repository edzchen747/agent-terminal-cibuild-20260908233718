import { TERMINAL_FONT_SIZE } from "./terminalSquish";

// The terminal renders glyphs to canvas with a font stack that must resolve on
// every device from app-provided fonts (fonts.css). The stack and the
// preloaded families stay in sync: the docs for fonts.load use exactly the
// quoted family strings below.
export const TERMINAL_FONT_FAMILY = '"Cascadia Mono", "Roboto Mono", monospace';

const TERMINAL_FONT_FAMILIES = ['"Cascadia Mono"', '"Roboto Mono"'];

// Fontsource ships per-script subset faces (latin, cyrillic, symbols2 for
// blocks/box drawing) that load lazily on first use. Text in a wide range so
// every face the terminal paints with is fetched here, at boot, instead of
// mid-session when xterm has already measured fallback glyphs.
const PRELOAD_TEXT = "AaWwOo01.,;:-_=+*()[]{}<>/^$\"!'@#&%▀▄█▌▐░▒▓│─┌┐└┘├┤┬┴┼═║↓↑ƒ€СТЯλΩ";

let terminalFontsReady: Promise<void> | null = null;

export function preloadTerminalFonts(): Promise<void> {
  terminalFontsReady ??= (async () => {
    try {
      await Promise.all(
        TERMINAL_FONT_FAMILIES.map((family) => document.fonts.load(`${TERMINAL_FONT_SIZE}px ${family}`, PRELOAD_TEXT))
      );
      await document.fonts.ready;
    } catch {
      // A font load failure degrades to the generic fallback; sessions still open.
    }
  })();
  return terminalFontsReady;
}
