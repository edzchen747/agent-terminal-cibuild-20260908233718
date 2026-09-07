//! Per-session active/idle detection.
//!
//! A tab is `Active` when its shell is blocked waiting for a foreground
//! program to finish, and `Idle` when the shell owns its prompt and is
//! waiting for the user. `status: running` already tells clients the
//! *shell* is alive; this tells them whether the tab is doing anything.
//!
//! Three signals feed the state, in this precedence:
//!
//! 1. **OSC 133 shell-integration markers** ([`ShellMarker`]), drained
//!    from `TuiClassifier::take_shell_markers`. `C` means the shell
//!    handed the foreground to a command; `A`/`B`/`D` mean it has the
//!    prompt back. These are the only signal that is correct for a
//!    program which prints *nothing* - `sleep 30`, an installer before
//!    its first line of output, anything blocked on stdin - because
//!    silence is indistinguishable from a prompt in the byte stream.
//!    The markers the classifier hands over are already filtered to
//!    those the shell emitted: one painted inside a synchronized-output
//!    bracket is an inline harness marking its own composer, and
//!    counting those flipped the state at repaint rate.
//!
//! 2. **TUI mode.** A non-`Canonical` period *is* a blocked shell, so
//!    `vim`, `htop`, `lazygit` and agent harnesses read as active in
//!    every shell, integrated or not. But a blocked shell is only
//!    *busy* while its program is actually doing something: while the
//!    screen is still changing (a fresh output chunk, i.e. not
//!    `tui_quiet`) the period reads active, and once the screen has
//!    been quiet for [`TUI_QUIET_MS`] the program is waiting - on
//!    keys, on a timer, on the user - and the badge drops to idle.
//!    That matches Windows Terminal, where a terminal whose screen has
//!    stopped changing shows no busy indicator. This matters even with
//!    integration: our PowerShell and cmd hooks emit `A`/`B`/`D` but no
//!    `C`, so between the prompt and the command's end the markers say
//!    nothing at all.
//!
//! 3. **Input and stream quiet**, the fallback for a shell we could not
//!    hook. A submitted line (input containing CR/LF) starts a command;
//!    line-terminated output that then goes quiet for
//!    `STREAM_EXIT_QUIET_MS` is the shell back at a prompt - the same
//!    predicate `TuiClassifier::quiet_idle` uses to end a TUI period.
//!
//! The quiet half of signal 3 is switched off for good once a session
//! has produced a real shell marker (`integrated`). Keeping both would
//! mean the weakest signal could contradict the strongest one: a build
//! that stalls silently for a second would go idle underneath an
//! outstanding `C`. The input half is *not* switched off, because it is
//! what covers the `A`/`B`/`D`-only shells described above.
//!
//! Publication is asymmetric on purpose. `Idle` is announced as soon as
//! it is observed, but `Active` has to hold for [`ACTIVE_MIN_MS`] first,
//! so `ls` and `git status` do not blink a badge on and off in the tab
//! strip. That deferral is also why the host needs a sweeper: idle is
//! discovered by a *timeout*, and a session that has gone quiet produces
//! no chunk to discover it on.

use chrono::Utc;
use std::time::{Duration, Instant};

use crate::models::{SessionActivity, TuiMode};
use crate::tui::ShellMarker;

/// An observed `Active` must hold this long before clients are told, so a
/// command that finishes in a few milliseconds never flashes a badge.
pub const ACTIVE_MIN_MS: u64 = 250;

/// A TUI period whose screen has been quiet this long is no longer doing
/// something visible: its `Active` badge drops to `Idle` until a new
/// output chunk lands (which re-earns `Active` through the ordinary
/// [`ACTIVE_MIN_MS`] delay). TUIs that are actively redrawing - htop's
/// 1 Hz refresh, an agent harness repainting its composer band - land
/// their next frame well inside this window and stay active, while an
/// idle one (a paused htop, a waiting pager, a stopped harness) goes
/// quiet and reports `Idle`, the way Windows Terminal shows no busy
/// indicator for a terminal whose screen has stopped changing.
pub const TUI_QUIET_MS: u64 = 2000;

pub struct ActivityDetector {
    /// The last state announced to clients.
    published: SessionActivity,
    /// When `published` was announced, RFC3339, for the wire.
    since: String,
    /// What the signals currently imply, before the publication delay.
    observed: SessionActivity,
    /// When `observed` last changed.
    observed_at: Instant,
    /// A genuine shell marker has been seen, so the quiet heuristic is
    /// retired for this session.
    integrated: bool,
    /// A line was submitted and no output has arrived since. Until some
    /// does, quiet is the gap before the command's first byte, not a
    /// prompt.
    awaiting_output: bool,
}

impl ActivityDetector {
    pub fn new(now: Instant) -> Self {
        Self {
            published: SessionActivity::Idle,
            since: Utc::now().to_rfc3339(),
            observed: SessionActivity::Idle,
            observed_at: now,
            integrated: false,
            awaiting_output: false,
        }
    }

    pub fn state(&self) -> SessionActivity {
        self.published
    }

    pub fn since(&self) -> &str {
        &self.since
    }

    /// Whether this session has ever produced a real OSC 133 marker.
    #[cfg(test)]
    pub fn integrated(&self) -> bool {
        self.integrated
    }

    /// Apply the signals available after a classifier `feed`, or - with
    /// `saw_output` false and no markers - a sweeper tick. `quiet_idle`
    /// is the classifier's shell-prompt verdict (canonical mode only) and
    /// `tui_quiet` says the TUI screen has been quiet for
    /// [`TUI_QUIET_MS`] (TUI modes only). Returns the new
    /// state and its timestamp only when what clients have been told
    /// changes.
    pub fn observe(
        &mut self,
        markers: &[ShellMarker],
        mode: TuiMode,
        quiet_idle: bool,
        tui_quiet: bool,
        saw_output: bool,
        now: Instant,
    ) -> Option<(SessionActivity, String)> {
        if saw_output {
            self.awaiting_output = false;
        }

        let mut next = self.observed;
        match mode {
            TuiMode::Canonical => {
                if !self.integrated && !self.awaiting_output && quiet_idle {
                    next = SessionActivity::Idle;
                }
            }
            // A TUI period is a blocked shell, but only a redrawing one is
            // busy: while the program's screen is still changing (not
            // `tui_quiet`) it reads active, and a screen that has been
            // quiet for `TUI_QUIET_MS` reads idle (see the module docs
            // for the Windows Terminal reference).
            TuiMode::Inline | TuiMode::Fullscreen => {
                next = if tui_quiet {
                    SessionActivity::Idle
                } else {
                    SessionActivity::Active
                };
            }
        }
        // Markers land last: they are the strongest evidence, and a `D`
        // arrives in the same chunk that returned the mode to canonical.
        for marker in markers {
            self.integrated = true;
            self.awaiting_output = false;
            next = match marker {
                ShellMarker::CommandStart => SessionActivity::Active,
                ShellMarker::PromptStart
                | ShellMarker::PromptEnd
                | ShellMarker::CommandEnd { .. } => SessionActivity::Idle,
            };
        }

        self.set_observed(next, now);
        self.settle(now)
    }

    /// The user submitted a line, so a command is starting. This stands in
    /// for `OSC 133 ; C` in the shells whose prompt hooks can only report
    /// the prompt itself.
    pub fn on_input_line(&mut self, now: Instant) -> Option<(SessionActivity, String)> {
        self.awaiting_output = true;
        self.set_observed(SessionActivity::Active, now);
        self.settle(now)
    }

    /// The shell exited. An exited tab must never keep a busy badge, and
    /// no further signal is coming to clear it.
    pub fn on_exit(&mut self, now: Instant) -> Option<(SessionActivity, String)> {
        self.integrated = false;
        self.awaiting_output = false;
        self.set_observed(SessionActivity::Idle, now);
        self.settle(now)
    }

    fn set_observed(&mut self, next: SessionActivity, now: Instant) {
        if next != self.observed {
            self.observed = next;
            self.observed_at = now;
        }
    }

    /// Publish the observed state if it differs from what clients hold and
    /// has earned the right to be announced.
    fn settle(&mut self, now: Instant) -> Option<(SessionActivity, String)> {
        if self.observed == self.published {
            return None;
        }
        if self.observed == SessionActivity::Active
            && now.duration_since(self.observed_at) < Duration::from_millis(ACTIVE_MIN_MS)
        {
            return None;
        }
        self.published = self.observed;
        self.since = Utc::now().to_rfc3339();
        Some((self.published, self.since.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: &[ShellMarker] = &[];

    fn detector() -> (ActivityDetector, Instant) {
        let at = Instant::now();
        (ActivityDetector::new(at), at)
    }

    fn advance(at: &mut Instant, ms: u64) -> Instant {
        *at += Duration::from_millis(ms);
        *at
    }

    /// Hold an observed `Active` past the publication delay.
    fn settle_active(detector: &mut ActivityDetector, at: &mut Instant) -> Option<SessionActivity> {
        settle_active_full(detector, at).map(|(state, _)| state)
    }

    /// The same, keeping the announced timestamp.
    fn settle_active_full(
        detector: &mut ActivityDetector,
        at: &mut Instant,
    ) -> Option<(SessionActivity, String)> {
        let now = advance(at, ACTIVE_MIN_MS);
        detector.observe(NONE, TuiMode::Canonical, false, false, false, now)
    }

    #[test]
    fn a_new_session_is_idle() {
        let (detector, _) = detector();
        assert_eq!(detector.state(), SessionActivity::Idle);
    }

    #[test]
    fn a_command_start_marker_goes_active_and_a_command_end_returns_to_idle() {
        let (mut detector, mut at) = detector();
        assert_eq!(
            detector.observe(
                &[ShellMarker::CommandStart],
                TuiMode::Canonical,
                false,
                false,
                true,
                at
            ),
            None,
            "active is held back until it has lasted ACTIVE_MIN_MS"
        );
        assert_eq!(
            settle_active(&mut detector, &mut at),
            Some(SessionActivity::Active)
        );

        let now = advance(&mut at, 4_000);
        let end = detector.observe(
            &[ShellMarker::CommandEnd { exit_code: Some(0) }],
            TuiMode::Canonical,
            false,
            false,
            true,
            now,
        );
        assert_eq!(end.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn a_prompt_marker_is_idle() {
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 50);
        let out = detector.observe(
            &[ShellMarker::PromptStart],
            TuiMode::Canonical,
            false,
            false,
            true,
            now,
        );
        assert_eq!(out.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn a_silent_command_stays_active_in_an_integrated_shell() {
        // The case the whole design exists for: `sleep 30` prints nothing,
        // so the stream is quiet the entire time it runs. Only the markers
        // can tell that apart from a prompt.
        let (mut detector, mut at) = detector();
        detector.observe(
            &[ShellMarker::CommandStart],
            TuiMode::Canonical,
            false,
            false,
            true,
            at,
        );
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        for _ in 0..40 {
            let now = advance(&mut at, 250);
            assert_eq!(
                detector.observe(NONE, TuiMode::Canonical, true, false, false, now),
                None,
                "quiet must not contradict an outstanding command-start"
            );
        }
        assert_eq!(detector.state(), SessionActivity::Active);
    }

    #[test]
    fn a_tui_period_is_active_while_its_screen_is_changing() {
        // PowerShell and cmd report A/B/D but never C, so between the
        // prompt and the command's end the markers are silent and the TUI
        // mode is the only thing holding the tab active - but only while
        // the program is still redrawing its screen.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        // Frames keep landing, each one restarting the quiet window, so
        // the badge never drops while the TUI is alive.
        for _ in 0..20 {
            let now = advance(&mut at, 250);
            assert_eq!(
                detector.observe(NONE, TuiMode::Fullscreen, false, false, true, now),
                None,
                "a redrawing TUI keeps the badge"
            );
        }

        let now = advance(&mut at, 250);
        let exit = detector.observe(
            &[ShellMarker::CommandEnd { exit_code: None }],
            TuiMode::Canonical,
            false,
            false,
            true,
            now,
        );
        assert_eq!(exit.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn a_quiet_tui_period_drops_to_idle() {
        // An idle TUI (a paused htop, a waiting pager, a stopped agent
        // harness) stops redrawing; once the screen has been quiet for
        // TUI_QUIET_MS the badge must drop, the way Windows Terminal
        // shows no busy indicator for a terminal whose screen has
        // stopped changing.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        for _ in 0..(TUI_QUIET_MS / 250 - 1) {
            let now = advance(&mut at, 250);
            assert_eq!(
                detector.observe(NONE, TuiMode::Fullscreen, true, false, false, now),
                None,
                "the quiet gap has not reached TUI_QUIET_MS yet"
            );
            assert_eq!(detector.state(), SessionActivity::Active);
        }
        let now = advance(&mut at, 250); // the quiet gap now reaches TUI_QUIET_MS
        let idle = detector.observe(NONE, TuiMode::Fullscreen, true, true, false, now);
        assert_eq!(idle.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn new_output_wakes_a_quiet_tui_period() {
        // The TUI redraws after going quiet: the badge must come back,
        // earning its own publication delay like any other Active.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);

        let now = advance(&mut at, TUI_QUIET_MS);
        assert_eq!(
            detector
                .observe(NONE, TuiMode::Fullscreen, true, true, false, now)
                .map(|(state, _)| state),
            Some(SessionActivity::Idle),
            "a frozen screen is idle"
        );

        let now = advance(&mut at, 50);
        assert_eq!(
            detector.observe(NONE, TuiMode::Fullscreen, false, false, true, now),
            None,
            "the fresh frame restarts the quiet window, but Active is held back"
        );
        let now = advance(&mut at, ACTIVE_MIN_MS);
        let out = detector.observe(NONE, TuiMode::Fullscreen, false, false, true, now);
        assert_eq!(out.map(|(state, _)| state), Some(SessionActivity::Active));
    }

    #[test]
    fn a_brief_tui_period_that_goes_quiet_announces_nothing() {
        // A TUI that lived less than ACTIVE_MIN_MS went quiet before
        // its Active could publish: the badge must not flicker on and
        // then off for clients.
        let (mut detector, mut at) = detector();
        assert_eq!(
            detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at),
            None,
            "the Active is held back by the publication delay"
        );
        let now = advance(&mut at, TUI_QUIET_MS);
        assert_eq!(
            detector.observe(NONE, TuiMode::Fullscreen, true, true, false, now),
            None,
            "the quiet flip landed on a state clients never saw"
        );
        assert_eq!(detector.state(), SessionActivity::Idle);
    }

    #[test]
    fn typing_into_a_quiet_tui_does_not_hold_the_badge() {
        // Keystrokes into an idle TUI are consumed by the program, not
        // a shell command: the input-line heuristic must not override
        // the quiet rule, or a paused htop would earn the badge back
        // every time the user presses a key.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, TUI_QUIET_MS);
        assert_eq!(
            detector
                .observe(NONE, TuiMode::Fullscreen, true, true, false, now)
                .map(|(state, _)| state),
            Some(SessionActivity::Idle),
            "the frozen screen drops the badge"
        );

        detector.on_input_line(advance(&mut at, 500));
        assert_eq!(detector.state(), SessionActivity::Idle);

        // The next sweeper tick sees the screen still quiet: the input
        // line's Active never got published, so nothing is announced.
        let now = advance(&mut at, 250);
        assert_eq!(
            detector.observe(NONE, TuiMode::Fullscreen, true, true, false, now),
            None,
            "the quiet rule reasserts the idle the badge already dropped"
        );
        assert_eq!(detector.state(), SessionActivity::Idle);
    }

    #[test]
    fn a_command_end_landing_on_a_quiet_tui_is_silent() {
        // The screen had already gone quiet, so the D that hands the
        // shell back its prompt must not re-announce an idle the badge
        // already dropped.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);

        let now = advance(&mut at, TUI_QUIET_MS);
        assert_eq!(
            detector
                .observe(NONE, TuiMode::Fullscreen, true, true, false, now)
                .map(|(state, _)| state),
            Some(SessionActivity::Idle)
        );

        let now = advance(&mut at, 100);
        assert_eq!(
            detector.observe(
                &[ShellMarker::CommandEnd { exit_code: Some(0) }],
                TuiMode::Canonical,
                false,
                false,
                true,
                now,
            ),
            None,
            "idle is already what clients hold"
        );
    }

    #[test]
    fn exiting_a_quiet_tui_announces_nothing_twice() {
        // The quiet drop and the exit both land on Idle: only the first
        // may announce.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);

        let now = advance(&mut at, TUI_QUIET_MS);
        assert_eq!(
            detector
                .observe(NONE, TuiMode::Fullscreen, true, true, false, now)
                .map(|(state, _)| state),
            Some(SessionActivity::Idle)
        );
        let now = advance(&mut at, 100);
        assert_eq!(
            detector.on_exit(now),
            None,
            "the badge already dropped when the screen went quiet"
        );
    }

    #[test]
    fn the_tui_quiet_boundary_is_exactly_tui_quiet_ms() {
        // The host computes `quiet_ms(now) >= TUI_QUIET_MS`, so one
        // millisecond short of the window the screen still reads busy
        // and the window's last millisecond flips it to idle.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);

        let now = advance(&mut at, TUI_QUIET_MS - 1);
        assert_eq!(
            detector.observe(NONE, TuiMode::Fullscreen, true, false, false, now),
            None,
            "one millisecond short of the window the screen still reads busy"
        );
        let now = advance(&mut at, 1); // the quiet gap now reaches TUI_QUIET_MS
        assert_eq!(
            detector
                .observe(NONE, TuiMode::Fullscreen, true, true, false, now)
                .map(|(state, _)| state),
            Some(SessionActivity::Idle)
        );
    }

    #[test]
    fn a_quiet_inline_tui_drops_to_idle_too() {
        // Inline TUIs (composer bands) share the quiet rule: the badge
        // follows the band's redraws, not the period's duration.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Inline, false, false, true, at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, TUI_QUIET_MS);
        assert_eq!(
            detector
                .observe(NONE, TuiMode::Inline, true, true, false, now)
                .map(|(state, _)| state),
            Some(SessionActivity::Idle)
        );
    }

    #[test]
    fn an_inline_tui_is_active_without_any_shell_integration() {
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Inline, false, false, true, at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);
        assert!(!detector.integrated());
    }

    #[test]
    fn an_unintegrated_shell_falls_back_to_input_and_quiet() {
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        // Output flows for a while, then the prompt comes back.
        let now = advance(&mut at, 300);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, false, false, true, now),
            None
        );
        let now = advance(&mut at, 600);
        let idle = detector.observe(NONE, TuiMode::Canonical, true, false, false, now);
        assert_eq!(idle.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn quiet_before_a_first_output_byte_is_not_a_prompt() {
        // Without this guard the gap between Enter and a slow command's
        // first byte reads exactly like a prompt.
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        settle_active(&mut detector, &mut at);

        let now = advance(&mut at, 900);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, true, false, false, now),
            None,
            "no output has arrived since the line was submitted"
        );
        assert_eq!(detector.state(), SessionActivity::Active);
    }

    #[test]
    fn a_brief_command_never_publishes_active() {
        let (mut detector, mut at) = detector();
        assert_eq!(detector.on_input_line(at), None);
        let now = advance(&mut at, 40);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, false, false, true, now),
            None
        );
        let now = advance(&mut at, 600);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, true, false, false, now),
            None,
            "the tab was never announced active, so there is nothing to clear"
        );
        assert_eq!(detector.state(), SessionActivity::Idle);
    }

    #[test]
    fn the_quiet_heuristic_retires_once_a_marker_is_seen() {
        let (mut detector, mut at) = detector();
        assert!(!detector.integrated());
        detector.observe(
            &[ShellMarker::PromptEnd],
            TuiMode::Canonical,
            false,
            false,
            true,
            at,
        );
        assert!(detector.integrated());

        let now = advance(&mut at, 10);
        detector.on_input_line(now);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 5_000);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, true, false, false, now),
            None
        );
        assert_eq!(
            detector.state(),
            SessionActivity::Active,
            "an integrated shell waits for its own D marker"
        );
    }

    #[test]
    fn an_exited_shell_drops_its_badge() {
        let (mut detector, mut at) = detector();
        detector.observe(
            &[ShellMarker::CommandStart],
            TuiMode::Canonical,
            false,
            false,
            true,
            at,
        );
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 10);
        let exit = detector.on_exit(now);
        assert_eq!(exit.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn the_last_marker_in_a_chunk_decides() {
        // A prompt arrives as `D` then `A` then `B` in one write, and the
        // host merges PTY reads before classifying, so a whole
        // command-end-plus-prompt often lands in a single chunk.
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 500);
        let out = detector.observe(
            &[
                ShellMarker::CommandEnd { exit_code: Some(0) },
                ShellMarker::PromptStart,
                ShellMarker::PromptEnd,
            ],
            TuiMode::Canonical,
            false,
            false,
            true,
            now,
        );
        assert_eq!(out.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn a_prompt_followed_by_a_command_start_in_one_chunk_ends_active() {
        // The reverse order, which is what a `PS0` command-start looks
        // like when it is merged with the prompt that preceded it.
        let (mut detector, mut at) = detector();
        detector.observe(
            &[ShellMarker::PromptEnd, ShellMarker::CommandStart],
            TuiMode::Canonical,
            false,
            false,
            true,
            at,
        );
        assert_eq!(
            settle_active(&mut detector, &mut at),
            Some(SessionActivity::Active)
        );
    }

    #[test]
    fn a_command_end_wins_over_a_stale_tui_mode() {
        // The classifier exits to canonical on the same marker, but the
        // detector must not depend on the order those two land in.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);

        let now = advance(&mut at, 100);
        let out = detector.observe(
            &[ShellMarker::CommandEnd { exit_code: None }],
            TuiMode::Fullscreen,
            false,
            false,
            true,
            now,
        );
        assert_eq!(out.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn leaving_a_tui_holds_active_until_the_prompt_is_back() {
        // `q` in a pager returns the mode to canonical instantly, but the
        // shell has not printed its prompt yet. Going idle on the mode
        // change alone would blink the badge off and on between the two.
        let (mut detector, mut at) = detector();
        detector.observe(NONE, TuiMode::Fullscreen, false, false, true, at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 10);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, false, false, true, now),
            None,
            "the mode dropped but nothing says the shell has the prompt"
        );
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 600);
        let idle = detector.observe(NONE, TuiMode::Canonical, true, false, false, now);
        assert_eq!(idle.map(|(state, _)| state), Some(SessionActivity::Idle));
    }

    #[test]
    fn a_session_that_never_ran_anything_stays_quietly_idle() {
        // The shell prints its banner and prompt at startup, then sits
        // there. None of that may announce a state clients already hold.
        let (mut detector, mut at) = detector();
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, false, false, true, at),
            None
        );
        for _ in 0..10 {
            let now = advance(&mut at, 250);
            assert_eq!(
                detector.observe(NONE, TuiMode::Canonical, true, false, false, now),
                None,
                "idle was never left, so there is nothing to announce"
            );
        }
        assert_eq!(detector.state(), SessionActivity::Idle);
    }

    #[test]
    fn a_second_line_submitted_mid_command_announces_nothing_new() {
        // Typing into a running program sends more lines; the tab is
        // already active and must not re-announce it.
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        settle_active(&mut detector, &mut at);
        assert_eq!(detector.state(), SessionActivity::Active);

        let now = advance(&mut at, 50);
        assert_eq!(detector.on_input_line(now), None);
        assert_eq!(detector.state(), SessionActivity::Active);
    }

    #[test]
    fn exiting_an_already_idle_session_announces_nothing() {
        let (mut detector, at) = detector();
        assert_eq!(detector.on_exit(at), None);
        assert_eq!(detector.state(), SessionActivity::Idle);
    }

    #[test]
    fn the_publication_delay_restarts_for_each_new_command() {
        // The delay is measured from when Active was last *observed*, not
        // from session start, so a long-running command after a burst of
        // short ones still has to earn its badge the same way.
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        let now = advance(&mut at, 40);
        detector.observe(NONE, TuiMode::Canonical, false, false, true, now);
        let now = advance(&mut at, 600);
        detector.observe(NONE, TuiMode::Canonical, true, false, false, now);
        assert_eq!(detector.state(), SessionActivity::Idle, "too brief to show");

        detector.on_input_line(advance(&mut at, 10));
        let now = advance(&mut at, ACTIVE_MIN_MS - 1);
        assert_eq!(
            detector.observe(NONE, TuiMode::Canonical, false, false, true, now),
            None,
            "the second command is still inside its own delay"
        );
        assert_eq!(
            settle_active(&mut detector, &mut at),
            Some(SessionActivity::Active)
        );
    }

    #[test]
    fn each_announcement_restamps_the_since_time() {
        let (mut detector, mut at) = detector();
        let opened = detector.since().to_string();
        detector.on_input_line(at);
        let (_, active_since) = settle_active_full(&mut detector, &mut at).expect("active");
        assert_ne!(active_since, opened, "the badge carries its own start time");

        let now = advance(&mut at, 100);
        detector.observe(NONE, TuiMode::Canonical, false, false, true, now);
        let now = advance(&mut at, 700);
        let (_, idle_since) = detector
            .observe(NONE, TuiMode::Canonical, true, false, false, now)
            .expect("idle");
        assert_eq!(idle_since, detector.since());
    }

    #[test]
    fn a_published_change_carries_a_timestamp() {
        let (mut detector, mut at) = detector();
        detector.on_input_line(at);
        let now = advance(&mut at, ACTIVE_MIN_MS);
        let (state, since) = detector
            .observe(NONE, TuiMode::Canonical, false, false, false, now)
            .expect("active is published");
        assert_eq!(state, SessionActivity::Active);
        assert_eq!(since, detector.since());
        assert!(chrono::DateTime::parse_from_rfc3339(&since).is_ok());
    }
}
