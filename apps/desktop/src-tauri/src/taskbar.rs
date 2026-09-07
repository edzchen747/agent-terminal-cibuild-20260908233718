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
//! A window's taskbar button shows one state per window, the
//! highest-priority state of the project's sessions (Windows Terminal's
//! group rule, microsoft/terminal #10755): error, paused, value,
//! indeterminate, clear.

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
    /// command also clears the previous run's lingering error.
    pub fn on_activity(&mut self, activity: SessionActivity) -> bool {
        let before = self.effective();
        match activity {
            SessionActivity::Active => {
                self.failed_exit = false;
                if self.explicit.is_none() {
                    self.command_running = true;
                }
            }
            SessionActivity::Idle => self.command_running = false,
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
        self.failed_exit = false;
        self.changed_since(before)
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

    fn report(state: u8, progress: u32) -> TaskbarProgress {
        match state {
            0 => TaskbarProgress::Clear,
            1 => TaskbarProgress::Value(progress.min(100)),
            2 => TaskbarProgress::Error(progress.min(100)),
            3 => TaskbarProgress::Indeterminate,
            _ => TaskbarProgress::Paused(progress.min(100)),
        }
    }

    #[test]
    fn explicit_report_wins_and_clear_resets() {
        let mut taskbar = SessionTaskbar::new();
        // An explicit value state shadows the implicit spinner.
        taskbar.on_activity(SessionActivity::Active);
        taskbar.apply_report(report(1, 40));
        assert_eq!(taskbar.effective(), TaskbarProgress::Value(40));
        // The explicit state survives the command finishing.
        taskbar.on_activity(SessionActivity::Idle);
        assert_eq!(taskbar.effective(), TaskbarProgress::Value(40));
        // An explicit clear drops everything.
        assert!(taskbar.apply_report(TaskbarProgress::Clear));
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
    }

    #[test]
    fn running_command_is_indeterminate_without_a_report() {
        let mut taskbar = SessionTaskbar::new();
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
        assert!(taskbar.on_activity(SessionActivity::Active));
        assert_eq!(taskbar.effective(), TaskbarProgress::Indeterminate);
        // The command succeeds: the spinner goes away.
        assert!(taskbar.on_activity(SessionActivity::Idle));
        assert_eq!(taskbar.effective(), TaskbarProgress::Clear);
    }

    #[test]
    fn failed_exit_linghers_until_the_next_command() {
        let mut taskbar = SessionTaskbar::new();
        taskbar.on_activity(SessionActivity::Active);
        taskbar.on_activity(SessionActivity::Idle);
        assert!(taskbar.on_failed_exit());
        assert_eq!(taskbar.effective(), TaskbarProgress::Error(0));
        // The next command clears the lingering error and re-spins.
        assert!(taskbar.on_activity(SessionActivity::Active));
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
