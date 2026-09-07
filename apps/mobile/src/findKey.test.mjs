import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUtilityKeyPad } from "./utilityKeys.ts";
import { UTILITY_KEY_ROW_ONE_KEY_COUNT, UTILITY_KEY_ROW_TWO_KEY_COUNT, utilityKeyRowsFit, utilityKeyRowMinWidth } from "./utilityKeyLayout.ts";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const terminal = readFileSync(join(SRC_DIR, "MobileTerminal.tsx"), "utf8");

const FIND_KEY = { id: "find", label: "\u{1F50D} Find" };

test("the find key replaced the tilde key without changing the row's width budget", () => {
  assert.ok(terminal.includes('{ id: "find", label: "\u{1F50D} Find" }'), "row one must carry the find key");
  assert.equal(terminal.includes('id: "tilde"'), false, "the tilde key it replaced must be gone");
  // A replacement, not an addition: the layout math is driven by these
  // counts, and an extra key would push row one past what a narrow phone
  // fits (utilityKeyRowsFit gates the whole bar).
  const rowOne = terminal.slice(terminal.indexOf("ACCESSIBILITY_KEY_ROWS"), terminal.indexOf('{ id: "page-up"'));
  assert.equal(rowOne.match(/\{ id: "/g).length, UTILITY_KEY_ROW_ONE_KEY_COUNT);
  // Row two is what utilityKeyRowsFit gates the bar on, so row one must stay
  // within its budget - which it does only as long as it is not grown.
  assert.ok(utilityKeyRowMinWidth(UTILITY_KEY_ROW_ONE_KEY_COUNT) <= utilityKeyRowMinWidth(UTILITY_KEY_ROW_TWO_KEY_COUNT));
  assert.ok(utilityKeyRowsFit(utilityKeyRowMinWidth(UTILITY_KEY_ROW_TWO_KEY_COUNT)));
});

test("the find key carries no value, so it can never type into the shell", () => {
  // Its entry has no `value`, and the pad returns no data for a key without
  // one - so even if a press did reach the pad (the component short-circuits
  // first), nothing would be sent to the host.
  assert.equal(FIND_KEY.value, undefined);
  const pad = createUtilityKeyPad();
  assert.equal(pad.press(FIND_KEY).data, null);
  assert.equal(pad.release(FIND_KEY.id).data, null);
});

test("the find key is an action, so it never disturbs an armed modifier", () => {
  // The component returns before touching the pad. A latched Ctrl must
  // therefore still be armed after a find press, ready for the next real
  // key - unlike a value key, which fires the chord and clears the latch.
  const pad = createUtilityKeyPad();
  const ctrl = { id: "ctrl", label: "Ctrl", modifier: "ctrl" };
  pad.press(ctrl);
  pad.release("ctrl");
  assert.deepEqual(pad.state().latched, ["ctrl"], "a tap latches Ctrl");
  const press = terminal.slice(terminal.indexOf("function pressAccessibilityKey"));
  assert.ok(press.includes('if (key.id === "find") {'), "the press handler must short-circuit before the pad");
  assert.ok(press.slice(0, press.indexOf("keyPadRef.current!.press")).includes("toggleFind();"),
    "the short-circuit must come before the pad ever sees the key");
  // The chord still belongs to whatever real key is pressed next, which is
  // what finally consumes the latch.
  assert.equal(pad.press({ id: "pipe", label: "|", value: "|" }).data, "|");
  assert.deepEqual(pad.state().latched, [], "the next real key consumes the latch");
});

test("find never sends anything to the host and closes back to a quiet keyboard", () => {
  // Search runs on this phone's own xterm buffer. Nothing about it is a
  // session.input or any other host message.
  const helpers = terminal.slice(terminal.indexOf("const runSearch"), terminal.indexOf("useLayoutEffect(", terminal.indexOf("const runSearch")));
  assert.equal(helpers.includes("connection.send"), false, "find must never reach the host connection");
  assert.equal(helpers.includes("sendKeyData"), false, "find must never reach the input path");
  assert.ok(helpers.includes("searchRef.current?.clearDecorations();"), "closing must drop the highlights");
  // Dismissing a search must not leave the terminal's soft keyboard popped
  // over the output the user came back to read.
  assert.ok(helpers.includes('explicitInput: false'), "closing find returns to the cursor-only focus state");
});

test("the find bar sits outside the squished terminal box", () => {
  // .mobile-terminal carries the scaleX squish; a bar rendered inside it
  // would have its text and controls stretched along with the cells.
  const shell = terminal.slice(terminal.indexOf('className="mobile-terminal-shell"'));
  const bar = shell.indexOf('className="terminal-find-bar"');
  const squished = shell.indexOf("transform: `scaleX(");
  assert.ok(bar > 0 && squished > 0);
  assert.ok(bar > squished, "the find bar must be a sibling that follows the squished terminal div, not a child of it");
  assert.ok(shell.slice(bar - 200, bar).includes("findState.open &&"));
});

test("the terminal allows the proposed API its decorations need", () => {
  // xterm gates registerDecoration behind allowProposedApi, and the search
  // addon draws every match as a decoration - and only emits its result
  // counts when decorations are on. With the flag off the first search
  // throws, so this is a hard prerequisite of the find bar, not a
  // preference.
  assert.ok(terminal.includes("allowProposedApi: true,"),
    "find decorations (and therefore the match count) require proposed API");
});

const styles = readFileSync(join(SRC_DIR, "styles.css"), "utf8");

const zIndexOf = (selector) => {
  const rule = styles.split("\n").find((line) => line.startsWith(`${selector} {`));
  assert.ok(rule, `no rule for ${selector}`);
  const match = /z-index: (\d+)/.exec(rule);
  assert.ok(match, `${selector} has no z-index`);
  return Number(match[1]);
};

test("the find bar layers under the sheets that block it", () => {
  // A bottom sheet (settings, folder picker) is modal; the find bar must not
  // float over one.
  assert.ok(zIndexOf(".terminal-find-bar") < zIndexOf(".sheet-backdrop"),
    "an open sheet must cover the find bar");
});

test("the find bar opts out of the pager swipe", () => {
  // Without data-no-swipe a horizontal drag inside the query field pages the
  // whole view away mid-search, exactly as it would on the key rows.
  const bar = terminal.slice(terminal.indexOf('className="terminal-find-bar"'));
  assert.ok(bar.slice(0, bar.indexOf(">")).includes("data-no-swipe"));
});

test("an empty query clears the highlights instead of searching for nothing", () => {
  // findNext("") matches everything; clearing the field must drop the
  // decorations rather than light up the whole buffer.
  const body = terminal.slice(terminal.indexOf("const runSearch"), terminal.indexOf("const dismissFind"));
  const emptyGuard = body.indexOf("if (!query) {");
  const firstFind = body.indexOf("search.find");
  assert.ok(emptyGuard >= 0, "runSearch must special-case an empty query");
  assert.ok(emptyGuard < firstFind, "the empty-query guard must come before any find call");
  assert.ok(body.slice(emptyGuard, firstFind).includes("clearDecorations()"));
});

test("the find key cannot fire on a backgrounded terminal", () => {
  // The pager keeps every session's terminal mounted, so a key press must
  // still be gated on this one being the active view - the find branch sits
  // after that guard, not before it.
  const press = terminal.slice(terminal.indexOf("function pressAccessibilityKey"));
  const guard = press.indexOf("if (!activeRef.current) return;");
  const findBranch = press.indexOf('if (key.id === "find")');
  assert.ok(guard >= 0 && findBranch > guard, "the active guard must precede the find branch");
});

test("the find key is the only value-less key in the rows", () => {
  // Every other utility key sends something; a second action key would need
  // its own branch in pressAccessibilityKey or it would silently do nothing.
  const rows = terminal.slice(terminal.indexOf("ACCESSIBILITY_KEY_ROWS"), terminal.indexOf("export function MobileTerminal"));
  const entries = rows.match(/\{ id: "[^"]+", label: "[^"]*"[^}]*\}/g) ?? [];
  const actionKeys = entries.filter((entry) => !entry.includes("value:") && !entry.includes("modifier:"));
  assert.deepEqual(actionKeys.map((entry) => /id: "([^"]+)"/.exec(entry)[1]), ["find"]);
});
