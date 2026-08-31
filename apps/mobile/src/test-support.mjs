/**
 * Test-runtime support for the mobile unit tests that import non-pure
 * modules (connection.ts, embedded-engine.ts, device.ts).
 *
 * Two Node/runtime gaps are bridged here:
 *
 * 1. These modules use extensionless relative imports (TS "Bundler"
 *    resolution). Node's ESM loader requires explicit extensions, so a
 *    sync resolve hook appends `.ts` when the bare specifier misses.
 * 2. Their storage layer is @capacitor/preferences, a web plugin that talks
 *    to `window.localStorage`. Node has neither, so this module installs an
 *    in-memory shim before any of those modules is imported (the test files
 *    import this support module *statically* and the modules under test
 *    *dynamically*, so the hooks are always registered first).
 *
 * Every test file gets its own process under `node --test`, so the shim
 * state never leaks between files.
 */

import { registerHooks } from "node:module";

const storage = new Map();

globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(specifier)) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

/** Wipes the in-memory Preferences store; call in each `beforeEach`. */
export function resetStorage() {
  storage.clear();
}

/** Simulates a web storage outage; returns a function that restores it. */
export function breakStorage() {
  const original = window.localStorage.getItem;
  window.localStorage.getItem = () => {
    throw new Error("storage unavailable");
  };
  return () => { window.localStorage.getItem = original; };
}
