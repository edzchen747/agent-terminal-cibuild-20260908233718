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
