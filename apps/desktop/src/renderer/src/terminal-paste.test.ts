import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Ctrl+V paste guards. The pane funnels EVERY key through one
// attachCustomKeyEventHandler, whose tail forwards Ctrl chords to the shell
// as control sequences. The WebView swallows the native Ctrl+V paste before
// xterm can turn it into a paste event, so the pane must claim the chord
// and hand the clipboard to xterm's paste path (the same transformations a
// right-click paste gets, bracketed-paste wrap included) - or a bare \x16
// (the Ctrl-V control character) reaches the shell and nothing pastes.
const terminalPaneSource = readFileSync(
  fileURLToPath(new URL("./TerminalPane.tsx", import.meta.url)),
  "utf8"
);
const handler = terminalPaneSource.slice(terminalPaneSource.indexOf("attachCustomKeyEventHandler"));
const pasteClaim = handler.indexOf('event.key.toLowerCase() === "v"');
const forwardTail = handler.indexOf("const data = keyInput(event);");

test("Ctrl+V is claimed before the shell input tail", () => {
  assert.ok(pasteClaim > 0, "the handler must recognize Ctrl+V");
  assert.ok(forwardTail > 0, "the Ctrl-forwarding tail must still exist");
  assert.ok(pasteClaim < forwardTail,
    "Ctrl+V must be claimed before the tail, which would otherwise forward \\x16 to the shell");
});

test("Ctrl+V goes through xterm's own paste path, like a right-click paste", () => {
  const body = handler.slice(pasteClaim, forwardTail);
  assert.ok(body.includes("event.preventDefault()"),
    "the claim must cancel the key, or the WebView's native paste and xterm's \\x16 both fire");
  assert.ok(body.includes("window.agentTerminal.readClipboard()"),
    "the clipboard must be read on the host, where arboard owns it");
  assert.ok(body.includes("terminal.paste(text)"),
    "xterm's paste performs the exact transformations a native paste event gets (newline fold + bracketed-paste wrap in mode 2004); sendKeyboardInput would bypass them");
  assert.ok(body.includes("if (!event.repeat)"),
    "holding Ctrl+V must not re-paste on every key repeat");
});

test("Ctrl+V is only claimed unmodified", () => {
  // Alt/Shift/Meta variants are other chords: they fall through to the
  // forwarding tail, which keeps them (and their \\x1b-prefixed forms)
  // reachable by the shells that bind them.
  const claimLine = handler.slice(handler.lastIndexOf("if (", pasteClaim), pasteClaim);
  for (const modifier of ["event.ctrlKey", "!event.altKey", "!event.metaKey", "!event.shiftKey"]) {
    assert.ok(claimLine.includes(modifier), `the Ctrl+V claim must require ${modifier}`);
  }
  assert.ok(!handler.includes('event.key.toLowerCase() === "v" && !event.altKey'),
    "the old pass-through of Ctrl+V to xterm (which types \\x16 at the shell) must be gone");
});

test("only keydown claims the paste; keyup and keypress fall through to xterm", () => {
  const keydownGuard = handler.indexOf('event.type !== "keydown"');
  assert.ok(keydownGuard !== -1 && keydownGuard < pasteClaim,
    "xterm calls the handler on keyup too - a keyup must not trigger another paste");
});

test("an empty clipboard pastes nothing", () => {
  const body = handler.slice(pasteClaim, forwardTail);
  const guard = body.indexOf("if (text)");
  const paste = body.indexOf("terminal.paste(text)");
  assert.ok(guard !== -1 && guard < paste,
    "an empty clipboard must not emit an empty (or empty-bracketed) paste sequence at the shell");
});

test("a failed host clipboard read is swallowed, not thrown into the key handler", () => {
  const body = handler.slice(pasteClaim, forwardTail);
  assert.ok(body.includes(".catch(() => undefined)"),
    "an arboard read that errors (clipboard service wedged) must not surface as an unhandled promise rejection inside a keydown listener");
});

test("the paste claim never steals keys from a background pane", () => {
  const guard = handler.indexOf("if (!activeRef.current) return false;");
  assert.ok(guard >= 0 && guard < pasteClaim,
    "the active-pane guard must precede the paste claim");
});

test("the existing Ctrl claims keep their places", () => {
  // Copy (Ctrl+C with a selection) and zoom (Ctrl+/-/=/0) are claimed
  // ahead of the forwarding tail exactly as before the paste change.
  const copy = handler.indexOf('event.key.toLowerCase() === "c"');
  const zoom = handler.indexOf("const zoom = zoomIntent(event);");
  assert.ok(copy > 0 && copy < forwardTail, "the Ctrl+C copy claim must stay ahead of the tail");
  assert.ok(zoom > 0 && zoom < forwardTail, "the zoom claim must stay ahead of the tail");
});

const tauriApiSource = readFileSync(
  fileURLToPath(new URL("./tauri-api.ts", import.meta.url)),
  "utf8"
);
const desktopApiSource = readFileSync(
  fileURLToPath(new URL("../../shared/api.ts", import.meta.url)),
  "utf8"
);
const tauriLibSource = readFileSync(
  fileURLToPath(new URL("../../../src-tauri/src/lib.rs", import.meta.url)),
  "utf8"
);

test("the renderer exposes the host's clipboard read", () => {
  assert.ok(tauriApiSource.includes('readClipboard: () => invoke<string>("read_clipboard")'),
    "tauri-api must invoke the read_clipboard command");
  assert.ok(desktopApiSource.includes("readClipboard(): Promise<string>;"),
    "DesktopApi must declare readClipboard so the pane is typed against it");
});

test("the host command reads the clipboard with arboard, like copy_text does", () => {
  const command = tauriLibSource.slice(tauriLibSource.indexOf("fn read_clipboard"));
  const end = command.indexOf("#[tauri::command]");
  const body = end > 0 ? command.slice(0, end) : command;
  assert.ok(body.includes("Clipboard::new()"), "must use the same arboard clipboard as copy_text");
  assert.ok(body.includes("get_text()"), "must read the clipboard text");
  assert.ok(tauriLibSource.includes("read_clipboard,"), "the command must be registered in the invoke handler");
});