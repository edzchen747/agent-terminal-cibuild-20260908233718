use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::UdpSocket,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU16, Ordering},
    },
    thread,
};

use anyhow::{Context, Result, anyhow};
use chrono::{Duration, Utc};
use percent_encoding::percent_decode_str;
use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};
use regex::Regex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;
use url::Url;
use uuid::Uuid;

use crate::{
    models::{
        AuthorizedDevice, ClientMessage, DesktopState, DirectoryEntry, DirectoryListing, HostInfo,
        HostSnapshot, PROTOCOL_VERSION, PairingPayload, Project, RemoteRegistration, ServerMessage,
        ShellProfile, TerminalDataEvent, TerminalSession,
    },
    network,
    path_utils::user_visible_path,
    provisioning,
    shells::{command_for, detect_shells},
    store::{DesktopStore, NetworkState, random_token},
    window_clients::WindowClients,
};

const MAX_SCROLLBACK_BYTES: usize = 512_000;
const MAX_CONTROL_BYTES: usize = 8_192;
const MAX_PROJECT_NAME_CHARACTERS: usize = 100;
/// Keep in sync with MOBILE_HEARTBEAT_INTERVAL_MS in packages/protocol/src/index.ts.
const MOBILE_HEARTBEAT_INTERVAL_MS: i64 = 60_000;
/// A paired device counts as connected while it has sent anything within this
/// window, so silently dropped sockets turn red instead of staying green.
const PRESENCE_WINDOW_MS: i64 = 2 * MOBILE_HEARTBEAT_INTERVAL_MS;
/// How often to re-check liveness so the indicator flips without waiting for
/// an unrelated broadcast.
const PRESENCE_REFRESH_INTERVAL_MS: u64 = (MOBILE_HEARTBEAT_INTERVAL_MS / 2) as u64;
/// How often the connectivity monitor re-probes for internet access.
const CONNECTIVITY_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

fn presence_now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn presence_alive(last_seen_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(last_seen_at_ms) <= PRESENCE_WINDOW_MS
}

fn is_cursor_position_report(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.len() < 6 || bytes[0] != 0x1b || bytes[1] != b'[' {
        return false;
    }
    let mut index = 2;
    if bytes[index] == b'?' {
        index += 1;
    }
    let first_start = index;
    while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
        index += 1;
    }
    if index == first_start || bytes.get(index) != Some(&b';') {
        return false;
    }
    index += 1;
    let second_start = index;
    while bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()) {
        index += 1;
    }
    index > second_start && bytes.get(index) == Some(&b'R') && index + 1 == bytes.len()
}

fn record_cursor_position_requests(tail: &mut String, data: &str) -> usize {
    const STANDARD: &[u8] = b"\x1b[6n";
    const DEC_PRIVATE: &[u8] = b"\x1b[?6n";
    let bytes = data.as_bytes();
    let crosses_boundary = |query: &[u8]| {
        (1..query.len()).any(|split| {
            tail.as_bytes().ends_with(&query[..split]) && bytes.starts_with(&query[split..])
        })
    };
    let standard = bytes
        .windows(4)
        .filter(|window| *window == STANDARD)
        .count();
    let dec_private = bytes
        .windows(5)
        .filter(|window| *window == DEC_PRIVATE)
        .count();
    let boundary_count =
        usize::from(crosses_boundary(STANDARD)) + usize::from(crosses_boundary(DEC_PRIVATE));
    let combined = format!("{tail}{data}");
    *tail = combined
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    standard + dec_private + boundary_count
}

struct ManagedSession {
    metadata: TerminalSession,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buffer: String,
    control_tail: String,
    cursor_query_tail: String,
    pending_cursor_reports: usize,
    has_run_command: bool,
    terminal_controller: Option<TerminalController>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TerminalController {
    Desktop(String),
    Remote(String),
}

#[derive(Clone)]
pub enum ClientSink {
    Direct {
        messages: mpsc::UnboundedSender<String>,
        close: mpsc::UnboundedSender<()>,
    },
}

struct RemoteClient {
    device_id: Option<String>,
    paired_connection: bool,
    enrollment_requests: u8,
    attached_sessions: HashSet<String>,
    last_seen_at_ms: i64,
    sink: ClientSink,
}

struct PairingGrant {
    expires_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedNodeStatus {
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    tailnet_address: String,
    #[serde(default)]
    error_code: String,
}

struct Inner {
    store: DesktopStore,
    shells: Vec<ShellProfile>,
    temporary_projects: HashMap<String, Project>,
    project_order: Vec<String>,
    sessions: HashMap<String, ManagedSession>,
    session_order: Vec<String>,
    windows: WindowClients,
    pairing_grants: HashMap<String, PairingGrant>,
}

pub struct Core {
    app: AppHandle,
    inner: Mutex<Inner>,
    clients: Mutex<HashMap<String, RemoteClient>>,
    /// Last online-device set observed by the presence refresher, so the
    /// periodic check only broadcasts when liveness actually changed.
    presence_cache: Mutex<Option<HashSet<String>>>,
    embedded_node: Mutex<Option<Child>>,
    desktop_enrollment_running: AtomicBool,
    remote_port: AtomicU16,
    direct_server_ready: AtomicBool,
    exit_requested: AtomicBool,
    /// Runtime knowledge of internet connectivity; the connectivity monitor
    /// keeps it updated so the badge can show "no internet" instead of a
    /// stale stored verdict while the machine has no network.
    network_online: AtomicBool,
}

/// One in-flight network drop should not reset the registration: the monitor
/// only acts on actual connectivity transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectivityAction {
    /// Connectivity was lost; the badge must show a no-internet state.
    ShowOffline,
    /// Connectivity came back; reset the registration to pending and
    /// re-confirm it with the control server.
    Verify,
    /// No transition; nothing to do.
    None,
}

/// Tracks connectivity readings so side effects happen only on transitions.
#[derive(Debug, Default)]
struct ConnectivityTracker {
    previous: Option<bool>,
}

impl ConnectivityTracker {
    fn record(&mut self, online: bool) -> ConnectivityAction {
        let previous = self.previous;
        self.previous = Some(online);
        match previous {
            // The first reading only establishes the baseline, but it decides
            // the badge immediately when the machine starts out offline.
            None if online => ConnectivityAction::None,
            None => ConnectivityAction::ShowOffline,
            Some(value) if value == online => ConnectivityAction::None,
            Some(true) => ConnectivityAction::ShowOffline,
            Some(false) => ConnectivityAction::Verify,
        }
    }
}

impl Core {
    pub fn new(app: AppHandle, store: DesktopStore) -> Arc<Self> {
        let remote_port = store.settings().port;
        let project_order = store
            .projects()
            .iter()
            .map(|project| project.id.clone())
            .collect();
        let core = Arc::new(Self {
            app,
            inner: Mutex::new(Inner {
                store,
                shells: detect_shells(),
                temporary_projects: HashMap::new(),
                project_order,
                sessions: HashMap::new(),
                session_order: Vec::new(),
                windows: WindowClients::default(),
                pairing_grants: HashMap::new(),
            }),
            clients: Mutex::new(HashMap::new()),
            embedded_node: Mutex::new(None),
            desktop_enrollment_running: AtomicBool::new(false),
            remote_port: AtomicU16::new(remote_port),
            direct_server_ready: AtomicBool::new(false),
            exit_requested: AtomicBool::new(false),
            presence_cache: Mutex::new(None),
            network_online: AtomicBool::new(true),
        });
        core.spawn_presence_refresh();
        core
    }

    pub fn initialize(self: &Arc<Self>) -> Result<()> {
        let start_folder = canonical_directory(
            std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?),
        )?;
        let project = {
            let inner = self.inner.lock().expect("desktop state poisoned");
            inner
                .store
                .projects()
                .iter()
                .find(|saved| {
                    normalized_path(Path::new(&saved.path)) == normalized_path(&start_folder)
                })
                .cloned()
                .unwrap_or_else(|| Project {
                    id: format!("temporary-{}", Uuid::new_v4()),
                    name: folder_name(&start_folder),
                    path: start_folder.to_string_lossy().into_owned(),
                    persistent: false,
                    created_at: None,
                })
        };
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.ensure_network_identity()?;
            if !project.persistent {
                inner
                    .temporary_projects
                    .insert(project.id.clone(), project.clone());
                inner.project_order.push(project.id.clone());
            }
        }
        self.create_session(&project.id, None)?;
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Some(mut node) = self
            .embedded_node
            .lock()
            .expect("embedded node poisoned")
            .take()
        {
            let _ = node.kill();
            let _ = node.wait();
        }
        let sessions = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };
        for mut session in sessions {
            let _ = session.killer.kill();
        }
        let clients = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .drain()
            .map(|(_, client)| client)
            .collect::<Vec<_>>();
        for client in clients {
            let ClientSink::Direct { close, .. } = client.sink;
            let _ = close.send(());
        }
    }

    pub fn configured_port(&self) -> u16 {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .store
            .settings()
            .port
    }

    pub fn set_remote_port(&self, port: u16) {
        self.remote_port.store(port, Ordering::Relaxed);
    }

    pub fn set_direct_server_ready(&self, ready: bool) {
        self.direct_server_ready.store(ready, Ordering::Release);
    }

    /// Watches internet connectivity and drives the remote registration state
    /// machine: a lost connection shows the no-internet badge, and regaining
    /// connectivity resets the stored verdict to pending and re-confirms it
    /// with the control server.
    pub fn start_connectivity_monitor(self: &Arc<Self>) {
        let core = Arc::clone(self);
        std::thread::spawn(move || {
            let mut tracker = ConnectivityTracker::default();
            loop {
                match tracker.record(network::internet_connected()) {
                    ConnectivityAction::Verify => {
                        let _ = core.reverify_remote_registration();
                        core.set_network_online(true);
                    }
                    ConnectivityAction::ShowOffline => core.set_network_online(false),
                    ConnectivityAction::None => {}
                }
                std::thread::sleep(CONNECTIVITY_PROBE_INTERVAL);
            }
        });
    }

    fn set_network_online(&self, online: bool) {
        if self.network_online.swap(online, Ordering::AcqRel) != online {
            self.broadcast();
        }
    }

    pub fn request_exit(&self) {
        self.exit_requested.store(true, Ordering::Release);
    }

    pub fn exit_requested(&self) -> bool {
        self.exit_requested.load(Ordering::Acquire)
    }

    pub fn control_url(&self) -> String {
        network::control_url()
    }

    pub fn remote_endpoint(&self) -> String {
        if let Some(value) = std::env::var("AGENT_TERMINAL_REMOTE_ENDPOINT")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return value.trim().trim_end_matches('/').to_string();
        }
        let inner = self.inner.lock().expect("desktop state poisoned");
        let host_id = &inner.store.host().id;
        let port = inner.store.settings().port;
        format!("ws://{host_id}.{}:{port}", network::tailnet_domain())
    }

    pub fn remote_transport(&self) -> String {
        std::env::var("AGENT_TERMINAL_REMOTE_TRANSPORT")
            .ok()
            .filter(|value| matches!(value.as_str(), "direct" | "overlay"))
            .unwrap_or_else(|| "overlay".into())
    }

    pub fn network_state(&self) -> NetworkState {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .store
            .network()
            .clone()
    }

    pub fn start_embedded_node(&self) -> Result<bool> {
        self.start_embedded_node_with_auth_key(None)
    }

    fn start_embedded_node_with_auth_key(&self, auth_key: Option<&str>) -> Result<bool> {
        if std::env::var("AGENT_TERMINAL_DISABLE_EMBEDDED_NODE").as_deref() == Ok("1") {
            return Ok(false);
        }

        {
            let mut process = self.embedded_node.lock().expect("embedded node poisoned");
            if let Some(child) = process.as_mut() {
                if child.try_wait()?.is_none() {
                    return Ok(true);
                }
                *process = None;
            }
        }

        let binary = embedded_node_binary(&self.app);
        let Some(binary) = binary.filter(|path| path.is_file()) else {
            return Ok(false);
        };
        let (network_state, host_id) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let network_state = inner.store.ensure_network_identity()?;
            let host_id = inner.store.host().id.clone();
            (network_state, host_id)
        };
        let state_dir = self.embedded_node_state_dir()?;
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("could not create {}", state_dir.display()))?;
        let _ = std::fs::remove_file(state_dir.join("status.json"));

        let mut command = Command::new(&binary);
        command
            .arg("--state-dir")
            .arg(&state_dir)
            .arg("--control-url")
            .arg(self.control_url())
            .arg("--node-id")
            .arg(host_id.clone())
            // The embedded node establishes the overlay route; the Tauri
            // process remains the only listener for the terminal WebSocket.
            .arg("--target-port")
            .arg(self.configured_port().to_string())
            .env(
                "AGENT_TERMINAL_NODE_PRIVATE_KEY",
                network_state.private_key.unwrap_or_default(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            // Do not let a console-subsystem node allocate a visible console
            // when it is launched by the GUI application. The packaged node
            // is also built as a GUI binary, but this keeps older/developer
            // binaries from flashing a blank cmd window.
            use std::os::windows::process::CommandExt;

            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        if let Some(auth_key) = auth_key {
            command.env("AGENT_TERMINAL_NODE_AUTH_KEY", auth_key);
        }
        let child = command
            .spawn()
            .with_context(|| format!("could not start embedded node {}", binary.display()))?;
        *self.embedded_node.lock().expect("embedded node poisoned") = Some(child);
        Ok(true)
    }

    fn embedded_node_state_dir(&self) -> Result<PathBuf> {
        std::env::var_os("AGENT_TERMINAL_EMBEDDED_NODE_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                self.app
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|path| path.join("embedded-node"))
            })
            .ok_or_else(|| anyhow!("Could not determine the embedded node state directory."))
    }

    fn stop_embedded_node(&self) {
        if let Some(mut child) = self
            .embedded_node
            .lock()
            .expect("embedded node poisoned")
            .take()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    async fn wait_for_embedded_node(&self) -> Result<EmbeddedNodeStatus> {
        let status_path = self.embedded_node_state_dir()?.join("status.json");
        for _ in 0..120 {
            if let Ok(contents) = std::fs::read_to_string(&status_path)
                && let Ok(status) = serde_json::from_str::<EmbeddedNodeStatus>(&contents)
            {
                if !status.error_code.is_empty() {
                    return Err(anyhow!("embedded node enrollment was rejected"));
                }
                if !status.tailnet_address.is_empty() {
                    return Ok(status);
                }
            }
            {
                let mut process = self.embedded_node.lock().expect("embedded node poisoned");
                if let Some(child) = process.as_mut()
                    && child.try_wait()?.is_some()
                {
                    *process = None;
                    return Err(anyhow!(
                        "embedded node stopped before registration completed"
                    ));
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        Err(anyhow!("embedded node registration timed out"))
    }

    fn embedded_node_status(&self) -> Option<EmbeddedNodeStatus> {
        let status_path = self.embedded_node_state_dir().ok()?.join("status.json");
        let contents = std::fs::read_to_string(status_path).ok()?;
        serde_json::from_str(&contents).ok()
    }

    fn paired_device_id(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .store
            .devices()
            .first()
            .map(|device| device.device.id.clone())
    }

    fn set_remote_registration(
        &self,
        status: &str,
        error: Option<String>,
        enrolled: bool,
        node: Option<&EmbeddedNodeStatus>,
    ) -> Result<()> {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let mut network = inner.store.network().clone();
        network.registration_status = status.into();
        network.registration_error = error;
        network.enrolled = enrolled;
        if let Some(node) = node {
            network.node_id = Some(node.node_id.clone());
            network.tailnet_address = Some(node.tailnet_address.clone());
            network.last_connected_at = Some(Utc::now().to_rfc3339());
        }
        inner.store.save_network(network)
    }

    pub fn begin_desktop_enrollment(self: &Arc<Self>, device_id: String) -> Result<()> {
        self.start_desktop_enrollment(device_id, false)
    }

    fn start_desktop_enrollment(
        self: &Arc<Self>,
        device_id: String,
        replace_stale_registration: bool,
    ) -> Result<()> {
        if self.network_state().enrolled && !replace_stale_registration {
            return Ok(());
        }
        if self
            .desktop_enrollment_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        if let Err(error) = self.set_remote_registration("pending", None, false, None) {
            self.desktop_enrollment_running
                .store(false, Ordering::Release);
            return Err(error);
        }
        self.broadcast();

        let core = Arc::clone(self);
        let host_id = self.snapshot().host.id;
        tauri::async_runtime::spawn(async move {
            let result = async {
                let nonce = random_token(32);
                let enrollment =
                    provisioning::issue_node_key("desktop", &host_id, &device_id, &nonce).await?;
                core.stop_embedded_node();
                let started = core.start_embedded_node_with_auth_key(Some(&enrollment.auth_key))?;
                drop(enrollment);
                if !started {
                    return Err(anyhow!("the embedded network component is unavailable"));
                }
                core.wait_for_embedded_node().await
            }
            .await;

            match result {
                Ok(node) => {
                    let _ = core.set_remote_registration("enrolled", None, true, Some(&node));
                }
                Err(error) => {
                    core.stop_embedded_node();
                    eprintln!("Agent Terminal desktop enrollment failed: {error:#}");
                    let _ = core.set_remote_registration(
                        "failed",
                        Some(
                            "Remote connection registration failed. LAN access is still available."
                                .into(),
                        ),
                        false,
                        None,
                    );
                }
            }
            core.desktop_enrollment_running
                .store(false, Ordering::Release);
            core.broadcast();
        });
        Ok(())
    }

    pub fn retry_desktop_enrollment(self: &Arc<Self>) -> Result<()> {
        let device_id = self
            .paired_device_id()
            .ok_or_else(|| anyhow!("Pair a mobile device before enabling remote access."))?;
        self.start_desktop_enrollment(device_id, true)
    }

    pub fn resume_remote_node(self: &Arc<Self>) {
        if self.prepare_remote_verification() {
            self.verify_remote_node(false);
        }
    }

    /// Connectivity came back after an outage: the stored verdict is stale, so
    /// reset to pending and re-confirm the registration with the control
    /// server before the badge may show "enrolled" again.
    pub fn reverify_remote_registration(self: &Arc<Self>) -> Result<()> {
        if self
            .desktop_enrollment_running
            .load(Ordering::Acquire)
        {
            // An enrollment run already resolves the registration against the
            // server; restarting the node now would only race its result.
            return Ok(());
        }
        if self.prepare_remote_verification() {
            self.verify_remote_node(true);
        }
        Ok(())
    }

    /// Writes the pending state and reports whether a verification may begin.
    /// Nothing is ever verified for a host that has never paired, which keeps
    /// the badge on "LAN access ready".
    fn prepare_remote_verification(&self) -> bool {
        let network = self.network_state();
        let has_known_registration = network.enrolled
            || network.node_id.is_some()
            || network.registration_status != "unregistered";
        if !has_known_registration {
            return false;
        }
        // Never trust the last stored verdict: the node may have been revoked
        // or expired since. Default to pending and let the control server
        // confirm the registration before showing it again.
        if let Err(error) = self.set_remote_registration("pending", None, network.enrolled, None)
        {
            eprintln!("Agent Terminal could not mark remote access as pending: {error:#}");
            return false;
        }
        self.broadcast();
        true
    }

    fn verify_remote_node(self: &Arc<Self>, force_restart: bool) {
        let core = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if force_restart {
                // A still-running node never rewrites its status file, so the
                // server verdict must come from a fresh process.
                core.stop_embedded_node();
            }
            let started = match core.start_embedded_node() {
                Ok(started) => started,
                Err(error) => {
                    eprintln!("Agent Terminal embedded network node is unavailable: {error:#}");
                    let _ = core.set_remote_registration(
                        "failed",
                        Some("Remote connection registration failed. LAN access is still available.".into()),
                        true,
                        None,
                    );
                    core.broadcast();
                    return;
                }
            };
            if !started {
                let _ = core.set_remote_registration(
                    "failed",
                    Some("The embedded network component is unavailable. Update the desktop app and try again.".into()),
                    true,
                    None,
                );
                core.broadcast();
                return;
            }

            match core.wait_for_embedded_node().await {
                Ok(node) => {
                    let _ = core.set_remote_registration("enrolled", None, true, Some(&node));
                    core.broadcast();
                }
                Err(error) => {
                    let dropped = core
                        .embedded_node_status()
                        .as_ref()
                        .is_some_and(is_dropped_node_status);
                    core.stop_embedded_node();
                    if dropped {
                        eprintln!(
                            "Agent Terminal desktop node is no longer registered; requesting a replacement enrollment: {error:#}"
                        );
                        if let Some(device_id) = core.paired_device_id() {
                            if let Err(retry_error) =
                                core.start_desktop_enrollment(device_id, true)
                            {
                                eprintln!(
                                    "Agent Terminal could not restart desktop enrollment: {retry_error:#}"
                                );
                                let _ = core.set_remote_registration(
                                    "failed",
                                    Some("The desktop node was removed and could not be registered again. LAN access is still available.".into()),
                                    false,
                                    None,
                                );
                            }
                        } else {
                            let _ = core.set_remote_registration(
                                "failed",
                                Some("The desktop node was removed. Pair a mobile device on LAN to register it again.".into()),
                                false,
                                None,
                            );
                        }
                    } else {
                        eprintln!(
                            "Agent Terminal embedded network node did not resume: {error:#}"
                        );
                        let _ = core.set_remote_registration(
                            "failed",
                            Some("Remote connection registration failed. LAN access is still available.".into()),
                            true,
                            None,
                        );
                    }
                    core.broadcast();
                }
            }
        });
    }

    pub fn state_for_window(&self, label: &str) -> DesktopState {
        let inner = self.inner.lock().expect("desktop state poisoned");
        let current_project_id = inner
            .windows
            .project_for_window(label)
            .map(str::to_owned)
            .unwrap_or_default();
        let online_device_ids = self.online_device_ids();
        let network = inner.store.network();
        DesktopState {
            snapshot: snapshot_from_inner(&inner, &online_device_ids),
            current_project_id,
            open_projects_in_new_windows: inner.store.settings().open_projects_in_new_windows,
            confirm_external_links: inner.store.settings().confirm_external_links,
            remote_registration: RemoteRegistration {
                status: registration_status_for_display(
                    self.network_online.load(Ordering::Acquire),
                    &network.registration_status,
                ),
                error: network.registration_error.clone(),
            },
        }
    }

    pub fn snapshot(&self) -> HostSnapshot {
        let inner = self.inner.lock().expect("desktop state poisoned");
        let online_device_ids = self.online_device_ids();
        snapshot_from_inner(&inner, &online_device_ids)
    }

    fn online_device_ids(&self) -> HashSet<String> {
        let now_ms = presence_now_ms();
        self.clients
            .lock()
            .expect("remote clients poisoned")
            .values()
            .filter(|client| client.device_id.is_some())
            .filter(|client| presence_alive(client.last_seen_at_ms, now_ms))
            .filter_map(|client| client.device_id.clone())
            .collect()
    }

    fn spawn_presence_refresh(self: &Arc<Self>) {
        let core = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(
                PRESENCE_REFRESH_INTERVAL_MS,
            ));
            core.refresh_online_presence();
        });
    }

    fn refresh_online_presence(self: &Arc<Self>) {
        let online = self.online_device_ids();
        let mut cache = self
            .presence_cache
            .lock()
            .expect("presence cache poisoned");
        if cache.as_ref() != Some(&online) {
            *cache = Some(online);
            drop(cache);
            self.broadcast();
        }
    }

    pub fn broadcast(&self) {
        for label in self.app.webview_windows().into_keys() {
            let registered = self
                .inner
                .lock()
                .expect("desktop state poisoned")
                .windows
                .is_registered(&label);
            if registered {
                let _ = self.app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "desktop-state",
                    self.state_for_window(&label),
                );
            }
        }
        let snapshot = self.snapshot();
        let client_ids = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .iter()
            .filter_map(|(id, client)| client.device_id.as_ref().map(|_| id.clone()))
            .collect::<Vec<_>>();
        for client_id in client_ids {
            self.send_to_client(
                &client_id,
                ServerMessage::Snapshot {
                    request_id: None,
                    snapshot: snapshot.clone(),
                },
            );
        }
    }

    pub fn mark_window_focused(&self, label: &str) {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        inner.windows.mark_focused(label);
    }

    pub fn unregister_window(&self, label: &str) {
        let project_id = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .remove_window(label);
        if let Some(project_id) = project_id {
            self.cleanup_empty_temporary_project(&project_id);
        }
    }

    pub fn show_terminal_window(self: &Arc<Self>) {
        let (label, fallback_project) = {
            let inner = self.inner.lock().expect("desktop state poisoned");
            let preferred = inner
                .windows
                .last_project()
                .filter(|project_id| project_by_id(&inner, project_id).is_some())
                .map(str::to_owned)
                .or_else(|| {
                    inner
                        .sessions
                        .values()
                        .filter(|session| session.metadata.status == "running")
                        .max_by(|left, right| {
                            left.metadata.created_at.cmp(&right.metadata.created_at)
                        })
                        .map(|session| session.metadata.project_id.clone())
                });
            (
                inner.windows.last_or_any(),
                preferred.or_else(|| {
                    public_projects(&inner)
                        .first()
                        .map(|project| project.id.clone())
                }),
            )
        };
        if let Some(label) = label
            && let Some(window) = self.app.get_webview_window(&label)
        {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
        if let Some(project_id) = fallback_project {
            let _ = self.ensure_project_window(&project_id);
        }
    }

    pub fn ensure_project_window(self: &Arc<Self>, project_id: &str) -> Result<()> {
        self.ensure_project_window_with_focus(project_id, true, None)
    }

    fn ensure_project_window_in_background(self: &Arc<Self>, project_id: &str) -> Result<()> {
        self.ensure_project_window_with_focus(project_id, false, None)
    }

    fn ensure_project_window_with_focus(
        self: &Arc<Self>,
        project_id: &str,
        focus: bool,
        preferred_window: Option<&str>,
    ) -> Result<()> {
        let reusable = {
            let inner = self.inner.lock().expect("desktop state poisoned");
            (!inner.store.settings().open_projects_in_new_windows)
                .then(|| {
                    preferred_window
                        .filter(|label| inner.windows.is_registered(label))
                        .map(str::to_owned)
                        .or_else(|| inner.windows.last_or_any())
                })
                .flatten()
        };
        if let Some(label) = reusable {
            let (project, displaced) = {
                let project = self.project_by_id(project_id)?;
                let displaced = self
                    .inner
                    .lock()
                    .expect("desktop state poisoned")
                    .windows
                    .assign(&label, project_id)
                    .displaced_window;
                (project, displaced)
            };
            if let Some(displaced) = displaced
                && let Some(window) = self.app.get_webview_window(&displaced)
            {
                let _ = window.destroy();
            }
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.set_title(&format!("{} — Agent Terminal", project.name));
                let _ = window.unminimize();
                window.show()?;
                if focus {
                    window.set_focus()?;
                    self.mark_window_focused(&label);
                }
                self.broadcast();
                return Ok(());
            }
        }
        let existing = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .window_for_project(project_id)
            .map(str::to_owned);
        if let Some(label) = existing
            && let Some(window) = self.app.get_webview_window(&label)
        {
            let _ = window.unminimize();
            window.show()?;
            if focus {
                window.set_focus()?;
                self.mark_window_focused(&label);
            }
            return Ok(());
        }

        let project = self.project_by_id(project_id)?;
        let label = format!("terminal-{}", Uuid::new_v4());
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.windows.assign(&label, &project.id);
            if focus {
                inner.windows.mark_focused(&label);
            }
        }
        let built =
            WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::App("index.html".into()))
                .title(format!("{} — Agent Terminal", project.name))
                .inner_size(1320.0, 820.0)
                .min_inner_size(840.0, 560.0)
                .visible(focus)
                .build();
        let window = match built {
            Ok(window) => window,
            Err(error) => {
                self.inner
                    .lock()
                    .expect("desktop state poisoned")
                    .windows
                    .remove_window(&label);
                return Err(error.into());
            }
        };
        if !focus {
            window.show()?;
        }
        if focus {
            window.set_focus()?;
        }
        Ok(())
    }

    pub fn open_project(
        self: &Arc<Self>,
        project_id: &str,
        preferred_window: Option<&str>,
    ) -> Result<()> {
        let has_running = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .sessions
            .values()
            .any(|session| {
                session.metadata.project_id == project_id && session.metadata.status == "running"
            });
        if !has_running {
            self.create_session(project_id, None)?;
        } else {
            self.ensure_project_window_with_focus(project_id, true, preferred_window)?;
        }
        Ok(())
    }

    pub fn create_persistent_project(
        self: &Arc<Self>,
        name: &str,
        folder: &str,
    ) -> Result<Project> {
        let resolved = canonical_directory(folder)?;
        let name = name.trim();
        if !name.is_empty() {
            validate_project_name(name)?;
        }
        let normalized = normalized_path(&resolved);
        let mut persisted_existing = None;
        let project = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            if let Some(existing) = inner
                .store
                .projects()
                .iter()
                .find(|project| normalized_path(Path::new(&project.path)) == normalized)
                .cloned()
            {
                existing
            } else if let Some(existing) = inner
                .temporary_projects
                .values()
                .find(|project| normalized_path(Path::new(&project.path)) == normalized)
                .cloned()
            {
                persisted_existing = Some(existing.id.clone());
                existing
            } else {
                let project = Project {
                    id: Uuid::new_v4().to_string(),
                    name: if name.is_empty() {
                        folder_name(&resolved)
                    } else {
                        name.to_string()
                    },
                    path: resolved.to_string_lossy().into_owned(),
                    persistent: true,
                    created_at: Some(Utc::now().to_rfc3339()),
                };
                inner.store.save_project(project.clone())?;
                inner.project_order.push(project.id.clone());
                project
            }
        };
        if let Some(project_id) = persisted_existing {
            return self.set_project_persistence(&project_id, true);
        }
        self.broadcast();
        Ok(project)
    }

    pub fn rename_project(&self, project_id: &str, name: &str) -> Result<Project> {
        let name = name.trim();
        let (project, window_label) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let mut project =
                project_by_id(&inner, project_id).ok_or_else(|| anyhow!("Project not found."))?;
            project.name = project_name_or_folder(name, Path::new(&project.path))?;
            project.persistent = true;
            if project.created_at.is_none() {
                project.created_at = Some(Utc::now().to_rfc3339());
            }
            inner.store.save_project(project.clone())?;
            inner.temporary_projects.remove(project_id);
            let window_label = inner
                .windows
                .window_for_project(project_id)
                .map(str::to_owned);
            (project, window_label)
        };
        if let Some(window) = window_label.and_then(|label| self.app.get_webview_window(&label)) {
            let _ = window.set_title(&format!("{} — Agent Terminal", project.name));
        }
        self.broadcast();
        Ok(project)
    }

    pub fn reorder_projects(&self, project_ids: &[String]) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let public_ids = public_projects(&inner)
                .into_iter()
                .map(|project| project.id)
                .collect::<HashSet<_>>();
            let requested_ids = project_ids.iter().cloned().collect::<HashSet<_>>();
            if requested_ids.len() != project_ids.len() || requested_ids != public_ids {
                return Err(anyhow!(
                    "Project order does not match the available projects."
                ));
            }
            inner.project_order = project_ids.to_vec();
            let saved = project_ids
                .iter()
                .filter(|id| {
                    inner
                        .store
                        .projects()
                        .iter()
                        .any(|project| project.id.as_str() == id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            inner.store.reorder_projects(&saved)?;
        }
        self.broadcast();
        Ok(())
    }

    pub fn set_open_projects_in_new_windows(
        &self,
        enabled: bool,
        preferred_window: Option<&str>,
    ) -> Result<()> {
        let windows_to_close = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.set_open_projects_in_new_windows(enabled)?;
            if enabled {
                Vec::new()
            } else {
                let keep = preferred_window
                    .filter(|label| inner.windows.is_registered(label))
                    .map(str::to_owned)
                    .or_else(|| inner.windows.last_or_any());
                inner
                    .windows
                    .labels()
                    .into_iter()
                    .filter(|label| Some(label) != keep.as_ref())
                    .collect::<Vec<_>>()
            }
        };
        for label in windows_to_close {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
        self.broadcast();
        Ok(())
    }

    pub fn set_confirm_external_links(&self, enabled: bool) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.set_confirm_external_links(enabled)?;
        }
        self.broadcast();
        Ok(())
    }

    pub fn list_directories(&self, folder: Option<&str>) -> Result<DirectoryListing> {
        let requested = folder
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
            .unwrap_or(std::env::current_dir()?);
        let current = canonical_directory(requested)?;
        let mut directories = fs::read_dir(&current)
            .with_context(|| format!("Could not read desktop folder: {}", current.display()))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_dir())
                    .map(|_| DirectoryEntry {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        path: user_visible_path(entry.path())
                            .to_string_lossy()
                            .into_owned(),
                    })
            })
            .collect::<Vec<_>>();
        directories.sort_by_cached_key(|entry| entry.name.to_lowercase());
        Ok(DirectoryListing {
            path: current.to_string_lossy().into_owned(),
            parent_path: current
                .parent()
                .map(user_visible_path)
                .map(|path| path.to_string_lossy().into_owned()),
            directories,
        })
    }

    pub fn set_project_persistence(&self, project_id: &str, persistent: bool) -> Result<Project> {
        let (project, window_label) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let current =
                project_by_id(&inner, project_id).ok_or_else(|| anyhow!("Project not found."))?;
            if current.persistent == persistent {
                return Ok(current);
            }
            let mut project = current;
            project.persistent = persistent;
            if persistent {
                if project.created_at.is_none() {
                    project.created_at = Some(Utc::now().to_rfc3339());
                }
                inner.store.save_project(project.clone())?;
                inner.temporary_projects.remove(project_id);
            } else {
                inner.store.remove_project(project_id)?;
                project.name = folder_name(Path::new(&project.path));
                project.created_at = None;
                inner
                    .temporary_projects
                    .insert(project_id.to_string(), project.clone());
            }
            let window_label = inner
                .windows
                .window_for_project(project_id)
                .map(str::to_owned);
            (project, window_label)
        };
        if let Some(window) = window_label.and_then(|label| self.app.get_webview_window(&label)) {
            let _ = window.set_title(&format!("{} — Agent Terminal", project.name));
        }
        self.broadcast();
        Ok(project)
    }

    pub fn create_session(
        self: &Arc<Self>,
        project_id: &str,
        shell_id: Option<&str>,
    ) -> Result<TerminalSession> {
        let (project, shell) = {
            let inner = self.inner.lock().expect("desktop state poisoned");
            let project =
                project_by_id(&inner, project_id).ok_or_else(|| anyhow!("Project not found."))?;
            let wanted = shell_id.unwrap_or(inner.store.settings().default_shell_id.as_str());
            let shell = inner
                .shells
                .iter()
                .find(|shell| shell.id == wanted)
                .or_else(|| inner.shells.first())
                .cloned()
                .ok_or_else(|| anyhow!("No supported shell was found."))?;
            (project, shell)
        };

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut child = pair
            .slave
            .spawn_command(command_for(&shell, &project.path))?;
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let id = Uuid::new_v4().to_string();
        let metadata = TerminalSession {
            id: id.clone(),
            project_id: project.id.clone(),
            title: shell.name.clone(),
            cwd: project.path.clone(),
            shell_id: shell.id.clone(),
            status: "running".into(),
            created_at: Utc::now().to_rfc3339(),
            exit_code: None,
        };
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.sessions.insert(
                id.clone(),
                ManagedSession {
                    metadata: metadata.clone(),
                    master: pair.master,
                    writer,
                    killer,
                    buffer: String::new(),
                    control_tail: String::new(),
                    cursor_query_tail: String::new(),
                    pending_cursor_reports: 0,
                    has_run_command: false,
                    terminal_controller: None,
                },
            );
            inner.session_order.push(id.clone());
        }

        let reader_core = Arc::clone(self);
        let reader_id = id.clone();
        thread::spawn(move || {
            let mut bytes = vec![0_u8; 16_384];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => reader_core.on_terminal_data(
                        &reader_id,
                        String::from_utf8_lossy(&bytes[..size]).into_owned(),
                    ),
                }
            }
        });
        let waiter_core = Arc::clone(self);
        let waiter_id = id.clone();
        thread::spawn(move || {
            if let Ok(status) = child.wait() {
                waiter_core.on_terminal_exit(&waiter_id, status.exit_code());
            }
        });

        if let Err(error) = self.ensure_project_window(&project.id) {
            self.close_session(&id);
            return Err(error);
        }
        self.broadcast();
        Ok(metadata)
    }

    pub fn close_session(self: &Arc<Self>, session_id: &str) {
        let project_id = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(mut session) = inner.sessions.remove(session_id) else {
                return;
            };
            inner.session_order.retain(|id| id != session_id);
            let _ = session.killer.kill();
            session.metadata.project_id
        };
        self.cleanup_empty_temporary_project(&project_id);
        self.broadcast();
    }

    pub fn reorder_project_sessions(&self, project_id: &str, session_ids: &[String]) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let project_session_ids = inner
                .sessions
                .values()
                .filter(|session| session.metadata.project_id == project_id)
                .map(|session| session.metadata.id.clone())
                .collect::<HashSet<_>>();
            let requested_ids = session_ids.iter().cloned().collect::<HashSet<_>>();
            if requested_ids.len() != session_ids.len() || requested_ids != project_session_ids {
                return Err(anyhow!("Tab order does not match the project's sessions."));
            }
            let mut requested = session_ids.iter();
            let project_slots = inner
                .session_order
                .iter()
                .map(|id| project_session_ids.contains(id))
                .collect::<Vec<_>>();
            for (id, belongs_to_project) in inner.session_order.iter_mut().zip(project_slots) {
                if belongs_to_project {
                    *id = requested
                        .next()
                        .expect("validated project session order")
                        .clone();
                }
            }
        }
        self.broadcast();
        Ok(())
    }

    fn write_session_from(
        &self,
        session_id: &str,
        data: &str,
        controller: TerminalController,
        size: Option<(u16, u16)>,
    ) {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let Some(session) = inner.sessions.get_mut(session_id) else {
            return;
        };
        if session.metadata.status != "running" {
            return;
        }

        // A CPR is valid only as a response to a live query emitted by the
        // shell. Replayed PTY history and duplicate xterm responses otherwise
        // arrive on the same input stream as typed keys; PSReadLine interprets
        // those stale reports as an editing key and rings the bell.
        if is_cursor_position_report(data) {
            if session.pending_cursor_reports == 0 {
                return;
            }
            session.pending_cursor_reports -= 1;
        } else {
            session.terminal_controller = Some(controller.clone());
            if let Some((cols, rows)) = size {
                Self::resize_managed_session(session, cols, rows);
            }
        }

        if data.contains('\r') || data.contains('\n') {
            session.has_run_command = true;
        }
        let _ = session.writer.write_all(data.as_bytes());
        let _ = session.writer.flush();
    }

    pub fn write_desktop_session(
        &self,
        window_label: &str,
        session_id: &str,
        data: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) {
        self.write_session_from(
            session_id,
            data,
            TerminalController::Desktop(window_label.to_string()),
            cols.zip(rows),
        );
    }

    fn write_remote_session(&self, client_id: &str, session_id: &str, data: &str) {
        self.write_session_from(
            session_id,
            data,
            TerminalController::Remote(client_id.to_string()),
            None,
        );
    }

    fn resize_session_from(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        controller: TerminalController,
    ) {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let Some(session) = inner.sessions.get_mut(session_id) else {
            return;
        };
        if session.metadata.status != "running" {
            return;
        }
        session.terminal_controller = Some(controller);
        Self::resize_managed_session(session, cols, rows);
    }

    pub fn resize_desktop_session(
        &self,
        window_label: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
        _force: bool,
    ) {
        self.resize_session_from(
            session_id,
            cols,
            rows,
            TerminalController::Desktop(window_label.to_string()),
        );
    }

    fn resize_remote_session(&self, client_id: &str, session_id: &str, cols: u16, rows: u16) {
        self.resize_session_from(
            session_id,
            cols,
            rows,
            TerminalController::Remote(client_id.to_string()),
        );
    }

    fn release_remote_controller(&self, client_id: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let Some(session) = inner.sessions.get_mut(session_id) else {
            return;
        };
        if session.terminal_controller == Some(TerminalController::Remote(client_id.to_string())) {
            session.terminal_controller = None;
        }
    }

    fn resize_managed_session(session: &ManagedSession, cols: u16, rows: u16) {
        let cols = cols.clamp(2, 500);
        let rows = rows.clamp(1, 200);
        // A resize is already a PTY notification.  Do not pulse through a
        // second row count for `force`: ConPTY can make a focused line editor
        // beep or lose the key being entered when it sees the synthetic
        // rows-1 -> rows transition.
        let _ = session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn attach_window_session(&self, label: &str, session_id: &str) -> Result<String> {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let window_project_id = inner
            .windows
            .project_for_window(label)
            .map(str::to_owned)
            .ok_or_else(|| {
                anyhow!("Terminal window is no longer registered with the tray host.")
            })?;
        let (session_project_id, buffer) = inner
            .sessions
            .get(session_id)
            .map(|session| (session.metadata.project_id.clone(), session.buffer.clone()))
            .ok_or_else(|| anyhow!("Terminal session not found."))?;
        if session_project_id != window_project_id {
            return Err(anyhow!("Terminal session moved to another project window."));
        }
        if let Some(session) = inner.sessions.get_mut(session_id) {
            session.terminal_controller = Some(TerminalController::Desktop(label.to_string()));
        }
        if !inner.windows.attach(label, session_id) {
            return Err(anyhow!(
                "Terminal window is no longer registered with the tray host."
            ));
        }
        Ok(buffer)
    }

    pub fn detach_window_session(&self, label: &str, session_id: &str) {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .detach(label, session_id);
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        if inner
            .sessions
            .get(session_id)
            .and_then(|session| session.terminal_controller.as_ref())
            == Some(&TerminalController::Desktop(label.to_string()))
        {
            if let Some(session) = inner.sessions.get_mut(session_id) {
                session.terminal_controller = None;
            }
        }
    }

    fn session_buffer(&self, session_id: &str) -> String {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .sessions
            .get(session_id)
            .map(|session| session.buffer.clone())
            .unwrap_or_default()
    }

    pub fn set_default_shell(&self, shell_id: &str) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            if !inner.shells.iter().any(|shell| shell.id == shell_id) {
                return Err(anyhow!("Shell profile not found."));
            }
            inner.store.set_default_shell(shell_id.to_string())?;
        }
        self.broadcast();
        Ok(())
    }

    pub fn select_shell(
        self: &Arc<Self>,
        session_id: Option<&str>,
        shell_id: &str,
    ) -> Result<Option<TerminalSession>> {
        self.set_default_shell(shell_id)?;
        let Some(session_id) = session_id else {
            return Ok(None);
        };
        let switch = {
            let inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get(session_id) else {
                return Ok(None);
            };
            if session.metadata.shell_id == shell_id {
                None
            } else {
                Some((
                    session.metadata.project_id.clone(),
                    !session.has_run_command,
                ))
            }
        };
        let Some((project_id, replace_current)) = switch else {
            return Ok(None);
        };
        let replacement = self.create_session(&project_id, Some(shell_id))?;
        if replace_current {
            self.close_session(session_id);
        }
        Ok(Some(replacement))
    }

    pub fn start_pairing(&self) -> Result<PairingPayload> {
        if !self.direct_server_ready.load(Ordering::Acquire) {
            return Err(anyhow!(
                "Local pairing is unavailable because this process does not own port {}. Another Agent Terminal instance may already be running in the tray. Exit every Agent Terminal tray instance, then reopen the latest build.",
                self.configured_port()
            ));
        }
        let token = random_token(24);
        let expires_at = Utc::now() + Duration::minutes(5);
        let (host_id, host_name) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.pairing_grants.insert(
                token.clone(),
                PairingGrant {
                    expires_at_ms: expires_at.timestamp_millis(),
                },
            );
            (
                inner.store.host().id.clone(),
                inner.store.host().name.clone(),
            )
        };
        let local_endpoint = format!(
            "ws://{}:{}",
            local_address(),
            self.remote_port.load(Ordering::Relaxed)
        );
        Ok(PairingPayload {
            version: PROTOCOL_VERSION,
            host_id,
            host_name,
            endpoint: local_endpoint.clone(),
            local_endpoint: Some(local_endpoint),
            remote_endpoint: Some(self.remote_endpoint()),
            remote_transport: Some(self.remote_transport()),
            control_url: Some(self.control_url()),
            transport: "direct".into(),
            pairing_token: token,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<()> {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .store
            .revoke_device(device_id)?;
        self.disconnect_device(device_id);
        self.broadcast();
        Ok(())
    }

    pub fn add_direct_client(
        &self,
        id: String,
        messages: mpsc::UnboundedSender<String>,
        close: mpsc::UnboundedSender<()>,
    ) {
        self.clients
            .lock()
            .expect("remote clients poisoned")
            .insert(
                id,
                RemoteClient {
                    device_id: None,
                    paired_connection: false,
                    enrollment_requests: 0,
                    attached_sessions: HashSet::new(),
                    last_seen_at_ms: presence_now_ms(),
                    sink: ClientSink::Direct { messages, close },
                },
            );
    }

    pub fn remove_client(&self, id: &str) {
        let device_id = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .remove(id)
            .and_then(|client| client.device_id);
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        for session in inner.sessions.values_mut() {
            if session.terminal_controller == Some(TerminalController::Remote(id.to_string())) {
                session.terminal_controller = None;
            }
        }
        drop(inner);
        if device_id.is_some() {
            self.broadcast();
        }
    }

    pub fn handle_client_raw(self: &Arc<Self>, client_id: &str, raw: &str) {
        if let Some(client) = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .get_mut(client_id)
        {
            client.last_seen_at_ms = presence_now_ms();
        }
        let message = match serde_json::from_str::<ClientMessage>(raw) {
            Ok(message) => message,
            Err(_) => {
                self.send_to_client(
                    client_id,
                    ServerMessage::Error {
                        request_id: None,
                        code: "BAD_MESSAGE".into(),
                        message: "The message could not be parsed.".into(),
                    },
                );
                return;
            }
        };
        let request_id = message.request_id().map(str::to_owned);

        match message {
            ClientMessage::Pair {
                request_id,
                token,
                device,
            } => {
                let Some(device_token) = self.consume_pairing_grant(&token, &device) else {
                    self.send_to_client(client_id, ServerMessage::Error {
                        request_id: Some(request_id), code: "PAIRING_DENIED".into(),
                        message: "This pairing QR is no longer valid. Reopen the desktop pairing window and scan the new QR.".into(),
                    });
                    return;
                };
                if let Some(client) = self
                    .clients
                    .lock()
                    .expect("remote clients poisoned")
                    .get_mut(client_id)
                {
                    client.device_id = Some(device.id.clone());
                    client.paired_connection = true;
                    client.enrollment_requests = 0;
                }
                let paired_device_id = device.id.clone();
                self.send_to_client(
                    client_id,
                    ServerMessage::PairAccepted {
                        request_id,
                        device_token,
                        snapshot: self.snapshot(),
                    },
                );
                let _ = self.app.emit("pairing-succeeded", paired_device_id.clone());
                self.broadcast();
                let _ = self.begin_desktop_enrollment(paired_device_id);
                return;
            }
            ClientMessage::NodeEnroll { request_id, nonce } => {
                if nonce.len() < 32
                    || nonce.len() > 128
                    || !nonce.bytes().all(|value| {
                        value.is_ascii_alphanumeric() || value == b'-' || value == b'_'
                    })
                {
                    self.send_to_client(
                        client_id,
                        ServerMessage::Error {
                            request_id: Some(request_id),
                            code: "BAD_ENROLLMENT_NONCE".into(),
                            message: "The enrollment request nonce is invalid.".into(),
                        },
                    );
                    return;
                }
                let device_id = {
                    let mut clients = self.clients.lock().expect("remote clients poisoned");
                    clients.get_mut(client_id).and_then(|client| {
                        if !client.paired_connection || client.enrollment_requests >= 3 {
                            return None;
                        }
                        client.enrollment_requests += 1;
                        client.device_id.clone()
                    })
                };
                let Some(device_id) = device_id else {
                    self.send_to_client(
                        client_id,
                        ServerMessage::Error {
                            request_id: Some(request_id),
                            code: "ENROLLMENT_DENIED".into(),
                            message: "Complete trusted LAN pairing before requesting a mobile enrollment key.".into(),
                        },
                    );
                    return;
                };

                let core = Arc::clone(self);
                let client_id = client_id.to_string();
                let host_id = self.snapshot().host.id;
                tauri::async_runtime::spawn(async move {
                    match provisioning::issue_node_key("mobile", &host_id, &device_id, &nonce).await
                    {
                        Ok(key) => core.send_to_client(
                            &client_id,
                            ServerMessage::NodeEnrollment {
                                request_id,
                                auth_key: key.auth_key,
                                expires_at: key.expires_at,
                            },
                        ),
                        Err(error) => {
                            // The provisioning client never reads an error
                            // response body, so this diagnostic cannot contain
                            // a Headscale key or provisioning credential.
                            eprintln!("Agent Terminal mobile enrollment failed: {error:#}");
                            core.send_to_client(
                                &client_id,
                                ServerMessage::Error {
                                    request_id: Some(request_id),
                                    code: "ENROLLMENT_UNAVAILABLE".into(),
                                    message: "A one-time mobile enrollment key could not be issued. LAN access remains available; retry remote registration from this paired session.".into(),
                                },
                            );
                        }
                    }
                });
                return;
            }
            ClientMessage::Auth {
                request_id,
                device_id,
                device_token,
                name,
            } => {
                let accepted = self
                    .inner
                    .lock()
                    .expect("desktop state poisoned")
                    .store
                    .authenticate(&device_id, &device_token);
                if !accepted {
                    self.send_to_client(
                        client_id,
                        ServerMessage::Error {
                            request_id: Some(request_id),
                            code: "AUTH_DENIED".into(),
                            message: "This device is no longer authorized.".into(),
                        },
                    );
                    return;
                }
                {
                    let mut inner = self.inner.lock().expect("desktop state poisoned");
                    let _ = inner.store.touch_device(&device_id);
                    if let Some(name) = name {
                        if inner
                            .store
                            .update_device_name(&device_id, &name)
                            .unwrap_or(false)
                        {
                            eprintln!("device {device_id} display name updated to '{name}'");
                        }
                    }
                }
                if let Some(client) = self
                    .clients
                    .lock()
                    .expect("remote clients poisoned")
                    .get_mut(client_id)
                {
                    client.device_id = Some(device_id);
                }
                self.send_to_client(
                    client_id,
                    ServerMessage::AuthAccepted {
                        request_id,
                        snapshot: self.snapshot(),
                    },
                );
                self.broadcast();
                return;
            }
            _ => {}
        }

        let authenticated = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .get(client_id)
            .and_then(|client| client.device_id.as_ref())
            .is_some();
        if !authenticated {
            self.send_to_client(
                client_id,
                ServerMessage::Error {
                    request_id,
                    code: "AUTH_REQUIRED".into(),
                    message: "Pair or authenticate before sending commands.".into(),
                },
            );
            return;
        }
        {
            let mut clients = self.clients.lock().expect("remote clients poisoned");
            if let Some(client) = clients.get_mut(client_id) {
                match &message {
                    ClientMessage::SessionAttach { session_id, .. } => {
                        client.attached_sessions.insert(session_id.clone());
                    }
                    ClientMessage::SessionDetach { session_id, .. } => {
                        client.attached_sessions.remove(session_id);
                    }
                    _ => {}
                }
            }
        }
        match self.execute_client_message(client_id, message) {
            Ok(Some(response)) => self.send_to_client(client_id, response),
            Ok(None) => {}
            Err(error) => self.send_to_client(
                client_id,
                ServerMessage::Error {
                    request_id,
                    code: "COMMAND_FAILED".into(),
                    message: error.to_string(),
                },
            ),
        }
    }

    fn execute_client_message(
        self: &Arc<Self>,
        client_id: &str,
        message: ClientMessage,
    ) -> Result<Option<ServerMessage>> {
        Ok(match message {
            ClientMessage::SnapshotRequest { request_id } => Some(ServerMessage::Snapshot {
                request_id: Some(request_id),
                snapshot: self.snapshot(),
            }),
            ClientMessage::ProjectCreate {
                request_id,
                name,
                path,
            } => {
                self.create_persistent_project(&name, &path)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::ProjectRename {
                request_id,
                project_id,
                name,
            } => {
                self.rename_project(&project_id, &name)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::ProjectRemove {
                request_id,
                project_id,
            } => {
                self.set_project_persistence(&project_id, false)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::ProjectPersistence {
                request_id,
                project_id,
                persistent,
            } => {
                self.set_project_persistence(&project_id, persistent)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::ProjectReorder {
                request_id,
                project_ids,
            } => {
                self.reorder_projects(&project_ids)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::DirectoryList { request_id, path } => {
                Some(ServerMessage::DirectoryListing {
                    request_id,
                    listing: self.list_directories(path.as_deref())?,
                })
            }
            ClientMessage::SessionCreate {
                request_id,
                project_id,
                shell_id,
            } => {
                self.create_session(&project_id, shell_id.as_deref())?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::SessionClose {
                request_id,
                session_id,
            } => {
                self.close_session(&session_id);
                Some(ServerMessage::Ok { request_id })
            }
            ClientMessage::SessionAttach {
                request_id,
                session_id,
                cols,
                rows,
            } => {
                self.resize_remote_session(client_id, &session_id, cols, rows);
                Some(ServerMessage::SessionBuffer {
                    request_id,
                    session_id: session_id.clone(),
                    data: self.session_buffer(&session_id),
                })
            }
            ClientMessage::SessionDetach {
                request_id,
                session_id,
            } => {
                self.release_remote_controller(client_id, &session_id);
                Some(ServerMessage::Ok { request_id })
            }
            ClientMessage::SessionInput { session_id, data } => {
                self.write_remote_session(client_id, &session_id, &data);
                None
            }
            ClientMessage::SessionResize {
                session_id,
                cols,
                rows,
                force,
            } => {
                let _ = force;
                self.resize_remote_session(client_id, &session_id, cols, rows);
                None
            }
            ClientMessage::Pair { .. }
            | ClientMessage::Auth { .. }
            | ClientMessage::NodeEnroll { .. } => None,
        })
    }

    fn consume_pairing_grant(
        &self,
        token: &str,
        device: &crate::models::DeviceIdentity,
    ) -> Option<String> {
        let device_token = random_token(32);
        let now = Utc::now();
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        if !take_valid_pairing_grant(&mut inner.pairing_grants, token, now.timestamp_millis()) {
            return None;
        }
        let authorized = AuthorizedDevice {
            id: device.id.clone(),
            name: device.name.clone(),
            platform: device.platform.clone(),
            added_at: now.to_rfc3339(),
            last_seen_at: now.to_rfc3339(),
            online: false,
        };
        inner
            .store
            .authorize_device(authorized, &device_token)
            .ok()?;
        Some(device_token)
    }

    fn send_to_client(&self, client_id: &str, message: ServerMessage) {
        let sink = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .get(client_id)
            .map(|client| client.sink.clone());
        let Ok(payload) = serde_json::to_string(&message) else {
            return;
        };
        match sink {
            Some(ClientSink::Direct { messages, .. }) => {
                let _ = messages.send(payload);
            }
            None => {}
        }
    }

    fn send_terminal_output(&self, session_id: &str, data: &str) {
        let targets = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .iter()
            .filter(|(_, client)| {
                client.device_id.is_some() && client.attached_sessions.contains(session_id)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for client_id in targets {
            self.send_to_client(
                &client_id,
                ServerMessage::SessionOutput {
                    session_id: session_id.to_string(),
                    data: data.to_string(),
                },
            );
        }
    }

    fn disconnect_device(&self, device_id: &str) {
        let removed = {
            let mut clients = self.clients.lock().expect("remote clients poisoned");
            let ids = clients
                .iter()
                .filter(|(_, client)| client.device_id.as_deref() == Some(device_id))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| clients.remove(&id))
                .collect::<Vec<_>>()
        };
        for client in removed {
            let ClientSink::Direct { close, .. } = client.sink;
            let _ = close.send(());
        }
    }

    fn on_terminal_data(self: &Arc<Self>, session_id: &str, data: String) {
        let (reported_cwd, title_changed, window_clients) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            session.buffer.push_str(&data);
            truncate_front(&mut session.buffer, MAX_SCROLLBACK_BYTES);
            session.control_tail.push_str(&data);
            truncate_front(&mut session.control_tail, MAX_CONTROL_BYTES);
            session.pending_cursor_reports =
                session
                    .pending_cursor_reports
                    .saturating_add(record_cursor_position_requests(
                        &mut session.cursor_query_tail,
                        &data,
                    ));
            let reported = parse_working_directories(&session.control_tail)
                .into_iter()
                .last()
                .filter(|cwd| {
                    normalize_text_path(cwd) != normalize_text_path(&session.metadata.cwd)
                });
            let reported_title = parse_terminal_titles(&session.control_tail)
                .into_iter()
                .last();
            let title_changed = reported_title.is_some_and(|title| {
                if title == session.metadata.title {
                    return false;
                }
                session.metadata.title = title;
                true
            });
            (
                reported,
                title_changed,
                inner.windows.subscribers(session_id),
            )
        };
        let event = TerminalDataEvent {
            session_id: session_id.to_string(),
            data: data.clone(),
        };
        for label in window_clients {
            let _ = self.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-data",
                event.clone(),
            );
        }
        self.send_terminal_output(session_id, &data);
        if let Some(cwd) = reported_cwd {
            self.handle_session_working_directory(session_id, &cwd);
        } else if title_changed {
            self.broadcast();
        }
    }

    fn on_terminal_exit(&self, session_id: &str, exit_code: u32) {
        let changed = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            if let Some(session) = inner.sessions.get_mut(session_id) {
                session.metadata.status = "exited".into();
                session.metadata.exit_code = Some(exit_code);
                true
            } else {
                false
            }
        };
        if changed {
            self.broadcast();
        }
    }

    fn handle_session_working_directory(self: &Arc<Self>, session_id: &str, reported: &str) {
        let cleaned = reported
            .trim()
            .trim_matches('"')
            .trim_start_matches(|character| {
                character == '/' && reported.get(1..3).is_some_and(|value| value.ends_with(':'))
            })
            .replace('/', "\\");
        let Ok(cwd) = canonical_directory(&cleaned) else {
            return;
        };
        let (
            project,
            previous_project_id,
            active_window,
            displaced_window,
            old_has_sessions,
            open_projects_in_new_windows,
        ) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(current) = inner
                .sessions
                .get(session_id)
                .map(|session| session.metadata.clone())
            else {
                return;
            };
            let mut saved = inner
                .store
                .projects()
                .iter()
                .filter(|project| is_within_project(&cwd, Path::new(&project.path)))
                .cloned()
                .collect::<Vec<_>>();
            saved.sort_by_key(|project| {
                std::cmp::Reverse(Path::new(&project.path).components().count())
            });
            let project = saved
                .into_iter()
                .next()
                .or_else(|| {
                    inner
                        .temporary_projects
                        .values()
                        .find(|project| {
                            normalized_path(Path::new(&project.path)) == normalized_path(&cwd)
                        })
                        .cloned()
                })
                .unwrap_or_else(|| {
                    let project = Project {
                        id: format!("temporary-{}", Uuid::new_v4()),
                        name: folder_name(&cwd),
                        path: cwd.to_string_lossy().into_owned(),
                        persistent: false,
                        created_at: None,
                    };
                    inner
                        .temporary_projects
                        .insert(project.id.clone(), project.clone());
                    inner.project_order.push(project.id.clone());
                    project
                });
            if let Some(session) = inner.sessions.get_mut(session_id) {
                session.metadata.cwd = cwd.to_string_lossy().into_owned();
                session.metadata.project_id = project.id.clone();
            }
            let project_changed = project.id != current.project_id;
            let active_window = project_changed
                .then(|| {
                    inner
                        .windows
                        .window_for_project(&current.project_id)
                        .map(str::to_owned)
                })
                .flatten();
            let displaced_window = active_window.as_ref().and_then(|label| {
                inner.windows.retain_attachment(label, session_id);
                inner.windows.assign(label, &project.id).displaced_window
            });
            let old_has_sessions = project_changed
                && inner
                    .sessions
                    .values()
                    .any(|session| session.metadata.project_id == current.project_id);
            let open_projects_in_new_windows = inner.store.settings().open_projects_in_new_windows;
            (
                project,
                current.project_id,
                active_window,
                displaced_window,
                old_has_sessions,
                open_projects_in_new_windows,
            )
        };
        if project.id != previous_project_id {
            if let Some(label) = displaced_window
                && let Some(window) = self.app.get_webview_window(&label)
            {
                let _ = window.destroy();
            }

            if let Some(label) = active_window {
                if let Some(window) = self.app.get_webview_window(&label) {
                    let _ = window.set_title(&format!("{} — Agent Terminal", project.name));
                    if old_has_sessions && open_projects_in_new_windows {
                        let _ = self.ensure_project_window_in_background(&previous_project_id);
                    } else {
                        self.cleanup_empty_temporary_project(&previous_project_id);
                    }
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    self.mark_window_focused(&label);
                }
            } else {
                let _ = self.ensure_project_window(&project.id);
                if old_has_sessions {
                    let _ = self.ensure_project_window_in_background(&previous_project_id);
                } else {
                    self.cleanup_empty_temporary_project(&previous_project_id);
                }
            }
        }
        self.broadcast();
    }

    fn cleanup_empty_temporary_project(&self, project_id: &str) {
        let label = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            if !inner.temporary_projects.contains_key(project_id)
                || inner
                    .sessions
                    .values()
                    .any(|session| session.metadata.project_id == project_id)
            {
                return;
            }
            inner.temporary_projects.remove(project_id);
            inner.project_order.retain(|id| id != project_id);
            let label = inner
                .windows
                .window_for_project(project_id)
                .map(str::to_owned);
            if let Some(label) = &label {
                inner.windows.remove_window(label);
            }
            label
        };
        if let Some(label) = label
            && let Some(window) = self.app.get_webview_window(&label)
        {
            let _ = window.destroy();
        }
    }

    fn project_by_id(&self, project_id: &str) -> Result<Project> {
        project_by_id(
            &self.inner.lock().expect("desktop state poisoned"),
            project_id,
        )
        .ok_or_else(|| anyhow!("Project not found."))
    }
}

fn snapshot_from_inner(inner: &Inner, online_device_ids: &HashSet<String>) -> HostSnapshot {
    let default_shell_id = if inner
        .shells
        .iter()
        .any(|shell| shell.id == inner.store.settings().default_shell_id)
    {
        inner.store.settings().default_shell_id.clone()
    } else {
        inner
            .shells
            .first()
            .map(|shell| shell.id.clone())
            .unwrap_or_else(|| "cmd".into())
    };
    let mut ordered_ids = HashSet::new();
    let mut sessions = inner
        .session_order
        .iter()
        .filter_map(|id| {
            inner.sessions.get(id).map(|session| {
                ordered_ids.insert(id.clone());
                session.metadata.clone()
            })
        })
        .collect::<Vec<_>>();
    let mut missing_sessions = inner
        .sessions
        .values()
        .filter(|session| !ordered_ids.contains(&session.metadata.id))
        .map(|session| session.metadata.clone())
        .collect::<Vec<_>>();
    missing_sessions.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    sessions.extend(missing_sessions);

    HostSnapshot {
        host: HostInfo {
            id: inner.store.host().id.clone(),
            name: inner.store.host().name.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        projects: public_projects(inner),
        sessions,
        devices: inner
            .store
            .devices()
            .iter()
            .map(|device| {
                let mut entry = device.device.clone();
                entry.online = online_device_ids.contains(&entry.id);
                entry
            })
            .collect(),
        shells: inner.shells.clone(),
        default_shell_id,
    }
}

fn public_projects(inner: &Inner) -> Vec<Project> {
    let active: HashSet<&str> = inner
        .sessions
        .values()
        .map(|session| session.metadata.project_id.as_str())
        .collect();
    let mut projects = inner.store.projects().to_vec();
    let saved_paths = inner
        .store
        .projects()
        .iter()
        .map(|project| normalized_path(Path::new(&project.path)))
        .collect::<HashSet<_>>();
    projects.extend(
        inner
            .temporary_projects
            .values()
            .filter(|project| {
                !saved_paths.contains(&normalized_path(Path::new(&project.path)))
                    && (active.contains(project.id.as_str())
                        || inner.windows.has_project(&project.id))
            })
            .cloned(),
    );
    let positions = inner
        .project_order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<HashMap<_, _>>();
    projects.sort_by(|left, right| {
        (
            positions
                .get(left.id.as_str())
                .copied()
                .unwrap_or(usize::MAX),
            &left.id,
        )
            .cmp(&(
                positions
                    .get(right.id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX),
                &right.id,
            ))
    });
    projects
}

fn project_by_id(inner: &Inner, project_id: &str) -> Option<Project> {
    inner
        .store
        .projects()
        .iter()
        .find(|project| project.id == project_id)
        .cloned()
        .or_else(|| inner.temporary_projects.get(project_id).cloned())
}

fn canonical_directory(value: impl AsRef<Path>) -> Result<PathBuf> {
    let path = value.as_ref();
    let resolved = path
        .canonicalize()
        .with_context(|| format!("The desktop folder does not exist: {}", path.display()))?;
    if !resolved.is_dir() {
        return Err(anyhow!("The desktop path is not a folder."));
    }
    Ok(user_visible_path(resolved))
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn normalize_text_path(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_start_matches('\\')
        .replace('/', "\\")
        .to_lowercase()
}

fn is_within_project(candidate: &Path, project: &Path) -> bool {
    let candidate = normalized_path(candidate);
    let project = normalized_path(project);
    candidate == project
        || candidate
            .strip_prefix(&project)
            .is_some_and(|rest| rest.starts_with('\\'))
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Home")
        .to_string()
}

fn truncate_front(value: &mut String, maximum: usize) {
    if value.len() <= maximum {
        return;
    }
    let mut start = value.len() - maximum;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value.drain(..start);
}

fn parse_working_directories(value: &str) -> Vec<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let regex = PATTERN.get_or_init(|| {
        Regex::new(r"\x1b\]([^\x07]*?)(?:\x07|\x1b\\)").expect("valid OSC pattern")
    });
    regex
        .captures_iter(value)
        .filter_map(|capture| {
            let payload = capture.get(1)?.as_str();
            if let Some(directory) = payload.strip_prefix("9;9;") {
                let directory = directory.trim().trim_matches('"');
                return (!directory.is_empty()).then(|| directory.to_string());
            }
            let location = Url::parse(payload.strip_prefix("7;")?).ok()?;
            if location.scheme() != "file" {
                return None;
            }
            let mut path = percent_decode_str(location.path())
                .decode_utf8_lossy()
                .into_owned();
            if path.starts_with('/') && path.get(2..3) == Some(":") {
                path.remove(0);
            }
            Some(
                if let Some(host) = location.host_str().filter(|host| !host.is_empty()) {
                    format!("//{host}{path}")
                } else {
                    path
                },
            )
        })
        .collect()
}

fn parse_terminal_titles(value: &str) -> Vec<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let regex = PATTERN.get_or_init(|| {
        Regex::new(r"\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)")
            .expect("valid terminal title pattern")
    });
    regex
        .captures_iter(value)
        .filter_map(|capture| {
            let title = capture
                .get(1)?
                .as_str()
                .chars()
                .filter(|character| !character.is_control())
                .take(256)
                .collect::<String>();
            (!title.is_empty()).then_some(title)
        })
        .collect()
}

fn validate_project_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("Project name cannot be empty."));
    }
    if name.chars().count() > MAX_PROJECT_NAME_CHARACTERS || name.chars().any(char::is_control) {
        return Err(anyhow!(
            "Project name must be {MAX_PROJECT_NAME_CHARACTERS} characters or fewer."
        ));
    }
    Ok(name)
}

fn project_name_or_folder(name: &str, path: &Path) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(folder_name(path));
    }
    Ok(validate_project_name(name)?.to_string())
}

fn local_address() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr().map(|address| address.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn embedded_node_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AGENT_TERMINAL_EMBEDDED_NODE_BIN") {
        return Some(PathBuf::from(path));
    }
    if let Some(directory) = std::env::var_os("AGENT_TERMINAL_EMBEDDED_NODE_DIR") {
        return Some(PathBuf::from(directory).join(if cfg!(windows) {
            "embedded-node.exe"
        } else {
            "embedded-node"
        }));
    }
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
    {
        let bundled = path.join("embedded-node").join(if cfg!(windows) {
            "embedded-node.exe"
        } else {
            "embedded-node"
        });
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    app.path().resource_dir().ok().map(|directory| {
        directory.join("embedded-node").join(if cfg!(windows) {
            "embedded-node.exe"
        } else {
            "embedded-node"
        })
    })
}

fn take_valid_pairing_grant(
    grants: &mut HashMap<String, PairingGrant>,
    token: &str,
    now_ms: i64,
) -> bool {
    grants
        .remove(token)
        .is_some_and(|grant| grant.expires_at_ms >= now_ms)
}

fn is_dropped_node_status(status: &EmbeddedNodeStatus) -> bool {
    matches!(status.error_code.as_str(), "preauth_missing" | "preauth_rejected")
}

/// The badge status for a given connectivity reading: while the machine has
/// no internet the stored registration verdict is hidden and the badge shows
/// "No internet" instead of a stale enrolled/pending/failed state.
fn registration_status_for_display(online: bool, stored: &str) -> String {
    if online {
        stored.to_owned()
    } else {
        "offline".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectivityAction, ConnectivityTracker, EmbeddedNodeStatus, Inner, PairingGrant,
        is_cursor_position_report, is_dropped_node_status, is_within_project,
        parse_terminal_titles, parse_working_directories, presence_alive, project_name_or_folder,
        record_cursor_position_requests, registration_status_for_display, snapshot_from_inner,
        take_valid_pairing_grant, validate_project_name, PRESENCE_WINDOW_MS,
    };
    use crate::{
        models::AuthorizedDevice,
        store::DesktopStore,
        window_clients::WindowClients,
    };
    use std::{
        collections::{HashMap, HashSet},
        fs,
        path::{Path, PathBuf},
    };
    use uuid::Uuid;

    #[test]
    fn presence_alive_covers_the_heartbeat_window_boundaries() {
        let now = 1_000_000_i64;
        assert!(presence_alive(now, now));
        assert!(presence_alive(now - PRESENCE_WINDOW_MS, now));
        assert!(!presence_alive(now - PRESENCE_WINDOW_MS - 1, now));
        // A clock that predates the last-seen stamp must not overflow.
        assert!(presence_alive(now, now - PRESENCE_WINDOW_MS - 1));
    }

    #[test]
    fn snapshot_marks_only_devices_currently_reachable_as_online() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        let device = |id: &str, name: &str| AuthorizedDevice {
            id: id.into(),
            name: name.into(),
            platform: "android".into(),
            added_at: "2026-08-27T00:00:00Z".into(),
            last_seen_at: "2026-08-27T00:00:00Z".into(),
            online: false,
        };
        store
            .authorize_device(device("phone-a", "Pixel 7"), "cred-a")
            .expect("authorize first device");
        store
            .authorize_device(device("phone-b", "Galaxy S23"), "cred-b")
            .expect("authorize second device");

        let inner = Inner {
            store,
            shells: Vec::new(),
            temporary_projects: HashMap::new(),
            project_order: Vec::new(),
            sessions: HashMap::new(),
            session_order: Vec::new(),
            windows: WindowClients::default(),
            pairing_grants: HashMap::new(),
        };

        let online = HashSet::from(["phone-a".to_string()]);
        let snapshot = snapshot_from_inner(&inner, &online);
        assert_eq!(snapshot.devices.len(), 2);
        assert_eq!(snapshot.devices[0].online, true);
        assert_eq!(snapshot.devices[1].online, false);

        let nobody = HashSet::new();
        let snapshot = snapshot_from_inner(&inner, &nobody);
        assert!(
            snapshot.devices.iter().all(|device| !device.online),
            "devices outside the presence window are offline"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn parses_windows_terminal_working_directory_reports() {
        let output = "before\x1b]9;9;C:\\Users\\edzch\\Project\x1b\\after\x1b]7;file:///C:/Users/edzch/Other%20Project\x07";
        assert_eq!(
            parse_working_directories(output),
            vec!["C:\\Users\\edzch\\Project", "C:/Users/edzch/Other Project"]
        );
    }

    #[test]
    fn recognizes_only_complete_cursor_position_reports() {
        assert!(is_cursor_position_report("\x1b[12;34R"));
        assert!(is_cursor_position_report("\x1b[?12;34R"));
        assert!(is_cursor_position_report("\x1b[1;1R"));
        assert!(!is_cursor_position_report("\x1b[12;34C"));
        assert!(!is_cursor_position_report("\x1b[12;34Rtail"));
    }

    #[test]
    fn records_live_cursor_position_queries_even_when_split_across_output_chunks() {
        let mut tail = String::new();
        assert_eq!(record_cursor_position_requests(&mut tail, "\x1b["), 0);
        assert_eq!(record_cursor_position_requests(&mut tail, "6n"), 1);
        assert_eq!(record_cursor_position_requests(&mut tail, "\x1b[?6"), 0);
        assert_eq!(record_cursor_position_requests(&mut tail, "n"), 1);
        assert_eq!(
            record_cursor_position_requests(&mut tail, "\x1b[6n\x1b[?6n"),
            2
        );
    }

    #[test]
    fn parses_shell_provided_terminal_titles() {
        let output = "before\x1b]0;PowerShell — build\x07middle\x1b]2;npm test\x1b\\after";
        assert_eq!(
            parse_terminal_titles(output),
            vec!["PowerShell — build", "npm test"]
        );
    }

    #[test]
    fn project_matching_is_case_insensitive_and_path_bounded() {
        assert!(is_within_project(
            Path::new("C:\\Work\\Project\\src"),
            Path::new("c:\\work\\project")
        ));
        assert!(!is_within_project(
            Path::new("C:\\Work\\Project-copy"),
            Path::new("C:\\Work\\Project")
        ));
    }

    #[test]
    fn pairing_grants_are_valid_until_expiry_and_consumed_once() {
        let mut grants = HashMap::from([(
            "fresh".to_string(),
            PairingGrant {
                expires_at_ms: 1_000,
            },
        )]);
        assert!(take_valid_pairing_grant(&mut grants, "fresh", 1_000));
        assert!(!take_valid_pairing_grant(&mut grants, "fresh", 1_000));

        grants.insert("expired".to_string(), PairingGrant { expires_at_ms: 999 });
        assert!(!take_valid_pairing_grant(&mut grants, "expired", 1_000));
        assert!(!grants.contains_key("expired"));
    }

    #[test]
    fn connectivity_tracker_only_triggers_side_effects_on_transitions() {
        let mut tracker = ConnectivityTracker::default();
        // The first reading only establishes a baseline.
        assert_eq!(tracker.record(true), ConnectivityAction::None);
        assert_eq!(tracker.record(true), ConnectivityAction::None);
        // Losing connectivity shows the no-internet badge once.
        assert_eq!(tracker.record(false), ConnectivityAction::ShowOffline);
        assert_eq!(tracker.record(false), ConnectivityAction::None);
        assert_eq!(tracker.record(false), ConnectivityAction::None);
        // Regaining connectivity resets and re-verifies the registration.
        assert_eq!(tracker.record(true), ConnectivityAction::Verify);
        assert_eq!(tracker.record(true), ConnectivityAction::None);
        // A transient probe value must not restart the embedded node.
        assert_eq!(tracker.record(false), ConnectivityAction::ShowOffline);
        assert_eq!(tracker.record(false), ConnectivityAction::None);
        assert_eq!(tracker.record(true), ConnectivityAction::Verify);
    }

    #[test]
    fn a_machine_booted_offline_shows_no_internet_without_a_verify_cycle() {
        let mut tracker = ConnectivityTracker::default();
        assert_eq!(tracker.record(false), ConnectivityAction::ShowOffline);
        // Only the reconnect may trigger verification.
        assert_eq!(tracker.record(true), ConnectivityAction::Verify);
    }

    #[test]
    fn offline_always_overrides_the_stored_registration_status() {
        for stored in ["unregistered", "pending", "enrolled", "failed"] {
            assert_eq!(
                registration_status_for_display(false, stored),
                "offline",
                "offline must hide a stored {stored} status"
            );
            assert_eq!(registration_status_for_display(true, stored), stored);
        }
    }

    #[test]
    fn auth_rejections_after_resume_are_treated_as_a_dropped_registration() {
        let missing = EmbeddedNodeStatus {
            node_id: "desktop-host".into(),
            tailnet_address: String::new(),
            error_code: "preauth_missing".into(),
        };
        let rejected = EmbeddedNodeStatus {
            node_id: "desktop-host".into(),
            tailnet_address: String::new(),
            error_code: "preauth_rejected".into(),
        };
        let unavailable = EmbeddedNodeStatus {
            node_id: "desktop-host".into(),
            tailnet_address: String::new(),
            error_code: "control_server_unavailable".into(),
        };

        assert!(is_dropped_node_status(&missing));
        assert!(is_dropped_node_status(&rejected));
        assert!(!is_dropped_node_status(&unavailable));
    }

    #[test]
    fn project_names_have_a_bounded_character_count() {
        assert_eq!(
            validate_project_name("  Project name  ").unwrap(),
            "Project name"
        );
        assert!(validate_project_name(&"x".repeat(100)).is_ok());
        assert!(validate_project_name(&"x".repeat(101)).is_err());
        assert!(validate_project_name("\n").is_err());
    }

    #[test]
    fn blank_project_names_use_the_original_folder_name() {
        assert_eq!(
            project_name_or_folder("  ", Path::new("C:\\Users\\Ada\\AgentTerminal")).unwrap(),
            "AgentTerminal"
        );
        assert_eq!(
            project_name_or_folder(
                "  Custom name  ",
                Path::new("C:\\Users\\Ada\\AgentTerminal")
            )
            .unwrap(),
            "Custom name"
        );
    }
}
