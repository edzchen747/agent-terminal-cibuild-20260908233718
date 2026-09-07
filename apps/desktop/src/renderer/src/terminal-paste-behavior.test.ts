import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Edge cases of the paste pipeline. Ctrl+V and right-click paste both funnel
// into xterm's own paste handler (terminal.paste), so its edge-case behavior
// is what the shell receives. These tests run the real @xterm/xterm
// headlessly and pin the paste semantics the shell depends on:
//   - newlines fold into the shell's Enter (\r)
//   - while the shell runs in bracketed paste mode (2004), the pasted text
//     is wrapped in ESC[200~ ... ESC[201~, so a pasted Enter stays paste
//     content instead of being read as a typed keypress - the exact
//     behavior that a TUI relies on
//   - the helper textarea is cleared, so stale text is never re-typed
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

type Fixture = {
  terminal: {
    paste: (data: string) => void;
    write: (data: string, callback?: () => void) => boolean;
    onData: (listener: (data: string) => void) => { dispose: () => void };
    dispose: () => void;
    _core: { textarea?: { value: string } };
  };
  events: string[];
  textarea: { value: string };
  done: () => void;
};

function pasteFixture(): Fixture {
  const terminal = new Terminal();
  const events: string[] = [];
  const subscription = terminal.onData((data: string) => events.push(data));
  const textarea = { value: "" };
  // A browser-opened terminal creates its hidden helper textarea in open();
  // headlessly we stub the property the paste cleanup writes to.
  terminal._core.textarea = textarea;
  return {
    terminal,
    events,
    textarea,
    done: () => {
      subscription.dispose();
      terminal.dispose();
    },
  };
}

// The last onData payload - a paste is exactly one data event.
const pasted = (fixture: Fixture) => fixture.events[fixture.events.length - 1];

// Feed "shell output" through the real parser; the write callback fires
// once the parser has consumed the data.
const writeShell = (fixture: Fixture, data: string) =>
  new Promise<void>((resolve) => {
    fixture.terminal.write(data, () => resolve());
  });

test("a paste without newlines is delivered verbatim", () => {
  const fixture = pasteFixture();
  fixture.terminal.paste("echo hello");
  assert.equal(pasted(fixture), "echo hello");
  fixture.done();
});

test("a paste folds every newline form into the shell's Enter", () => {
  const fixture = pasteFixture();
  fixture.terminal.paste("a\rb\nc\r\nd");
  // A lone \r passes through; \n and \r\n each become ONE \r - exactly what a
  // typed Enter produces. A Windows CRLF pair collapses to a single Enter,
  // never a double one.
  assert.equal(pasted(fixture), "a\rb\rc\rd");
  fixture.done();
});

test("while the shell runs in bracketed paste mode, a pasted Enter stays paste content", async () => {
  const fixture = pasteFixture();
  await writeShell(fixture, "\x1b[?2004h"); // the TUI enables mode 2004
  fixture.terminal.paste("echo hi\r\nthere");
  assert.equal(pasted(fixture), "\x1b[200~echo hi\rthere\x1b[201~");
  fixture.done();
});

test("disabling bracketed paste mode unwraps the paste", async () => {
  const fixture = pasteFixture();
  await writeShell(fixture, "\x1b[?2004h");
  await writeShell(fixture, "\x1b[?2004l");
  fixture.terminal.paste("echo hi\r\nthere");
  assert.equal(pasted(fixture), "echo hi\rthere");
  fixture.done();
});

test("a paste clears the helper textarea so stale text is never re-typed", () => {
  const fixture = pasteFixture();
  fixture.textarea.value = "stale composition";
  fixture.terminal.paste("x");
  assert.equal(fixture.textarea.value, "");
  fixture.done();
});