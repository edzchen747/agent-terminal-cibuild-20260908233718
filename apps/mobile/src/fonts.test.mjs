import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// Families the app may fall back to without bundling. Any other family must
// be provided by the app, otherwise rendering drifts between devices.
const GENERIC_FAMILIES = new Set([
  "monospace", "sans-serif", "serif", "system-ui",
  "ui-monospace", "ui-sans-serif", "ui-serif", "ui-rounded",
  "cursive", "fantasy", "math", "emoji", "fangsong"
]);

function findNodeModules(specifier) {
  let dir = SRC_DIR;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "node_modules", specifier);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function fontFaceBlocks(css) {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
}

function providedFamilies() {
  const fontsCss = readFileSync(join(SRC_DIR, "fonts.css"), "utf8");
  const imports = [...fontsCss.matchAll(/@import\s+(['"])([^'"]+)\1\s*;/g)].map((match) => match[2]);
  assert.ok(imports.length >= 1, "fonts.css must import every provided font");
  const families = new Set();
  const fontFiles = [];
  for (const specifier of imports) {
    const cssPath = findNodeModules(specifier);
    assert.ok(cssPath, `font css @import "${specifier}" does not resolve to node_modules`);
    const css = readFileSync(cssPath, "utf8");
    const blocks = fontFaceBlocks(css);
    assert.ok(blocks.length >= 1, `${specifier} must declare at least one @font-face`);
    for (const block of blocks) {
      const family = /font-family\s*:\s*['"]([^'"]+)['"]/.exec(block)?.[1];
      assert.ok(family, `${specifier} @font-face must declare a family name`);
      families.add(family);
      const urls = [...block.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2]);
      assert.ok(urls.some((url) => url.endsWith("woff2")), `${specifier} must ship woff2 sources`);
      for (const url of urls) {
        fontFiles.push(parse(url).root ? url : join(parse(cssPath).dir, url));
      }
    }
  }
  return { families, fontFiles };
}

function usedFamilies() {
  const used = new Set();
  const scan = (path) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry.endsWith(".test.mjs")) continue;
        scan(join(path, entry));
      }
      return;
    }
    if (!/\.(css|tsx|ts)$/.test(path)) return;
    const source = readFileSync(path, "utf8");
    for (const line of source.split("\n")) {
      // CSS rules, inline fontFamily in TS, and the terminal font constant.
      if (!/\b(?:font-family|fontFamily|FONT_FAMILY)\b/i.test(line)) continue;
      const names = [...line.matchAll(/[~`'"]["']?([A-Za-z][A-Za-z -]{1,30})["']/g)].map((match) => match[1]);
      for (const name of names) used.add(name);
    }
  };
  scan(SRC_DIR);
  return used;
}

test("fonts.css resolves to real font css files that ship woff2 sources", () => {
  const { fontFiles } = providedFamilies();
  for (const file of fontFiles) {
    assert.ok(existsSync(file), `missing font asset referenced by @font-face: ${file}`);
  }
});

test("every font family used in the app is provided, not a device system font", () => {
  const { families } = providedFamilies();
  const provided = new Set([...families].map((name) => name.toLowerCase()));
  const used = usedFamilies();
  const offending = [...used].filter((name) => {
    const lower = name.toLowerCase();
    return !provided.has(lower) && !GENERIC_FAMILIES.has(lower);
  });
  assert.deepEqual(offending, [], "app references system fonts not provided: " + offending.join(", "));
});

test("every provided font family is actually used by the app", () => {
  const { families } = providedFamilies();
  const used = new Set([...usedFamilies()].map((name) => name.toLowerCase()));
  const dead = [...families].filter((name) => !used.has(name.toLowerCase()));
  assert.deepEqual(dead, [], "provided fonts never referenced: " + dead.join(", "));
});
