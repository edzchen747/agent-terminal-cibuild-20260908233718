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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub version: u8,
    pub host_id: String,
    pub host_name: String,
    pub endpoint: String,
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
    },
    #[serde(rename = "snapshot.request")]
    SnapshotRequest { request_id: String },
    #[serde(rename = "project.create")]
    ProjectCreate {
        request_id: String,
        name: String,
        path: String,
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
}

impl ClientMessage {
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Pair { request_id, .. }
            | Self::Auth { request_id, .. }
            | Self::SnapshotRequest { request_id }
            | Self::ProjectCreate { request_id, .. }
            | Self::ProjectRemove { request_id, .. }
            | Self::ProjectPersistence { request_id, .. }
            | Self::SessionCreate { request_id, .. }
            | Self::SessionClose { request_id, .. }
            | Self::SessionAttach { request_id, .. }
            | Self::SessionDetach { request_id, .. } => Some(request_id),
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
    #[serde(rename = "snapshot")]
    Snapshot {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        snapshot: HostSnapshot,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum RelayMessage {
    #[serde(rename = "relay.register")]
    Register { host_id: String, host_token: String },
    #[serde(rename = "relay.registered")]
    Registered { host_id: String },
    #[serde(rename = "relay.connect")]
    Connect {
        host_id: String,
        connection_id: String,
    },
    #[serde(rename = "relay.connected")]
    Connected { connection_id: String },
    #[serde(rename = "relay.message")]
    Message {
        connection_id: String,
        payload: String,
    },
    #[serde(rename = "relay.disconnect")]
    Disconnect { connection_id: String },
    #[serde(rename = "relay.error")]
    Error { message: String },
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

        let json = serde_json::to_value(ServerMessage::Ok {
            request_id: "r1".into(),
        })
        .expect("server message");
        assert_eq!(json["type"], "ok");
        assert_eq!(json["requestId"], "r1");
    }
}
