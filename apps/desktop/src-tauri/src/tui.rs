//! TUI mode classification for the shared PTY stream.
//!
//! The host classifies the running foreground program into grid-ownership
//! modes (see `TuiMode`). Only definitive program announcements move the
//! period off `Canonical`, and each commits immediately on the program's
//! own VT sequence. The signals are split by *how much of the grid* the
//! program is claiming, because that is what decides whether the host may
//! wrap the period in a synthetic alt-screen pair:
//!
//! `Fullscreen` - the program owns the whole grid, so its frames may be
//! isolated from client scrollback:
//!
//! - the program's own alt-screen entry (`CSI ?1049/1047/1048 h`);
//! - DECSTBM (scroll-region set) plus drawing on two or more rows.
//!
//! `Inline` - the program is a TUI (it owns the grid size and raw key
//! input) but draws on the primary buffer, keeping its own scrollback:
//!
//! - sync output (`CSI ?2026 h`);
//! - mouse/focus tracking (`CSI ?1000/1002/1003/1005/1006/1015 h`);
//! - kitty keyboard flags / modifyOtherKeys (`CSI > n u`, `CSI = n u`,
//!   `CSI > 4 ; n m`, `CSI 4 ; n m`).
//!
//! None of those three says anything about *where* the program draws:
//! an agent harness prints a scrolling transcript on the primary buffer
//! and repaints only a bottom composer band, and it announces itself
//! with exactly these sequences. Treating them as `Fullscreen` made the
//! host inject `[?1049h`, which put every frame on a blank alt
//! screen: the transcript above the composer disappeared and only the
//! bottom band was ever painted. A period only ever *rises*
//! (`Canonical` < `Inline` < `Fullscreen`), so a harness that later
//! sets a scroll region is promoted without restarting the period.
//!
//! There is no strong-signal confirmation window: a signal either commits
//! immediately or is not evidence. The removed signal families (ED-based
//! multi-row draws, cursor-hide durations, bottom-to-top CUP rewinds,
//! probe bursts, weak-signal accumulation, CUU+clear inline repaints)
//! all fire on patterns PSReadLine's Clear-Host, prompt redraws, and
//! startup burst are indistinguishable from: the host used to wrap shell
//! clears in synthetic alt pairs, and every client split the clear
//! across two buffers (the prompt vanished twice, stale output
//! resurfaced). The shell's `clear` (ED2/ED3 + home-CUP) stays
//! deliberately not evidence, as do focus-event reporting
//! (`CSI ?1004 h` - PSReadLine enables it at startup and the
//! `[I`/`[O` focus events are not TUI behavior) and bare
//! two-byte DECKPAM/DECPAM (`ESC =` / `ESC >`, only meaningful as the
//! intro of a kitty keyboard-flags sequence).
//!
//! Exits: a quiet stream with an observed alt-exit + visible cursor
//! (`alt-exit`), a quiet newline-terminated prompt (`exit-quiet`), or an
//! OSC 133 shell marker (`osc133`). The OSC 133 exit only counts
//! *outside* a synchronized-output bracket: the markers are ground truth
//! for "the shell owns the foreground again" only when the shell emitted
//! them, and an inline harness marks its own composer with the same
//! `OSC 133 ; A/B/C` inside the `?2026h`/`?2026l` pair that draws the
//! frame. Counting those exited the period once per frame, which flapped
//! the mode (and, with the alt wrap, the buffer) at repaint rate.
//!
//! Whole-screen clears (`CSI 2 J` / `CSI 3 J`) are not TUI evidence,
//! but they are journal-history boundaries: [`feed`] records where a
//! clear started in the chunk and the host drains the replay journal
//! at that point, so synced devices never reflow content the program
//! already erased. See [`TuiClassifier::take_chunk_clear`].
//!
//! [`feed`]: TuiClassifier::feed

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::models::TuiMode;

/// Alt-anchored exit requires the stream to have been quiet this long
/// with a visible cursor.
pub const ALT_EXIT_QUIET_MS: u64 = 300;
/// Stream-anchored exit: newline-terminated output plus this much quiet
/// means the foreground is back at a shell prompt.
pub const STREAM_EXIT_QUIET_MS: u64 = 500;

/// A mode transition the classifier observed, with the evidence the host
/// needs for its journaling rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TuiTransition {
    pub to: TuiMode,
    /// While entering fullscreen, whether the enter was the program's own
    /// alt-screen sequence. The host only injects a synthetic
    /// `\x1b[?1049h` when the program did not send one itself.
    pub via_alt_enter: bool,
    /// While leaving a TUI mode, whether the program's own alt-screen
    /// exit sequence was observed during this period. The host only
    /// injects the matching synthetic `\x1b[?1049l` when it injected
    /// the enter half and the program never sent its own exit.
    pub program_alt_exit: bool,
    /// The classifier rule that fired, for the sync debug log
    /// (`[mode] session=... mode=... reason=...`): e.g. `alt-enter`,
    /// `sync-output`, `stbm-draw`, `alt-exit`, `exit-quiet`, `osc133`.
    pub reason: &'static str,
    /// Byte index into the chunk just fed where the triggering sequence
    /// started, so the host splices its synthetic alt-screen bytes at
    /// the boundary the transition actually happened on. Prepending
    /// them to the whole chunk swallowed any pre-transition output in
    /// the same chunk into the alt screen. A signal that started in a
    /// previous chunk (a split sequence) reports 0.
    pub at: usize,
}

pub struct TuiClassifier {
    mode: TuiMode,
    /// Trailing bytes of an incomplete ESC/CSI/OSC sequence so a split
    /// sequence bridges chunk boundaries.
    tail: String,
    cursor_hidden: bool,
    /// Approximate cursor row (1-based, clamped to the grid).
    cursor_row: u16,
    /// The current row was entered by an absolute CUP rather than by
    /// scrolling (newline) or relative motion. TUI frames are drawn
    /// with absolute addressing; shell output scrolls.
    cup_entered_row: bool,
    /// The most recent chunk whose *visible* tail (escapes stripped)
    /// ended with a newline: line editing, not a TUI repaint.
    last_newline_chunk_at: Option<Instant>,
    last_chunk_at: Option<Instant>,
    /// The program entered the alt screen itself (not a synthetic
    /// injection): the exit is anchored to the matching alt-exit
    /// sequence, not to stream quiet.
    alt_anchored: bool,
    /// An alt-exit sequence was seen since the TUI period started.
    saw_alt_exit: bool,
    /// The program's own alt screen is currently open: it entered via
    /// its own `?1049h` and has not yet sent the matching `?1049l`.
    /// TUI paint evidence is only counted while this is set, so the
    /// shell's post-alt main-screen redraws cannot be mistaken for TUI
    /// frames.
    alt_open: bool,
    /// DECSTBM was set during the current alt screen; with any drawing
    /// it is a definitive fullscreen signal.
    stbm: bool,
    /// Open `CSI ?2026 h` brackets. A program's frame is drawn inside
    /// one, so anything observed at depth > 0 is the program painting,
    /// not the shell - which is what disqualifies an OSC 133 marker
    /// from ending the period.
    sync_depth: u16,
    /// Distinct rows that received text, for the whole foreground
    /// period (the draw-extent measurement behind `stbm-draw`).
    extent_rows: Vec<bool>,
    /// (row, time) of rows that first received text while the cursor
    /// was hidden and the row was CUP-addressed, scoped to the program's
    /// own alt screen (paint evidence for the grid-suppression release).
    row_stamps: VecDeque<(u16, Instant)>,
    /// Byte index into the chunk fed last where a whole-screen clear
    /// (`CSI 2 J` / `CSI 3 J`) started, reported to the host so it can
    /// truncate the replay journal at the boundary.
    clear_marker: Option<usize>,
}

impl TuiClassifier {
    pub fn new(rows: u16) -> Self {
        Self {
            mode: TuiMode::Canonical,
            tail: String::new(),
            cursor_hidden: false,
            cursor_row: 1,
            cup_entered_row: false,
            last_newline_chunk_at: None,
            last_chunk_at: None,
            alt_anchored: false,
            saw_alt_exit: false,
            alt_open: false,
            stbm: false,
            sync_depth: 0,
            extent_rows: vec![false; rows.max(1) as usize + 1],
            row_stamps: VecDeque::new(),
            clear_marker: None,
        }
    }

    pub fn mode(&self) -> TuiMode {
        self.mode
    }

    /// The index into the chunk most recently fed where a whole-screen
    /// clear (`CSI 2 J` / `CSI 3 J`) started, consumed once by the host
    /// to truncate the replay journal at that sequence boundary. Clears
    /// split across chunk boundaries are not reported: the sequence
    /// start sits in an earlier chunk, which cannot anchor a cut.
    pub fn take_chunk_clear(&mut self) -> Option<usize> {
        self.clear_marker.take()
    }

    /// Whether the program has painted TUI frames while its own alt
    /// screen is open: DECSTBM, or an absolute-addressed write past
    /// row 1 under a hidden cursor. The evidence is scoped to the alt
    /// screen (`alt_open`): after the program's `?1049l` it is back on
    /// the main screen, where PSReadLine's own prompt and listing
    /// redraws CUP across many rows (hidden or visible) and must not
    /// count as TUI frames. Shell alt-screen cycles (PSReadLine's
    /// Clear-Host) paint only the prompt on row 1 of the alt screen -
    /// no DECSTBM, no hidden writes past row 1 - so they never
    /// produce evidence.
    pub fn has_paint_evidence(&self) -> bool {
        self.alt_open && (self.stbm || self.row_stamps.iter().any(|(row, _)| *row > 1))
    }

    /// While a shell alt-screen cycle is in progress the grid must not
    /// move: the program entered the alt screen itself (the shell's
    /// Clear-Host) but has not painted a TUI frame, and a SIGWINCH
    /// mid-shell-state desyncs PSReadLine's prompt-row tracking. A
    /// bare alt cycle never produces paint evidence, so its grid stays
    /// put; a real alt-screen TUI releases the suppression on its
    /// first painted frame.
    pub fn grid_change_suppressed(&self) -> bool {
        self.mode == TuiMode::Fullscreen
            && self.alt_anchored
            && !self.has_paint_evidence()
    }

    /// Feed one PTY output chunk. Returns a mode transition, if this
    /// chunk crossed a boundary. `rows` is the PTY's current height and
    /// `now` the chunk's arrival time.
    pub fn feed(&mut self, data: &str, now: Instant, rows: u16) -> Option<TuiTransition> {
        let gap = self.last_chunk_at.map(|at| now.duration_since(at));
        // Exit evaluation uses the previous chunks' state: the quiet
        // windows refer to what has already happened.
        if self.mode != TuiMode::Canonical {
            let quiet_ms = gap.map(|g| g.as_millis() as u64).unwrap_or(0);
            let visible = !self.cursor_hidden;
            let alt_exit_ok = self.saw_alt_exit && visible && quiet_ms >= ALT_EXIT_QUIET_MS;
            // The quiet gap is preceded by line-terminated output: the
            // last output chunk, or one within the quiet window, ended a
            // line the way shell output does. A colored prompt ("PS C:\>
            // " after a "\r\n") still counts because the newline chunk
            // is recent.
            let newline_recent = self.last_newline_chunk_at.is_some_and(|at| {
                self.last_chunk_at
                    .is_some_and(|last| last.duration_since(at) <= Duration::from_millis(STREAM_EXIT_QUIET_MS))
            });
            let stream_exit_ok = visible && newline_recent && quiet_ms >= STREAM_EXIT_QUIET_MS;
            if self.alt_anchored && alt_exit_ok {
                return self.exit_to_canonical("alt-exit", 0);
            }
            if !self.alt_anchored && stream_exit_ok {
                return self.exit_to_canonical("exit-quiet", 0);
            }
        }

        // Bridge a split sequence from the previous chunk.
        let tail_len = self.tail.len();
        let mut input = self.tail.clone();
        input.push_str(data);
        self.tail.clear();
        self.clear_marker = None;

        // The net effect of the chunk is what the host acts on, so a
        // reported transition is measured against the mode the chunk
        // started in.
        let mode_before = self.mode;
        let mut transition: Option<TuiTransition> = None;
        let mut last_visible: Option<u8> = None;
        let mut i = 0;
        while i < input.len() {
            let byte = input.as_bytes()[i];
            if byte != 0x1b {
                if byte == b'\n' || byte == b'\r' || !byte.is_ascii_control() {
                    last_visible = Some(byte);
                }
                let at = i.saturating_sub(tail_len);
                if let Some(t) = self.on_plain_byte(byte, now, rows, at) {
                    transition = Some(t);
                }
                i += 1;
                continue;
            }
            i += 1;
            if i >= input.len() {
                // A lone ESC at the chunk end may start a split
                // sequence.
                self.tail.push('\u{1b}');
                break;
            }
            let intro = input.as_bytes()[i];
            match intro {
                b'[' | b'=' | b'>' | b'<' => {
                    // The ESC immediately precedes the intro byte; the
                    // marker is anchored to the ESC so the host's journal
                    // cut starts at a sequence boundary.
                    let esc_at = i - 1;
                    match self.scan_csi(&input, &mut i) {
                        CsiOutcome::Complete(signal) => {
                            // A whole-screen clear is a history boundary:
                            // report its chunk index (only when the
                            // sequence start is inside this chunk; a
                            // split clear cannot anchor a journal cut).
                            if matches!(signal, CsiSignal::EraseDisplay23) && esc_at >= tail_len {
                                self.clear_marker = Some(esc_at - tail_len);
                            }
                            // Apply the signal's state updates even when a
                            // transition already fired in this chunk, and
                            // keep the LAST one: a chunk can rise
                            // (Inline, then Fullscreen) or round-trip, and
                            // only the net result is actionable.
                            let at = esc_at.saturating_sub(tail_len);
                            let t = self.on_csi(signal, now, rows, at);
                            if t.is_some() {
                                transition = t;
                            }
                        }
                        CsiOutcome::Split { keep_from } => {
                            self.tail.push_str(&input[keep_from..]);
                            i = input.len();
                        }
                    }
                }
                b']' => {
                    let esc_at = i - 1;
                    match self.scan_osc(&input, &mut i) {
                        OscOutcome::Complete(payload) => {
                            let t = self.on_osc(&payload, esc_at.saturating_sub(tail_len));
                            if t.is_some() {
                                transition = t;
                            }
                        }
                        OscOutcome::Split { keep_from } => {
                            self.tail.push_str(&input[keep_from..]);
                            i = input.len();
                        }
                    }
                }
                _ => {
                    // ESC c, bare ESC, or any other two-byte escape: no
                    // signal.
                    i += 1;
                }
            }
        }
        // Line-termination is judged on visible text: a chunk that ends
        // in escapes still counts when its last visible byte is a
        // newline.
        if last_visible == Some(b'\n') {
            self.last_newline_chunk_at = Some(now);
        }
        self.last_chunk_at = Some(now);
        if self.mode == TuiMode::Canonical
            && last_visible == Some(b'\n')
            && gap.is_some_and(|g| g >= Duration::from_millis(STREAM_EXIT_QUIET_MS))
        {
            // A quiet, line-terminated gap in canonical mode is the
            // shell prompt: the next foreground period starts a fresh
            // draw-extent measurement.
            self.extent_rows.fill(false);
            self.row_stamps.clear();
        }
        // A chunk that entered and left a period in the same chunk moved
        // nothing the host can act on. Reporting only its first half (the
        // old first-wins rule) desynced the host's synthetic alt-screen
        // bookkeeping: an inline harness carries `?2026h` and an OSC 133
        // marker in one chunk, so the enter was reported and the exit
        // swallowed, and one ten-second session journaled 28 injected
        // `\x1b[?1049h` against 10 `\x1b[?1049l`.
        match transition {
            Some(t) if self.mode != mode_before => Some(t),
            _ => None,
        }
    }

    fn exit_to_canonical(&mut self, reason: &'static str, at: usize) -> Option<TuiTransition> {
        let program_alt_exit = self.saw_alt_exit;
        self.mode = TuiMode::Canonical;
        self.saw_alt_exit = false;
        self.alt_anchored = false;
        self.alt_open = false;
        self.stbm = false;
        self.sync_depth = 0;
        self.row_stamps.clear();
        self.extent_rows.fill(false);
        Some(TuiTransition {
            to: TuiMode::Canonical,
            via_alt_enter: false,
            program_alt_exit,
            reason,
            at,
        })
    }

    /// Definitive signals commit immediately on the program's own
    /// announcement sequence. `to` is the mode the signal actually
    /// proves: `Fullscreen` only for programs that own the whole grid
    /// (their own alt screen, or a scroll region plus drawing),
    /// `Inline` for the announcements that prove a TUI without proving
    /// where it draws. Modes are ordered `Canonical` < `Inline` <
    /// `Fullscreen` and a period only ever rises, so a harness that
    /// starts inline and later sets a scroll region is promoted in
    /// place rather than restarting the period.
    fn commit_definitive(
        &mut self,
        now: Instant,
        rows: u16,
        to: TuiMode,
        via_alt: bool,
        reason: &'static str,
        at: usize,
    ) -> Option<TuiTransition> {
        if to <= self.mode {
            return None;
        }
        let transition = self.commit_enter(to, now, rows, via_alt, reason, at)?;
        // The program's own alt-screen enter anchors the matching exit
        // to the alt-exit sequence, not to stream quiet.
        if via_alt {
            self.alt_anchored = true;
        }
        Some(transition)
    }

    fn commit_enter(
        &mut self,
        to: TuiMode,
        _now: Instant,
        rows: u16,
        via_alt_enter: bool,
        reason: &'static str,
        at: usize,
    ) -> Option<TuiTransition> {
        if self.mode == to {
            return None;
        }
        // Only leaving Canonical starts a new foreground period. A
        // promotion within one (Inline -> Fullscreen) must keep the
        // evidence that triggered it: `stbm-draw` fires on the DECSTBM
        // flag plus the measured draw extent, and clearing them here
        // would erase the paint evidence the grid-suppression release
        // reads back.
        if self.mode == TuiMode::Canonical {
            self.saw_alt_exit = false;
            self.stbm = false;
            self.row_stamps.clear();
            self.extent_rows = vec![false; rows.max(1) as usize + 1];
        }
        self.mode = to;
        Some(TuiTransition {
            to,
            via_alt_enter,
            program_alt_exit: false,
            reason,
            at,
        })
    }

    fn on_csi(
        &mut self,
        signal: CsiSignal,
        now: Instant,
        rows: u16,
        at: usize,
    ) -> Option<TuiTransition> {
        use CsiSignal::*;
        match signal {
            AltEnter => {
                self.saw_alt_exit = false;
                self.alt_open = true;
                self.commit_definitive(now, rows, TuiMode::Fullscreen, true, "alt-enter", at)
            }
            AltExit => {
                self.saw_alt_exit = true;
                self.alt_open = false;
                None
            }
            CursorHidden => {
                self.cursor_hidden = true;
                None
            }
            CursorVisible => {
                self.cursor_hidden = false;
                None
            }
            // Sync output, mouse tracking and kitty keyboard flags each
            // prove a TUI - the program drives the grid size and reads
            // raw keys - but none of them says the program owns the
            // whole grid. An agent harness announces itself with exactly
            // these while printing a scrolling transcript on the primary
            // buffer and repainting only a bottom composer band, so
            // wrapping the period in a synthetic alt screen threw the
            // transcript away and left the composer alone on a blank
            // screen. They enter `Inline`, which claims the grid without
            // touching the buffer.
            SyncOutput => {
                self.sync_depth = self.sync_depth.saturating_add(1);
                self.commit_definitive(now, rows, TuiMode::Inline, false, "sync-output", at)
            }
            SyncEnd => {
                self.sync_depth = self.sync_depth.saturating_sub(1);
                None
            }
            MouseOrFocus => {
                self.commit_definitive(now, rows, TuiMode::Inline, false, "mouse-focus", at)
            }
            KittyKeyboard => {
                self.commit_definitive(now, rows, TuiMode::Inline, false, "kitty-keyboard", at)
            }
            // A scroll region plus drawing IS whole-grid ownership: the
            // program has taken over the scrolling the primary buffer
            // would otherwise do, so its frames are safe to isolate.
            Decstbm => {
                self.stbm = true;
                if self.distinct_extent(rows) >= 2 {
                    self.commit_definitive(now, rows, TuiMode::Fullscreen, false, "stbm-draw", at)
                } else {
                    None
                }
            }
            CursorUp(n) => {
                self.cursor_row = self.cursor_row.saturating_sub(n).max(1);
                self.cup_entered_row = false;
                None
            }
            CursorPosition { row } => {
                let target = row.clamp(1, rows.max(1));
                self.cursor_row = target;
                self.cup_entered_row = true;
                None
            }
            // ED2/ED3 is never TUI evidence (the shell's `clear`), but
            // the feed loop reposts it as a journal-history boundary.
            EraseDisplay23 => None,
            NoSignal => None,
        }
    }

    fn on_osc(&mut self, payload: &str, at: usize) -> Option<TuiTransition> {
        // OSC 133 shell-integration markers are ground truth that the
        // shell owns the foreground again - but only when the shell is
        // what emitted them. Inside a synchronized-output bracket the
        // marker is part of a frame the foreground program is painting:
        // an inline harness brackets each repaint with `?2026h`/`?2026l`
        // and marks its own composer with `OSC 133 ; A/B/C`. Counting
        // those ended the period once per frame, so the mode flapped at
        // repaint rate and every frame swapped the client's buffer.
        if let Some(code) = payload.strip_prefix("133;") {
            if self.sync_depth > 0 {
                return None;
            }
            let marker = code.chars().next().unwrap_or('\0');
            if matches!(marker, 'A' | 'B' | 'C' | 'D') && self.mode != TuiMode::Canonical {
                return self.exit_to_canonical("osc133", at);
            }
            return None;
        }
        None
    }

    fn on_plain_byte(
        &mut self,
        byte: u8,
        now: Instant,
        rows: u16,
        at: usize,
    ) -> Option<TuiTransition> {
        if byte == b'\n' {
            self.cursor_row = (self.cursor_row + 1).min(rows.max(1));
            // The new row was reached by scrolling, not addressing.
            self.cup_entered_row = false;
            return None;
        }
        if byte.is_ascii_control() {
            return None;
        }
        // Printable text lands on the tracked row; record the draw
        // extent for the DECSTBM paint rule.
        let row = self.cursor_row as usize;
        if row < self.extent_rows.len() && !self.extent_rows[row] {
            self.extent_rows[row] = true;
            // TUI frames are drawn flicker-free: cursor hidden, rows
            // entered by absolute CUP. Shell listings scroll with the
            // cursor visible, so they stamp nothing here; the paint
            // evidence gate releases the grid-suppression hold on a
            // real alt-screen TUI's first frame.
            if self.cursor_hidden && self.cup_entered_row {
                self.row_stamps.push_back((self.cursor_row, now));
            }
        }
        // DECSTBM plus any drawing is a definitive fullscreen paint.
        // The transition is returned, not dropped: swallowing it here
        // moved the classifier's mode without telling the host, which
        // then never injected the alt pair the mode implies.
        if self.stbm && self.distinct_extent(rows) >= 2 {
            return self.commit_definitive(now, rows, TuiMode::Fullscreen, false, "stbm-draw", at);
        }
        None
    }

    fn distinct_extent(&self, rows: u16) -> usize {
        let end = (rows as usize + 1).min(self.extent_rows.len());
        self.extent_rows[1..end].iter().filter(|&&written| written).count()
    }

    /// Parse one CSI sequence: `*i` points at the intro byte (`[`, `=`,
    /// `>`, or `<`). On `Complete` it is left just past the final byte;
    /// on `Split` the caller keeps `input[keep_from..]` (from the ESC)
    /// for the next chunk.
    fn scan_csi(&self, input: &str, i: &mut usize) -> CsiOutcome {
        let bytes = input.as_bytes();
        let open = *i; // index of the intro byte; the ESC is just before
        *i += 1;
        let intro_marker = match input.as_bytes()[open] {
            b'=' | b'>' | b'<' => true,
            _ => false,
        };
        let mut private = false;
        let mut intermediate: u8 = 0;
        let mut groups: [u32; 4] = [0; 4];
        let mut group_count = 0;
        let mut current: u32 = 0;
        while *i < bytes.len() {
            let b = bytes[*i];
            if (b'0'..=b'9').contains(&b) {
                current = current.saturating_mul(10).saturating_add((b - b'0') as u32);
                *i += 1;
                continue;
            }
            if b == b';' {
                if group_count < 4 {
                    groups[group_count] = current;
                    group_count += 1;
                }
                current = 0;
                *i += 1;
                continue;
            }
            if (0x20..=0x3f).contains(&b) {
                // Parameter-section bytes: intermediates and private
                // markers ('?', ':', '$', ...).
                if b == b'?' {
                    private = true;
                } else {
                    intermediate = b;
                }
                *i += 1;
                continue;
            }
            // Final byte: dispatch.
            if group_count < 4 {
                groups[group_count] = current;
                group_count += 1;
            }
            *i += 1;
            return CsiOutcome::Complete(self.classify_csi(
                b,
                private,
                intermediate,
                intro_marker,
                &groups[..group_count],
            ));
        }
        CsiOutcome::Split {
            keep_from: open - 1, // include the ESC
        }
    }

    fn classify_csi(
        &self,
        final_byte: u8,
        private: bool,
        intermediate: u8,
        intro_marker: bool,
        groups: &[u32],
    ) -> CsiSignal {
        use CsiSignal::*;
        let value = groups.last().copied().unwrap_or(0);
        let first = groups.first().copied().unwrap_or(0);
        if private {
            match final_byte {
                b'h' => match value {
                    1049 | 1047 | 1048 => AltEnter,
                    25 => CursorVisible,
                    2026 => SyncOutput,
                    1000 | 1002 | 1003 | 1005 | 1006 | 1015 => MouseOrFocus,
                    // Focus-event reporting (PSReadLine enables it at
                    // startup) and bracketed paste (`?2004h`) are not
                    // TUI evidence.
                    1004 | 2004 | 1 => NoSignal,
                    _ => NoSignal,
                },
                b'l' => match value {
                    1049 | 1047 | 1048 => AltExit,
                    25 => CursorHidden,
                    2026 => SyncEnd,
                    _ => NoSignal,
                },
                b'u' => KittyKeyboard, // kitty keyboard flags: CSI > n u
                b'm' if groups.len() >= 2 && first == 4 => KittyKeyboard, // modifyOtherKeys: CSI > 4 ; n m
                _ => NoSignal,
            }
        } else {
            match final_byte {
                b'l' => {
                    if value == 47 {
                        AltExit
                    } else {
                        NoSignal
                    }
                }
                b'h' => {
                    if groups.is_empty() {
                        // Bare CSI H is CUP home, not a public DECSET.
                        CursorPosition { row: 1 }
                    } else {
                        NoSignal
                    }
                }
                b'A' => CursorUp(if groups.is_empty() { 1 } else { value as u16 }),
                b'J' => {
                    // ED2 (screen) / ED3 (scrollback): a whole-screen
                    // clear, journaled as a history boundary. ED0/ED1
                    // clear a region and are not.
                    match value {
                        2 | 3 => EraseDisplay23,
                        _ => NoSignal,
                    }
                }
                b'H' | b'f' => {
                    // CUP: CSI row;col H / f. One parameter is the
                    // column only (row 1); none means home.
                    let row = if groups.len() >= 2 {
                        first.max(1).min(u16::MAX as u32) as u16
                    } else {
                        1
                    };
                    CursorPosition { row }
                }
                b'd' => CursorPosition {
                    row: if groups.is_empty() { 1 } else { value.max(1).min(u16::MAX as u32) as u16 },
                },
                b'G' => NoSignal, // column movement only
                b'r' => Decstbm,
                // Kitty keyboard flags: CSI > n u / CSI = n u. The intro
                // marker covers the two-byte ESC = / ESC > forms; the `>`
                // / `=` parameter-section byte covers the CSI forms. The
                // public modifyOtherKeys form (CSI 4 ; n m) below is
                // definitive on its own.
                b'u' => {
                    if intro_marker || intermediate == b'>' || intermediate == b'=' {
                        KittyKeyboard
                    } else {
                        NoSignal
                    }
                }
                b'm' => {
                    if groups.len() >= 2 && first == 4 {
                        // modifyOtherKeys, xterm public form.
                        KittyKeyboard
                    } else {
                        NoSignal
                    }
                }
                _ => NoSignal,
            }
        }
    }

    /// Parse one OSC string: `*i` points at the `]`. On `Complete` the
    /// payload excludes the terminator and `*i` is just past it; on
    /// `Split` the caller keeps `input[keep_from..]` (from the ESC).
    fn scan_osc(&self, input: &str, i: &mut usize) -> OscOutcome {
        let bytes = input.as_bytes();
        let open = *i; // index of ']'; the ESC is just before
        *i += 1;
        while *i < bytes.len() {
            let b = bytes[*i];
            if b == 0x07 {
                let payload = input[open + 1..*i].to_string();
                *i += 1;
                return OscOutcome::Complete(payload);
            }
            if b == 0x1b && *i + 1 < bytes.len() && bytes[*i + 1] == b'\\' {
                let payload = input[open + 1..*i].to_string();
                *i += 2; // consume ESC \
                return OscOutcome::Complete(payload);
            }
            *i += 1;
        }
        OscOutcome::Split {
            keep_from: open - 1, // include the ESC
        }
    }
}

enum CsiOutcome {
    Complete(CsiSignal),
    Split { keep_from: usize },
}

enum OscOutcome {
    Complete(String),
    Split { keep_from: usize },
}

/// Signals the CSI scanner recognises.
enum CsiSignal {
    NoSignal,
    AltEnter,
    AltExit,
    CursorHidden,
    CursorVisible,
    SyncOutput,
    SyncEnd,
    MouseOrFocus,
    KittyKeyboard,
    Decstbm,
    EraseDisplay23,
    CursorUp(u16),
    CursorPosition { row: u16 },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Feed chunks 5ms apart, starting 5ms after `at`.
    fn feed(at: Instant, rows: u16, chunks: &[&str]) -> Vec<TuiTransition> {
        let mut clf = TuiClassifier::new(rows);
        let mut out = Vec::new();
        let mut at = at;
        for chunk in chunks {
            at += Duration::from_millis(5);
            if let Some(t) = clf.feed(chunk, at, rows) {
                out.push(t);
            }
        }
        out
    }

    /// Feed (delay, chunk) steps with explicit gaps.
    fn feed_timed(rows: u16, steps: &[(u64, &str)]) -> Vec<TuiTransition> {
        let mut clf = TuiClassifier::new(rows);
        let mut at = Instant::now();
        let mut out = Vec::new();
        for (delta, chunk) in steps {
            at += Duration::from_millis(*delta);
            if let Some(t) = clf.feed(chunk, at, rows) {
                out.push(t);
            }
        }
        out
    }

    /// Feed (delay, chunk) steps with explicit gaps, owned chunks.
    fn feed_timed_owned(rows: u16, steps: &[(u64, String)]) -> Vec<TuiTransition> {
        let mut clf = TuiClassifier::new(rows);
        let mut at = Instant::now();
        let mut out = Vec::new();
        for (delta, chunk) in steps {
            at += Duration::from_millis(*delta);
            if let Some(t) = clf.feed(chunk, at, rows) {
                out.push(t);
            }
        }
        out
    }

    fn mode(t: &TuiTransition) -> TuiMode {
        t.to
    }

    #[test]
    fn alt_screen_enter_and_exit_move_through_fullscreen() {
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?1049h"),
                (10, "top - 03\r\n"),
                (10, "\x1b[?1049l"),
                (350, "\r\n"),
            ],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
        assert!(out[0].via_alt_enter);
        assert_eq!(mode(&out[1]), TuiMode::Canonical);
        assert!(out[1].program_alt_exit);
    }

    #[test]
    fn alt_exit_needs_a_visible_cursor_and_quiet_stream() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        let enter = clf.feed("\x1b[?1049h\x1b[?25l", at, 30).expect("alt enter");
        assert_eq!(enter.to, TuiMode::Fullscreen);
        at += Duration::from_millis(500);
        // The program left the alt screen but still hides the cursor:
        // the exit is held until the cursor is visible.
        assert_eq!(clf.feed("\x1b[?1049l", at, 30), None);
        at += Duration::from_millis(400);
        assert!(clf.feed("\x1b[?25h", at, 30).is_none());
        at += Duration::from_millis(350);
        let exit = clf.feed("\r\n", at, 30).expect("exit after quiet");
        assert_eq!(mode(&exit), TuiMode::Canonical);
        assert!(exit.program_alt_exit);
    }

    #[test]
    fn mouse_tracking_commits_inline_immediately() {
        // Mouse tracking proves a TUI, not whole-grid ownership: the
        // period claims the grid but the buffer is left alone.
        for seq in [
            "\x1b[?1000h",
            "\x1b[?1002h",
            "\x1b[?1003h\x1b[?1006h",
            "\x1b[?1005h",
            "\x1b[?1015h",
        ] {
            let out = feed(Instant::now(), 30, &[seq, "x"]);
            assert_eq!(out.len(), 1, "{seq}");
            assert_eq!(mode(&out[0]), TuiMode::Inline, "{seq}");
            assert!(!out[0].via_alt_enter);
        }
    }

    #[test]
    fn pwsh_startup_burst_stays_canonical() {
        // Plain PowerShell: PSReadLine answers the CPR, enables
        // DECSCUSR + focus reporting, resets SGR, sets the title.
        // None of that is a TUI - the old rule committed Fullscreen
        // on the ?1004, which flapped back to Canonical on the
        // stream-quiet exit and wiped the prompt on reparse.
        let out = feed(
            Instant::now(),
            39,
            &[
                "\x1b[?9001h\x1b[?1004h\x1b[m\x1b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\x07\x1b[?25h\r\n\x1b]9;9;C:\\Users\\x\x1b\\PS C:\\Users> ",
                "\x1b[I",
                "\x1b[O",
            ],
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn pwsh_prompt_redraw_plus_listing_stays_canonical() {
        // First `ls` in plain pwsh: PSReadLine redraws the prompt
        // (cursor hidden, CUP to the prompt row, erase + text), shows
        // the cursor, then streams the listing with the cursor
        // visible across half the grid. None of it is TUI evidence.
        let mut steps: Vec<(u64, String)> = vec![
            (
                10,
                "\x1b[?25l\x1b[35;1H\x1b[16X\x1b[44mPS C:\\Users> \x1b[?25h".into(),
            ),
        ];
        for row in 1..=34 {
            steps.push((5, format!("-rw- 1 file{row}\r\n")));
        }
        steps.push((60, String::new()));
        let out = feed_timed_owned(39, &steps);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn hidden_multi_row_frame_stays_canonical_without_a_definitive_signal() {
        // A hidden-cursor multi-row repaint with absolute addressing
        // (the old distinct-row rule) is no longer evidence: only
        // definitive program announcements move the period.
        let mut steps: Vec<(u64, String)> = vec![(10, "\x1b[?25l".into())];
        for row in 1..=20u16 {
            steps.push((5, format!("\x1b[{row};1Hrow {row}\r\n")));
        }
        steps.push((60, String::new()));
        let out = feed_timed_owned(30, &steps);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn pwsh_startup_clear_with_home_stays_canonical() {
        // PSReadLine startup: hide the cursor, clear all rows with
        // EL + CRLF (the cursor scrolls to the bottom row), then
        // home and show the cursor. The home from the bottom looks
        // like a frame rewind, but none of this is evidence.
        let mut chunk = String::from("\x1b[?25l");
        for _ in 0..38 {
            chunk.push_str("\x1b[K\r\n");
        }
        chunk.push_str("\x1b[K\x1b[H\x1b[?25hPS C:\\Users> ");
        let out = feed(Instant::now(), 39, &[&chunk, "\x1b[I"]);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn pwsh_hidden_redraw_plus_scrolled_listing_stays_canonical() {
        // First `ls` in plain pwsh: PSReadLine hides the cursor, CUPs
        // to the prompt/output region and rewrites it, then streams
        // the listing with the cursor visible, scrolled across the
        // whole grid. Only the few CUP-targeted rows stamp; the
        // scrolled listing rows do not - far below the distinct-row
        // threshold.
        let mut steps: Vec<(u64, String)> = vec![
            (10, "\x1b[?25l\x1b[5;1H\x1b[16XDirectory: C:\\Users\x1b[?25h".into()),
        ];
        for i in 1..=38u16 {
            steps.push((2, format!("-rw- 1 file{i}\r\n")));
        }
        steps.push((60, String::new()));
        let out = feed_timed_owned(39, &steps);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn sync_output_is_a_definitive_inline_enter_signal() {
        let out = feed(Instant::now(), 30, &["\x1b[?2026h", "frame"]);
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Inline);
    }

    #[test]
    fn kitty_keyboard_modes_are_definitive_inline_signals() {
        for seq in ["\x1b[>1u", "\x1b[>u", "\x1b[=2u", "\x1b[4;2m"] {
            let out = feed(Instant::now(), 30, &[seq, "x"]);
            assert_eq!(out.len(), 1, "{seq}");
            assert_eq!(mode(&out[0]), TuiMode::Inline, "{seq}");
        }
    }

    #[test]
    fn full_screen_addressing_without_a_definitive_signal_stays_canonical() {
        // CUP jumps from the bottom of the grid to row 1 plus a burst
        // of writes across most rows (the old cup-rewind rule) is no
        // longer evidence: only definitive program announcements move
        // the period.
        let mut steps: Vec<(u64, &str)> = vec![(10, "\x1b[30;1H")];
        for row in 1..=15u16 {
            let chunk = format!("\x1b[{row};1Htext\r\n");
            steps.push((1, chunk.leak()));
        }
        steps.push((60, ""));
        let out = feed_timed(30, &steps);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn a_bare_clear_stays_canonical() {
        // The shell's `clear` (ED2 + home) is cooked: no multi-row
        // follow-up, no strong signal, no commit.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[H\x1b[2J\x1b[H"),
                (60, "PS C:\\> "),
                (500, "dir\r\n"),
            ],
        );
        assert!(out.is_empty());
    }

    #[test]
    fn whole_screen_clear_reports_a_chunk_marker() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("echo on\r\n\x1b[2J\x1b[HPS C:\\> ", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), Some(9));
        assert_eq!(clf.take_chunk_clear(), None, "the marker is consumed once");
        // ED3 (scrollback wipe) is a clear boundary too.
        at += Duration::from_millis(5);
        assert!(clf.feed("\x1b[3J\x1b[H", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), Some(0));
    }

    #[test]
    fn erase_down_or_up_are_not_clear_markers() {
        // ED0 (`\x1b[J`) and ED1 (`\x1b[1J`) clear a region, not the
        // history: the host must not truncate the journal for them.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[J\x1b[1J", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), None);
    }

    #[test]
    fn a_clear_split_across_chunks_is_not_reported() {
        // The sequence start sits in the previous chunk, so the current
        // chunk cannot anchor a journal cut.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("before\x1b[2", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), None);
        at += Duration::from_millis(10);
        assert!(clf.feed("J", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), None);
    }

    #[test]
    fn clear_marker_is_reported_inside_a_fullscreen_period() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[?1049h", at, 30).is_some());
        assert_eq!(clf.take_chunk_clear(), None);
        // A mid-TUI ED2 is not a mode event (no double transition), but
        // it is still a history boundary the host may truncate at.
        at += Duration::from_millis(5);
        assert!(clf.feed("\x1b[H\x1b[2J", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), Some(3));
    }

    #[test]
    fn a_feed_without_a_clear_consumes_the_marker() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[2J", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), Some(0));
        // A clear from an earlier chunk must not leak into the next one.
        at += Duration::from_millis(5);
        assert!(clf.feed("plain text", at, 30).is_none());
        assert_eq!(clf.take_chunk_clear(), None);
    }

    #[test]
    fn clear_then_command_output_stays_canonical() {
        // `clear; ls`: ED2 + home, then plain newline-terminated
        // command output - no cursor hide, no row addressing. Must
        // stay canonical so typing/resize/focus does not claim the
        // PTY grid.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[2J\x1b[1;1H"),
                (5, "file one\r\nfile two\r\nfile three\r\nfile four\r\n"),
                (60, "PS C:\\> "),
                (500, "ls\r\n"),
            ],
        );
        assert!(out.is_empty());
    }

    #[test]
    fn large_listing_scrolled_without_markers_stays_canonical() {
        // A long `ls` listing after `clear` scrolls across the grid
        // without cursor hides or row addressing, so it must not
        // commit.
        let mut steps: Vec<(u64, String)> = vec![(10, "\x1b[2J\x1b[1;1H".into())];
        for row in 0..20 {
            steps.push((5, format!("entry {row}\r\n")));
        }
        steps.push((60, String::new()));
        let out = feed_timed_owned(30, &steps);
        assert!(out.is_empty());
    }

    #[test]
    fn cursor_hidden_ed2_draw_stays_canonical() {
        // A cursor-hidden multi-row draw after an ED stays canonical:
        // this was the pattern that got PSReadLine's Clear-Host (ED3 +
        // prompt + erase sweep + hidden-cursor redraws) misread as a
        // fullscreen TUI, and it is no longer evidence.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?25l\x1b[2J"),
                (5, "row one\r\nrow two\r\nrow three\r\n"),
                (60, ""),
            ],
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn transitions_carry_the_firing_rule_as_reason() {
        // The sync debug log prints `reason=` per mode line; pin the
        // strings so a rename cannot silently break the log.
        let out = feed(Instant::now(), 30, &["\x1b[?1049h", "x"]);
        assert_eq!(out[0].reason, "alt-enter");

        let out = feed(Instant::now(), 30, &["\x1b[?2026h", "x"]);
        assert_eq!(out[0].reason, "sync-output");
        assert_eq!(mode(&out[0]), TuiMode::Inline);

        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?1049h"),
                (5, "frame\r\n"),
                (60, "\x1b[?1049l\r\n"),
                (500, ""),
            ],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].reason, "alt-enter");
        assert_eq!(out[1].reason, "alt-exit");
    }

    #[test]
    fn clear_from_the_bottom_stays_canonical() {
        // A listing ends on the bottom row; the shell's `clear`
        // (home + ED2/ED3, both orders) must not commit a TUI mode.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed(&"entry\r\n".repeat(30), at, 30).is_none());
        at += Duration::from_millis(10);
        // Home first, ED2 second.
        assert!(clf.feed("\x1b[H\x1b[2J", at, 30).is_none());
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[H", at, 30).is_none());
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_none());
        // ED3 (scrollback wipe) first is the same signature.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed(&"entry\r\n".repeat(30), at, 30).is_none());
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[3J\x1b[H", at, 30).is_none());
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_none());
    }

    #[test]
    fn ed2_home_with_a_two_row_prompt_stays_canonical() {
        // Two distinct CUP rows is a multi-line prompt redraw, not a
        // full-screen repaint (there is no ED-based detection left to
        // misread a prompt redraw as a TUI repaint).
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[2J\x1b[1;1H"),
                (5, "\x1b[2;1Hline two"),
                (60, ""),
            ],
        );
        assert!(out.is_empty());
    }

    #[test]
    fn psreadline_clear_with_erase_sweep_stays_canonical() {
        // PSReadLine's Clear-Host on a primary-buffer terminal: ED3 +
        // prompt + a full-grid `\x1b[K` erase sweep stepped down by
        // scrolling, then the line editor's absolute-addressed redraws
        // (the prompt text on row 1, CUP placement at 33/3, hidden
        // cursor). This pattern is indistinguishable from a primary-
        // buffer TUI repaint, so none of it is evidence: the host used
        // to wrap the shell clear in a synthetic alt pair and every
        // client split the clear across two buffers - the prompt
        // appeared to vanish twice and stale output replaced the
        // cleared screen.
        let sweep: &'static str = Box::leak(("\x1b[K\r\n".repeat(38)).into_boxed_str());
        let out = feed_timed(
            39,
            &[
                (10, "\x1b[H\x1b[?25h\x1b[3J\x1b]9;9;C:\\repo\x07\x1b[?25lPS C:\\repo> "),
                (5, sweep),
                (5, "\x1b[1;31H\x1b[?25h"),
                (5, "\x1b[?25l\x1b[93ml\x1b[97m\x1b[2m\x1b[3ms\x08\x1b[1;33H\x1b[?25h"),
                (5, "\x1b[?25l\x1b[93m\x1b[3;1Hrow\x1b[4;1Hrow"),
                (60, ""),
            ],
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn ed2_home_with_multiline_cups_no_longer_commits() {
        // The old ed2-multiline-cup rule: ED2 + home held as the `clear`
        // signature, then multi-row absolute CUPs that used to prove a TUI
        // repaint. With the ED-based detection removed, this shell-clear
        // follow-up stays canonical too - it is exactly the prompt/editor
        // placement PSReadLine uses after a clear.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[2J\x1b[1;1H"),
                (5, "\x1b[2;1Hrow"),
                (5, "\x1b[3;1Hrow"),
                (5, "\x1b[4;1Hrow"),
                (60, ""),
            ],
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn bottom_up_jump_is_not_tui_evidence_in_any_direction() {
        // A bottom-to-top frame rewind used to be a candidate (cup-rewind).
        // With the ED-based detection removed entirely, it stays canonical
        // whether or not a whole-screen clear preceded it; only definitive
        // signals (alt-enter, sync-output, DECSTBM paint, mouse/kitty)
        // commit a fullscreen period now.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[30;1H", at, 30).is_none());
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[1;1Hframe", at, 30).is_none());
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_none());
        // With a whole-screen clear in between (the shell's `clear` shape).
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[30;1H", at, 30).is_none());
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[2J", at, 30).is_none());
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[1;1Hframe", at, 30).is_none());
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_none());
    }

    #[test]
    fn probe_burst_stays_canonical() {
        // Probe families (DA, DSR, window size queries) are terminal
        // capability checks, not TUI evidence - a shell prompt fires
        // some of them too.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?c"),
                (5, "\x1b[?6n"),
                (5, "\x1b[18t"),
                (60, ""),
            ],
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn inline_repaint_pattern_stays_canonical() {
        // CUU+EL bottom-region repaints (fzf-style inline apps) are no
        // longer evidence: the inline mode is not produced anymore.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?25l"),
                (5, "\x1b[3A\x1b[2Kline a\r\n"),
                (5, "\x1b[3A\x1b[2Kline b\r\n"),
                (5, "\x1b[3A\x1b[2Kline c\r\n"),
                (60, ""),
            ],
        );
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn alt_enter_still_commits_after_an_inline_like_harness() {
        // The repaint harness never commits, but the program's own
        // alt-screen entry remains definitive whenever it arrives.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        for _ in 0..3 {
            at += Duration::from_millis(5);
            clf.feed("\x1b[3A\x1b[2Kline\r\n", at, 30);
        }
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_none(), "no inline commit");
        at += Duration::from_millis(5);
        let upgrade = clf.feed("\x1b[?1049h", at, 30).expect("alt-enter commits");
        assert_eq!(mode(&upgrade), TuiMode::Fullscreen);
    }

    #[test]
    fn post_exit_prompt_redraw_stays_canonical() {
        // Exit fullscreen, then a prompt redraw (clear + a few rows):
        // none of it is evidence, so the only transitions are the enter
        // and the exit.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?1049h"),
                (10, "\x1b[?1049l"),
                (350, "\r\n"), // alt-anchored exit fires here
                (5, "\x1b[2Jline one\r\nline two\r\nline three"),
                (600, "PS C:\\> "),
                (500, ""),
            ],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
        assert_eq!(mode(&out[1]), TuiMode::Canonical);
    }

    #[test]
    fn stream_anchored_exit_on_quiet_newline_terminated_prompt() {
        // A stream-anchored TUI (no alt screen of its own, entered
        // through sync-output) leaves: the prompt is newline-terminated
        // and the stream goes quiet.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?2026h"),
                (5, "frame one\r\nframe two\r\n"),
                (60, ""), // definitive sync-output entry
                (5, "done\r\n\x1b[?25h"),
                (520, "PS C:\\> "),
            ],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(mode(&out[0]), TuiMode::Inline);
        assert_eq!(mode(&out[1]), TuiMode::Canonical);
        assert!(!out[1].program_alt_exit);
        assert_eq!(out[1].reason, "exit-quiet");
    }

    #[test]
    fn osc_133_marker_exits_to_canonical() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        assert!(clf.feed("\x1b[?1049h", at, 30).is_some());
        at += Duration::from_millis(10);
        let out = clf.feed("\x1b]133;D\x07", at, 30);
        assert!(out.is_some());
        assert_eq!(mode(out.as_ref().unwrap()), TuiMode::Canonical);
    }

    #[test]
    fn a_split_sequence_bridges_chunks() {
        let out = feed_timed(
            30,
            &[(10, "\x1b[?104"), (5, "9h"), (5, "x")],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    /// Feed one step on a live classifier, advancing the clock by `gap`.
    /// A free function (not a closure) so each call's borrows of `clf`
    /// and `at` are scoped to the call and do not overlap later asserts.
    fn step(
        clf: &mut TuiClassifier,
        at: &mut Instant,
        rows: u16,
        chunk: &str,
        gap: u64,
    ) -> Option<TuiTransition> {
        *at += Duration::from_millis(gap);
        clf.feed(chunk, *at, rows)
    }

    #[test]
    fn bare_alt_cycle_suppresses_grid_changes_until_exit() {
        // PSReadLine's Clear-Host: alt-enter, a HIDDEN prompt redraw on
        // row 1 only, alt-exit, then main-screen backspace redraws
        // (row 1, hidden cursor) while the pending-exit quiet window is
        // open. No DECSTBM, no hidden writes past row 1 - the shell
        // never paints a TUI frame, so the grid must stay held the
        // whole time.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let entry =
            step(&mut clf, &mut at, 30, "\x1b[?1049h\x1b[?25l\x1b[HPS C:\\> ", 10)
                .expect("alt-enter commits");
        assert!(entry.via_alt_enter);
        // Row-1 hidden writes produce no paint evidence; the grid is
        // suppressed from the moment of entry.
        step(&mut clf, &mut at, 30, "\x1b[K\r\n\x1b[K\r\n\x1b[1;32H\x1b[?25h", 10);
        assert!(!clf.has_paint_evidence());
        assert!(clf.grid_change_suppressed());
        // Alt-exit, then the main-screen prompt redraw: PSReadLine CUPs
        // to a non-home row (here row 4) under a hidden cursor. That is
        // shell activity on the MAIN screen after the program left the
        // alt screen - it must NOT count as TUI paint evidence, so the
        // grid stays held.
        step(&mut clf, &mut at, 30, "\x1b[?1049l\x1b[?25l\x1b[4;31Hl\x1b[?25h", 10);
        assert!(!clf.has_paint_evidence(), "post-alt main-screen CUP is not TUI paint");
        assert!(clf.grid_change_suppressed());
        // Quiet + visible cursor exits to canonical; the suppression
        // disappears with the TUI period.
        step(&mut clf, &mut at, 30, "\r", 350);
        assert_eq!(clf.mode(), TuiMode::Canonical);
        assert!(!clf.grid_change_suppressed());
    }

    #[test]
    fn alt_tui_stbm_releases_grid_suppression() {
        let mut clf = TuiClassifier::new(26);
        let mut at = Instant::now();
        let entry = step(&mut clf, &mut at, 26, "\x1b[?1049h\x1b[?25l", 10)
            .expect("alt-enter commits");
        assert!(entry.via_alt_enter);
        assert!(clf.grid_change_suppressed());
        // DECSTBM: definitive paint evidence on the first frame.
        step(&mut clf, &mut at, 26, "\x1b[1;26r\x1b[3;1Hframe", 10);
        assert!(clf.has_paint_evidence());
        assert!(!clf.grid_change_suppressed());
    }

    #[test]
    fn hidden_multirow_paint_releases_grid_suppression() {
        let mut clf = TuiClassifier::new(26);
        let mut at = Instant::now();
        let _entry = step(&mut clf, &mut at, 26, "\x1b[?1049h\x1b[?25l", 10)
            .expect("alt-enter commits");
        // Hidden-cursor absolute writes past row 1: paint evidence
        // without DECSTBM.
        step(&mut clf, &mut at, 26, "\x1b[5;10Hx\x1b[7;10Hy", 10);
        assert!(clf.has_paint_evidence());
        assert!(!clf.grid_change_suppressed());
    }

    #[test]
    fn synthetic_entry_never_suppresses_grid_changes() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        // A non-alt definitive entry does not anchor to alt, so the
        // entry-time grid change applies immediately (host-injected
        // alt pair already guarantees the evidence).
        let entry = step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("sync-output entry");
        assert!(!entry.via_alt_enter);
        assert!(!clf.grid_change_suppressed());
    }

    #[test]
    fn deferred_exit_cancels_pending_suppression_state() {
        // A bare alt cycle that exits quietly leaves no trace: a later
        // real TUI entry behaves exactly as before the fix.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let _ = step(&mut clf, &mut at, 30, "\x1b[?1049h\x1b[?25l\x1b[H> ", 10).unwrap();
        step(&mut clf, &mut at, 30, "\x1b[?1049l\x1b[?25h", 10);
        step(&mut clf, &mut at, 30, "\r", 350);
        assert_eq!(clf.mode(), TuiMode::Canonical);
        let entry = step(&mut clf, &mut at, 30, "\x1b[?1049h\x1b[?25l", 10)
            .expect("second alt-enter");
        assert!(entry.via_alt_enter);
        assert!(clf.grid_change_suppressed());
        step(&mut clf, &mut at, 30, "\x1b[1;30r\x1b[2;1Ht", 10);
        assert!(!clf.grid_change_suppressed());
    }

    /// One `pi`-style frame: the whole repaint bracketed by
    /// `?2026h`/`?2026l`, the composer addressed near the bottom of the
    /// grid, and the harness marking its OWN prompt with OSC 133.
    fn inline_frame(tick: u32) -> String {
        format!(
            "{ESC}[?2026h{ESC}[33;1H{ESC}[K{ESC}]133;A\x07{ESC}[34;1H\
             {ESC}]133;B\x07{ESC}]133;C\x07 thinking {tick}{ESC}[K\r\n\
             {ESC}[39;1H status{ESC}[K{ESC}[?2026l",
            ESC = "\x1b"
        )
    }

    #[test]
    fn an_inline_harness_stays_in_one_inline_period_across_frames() {
        // The regression this whole split exists for. `pi` announces
        // itself with kitty keyboard + sync output, never touches the
        // alt screen, and wraps an OSC 133 prompt marker inside every
        // frame. The old classifier read the marker as "the shell is
        // back", so it left and re-entered the period once per repaint -
        // 27 enters against 10 exits in a ten-second session - and the
        // host's synthetic alt pair flashed the buffer at repaint rate.
        let mut clf = TuiClassifier::new(39);
        let mut at = Instant::now();
        let enter = step(&mut clf, &mut at, 39, "\x1b[?2004h\x1b[>7u\x1b[?25l", 10)
            .expect("the harness announces itself");
        assert_eq!(mode(&enter), TuiMode::Inline);
        assert_eq!(enter.reason, "kitty-keyboard");

        for tick in 0..12u32 {
            let frame = inline_frame(tick);
            assert_eq!(
                step(&mut clf, &mut at, 39, &frame, 30),
                None,
                "frame {tick} must not move the period"
            );
            assert_eq!(clf.mode(), TuiMode::Inline, "frame {tick}");
        }
    }

    #[test]
    fn an_inline_period_never_reaches_fullscreen_on_its_own() {
        // The host keys its synthetic alt-screen injection on
        // `Fullscreen`, so this is the contract that keeps an inline
        // harness's transcript in the primary buffer.
        let mut clf = TuiClassifier::new(39);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 39, "\x1b[>7u\x1b[?1002h\x1b[?25l", 10);
        for tick in 0..6u32 {
            step(&mut clf, &mut at, 39, &inline_frame(tick), 30);
        }
        assert_eq!(clf.mode(), TuiMode::Inline);
    }

    #[test]
    fn an_osc_133_marker_inside_a_frame_is_not_a_shell_prompt() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("inline entry");
        assert_eq!(
            step(&mut clf, &mut at, 30, "\x1b]133;A\x07frame", 5),
            None,
            "a marker inside the program's own bracket is part of its frame"
        );
        assert_eq!(clf.mode(), TuiMode::Inline);
        // Closing the bracket restores the marker's meaning: the next
        // one is the shell's and ends the period.
        step(&mut clf, &mut at, 30, "\x1b[?2026l", 5);
        let exit = step(&mut clf, &mut at, 30, "\x1b]133;A\x07", 5).expect("shell prompt");
        assert_eq!(mode(&exit), TuiMode::Canonical);
        assert_eq!(exit.reason, "osc133");
    }

    #[test]
    fn unbalanced_sync_brackets_do_not_wedge_the_period_open() {
        // A program killed mid-frame leaves the bracket open; the exit
        // paths must still be able to close the period.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("inline entry");
        step(&mut clf, &mut at, 30, "frame\r\n\x1b[?25h", 5);
        let exit = step(&mut clf, &mut at, 30, "PS C:\\> ", 520).expect("quiet exit");
        assert_eq!(mode(&exit), TuiMode::Canonical);
        // The bracket depth reset with the period, so the next shell
        // marker is read as the shell's again.
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("second entry");
        let second = step(&mut clf, &mut at, 30, "\x1b[?2026l\x1b]133;A\x07", 5);
        assert_eq!(mode(&second.expect("marker after the bracket closed")), TuiMode::Canonical);
    }

    #[test]
    fn an_enter_and_an_exit_in_one_chunk_report_nothing() {
        // Net effect is what the host acts on. Reporting only the enter
        // (the old first-wins rule) left it holding a synthetic
        // alt-screen enter with no matching exit.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        assert_eq!(
            step(&mut clf, &mut at, 30, "\x1b[?2026h\x1b[?2026l\x1b]133;A\x07", 10),
            None,
            "the chunk both entered and left: nothing net changed"
        );
        assert_eq!(clf.mode(), TuiMode::Canonical);
    }

    #[test]
    fn an_inline_period_is_promoted_in_place_by_a_scroll_region() {
        // A harness that later takes the whole grid (DECSTBM + drawing)
        // rises to Fullscreen without restarting the period, and the
        // promotion is reported so the host can wrap it.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let enter = step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("inline entry");
        assert_eq!(mode(&enter), TuiMode::Inline);
        step(&mut clf, &mut at, 30, "\x1b[?25l\x1b[2;1Ha\x1b[3;1Hb", 5);
        let promoted = step(&mut clf, &mut at, 30, "\x1b[1;30r", 5).expect("stbm promotion");
        assert_eq!(mode(&promoted), TuiMode::Fullscreen);
        assert_eq!(promoted.reason, "stbm-draw");
        assert!(!promoted.via_alt_enter);
        // The promotion kept the period's evidence rather than wiping it.
        assert_eq!(clf.mode(), TuiMode::Fullscreen);
    }

    #[test]
    fn a_stbm_promotion_from_drawing_is_reported_not_swallowed() {
        // The DECSTBM arrives first and the draw extent completes it on
        // a later plain byte. That path used to change the mode without
        // returning a transition, so the host never learned about it.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026h\x1b[?25l", 10).expect("inline entry");
        step(&mut clf, &mut at, 30, "\x1b[1;30r\x1b[2;1Ha", 5);
        let promoted = step(&mut clf, &mut at, 30, "\x1b[3;1Hb", 5).expect("promotion on draw");
        assert_eq!(mode(&promoted), TuiMode::Fullscreen);
        assert_eq!(promoted.reason, "stbm-draw");
    }

    #[test]
    fn a_transition_carries_the_offset_of_the_sequence_that_fired_it() {
        // The host splices its synthetic alt bytes here, so output the
        // program wrote before announcing itself stays on the main
        // screen instead of being swallowed into the alt buffer.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let chunk = "done.\r\n\x1b[?1049h";
        let enter = step(&mut clf, &mut at, 30, chunk, 10).expect("alt enter");
        assert_eq!(enter.at, chunk.find('\x1b').expect("esc"));

        // A signal carried over from a previous chunk cannot anchor a
        // splice in this one, so it reports the chunk start.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        assert_eq!(step(&mut clf, &mut at, 30, "text\x1b[?104", 10), None);
        let split = step(&mut clf, &mut at, 30, "9h", 5).expect("alt enter across chunks");
        assert_eq!(split.at, 0);
    }

    #[test]
    fn a_split_sync_bracket_still_gates_the_osc_133_exit() {
        // `?2026h` arriving in two chunks must open the bracket exactly
        // once: the tail bridge is what makes the depth trustworthy, and
        // a missed opener would let the harness's own prompt marker end
        // the period again.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        assert_eq!(step(&mut clf, &mut at, 30, "\x1b[?202", 10), None);
        let enter = step(&mut clf, &mut at, 30, "6h", 5).expect("split sync-output");
        assert_eq!(mode(&enter), TuiMode::Inline);
        assert_eq!(enter.at, 0, "a signal carried over cannot anchor a splice");
        assert_eq!(step(&mut clf, &mut at, 30, "\x1b]133;A\x07", 5), None);
        assert_eq!(clf.mode(), TuiMode::Inline);
    }

    #[test]
    fn a_split_osc_133_is_judged_by_the_depth_it_completes_at() {
        // The marker spans chunks; the bracket is open the whole time.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("inline entry");
        assert_eq!(step(&mut clf, &mut at, 30, "\x1b]133", 5), None);
        assert_eq!(step(&mut clf, &mut at, 30, ";A\x07", 5), None, "still inside the frame");
        assert_eq!(clf.mode(), TuiMode::Inline);
    }

    #[test]
    fn nested_sync_brackets_unwind_one_level_at_a_time() {
        // A frame that opens a second bracket must not be treated as
        // closed by the inner `?2026l`.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("inline entry");
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 5);
        step(&mut clf, &mut at, 30, "\x1b[?2026l", 5);
        assert_eq!(
            step(&mut clf, &mut at, 30, "\x1b]133;A\x07", 5),
            None,
            "the outer bracket is still open"
        );
        step(&mut clf, &mut at, 30, "\x1b[?2026l", 5);
        let exit = step(&mut clf, &mut at, 30, "\x1b]133;A\x07", 5).expect("both closed");
        assert_eq!(mode(&exit), TuiMode::Canonical);
    }

    #[test]
    fn a_stray_bracket_close_cannot_drive_the_depth_negative() {
        // A `?2026l` with no opener (a chunk boundary lost in a
        // reconnect, or a program that closes twice) must leave the
        // depth at zero rather than wrapping, or every later frame's
        // marker would be read as the shell's.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026l\x1b[?2026l", 10);
        let enter = step(&mut clf, &mut at, 30, "\x1b[?2026h", 5).expect("inline entry");
        assert_eq!(mode(&enter), TuiMode::Inline);
        assert_eq!(
            step(&mut clf, &mut at, 30, "\x1b]133;A\x07", 5),
            None,
            "the bracket opened by this frame still gates the marker"
        );
    }

    #[test]
    fn an_alt_screen_tui_that_brackets_its_frames_keeps_the_period() {
        // The gate is not inline-only: a real alt-screen TUI that wraps
        // repaints in `?2026h`/`?2026l` and prints an OSC 133 inside one
        // must not be torn out of its period either.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let enter = step(&mut clf, &mut at, 30, "\x1b[?1049h\x1b[?25l", 10).expect("alt enter");
        assert_eq!(mode(&enter), TuiMode::Fullscreen);
        assert_eq!(
            step(&mut clf, &mut at, 30, "\x1b[?2026h\x1b]133;C\x07frame\x1b[?2026l", 5),
            None
        );
        assert_eq!(clf.mode(), TuiMode::Fullscreen);
    }

    #[test]
    fn an_alt_enter_inside_a_frame_still_promotes() {
        // Depth gates the OSC 133 exit only. A program that opens its
        // alt screen mid-frame is still claiming the whole grid.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("inline entry");
        let promoted = step(&mut clf, &mut at, 30, "\x1b[?1049h", 5).expect("alt enter");
        assert_eq!(mode(&promoted), TuiMode::Fullscreen);
        assert!(promoted.via_alt_enter);
    }

    #[test]
    fn a_period_never_drops_from_fullscreen_back_to_inline() {
        // Modes only rise within a period: a fullscreen TUI that later
        // enables sync output or mouse tracking must not be demoted,
        // which would leave the host's injected alt pair unclosed.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?1049h\x1b[?25l", 10).expect("alt enter");
        for seq in ["\x1b[?2026h", "\x1b[?1002h", "\x1b[>7u"] {
            assert_eq!(step(&mut clf, &mut at, 30, seq, 5), None, "{seq}");
            assert_eq!(clf.mode(), TuiMode::Fullscreen, "{seq}");
        }
    }

    #[test]
    fn a_chunk_that_rises_twice_reports_only_the_mode_it_lands_in() {
        // Canonical -> Inline -> Fullscreen inside one chunk is one
        // actionable transition, carrying the rule that took it the
        // whole way.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let out = step(
            &mut clf,
            &mut at,
            30,
            "\x1b[?2026h\x1b[?25l\x1b[2;1Ha\x1b[3;1Hb\x1b[1;30r",
            10,
        )
        .expect("net rise to fullscreen");
        assert_eq!(mode(&out), TuiMode::Fullscreen);
        assert_eq!(out.reason, "stbm-draw");
        assert!(!out.via_alt_enter);
    }

    #[test]
    fn an_exit_reports_the_offset_of_the_marker_that_released_it() {
        // The host splices its `?1049l` here, so bytes the program wrote
        // before releasing the grid stay on the alt screen.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?1049h", 10).expect("alt enter");
        let chunk = "last frame\x1b]133;D\x07";
        let exit = step(&mut clf, &mut at, 30, chunk, 5).expect("osc133 exit");
        assert_eq!(exit.reason, "osc133");
        assert_eq!(exit.at, chunk.find('\x1b').expect("esc"));
    }

    #[test]
    fn a_transition_offset_counts_bytes_not_characters() {
        // `at` indexes the chunk the host is about to journal, which is
        // a byte buffer: multi-byte text ahead of the signal shifts it
        // by its encoded width.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let chunk = "\u{2500}\u{2500} ready\x1b[?1049h";
        let enter = step(&mut clf, &mut at, 30, chunk, 10).expect("alt enter");
        assert_eq!(enter.at, 12, "two 3-byte box glyphs plus ' ready'");
        assert_eq!(enter.at, chunk.find('\x1b').expect("esc"));
        assert!(chunk.is_char_boundary(enter.at));
    }

    #[test]
    fn an_osc_133_in_canonical_mode_is_not_a_transition() {
        // The shell's own prompt markers arrive constantly; only ones
        // that actually end a TUI period are events.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        for marker in ["\x1b]133;A\x07", "\x1b]133;B\x07", "\x1b]133;C\x07", "\x1b]133;D\x07"] {
            assert_eq!(step(&mut clf, &mut at, 30, marker, 10), None, "{marker}");
        }
        assert_eq!(clf.mode(), TuiMode::Canonical);
    }

    #[test]
    fn an_exit_clears_the_bracket_depth_for_the_next_program() {
        // A program killed mid-frame leaves the depth open. The next
        // program's period must start from zero or its first prompt
        // marker would be swallowed.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        step(&mut clf, &mut at, 30, "\x1b[?1049h\x1b[?25l", 10).expect("alt enter");
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 5); // frame opened, never closed
        step(&mut clf, &mut at, 30, "\x1b[?1049l\x1b[?25h", 5);
        let exit = step(&mut clf, &mut at, 30, "\r\n", 350).expect("alt-anchored exit");
        assert_eq!(mode(&exit), TuiMode::Canonical);
        // Next period: one marker, at depth zero, ends it.
        step(&mut clf, &mut at, 30, "\x1b[?2026h", 10).expect("second entry");
        step(&mut clf, &mut at, 30, "\x1b[?2026l", 5);
        let second = step(&mut clf, &mut at, 30, "\x1b]133;A\x07", 5).expect("shell prompt");
        assert_eq!(mode(&second), TuiMode::Canonical);
    }

    #[test]
    fn a_whole_screen_clear_inside_a_frame_is_still_a_history_boundary() {
        // The clear marker feeds the host's journal truncation and is
        // independent of the bracket depth: an inline harness clears the
        // screen on startup inside its first frame. With an ED2+ED3 pair
        // in one chunk the LAST clear wins, which is the boundary that
        // discards the most already-erased history.
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        let chunk = "\x1b[?2026h\x1b[2J\x1b[3J\x1b[?2026l";
        step(&mut clf, &mut at, 30, chunk, 10).expect("inline entry");
        assert_eq!(clf.take_chunk_clear(), Some(chunk.find("\x1b[3J").expect("ed3")));
        assert_eq!(clf.mode(), TuiMode::Inline);
    }
}
