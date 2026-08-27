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

use crate::models::{AuthorizedDevice, Project};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredHost {
    pub id: String,
    pub name: String,
    pub relay_token: String,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    host: StoredHost,
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
        let state = read_state(&file_path)
            .or_else(|| {
                migration_candidates()
                    .into_iter()
                    .find_map(|candidate| read_state(&candidate))
            })
            .unwrap_or_else(default_state);
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

    pub fn save_project(&mut self, project: Project) -> Result<()> {
        self.state.projects.retain(|item| item.id != project.id);
        self.state.projects.push(project);
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
            relay_token: random_token(32),
        },
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
