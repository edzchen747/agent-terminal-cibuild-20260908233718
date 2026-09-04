/**
 * Terminal color schemes shared by every client.
 *
 * A terminal scheme is a complete unit: a background, a foreground, a cursor,
 * a selection, and the 16 ANSI colors that go with them. They cannot be mixed
 * and matched - most schemes render ANSI black as near-black, so dropping a
 * dark scheme's palette onto a light background makes every "black" glyph a
 * program prints invisible. Each entry below is therefore a whole scheme with
 * a declared mode, and the pickers only ever offer schemes of the mode they
 * apply to.
 *
 * The table lives in the protocol package because the desktop and the phone
 * must render the same session identically: both clients resolve a scheme id
 * through the helpers here rather than pinning colors of their own.
 */

export interface TerminalAnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * The Windows Terminal "Campbell" ANSI palette - the native Windows terminal
 * colors, and the default dark scheme's 16 colors. Exported on its own
 * because it is the historical shared palette every client pinned before
 * schemes existed.
 */
export const TERMINAL_ANSI_THEME = {
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  magenta: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightMagenta: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2"
} as const satisfies TerminalAnsiPalette;

const VINTAGE_ANSI: TerminalAnsiPalette = {
  black: "#000000",
  red: "#800000",
  green: "#008000",
  yellow: "#808000",
  blue: "#000080",
  magenta: "#800080",
  cyan: "#008080",
  white: "#C0C0C0",
  brightBlack: "#808080",
  brightRed: "#FF0000",
  brightGreen: "#00FF00",
  brightYellow: "#FFFF00",
  brightBlue: "#0000FF",
  brightMagenta: "#FF00FF",
  brightCyan: "#00FFFF",
  brightWhite: "#FFFFFF"
};

const ONE_HALF_DARK_ANSI: TerminalAnsiPalette = {
  black: "#282C34",
  red: "#E06C75",
  green: "#98C379",
  yellow: "#E5C07B",
  blue: "#61AFEF",
  magenta: "#C678DD",
  cyan: "#56B6C2",
  white: "#DCDFE4",
  brightBlack: "#5A6374",
  brightRed: "#EF8A93",
  brightGreen: "#B2D89A",
  brightYellow: "#F0D09B",
  brightBlue: "#8AC6F2",
  brightMagenta: "#D79BE6",
  brightCyan: "#7CCBD4",
  brightWhite: "#F2F4F7"
};

/** Solarized ships one palette; its dark and light schemes differ only in surface. */
const SOLARIZED_ANSI: TerminalAnsiPalette = {
  black: "#073642",
  red: "#DC322F",
  green: "#859900",
  yellow: "#B58900",
  blue: "#268BD2",
  magenta: "#D33682",
  cyan: "#2AA198",
  white: "#EEE8D5",
  brightBlack: "#586E75",
  brightRed: "#CB4B16",
  brightGreen: "#719E07",
  brightYellow: "#657B83",
  brightBlue: "#839496",
  brightMagenta: "#6C71C4",
  brightCyan: "#93A1A1",
  brightWhite: "#FDF6E3"
};

const ONE_HALF_LIGHT_ANSI: TerminalAnsiPalette = {
  black: "#383A42",
  red: "#E45649",
  green: "#50A14F",
  yellow: "#C18301",
  blue: "#0184BC",
  magenta: "#A626A4",
  cyan: "#0997B3",
  white: "#FAFAFA",
  brightBlack: "#4F525D",
  brightRed: "#C91B0D",
  brightGreen: "#3C8A3B",
  brightYellow: "#9A6700",
  brightBlue: "#016995",
  brightMagenta: "#851C83",
  brightCyan: "#07788F",
  brightWhite: "#FFFFFF"
};

const NOVEL_ANSI: TerminalAnsiPalette = {
  black: "#000000",
  red: "#CC0000",
  green: "#009600",
  yellow: "#D06B00",
  blue: "#0000CC",
  magenta: "#CC00CC",
  cyan: "#0087CC",
  white: "#5C5647",
  brightBlack: "#6B6558",
  brightRed: "#A30000",
  brightGreen: "#007000",
  brightYellow: "#A15000",
  brightBlue: "#0000A3",
  brightMagenta: "#A300A3",
  brightCyan: "#00648F",
  brightWhite: "#3B2322"
};

/** Whether a scheme is meant for a dark or a light app theme. */
export type TerminalSchemeMode = "dark" | "light";

export interface TerminalScheme {
  id: string;
  name: string;
  mode: TerminalSchemeMode;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  /**
   * Drawn behind the glyphs, so it is translucent wherever an opaque fill
   * would otherwise swallow the selected text.
   */
  selectionBackground: string;
  ansi: TerminalAnsiPalette;
}

export const TERMINAL_SCHEMES: readonly TerminalScheme[] = [
  {
    id: "campbell",
    name: "Campbell",
    mode: "dark",
    background: "#0C0C0C",
    foreground: "#CCCCCC",
    cursor: "#FFFFFF",
    cursorAccent: "#0C0C0C",
    selectionBackground: "#FFFFFF80",
    ansi: TERMINAL_ANSI_THEME
  },
  {
    id: "campbell-powershell",
    name: "Campbell PowerShell",
    mode: "dark",
    background: "#012456",
    foreground: "#CCCCCC",
    cursor: "#FFFFFF",
    cursorAccent: "#012456",
    selectionBackground: "#FFFFFF80",
    ansi: TERMINAL_ANSI_THEME
  },
  {
    id: "vintage",
    name: "Vintage",
    mode: "dark",
    background: "#000000",
    foreground: "#C0C0C0",
    cursor: "#C0C0C0",
    cursorAccent: "#000000",
    selectionBackground: "#FFFFFF80",
    ansi: VINTAGE_ANSI
  },
  {
    id: "one-half-dark",
    name: "One Half Dark",
    mode: "dark",
    background: "#282C34",
    foreground: "#DCDFE4",
    cursor: "#DCDFE4",
    cursorAccent: "#282C34",
    selectionBackground: "#7F87A0A0",
    ansi: ONE_HALF_DARK_ANSI
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    mode: "dark",
    background: "#002B36",
    foreground: "#93A1A1",
    cursor: "#93A1A1",
    cursorAccent: "#002B36",
    selectionBackground: "#4E7C8AA0",
    ansi: SOLARIZED_ANSI
  },
  {
    id: "one-half-light",
    name: "One Half Light",
    mode: "light",
    background: "#FAFAFA",
    foreground: "#383A42",
    cursor: "#383A42",
    cursorAccent: "#FAFAFA",
    selectionBackground: "#9CC1F0A0",
    ansi: ONE_HALF_LIGHT_ANSI
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    background: "#FDF6E3",
    foreground: "#073642",
    cursor: "#073642",
    cursorAccent: "#FDF6E3",
    selectionBackground: "#D3C9AEA0",
    ansi: SOLARIZED_ANSI
  },
  {
    id: "novel",
    name: "Novel",
    mode: "light",
    background: "#DFDBC3",
    foreground: "#3B2322",
    cursor: "#3B2322",
    cursorAccent: "#DFDBC3",
    selectionBackground: "#B0A98CA0",
    ansi: NOVEL_ANSI
  }
];

export const DEFAULT_DARK_TERMINAL_SCHEME_ID = "campbell";
export const DEFAULT_LIGHT_TERMINAL_SCHEME_ID = "one-half-light";

/** The scheme each app theme uses, chosen once and shared by every client. */
export interface TerminalThemeSettings {
  darkSchemeId: string;
  lightSchemeId: string;
}

export const DEFAULT_TERMINAL_THEME_SETTINGS: TerminalThemeSettings = {
  darkSchemeId: DEFAULT_DARK_TERMINAL_SCHEME_ID,
  lightSchemeId: DEFAULT_LIGHT_TERMINAL_SCHEME_ID
};

/** The schemes a picker may offer for one app theme. */
export function terminalSchemesFor(mode: TerminalSchemeMode): TerminalScheme[] {
  return TERMINAL_SCHEMES.filter((scheme) => scheme.mode === mode);
}

export function terminalSchemeById(id: string): TerminalScheme | undefined {
  return TERMINAL_SCHEMES.find((scheme) => scheme.id === id);
}

/**
 * The scheme to paint for a mode. An id that is unknown, or that belongs to
 * the other mode, falls back to that mode's default rather than painting a
 * dark palette on a light background (or the reverse): a stale stored value
 * or an older client must never produce an unreadable terminal.
 */
export function resolveTerminalScheme(id: string | undefined, mode: TerminalSchemeMode): TerminalScheme {
  const scheme = id ? terminalSchemeById(id) : undefined;
  if (scheme?.mode === mode) return scheme;
  const fallbackId = mode === "dark" ? DEFAULT_DARK_TERMINAL_SCHEME_ID : DEFAULT_LIGHT_TERMINAL_SCHEME_ID;
  return terminalSchemeById(fallbackId)!;
}

/**
 * Coerce any stored or received value into a settings pair whose ids exist
 * and match their mode. This is the single guard that keeps a dark scheme out
 * of the light slot no matter which client wrote the value.
 */
export function normalizeTerminalThemeSettings(value: Partial<TerminalThemeSettings> | null | undefined): TerminalThemeSettings {
  return {
    darkSchemeId: resolveTerminalScheme(value?.darkSchemeId, "dark").id,
    lightSchemeId: resolveTerminalScheme(value?.lightSchemeId, "light").id
  };
}

/** The scheme's colors in the shape xterm's theme option expects. */
export function xtermThemeFor(scheme: TerminalScheme) {
  return {
    background: scheme.background,
    foreground: scheme.foreground,
    cursor: scheme.cursor,
    cursorAccent: scheme.cursorAccent,
    selectionBackground: scheme.selectionBackground,
    ...scheme.ansi
  };
}
