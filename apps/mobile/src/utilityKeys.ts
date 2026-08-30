import { applyTerminalModifiers } from "@agentterminal/protocol";
import type { TerminalModifier } from "@agentterminal/protocol";

/** A key in the terminal utility row, mapping to a modifier and/or a value. */
export interface UtilityKey {
  id: string;
  label: string;
  modifier?: TerminalModifier;
  value?: string;
}

export interface KeyPadState {
  /** Keys with a pointer currently down; modifiers here are active. */
  held: readonly string[];
  /** Modifiers latched on; active until a non-modifier key fires. */
  latched: readonly string[];
}

export interface KeyPadResult {
  state: KeyPadState;
  /** Data to send to the terminal, or null when nothing fires. */
  data: string | null;
}

export interface UtilityKeyPad {
  state(): KeyPadState;
  press(key: UtilityKey): KeyPadResult;
  release(keyId: string): KeyPadResult;
  consume(value: string): KeyPadResult;
  /** Drops all held and latched keys without firing anything. */
  reset(): KeyPadResult;
}

export function createUtilityKeyPad(): UtilityKeyPad {
  let held: UtilityKey[] = [];
  let latched: UtilityKey[] = [];
  // Whether a held modifier was already latched when its pointer went down.
  // Releasing it then toggles the latch off again, preserving tap-to-cancel.
  const latchedAtPress = new Map<string, boolean>();

  const snapshot = (): KeyPadState => ({
    held: held.map((key) => key.id),
    latched: latched.map((key) => key.id)
  });

  const activeModifiers = () => {
    const modifiers = new Set<TerminalModifier>();
    for (const key of held) if (key.modifier) modifiers.add(key.modifier);
    for (const key of latched) if (key.modifier) modifiers.add(key.modifier);
    return modifiers;
  };

  // A non-modifier keypress completes the current modifier state: the chord
  // fires now and the latched modifiers are cleared. Held modifiers stay
  // active for the rest of the hold and re-latch when released.
  const resetModifiers = () => {
    latched = [];
  };

  return {
    state: snapshot,

    press(key: UtilityKey): KeyPadResult {
      if (held.some((item) => item.id === key.id)) {
        return { state: snapshot(), data: null };
      }
      held.push(key);
      if (key.modifier) {
        // A modifier never sends input on its own: it is engaged for the
        // whole hold and waits until a non-modifier key completes the chord.
        latchedAtPress.set(key.id, latched.some((item) => item.id === key.id));
        return { state: snapshot(), data: null };
      }
      const data = key.value ? applyTerminalModifiers(key.value, activeModifiers()) : null;
      resetModifiers();
      return { state: snapshot(), data };
    },

    release(keyId: string): KeyPadResult {
      const removed = held.find((item) => item.id === keyId);
      if (!removed) return { state: snapshot(), data: null };
      held = held.filter((item) => item.id !== keyId);
      if (removed.modifier) {
        const wasLatched = latchedAtPress.get(keyId) === true;
        latchedAtPress.delete(keyId);
        if (wasLatched) {
          // It was already latched when pressed, so releasing toggles it off.
          latched = latched.filter((item) => item.id !== keyId);
        } else {
          // Lifting a held modifier re-latches it on, whether or not a chord
          // fired while it was held; it stays armed until a key fires the
          // chord or the key is tapped again to toggle it off.
          latched = [...latched, removed];
        }
      }
      return { state: snapshot(), data: null };
    },

    consume(value: string): KeyPadResult {
      // Typed text is a non-modifier keypress: it fires the chord with every
      // active modifier and resets the modifier state.
      const data = applyTerminalModifiers(value, activeModifiers());
      resetModifiers();
      return { state: snapshot(), data };
    },

    reset(): KeyPadResult {
      held = [];
      latched = [];
      latchedAtPress.clear();
      return { state: snapshot(), data: null };
    }
  };
}
