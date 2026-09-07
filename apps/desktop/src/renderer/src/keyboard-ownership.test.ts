import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyKeyboardFocus, shouldReturnKeyboardToTerminal, type FocusPlacement } from "./keyboard-ownership.ts";

describe("keyboard focus classification", () => {
  it("treats the terminal's own input surface as terminal, even though it is a textarea", () => {
    assert.equal(classifyKeyboardFocus({ isTerminalSurface: true, isControl: true, insideOverlay: false }), "terminal");
  });

  it("treats a plain input control as control", () => {
    assert.equal(classifyKeyboardFocus({ isTerminalSurface: false, isControl: true, insideOverlay: false }), "control");
  });

  it("keeps a control a control even inside an overlay (the find input, a settings input)", () => {
    assert.equal(classifyKeyboardFocus({ isTerminalSurface: false, isControl: true, insideOverlay: true }), "control");
  });

  it("treats overlay furniture that is not a control as overlay", () => {
    assert.equal(classifyKeyboardFocus({ isTerminalSurface: false, isControl: false, insideOverlay: true }), "overlay");
  });

  it("treats everything else as chrome", () => {
    assert.equal(classifyKeyboardFocus({ isTerminalSurface: false, isControl: false, insideOverlay: false }), "chrome");
  });
});

describe("keyboard return decision", () => {
  it("never moves a keyboard that already sits on the terminal", () => {
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "terminal", overlayOpen: false }), false);
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "terminal", overlayOpen: true }), false);
  });

  it("never moves a keyboard that sits on an input control", () => {
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "control", overlayOpen: false }), false);
    // A settings input focused while its modal is up: the modal owns the
    // keyboard, and its close path restores the terminal.
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "control", overlayOpen: true }), false);
  });

  it("returns a keyboard that settled on window chrome", () => {
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "chrome", overlayOpen: false }), true);
  });

  it("never returns a keyboard while a blocking overlay is open", () => {
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "chrome", overlayOpen: true }), false);
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "overlay", overlayOpen: true }), false);
  });

  it("returns a keyboard that settled on the non-blocking find bar", () => {
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "overlay", overlayOpen: false }), true);
  });

  it("matches the policy spec for every combination", () => {
    const placements: FocusPlacement[] = ["terminal", "control", "overlay", "chrome"];
    for (const focus of placements) {
      for (const overlayOpen of [true, false]) {
        const expected = (focus === "chrome" || focus === "overlay") && !overlayOpen;
        assert.equal(
          shouldReturnKeyboardToTerminal({ focus, overlayOpen }),
          expected,
          `focus=${focus} overlayOpen=${overlayOpen}`
        );
      }
    }
  });
});

describe("keyboard focus classification decision matrix", () => {
  // Spec: the terminal-surface check wins over everything (xterm's helper
  // textarea is a textarea that must read as terminal, never control),
  // then a control (even one inside an overlay region - the find input and
  // the settings inputs), then an overlay, and chrome as the fallthrough.
  it("matches the classification spec for every combination of flags", () => {
    for (const isTerminalSurface of [true, false]) {
      for (const isControl of [true, false]) {
        for (const insideOverlay of [true, false]) {
          const expected = isTerminalSurface
            ? "terminal"
            : isControl
              ? "control"
              : insideOverlay
                ? "overlay"
                : "chrome";
          assert.equal(
            classifyKeyboardFocus({ isTerminalSurface, isControl, insideOverlay }),
            expected,
            `surface=${isTerminalSurface} control=${isControl} overlay=${insideOverlay}`
          );
        }
      }
    }
  });

  it("keeps the terminal surface a terminal even inside an overlay region", () => {
    // Defensive: today the helper textarea never renders inside an overlay,
    // but if it ever did, it must still read as terminal - the keyboard is
    // the shell's, not the overlay's.
    assert.equal(classifyKeyboardFocus({ isTerminalSurface: true, isControl: true, insideOverlay: true }), "terminal");
  });
});

describe("keyboard return edge cases", () => {
  it("never returns a keyboard while a blocking overlay is open, even from chrome", () => {
    // A click that opened the modal settled the keyboard on the button that
    // opened it: the overlay owns the keyboard until its close path runs.
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "chrome", overlayOpen: true }), false);
  });

  it("returns a keyboard sitting on find-bar furniture when no blocking overlay is open", () => {
    // The find bar floats over the pane without covering the terminal, so
    // it never blocks the keyboard: clicking the sidebar with the find bar
    // up hands the keyboard back to the shell, highlights and all.
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "overlay", overlayOpen: false }), true);
  });

  it("does not return a keyboard sitting on find-bar furniture while a modal is open", () => {
    // A settings modal over a pane whose find bar is still open: the modal
    // owns the keyboard, and only its close path may restore the terminal.
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "overlay", overlayOpen: true }), false);
  });

  it("leaves a keyboard on an input control even while its modal is open", () => {
    // A settings select focused inside the settings modal: the control keeps
    // the keyboard it was given; the terminal's restore waits for the close.
    assert.equal(shouldReturnKeyboardToTerminal({ focus: "control", overlayOpen: true }), false);
  });
});