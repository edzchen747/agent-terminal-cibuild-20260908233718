use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    models::{AuthorizedDevice, DevicePortBridging, Project},
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
    #[serde(default = "default_open_projects_in_new_windows")]
    pub open_projects_in_new_windows: bool,
    #[serde(default = "default_confirm_external_links")]
    pub confirm_external_links: bool,
    #[serde(default = "default_follow_working_directory")]
    pub follow_working_directory: bool,
    /// Terminal scheme ids applied when a client is in dark / light mode.
    /// Shared by every client, so the same session renders identically on the
    /// desktop and the phone. Validated against the protocol's scheme table
    /// on the way in and out (see Core::set_terminal_theme).
    #[serde(default = "default_terminal_dark_scheme_id")]
    pub terminal_dark_scheme_id: String,
    #[serde(default = "default_terminal_light_scheme_id")]
    pub terminal_light_scheme_id: String,
}

fn default_open_projects_in_new_windows() -> bool {
    true
}

fn default_confirm_external_links() -> bool {
    true
}

fn default_follow_working_directory() -> bool {
    true
}

fn default_terminal_dark_scheme_id() -> String {
    crate::models::DEFAULT_DARK_TERMINAL_SCHEME_ID.to_string()
}

fn default_terminal_light_scheme_id() -> String {
    crate::models::DEFAULT_LIGHT_TERMINAL_SCHEME_ID.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    #[serde(default)]
    pub enrolled: bool,
    #[serde(default = "default_registration_status")]
    pub registration_status: String,
    #[serde(default)]
    pub registration_error: Option<String>,
}

fn default_registration_status() -> String {
    "unregistered".into()
}

impl Default for NetworkState {
    fn default() -> Self {
        Self {
            private_key: None,
            node_id: None,
            tailnet_address: None,
            last_connected_at: None,
            enrolled: false,
            registration_status: default_registration_status(),
            registration_error: None,
        }
    }
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
            let visible_path = strip_windows_verbatim_prefix(&project.path);
            project.path = fs::canonicalize(&visible_path)
                .map(|path| strip_windows_verbatim_prefix(path.to_string_lossy().as_ref()))
                .unwrap_or(visible_path);
        }
        let mut paths = HashSet::new();
        state.projects.retain(|project| {
            // Keep the first record so existing project IDs remain stable.
            paths.insert(normalized_project_path(&project.path))
        });
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
        if self.state.projects.iter().any(|item| {
            item.id != project.id
                && normalized_project_path(&item.path) == normalized_project_path(&project.path)
        }) {
            return Err(anyhow!("A project already exists for this folder."));
        }
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

    pub fn reorder_projects(&mut self, project_ids: &[String]) -> Result<()> {
        let existing = self
            .state
            .projects
            .iter()
            .map(|project| project.id.clone())
            .collect::<HashSet<_>>();
        let requested = project_ids.iter().cloned().collect::<HashSet<_>>();
        if requested.len() != project_ids.len() || requested != existing {
            return Err(anyhow!("Project order does not match the saved projects."));
        }
        let mut projects = self
            .state
            .projects
            .drain(..)
            .map(|project| (project.id.clone(), project))
            .collect::<std::collections::HashMap<_, _>>();
        self.state.projects = project_ids
            .iter()
            .filter_map(|id| projects.remove(id))
            .collect();
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

    /// Returns true when the stored display name actually changed.
    pub fn update_device_name(&mut self, device_id: &str, name: &str) -> Result<bool> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(false);
        }
        if let Some(device) = self
            .state
            .devices
            .iter_mut()
            .find(|item| item.device.id == device_id)
        {
            if device.device.name != name {
                device.device.name = name.to_owned();
                self.write()?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Replace a device's Port Bridge configuration. Returns false when the
    /// device is unknown (it was revoked while a page was still showing it).
    /// The ports are the user's to choose; the host arbitrates collisions
    /// between devices at connection time rather than at save time, so a port
    /// another device already holds is stored here and reported as a conflict.
    pub fn set_device_port_bridging(
        &mut self,
        device_id: &str,
        bridging: DevicePortBridging,
    ) -> Result<bool> {
        let Some(device) = self
            .state
            .devices
            .iter_mut()
            .find(|item| item.device.id == device_id)
        else {
            return Ok(false);
        };
        if device.device.port_bridging == bridging {
            return Ok(true);
        }
        device.device.port_bridging = bridging;
        self.write()?;
        Ok(true)
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

    pub fn set_open_projects_in_new_windows(&mut self, enabled: bool) -> Result<()> {
        self.state.settings.open_projects_in_new_windows = enabled;
        self.write()
    }

    pub fn set_confirm_external_links(&mut self, enabled: bool) -> Result<()> {
        self.state.settings.confirm_external_links = enabled;
        self.write()
    }

    pub fn set_follow_working_directory(&mut self, enabled: bool) -> Result<()> {
        self.state.settings.follow_working_directory = enabled;
        self.write()
    }

    pub fn set_terminal_theme(
        &mut self,
        dark_scheme_id: String,
        light_scheme_id: String,
    ) -> Result<()> {
        self.state.settings.terminal_dark_scheme_id = dark_scheme_id;
        self.state.settings.terminal_light_scheme_id = light_scheme_id;
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
            open_projects_in_new_windows: true,
            confirm_external_links: true,
            follow_working_directory: true,
            terminal_dark_scheme_id: default_terminal_dark_scheme_id(),
            terminal_light_scheme_id: default_terminal_light_scheme_id(),
        },
    }
}

fn read_state(path: &Path) -> Option<StoredState> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn normalized_project_path(path: &str) -> String {
    strip_windows_verbatim_prefix(path)
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
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
    use crate::models::{AuthorizedDevice, DevicePortBridging, PortBridge, PortBridgeServer};
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn a_settings_file_written_before_terminal_themes_loads_the_defaults() {
        // Upgrading in place must not need the settings file rewritten first:
        // the fields are simply absent until something sets them.
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let state = serde_json::json!({
            "host": { "id": "host-1", "name": "Workstation" },
            "projects": [],
            "devices": [],
            "settings": { "defaultShellId": "powershell", "port": 47831 }
        });
        fs::write(&state_path, serde_json::to_vec(&state).expect("serialize")).expect("write");

        let store = DesktopStore::load(state_path.clone()).expect("load legacy settings");
        assert_eq!(
            store.settings().terminal_dark_scheme_id,
            crate::models::DEFAULT_DARK_TERMINAL_SCHEME_ID
        );
        assert_eq!(
            store.settings().terminal_light_scheme_id,
            crate::models::DEFAULT_LIGHT_TERMINAL_SCHEME_ID
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn the_terminal_theme_pair_survives_a_store_reload() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        {
            let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
            store
                .set_terminal_theme("vintage".into(), "novel".into())
                .expect("store the pair");
        }
        let reloaded = DesktopStore::load(state_path.clone()).expect("reload store");
        assert_eq!(reloaded.settings().terminal_dark_scheme_id, "vintage");
        assert_eq!(reloaded.settings().terminal_light_scheme_id, "novel");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn duplicate_project_paths_are_collapsed_on_reload() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let state = serde_json::json!({
            "host": { "id": "host-1", "name": "Workstation" },
            "projects": [
                {
                    "id": "project-first",
                    "name": "First name",
                    "path": "C:\\Users\\edzch",
                    "persistent": true,
                    "createdAt": "2026-08-28T00:00:00Z"
                },
                {
                    "id": "project-duplicate",
                    "name": "Duplicate name",
                    "path": "\\\\?\\c:\\Users\\edzch\\",
                    "persistent": true,
                    "createdAt": "2026-08-28T00:01:00Z"
                }
            ],
            "devices": [],
            "settings": { "defaultShellId": "powershell", "port": 47831 }
        });
        fs::write(
            &state_path,
            serde_json::to_vec(&state).expect("serialize test state"),
        )
        .expect("write test state");

        let store = DesktopStore::load(state_path.clone()).expect("load duplicate state");
        assert_eq!(store.projects().len(), 1);
        assert_eq!(store.projects()[0].id, "project-first");

        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&state_path).expect("read repaired state"))
                .expect("parse repaired state");
        assert_eq!(persisted["projects"].as_array().unwrap().len(), 1);
        fs::remove_file(state_path).expect("remove test state");
    }

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
            online: false,
            viewing_session_ids: Vec::new(),
            port_bridging: DevicePortBridging::default(),
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
    fn follow_working_directory_defaults_on_and_persists() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));

        // A brand-new store enables the follow behavior by default.
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        assert!(store.settings().follow_working_directory);

        // Disabling it is written to disk and survives a reload.
        let mut store = store;
        store
            .set_follow_working_directory(false)
            .expect("disable follow");
        drop(store);
        let reloaded = DesktopStore::load(state_path.clone()).expect("reloaded store");
        assert!(!reloaded.settings().follow_working_directory);

        // Legacy state files that predate the setting (no key present) must
        // load with the default of `true` rather than failing to parse.
        let legacy = serde_json::json!({
            "host": { "id": "host-1", "name": "Workstation" },
            "projects": [],
            "devices": [],
            "settings": { "defaultShellId": "powershell", "port": 47831 }
        });
        let legacy_path = test_root.join(format!("legacy-{}.json", Uuid::new_v4()));
        fs::write(
            &legacy_path,
            serde_json::to_vec(&legacy).expect("serialize legacy"),
        )
        .expect("write legacy");
        let legacy_store = DesktopStore::load(legacy_path.clone()).expect("load legacy state");
        assert!(legacy_store.settings().follow_working_directory);

        // A legacy file that already pinned the setting to `false` keeps it.
        let explicit_off = serde_json::json!({
            "host": { "id": "host-1", "name": "Workstation" },
            "projects": [],
            "devices": [],
            "settings": { "defaultShellId": "powershell", "port": 47831, "followWorkingDirectory": false }
        });
        let explicit_path = test_root.join(format!("off-{}.json", Uuid::new_v4()));
        fs::write(
            &explicit_path,
            serde_json::to_vec(&explicit_off).expect("serialize"),
        )
        .expect("write");
        let explicit_store =
            DesktopStore::load(explicit_path.clone()).expect("load explicit-off state");
        assert!(!explicit_store.settings().follow_working_directory);

        // Re-enabling persists just like disabling does.
        let mut store = DesktopStore::load(state_path.clone()).expect("reloaded store");
        store
            .set_follow_working_directory(true)
            .expect("re-enable follow");
        drop(store);
        let reenabled = DesktopStore::load(state_path.clone()).expect("final reload");
        assert!(reenabled.settings().follow_working_directory);

        fs::remove_file(state_path).expect("remove test state");
        fs::remove_file(legacy_path).expect("remove legacy test state");
        fs::remove_file(explicit_path).expect("remove explicit-off test state");
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
                enrolled: true,
                registration_status: "enrolled".into(),
                registration_error: None,
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

    fn store_with_device(name: &str) -> (PathBuf, DesktopStore) {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let device = AuthorizedDevice {
            id: "phone-1".into(),
            name: name.into(),
            platform: "android".into(),
            added_at: "2026-08-27T00:00:00Z".into(),
            last_seen_at: "2026-08-27T00:00:00Z".into(),
            online: false,
            viewing_session_ids: Vec::new(),
            port_bridging: DevicePortBridging::default(),
        };
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        store
            .authorize_device(device, "device-credential")
            .expect("authorize device");
        (state_path, store)
    }

    #[test]
    fn update_device_name_changes_and_persists_across_reloads() {
        let (state_path, mut store) = store_with_device("Android phone");

        assert!(
            store
                .update_device_name("phone-1", "Pixel 9 Pro")
                .expect("rename device")
        );
        assert_eq!(store.devices()[0].device.name, "Pixel 9 Pro");
        assert_eq!(store.devices().len(), 1);

        drop(store);
        let reloaded = DesktopStore::load(state_path.clone()).expect("reloaded store");
        assert_eq!(reloaded.devices()[0].device.name, "Pixel 9 Pro");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn update_device_name_trims_blanks_and_ignores_unknown_or_unchanged() {
        let (_state_path, mut store) = store_with_device("Android phone");

        assert!(
            store
                .update_device_name("phone-1", "  Pixel 9 Pro  ")
                .expect("trimmed rename")
        );
        assert_eq!(store.devices()[0].device.name, "Pixel 9 Pro");
        // A repeated rename is a no-op rather than a write.
        assert!(
            !store
                .update_device_name("phone-1", "Pixel 9 Pro")
                .expect("unchanged rename")
        );
        // Blank names are rejected, keeping the previous name in place.
        assert!(
            !store
                .update_device_name("phone-1", "   ")
                .expect("blank rename")
        );
        assert_eq!(store.devices()[0].device.name, "Pixel 9 Pro");
        // Unknown device ids are ignored instead of failing the auth flow.
        assert!(
            !store
                .update_device_name("phone-missing", "Other phone")
                .expect("unknown device rename")
        );
    }

    #[test]
    fn a_device_written_before_port_bridging_loads_with_bridging_switched_off() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        // A state file from a build that had never heard of port bridges.
        let legacy = serde_json::json!({
            "host": { "id": "host-1", "name": "Workstation" },
            "projects": [],
            "devices": [{
                "id": "phone-a",
                "name": "Pixel 7",
                "platform": "android",
                "addedAt": "2026-08-27T00:00:00Z",
                "lastSeenAt": "2026-08-27T00:00:00Z",
                "tokenHash": "00"
            }],
            "settings": { "defaultShellId": "cmd", "port": 47831 }
        });
        fs::write(
            &state_path,
            serde_json::to_vec(&legacy).expect("serialize legacy"),
        )
        .expect("write legacy state");

        let mut store = DesktopStore::load(state_path.clone()).expect("load legacy store");
        assert_eq!(store.devices()[0].device.port_bridging.enabled, false);
        assert!(store.devices()[0].device.port_bridging.bridges.is_empty());

        let bridging = DevicePortBridging {
            enabled: true,
            bridges: vec![PortBridge {
                id: "b1".into(),
                port: 5173,
                server: PortBridgeServer::Host,
                label: Some("dev server".into()),
            }],
        };
        assert!(
            store
                .set_device_port_bridging("phone-a", bridging.clone())
                .expect("save bridging")
        );
        // A device that was revoked while a config page was still open must
        // not silently create a record.
        assert!(
            !store
                .set_device_port_bridging("gone", bridging.clone())
                .expect("unknown device is not an error")
        );

        let reloaded = DesktopStore::load(state_path).expect("reload store");
        assert_eq!(reloaded.devices()[0].device.port_bridging, bridging);
    }
}
