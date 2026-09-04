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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub host: HostInfo,
    pub projects: Vec<Project>,
    pub sessions: Vec<TerminalSession>,
    pub devices: Vec<AuthorizedDevice>,
    pub shells: Vec<ShellProfile>,
    pub default_shell_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    #[serde(flatten)]
    pub snapshot: HostSnapshot,
    pub current_project_id: String,
    pub open_projects_in_new_windows: bool,
    pub confirm_external_links: bool,
    pub follow_working_directory: bool,
    pub remote_registration: RemoteRegistration,
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

/// One contiguous slice of the session's PTY stream recorded under a single
/// terminal grid. Emulators resize to `cols` x `rows` before writing `data`,
/// so their history reflows exactly the way live clients reflowed it.
#[derive(Clone, Debug, Serialize)]
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
        /// The sender's viewport at the moment of typing. In a TUI period the
        /// host applies it immediately (the interacting client owns the grid).
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
            | Self::ShellDefault { request_id, .. } => Some(request_id),
            Self::SessionInput { .. } | Self::SessionResize { .. } | Self::DebugDiagnostics { .. } | Self::Ping => {
                None
            }
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
    use super::{ClientMessage, ServerMessage, SessionSegment, TerminalTuiModeEvent, TerminalSession, TuiMode};

    #[test]
    fn protocol_field_names_match_the_mobile_contract() {
        let client: ClientMessage = serde_json::from_str(
            r#"{"type":"session.resize","sessionId":"s1","cols":120,"rows":40}"#,
        )
        .expect("client message");
        assert!(matches!(
            client,
            ClientMessage::SessionResize { cols: 120, rows: 40, .. }
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
        let invalid: Result<ClientMessage, _> = serde_json::from_str(
            r#"{"type":"shell.default","requestId":"r6","shellId":""}"#,
        );
        assert!(invalid.is_ok());
        assert!(matches!(
            invalid.expect("empty value still parses"),
            ClientMessage::ShellDefault { shell_id, .. } if shell_id.is_empty()
        ));

        // The type tag is what routes a command; a lookalike must be rejected
        // so a typo'd or newer type cannot silently fall through to a handler.
        let lookalike: Result<ClientMessage, _> =
            serde_json::from_str(r#"{"type":"shell.defaultValue","requestId":"r7","shellId":"cmd"}"#);
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
            ClientMessage::SessionInput { cols: Some(113), rows: Some(39), .. }
        ));
        assert_eq!(with_size.request_id(), None);

        // Legacy clients send no size: the fields decode as None and the
        // host keeps the previously announced viewport.
        let legacy: ClientMessage = serde_json::from_str(
            r#"{"type":"session.input","sessionId":"s1","data":"q"}"#,
        )
        .expect("input without a viewport size");
        assert!(matches!(
            legacy,
            ClientMessage::SessionInput { cols: None, rows: None, .. }
        ));
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
        assert!(matches!(
            legacy,
            ClientMessage::Auth { name: None, .. }
        ));
    }
}
