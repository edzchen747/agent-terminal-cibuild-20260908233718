import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isThemePreference, loadThemePreference, resolveTheme, saveThemePreference, THEME_BACKGROUNDS, THEME_LABELS, THEME_PREFERENCES } from "./theme.ts";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/** The blue of the app icon (apps/desktop/src-tauri/icons), the brand accent. */
const ICON_BLUE = "#5db8fd";

test("the settings control offers system, light and dark", () => {
  assert.deepEqual([...THEME_PREFERENCES], ["system", "light", "dark"]);
  for (const preference of THEME_PREFERENCES) assert.ok(THEME_LABELS[preference], `${preference} needs a label`);
});

test("only the three preferences are accepted", () => {
  for (const preference of THEME_PREFERENCES) assert.ok(isThemePreference(preference));
  for (const value of ["", "System", "auto", null, undefined, 0]) assert.ok(!isThemePreference(value));
});

test("system follows the OS setting and an explicit choice overrides it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("an unreadable storage area falls back to following the system", () => {
  // No window in the test runner, so the storage read throws.
  assert.equal(loadThemePreference(), "system");
});

test("the meta theme colors match the --app-bg of each palette", () => {
  assert.match(styles, new RegExp(`--app-bg:\\s*${THEME_BACKGROUNDS.dark}`, "i"));
  assert.match(styles, new RegExp(`--app-bg:\\s*${THEME_BACKGROUNDS.light}`, "i"));
});

test("the accent is the blue from the app icon", () => {
  assert.match(styles, new RegExp(`--accent:\\s*${ICON_BLUE}`, "i"));
  // Drift guard: the previous teal accent must not come back anywhere.
  for (const hex of ["#78d9c4", "#8ce8d2", "#66bdb7", "#65cdb8", "#79dbc6", "#8ee1cf"]) {
    assert.ok(!styles.toLowerCase().includes(hex), `${hex} is the old teal accent and must not reappear`);
  }
});

test("styles.css defines a light palette selected by data-theme", () => {
  assert.match(styles, /:root\[data-theme="light"\]/);
  assert.match(styles, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
});

test("the app theme never repaints the terminal surface", () => {
  // The terminal's color comes from the shared scheme the host holds, applied
  // at runtime; styles.css only carries the pre-mount fallback and must not
  // give the light palette a --terminal-bg of its own.
  assert.match(styles, /--terminal-bg:\s*#0C0C0C/i);
  assert.ok(!/:root\[data-theme="light"\][^}]*--terminal-bg/i.test(styles), "the light palette must not override --terminal-bg");
});

/**
 * The storage paths only run with a window present, so these install a
 * localStorage stand-in for the duration of each test. Node has none, which
 * is why the fallback test above exercises the throwing path instead.
 */
function withStorage(store: Record<string, string>, run: () => void): void {
  const original = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => (key in store ? store[key]! : null),
      setItem: (key: string, value: string) => { store[key] = String(value); },
      removeItem: (key: string) => { delete store[key]; }
    }
  } as unknown as Window & typeof globalThis;
  try {
    return run();
  } finally {
    globalThis.window = original;
  }
}

test("a saved preference round-trips", () => {
  for (const preference of THEME_PREFERENCES) {
    const store: Record<string, string> = {};
    withStorage(store, () => {
      saveThemePreference(preference);
      assert.equal(loadThemePreference(), preference);
    });
    // Exactly one key, so the preference cannot collide with other settings.
    assert.deepEqual(Object.values(store), [preference]);
  }
});

test("a stored value that is not a preference falls back to following the system", () => {
  // A hand-edited store, or one written by a build that knew other values,
  // must not leave the app painting nothing.
  for (const junk of ["", "purple", "SYSTEM", "Dark", "null", "{}", "[]", " dark "]) {
    const store: Record<string, string> = {};
    withStorage(store, () => {
      saveThemePreference("dark");
      const key = Object.keys(store)[0]!;
      store[key] = junk;
      assert.equal(loadThemePreference(), "system", `${JSON.stringify(junk)} must not be trusted`);
    });
  }
});

test("a storage area that throws does not break the caller", () => {
  // Private mode, a full quota, or blocked site data: the choice is lost, the
  // session is not.
  const original = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    }
  } as unknown as Window & typeof globalThis;
  try {
    assert.doesNotThrow(() => saveThemePreference("dark"));
    assert.equal(loadThemePreference(), "system");
  } finally {
    globalThis.window = original;
  }
});

test("every preference resolves to a theme the stylesheet actually defines", () => {
  // resolveTheme may only produce a scheme styles.css has a palette for; a new
  // preference without one would render an unstyled app.
  for (const preference of THEME_PREFERENCES) {
    for (const systemPrefersDark of [true, false]) {
      const resolved = resolveTheme(preference, systemPrefersDark);
      assert.ok(resolved === "dark" || resolved === "light", `${preference} resolved to ${resolved}`);
      assert.match(THEME_BACKGROUNDS[resolved], /^#[0-9a-f]{6}$/i);
      assert.match(styles, new RegExp(`--app-bg:\\s*${THEME_BACKGROUNDS[resolved]}`, "i"));
    }
  }
});

const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

/** The markup of one terminal-colour row, from its heading to its closing select. */
function pickerRow(heading: string): string {
  const start = appSource.indexOf(`Terminal colors · ${heading}`);
  assert.notEqual(start, -1, `the ${heading} terminal colour picker is missing`);
  const end = appSource.indexOf("</select>", start);
  assert.notEqual(end, -1, `the ${heading} picker has no select`);
  return appSource.slice(start, end);
}

test("each terminal colour picker offers only schemes of its own mode", () => {
  // The core promise of the mode split: a dark palette on a light background
  // hides every glyph a program prints in ANSI black. A copy-paste swap here
  // would look fine until someone actually switched theme.
  const dark = pickerRow("Dark");
  assert.match(dark, /terminalSchemesFor\("dark"\)/);
  assert.ok(!dark.includes('terminalSchemesFor("light")'), "the dark picker must not list light schemes");
  assert.match(dark, /value=\{terminalTheme\.darkSchemeId\}/);

  const light = pickerRow("Light");
  assert.match(light, /terminalSchemesFor\("light"\)/);
  assert.ok(!light.includes('terminalSchemesFor("dark")'), "the light picker must not list dark schemes");
  assert.match(light, /value=\{terminalTheme\.lightSchemeId\}/);
});

test("changing one terminal colour slot preserves the other", () => {
  // Both ids travel together in one message, so a picker that dropped the
  // other half would silently reset it to the default.
  assert.match(pickerRow("Dark"), /terminalTheme\.lightSchemeId/);
  assert.match(pickerRow("Light"), /terminalTheme\.darkSchemeId/);
});

test("the active-now dot marks the slot matching the resolved theme", () => {
  assert.match(pickerRow("Dark"), /resolvedTheme === "dark" && <i className="active-dot"/);
  assert.match(pickerRow("Light"), /resolvedTheme === "light" && <i className="active-dot"/);
  // A dot with no palette entry would be invisible.
  assert.match(styles, /\.active-dot \{[^}]*background: var\(--ok\)/);
});

test("the scheme pair is always read through the normalizer", () => {
  // Reaching into snapshot/state.terminalTheme directly threw on every render
  // against a host too old to send it, which blanked the whole app.
  assert.match(appSource, /normalizeTerminalThemeSettings\(/);
  assert.ok(!/(?:snapshot|state)\?\.terminalTheme\./.test(appSource), "read the pair through normalizeTerminalThemeSettings");
  assert.ok(!/(?:snapshot|state)\.terminalTheme\.[a-z]/i.test(appSource), "read the pair through normalizeTerminalThemeSettings");
});
