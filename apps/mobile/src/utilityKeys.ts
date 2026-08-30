import { applyTerminalModifiers } from "@agentterminal/protocol";
import type { TerminalModifier } from "@agentterminal/protocol";

/** A key in the terminal utility row, mapping to a modifier and/or a value. */
export interface UtilityKey {
  id: string;
  label: string;
  modifier?: TerminalModifier;
  value?: string;
  /** Fires immediately on press instead of waiting for the latched countdown (arrows). */
  instant?: boolean;
}

export interface KeyPadState {
  /** Keys with a pointer currently down; modifiers here are active. */
  held: readonly string[];
  /** Keys latched for a chord; resolved by the countdown. */
  selected: readonly string[];
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
  expire(): KeyPadResult;
  consume(value: string): KeyPadResult;
  /** Drops all held and latched keys without firing anything. */
  reset(): KeyPadResult;
}

export function createUtilityKeyPad(): UtilityKeyPad {
  let held: UtilityKey[] = [];
  let selected: UtilityKey[] = [];
  // Whether a held modifier was already latched when its pointer went down.
  // Releasing it then toggles the latch off again, preserving tap-to-cancel.
  const selectedAtPress = new Map<string, boolean>();

  const snapshot = (): KeyPadState => ({
    held: held.map((key) => key.id),
    selected: selected.map((key) => key.id)
  });

  const activeModifiers = () => {
    const modifiers = new Set<TerminalModifier>();
    for (const key of held) if (key.modifier) modifiers.add(key.modifier);
    for (const key of selected) if (key.modifier) modifiers.add(key.modifier);
    return modifiers;
  };

  const buildChord = (keys: readonly UtilityKey[], modifiers: ReadonlySet<TerminalModifier>) => {
    const output = keys.flatMap((key) =>
      key.value ? [applyTerminalModifiers(key.value, modifiers)] : []
    ).join("");
    return output || null;
  };

  return {
    state: snapshot,

    press(key: UtilityKey): KeyPadResult {
      if (held.some((item) => item.id === key.id)) {
        return { state: snapshot(), data: null };
      }
      // A modifier is engaged for the whole hold: while the finger is on the
      // button its modifier combines with keys pressed by other fingers.
      held.push(key);
      if (key.modifier) {
        selectedAtPress.set(key.id, selected.some((item) => item.id === key.id));
        return { state: snapshot(), data: null };
      }

      // Any value key fired while a modifier is physically held behaves like a
      // real keyboard: the chord fires now and the latched stack is consumed.
      const heldModifier = held.some((item) => Boolean(item.modifier));
      if (heldModifier || key.instant) {
        // A latched copy of the pressed key must not fire twice; pressing it
        // again is one new press, not the old latch plus this one.
        const stacked = selected.filter((item) => item.id !== key.id);
        const data = buildChord([...stacked, key], activeModifiers());
        selected = [];
        return { state: snapshot(), data };
      }

      // Latch-style value keys keep the existing stack-and-countdown flow.
      const alreadySelected = selected.some((item) => item.id === key.id);
      if (alreadySelected) {
        selected = selected.filter((item) => item.id !== key.id);
        return { state: snapshot(), data: null };
      }
      if (!selected.length) {
        selected = [key];
        return { state: snapshot(), data: key.value ?? null };
      }
      selected = [...selected, key];
      return { state: snapshot(), data: null };
    },

    release(keyId: string): KeyPadResult {
      const removed = held.find((item) => item.id === keyId);
      if (!removed) return { state: snapshot(), data: null };
      held = held.filter((item) => item.id !== keyId);
      if (removed.modifier) {
        // After release the key continues the current behavior: it stays
        // latched with a countdown so the next press can still chord with it.
        // If it was already latched when pressed, releasing toggles it off,
        // preserving the tap-to-cancel behavior.
        if (selectedAtPress.get(keyId) === true) {
          selected = selected.filter((item) => item.id !== keyId);
        } else {
          selected = [...selected, removed];
        }
        selectedAtPress.delete(keyId);
      }
      return { state: snapshot(), data: null };
    },

    expire(): KeyPadResult {
      const pending = selected;
      selected = [];
      // The countdown resolves only the keys that were stacked, with their own
      // modifiers. Keys held while the countdown ran are separate input.
      if (pending.length > 1) {
        const modifiers = new Set<TerminalModifier>();
        for (const key of pending) if (key.modifier) modifiers.add(key.modifier);
        return { state: snapshot(), data: buildChord(pending, modifiers) };
      }
      return { state: snapshot(), data: null };
    },

    consume(value: string): KeyPadResult {
      const output = applyTerminalModifiers(value, activeModifiers());
      if (selected.length) selected = [];
      return { state: snapshot(), data: output };
    },

    reset(): KeyPadResult {
      held = [];
      selected = [];
      selectedAtPress.clear();
      return { state: snapshot(), data: null };
    }
  };
}
