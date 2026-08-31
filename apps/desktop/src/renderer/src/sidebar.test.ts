import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { loadSidebarPreferences, saveSidebarPreferences, shouldCollapseSidebar } from "./sidebar.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function installStorage(): void {
  const storage = new MemoryStorage();
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
}

const outsideClick = (open: boolean, autoCollapse: boolean) => shouldCollapseSidebar(open, autoCollapse, false, false);
const projectClick = (open: boolean, autoCollapse: boolean) => shouldCollapseSidebar(open, autoCollapse, true, true);
const insideClick = (open: boolean, autoCollapse: boolean) => shouldCollapseSidebar(open, autoCollapse, true, false);
const toggleClick = (open: boolean, autoCollapse: boolean) => shouldCollapseSidebar(open, autoCollapse, false, false, true);

describe("sidebar auto collapse", () => {
  it("collapses on a click outside the sidebar when enabled", () => {
    assert.equal(shouldCollapseSidebar(true, true, false, false), true);
  });

  it("collapses on a project click when enabled", () => {
    assert.equal(shouldCollapseSidebar(true, true, true, true), true);
  });

  it("ignores clicks inside the sidebar that are not projects", () => {
    assert.equal(insideClick(true, true), false);
  });

  it("never collapses when the setting is off, even when the sidebar is open", () => {
    assert.equal(outsideClick(true, false), false);
    assert.equal(projectClick(true, false), false);
    assert.equal(insideClick(true, false), false);
  });

  it("never collapses on a click of the toggle button", () => {
    assert.equal(toggleClick(true, true), false);
    assert.equal(toggleClick(false, true), false);
    assert.equal(toggleClick(true, false), false);
    assert.equal(toggleClick(false, false), false);
  });

  it("still collapses on the click ending a toggle when the event lands next to it", () => {
    assert.equal(shouldCollapseSidebar(true, true, false, false, false), true);
  });

  it("stays collapsed once already closed", () => {
    assert.equal(outsideClick(false, true), false);
    assert.equal(projectClick(false, true), false);
    assert.equal(insideClick(false, true), false);
  });
});

describe("sidebar preferences", () => {
  beforeEach(() => installStorage());

  it("defaults to auto collapse on", () => {
    assert.deepEqual(loadSidebarPreferences(), { autoCollapse: true });
  });

  it("round-trips a saved setting", () => {
    saveSidebarPreferences({ autoCollapse: false });
    assert.deepEqual(loadSidebarPreferences(), { autoCollapse: false });
    saveSidebarPreferences({ autoCollapse: true });
    assert.deepEqual(loadSidebarPreferences(), { autoCollapse: true });
  });

  it("treats an explicit false as off and anything else as on", () => {
    saveSidebarPreferences({ autoCollapse: false });
    assert.equal(loadSidebarPreferences().autoCollapse, false);
    saveSidebarPreferences({ autoCollapse: true });
    assert.equal(loadSidebarPreferences().autoCollapse, true);
    saveSidebarPreferences({ autoCollapse: "false" as unknown as boolean });
    assert.equal(loadSidebarPreferences().autoCollapse, true);
  });

  it("falls back to defaults on corrupt JSON", () => {
    saveSidebarPreferences({ autoCollapse: false });
    const storage = (globalThis as Record<string, unknown>).window as { localStorage: Storage };
    storage.localStorage.setItem("agent-terminal.desktop.sidebar.v1", "{not json");
    assert.deepEqual(loadSidebarPreferences(), { autoCollapse: true });
  });

  it("falls back to defaults when storage is unavailable", () => {
    (globalThis as Record<string, unknown>).window = {};
    assert.deepEqual(loadSidebarPreferences(), { autoCollapse: true });
  });

  it("does not throw when storage writes fail", () => {
    const throwingStorage = new MemoryStorage();
    throwingStorage.setItem = () => { throw new Error("quota exceeded"); };
    (globalThis as Record<string, unknown>).window = { localStorage: throwingStorage };
    assert.doesNotThrow(() => saveSidebarPreferences({ autoCollapse: false }));
  });
});
