/**
 * Pure decision logic for the project persistence toggle (saved vs temporary).
 * Kept out of the React component so its edge cases can be unit-tested without
 * a DOM.
 */

export interface ProjectPersistenceAction {
  /** The value to send to the host when the user toggles: true saves, false unsaves. */
  nextPersistent: boolean;
  /** Tooltip / accessible name describing the action about to happen. */
  tooltip: string;
  /** Short visible label used by the title-bar control. */
  shortLabel: string;
}

/**
 * Given a project's current persistence flag, decide what a toggle does:
 * the next flag to persist plus the labels that describe the action. Toggling
 * inverts the flag — a saved (persistent) project is unsaved and a temporary
 * project is saved.
 */
export function projectPersistenceAction(persistent: boolean): ProjectPersistenceAction {
  return persistent
    ? { nextPersistent: false, tooltip: "Stop saving this project", shortLabel: "Unsave" }
    : { nextPersistent: true, tooltip: "Save this temporary project", shortLabel: "Save project" };
}

/**
 * A project row is itself a keyboard-activatable button (role=button,
 * tabIndex=0) but also nests its own controls (the persistence and rename
 * buttons). Enter or Space must open the project only when the key lands on
 * the row itself; when a nested control holds focus the same keys activate
 * that control instead, and letting the row also open the project would make
 * a single keypress do two things at once.
 */
export function projectRowOpensOnKey(target: unknown, currentTarget: unknown, key: string): boolean {
  return target === currentTarget && (key === "Enter" || key === " ");
}