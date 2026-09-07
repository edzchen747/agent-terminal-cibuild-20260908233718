/**
 * The ConEmu `OSC 9;4` taskbar progress states, the same set Windows
 * Terminal applies to its taskbar button through `ITaskbarList3`:
 *
 * | state          | meaning                                        |
 * | -------------- | -------------------------------------------- |
 * | `clear`        | no progress indicator                         |
 * | `value`        | deterministic progress (0-100)                |
 * | `error`        | failed; `progress` marks where it failed      |
 * | `indeterminate`| running, duration unknown (animated spinner)  |
 * | `paused`       | waiting on input or a user action             |
 *
 * `progress` is only meaningful for `value`, `error`, and `paused`.
 * A window's taskbar button shows the highest-priority state of its
 * project's sessions, Windows Terminal's group rule:
 * `error` > `paused` > `value` > `indeterminate` > `clear`.
 */
export type TaskbarProgressState =
  | "clear"
  | "value"
  | "error"
  | "indeterminate"
  | "paused";

export interface TaskbarProgress {
  state: TaskbarProgressState;
  /** 0-100, only present for value/error/paused states. */
  progress?: number;
}

export const TASKBAR_PROGRESS_STATES: readonly TaskbarProgressState[] = [
  "clear",
  "value",
  "error",
  "indeterminate",
  "paused",
];

export const CLEAR_TASKBAR_PROGRESS: TaskbarProgress = {
  state: "clear",
};

/** The highest-priority state, Windows Terminal's taskbar group rule. */
export function combineTaskbarProgress(
  states: readonly TaskbarProgress[],
): TaskbarProgress {
  const priority = {
    error: 0,
    paused: 1,
    value: 2,
    indeterminate: 3,
    clear: 4,
  } as const;
  let best: TaskbarProgress | undefined;
  for (const state of states) {
    if (
      !best ||
      priority[state.state] < priority[best.state]
    ) {
      best = state;
    }
  }
  return best ?? CLEAR_TASKBAR_PROGRESS;
}