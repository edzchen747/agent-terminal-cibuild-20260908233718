//! The per-session taskbar progress state machine and the window-level
//! combine.
//!
//! A session's taskbar indicator has three inputs, and the state shown is
//! the most recent of them in this order of authority:
//!
//! 1. An explicit ConEmu `OSC 9;4` report from the foreground program
//!    (`0` clear, `1` value, `2` error, `3` indeterminate, `4` paused).
//!    Windows Terminal keeps this state until the program reports again
//!    or the process exits, and we do the same.
//! 2. The shell's command lifecycle, which covers programs that report
//!    nothing: a running command is an indeterminate spinner, and a
//!    non-zero exit leaves an error state until the next command starts.
//! 3. Process exit, which clears everything.
//!
//! A window's taskbar button shows one state per window, and it follows
//! the project's *last-ran* command: the running command that started
//! most recently is the one the button animates (its progress or
//! spinner), and when that command finishes the next-newest still
//! running command takes over, and so on, until none are left
//! ([`window_state`]). The order comes from each session's recorded
//! command start time. When no command is running, the button falls
//! back to the highest-priority state of the project's sessions
//! (Windows Terminal's group rule, microsoft/terminal #10755): error,
//! paused, value, indeterminate, clear - which is how a just-failed
//! exit keeps its error marker until the next command starts.

use std::time::Instant;

use crate::models::{SessionActivity, TaskbarProgress};

/// One session's taskbar progress, the most recent state from its
/// program reports and shell command lifecycle.
#[derive(Clone, Debug, Default)]
pub struct SessionTaskbar {
    /// The latest explicit program report, `None` when it has been
    /// cleared or never arrived.
    explicit: Option<TaskbarProgress>,
    /// The shell's last command is still running: an implicit spinner
    /// while no explicit state exists.
    command_running: bool,
    /// When the shell's current command started, recorded while it runs
    /// so the window's last-ran rule can order the project's running
    /// commands by start time; `None` while no command runs.
    command_started_at: Option<Instant>,
    /// The shell's last command exited non-zero: an error state that
    /// stays until the next command starts, so a failed run is visible
    /// instead of silently going clear.
    failed_exit: bool,
}

impl SessionTaskbar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies an explicit ConEmu `OSC 9;4` report. Returns whether the
    /// session's effective state changed, so the host only re-broadcasts
    /// and re-pushes the taskbar when something the user can see moved.
    pub fn apply_report(&mut self, report: TaskbarProgress) -> bool {
        let before = self.effective();
        match report {
            TaskbarProgress::Clear => {
                self.explicit = None;
                self.command_running = false;
                self.failed_exit = false;
            }
            _ => self.explicit = Some(report),
        }
        self.changed_since(before)
    }

    /// Reacts to a published shell activity change. An active command is
    /// an indeterminate spinner while no explicit state exists, and a new
    /// command also clears the previous run's lingering error. The
    /// command's start is recorded (`now`) for the window's last-ran
    /// ordering, and an idle shell ends the recorded command.
    pub fn on_activity(&mut self, activity: SessionActivity, now: Instant) -> bool {
        let before = self.effective();
        match activity {
            SessionActivity::Active => {
                self.failed_exit = false;
                if self.explicit.is_none() {
                    self.command_running = true;
                }
                // A published `Active` begins a command run: record its
                // start so the window's button can order the project's
                // running commands by it. A re-published `Active` (a
                // quiet TUI period waking back up) begins a new run and
                // restamps the start time.
                self.command_started_at = Some(now);
            }
            SessionActivity::Idle => {
                self.command_running = false;
                self.command_started_at = None;
            }
        }
        self.changed_since(before)
    }

    /// Records that the shell's last command exited non-zero. The error
    /// state only shows while no explicit state is set; the next command
    /// clears it again.
    pub fn on_failed_exit(&mut self) -> bool {
        let before = self.effective();
        self.failed_exit = true;
        self.changed_since(before)
    }

    /// The session's process exited: every indicator it owned is gone.
    pub fn on_exit(&mut self) -> bool {
        let before = self.effective();
        self.explicit = None;
        self.command_running = false;
        self.command_started_at = None;
        self.failed_exit = false;
        self.changed_since(before)
    }

    /// When the shell's current command started, `None` while no command
    /// runs. The window's last-ran rule orders the project's running
    /// commands by it (see [`window_state`]).
    pub fn command_started_at(&self) -> Option<Instant> {
        self.command_started_at
    }

    /// The taskbar state the session currently contributes.
    pub fn effective(&self) -> TaskbarProgress {
        if let Some(explicit) = self.explicit {
            return explicit;
        }
        if self.command_running {
            return TaskbarProgress::Indeterminate;
        }
        if self.failed_exit {
            return TaskbarProgress::Error(0);
        }
        TaskbarProgress::Clear
    }

    fn changed_since(&self, before: TaskbarProgress) -> bool {
        self.effective() != before
    }
}

/// The state a window's taskbar button shows: the highest-priority state
/// of its sessions, Windows Terminal's group rule for combining the
/// states of a window's tabs (error, paused, value, indeterminate,
/// clear). An empty set is clear.
pub fn combine(states: impl IntoIterator<Item = TaskbarProgress>) -> TaskbarProgress {
    states
        .into_iter()
        .min_by_key(TaskbarProgress::priority)
        .unwrap_or(TaskbarProgress::Clear)
}

/// One session's contribution to its window's taskbar button under the
/// last-ran rule: its effective state and, while a command is running,
/// when that command started.
#[derive(Clone, Copy, Debug)]
pub struct WindowTaskbarCandidate {
    /// When the session's current command started, `None` while no
    /// command runs (the session then only carries a lingering state,
    /// such as a failed exit's error or a report that outlived its
    /// command).
    pub started_at: Option<Instant>,
    /// The session's effective taskbar state.
    pub state: TaskbarProgress,
}

/// The state a window's taskbar button shows under the last-ran rule:
/// the most-recently-started still-running command owns the button, so
/// it animates the project's last-ran process command, and when that
/// command finishes the next-newest still-running command takes over,
/// and so on, until none are left. When no command is running, the
/// button falls back to the group rule's highest-priority state of the
/// sessions' states, so a just-failed exit keeps its error marker until
/// the next command starts.
pub fn window_state(
    candidates: impl IntoIterator<Item = WindowTaskbarCandidate>,
) -> TaskbarProgress {
    let candidates: Vec<_> = candidates.into_iter().collect();
    match candidates
        .iter()
        .filter(|candidate| candidate.started_at.is_some())
        .max_by_key(|candidate| candidate.started_at)
    {
        Some(winner) => winner.state,
        None => combine(candidates.iter().map(|candidate| candidate.state)),
    }
}

impl TaskbarProgress {
    /// Lower numbers win the window's taskbar button.
    pub fn priority(&self) -> u8 {
        match self {
            TaskbarProgress::Error(_) => 0,
            TaskbarProgress::Paused(_) => 1,
            TaskbarProgress::Value(_) => 2,
            TaskbarProgress::Indeterminate => 3,
            TaskbarProgress::Clear => 4,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn report(state: u8, progress: u32) -> TaskbarProgress {
        match state {
            0 => TaskbarProgress::Clear,
            1 => TaskbarProgress::Value(progress.min(100)),
            2 => TaskbarProgress::Error(progress.min(100)),
            3 => TaskbarProgress::Indeterminate,
            _ => TaskbarProgress::Paused(progress.min(100)),
        }
    }

    /// A fixed "now" with a later instant for two-step scenarios.
    fn clock() -> (Instant, Instant) {
        let now = Instant::now();
        (now, now + Duration::from_secs(10))
    }

    #[test]
    fn explicit_report_wins_and_clear_resets() {
        let (now, _) = clock();
        let mut taskbar = SessionTaskbar::new();
        // An explicit value state shadows the implicit spinner.
        taskbar.on_activity(SessionActivity::Active, now);
        taskbar.apply_report(report(1, 40));
        assert_eq!(taskbar.effective(), TaskbarProgress::Value(40));
        // The explicit state survives the command finishing.
        taskbar.on_activity(SessionActivity::Idle, now);
        assert_eq!(taskbar.effective(), TaskbarProgress::Value(40));
        // An explicit clear drops everything.
        assert!(taskbar.apply_report(TaskbarProgress::Clear));
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
    }

    #[test]
    fn running_command_is_indeterminate_without_a_report() {
        let (now, _) = clock();
        let mut taskbar = SessionTaskbar::new();
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
        assert!(taskbar.on_activity(SessionActivity::Active, now));
        assert_eq!(taskbar.effective(), TaskbarProgress::Indeterminate);
        // The command succeeds: the spinner goes away.
        assert!(taskbar.on_activity(SessionActivity::Idle, now));
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
    }

    #[test]
    fn failed_exit_linghers_until_the_next_command() {
        let (now, _) = clock();
        let mut taskbar = SessionTaskbar::new();
        taskbar.on_activity(SessionActivity::Active, now);
        taskbar.on_activity(SessionActivity::Idle, now);
        assert!(taskbar.on_failed_exit());
        assert_eq!(taskbar.effective(), TaskbarProgress::Error(0));
        // The next command clears the lingering error and re-spins.
        assert!(taskbar.on_activity(SessionActivity::Active, now));
        assert_eq!(taskbar.effective(), TaskbarProgress::Indeterminate);
    }

    #[test]
    fn an_explicit_state_shadows_the_lingering_error() {
        let mut taskbar = SessionTaskbar::new();
        taskbar.on_failed_exit();
        assert!(taskbar.apply_report(report(1, 25)));
        assert_eq!(taskbar.effective(), TaskbarProgress::Value(25));
    }

    #[test]
    fn exit_clears_everything() {
        let mut taskbar = SessionTaskbar::new();
        taskbar.apply_report(report(2, 70));
        taskbar.on_failed_exit();
        assert!(taskbar.on_exit());
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
        // A second exit is a no-op.
        assert!(!taskbar.on_exit());
    }

    #[test]
    fn window_state_combines_like_windows_terminal() {
        assert_eq!(
            combine([
                TaskbarProgress::Indeterminate,
                TaskbarProgress::Value(50),
                TaskbarProgress::Clear,
            ]),
            TaskbarProgress::Value(50)
        );
        assert_eq!(
            combine([TaskbarProgress::Clear, TaskbarProgress::Error(90),]),
            TaskbarProgress::Error(90)
        );
        assert_eq!(
            combine([
                TaskbarProgress::Value(10),
                TaskbarProgress::Paused(5),
                TaskbarProgress::Error(0),
            ]),
            TaskbarProgress::Error(0)
        );
        assert_eq!(
            combine([TaskbarProgress::Paused(0), TaskbarProgress::Indeterminate,]),
            TaskbarProgress::Paused(0)
        );
        assert_eq!(combine([]), TaskbarProgress::Clear);
    }

    #[test]
    fn a_running_command_records_its_start_time() {
        let (now, later) = clock();
        let mut taskbar = SessionTaskbar::new();
        assert_eq!(taskbar.command_started_at(), None);
        // A published Active begins the run: the start time is recorded.
        assert!(taskbar.on_activity(SessionActivity::Active, now));
        assert_eq!(taskbar.command_started_at(), Some(now));
        // An explicit report does not move the command's start: it is
        // the same run, only now reporting progress.
        taskbar.apply_report(report(1, 40));
        assert_eq!(taskbar.command_started_at(), Some(now));
        // The command finishes: the record is dropped even though the
        // explicit state (and thus the effective state) still holds, so
        // no state change is reported.
        taskbar.on_activity(SessionActivity::Idle, later);
        assert_eq!(taskbar.command_started_at(), None);
        // A re-published Active (a quiet TUI waking back up) begins a
        // new run and restamps the start time.
        taskbar.on_activity(SessionActivity::Active, later);
        assert_eq!(taskbar.command_started_at(), Some(later));
    }

    #[test]
    fn exit_clears_the_recorded_start() {
        let (now, _) = clock();
        let mut taskbar = SessionTaskbar::new();
        taskbar.on_activity(SessionActivity::Active, now);
        assert_eq!(taskbar.command_started_at(), Some(now));
        assert!(taskbar.on_exit());
        assert_eq!(taskbar.command_started_at(), None);
    }

    #[test]
    fn the_button_animates_the_last_ran_command_and_cascades() {
        let (first, second) = clock();
        // Two commands run, the second started later: the button
        // animates it (the last-ran process), whatever the first shows.
        assert_eq!(
            window_state([
                WindowTaskbarCandidate {
                    started_at: Some(first),
                    state: TaskbarProgress::Indeterminate,
                },
                WindowTaskbarCandidate {
                    started_at: Some(second),
                    state: TaskbarProgress::Value(40),
                },
            ]),
            TaskbarProgress::Value(40)
        );
        // The second finishes (its start record is gone): the
        // next-newest still-running command takes over.
        assert_eq!(
            window_state([
                WindowTaskbarCandidate {
                    started_at: Some(first),
                    state: TaskbarProgress::Indeterminate,
                },
                WindowTaskbarCandidate { started_at: None, state: TaskbarProgress::Clear },
            ]),
            TaskbarProgress::Indeterminate
        );
        // The first finishes too: nothing runs, so the button falls
        // back to the group rule over the lingering states - clear.
        assert_eq!(
            window_state([
                WindowTaskbarCandidate { started_at: None, state: TaskbarProgress::Clear },
                WindowTaskbarCandidate { started_at: None, state: TaskbarProgress::Clear },
            ]),
            TaskbarProgress::Clear
        );
    }

    #[test]
    fn a_lingering_error_shows_only_when_nothing_runs() {
        let (_, second) = clock();
        // A failed exit's error marker holds the button while no
        // command runs...
        assert_eq!(
            window_state([WindowTaskbarCandidate {
                started_at: None,
                state: TaskbarProgress::Error(0),
            }]),
            TaskbarProgress::Error(0)
        );
        // ...but a running command's animation outranks it.
        assert_eq!(
            window_state([
                WindowTaskbarCandidate { started_at: None, state: TaskbarProgress::Error(0) },
                WindowTaskbarCandidate {
                    started_at: Some(second),
                    state: TaskbarProgress::Indeterminate,
                },
            ]),
            TaskbarProgress::Indeterminate
        );
        assert_eq!(window_state([]), TaskbarProgress::Clear);
    }

    #[test]
    fn an_explicit_clear_mid_run_keeps_the_session_in_the_last_ran_order() {
        // A program that clears its own report is not saying its command
        // ended: the activity lifecycle still owns the start record, so
        // the session keeps its running slot - and its requested clear -
        // until the command actually finishes.
        let (now, _) = clock();
        let mut taskbar = SessionTaskbar::new();
        assert!(taskbar.on_activity(SessionActivity::Active, now));
        taskbar.apply_report(TaskbarProgress::Clear);
        assert_eq!(taskbar.command_started_at(), Some(now));
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
        // ...and the window follows it: the button shows the program's
        // requested clear, not another session's lingering state.
        assert_eq!(
            window_state([
                WindowTaskbarCandidate { started_at: None, state: TaskbarProgress::Error(0) },
                WindowTaskbarCandidate {
                    started_at: Some(now),
                    state: TaskbarProgress::Clear,
                },
            ]),
            TaskbarProgress::Clear
        );
    }

    #[test]
    fn the_last_ran_command_outranks_earlier_spiners_when_paused_or_failed() {
        // Whatever the last-ran command reports is what the button shows:
        // a paused run holds its bar at the percentage, and an error the
        // command itself reported beats an earlier session's spinner.
        let (first, second) = clock();
        assert_eq!(
            window_state([
                WindowTaskbarCandidate {
                    started_at: Some(first),
                    state: TaskbarProgress::Indeterminate,
                },
                WindowTaskbarCandidate {
                    started_at: Some(second),
                    state: TaskbarProgress::Paused(60),
                },
            ]),
            TaskbarProgress::Paused(60)
        );
        assert_eq!(
            window_state([
                WindowTaskbarCandidate {
                    started_at: Some(first),
                    state: TaskbarProgress::Indeterminate,
                },
                WindowTaskbarCandidate {
                    started_at: Some(second),
                    state: TaskbarProgress::Error(80),
                },
            ]),
            TaskbarProgress::Error(80)
        );
    }

    #[test]
    fn equal_start_times_resolve_to_the_later_candidate() {
        // Two commands that started in the same instant cannot be
        // ordered by time: the later candidate in iteration order wins,
        // so a call's result is deterministic for its candidate order.
        let (now, _) = clock();
        assert_eq!(
            window_state([
                WindowTaskbarCandidate {
                    started_at: Some(now),
                    state: TaskbarProgress::Value(10),
                },
                WindowTaskbarCandidate {
                    started_at: Some(now),
                    state: TaskbarProgress::Value(90),
                },
            ]),
            TaskbarProgress::Value(90)
        );
    }

    #[test]
    fn a_new_command_restarts_the_start_record() {
        // Each run gets its own start time: the window orders the fresh
        // run after the finished one, so the cascade never shows a
        // command the shell has already left behind.
        let (now, later) = clock();
        let mut taskbar = SessionTaskbar::new();
        assert!(taskbar.on_activity(SessionActivity::Active, now));
        assert!(taskbar.on_activity(SessionActivity::Idle, now));
        assert!(taskbar.on_activity(SessionActivity::Active, later));
        assert_eq!(taskbar.command_started_at(), Some(later));
    }

    #[test]
    fn a_failed_run_linghers_after_its_start_record_is_gone() {
        // A non-zero exit ends the recorded run (the spinner's start is
        // no longer anyone's truth) and leaves the error marker in its
        // place, where the next command clears it again.
        let (now, _) = clock();
        let mut taskbar = SessionTaskbar::new();
        assert!(taskbar.on_activity(SessionActivity::Active, now));
        assert!(taskbar.on_activity(SessionActivity::Idle, now));
        taskbar.on_failed_exit();
        assert_eq!(taskbar.command_started_at(), None);
        assert_eq!(taskbar.effective(), TaskbarProgress::Error(0));
        // The window's fallback surfaces that lingering error while
        // nothing runs.
        assert_eq!(
            window_state([WindowTaskbarCandidate {
                started_at: taskbar.command_started_at(),
                state: taskbar.effective(),
            }]),
            TaskbarProgress::Error(0)
        );
    }

    #[test]
    fn state_codes_round_trip() {
        let cases = [
            (TaskbarProgress::Clear, 0u8),
            (TaskbarProgress::Value(10), 1),
            (TaskbarProgress::Error(10), 2),
            (TaskbarProgress::Indeterminate, 3),
            (TaskbarProgress::Paused(10), 4),
        ];
        for (progress, code) in cases {
            assert_eq!(progress.state_code(), code);
            assert_eq!(report(code, 10), progress);
        }
    }
}
