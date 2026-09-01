import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { effectiveAutoCollapse, isNarrowLayout, loadSidebarPreferences, NARROW_SIDEBAR_WIDTH, saveSidebarPreferences, sidebarOpenAfterAutoCollapseToggle, sidebarOpenAfterNarrowLayout, shouldCollapseSidebar } from "./sidebar.ts";

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
const overlayClick = (open: boolean, autoCollapse: boolean) => shouldCollapseSidebar(open, autoCollapse, false, false, false, true);

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

  it("never collapses on a click inside the rename project overlay", () => {
    assert.equal(overlayClick(true, true), false);
    assert.equal(overlayClick(false, true), false);
    assert.equal(overlayClick(true, false), false);
    assert.equal(overlayClick(false, false), false);
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

describe("sidebar collapse decision matrix", () => {
  // Spec: collapse exactly when the sidebar is open, auto-collapse is
  // effective, the click is neither on the explicit toggle nor on the
  // rename-project overlay, and the click is outside the sidebar or on a
  // project row. Every one of the 64 combinations of the six flags is
  // asserted against that spec.
  it("matches the collapse spec for every combination of flags", () => {
    for (const open of [true, false]) {
      for (const autoCollapse of [true, false]) {
        for (const inside of [true, false]) {
          for (const isProject of [true, false]) {
            for (const isToggle of [true, false]) {
              for (const inProjectOverlay of [true, false]) {
                const expected = open && autoCollapse && !isToggle && !inProjectOverlay && (!inside || isProject);
                assert.equal(
                  shouldCollapseSidebar(open, autoCollapse, inside, isProject, isToggle, inProjectOverlay),
                  expected,
                  `open=${open} auto=${autoCollapse} inside=${inside} project=${isProject} toggle=${isToggle} overlay=${inProjectOverlay}`
                );
              }
            }
          }
        }
      }
    }
  });

  it("treats the toggle as the explicit control: it never collapses, even on a click outside the sidebar", () => {
    for (const inside of [true, false]) {
      for (const isProject of [true, false]) {
        assert.equal(shouldCollapseSidebar(true, true, inside, isProject, true, false), false, `toggle click inside=${inside} project=${isProject}`);
      }
    }
  });

  it("treats the rename overlay as part of the sidebar flow: it never collapses, even outside or on a project", () => {
    for (const inside of [true, false]) {
      for (const isProject of [true, false]) {
        assert.equal(shouldCollapseSidebar(true, true, inside, isProject, false, true), false, `overlay click inside=${inside} project=${isProject}`);
      }
    }
  });

  it("keeps the sidebar open for interior clicks that are neither projects nor the overlay", () => {
    assert.equal(shouldCollapseSidebar(true, true, true, false, false, false), false);
  });

  it("collapses from the open-and-enabled state on an outside click or a project click", () => {
    assert.equal(shouldCollapseSidebar(true, true, false, false, false, false), true);
    assert.equal(shouldCollapseSidebar(true, true, true, true, false, false), true);
  });
});

describe("narrow layout threshold", () => {
  it("is narrow exactly at the documented threshold", () => {
    assert.equal(NARROW_SIDEBAR_WIDTH, 900);
    assert.equal(isNarrowLayout(900), true);
  });

  it("is not narrow just above the threshold", () => {
    assert.equal(isNarrowLayout(901), false);
  });

  it("treats the Tauri minimum widths as narrow", () => {
    // 680 is the current Tauri window minimum; 840 was the old one. Both
    // must land in the overlay-drawer layout.
    assert.equal(isNarrowLayout(680), true);
    assert.equal(isNarrowLayout(840), true);
  });

  it("treats the default window width as wide", () => {
    assert.equal(isNarrowLayout(1320), false);
  });

  it("treats degenerate widths as narrow", () => {
    assert.equal(isNarrowLayout(0), true);
  });
});

describe("effective auto collapse", () => {
  it("is on when the saved setting is on, regardless of layout", () => {
    assert.equal(effectiveAutoCollapse(true, false), true);
    assert.equal(effectiveAutoCollapse(true, true), true);
  });

  it("is implicitly on in the narrow layout even when the saved setting is off", () => {
    assert.equal(effectiveAutoCollapse(false, true), true);
  });

  it("is off only when the setting is off and the layout is wide", () => {
    assert.equal(effectiveAutoCollapse(false, false), false);
  });
});

describe("sidebar state when entering narrow layout", () => {
  it("collapses an open sidebar when the window becomes narrow", () => {
    assert.equal(sidebarOpenAfterNarrowLayout(true, true), false);
  });

  it("leaves a collapsed sidebar collapsed when the window becomes narrow", () => {
    assert.equal(sidebarOpenAfterNarrowLayout(false, true), false);
  });

  it("keeps the sidebar in its current state when the window is wide", () => {
    assert.equal(sidebarOpenAfterNarrowLayout(true, false), true);
    assert.equal(sidebarOpenAfterNarrowLayout(false, false), false);
  });
});

describe("sidebar state after toggling auto collapse", () => {
  it("reopens the sidebar when auto collapse is turned off", () => {
    assert.equal(sidebarOpenAfterAutoCollapseToggle(false, false), true);
    assert.equal(sidebarOpenAfterAutoCollapseToggle(true, false), true);
  });

  it("leaves the sidebar unchanged when auto collapse is turned on", () => {
    assert.equal(sidebarOpenAfterAutoCollapseToggle(true, true), true);
    assert.equal(sidebarOpenAfterAutoCollapseToggle(false, true), false);
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
