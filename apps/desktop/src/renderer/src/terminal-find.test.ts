import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Find-bar wiring guards. The pane funnels EVERY key through one
// attachCustomKeyEventHandler, and its tail forwards any Ctrl chord to the
// shell as a control sequence - so a find shortcut that is not claimed ahead
// of that tail is simply typed at the shell instead.
const terminalPaneSource = readFileSync(
  fileURLToPath(new URL("./TerminalPane.tsx", import.meta.url)),
  "utf8"
);

test("Ctrl+F is claimed before the pane forwards it to the shell", () => {
  const handler = terminalPaneSource.slice(terminalPaneSource.indexOf("attachCustomKeyEventHandler"));
  const claim = handler.indexOf('event.key.toLowerCase() === "f"');
  const forward = handler.indexOf("const data = keyInput(event);");
  assert.ok(claim > 0, "the handler must recognize Ctrl+F");
  assert.ok(forward > 0);
  assert.ok(claim < forward,
    "Ctrl+F must be claimed before the Ctrl-forwarding tail, which would otherwise send it to the shell as \x06");
});

test("Ctrl+Shift+F still reaches the shell", () => {
  // Claiming Ctrl+F outright would put \x06 out of reach of every shell that
  // binds it (bash's forward-char, tmux prefixes), so the shifted chord is
  // deliberately left to fall through to the forwarding tail.
  assert.ok(terminalPaneSource.includes('!event.shiftKey && event.key.toLowerCase() === "f"'),
    "the find shortcut must exclude Shift so Ctrl+Shift+F falls through unclaimed");
});

test("find never writes to the session", () => {
  const helpers = terminalPaneSource.slice(
    terminalPaneSource.indexOf("const runSearch"),
    terminalPaneSource.indexOf("const dismissFind")
  );
  assert.ok(helpers.length > 0);
  assert.equal(helpers.includes("window.agentTerminal.write"), false,
    "searching reads this pane's own buffer; it must never send input to the PTY");
});

test("closing find clears its highlights and hands the keyboard back", () => {
  const dismiss = terminalPaneSource.slice(terminalPaneSource.indexOf("const dismissFind"));
  const body = dismiss.slice(0, dismiss.indexOf("};"));
  assert.ok(body.includes("clearDecorations()"), "the match highlights must not outlive the bar");
  assert.ok(body.includes("terminalRef.current?.focus()"), "the shell must get the keyboard back");
});

test("a backgrounded pane drops its find bar", () => {
  // Panes stay mounted while their project is open, so an inactive tab would
  // otherwise keep decorations on a buffer nobody is looking at.
  const deactivate = terminalPaneSource.slice(terminalPaneSource.indexOf("if (!active) {"));
  const body = deactivate.slice(0, deactivate.indexOf("return;"));
  assert.ok(body.includes("setFindState(closeFind);"));
  assert.ok(body.includes("clearDecorations()"));
});

test("the addon is disposed with the terminal it was loaded into", () => {
  assert.ok(terminalPaneSource.includes("searchResults.dispose();"), "the results subscription must be released");
  assert.ok(terminalPaneSource.includes("search.dispose();"), "the addon must be released with its terminal");
});

test("the terminal allows the proposed API its decorations need", () => {
  // xterm gates registerDecoration behind allowProposedApi, and the search
  // addon draws every match as a decoration - and only emits its result
  // counts when decorations are on. With the flag off the first search
  // throws, so this is a hard prerequisite of the find bar, not a
  // preference.
  assert.ok(terminalPaneSource.includes("allowProposedApi: true,"),
    "find decorations (and therefore the match count) require proposed API");
});

const stylesSource = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8"
);

const zIndexOf = (selector: string): number => {
  const rule = stylesSource.split("\n").find((line) => line.startsWith(`${selector} {`));
  assert.ok(rule, `no rule for ${selector}`);
  const match = /z-index: (\d+)/.exec(rule!);
  assert.ok(match, `${selector} has no z-index`);
  return Number(match![1]);
};

test("the find bar layers above the replay overlay and below the modals", () => {
  // The replay overlay covers the whole pane opaquely, so a find bar beneath
  // it would simply vanish while a journal replays. The link-confirm modal is
  // blocking and must stay on top of it.
  assert.ok(zIndexOf(".terminal-find-bar") > zIndexOf(".replay-overlay"),
    "a replaying pane would otherwise bury the find bar");
  assert.ok(zIndexOf(".terminal-find-bar") < zIndexOf(".modal-backdrop"),
    "a blocking modal must cover the find bar, not sit under it");
});

test("Ctrl+F is only claimed unmodified", () => {
  // Alt and Meta variants are other chords entirely; claiming them would
  // swallow keys the shell (or Windows) expects to receive.
  const handler = terminalPaneSource.slice(terminalPaneSource.indexOf("attachCustomKeyEventHandler"));
  const guard = handler.slice(handler.indexOf("if (event.ctrlKey"), handler.indexOf('event.key.toLowerCase() === "f"'));
  for (const modifier of ["!event.altKey", "!event.metaKey", "!event.shiftKey"]) {
    assert.ok(guard.includes(modifier), `Ctrl+F must not be claimed with ${modifier.slice(1)} held`);
  }
});

test("the find bar cannot be opened on a pane that is not the active tab", () => {
  // Every key in the pane goes through the handler, which returns early for
  // an inactive pane - so a background split can never grab Ctrl+F from the
  // tab the user is actually typing in.
  const handler = terminalPaneSource.slice(terminalPaneSource.indexOf("attachCustomKeyEventHandler"));
  const guard = handler.indexOf("if (!activeRef.current) return false;");
  const claim = handler.indexOf('event.key.toLowerCase() === "f"');
  assert.ok(guard >= 0 && claim > guard, "the active-pane guard must precede the find claim");
});

test("an empty query clears the highlights instead of searching for nothing", () => {
  // findNext("") matches everything; deleting the last character must drop
  // the decorations rather than light up the whole buffer.
  const body = terminalPaneSource.slice(terminalPaneSource.indexOf("const runSearch"), terminalPaneSource.indexOf("const dismissFind"));
  const emptyGuard = body.indexOf("if (!query) {");
  const firstFind = body.indexOf("search.find");
  assert.ok(emptyGuard >= 0, "runSearch must special-case an empty query");
  assert.ok(emptyGuard < firstFind, "the empty-query guard must come before any find call");
  assert.ok(body.slice(emptyGuard, firstFind).includes("clearDecorations()"));
});
