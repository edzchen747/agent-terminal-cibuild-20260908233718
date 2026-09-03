//! TUI mode classification for the shared PTY stream.
//!
//! The host classifies the running foreground program into one of three
//! grid-ownership modes (see `TuiMode`):
//!
//! - `Canonical`: the PTY stays at its snapshot size; clients reflow the
//!   journal at their own sizes.
//! - `Inline`: the program repaints a bounded region in place; the PTY
//!   follows the focused client and output intentionally stays in the
//!   scrollback.
//! - `Fullscreen`: the program owns the whole grid; the PTY follows the
//!   focused client and the host isolates TUI frames from the scrollback
//!   (journaled synthetic alt-screen pair when the program does not use
//!   one itself).
//!
//! The classifier runs on stream evidence (the VT sequences the program
//! emits). The other evidence sources — pty probing (termios raw mode,
//! foreground pgrp) and shell-rc markers — need platform APIs this
//! Windows host does not expose: `raw_mode` stays `None`, so strong
//! signals qualify on their own and the "foreground == shell" veto is
//! approximated by the newline-terminated quiet exit rule. Both are
//! documented extension points: a prober calls [`TuiClassifier::set_raw_mode`],
//! and OSC 133 shell markers are honored when present.
//!
//! Deviations from the detection matrix, all due to the missing platform
//! APIs: bare two-byte DECKPAM/DECPAM (`ESC =` / `ESC >`) are not
//! treated as strong on their own — the same intro markers open the
//! kitty keyboard-flags sequences (`ESC = n u`, `ESC > n u`,
//! `ESC > 4 ; n m`), which are definitive and cover the real apps; and
//! the cooked-foreground veto (`raw_mode`) applies only when a prober
//! supplies raw-mode state.
//!
//! The shell's `clear` (ED2/ED3 + home-CUP) is deliberately not a strong
//! signal on its own: a bottom-to-top home jump only commits when it was
//! not armed by a recent whole-screen clear, and an ED2-armed home is
//! held until multi-row absolute CUPs (or drawing) prove a TUI repaint.
//! Multi-row *scrolled* drawing after an ED2 (and windowed distinct-row
//! writes in general) additionally require a TUI marker in the window -
//! a cursor hide or CUP/VPR addressing to a non-home row: shell command
//! output after `clear` (e.g. `clear; ls`) is ED2 + home + sequential
//! newline-terminated scrolling, which carries none of those. The
//! distinct-row rule counts only rows first written while the cursor is
//! hidden: TUI frames are drawn flicker-free, while shell listings
//! scroll with the cursor visible. Focus-event reporting (`CSI ?1004 h`)
//! is not evidence either - PSReadLine (plain PowerShell) enables it at
//! startup, and the focus events it produces (`\x1b[I`/`\x1b[O`) are
//! not TUI behavior.

use std::collections::{BTreeSet, VecDeque};
use std::time::{Duration, Instant};

use crate::models::TuiMode;

/// Entry confirmation window: batch the program's startup burst, then
/// decide once (a strong signal alone commits after this window).
pub const ENTER_CONFIRM_MS: u64 = 50;
/// Exit hold-off: strong signals that fired this long after a canonical
/// exit are dropped, so a prompt redraw cannot bounce the mode.
pub const EXIT_HOLD_MS: u64 = 200;
/// Cursor hidden for at least this long is a strong signal (prompt
/// redraws hide the cursor for milliseconds only).
pub const CURSOR_HIDDEN_MS: u64 = 100;
/// Alt-anchored exit requires the stream to have been quiet this long
/// with a visible cursor.
pub const ALT_EXIT_QUIET_MS: u64 = 300;
/// Stream-anchored exit: newline-terminated output plus this much quiet
/// means the foreground is back at a shell prompt.
pub const STREAM_EXIT_QUIET_MS: u64 = 500;
/// Window over which distinct-row writes count toward "full-screen
/// addressing".
pub const FULLSCREEN_WINDOW_MS: u64 = 250;
/// Three CUU+clear repaints inside this window is the inline
/// bottom-region pattern.
pub const REPAINT_WINDOW_MS: u64 = 1000;
/// Probe families and weak signals accumulate over this window.
pub const PROBE_WINDOW_MS: u64 = 2000;
/// Four weak signals (OSC titles, bracketed paste, ...) inside the probe
/// window accumulate into a strong one.
pub const WEAK_TO_STRONG: u32 = 4;
/// Three distinct probe families (size/capability queries) inside the
/// probe window is a TUI startup burst; a shell prompt emits at most one
/// or two.
pub const PROBE_FAMILIES_TO_STRONG: usize = 3;

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
    /// (`[mode] session=... mode=... reason=...`): e.g. `cup-rewind`,
    /// `ed2-multiline-draw`, `cursor-hidden`, `distinct-rows`,
    /// `alt-exit`, `exit-quiet`, `osc133`.
    pub reason: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EnterKind {
    /// Full-screen addressing / ED2+draw / probe burst / cursor hidden:
    /// commits to FULLSCREEN after the confirmation window.
    Grid,
    /// CUU+clear bottom-region repaints: commits to INLINE.
    Repaint,
}

pub struct TuiClassifier {
    mode: TuiMode,
    /// Trailing bytes of an incomplete ESC/CSI/OSC sequence so a split
    /// sequence bridges chunk boundaries.
    tail: String,
    cursor_hidden: bool,
    hidden_since: Option<Instant>,
    /// Approximate cursor row (1-based, clamped to the grid).
    cursor_row: u16,
    /// The current row was entered by an absolute CUP rather than by
    /// scrolling (newline) or relative motion. TUI frames are drawn
    /// with absolute addressing; shell output scrolls. The
    /// distinct-row and cup-rewind rules only count rows entered
    /// this way, so a PSReadLine clear (38 CRLFs down, then home)
    /// or a scrolled `ls` listing cannot arm them.
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
    /// DECSTBM was set during this period; with any drawing it is a
    /// definitive fullscreen signal.
    stbm: bool,
    /// Last ED2/ED3 time; multi-row drawing after it is a strong signal.
    last_ed: Option<Instant>,
    /// A home-CUP inside the ED2/ED3 window (the shell's `clear`
    /// signature): the Grid commit is held until multi-row absolute
    /// CUPs prove a TUI repaint.
    ed_home_watch: Option<Instant>,
    /// Rows targeted by absolute CUPs since `ed_home_watch` armed.
    ed_home_rows: BTreeSet<u16>,
    /// Last TUI marker in the current foreground period: a cursor hide
    /// or CUP/VPR addressing to a non-home row. Shell cooked output
    /// (`clear` + command output) emits ED2, home-CUP, and sequential
    /// newline-terminated scrolling only - no marker - so post-ED
    /// multi-row drawing and windowed distinct-row commits require one.
    last_tui_marker: Option<Instant>,
    /// A CUU>=2 is armed; a following EL/ED0 completes a repaint.
    repaint_armed: Option<Instant>,
    /// Completed CUU+clear repaint times (the inline pattern).
    repaints: VecDeque<Instant>,
    /// (probe family, time): 1 window size, 2 DA, 3 DECRQM, 4 DSR, 5
    /// OSC color query.
    probes: VecDeque<(u8, Instant)>,
    /// Weak signal times (OSC titles, bracketed paste, ...).
    weaks: VecDeque<Instant>,
    /// Distinct rows that received text under absolute addressing, for
    /// the whole foreground period.
    extent_rows: Vec<bool>,
    /// (row, time) of rows that first received text while the cursor
    /// was hidden, for the windowed distinct-row count.
    row_stamps: VecDeque<(u16, Instant)>,
    /// A strong signal awaiting the confirmation window; the reason is
    /// the rule that queued it, carried to the committing transition.
    pending: Option<(EnterKind, &'static str, Instant)>,
    /// No strong signal that fired before this instant may commit.
    exit_hold_until: Option<Instant>,
    /// Raw-mode state, probed on platforms with termios. Windows ConPTY
    /// exposes no termios API, so this stays `None` and strong signals
    /// qualify on their own.
    raw_mode: Option<bool>,
}

impl TuiClassifier {
    pub fn new(rows: u16) -> Self {
        Self {
            mode: TuiMode::Canonical,
            tail: String::new(),
            cursor_hidden: false,
            hidden_since: None,
            cursor_row: 1,
            cup_entered_row: false,
            last_newline_chunk_at: None,
            last_chunk_at: None,
            alt_anchored: false,
            saw_alt_exit: false,
            alt_open: false,
            stbm: false,
            last_ed: None,
            ed_home_watch: None,
            ed_home_rows: BTreeSet::new(),
            last_tui_marker: None,
            repaint_armed: None,
            repaints: VecDeque::new(),
            probes: VecDeque::new(),
            weaks: VecDeque::new(),
            extent_rows: vec![false; rows.max(1) as usize + 1],
            row_stamps: VecDeque::new(),
            pending: None,
            exit_hold_until: None,
            raw_mode: None,
        }
    }

    pub fn mode(&self) -> TuiMode {
        self.mode
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

    /// A platform prober (termios on the PTY master) can publish raw
    /// mode; strong and repaint signals are then vetoed while cooked.
    /// Definitive signals commit regardless. No prober exists on this
    /// Windows host yet, so the method stays inert until one lands.
    #[allow(dead_code)]
    pub fn set_raw_mode(&mut self, raw: bool) {
        self.raw_mode = Some(raw);
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
                return self.exit_to_canonical(now, "alt-exit");
            }
            if !self.alt_anchored && stream_exit_ok {
                return self.exit_to_canonical(now, "exit-quiet");
            }
        }

        // Bridge a split sequence from the previous chunk.
        let mut input = self.tail.clone();
        input.push_str(data);
        self.tail.clear();

        let mut transition: Option<TuiTransition> = None;
        let mut last_visible: Option<u8> = None;
        let mut i = 0;
        while i < input.len() {
            let byte = input.as_bytes()[i];
            if byte != 0x1b {
                if byte == b'\n' || byte == b'\r' || !byte.is_ascii_control() {
                    last_visible = Some(byte);
                }
                self.on_plain_byte(byte, now, rows);
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
                b'[' | b'=' | b'>' | b'<' => match self.scan_csi(&input, &mut i) {
                    CsiOutcome::Complete(signal) => {
                        // Apply the signal's state updates even when a
                        // transition already fired in this chunk; only
                        // the transition result is first-wins.
                        let t = self.on_csi(signal, now, rows);
                        transition = transition.or(t);
                    }
                    CsiOutcome::Split { keep_from } => {
                        self.tail.push_str(&input[keep_from..]);
                        i = input.len();
                    }
                },
                b']' => match self.scan_osc(&input, &mut i) {
                    OscOutcome::Complete(payload) => {
                        let t = self.on_osc(&payload, now, rows);
                        transition = transition.or(t);
                    }
                    OscOutcome::Split { keep_from } => {
                        self.tail.push_str(&input[keep_from..]);
                        i = input.len();
                    }
                },
                _ => {
                    // ESC c, bare ESC, or any other two-byte escape: no
                    // signal.
                    i += 1;
                }
            }
        }
        if transition.is_none() {
            transition = self.confirm_pending(now, rows);
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
        transition
    }

    fn exit_to_canonical(&mut self, now: Instant, reason: &'static str) -> Option<TuiTransition> {
        let program_alt_exit = self.saw_alt_exit;
        self.mode = TuiMode::Canonical;
        self.pending = None;
        self.saw_alt_exit = false;
        self.alt_anchored = false;
        self.alt_open = false;
        self.stbm = false;
        self.last_ed = None;
        self.ed_home_watch = None;
        self.ed_home_rows.clear();
        self.last_tui_marker = None;
        self.repaint_armed = None;
        self.repaints.clear();
        self.row_stamps.clear();
        self.extent_rows.fill(false);
        self.exit_hold_until = Some(now + Duration::from_millis(EXIT_HOLD_MS));
        Some(TuiTransition {
            to: TuiMode::Canonical,
            via_alt_enter: false,
            program_alt_exit,
            reason,
        })
    }

    /// Record a strong (non-definitive) signal. An inline -> fullscreen
    /// grid signal commits immediately, without the confirmation window.
    fn queue_strong(
        &mut self,
        now: Instant,
        rows: u16,
        kind: EnterKind,
        reason: &'static str,
    ) -> Option<TuiTransition> {
        if self.mode == TuiMode::Fullscreen {
            return None;
        }
        if self.mode == TuiMode::Inline && kind == EnterKind::Grid {
            return self.commit_enter(TuiMode::Fullscreen, now, rows, false, reason);
        }
        // A grid candidate replaces a pending repaint candidate; the
        // original time is kept so the window still batches the burst.
        let (existing, at) = match self.pending.take() {
            Some((previous, _, at)) => (previous, at),
            None => (kind, now),
        };
        let kind = if existing == EnterKind::Grid || kind == EnterKind::Grid {
            EnterKind::Grid
        } else {
            EnterKind::Repaint
        };
        self.pending = Some((kind, reason, at));
        None
    }

    /// Definitive signals commit immediately, bypassing the window.
    fn commit_definitive(
        &mut self,
        now: Instant,
        rows: u16,
        via_alt: bool,
        reason: &'static str,
    ) -> Option<TuiTransition> {
        if self.mode == TuiMode::Canonical || self.mode == TuiMode::Inline {
            let transition = self.commit_enter(TuiMode::Fullscreen, now, rows, via_alt, reason)?;
            // The program's own alt-screen enter anchors the matching exit
            // to the alt-exit sequence, not to stream quiet.
            if via_alt {
                self.alt_anchored = true;
            }
            Some(transition)
        } else {
            None
        }
    }

    fn commit_enter(
        &mut self,
        to: TuiMode,
        _now: Instant,
        rows: u16,
        via_alt_enter: bool,
        reason: &'static str,
    ) -> Option<TuiTransition> {
        if self.mode == to {
            return None;
        }
        self.mode = to;
        self.saw_alt_exit = false;
        self.stbm = false;
        self.last_ed = None;
        self.ed_home_watch = None;
        self.ed_home_rows.clear();
        self.last_tui_marker = None;
        self.repaint_armed = None;
        self.repaints.clear();
        self.probes.clear();
        self.weaks.clear();
        self.row_stamps.clear();
        self.extent_rows = vec![false; rows.max(1) as usize + 1];
        Some(TuiTransition {
            to,
            via_alt_enter,
            program_alt_exit: false,
            reason,
        })
    }

    /// Commit a pending strong candidate once the confirmation window
    /// has elapsed, the exit hold-off has passed, and a probed
    /// foreground is raw.
    fn confirm_pending(&mut self, now: Instant, rows: u16) -> Option<TuiTransition> {
        let Some((kind, reason, at)) = self.pending.take() else {
            return None;
        };
        if now.duration_since(at) < Duration::from_millis(ENTER_CONFIRM_MS) {
            self.pending = Some((kind, reason, at));
            return None;
        }
        // The signal itself fired inside the post-exit hold-off: drop
        // it (a prompt redraw is exactly what this prevents).
        if self.exit_hold_until.is_some_and(|until| at < until) {
            return None;
        }
        // A probed cooked foreground cannot run a TUI: strong and
        // repaint signals are vetoed (definitive signals are not).
        if !self.raw_mode.map_or(true, |raw| raw) {
            return None;
        }
        let to = match kind {
            EnterKind::Grid => TuiMode::Fullscreen,
            EnterKind::Repaint => TuiMode::Inline,
        };
        if to > self.mode {
            self.commit_enter(to, now, rows, false, reason)
        } else {
            None
        }
    }

    /// A TUI marker (cursor hide, non-home CUP) fired inside the
    /// fullscreen window: scrolled or windowed drawing may commit.
    fn marker_recent(&self, now: Instant) -> bool {
        self.last_tui_marker.is_some_and(|at| {
            now.duration_since(at) <= Duration::from_millis(FULLSCREEN_WINDOW_MS)
        })
    }

    fn on_csi(&mut self, signal: CsiSignal, now: Instant, rows: u16) -> Option<TuiTransition> {
        use CsiSignal::*;
        match signal {
            AltEnter => {
                self.saw_alt_exit = false;
                self.alt_open = true;
                self.commit_definitive(now, rows, true, "alt-enter")
            }
            AltExit => {
                self.saw_alt_exit = true;
                self.alt_open = false;
                None
            }
            CursorHidden => {
                self.cursor_hidden = true;
                self.hidden_since = Some(now);
                self.last_tui_marker = Some(now);
                None
            }
            CursorVisible => {
                self.cursor_hidden = false;
                self.hidden_since = None;
                None
            }
            SyncOutput => self.commit_definitive(now, rows, false, "sync-output"),
            MouseOrFocus => self.commit_definitive(now, rows, false, "mouse-focus"),
            KittyKeyboard => self.commit_definitive(now, rows, false, "kitty-keyboard"),
            AppCursorKeys => self.queue_strong(now, rows, EnterKind::Grid, "app-cursor-keys"),
            Decstbm => {
                self.stbm = true;
                if self.distinct_extent(rows) >= 2 {
                    self.commit_definitive(now, rows, false, "stbm-draw")
                } else {
                    None
                }
            }
            EraseDisplay23 => {
                // ED2/ED3 alone is not evidence (the shell's `clear`
                // sends it cooked): it only becomes strong when
                // multi-row drawing follows inside the fullscreen
                // window.
                self.last_ed = Some(now);
                // A whole-screen clear right after a bottom-to-top jump
                // is the shell's `clear` (home-then-ED order), not a
                // TUI frame rewind: drop the candidate the jump queued.
                // A real repaint re-queues through the drawing that
                // follows the clear.
                if self.pending.as_ref().is_some_and(|(kind, _, at)| {
                    kind == &EnterKind::Grid
                        && now.duration_since(*at)
                            <= Duration::from_millis(FULLSCREEN_WINDOW_MS)
                }) {
                    self.pending = None;
                }
                None
            }
            CursorUp(n) => {
                if n >= 2 {
                    self.repaint_armed = Some(now);
                }
                self.cursor_row = self.cursor_row.saturating_sub(n).max(1);
                self.cup_entered_row = false;
                None
            }
            ClearLineOrEraseDown => {
                if self
                    .repaint_armed
                    .is_some_and(|at| now.duration_since(at) <= Duration::from_millis(REPAINT_WINDOW_MS))
                {
                    self.repaint_armed = None;
                    self.repaints.push_back(now);
                    self.repaints
                        .retain(|at| now.duration_since(*at) <= Duration::from_millis(REPAINT_WINDOW_MS));
                    if self.repaints.len() >= 3 {
                        self.queue_strong(now, rows, EnterKind::Repaint, "inline-repaint");
                    }
                }
                None
            }
            CursorPosition { row } => {
                // Full-screen addressing: a jump from the bottom of the
                // grid (the bottom two rows) back to the top - the
                // frame rewind of a full-screen repaint. A mid-grid
                // jump is not evidence. The bottom must have been
                // *addressed* by a CUP, not reached by scrolling: a
                // PSReadLine startup clear scrolls the cursor to the
                // bottom with CRLFs and homes again, which is not a
                // frame rewind.
                let from_bottom =
                    self.cursor_row >= rows.saturating_sub(1) && self.cup_entered_row;
                let ed2_recent = self.last_ed.is_some_and(|ed| {
                    now.duration_since(ed) <= Duration::from_millis(FULLSCREEN_WINDOW_MS)
                });
                let target = row.clamp(1, rows.max(1));
                self.cursor_row = target;
                self.cup_entered_row = true;
                // Addressing a non-home row is a TUI marker: shell
                // cooked output positions the cursor only via home
                // (after ED2) and scrolling.
                if target > 1 {
                    self.last_tui_marker = Some(now);
                }
                if row == 1 && from_bottom && rows >= 4 && !ed2_recent {
                    // The rewind is not armed by a whole-screen clear:
                    // commit. (Needs a big-enough grid for the jump to
                    // be meaningful.)
                    self.ed_home_watch = None;
                    self.ed_home_rows.clear();
                    self.queue_strong(now, rows, EnterKind::Grid, "cup-rewind")
                } else if ed2_recent {
                    // ED2/ED3 + home is the shell's `clear` signature:
                    // hold the commit. Multi-row absolute CUPs
                    // (>= 3 distinct rows, matching the drawing rule)
                    // inside the window are the TUI repaint that
                    // `clear` does not produce.
                    let watch_open = self.ed_home_watch.is_some_and(|at| {
                        now.duration_since(at)
                            <= Duration::from_millis(FULLSCREEN_WINDOW_MS)
                    });
                    if !watch_open {
                        self.ed_home_watch = Some(now);
                        self.ed_home_rows.clear();
                    }
                    if target > 1 {
                        self.ed_home_rows.insert(target);
                        if self.ed_home_rows.len() >= 3 {
                            self.ed_home_watch = None;
                            self.ed_home_rows.clear();
                            self.queue_strong(now, rows, EnterKind::Grid, "ed2-multiline-cup")
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            Probe(family) => {
                self.probes.push_back((family, now));
                self.probes
                    .retain(|(_, at)| now.duration_since(*at) <= Duration::from_millis(PROBE_WINDOW_MS));
                let distinct = self
                    .probes
                    .iter()
                    .map(|(family, _)| *family)
                    .collect::<BTreeSet<u8>>()
                    .len();
                if distinct >= PROBE_FAMILIES_TO_STRONG {
                    self.queue_strong(now, rows, EnterKind::Grid, "probe-burst")
                } else {
                    None
                }
            }
            Weak => {
                self.weaks.push_back(now);
                self.weaks
                    .retain(|at| now.duration_since(*at) <= Duration::from_millis(PROBE_WINDOW_MS));
                if self.weaks.len() as u32 >= WEAK_TO_STRONG {
                    self.queue_strong(now, rows, EnterKind::Grid, "weak-signals")
                } else {
                    None
                }
            }
            NoSignal => None,
        }
    }

    fn on_osc(&mut self, payload: &str, now: Instant, rows: u16) -> Option<TuiTransition> {
        // OSC 133 shell-integration markers are ground truth: the shell
        // owns the foreground again.
        if let Some(code) = payload.strip_prefix("133;") {
            let marker = code.chars().next().unwrap_or('\0');
            if matches!(marker, 'A' | 'B' | 'C' | 'D') && self.mode != TuiMode::Canonical {
                return self.exit_to_canonical(now, "osc133");
            }
            return None;
        }
        if payload.starts_with("10;?") || payload.starts_with("11;?") || payload.starts_with("12;?") {
            return self.on_csi(CsiSignal::Probe(5), now, rows);
        }
        if payload.starts_with("0;") || payload.starts_with("2;") {
            return self.on_csi(CsiSignal::Weak, now, rows);
        }
        None
    }

    fn on_plain_byte(&mut self, byte: u8, now: Instant, rows: u16) {
        if byte == b'\n' {
            self.cursor_row = (self.cursor_row + 1).min(rows.max(1));
            // The new row was reached by scrolling, not addressing.
            self.cup_entered_row = false;
            return;
        }
        if byte.is_ascii_control() {
            return;
        }
        // Printable text lands on the tracked row; record the draw
        // extent for the fullscreen-addressing heuristics.
        let row = self.cursor_row as usize;
        if row < self.extent_rows.len() && !self.extent_rows[row] {
            self.extent_rows[row] = true;
            // TUI frames are drawn flicker-free: cursor hidden, rows
            // entered by absolute CUP. Shell listings scroll with the
            // cursor visible, and even when PSReadLine hides the
            // cursor to redraw the prompt it reaches the listing rows
            // by scrolling, stamping at most a handful of rows - far
            // below the threshold. A plain `ls` must not commit.
            if self.cursor_hidden && self.cup_entered_row {
                self.row_stamps.push_back((self.cursor_row, now));
            }
        }
        // A full-screen clear followed by multi-row drawing is the
        // classic TUI repaint - but only with a TUI marker (cursor
        // hide or row addressing). A bare `clear` followed by
        // newline-terminated command output (`clear; ls`) carries no
        // marker and stays canonical.
        if self
            .last_ed
            .is_some_and(|ed| now.duration_since(ed) <= Duration::from_millis(FULLSCREEN_WINDOW_MS))
            && self.distinct_extent(rows) >= 3
            && self.marker_recent(now)
        {
            self.queue_strong(now, rows, EnterKind::Grid, "ed2-multiline-draw");
        }
        // DECSTBM plus any drawing is a definitive fullscreen paint.
        if self.stbm && self.distinct_extent(rows) >= 2 {
            self.commit_definitive(now, rows, false, "stbm-draw");
        }
        // Cursor hidden long enough is a strong signal on its own.
        if self.cursor_hidden
            && self
                .hidden_since
                .is_some_and(|at| now.duration_since(at) >= Duration::from_millis(CURSOR_HIDDEN_MS))
        {
            self.queue_strong(now, rows, EnterKind::Grid, "cursor-hidden");
        }
        // Distinct-row writes inside the window: full-screen
        // addressing. As with the post-ED rule, the writes must be
        // accompanied by a TUI marker: a long `ls` listing scrolls
        // across half the grid without CUP addressing - the scrolled
        // rows stamp nothing, and its few CUP-targeted redraw rows
        // stay far below the threshold.
        self.row_stamps
            .retain(|(_, at)| now.duration_since(*at) <= Duration::from_millis(FULLSCREEN_WINDOW_MS));
        let distinct = self
            .row_stamps
            .iter()
            .map(|(row, _)| *row)
            .collect::<BTreeSet<u16>>();
        if rows >= 4 && distinct.len() >= (rows / 2) as usize && self.marker_recent(now) {
            self.queue_strong(now, rows, EnterKind::Grid, "distinct-rows");
        }
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
                    // Focus-event reporting: PSReadLine (plain pwsh)
                    // enables it at startup; the \x1b[I/\x1b[O focus
                    // events it produces are not TUI evidence.
                    1004 => NoSignal,
                    2004 => Weak,
                    1 => AppCursorKeys,
                    _ => NoSignal,
                },
                b'l' => match value {
                    1049 | 1047 | 1048 => AltExit,
                    25 => CursorHidden,
                    _ => NoSignal,
                },
                b't' if value == 18 || value == 14 => Probe(1),
                b'p' if intermediate == b'$' && groups.is_empty() => Probe(3), // DECRQM
                b'n' if value == 6 => Probe(4), // DSR
                b'c' => Probe(2), // DA1 (CSI ? c) and DA2 (CSI 0 ? c)
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
                b'J' => match value {
                    2 | 3 => EraseDisplay23,
                    _ => NoSignal,
                },
                b'K' => ClearLineOrEraseDown,
                b'A' => CursorUp(if groups.is_empty() { 1 } else { value as u16 }),
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
                b't' => {
                    if value == 18 || value == 14 {
                        Probe(1)
                    } else {
                        NoSignal
                    }
                }
                b'n' => {
                    if value == 6 {
                        Probe(4)
                    } else {
                        NoSignal
                    }
                }
                b'c' => {
                    if groups.is_empty() || first == 0 {
                        Probe(2) // DA1 / DA2
                    } else {
                        NoSignal
                    }
                }
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
    MouseOrFocus,
    KittyKeyboard,
    AppCursorKeys,
    Decstbm,
    EraseDisplay23,
    CursorUp(u16),
    ClearLineOrEraseDown,
    CursorPosition { row: u16 },
    /// Probe families: 1 window size (18t/14t), 2 DA, 3 DECRQM, 4 DSR,
    /// 5 OSC color query.
    Probe(u8),
    Weak,
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
    fn mouse_tracking_commits_fullscreen_immediately() {
        for seq in [
            "\x1b[?1000h",
            "\x1b[?1002h",
            "\x1b[?1003h\x1b[?1006h",
            "\x1b[?1005h",
            "\x1b[?1015h",
        ] {
            let out = feed(Instant::now(), 30, &[seq, "x"]);
            assert_eq!(out.len(), 1, "{seq}");
            assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
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
        // visible across half the grid. The listing stamps no rows
        // (visible), so the distinct-row rule cannot commit even
        // though a marker (non-home CUP) is recent.
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
    fn hidden_multi_row_frame_still_commits_fullscreen() {
        // The distinct-row rule still fires for real repaints: cursor
        // hidden, absolute CUP addressing across half the grid.
        let mut steps: Vec<(u64, String)> = vec![(10, "\x1b[?25l".into())];
        for row in 1..=20u16 {
            steps.push((5, format!("\x1b[{row};1Hrow {row}\r\n")));
        }
        steps.push((60, String::new()));
        let out = feed_timed_owned(30, &steps);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    #[test]
    fn pwsh_startup_clear_with_home_stays_canonical() {
        // PSReadLine startup: hide the cursor, clear all rows with
        // EL + CRLF (the cursor scrolls to the bottom row), then
        // home and show the cursor. The home from the bottom looks
        // like a frame rewind, but the bottom was reached by
        // scrolling, not a CUP, so cup-rewind must not fire.
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
    fn sync_output_is_a_definitive_enter_signal() {
        let out = feed(Instant::now(), 30, &["\x1b[?2026h", "frame"]);
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    #[test]
    fn kitty_keyboard_modes_are_definitive() {
        for seq in ["\x1b[>1u", "\x1b[>u", "\x1b[=2u", "\x1b[4;2m"] {
            let out = feed(Instant::now(), 30, &[seq, "x"]);
            assert_eq!(out.len(), 1, "{seq}");
            assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
        }
    }

    #[test]
    fn full_screen_addressing_commits_fullscreen_after_the_window() {
        // CUP jumps from the bottom of the grid to row 1, then a burst
        // of writes across most rows: a classic fullscreen TUI open.
        let mut steps: Vec<(u64, &str)> = vec![(10, "\x1b[30;1H")];
        for row in 1..=15u16 {
            let chunk = format!("\x1b[{row};1Htext\r\n");
            steps.push((1, chunk.leak()));
        }
        steps.push((60, "")); // let the confirmation window elapse
        let out = feed_timed(30, &steps);
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    #[test]
    fn ed2_plus_multiline_draw_commits_fullscreen() {
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?25l"),
                (5, "\x1b[2J\x1b[1;1H"),
                (5, "row one\r\nrow two\r\nrow three\r\n"),
                (60, ""),
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
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
    fn clear_then_command_output_stays_canonical() {
        // `clear; ls`: ED2 + home, then plain newline-terminated
        // command output - no cursor hide, no row addressing. Must
        // stay canonical so typing/resize/focus does not claim the
        // PTY grid (the pending candidate, if any, would only be
        // confirmed by the next chunk - the user's keystroke).
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
        // The rolling distinct-row rule (half the grid written inside
        // the window) also requires a TUI marker: a long `ls` listing
        // after `clear` scrolls across the grid without cursor hides
        // or row addressing, so it must not commit.
        let mut steps: Vec<(u64, String)> = vec![(10, "\x1b[2J\x1b[1;1H".into())];
        for row in 0..20 {
            steps.push((5, format!("entry {row}\r\n")));
        }
        steps.push((60, String::new()));
        let out = feed_timed_owned(30, &steps);
        assert!(out.is_empty());
    }

    #[test]
    fn cursor_hidden_scrolled_draw_commits_fullscreen() {
        // The marker gate is a requirement, not a veto on real
        // repaints: a cursor-hidden ED2 + multi-row draw (no CUPs) is
        // still a TUI.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?25l\x1b[2J"),
                (5, "row one\r\nrow two\r\nrow three\r\n"),
                (60, ""),
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    #[test]
    fn transitions_carry_the_firing_rule_as_reason() {
        // The sync debug log prints `reason=` per mode line; pin the
        // strings so a rename cannot silently break the log.
        let out = feed(Instant::now(), 30, &["\x1b[?1049h", "x"]);
        assert_eq!(out[0].reason, "alt-enter");

        let out = feed_timed(
            30,
            &[
                (10, "\x1b[30;1H"),
                (5, "\x1b[1;1H"),
                (60, ""),
            ],
        );
        assert_eq!(out[0].reason, "cup-rewind");

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
        // Home first, ED2 second: the jump queues a candidate, the
        // clear that follows drops it.
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
    fn ed2_home_repaint_with_multiline_cups_commits_fullscreen() {
        // ED2 + home is held as the `clear` signature; multi-row
        // absolute CUPs inside the window prove a TUI repaint.
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
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    #[test]
    fn ed2_home_with_a_two_row_prompt_stays_canonical() {
        // Two distinct CUP rows is a multi-line prompt redraw, not a
        // full-screen repaint (the threshold matches the drawing rule).
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
    fn probe_burst_commits_fullscreen() {
        // Three distinct probe families inside the burst window: a TUI
        // startup querying the terminal, not a shell prompt.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?c"),
                (5, "\x1b[?6n"),
                (5, "\x1b[18t"),
                (60, ""),
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
    }

    #[test]
    fn inline_repaint_pattern_commits_inline() {
        // Three CUU+EL bottom-region repaints: an inline bottom-region
        // app (fzf-style), not fullscreen.
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
        assert_eq!(out.len(), 1);
        assert_eq!(mode(&out[0]), TuiMode::Inline);
    }

    #[test]
    fn inline_upgrades_to_fullscreen_on_alt_enter() {
        let mut clf = TuiClassifier::new(30);
        let mut at = Instant::now();
        for _ in 0..3 {
            at += Duration::from_millis(5);
            clf.feed("\x1b[3A\x1b[2Kline\r\n", at, 30);
        }
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_some()); // inline commit
        at += Duration::from_millis(5);
        let upgrade = clf.feed("\x1b[?1049h", at, 30).expect("alt enter upgrades");
        assert_eq!(mode(&upgrade), TuiMode::Fullscreen);
    }

    #[test]
    fn exit_hold_prevents_a_prompt_redraw_bounce() {
        // Exit fullscreen, then a prompt redraw (clear + a few rows)
        // inside the hold-off: the strong signal is dropped, so the only
        // transitions are the enter and the exit.
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
        // A stream-anchored fullscreen TUI (no alt screen of its own)
        // leaves: the prompt is newline-terminated and the stream goes
        // quiet.
        let out = feed_timed(
            30,
            &[
                (10, "\x1b[?25l"),
                (5, "\x1b[2J\x1b[1;1H"),
                (5, "row one\r\nrow two\r\nrow three\r\n"),
                (60, ""), // strong commit to fullscreen
                (5, "done\r\n\x1b[?25h"),
                (520, "PS C:\\> "),
            ],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(mode(&out[0]), TuiMode::Fullscreen);
        assert_eq!(mode(&out[1]), TuiMode::Canonical);
        assert!(!out[1].program_alt_exit);
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

    #[test]
    fn a_cooked_foreground_vetoes_strong_signals() {
        let mut clf = TuiClassifier::new(30);
        clf.set_raw_mode(false);
        let mut at = Instant::now();
        at += Duration::from_millis(10);
        clf.feed("\x1b[2J\x1b[1;1H", at, 30);
        at += Duration::from_millis(5);
        clf.feed("row one\r\nrow two\r\nrow three\r\n", at, 30);
        at += Duration::from_millis(60);
        assert!(clf.feed("", at, 30).is_none()); // strong, but cooked
        at += Duration::from_millis(5);
        // Definitive signals are not vetoed.
        assert!(clf.feed("\x1b[?2026h", at, 30).is_some());
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
}
