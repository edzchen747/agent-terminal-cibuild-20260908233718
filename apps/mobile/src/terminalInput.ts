export type NativeTerminalInputEvent = Pick<InputEvent, "data" | "inputType" | "isComposing">;

export interface TimedTerminalInput {
  data: string;
  at: number;
}

const DUPLICATE_INPUT_WINDOW_MS = 120;

export function isCursorPositionReport(data: string): boolean {
  return /^\x1b\[\??\d+;\d+R$/.test(data);
}

export function nativeTerminalInput(event: NativeTerminalInputEvent, textareaValue = ""): string {
  const inputType = event.inputType ?? "";
  if (inputType === "deleteContentBackward" || inputType === "deleteWordBackward" || inputType === "deleteSoftLineBackward") {
    return inputType === "deleteWordBackward" ? "\x17" : "\x7f";
  }
  if (inputType === "deleteContentForward" || inputType === "deleteWordForward" || inputType === "deleteSoftLineForward") {
    return "\x1b[3~";
  }
  if (inputType === "insertLineBreak") return "\r";
  if ((!inputType || inputType.startsWith("insert")) && !event.isComposing && (event.data || textareaValue)) {
    return event.data || textareaValue;
  }
  return "";
}

/**
 * Whether xterm should defer a keydown to Android's native IME event.
 *
 * Backspace and Enter must not defer to beforeinput/input: an IME can report
 * them with keyCode 229 without mutating xterm's empty textarea. They are
 * handled directly by androidImeKeydownInput instead.
 */
export function shouldDeferToNativeInput(event: Pick<KeyboardEvent, "type" | "key" | "keyCode" | "isComposing">): boolean {
  return event.type === "keydown" && event.keyCode === 229 && !event.isComposing && event.key.length === 1;
}

/**
 * Special keys reported with the generic Android IME key code cannot be
 * decoded by xterm and may not mutate an empty textarea. Handle them from the
 * keydown itself so they do not depend on a later native input event.
 */
export function androidImeKeydownInput(event: Pick<KeyboardEvent, "type" | "key" | "keyCode" | "isComposing">): string {
  if (event.type !== "keydown" || event.keyCode !== 229 || event.isComposing) return "";
  if (event.key === "Backspace") return "\x7f";
  if (event.key === "Enter") return "\r";
  return "";
}

/**
 * Make a native IME event authoritative while removing any xterm event from
 * the same key cycle. The caller must always forward the returned native data.
 */
export function claimNativeInput(native: TimedTerminalInput, pendingTerminalInput: TimedTerminalInput[]): string {
  const matchingTerminal = pendingTerminalInput.findIndex(
    (item) => Math.abs(native.at - item.at) <= DUPLICATE_INPUT_WINDOW_MS && item.data === native.data
  );
  if (matchingTerminal >= 0) {
    pendingTerminalInput.splice(matchingTerminal, 1);
  } else {
    // Android can emit a phantom xterm key immediately before the authoritative
    // insertText/deleteContentBackward event. Do not send both key cycles.
    for (let index = pendingTerminalInput.length - 1; index >= 0; index -= 1) {
      const pending = pendingTerminalInput[index];
      if (pending && Math.abs(native.at - pending.at) <= DUPLICATE_INPUT_WINDOW_MS) {
        pendingTerminalInput.splice(index, 1);
      }
    }
  }
  return native.data;
}
