use std::collections::{HashMap, HashSet};

/// Why a window shows the project it shows. The user opened it (a sidebar
/// click, a console handoff, the tray), or the HOST placed it there: an
/// empty temporary project was retired and the window was reattached to its
/// replacement, or a quiet window was opened for a phone-created session.
/// Only a user-opened project's auto-selected tab claims the PTY grid on
/// activation - a host-placed window is following state that a client
/// (typically a phone) is interacting with, so its renderer must not steal
/// the grid from that client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProjectOrigin {
    #[default]
    User,
    Host,
}

impl ProjectOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectOrigin::User => "user",
            ProjectOrigin::Host => "host",
        }
    }
}

#[derive(Debug, Default)]
pub struct WindowClients {
    project_windows: HashMap<String, String>,
    window_projects: HashMap<String, String>,
    attached_sessions: HashMap<String, HashSet<String>>,
    /// Why each window shows its project (see `ProjectOrigin`); a missing
    /// entry is a user-opened one.
    project_origin: HashMap<String, ProjectOrigin>,
    /// The session each window is actively showing (its active tab), as
    /// reported by the renderer: "a desktop terminal was actually opened",
    /// the signal a phone's "come look" markers reset against. A background
    /// tab is attached but not active, so it never counts as a look.
    active_sessions: HashMap<String, String>,
    /// The windows currently holding OS focus (Tauri's `Focused` events):
    /// which desktop window the user is actually looking at right now - or
    /// none at all when the user is elsewhere (on the phone). A host
    /// action like `set_focus` reports through the same events, so the set
    /// stays accurate either way.
    focused_windows: HashSet<String>,
    last_window: Option<String>,
    last_project: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WindowAssignment {
    pub previous_project: Option<String>,
    pub displaced_window: Option<String>,
}

impl WindowClients {
    pub fn project_for_window(&self, label: &str) -> Option<&str> {
        self.window_projects.get(label).map(String::as_str)
    }

    pub fn window_for_project(&self, project_id: &str) -> Option<&str> {
        self.project_windows.get(project_id).map(String::as_str)
    }

    pub fn has_project(&self, project_id: &str) -> bool {
        self.project_windows.contains_key(project_id)
    }

    pub fn is_registered(&self, label: &str) -> bool {
        self.window_projects.contains_key(label)
    }

    pub fn last_project(&self) -> Option<&str> {
        self.last_project.as_deref()
    }

    pub fn last_or_any(&self) -> Option<String> {
        self.last_window
            .clone()
            .or_else(|| self.window_projects.keys().next().cloned())
    }

    /// The window a handed-off console should surface in: the one already
    /// showing `project_id`, otherwise whichever window is in front. `None`
    /// when no window is open at all - the handoff path then opens a fresh
    /// window for the project, shown and focused, so the console the user
    /// launched lands on screen.
    pub fn handoff_target(&self, project_id: &str) -> Option<String> {
        self.window_for_project(project_id)
            .map(str::to_owned)
            .or_else(|| self.last_or_any())
    }

    pub fn labels(&self) -> Vec<String> {
        self.window_projects.keys().cloned().collect()
    }

    pub fn assign(&mut self, label: &str, project_id: &str) -> WindowAssignment {
        let previous_project = self.window_projects.remove(label);
        if let Some(previous) = &previous_project
            && self.project_windows.get(previous).map(String::as_str) == Some(label)
        {
            self.project_windows.remove(previous);
        }

        let displaced_window = self
            .project_windows
            .insert(project_id.to_string(), label.to_string())
            .filter(|existing| existing != label);
        if let Some(displaced) = &displaced_window {
            self.window_projects.remove(displaced);
            self.attached_sessions.remove(displaced);
            if self.last_window.as_ref() == Some(displaced) {
                self.last_window = None;
            }
        }
        self.window_projects
            .insert(label.to_string(), project_id.to_string());
        if self.last_window.as_deref() == Some(label) {
            self.last_project = Some(project_id.to_string());
        }

        WindowAssignment {
            previous_project,
            displaced_window,
        }
    }

    /// How the window came to show its project: `Host` when the cd / empty-
    /// project paths placed it there, `User` (the default) otherwise.
    pub fn project_origin(&self, label: &str) -> ProjectOrigin {
        self.project_origin.get(label).copied().unwrap_or_default()
    }

    pub fn set_project_origin(&mut self, label: &str, origin: ProjectOrigin) {
        if self.window_projects.contains_key(label) {
            self.project_origin.insert(label.to_string(), origin);
        }
    }

    pub fn remove_window(&mut self, label: &str) -> Option<String> {
        self.attached_sessions.remove(label);
        self.active_sessions.remove(label);
        self.project_origin.remove(label);
        self.focused_windows.remove(label);
        let was_last_window = self.last_window.as_deref() == Some(label);
        if was_last_window {
            self.last_window = None;
        }
        let project_id = self.window_projects.remove(label)?;
        if was_last_window || self.last_window.is_none() {
            self.last_project = Some(project_id.clone());
        }
        if self.project_windows.get(&project_id).map(String::as_str) == Some(label) {
            self.project_windows.remove(&project_id);
        }
        Some(project_id)
    }

    pub fn mark_focused(&mut self, label: &str) {
        if let Some(project_id) = self.window_projects.get(label) {
            self.last_window = Some(label.to_string());
            self.last_project = Some(project_id.clone());
            self.focused_windows.insert(label.to_string());
        }
    }

    /// The window lost OS focus (the user looked away - at another app, or
    /// at the phone): it no longer counts as the desktop being engaged.
    pub fn mark_blurred(&mut self, label: &str) {
        self.focused_windows.remove(label);
    }

    /// Whether the window holds OS focus right now - the desktop user is
    /// looking at it.
    pub fn is_focused(&self, label: &str) -> bool {
        self.focused_windows.contains(label)
    }

    pub fn retain_attachment(&mut self, label: &str, session_id: &str) {
        if !self.window_projects.contains_key(label) {
            return;
        }
        self.attached_sessions
            .insert(label.to_string(), HashSet::from([session_id.to_string()]));
    }

    pub fn attach(&mut self, label: &str, session_id: &str) -> bool {
        if !self.window_projects.contains_key(label) {
            return false;
        }
        self.attached_sessions
            .entry(label.to_string())
            .or_default()
            .insert(session_id.to_string());
        true
    }

    pub fn detach(&mut self, label: &str, session_id: &str) {
        let Some(sessions) = self.attached_sessions.get_mut(label) else {
            return;
        };
        sessions.remove(session_id);
        if sessions.is_empty() {
            self.attached_sessions.remove(label);
        }
    }

    pub fn clear_attachments(&mut self, label: &str) {
        self.attached_sessions.remove(label);
    }

    pub fn subscribers(&self, session_id: &str) -> Vec<String> {
        self.attached_sessions
            .iter()
            .filter(|(_, sessions)| sessions.contains(session_id))
            .map(|(label, _)| label.clone())
            .collect()
    }

    /// The session each window is actively showing (its active tab),
    /// reported by the renderer through `set_active_session`; `None` on
    /// the renderer side clears the window's entry (a window with no tab
    /// open, or a project switch in flight). Closed windows lose their
    /// entry with the window (`remove_window`), so the union only ever
    /// contains live windows' active tabs.
    pub fn set_active_session(&mut self, label: &str, session_id: Option<String>) {
        if let Some(session_id) = session_id {
            self.active_sessions.insert(label.to_string(), session_id);
        } else {
            self.active_sessions.remove(label);
        }
    }

    /// The sessions desktop windows are actively showing right now (the
    /// union of the per-window active tabs): "a desktop terminal was
    /// opened". A phone's "come look" markers reset when a session lands
    /// in this set - and only when it newly lands: a terminal that was
    /// already open before a command finished is a background tab, not a
    /// look at the finish.
    pub fn active_session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.active_sessions.values().cloned().collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::{ProjectOrigin, WindowAssignment, WindowClients};

    #[test]
    fn reassigning_the_active_window_displaces_the_old_target_window() {
        let mut clients = WindowClients::default();
        clients.assign("window-current", "project-old");
        clients.assign("window-target", "project-new");
        clients.attach("window-target", "target-session");
        clients.mark_focused("window-current");

        assert_eq!(
            clients.assign("window-current", "project-new"),
            WindowAssignment {
                previous_project: Some("project-old".into()),
                displaced_window: Some("window-target".into()),
            }
        );
        assert_eq!(
            clients.window_for_project("project-new"),
            Some("window-current")
        );
        assert_eq!(clients.window_for_project("project-old"), None);
        assert!(clients.subscribers("target-session").is_empty());
    }

    #[test]
    fn terminal_output_only_targets_attached_window_clients() {
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.assign("window-b", "project-b");
        assert!(clients.attach("window-a", "session-1"));
        assert!(clients.attach("window-b", "session-2"));
        assert_eq!(clients.subscribers("session-1"), vec!["window-a"]);
        clients.detach("window-a", "session-1");
        assert!(clients.subscribers("session-1").is_empty());
    }

    #[test]
    fn closing_the_last_window_retains_its_project_for_tray_restore() {
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.mark_focused("window-a");
        clients.remove_window("window-a");

        assert_eq!(clients.last_or_any(), None);
        assert_eq!(clients.last_project(), Some("project-a"));
    }

    #[test]
    fn closing_a_background_window_does_not_replace_the_restore_project() {
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.assign("window-b", "project-b");
        clients.mark_focused("window-b");
        clients.remove_window("window-a");

        assert_eq!(clients.last_or_any(), Some("window-b".into()));
        assert_eq!(clients.last_project(), Some("project-b"));
    }

    #[test]
    fn project_reassignment_retains_only_the_moved_terminal_attachment() {
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.attach("window-a", "moved-session");
        clients.attach("window-a", "old-session");

        clients.retain_attachment("window-a", "moved-session");
        clients.assign("window-a", "project-b");

        assert_eq!(clients.subscribers("moved-session"), vec!["window-a"]);
        assert!(clients.subscribers("old-session").is_empty());
    }

    #[test]
    fn assigning_an_unowned_project_displaces_no_other_window() {
        // The quiet window path for phone-created sessions assigns a brand-new
        // label to a project that had no window; this takeover must never
        // evict a window that hosts a different project.
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.attach("window-a", "session-a");

        let assignment = clients.assign("window-b", "project-b");
        assert_eq!(assignment.displaced_window, None);
        assert_eq!(clients.window_for_project("project-a"), Some("window-a"));
        assert_eq!(clients.window_for_project("project-b"), Some("window-b"));
        assert_eq!(
            clients.subscribers("session-a"),
            vec!["window-a"],
            "the old window keeps its terminal attachment"
        );
    }

    #[test]
    fn a_handoff_surfaces_in_the_window_already_showing_its_project() {
        let mut clients = WindowClients::default();
        clients.assign("window-1", "project-1");
        clients.assign("window-2", "project-2");
        clients.mark_focused("window-2");

        assert_eq!(
            clients.handoff_target("project-1"),
            Some("window-1".to_string()),
            "the project's own window wins over whichever is in front"
        );
        assert_eq!(
            clients.handoff_target("project-2"),
            Some("window-2".to_string())
        );
    }

    #[test]
    fn a_handoff_without_a_project_window_surfaces_in_the_front_window() {
        let mut clients = WindowClients::default();
        clients.assign("window-1", "project-1");
        clients.assign("window-2", "project-2");
        clients.mark_focused("window-1");

        // The console's project has no window of its own, so the handoff
        // raises the front-most one and records a pending focus for it.
        assert_eq!(
            clients.handoff_target("project-3"),
            Some("window-1".to_string())
        );
    }

    #[test]
    fn a_handoff_with_no_window_open_has_no_target() {
        // All windows were closed and the app keeps running from the tray:
        // there is nothing to raise, so the handoff path opens a fresh
        // window for the console's project.
        let clients = WindowClients::default();
        assert_eq!(clients.handoff_target("project-1"), None);
    }

    #[test]
    fn a_handoff_after_the_last_window_closes_has_no_target() {
        let mut clients = WindowClients::default();
        clients.assign("window-1", "project-1");
        clients.mark_focused("window-1");
        clients.remove_window("window-1");

        assert_eq!(
            clients.handoff_target("project-1"),
            None,
            "a closed window is not a target: the handoff opens a fresh window"
        );
    }

    #[test]
    fn a_handoff_targets_a_registered_window_that_was_never_focused() {
        // A freshly built window is registered before its first focus event
        // arrives, so the fallback must reach any registered window rather
        // than only the last-focused one.
        let mut clients = WindowClients::default();
        clients.assign("window-1", "project-1");

        assert_eq!(
            clients.handoff_target("project-2"),
            Some("window-1".to_string())
        );
    }

    #[test]
    fn the_active_session_union_tracks_each_window_active_tab() {
        // A window reports the tab it is actually showing; a background
        // tab (attached but not active) never counts, `None` clears the
        // window's entry, and a closed window's entry is gone with it.
        let mut clients = WindowClients::default();
        clients.assign("window-1", "project-1");
        clients.assign("window-2", "project-2");
        clients.attach("window-1", "session-a");
        clients.attach("window-1", "session-b");
        clients.set_active_session("window-1", Some("session-b".to_string()));
        clients.set_active_session("window-2", Some("session-b".to_string()));

        assert_eq!(
            clients.active_session_ids(),
            vec!["session-b"],
            "the union spans windows, dedupes, and ignores background tabs"
        );

        clients.set_active_session("window-1", None);

        assert_eq!(
            clients.active_session_ids(),
            vec!["session-b"],
            "clearing a window's active tab drops its entry"
        );

        clients.remove_window("window-2");

        assert_eq!(clients.active_session_ids(), Vec::<String>::new());
    }

    #[test]
    fn focus_tracking_follows_the_os_focus_events() {
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.assign("window-b", "project-b");

        assert!(!clients.is_focused("window-a"), "a window starts unfocused");
        clients.mark_focused("window-a");
        assert!(clients.is_focused("window-a"));
        assert!(!clients.is_focused("window-b"));

        // The user looks away (at the phone): the window stops counting as
        // engaged, which is what keeps a phone's cd from dragging it.
        clients.mark_blurred("window-a");
        assert!(!clients.is_focused("window-a"));

        // A closed window's focus dies with it, and blurring a label that
        // never focused is a no-op.
        clients.mark_focused("window-b");
        clients.remove_window("window-b");
        assert!(!clients.is_focused("window-b"));
        clients.mark_blurred("ghost");
    }

    #[test]
    fn a_focus_event_for_an_unregistered_window_changes_nothing() {
        // Tauri's Focused events can reach a label before its window is
        // registered, or for a window that is tearing down. Recording one
        // would poison `last_or_any` / `handoff_target` with a dead label,
        // so a focus for an unknown label is a strict no-op - and a late
        // focus for a DESTROYED label must not re-list it.
        let mut clients = WindowClients::default();

        clients.mark_focused("ghost");
        assert!(!clients.is_focused("ghost"), "an unregistered label cannot be focused");
        assert_eq!(clients.last_or_any(), None, "a ghost focus is not a last window");
        assert_eq!(clients.last_project(), None);

        clients.assign("window-a", "project-a");
        clients.mark_focused("window-a");
        clients.remove_window("window-a");
        clients.mark_focused("window-a");

        assert!(!clients.is_focused("window-a"), "a destroyed window cannot hold focus");
        assert_eq!(
            clients.last_or_any(),
            None,
            "the destroyed window's late focus must not make it the restore target"
        );
    }

    #[test]
    fn the_focused_window_becomes_the_last_project_for_tray_restore() {
        // `mark_focused` records which project the focused window shows, so
        // tray restore (and the handoff fallback) bring back the window the
        // user was actually looking at - not merely the most-recently
        // assigned one (assignment order and focus order can differ in
        // multi-window mode).
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.assign("window-b", "project-b");

        clients.mark_focused("window-a");
        assert_eq!(clients.last_project(), Some("project-a"));
        clients.mark_focused("window-b");
        assert_eq!(clients.last_project(), Some("project-b"));
        assert_eq!(clients.last_or_any(), Some("window-b".into()));
    }

    #[test]
    fn the_project_origin_defaults_to_user_and_follows_the_window() {
        let mut clients = WindowClients::default();
        clients.assign("window-a", "project-a");
        clients.assign("window-b", "project-b");

        assert_eq!(clients.project_origin("window-a"), ProjectOrigin::User);

        // A cd (or an empty temporary project being retired) reattaches the
        // window: the origin flips to host, and the renderer's auto-selected
        // tab must not claim the PTY grid because of it.
        clients.set_project_origin("window-a", ProjectOrigin::Host);
        assert_eq!(clients.project_origin("window-a"), ProjectOrigin::Host);
        assert_eq!(clients.project_origin("window-b"), ProjectOrigin::User, "the other window is untouched");

        // A destroyed window loses its origin with it; setting one for an
        // unregistered label is a no-op.
        clients.remove_window("window-a");
        assert_eq!(clients.project_origin("window-a"), ProjectOrigin::User);
        clients.set_project_origin("ghost", ProjectOrigin::Host);
        assert!(clients.project_origin.is_empty());
    }
}
