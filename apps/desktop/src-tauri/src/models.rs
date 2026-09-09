use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;

/// How the host classifies the running foreground program's relationship to
/// the terminal grid (see the `TuiMode` doc in `packages/protocol`):
/// canonical keeps the PTY frozen at its snapshot size while clients reflow
/// the journal at their own sizes; inline and fullscreen make the PTY
/// follow the focused client, with fullscreen additionally isolating TUI
/// frames from the scrollback with a synthetic alt-screen pair.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TuiMode {
    #[default]
    Canonical,
    Inline,
    Fullscreen,
}

/// Whether a session's shell is blocked on a foreground program (`Active`)
/// or owns its prompt and is waiting for the user (`Idle`). See
/// `activity.rs` for how the host decides.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionActivity {
    #[default]
    Idle,
    Active,
}

/// ConEmu's `OSC 9;4` taskbar progress state, the same states Windows
/// Terminal applies to its taskbar button through `ITaskbarList3`
/// (microsoft/terminal #8055, #10755): the foreground program reports
/// `OSC 9 ; 4 ; state ; progress ST`, and the host additionally derives
/// `indeterminate` and `error` from the shell's command lifecycle. A
/// window's taskbar button shows the highest-priority state of its
/// project's sessions: error, paused, value, indeterminate, clear.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "progress", rename_all = "lowercase")]
pub enum TaskbarProgress {
    /// No progress indicator.
    Clear,
    /// Deterministic progress, a 0-100 percentage.
    Value(u32),
    /// The command failed; the percentage marks where it stopped.
    Error(u32),
    /// Running, duration unknown (the taskbar shows an animated spinner).
    Indeterminate,
    /// Waiting on input or a user action.
    Paused(u32),
}

impl Default for TaskbarProgress {
    fn default() -> Self {
        TaskbarProgress::Clear
    }
}

impl TaskbarProgress {
    pub fn is_clear(&self) -> bool {
        matches!(self, TaskbarProgress::Clear)
    }

    /// The `st` code of a ConEmu `OSC 9;4` report in this state.
    pub fn state_code(self) -> u8 {
        match self {
            TaskbarProgress::Clear => 0,
            TaskbarProgress::Value(_) => 1,
            TaskbarProgress::Error(_) => 2,
            TaskbarProgress::Indeterminate => 3,
            TaskbarProgress::Paused(_) => 4,
        }
    }

    /// The 0-100 value carried by the value, error, and paused states
    /// (zero otherwise).
    pub fn progress(self) -> u32 {
        match self {
            TaskbarProgress::Value(p) | TaskbarProgress::Error(p) | TaskbarProgress::Paused(p) => p,
            TaskbarProgress::Clear | TaskbarProgress::Indeterminate => 0,
        }
    }
}

/// Which side of a port bridge runs the real service on `127.0.0.1:port`.
/// The other side opens the loopback listener and forwards over the overlay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortBridgeServer {
    Host,
    Client,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBridge {
    pub id: String,
    pub port: u16,
    pub server: PortBridgeServer,
    /// What the user calls this bridge. Config-page only: it never reaches
    /// the node, so renaming one cannot disturb a live bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePortBridging {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bridges: Vec<PortBridge>,
}

/// What the host made of one configured bridge. Mirrors `PortBridgeState` in
/// `packages/protocol/src/port-bridges.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortBridgeState {
    Active,
    Pending,
    Conflict,
    Failed,
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBridgeStatus {
    pub bridge_id: String,
    pub state: PortBridgeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub id: String,
    pub name: String,
    pub platform: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub added_at: String,
    pub last_seen_at: String,
    /// Whether the device currently holds an authenticated connection.
    #[serde(default)]
    pub online: bool,
    /// The sessions the device is displaying right now (its viewport entries
    /// in each session's set S). Runtime-only, like `online`: filled in on
    /// the way out to clients and never meaningful in the store file.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub viewing_session_ids: Vec<String>,
    /// The device's Port Bridge configuration. Persisted with the device, so
    /// unlike `online` this one is meaningful in the store file; a state file
    /// written before this feature simply has bridging switched off.
    #[serde(default)]
    pub port_bridging: DevicePortBridging,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub persistent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_path: Option<String>,
    pub directories: Vec<DirectoryEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub cwd: String,
    pub shell_id: String,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    /// The host's TUI classification of the running foreground program:
    /// clients in canonical mode render the journal at their own grid, while
    /// inline/fullscreen follow the host grid announcements.
    #[serde(default)]
    pub tui_mode: TuiMode,
    /// Whether the shell is currently blocked on a foreground program.
    #[serde(default)]
    pub activity: SessionActivity,
    /// When the session entered `activity`, RFC3339, so clients can show
    /// how long the current command has been running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_since: Option<String>,
    /// The session's ConEmu `OSC 9;4` taskbar progress for its last
    /// command: an explicit program report, or derived from the shell's
    /// command lifecycle (indeterminate while it runs, error after a
    /// non-zero exit). A window's taskbar button combines these across
    /// the project's sessions, highest priority first. Skipped while
    /// clear, like `activity_since`.
    #[serde(default, skip_serializing_if = "TaskbarProgress::is_clear")]
    pub taskbar: TaskbarProgress,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// Terminal scheme ids, mirroring TERMINAL_SCHEMES in
/// packages/protocol/src/terminal-themes.ts. The host validates ids so a
/// stale or hostile value can never put a dark scheme in the light slot; the
/// drift guard in the tests below keeps these lists in step with the
/// TypeScript table that actually carries the colors.
pub const DARK_TERMINAL_SCHEME_IDS: &[&str] = &[
    "campbell",
    "campbell-powershell",
    "vintage",
    "one-half-dark",
    "solarized-dark",
];
pub const LIGHT_TERMINAL_SCHEME_IDS: &[&str] = &["one-half-light", "solarized-light", "novel"];
pub const DEFAULT_DARK_TERMINAL_SCHEME_ID: &str = "campbell";
pub const DEFAULT_LIGHT_TERMINAL_SCHEME_ID: &str = "one-half-light";

/// An id that is unknown, or that belongs to the other mode, falls back to
/// that mode's default rather than painting an unreadable terminal.
pub fn normalize_terminal_scheme_id(id: &str, dark: bool) -> String {
    let (allowed, fallback) = if dark {
        (DARK_TERMINAL_SCHEME_IDS, DEFAULT_DARK_TERMINAL_SCHEME_ID)
    } else {
        (LIGHT_TERMINAL_SCHEME_IDS, DEFAULT_LIGHT_TERMINAL_SCHEME_ID)
    };
    allowed
        .iter()
        .find(|candidate| **candidate == id)
        .map_or_else(
            || fallback.to_string(),
            |candidate| (*candidate).to_string(),
        )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalThemeSettings {
    pub dark_scheme_id: String,
    pub light_scheme_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub host: HostInfo,
    pub projects: Vec<Project>,
    pub sessions: Vec<TerminalSession>,
    pub devices: Vec<AuthorizedDevice>,
    /// The sessions desktop windows are actively showing (their active
    /// tabs, unioned across windows), reported by the renderers: a phone
    /// resets a session's "come look" marker when it lands here - a
    /// terminal actually opened, not a background tab.
    pub desktop_active_session_ids: Vec<String>,
    /// The sessions whose command just finished (taskbar indicator went
    /// non-clear to clear) and that no client has viewed yet: the
    /// host-persisted "come look" markers. A client that connects after
    /// the edge seeds its own markers from this list (the live clients
    /// raised theirs from the taskbar event stream); opening the session
    /// anywhere - a desktop active tab or a phone's open terminal -
    /// clears it on the host, and with it on every client.
    pub look_here_session_ids: Vec<String>,
    pub shells: Vec<ShellProfile>,
    pub default_shell_id: String,
    pub terminal_theme: TerminalThemeSettings,
    /// What the host made of every device's configured port bridges, keyed by
    /// device id. The host alone arbitrates a port: two devices may both
    /// configure 8080, but only the one that claimed it first while connected
    /// is active, and the other stays in conflict until the holder leaves.
    pub port_bridge_statuses: BTreeMap<String, Vec<PortBridgeStatus>>,
    /// The host's own overlay address, which a client needs as the dial
    /// target for a bridge the host serves. Empty while the node is not
    /// enrolled, which is also when no bridge can come up.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub host_tailnet_address: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    #[serde(flatten)]
    pub snapshot: HostSnapshot,
    pub current_project_id: String,
    /// How the window came to show its current project: the user opened it
    /// (`"user"`), or the host placed it there (a shell `cd` moved a
    /// session into it, or an empty temporary project was retired).
    /// The renderer uses this to keep a host-placed project's auto-selected
    /// tab from claiming the PTY grid - the client that ran the `cd`
    /// (a phone) is the one actually interacting with the session.
    pub current_project_origin: String,
    pub open_projects_in_new_windows: bool,
    pub confirm_external_links: bool,
    pub follow_working_directory: bool,
    pub remote_registration: RemoteRegistration,
    /// Whether this app is registered as the user's default terminal app.
    pub is_default_terminal: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRegistration {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub version: u8,
    pub host_id: String,
    pub host_name: String,
    /// The QR is intentionally issued with a LAN endpoint. Pairing never
    /// sends the one-time grant through the public network.
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_url: Option<String>,
    pub transport: String,
    pub pairing_token: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub data: String,
    /// Absolute byte offset of `data` in the session's PTY stream.
    pub offset: u64,
}

/// Windows handed us a console: the window owning `project_id` should open
/// that project and bring `session_id` to the front.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionEvent {
    pub project_id: String,
    pub session_id: String,
}

/// The focus-dependent grid of a session changed at stream offset `offset`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalGridEvent {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub offset: u64,
}

/// The host reclassified the session's foreground program at stream offset
/// `offset`; `mode` tells clients how to own (or not own) the PTY grid.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTuiModeEvent {
    pub session_id: String,
    pub mode: TuiMode,
    pub offset: u64,
}

/// The host reclassified whether the session is blocked on a foreground
/// program. Unlike the grid and mode events this carries no stream offset:
/// idle is discovered by a timeout, not by a byte in the stream, so there
/// is no position to anchor it to.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalActivityEvent {
    pub session_id: String,
    pub activity: SessionActivity,
    pub since: String,
}

/// The session's ConEmu `OSC 9;4` taskbar progress changed, whether by
/// an explicit program report or derived from the shell's command
/// lifecycle. Like the activity event it carries no stream offset: the
/// state is host-side and is also refreshed by the host's idle sweeper.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTaskbarEvent {
    pub session_id: String,
    pub taskbar: TaskbarProgress,
}

/// One contiguous slice of the session's PTY stream recorded under a single
/// terminal grid. Emulators resize to `cols` x `rows` before writing `data`,
/// so their history reflows exactly the way live clients reflowed it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSegment {
    pub cols: u16,
    pub rows: u16,
    pub data: String,
}

/// A point-in-time snapshot of one session's PTY stream: the append-only
/// journal split into per-grid segments plus the absolute stream position it
/// ends at, so clients can replay history with the exact resize sequence the
/// live clients applied and drop live chunks the journal already contains.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub segments: Vec<SessionSegment>,
    pub end_offset: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    #[serde(rename = "pair")]
    Pair {
        request_id: String,
        token: String,
        device: DeviceIdentity,
    },
    #[serde(rename = "auth")]
    Auth {
        request_id: String,
        device_id: String,
        device_token: String,
        /// Optional display name so a stored device keeps a fresh identity
        /// without needing to be paired again.
        #[serde(default)]
        name: Option<String>,
    },
    #[serde(rename = "node.enroll")]
    NodeEnroll { request_id: String, nonce: String },
    #[serde(rename = "snapshot.request")]
    SnapshotRequest { request_id: String },
    #[serde(rename = "project.create")]
    ProjectCreate {
        request_id: String,
        name: String,
        path: String,
    },
    #[serde(rename = "project.rename")]
    ProjectRename {
        request_id: String,
        project_id: String,
        name: String,
    },
    #[serde(rename = "project.remove")]
    ProjectRemove {
        request_id: String,
        project_id: String,
    },
    #[serde(rename = "project.persistence")]
    ProjectPersistence {
        request_id: String,
        project_id: String,
        persistent: bool,
    },
    #[serde(rename = "project.reorder")]
    ProjectReorder {
        request_id: String,
        project_ids: Vec<String>,
    },
    #[serde(rename = "directory.list")]
    DirectoryList {
        request_id: String,
        path: Option<String>,
    },
    #[serde(rename = "session.create")]
    SessionCreate {
        request_id: String,
        project_id: String,
        shell_id: Option<String>,
    },
    #[serde(rename = "session.close")]
    SessionClose {
        request_id: String,
        session_id: String,
    },
    #[serde(rename = "session.attach")]
    SessionAttach {
        request_id: String,
        session_id: String,
        cols: u16,
        rows: u16,
        /// Opening a terminal is an explicit interaction: the client always
        /// sets this, so attaching claims ownership of the PTY grid (see
        /// `apply_owner_grid_for`) unless a more recent claim already holds
        /// it. Optional/defaulted so an older client that omits it is simply
        /// never granted a claim.
        #[serde(default)]
        claim: bool,
    },
    #[serde(rename = "session.detach")]
    SessionDetach {
        request_id: String,
        session_id: String,
    },
    #[serde(rename = "session.input")]
    SessionInput {
        session_id: String,
        data: String,
        /// The sender's viewport at the moment of typing. Typing is always
        /// an interaction: the host applies it immediately and claims the
        /// PTY grid for the sender (see `apply_owner_grid_for`).
        #[serde(default)]
        cols: Option<u16>,
        #[serde(default)]
        rows: Option<u16>,
    },
    #[serde(rename = "session.resize")]
    SessionResize {
        session_id: String,
        cols: u16,
        rows: u16,
        /// Set only on a forced/interaction-driven announce (a tap, a click,
        /// a character-width slider drag) - never on a plain layout resize.
        /// The PTY grid belongs to whichever client last claimed it (see
        /// `apply_owner_grid_for`); an unclaimed announce from a non-owner
        /// is recorded but changes nothing.
        #[serde(default)]
        claim: bool,
    },
    /// Leave the session's viewport set S without leaving its stream: the
    /// client is still attached (still receiving output) but is no longer
    /// displaying the session, so it must not size the PTY and must not be
    /// a successor candidate (`release_viewport`). A hidden desktop tab and
    /// a backgrounded phone send this instead of `session.detach`.
    #[serde(rename = "session.viewport.release")]
    SessionViewportRelease {
        request_id: String,
        session_id: String,
    },
    /// Bare heartbeat with no requestId and no reply: the host only bumps the
    /// client's viewport liveness so a networked client stays in a session's
    /// viewport set S. The `snapshot.request` heartbeat (the presence dot)
    /// stays as-is; a full snapshot every second would be far too heavy.
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "debug.diagnostics")]
    DebugDiagnostics { message: String },
    #[serde(rename = "shell.default")]
    ShellDefault {
        request_id: String,
        shell_id: String,
    },
    #[serde(rename = "terminal.theme")]
    TerminalTheme {
        request_id: String,
        dark_scheme_id: String,
        light_scheme_id: String,
    },
    /// Replace the sending device's own Port Bridge configuration. A device
    /// may only configure itself, so there is no device id: the desktop edits
    /// any device through its Tauri command instead.
    #[serde(rename = "bridge.set")]
    BridgeSet {
        request_id: String,
        enabled: bool,
        bridges: Vec<PortBridge>,
    },
    /// The overlay address this device's embedded node came up on. The host
    /// needs it as the dial target for a bridge the device serves and as the
    /// peer allowlist entry for one the host serves, so a device's bridges
    /// stay pending until it arrives.
    #[serde(rename = "bridge.node")]
    BridgeNode {
        request_id: String,
        tailnet_address: String,
    },
    /// What the device's own node made of its half of the bridges. Only
    /// failures matter here: they are merged into the snapshot so the
    /// desktop's Port Bridge page can warn about a port in use on the device.
    #[serde(rename = "bridge.status")]
    BridgeStatus { statuses: Vec<PortBridgeStatus> },
}

impl ClientMessage {
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Pair { request_id, .. }
            | Self::Auth { request_id, .. }
            | Self::NodeEnroll { request_id, .. }
            | Self::SnapshotRequest { request_id }
            | Self::ProjectCreate { request_id, .. }
            | Self::ProjectRename { request_id, .. }
            | Self::ProjectRemove { request_id, .. }
            | Self::ProjectPersistence { request_id, .. }
            | Self::ProjectReorder { request_id, .. }
            | Self::DirectoryList { request_id, .. }
            | Self::SessionCreate { request_id, .. }
            | Self::SessionClose { request_id, .. }
            | Self::SessionAttach { request_id, .. }
            | Self::SessionDetach { request_id, .. }
            | Self::SessionViewportRelease { request_id, .. }
            | Self::ShellDefault { request_id, .. }
            | Self::TerminalTheme { request_id, .. }
            | Self::BridgeSet { request_id, .. }
            | Self::BridgeNode { request_id, .. } => Some(request_id),
            Self::SessionInput { .. }
            | Self::SessionResize { .. }
            | Self::DebugDiagnostics { .. }
            | Self::BridgeStatus { .. }
            | Self::Ping => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    #[serde(rename = "pair.accepted")]
    PairAccepted {
        request_id: String,
        device_token: String,
        snapshot: HostSnapshot,
    },
    #[serde(rename = "auth.accepted")]
    AuthAccepted {
        request_id: String,
        snapshot: HostSnapshot,
    },
    #[serde(rename = "node.enrollment")]
    NodeEnrollment {
        request_id: String,
        auth_key: String,
        expires_at: String,
    },
    #[serde(rename = "snapshot")]
    Snapshot {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        snapshot: HostSnapshot,
    },
    #[serde(rename = "directory.listing")]
    DirectoryListing {
        request_id: String,
        listing: DirectoryListing,
    },
    #[serde(rename = "session.output")]
    SessionOutput {
        session_id: String,
        data: String,
        offset: u64,
    },
    #[serde(rename = "session.buffer")]
    SessionBuffer {
        request_id: String,
        session_id: String,
        segments: Vec<SessionSegment>,
        end_offset: u64,
    },
    #[serde(rename = "session.grid")]
    SessionGrid {
        session_id: String,
        cols: u16,
        rows: u16,
        offset: u64,
    },
    #[serde(rename = "session.mode")]
    SessionMode {
        session_id: String,
        mode: TuiMode,
        offset: u64,
    },
    #[serde(rename = "session.activity")]
    SessionActivityChanged {
        session_id: String,
        activity: SessionActivity,
        since: String,
    },
    /// The session's taskbar progress changed (a program `OSC 9;4`
    /// report, the shell's command lifecycle, or the process exiting).
    /// Like the activity event it carries no stream offset: the state is
    /// host-side, not a position in the stream.
    #[serde(rename = "session.taskbar")]
    SessionTaskbarChanged {
        session_id: String,
        taskbar: TaskbarProgress,
    },
    #[serde(rename = "ok")]
    Ok { request_id: String },
    #[serde(rename = "error")]
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{
        ClientMessage, DARK_TERMINAL_SCHEME_IDS, DEFAULT_DARK_TERMINAL_SCHEME_ID,
        DEFAULT_LIGHT_TERMINAL_SCHEME_ID, LIGHT_TERMINAL_SCHEME_IDS, PortBridgeServer,
        PortBridgeState, PortBridgeStatus, ServerMessage,
        SessionActivity, SessionSegment, TaskbarProgress, TerminalSession, TerminalTuiModeEvent,
        TuiMode, normalize_terminal_scheme_id,
    };

    #[test]
    fn protocol_field_names_match_the_mobile_contract() {
        let client: ClientMessage = serde_json::from_str(
            r#"{"type":"session.resize","sessionId":"s1","cols":120,"rows":40}"#,
        )
        .expect("client message");
        assert!(matches!(
            client,
            ClientMessage::SessionResize {
                cols: 120,
                rows: 40,
                ..
            }
        ));

        let ping: ClientMessage = serde_json::from_str(r#"{"type":"ping"}"#).expect("ping");
        assert!(matches!(ping, ClientMessage::Ping));

        let enrollment: ClientMessage = serde_json::from_str(
            r#"{"type":"node.enroll","requestId":"r2","nonce":"12345678901234567890123456789012"}"#,
        )
        .expect("enrollment message");
        assert!(matches!(enrollment, ClientMessage::NodeEnroll { .. }));

        let json = serde_json::to_value(ServerMessage::Ok {
            request_id: "r1".into(),
        })
        .expect("server message");
        assert_eq!(json["type"], "ok");
        assert_eq!(json["requestId"], "r1");
    }

    #[test]
    fn session_stream_messages_carry_absolute_byte_offsets_and_grid_segments() {
        let output = serde_json::to_value(ServerMessage::SessionOutput {
            session_id: "s1".into(),
            data: "\x1b[31mred\x1b[0m".into(),
            offset: 1024,
        })
        .expect("session.output");
        assert_eq!(output["type"], "session.output");
        assert_eq!(output["offset"], 1024);

        let buffer = serde_json::to_value(ServerMessage::SessionBuffer {
            request_id: "r1".into(),
            session_id: "s2".into(),
            segments: vec![
                SessionSegment {
                    cols: 120,
                    rows: 40,
                    data: "PS C:\\> ls\r\n".into(),
                },
                SessionSegment {
                    cols: 45,
                    rows: 35,
                    data: "file.txt\r\n".into(),
                },
            ],
            end_offset: 777,
        })
        .expect("session.buffer");
        assert_eq!(buffer["type"], "session.buffer");
        assert_eq!(buffer["endOffset"], 777);
        assert_eq!(buffer["segments"][1]["cols"], 45);

        let grid = serde_json::to_value(ServerMessage::SessionGrid {
            session_id: "s1".into(),
            cols: 100,
            rows: 34,
            offset: 512,
        })
        .expect("session.grid");
        assert_eq!(grid["type"], "session.grid");
        assert_eq!(grid["cols"], 100);
        assert_eq!(grid["rows"], 34);
        assert_eq!(grid["offset"], 512);

        let mode = serde_json::to_value(ServerMessage::SessionMode {
            session_id: "s1".into(),
            mode: TuiMode::Fullscreen,
            offset: 200,
        })
        .expect("session.mode");
        assert_eq!(mode["type"], "session.mode");
        assert_eq!(mode["mode"], "fullscreen");
        assert_eq!(mode["offset"], 200);

        let activity = serde_json::to_value(ServerMessage::SessionActivityChanged {
            session_id: "s1".into(),
            activity: SessionActivity::Active,
            since: "2026-09-06T00:00:00Z".into(),
        })
        .expect("session.activity");
        assert_eq!(activity["type"], "session.activity");
        assert_eq!(activity["activity"], "active");
        assert_eq!(activity["since"], "2026-09-06T00:00:00Z");
    }

    #[test]
    fn session_tui_mode_flag_and_event_are_camel_cased_on_the_wire() {
        let session = TerminalSession {
            id: "s1".into(),
            project_id: "p1".into(),
            title: "pwsh".into(),
            cwd: "C:\\repo".into(),
            shell_id: "powershell".into(),
            status: "running".into(),
            created_at: "now".into(),
            exit_code: None,
            tui_mode: TuiMode::Inline,
            activity: SessionActivity::Active,
            activity_since: Some("2026-09-06T00:00:00Z".into()),
            taskbar: TaskbarProgress::Clear,
        };
        let json = serde_json::to_value(&session).expect("TerminalSession");
        assert_eq!(json["tuiMode"], "inline", "the TUI mode must be camelCased");
        assert_eq!(json["title"], "pwsh");

        let event = TerminalTuiModeEvent {
            session_id: "s1".into(),
            mode: TuiMode::Canonical,
            offset: 42,
        };
        let event_json = serde_json::to_value(event).expect("TerminalTuiModeEvent");
        assert_eq!(event_json["mode"], "canonical");
        assert_eq!(event_json["offset"], 42);
        assert_eq!(event_json["sessionId"], "s1");
    }

    #[test]
    fn taskbar_progress_uses_the_protocol_wire_shape() {
        // The desktop and the renderer must agree on this JSON: a
        // lowercase state tag plus an optional progress, matching
        // packages/protocol's TaskbarProgress.
        let json = serde_json::to_value(TaskbarProgress::Value(42)).expect("value");
        assert_eq!(
            json,
            serde_json::json!({ "state": "value", "progress": 42 })
        );
        let json = serde_json::to_value(TaskbarProgress::Clear).expect("clear");
        assert_eq!(json, serde_json::json!({ "state": "clear" }));
        let json = serde_json::to_value(TaskbarProgress::Error(70)).expect("error");
        assert_eq!(
            json,
            serde_json::json!({ "state": "error", "progress": 70 })
        );
        let json = serde_json::to_value(TaskbarProgress::Indeterminate).expect("indeterminate");
        assert_eq!(json, serde_json::json!({ "state": "indeterminate" }));
        let json = serde_json::to_value(TaskbarProgress::Paused(7)).expect("paused");
        assert_eq!(
            json,
            serde_json::json!({ "state": "paused", "progress": 7 })
        );

        // The inverse direction: what a client could report back, or a
        // persisted journal, must round-trip.
        let progress: TaskbarProgress =
            serde_json::from_value(serde_json::json!({ "state": "value", "progress": 3 }))
                .expect("round-trip");
        assert!(matches!(progress, TaskbarProgress::Value(3)));
    }

    #[test]
    fn a_clear_taskbar_is_omitted_from_the_session_json() {
        let session = TerminalSession {
            id: "s1".into(),
            project_id: "p1".into(),
            title: "pwsh".into(),
            cwd: "C:\\repo".into(),
            shell_id: "powershell".into(),
            status: "running".into(),
            created_at: "now".into(),
            exit_code: None,
            tui_mode: TuiMode::Canonical,
            activity: SessionActivity::Idle,
            activity_since: None,
            taskbar: TaskbarProgress::Clear,
        };
        let json = serde_json::to_value(&session).expect("TerminalSession");
        assert!(
            json.get("taskbar").is_none(),
            "a clear indicator is the default and must not ship on the wire"
        );

        let mut busy = session.clone();
        busy.taskbar = TaskbarProgress::Indeterminate;
        let json = serde_json::to_value(&busy).expect("TerminalSession");
        assert_eq!(
            json["taskbar"],
            serde_json::json!({ "state": "indeterminate" })
        );
    }

    #[test]
    fn shell_default_carries_the_chosen_terminal_through_the_wire_contract() {
        let message: ClientMessage = serde_json::from_str(
            r#"{"type":"shell.default","requestId":"r5","shellId":"git-bash"}"#,
        )
        .expect("shell.default command");
        assert!(matches!(
            message,
            ClientMessage::ShellDefault { ref shell_id, .. } if shell_id == "git-bash"
        ));
        assert_eq!(message.request_id(), Some("r5"));

        // A missing or unknown shell id must never decode as a valid command:
        // the desktop answers with an error instead of touching its store.
        let invalid: Result<ClientMessage, _> =
            serde_json::from_str(r#"{"type":"shell.default","requestId":"r6","shellId":""}"#);
        assert!(invalid.is_ok());
        assert!(matches!(
            invalid.expect("empty value still parses"),
            ClientMessage::ShellDefault { shell_id, .. } if shell_id.is_empty()
        ));

        // The type tag is what routes a command; a lookalike must be rejected
        // so a typo'd or newer type cannot silently fall through to a handler.
        let lookalike: Result<ClientMessage, _> = serde_json::from_str(
            r#"{"type":"shell.defaultValue","requestId":"r7","shellId":"cmd"}"#,
        );
        assert!(lookalike.is_err());

        // SessionInput and SessionResize intentionally carry no request id;
        // the new command returning one must not disturb that split.
        let input: ClientMessage =
            serde_json::from_str(r#"{"type":"session.input","sessionId":"s1","data":"echo hi"}"#)
                .expect("fire-and-forget input");
        assert_eq!(input.request_id(), None);
    }

    #[test]
    fn session_input_carries_an_optional_viewport_size() {
        let with_size: ClientMessage = serde_json::from_str(
            r#"{"type":"session.input","sessionId":"s1","data":"q","cols":113,"rows":39}"#,
        )
        .expect("input with a viewport size");
        assert!(matches!(
            with_size,
            ClientMessage::SessionInput {
                cols: Some(113),
                rows: Some(39),
                ..
            }
        ));
        assert_eq!(with_size.request_id(), None);

        // Legacy clients send no size: the fields decode as None and the
        // host keeps the previously announced viewport.
        let legacy: ClientMessage =
            serde_json::from_str(r#"{"type":"session.input","sessionId":"s1","data":"q"}"#)
                .expect("input without a viewport size");
        assert!(matches!(
            legacy,
            ClientMessage::SessionInput {
                cols: None,
                rows: None,
                ..
            }
        ));
    }

    #[test]
    fn session_viewport_release_decodes_with_a_request_id() {
        let message: ClientMessage = serde_json::from_str(
            r#"{"type":"session.viewport.release","requestId":"r1","sessionId":"s1"}"#,
        )
        .expect("viewport release");
        assert!(matches!(
            message,
            ClientMessage::SessionViewportRelease { ref session_id, .. } if session_id == "s1"
        ));
        assert_eq!(message.request_id(), Some("r1"));
    }

    #[test]
    fn auth_message_accepts_an_optional_display_name() {
        let with_name: ClientMessage = serde_json::from_str(
            r#"{"type":"auth","requestId":"r1","deviceId":"d1","deviceToken":"t1","name":"Pixel 9"}"#,
        )
        .expect("auth with a display name");
        assert!(matches!(
            with_name,
            ClientMessage::Auth { name: Some(name), .. } if name == "Pixel 9"
        ));

        let legacy: ClientMessage = serde_json::from_str(
            r#"{"type":"auth","requestId":"r1","deviceId":"d1","deviceToken":"t1"}"#,
        )
        .expect("auth without a display name");
        assert!(matches!(legacy, ClientMessage::Auth { name: None, .. }));
    }

    /// The host validates scheme ids against the lists above, but the colors
    /// they name live in TypeScript. Read the shared table and prove the two
    /// stay in step, so adding a scheme on one side can never leave the host
    /// rejecting an id its clients offer.
    #[test]
    fn the_scheme_id_lists_match_the_shared_typescript_table() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/protocol/src/terminal-themes.ts"),
        )
        .expect("shared terminal scheme table");

        // Every `id: "..."` entry paired with the `mode: "..."` that follows it.
        let mut dark = Vec::new();
        let mut light = Vec::new();
        let mut pending_id: Option<String> = None;
        for line in source.lines().map(str::trim) {
            if let Some(rest) = line.strip_prefix("id: \"") {
                if let Some(id) = rest.split('"').next() {
                    pending_id = Some(id.to_string());
                }
            } else if let Some(rest) = line.strip_prefix("mode: \"") {
                if let (Some(id), Some(mode)) = (pending_id.take(), rest.split('"').next()) {
                    match mode {
                        "dark" => dark.push(id),
                        "light" => light.push(id),
                        other => panic!("unknown scheme mode {other}"),
                    }
                }
            }
        }

        assert!(!dark.is_empty() && !light.is_empty(), "parsed no schemes");
        assert_eq!(
            dark, DARK_TERMINAL_SCHEME_IDS,
            "dark scheme ids drifted from terminal-themes.ts"
        );
        assert_eq!(
            light, LIGHT_TERMINAL_SCHEME_IDS,
            "light scheme ids drifted from terminal-themes.ts"
        );
        assert!(dark.contains(&DEFAULT_DARK_TERMINAL_SCHEME_ID.to_string()));
        assert!(light.contains(&DEFAULT_LIGHT_TERMINAL_SCHEME_ID.to_string()));
    }

    #[test]
    fn a_scheme_id_from_the_wrong_mode_falls_back_to_that_modes_default() {
        assert_eq!(normalize_terminal_scheme_id("vintage", true), "vintage");
        assert_eq!(normalize_terminal_scheme_id("novel", false), "novel");
        // A light id in the dark slot (or the reverse) would paint an
        // unreadable terminal, so it is replaced rather than stored.
        assert_eq!(
            normalize_terminal_scheme_id("novel", true),
            DEFAULT_DARK_TERMINAL_SCHEME_ID
        );
        assert_eq!(
            normalize_terminal_scheme_id("vintage", false),
            DEFAULT_LIGHT_TERMINAL_SCHEME_ID
        );
        assert_eq!(
            normalize_terminal_scheme_id("", true),
            DEFAULT_DARK_TERMINAL_SCHEME_ID
        );
        assert_eq!(
            normalize_terminal_scheme_id("nonsense", false),
            DEFAULT_LIGHT_TERMINAL_SCHEME_ID
        );
    }

    #[test]
    fn terminal_theme_carries_the_shared_scheme_pair_through_the_wire_contract() {
        let message: ClientMessage = serde_json::from_str(
            r#"{"type":"terminal.theme","requestId":"r9","darkSchemeId":"vintage","lightSchemeId":"novel"}"#,
        )
        .expect("terminal.theme command");
        assert!(matches!(
            message,
            ClientMessage::TerminalTheme { ref dark_scheme_id, ref light_scheme_id, .. }
                if dark_scheme_id == "vintage" && light_scheme_id == "novel"
        ));
        assert_eq!(message.request_id(), Some("r9"));
    }

    #[test]
    fn the_port_bridge_commands_match_the_shared_wire_contract() {
        let set: ClientMessage = serde_json::from_str(
            r#"{"type":"bridge.set","requestId":"r1","enabled":true,"bridges":[{"id":"b1","port":5173,"server":"host"},{"id":"b2","port":9000,"server":"client"}]}"#,
        )
        .expect("bridge.set command");
        let ClientMessage::BridgeSet {
            enabled, bridges, ..
        } = &set
        else {
            panic!("bridge.set must decode as BridgeSet");
        };
        assert!(enabled);
        assert_eq!(bridges[0].port, 5173);
        assert_eq!(bridges[0].server, PortBridgeServer::Host);
        assert_eq!(bridges[1].server, PortBridgeServer::Client);
        assert_eq!(set.request_id(), Some("r1"));

        let node: ClientMessage = serde_json::from_str(
            r#"{"type":"bridge.node","requestId":"r2","tailnetAddress":"100.64.0.3"}"#,
        )
        .expect("bridge.node command");
        assert!(matches!(
            node,
            ClientMessage::BridgeNode { ref tailnet_address, .. } if tailnet_address == "100.64.0.3"
        ));

        // A status report is a notification, not a request: it carries no id
        // and is never answered.
        let status: ClientMessage = serde_json::from_str(
            r#"{"type":"bridge.status","statuses":[{"bridgeId":"b1","state":"failed","detail":"in use"}]}"#,
        )
        .expect("bridge.status command");
        assert_eq!(status.request_id(), None);
        let ClientMessage::BridgeStatus { statuses } = &status else {
            panic!("bridge.status must decode as BridgeStatus");
        };
        assert_eq!(statuses[0].state, PortBridgeState::Failed);
        assert_eq!(statuses[0].detail.as_deref(), Some("in use"));

        // The names the phone reads back out of the snapshot.
        let encoded = serde_json::to_value(PortBridgeStatus {
            bridge_id: "b1".into(),
            state: PortBridgeState::Conflict,
            detail: None,
        })
        .expect("encode status");
        assert_eq!(encoded["bridgeId"], "b1");
        assert_eq!(encoded["state"], "conflict");
        assert!(encoded.get("detail").is_none());
    }
}
