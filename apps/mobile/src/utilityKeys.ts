import { applyTerminalModifiers } from "@agentterminal/protocol";
import type { TerminalModifier } from "@agentterminal/protocol";

/**
 * Default duration a modifier key must stay down before release counts
 * as a detected hold rather than a tap. Native builds override it with
 * the Android system's long-press timeout, so the hold boundary matches
 * the platform's own long-press detection. A tap keeps the toggle
 * behavior (latch on if it was not armed, off if it was); a hold engaged
 * the modifier only for the duration of the hold, so lifting the finger
 * drops it instead of leaving it selected.
 */
export const MODIFIER_HOLD_THRESHOLD_MS = 300;

/** A key in the terminal utility row, mapping to a modifier and/or a value. */
export interface UtilityKey {
  id: string;
  label: string;
  modifier?: TerminalModifier;
  value?: string;
}

export interface KeyPadState {
  /** Keys with an active press; modifiers here are active. */
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
  /**
   * Lifts a key. A modifier held at least the hold threshold (the
   * system long-press duration on device, MODIFIER_HOLD_THRESHOLD_MS
   * off device) drops off without latching; a quicker tap toggles its
   * latch as before (on if it was not armed, off if it was).
   */
  release(keyId: string): KeyPadResult;
  /**
   * The platform cancelled this key's pointer (the finger slid off and
   * the gesture was taken over), so no pointerup will ever arrive for
   * it. The key must not outlive the finger, so a cancel ends with the
   * same end-state as release: a modifier detected as a hold drops,
   * a quicker tap toggles its latch as before.
   */
  cancel(keyId: string): KeyPadResult;
  consume(value: string): KeyPadResult;
  /** Drops all held and latched keys without firing anything. */
  reset(): KeyPadResult;
}

export function createUtilityKeyPad(now: () => number = Date.now, holdThresholdMs: () => number = () => MODIFIER_HOLD_THRESHOLD_MS): UtilityKeyPad {
  let held: UtilityKey[] = [];
  let latched: UtilityKey[] = [];
  // Whether a held modifier was already latched when its pointer went down.
  // Releasing it then toggles the latch off again, preserving tap-to-cancel.
  const latchedAtPress = new Map<string, boolean>();
  // When each modifier's pointer went down, so release can tell a detected
  // hold (down at least the hold threshold) from a quick tap.
  const pressTime = new Map<string, number>();

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
  // active for the rest of the hold; a detected hold drops when released
  // (a quick tap re-latches instead, see release).
  const resetModifiers = () => {
    latched = [];
  };

  // A lift of a key: tap-toggle or hold-drop semantics. A cancelled
  // pointer (the platform took the gesture away) also ends here: the
  // key must not outlive the finger, so cancel falls through to these
  // same end-states.
  const release = (keyId: string): KeyPadResult => {
    const removed = held.find((item) => item.id === keyId);
    if (!removed) return { state: snapshot(), data: null };
    held = held.filter((item) => item.id !== keyId);
    if (removed.modifier) {
      const wasLatched = latchedAtPress.get(keyId) === true;
      latchedAtPress.delete(keyId);
      const wasHeld = now() - (pressTime.get(keyId) ?? now()) >= holdThresholdMs();
      pressTime.delete(keyId);
      if (wasHeld) {
        // A detected hold: the modifier was engaged only for the duration
        // of the hold, so lifting the finger drops it. It is not left
        // selected like a tap would be, whether or not a chord fired while
        // it was held. (If it was already latched, this cancels that
        // latch too, never stacking a second one.)
        latched = latched.filter((item) => item.id !== keyId);
      } else if (wasLatched) {
        // It was already latched when pressed, so the tap toggles it off.
        latched = latched.filter((item) => item.id !== keyId);
      } else {
        // A tap latches the modifier on; it stays armed until a key fires
        // the chord or the key is tapped again to toggle it off.
        latched = [...latched, removed];
      }
    }
    return { state: snapshot(), data: null };
  };

  return {
    state: snapshot,

    press(key: UtilityKey): KeyPadResult {
      const existing = held.find((item) => item.id === key.id);
      if (existing) return { state: snapshot(), data: null };
      held.push(key);
      if (key.modifier) {
        // A modifier never sends input on its own: it is engaged for the
        // whole hold and waits until a non-modifier key completes the chord.
        latchedAtPress.set(key.id, latched.some((item) => item.id === key.id));
        pressTime.set(key.id, now());
        return { state: snapshot(), data: null };
      }
      const data = key.value ? applyTerminalModifiers(key.value, activeModifiers()) : null;
      resetModifiers();
      return { state: snapshot(), data };
    },

    release,

    cancel(keyId: string): KeyPadResult {
      // The platform took the gesture away (the finger slid off the key
      // and started scrolling or a system gesture): no pointerup will
      // ever arrive for that pointer. The key must not outlive the
      // finger, so a cancelled press ends with exactly the same
      // end-state as a normal release.
      return release(keyId);
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
      pressTime.clear();
      return { state: snapshot(), data: null };
    }
  };
}
