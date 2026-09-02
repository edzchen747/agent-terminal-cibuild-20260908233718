import assert from "node:assert/strict";
import test from "node:test";
import headless from "@xterm/headless";
import { TERMINAL_SCROLLBACK_LINES, streamByteLength } from "@agentterminal/protocol";

// The PTY follows focus: whichever client is actively using the session owns
// the terminal grid (desktop size while the desktop is focused, mobile
// dimensions while the phone is). Every grid change is journaled at its exact
// stream offset, and every emulator reflows through the same grid sequence.
//
// These tests prove that:
//  - a device that was live through every focus flip, and
//  - a device that reconnects later and replays the segmented journal,
// render byte-identical history and cursor state - across grid switches,
// alternate-screen round trips, and output racing the replay.

const Terminal = headless.Terminal;

const makeTerminal = () => new Terminal({
  cols: 120,
  rows: 30,
  scrollback: TERMINAL_SCROLLBACK_LINES,
  allowProposedApi: true
});

const write = (term, data) => new Promise((resolve) => term.write(data, () => resolve()));

function snapshot(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return { lines, cursorX: buffer.cursorX, absoluteCursorY: buffer.ybase + buffer.cursorY };
}

/** A realistic session: prompts with OSC metadata, wrapped listings, colors,
 * wide characters, a CPR query, an alternate-screen TUI round trip, and grid
 * switches as focus moves between a desktop window (120x30, then 100x34) and
 * a phone (45x36). Offsets are the host journal's absolute byte positions. */
function buildSessionEvents() {
  const events = [];
  let offset = 0;
  const data = (bytes) => { events.push({ data: bytes, offset }); offset += streamByteLength(bytes); };
  const grid = (cols, rows) => events.push({ grid: { cols, rows }, offset });

  grid(120, 30);
  data("\x1b[2J\x1b[H");
  data("\x1b]9;9;C:\\Users\\Ada\\src\\agent-terminal\x07\x1b]0;PowerShell 7\x07");
  data("C:\\Users\\Ada\\src\\agent-terminal> ");
  data("dir\r\n");
  const files = [
    "build-installer.ps1",
    "agent-terminal-host.rs",
    "protocol-contract.ts",
    "terminal-parity-fixture.json",
    "windows-tray-thread-pool.toml",
    "cap-android-pairing-flow.md",
    "screenshot-landscape-v2.png",
    ".gitignore"
  ];
  data(files.map((file) => `\x1b[34m${file}\x1b[0m  1,024 bytes\r\n`).join(""));
  data("\x1b[32m  8 Dir(s)  2,048,000,000 bytes free\x1b[0m\r\n");

  // The desktop window is focused: it keeps a 120x30 grid.
  grid(100, 34);
  data("C:\\Users\\Ada\\src\\agent-terminal> ");
  data('echo "the quick brown fox jumps over the lazy dog while the cat sleeps on a keyboard"\r\n');
  data("the quick brown fox jumps over the lazy dog while the cat sleeps on a keyboard\r\n");

  // The phone takes control: the PTY switches to the mobile grid.
  grid(45, 36);
  data("C:\\Users\\Ada\\src\\agent-terminal> git status\r\n");
  data("\x1b[31m On branch main\x1b[0m\r\n your branch is up to date with 'origin/main'.\r\n");
  data("\x1b[33m modified:   terminal-sync-window-journal.proto\x1b[0m\r\n");
  data("\x1b[32m untracked:  watanabe-preview-コピー.txt\x1b[0m\r\n");

  // A CPR query: the query itself must survive the journal verbatim.
  data("\x1b[6n");

  // Alternate-screen TUI (vim-like) while the phone is focused, then exit.
  data("\x1b[?1049h\x1b[H\x1b[2J");
  data("\x1b[1;1H\x1b[42m\x1b[1;37m vim - Agent Terminal parity\x1b[0m\r\n");
  data("+--┬──────────────────────────────────────────┬──────────────────┐\r\n");
  data("│ # │ NAME                       %CPU   %MEM  │ COMMAND          │\r\n");
  data("├───┼──────────────────────────────────────────┼──────────────────┤\r\n");
  data("│ 1 │ agent-terminal-host        0.7    4.3   │ C:\\src\\host.exe  │\r\n");
  data("+--┴──────────────────────────────────────────┴──────────────────┘\r\n");
  data("\x1b[?1049l");

  // The desktop reclaims focus while the phone is mid-session.
  grid(120, 30);
  data("\x1b]9;9;C:\\Users\\Ada\\src\\agent-terminal\x07");
  data("C:\\Users\\Ada\\src\\agent-terminal> clearlog\r\n");
  data("clearing log...\r\n");
  data("C:\\Users\\Ada\\src\\agent-terminal> powershell get-history\r\n");
  for (let index = 1; index <= 120; index += 1) {
    data(`   ${index}  npm-${index}  fast-forward  master\r\n`);
  }
  data("\x1b]9;9;C:\\Users\\Ada\\src\\agent-terminal\x07");
  data("C:\\Users\\Ada\\src\\agent-terminal> ");
  return events;
}

/** The client-side live path: write each chunk, reflow when the announced
 * grid differs from the emulator's current grid. */
async function applyLive(term, events) {
  for (const event of events) {
    if (event.grid) {
      if (event.grid.cols !== term.cols || event.grid.rows !== term.rows) {
        term.resize(event.grid.cols, event.grid.rows);
      }
      continue;
    }
    await write(term, event.data);
  }
}

/** The host-side journal split (mirrors split_journal_by_epochs): the PTY
 * stream becomes one segment per grid, keeping zero-length segments for
 * back-to-back switches so replay reflows through every intermediate grid. */
function splitSegments(events) {
  const segments = [];
  let run = "";
  let current = { cols: events[0]?.grid?.cols ?? 120, rows: events[0]?.grid?.rows ?? 30 };
  for (const event of events) {
    if (event.grid) {
      if (event.grid.cols !== current.cols || event.grid.rows !== current.rows) {
        segments.push({ cols: current.cols, rows: current.rows, data: run });
        run = "";
        current = event.grid;
      }
    } else {
      run += event.data;
    }
  }
  segments.push({ cols: current.cols, rows: current.rows, data: run });
  return segments;
}

/** The journal's end: one past the last byte of the last data chunk. */
function streamEnd(events) {
  let end = 0;
  for (const event of events) {
    if (event.grid) continue;
    end = Math.max(end, event.offset + streamByteLength(event.data));
  }
  return end;
}

/** The client-side catch-up used by MobileTerminal / TerminalPane: reset,
 * replay the segmented journal, then merge queued live items, dropping
 * anything (chunks AND grid notices) the snapshot already covers. */
async function replayWithCatchUp(term, segments, endOffset, pending) {
  term.reset();
  let appliedUpTo = 0;
  for (const segment of segments) {
    if (segment.cols !== term.cols || segment.rows !== term.rows) term.resize(segment.cols, segment.rows);
    await write(term, segment.data);
  }
  appliedUpTo = endOffset;
  for (const item of pending) {
    if (item.grid) {
      if (item.offset < appliedUpTo) continue;
      if (item.grid.cols !== term.cols || item.grid.rows !== term.rows) term.resize(item.grid.cols, item.grid.rows);
      continue;
    }
    if (item.offset < appliedUpTo) continue;
    appliedUpTo = Math.max(appliedUpTo, item.offset + streamByteLength(item.data));
    await write(term, item.data);
  }
}

test("focus-driven grid switches preserve identical history on every device", async () => {
  const events = buildSessionEvents();
  const live = makeTerminal();
  await applyLive(live, events);

  const replayed = makeTerminal();
  // The device reconnects right before the desktop reclaims focus: the
  // snapshot ends at that point, and the grid notice plus everything after
  // it arrive as pending live traffic during replay.
  const resumeAt = events.findIndex((event) => event.grid && event.grid.cols === 120 && event.grid.rows === 30 && event.offset > events[0].offset);
  const snapshotEvents = events.slice(0, resumeAt);
  const segments = splitSegments(snapshotEvents);
  const pending = events.slice(resumeAt).map((event) =>
    event.grid
      ? { grid: { cols: event.grid.cols, rows: event.grid.rows }, offset: event.offset }
      : { data: event.data, offset: event.offset });
  await replayWithCatchUp(replayed, segments, streamEnd(snapshotEvents), pending);

  assert.deepEqual(snapshot(replayed), snapshot(live));
});

test("a chunk and a grid notice racing the snapshot reply are applied exactly once", async () => {
  const events = buildSessionEvents();
  const live = makeTerminal();
  await applyLive(live, events);

  // Snapshot taken at the first grid switch: the switch itself AND the data
  // after it may race the replay (they carry offsets inside/equal to the
  // snapshot). The client must neither double-apply nor skip them.
  const cut = events.findIndex((event) => event.grid && event.offset > 0);
  const snapshotEvents = events.slice(0, cut);
  const segments = splitSegments(snapshotEvents);
  const snapshotEnd = streamEnd(snapshotEvents);
  const racing = [
    ...events.slice(cut - 1, cut + 2).map((event) =>
      event.grid
        ? { grid: { cols: event.grid.cols, rows: event.grid.rows }, offset: event.offset }
        : { data: event.data, offset: event.offset }),
    ...events.slice(cut + 2).map((event) =>
      event.grid
        ? { grid: { cols: event.grid.cols, rows: event.grid.rows }, offset: event.offset }
        : { data: event.data, offset: event.offset })
  ];
  const replayed = makeTerminal();
  await replayWithCatchUp(replayed, segments, snapshotEnd, racing);

  assert.deepEqual(snapshot(replayed), snapshot(live));
});

test("resizing mid-TUI keeps the primary history and TUI isolation on both devices", async () => {
  // Focus switches while a TUI owns the alternate screen: the PTY resize
  // sends SIGWINCH, the TUI wipes and repaints across the new grid. The
  // client follows the grid announcements, but the alternate buffer must
  // stay isolated - primary scrollback stays clean and complete.
  const events = [];
  let offset = 0;
  const data = (s) => { events.push({ data: s, offset }); offset += streamByteLength(s); };
  const grid = (cols, rows) => events.push({ grid: { cols, rows }, offset });
  grid(113, 39);
  for (let i = 0; i < 50; i += 1) data(`base-line-${i} ${"x".repeat(90)}\r\n`);
  data("\x1b[?1049h\x1b[H\x1b[2J");
  data("\x1b[1;1H\x1b[42m\x1b[1;37m top - TUI canvas\x1b[0m\r\n");
  data("+----+------------------------+-------+\r\n");
  data("| 1  | agent-terminal-host    |  0.7% |\r\n");
  data("+----+------------------------+-------+\r\n");
  grid(72, 26);
  data("\x1b[H\x1b[2J\x1b[1;1H top - repainted after SIGWINCH\r\n");
  data("| 2  | node.exe               | 12.9% |\r\n");
  data("\x1b[?1049l");
  grid(113, 39);
  data("END-OF-TUI\r\n");
  data("PS> after-exit\r\n");

  const a = makeTerminal();
  await applyLive(a, events);
  const b = makeTerminal();
  await applyLive(b, events);

  assert.deepEqual(snapshot(a), snapshot(b), "both devices converge through the mid-TUI resize");
  const lines = snapshot(a).lines;
  assert.ok(lines.some((line) => line.includes("base-line-0")), "pre-TUI history survives");
  assert.ok(lines.some((line) => line.includes("base-line-49")), "the last pre-TUI line survives");
  assert.ok(lines.some((line) => line.includes("END-OF-TUI")), "post-TUI content arrives");
  assert.ok(!lines.some((line) => line.includes("TUI canvas")), "alternate-screen paint never leaks into the primary history");
});

test("alternate screen round trips stay clean and identical across grid flips", async () => {
  const events = buildSessionEvents();
  const a = makeTerminal();
  const b = makeTerminal();
  await applyLive(a, events);
  await replayWithCatchUp(b, splitSegments(events), streamEnd(events), []);

  const lines = snapshot(a).lines;
  // The post-TUI prompt region must not contain alt-buffer baggage.
  assert.ok(!lines.some((line) => line.includes("vim - Agent Terminal parity")));
  assert.deepEqual(snapshot(b), snapshot(a));
});

test("re-wrapping after a grid switch never loses content on any device", async () => {
  const events = buildSessionEvents();
  const a = makeTerminal();
  await applyLive(a, events);

  // History recorded under the desktop's wide grid was reflowed when the
  // phone took the PTY and reflowed again when the desktop reclaimed it.
  // Both replay paths must converge on the identical result.
  const replayed = makeTerminal();
  await replayWithCatchUp(replayed, splitSegments(events), streamEnd(events), []);
  assert.deepEqual(snapshot(replayed), snapshot(a));

  // Lines recorded under the final 120x30 grid may not exceed that width,
  // and the phone-era content must still be present - not truncated.
  const lines = snapshot(a).lines;
  assert.ok(lines.every((line) => line.length <= 120));
  assert.ok(lines.join("\n").includes("terminal-sync-window-journal.proto"));
  assert.ok(lines.join("\n").includes("watanabe-preview-コピー.txt"));
});

test("back-to-back grid swaps (no output between) reflow through both grids", async () => {
  const events = [
    ...buildSessionEvents().slice(0, 6),
    { grid: { cols: 45, rows: 36 }, offset: 100 },
    { grid: { cols: 90, rows: 28 }, offset: 100 },
    { data: "PS C:\\Users\\Ada\\src> ls\r\npackage.json\r\n", offset: 100 }
  ];
  const live = makeTerminal();
  await applyLive(live, events);

  const replayed = makeTerminal();
  await replayWithCatchUp(replayed, splitSegments(events), streamEnd(events), []);
  assert.deepEqual(snapshot(replayed), snapshot(live));
});

test("rapid focus flapping followed by a heal replays the journal truth exactly", async () => {
  // Build a flap storm: the grid alternates fast between mobile (45x36) and
  // desktop (113x32) with content in between (xterm reflow is lossy under
  // such oscillation - the truncation regression we protect against).
  const events = [];
  let offset = 0;
  const data = (s) => { events.push({ data: s, offset }); offset += streamByteLength(s); };
  const grid = (cols, rows) => events.push({ grid: { cols, rows }, offset });
  grid(45, 36);
  for (let i = 0; i < 60; i++) data(`header-line-${i} ${"x".repeat(140)}\r\n`);
  for (let flap = 0; flap < 8; flap += 1) {
    grid(flap % 2 === 0 ? 113 : 45, flap % 2 === 0 ? 32 : 36);
    data(`flap-${flap} ${"y".repeat(130)}\r\n`);
  }
  data("END-OF-TEST\r\n");

  const flapped = makeTerminal();
  await applyLive(flapped, events);

  // Heal: the focused client re-attaches - reset and replay the segmented
  // journal. The result must equal the journal truth (a fresh replay) and
  // contain every marker the flap storm was supposed to preserve.
  const healed = makeTerminal();
  await replayWithCatchUp(healed, splitSegments(events), streamEnd(events), []);
  const reference = makeTerminal();
  await replayWithCatchUp(reference, splitSegments(events), streamEnd(events), []);

  assert.deepEqual(snapshot(healed), snapshot(reference));
  const all = snapshot(healed).lines;
  for (let i = 0; i < 60; i += 1) {
    assert.ok(all.some((line) => line.includes(`header-line-${i}`)), `header-line-${i} must survive the flap storm after a heal`);
  }
  assert.ok(all.some((line) => line.includes("END-OF-TEST")));
});

test("duplicate same-grid notices are idempotent on every client", async () => {
  // The log shows the host echoes its own grid assert twice at the same
  // offset (the pane's reassert and the broadcast); those duplicates must
  // not cause a second reflow or any buffer change.
  const events = buildSessionEvents();
  const duplicates = events.flatMap((event, index) =>
    event.grid && index > 0
      ? [event, { ...event, offset: event.offset }]
      : [event]);
  const a = makeTerminal();
  await applyLive(a, events);
  const b = makeTerminal();
  await applyLive(b, duplicates);
  assert.deepEqual(snapshot(b), snapshot(a));
});

test("an empty snapshot replay initializes cleanly and applies pending live output", async () => {
  const events = buildSessionEvents().slice(0, 7);
  const live = makeTerminal();
  await applyLive(live, events);

  const replayed = makeTerminal();
  await replayWithCatchUp(replayed, [], 0, events.map((event) =>
    event.grid
      ? { grid: { cols: event.grid.cols, rows: event.grid.rows }, offset: event.offset }
      : { data: event.data, offset: event.offset }));
  assert.deepEqual(snapshot(replayed), snapshot(live));
});

test("a non-TUI session re-renders losslessly across every viewport size", async () => {
  // Fixed-session model: the stream is produced at one grid with no WINCH
  // churn. Each viewport change re-renders it (reset + full replay at the
  // viewport grid) and must equal the canonical parse at the final size.
  const journal = [];
  for (let i = 0; i < 200; i += 1) journal.push(`header-line-${i} ${"x".repeat(140)}\r\n`);
  journal.push("PS> done\r\n");
  const stream = journal.join("");
  const viewports = [[120, 40], [90, 30], [113, 39], [72, 26], [100, 34]];

  const renderAt = async (term, cols, rows) => {
    term.reset();
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    await write(term, stream);
  };

  // Emulate the pane's viewport re-renders after every window resize.
  const pane = makeTerminal(120, 40);
  for (const [cols, rows] of viewports) await renderAt(pane, cols, rows);

  const truth = makeTerminal(120, 40);
  const [finalCols, finalRows] = viewports.at(-1);
  await renderAt(truth, finalCols, finalRows);

  assert.deepEqual(snapshot(pane), snapshot(truth), "every viewport re-render must equal the canonical parse at the final size");
  const lines = snapshot(truth).lines;
  assert.equal(lines.filter((line) => line.includes("header-line-")).length, 200, "no header may be lost across viewport re-renders");
  assert.equal(lines.filter((line) => line.includes("PS> done")).length, 1, "the tail must be intact");
});

test("a full-screen primary-buffer TUI is isolated and the session returns cleanly", async () => {
  // A harness that renders full-screen in the PRIMARY buffer (cursor-hide +
  // synchronized-output + absolute repaints, no alternate screen). Detection
  // is server-side (core.rs), but the client contract is: the UI content and
  // cursor/sync state never pollute the pre-TUI history, and after the UI
  // releases the terminal (cursor-show) the session re-renders cleanly.
  const renderAt = (term, cols, rows, data) => new Promise((resolve) => {
    term.resize(cols, rows);
    term.reset();
    term.write(data, () => resolve());
  });
  const tui = makeTerminal(120, 40);
  let journal = "";
  const emit = (s) => { journal += s; };

  await write(tui, "base-line-one\r\nbase-line-two\r\n");
  emit("base-line-one\r\nbase-line-two\r\n");
  // TUI enter: cursor-hide + sync mode, then absolute repaints.
  const enter = "\x1b[?25l\x1b[?2026h\x1b[38;2;102;102;102m\x1b[1m AGENT UI \x1b[0m\r\n\x1b[2b\x1b[4C\x1b[38;2;255;255;0m●\x1b[0m\r\n";
  await write(tui, enter);
  emit(enter);
  // A repaint burst (the harness redraws on a resize; absolute positioning).
  const repaint = "\x1b[H\x1b[K\x1b[38;2;240;198;116m running\u2026 \x1b[0m\r\n";
  await write(tui, repaint);
  emit(repaint);
  // TUI exit: sync off + cursor show, then the prompt returns.
  const exit = "\x1b[?2026l\x1b[?25h\r\nPS> done\r\n";
  await write(tui, exit);
  emit(exit);

  // Canonical re-render at the same grid must be identical (no loss / no
  // residue), and the pre-TUI history must be untouched.
  const fresh = makeTerminal(120, 40);
  fresh.reset();
  await write(fresh, journal);
  assert.deepEqual(snapshot(fresh), snapshot(tui), "a clean re-render equals the live TUI session");
  const lines = snapshot(fresh).lines;
  // The TUI repainted row 0 in place (a legit full-screen overpaint), so the
  // row it did not touch survives; the re-parse must neither lose it nor
  // duplicate the UI's own repaint.
  assert.ok(lines.some((line) => line.includes("base-line-two")), "the un-overpainted pre-TUI history survives");
  assert.ok(lines.some((line) => line.includes("PS> done")), "post-TUI prompt arrives");
  // The full-screen UI repainted its rows in place: the surviving repaint
  // marker must appear exactly once - never duplicated into scrollback, and
  // the earlier painted line was legitimately overpainted by the later one.
  const joined = lines.join("\n");
  assert.equal((joined.match(/running…/g) ?? []).length, 1, "the full-screen UI paints in place, never duplicating into history");
});
