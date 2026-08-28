use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    models::{AuthorizedDevice, Project},
    path_utils::strip_windows_verbatim_prefix,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredHost {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    #[serde(flatten)]
    pub device: AuthorizedDevice,
    pub token_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_shell_id: String,
    pub port: u16,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkState {
    /// The node's long-lived private identity key. It is never sent to the
    /// network; the embedded engine consumes its local state directory.
    #[serde(default)]
    pub private_key: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub tailnet_address: Option<String>,
    #[serde(default)]
    pub last_connected_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    host: StoredHost,
    #[serde(default)]
    network: NetworkState,
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    devices: Vec<StoredDevice>,
    settings: Settings,
}

pub struct DesktopStore {
    file_path: PathBuf,
    state: StoredState,
}

impl DesktopStore {
    pub fn load(file_path: PathBuf) -> Result<Self> {
        let mut state = read_state(&file_path)
            .or_else(|| {
                migration_candidates()
                    .into_iter()
                    .find_map(|candidate| read_state(&candidate))
            })
            .unwrap_or_else(default_state);
        for project in &mut state.projects {
            project.path = strip_windows_verbatim_prefix(&project.path);
        }
        let store = Self { file_path, state };
        store.write()?;
        Ok(store)
    }

    pub fn host(&self) -> &StoredHost {
        &self.state.host
    }
    pub fn projects(&self) -> &[Project] {
        &self.state.projects
    }
    pub fn devices(&self) -> &[StoredDevice] {
        &self.state.devices
    }
    pub fn settings(&self) -> &Settings {
        &self.state.settings
    }

    pub fn network(&self) -> &NetworkState {
        &self.state.network
    }

    pub fn save_network(&mut self, network: NetworkState) -> Result<()> {
        self.state.network = network;
        self.write()
    }

    pub fn ensure_network_identity(&mut self) -> Result<NetworkState> {
        if self.state.network.private_key.is_none() {
            self.state.network.private_key = Some(random_token(32));
            self.write()?;
        }
        Ok(self.state.network.clone())
    }

    pub fn save_project(&mut self, project: Project) -> Result<()> {
        if let Some(existing) = self
            .state
            .projects
            .iter_mut()
            .find(|item| item.id == project.id)
        {
            *existing = project;
        } else {
            self.state.projects.push(project);
        }
        self.write()
    }

    pub fn remove_project(&mut self, project_id: &str) -> Result<()> {
        self.state.projects.retain(|item| item.id != project_id);
        self.write()
    }

    pub fn authorize_device(&mut self, device: AuthorizedDevice, token: &str) -> Result<()> {
        let id = device.id.clone();
        self.state.devices.retain(|item| item.device.id != id);
        self.state.devices.push(StoredDevice {
            device,
            token_hash: hash_token(token),
        });
        self.write()
    }

    pub fn touch_device(&mut self, device_id: &str) -> Result<()> {
        if let Some(device) = self
            .state
            .devices
            .iter_mut()
            .find(|item| item.device.id == device_id)
        {
            device.device.last_seen_at = Utc::now().to_rfc3339();
            self.write()?;
        }
        Ok(())
    }

    pub fn revoke_device(&mut self, device_id: &str) -> Result<()> {
        self.state
            .devices
            .retain(|item| item.device.id != device_id);
        self.write()
    }

    pub fn authenticate(&self, device_id: &str, token: &str) -> bool {
        let Some(expected_hex) = self
            .state
            .devices
            .iter()
            .find(|item| item.device.id == device_id)
            .map(|item| &item.token_hash)
        else {
            return false;
        };
        let Ok(expected) = decode_hex(expected_hex) else {
            return false;
        };
        let actual = Sha256::digest(token.as_bytes());
        expected.len() == actual.len() && bool::from(expected.as_slice().ct_eq(actual.as_slice()))
    }

    pub fn set_default_shell(&mut self, shell_id: String) -> Result<()> {
        self.state.settings.default_shell_id = shell_id;
        self.write()
    }

    fn write(&self) -> Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&self.file_path, serde_json::to_vec_pretty(&self.state)?)
            .with_context(|| format!("could not write {}", self.file_path.display()))
    }
}

pub fn random_token(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn default_state() -> StoredState {
    StoredState {
        host: StoredHost {
            id: Uuid::new_v4().to_string(),
            name: hostname::get()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        },
        network: NetworkState::default(),
        projects: Vec::new(),
        devices: Vec::new(),
        settings: Settings {
            default_shell_id: "powershell".into(),
            port: 47_831,
        },
    }
}

fn read_state(path: &Path) -> Option<StoredState> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn migration_candidates() -> Vec<PathBuf> {
    let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) else {
        return Vec::new();
    };
    vec![
        app_data.join("Agent Terminal").join("agent-terminal.json"),
        app_data.join("agent-terminal").join("agent-terminal.json"),
    ]
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ()> {
    if !value.len().is_multiple_of(2) {
        return Err(());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| ()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{DesktopStore, NetworkState};
    use crate::models::AuthorizedDevice;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn authorized_device_credentials_survive_a_store_reload() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let device = AuthorizedDevice {
            id: "phone-1".into(),
            name: "Android phone".into(),
            platform: "android".into(),
            added_at: "2026-08-27T00:00:00Z".into(),
            last_seen_at: "2026-08-27T00:00:00Z".into(),
        };

        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        store
            .authorize_device(device, "durable-device-credential")
            .expect("authorize device");
        drop(store);

        let reloaded = DesktopStore::load(state_path.clone()).expect("reloaded store");
        assert!(reloaded.authenticate("phone-1", "durable-device-credential"));
        assert!(!reloaded.authenticate("phone-1", "wrong-credential"));
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn embedded_network_identity_survives_a_store_reload() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        let identity = store.ensure_network_identity().expect("network identity");
        let private_key = identity.private_key.clone().expect("private key");
        store
            .save_network(NetworkState {
                private_key: Some(private_key.clone()),
                node_id: Some("node-1".into()),
                tailnet_address: Some("100.64.0.2".into()),
                last_connected_at: Some("2026-08-28T00:00:00Z".into()),
            })
            .expect("save network state");
        drop(store);

        let reloaded = DesktopStore::load(state_path.clone()).expect("reloaded store");
        assert_eq!(
            reloaded.network().private_key.as_deref(),
            Some(private_key.as_str())
        );
        assert_eq!(reloaded.network().node_id.as_deref(), Some("node-1"));
        fs::remove_file(state_path).expect("remove test state");
    }
}
