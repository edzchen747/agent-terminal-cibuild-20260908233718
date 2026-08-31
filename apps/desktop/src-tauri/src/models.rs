use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;

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
    SessionInput { session_id: String, data: String },
    #[serde(rename = "session.resize")]
    SessionResize {
        session_id: String,
        cols: u16,
        rows: u16,
        force: Option<bool>,
    },
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
            Self::SessionInput { .. } | Self::SessionResize { .. } => None,
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
    SessionOutput { session_id: String, data: String },
    #[serde(rename = "session.buffer")]
    SessionBuffer {
        request_id: String,
        session_id: String,
        data: String,
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
    use super::{ClientMessage, ServerMessage};

    #[test]
    fn protocol_field_names_match_the_mobile_contract() {
        let client: ClientMessage = serde_json::from_str(
            r#"{"type":"session.resize","sessionId":"s1","cols":120,"rows":40,"force":true}"#,
        )
        .expect("client message");
        assert!(matches!(
            client,
            ClientMessage::SessionResize {
                force: Some(true),
                ..
            }
        ));

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
