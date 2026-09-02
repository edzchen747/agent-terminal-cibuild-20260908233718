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
    time::Instant,
};

use std::fmt;

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
        SessionSegment, SessionSnapshot, ShellProfile, TerminalDataEvent, TerminalGridEvent,
        TerminalSession, TerminalTuiModeEvent, TuiMode,
    },
    network,
    path_utils::user_visible_path,
    provisioning,
    shells::{command_for, detect_shells},
    store::{DesktopStore, NetworkState, random_token},
    tui::TuiClassifier,
    window_clients::WindowClients,
};

/// The PTY is spawned at this grid, then follows focus: whichever client
/// actively uses the session (desktop window focused, or the phone) resizes
/// the PTY to its own dimensions. Every change is journaled as a grid epoch
/// (see `GridEpoch`), so a later replay reflows history exactly as live
/// clients did.
const SESSION_DEFAULT_COLS: u16 = 120;
const SESSION_DEFAULT_ROWS: u16 = 30;
/// Append-only raw PTY journal per session (the `session.buffer` replay
/// source). Large enough for a full day of use; clients replay it over
/// WebSocket on every attach, so the cap is the only history boundary.
const MAX_TERMINAL_JOURNAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONTROL_BYTES: usize = 8_192;

/// A grid change in a session's PTY stream: `cols` x `rows` took effect at
/// absolute stream offset `offset` (always a chunk-aligned boundary, because
/// resize and append are serialized under the session lock).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GridEpoch {
    offset: u64,
    cols: u16,
    rows: u16,
}
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

// ---------------------------------------------------------------------------
// Terminal sync diagnostics (for debugging history parity between devices).
// Enable by setting AGENT_TERMINAL_SYNC_DEBUG=1 before starting the host. The
// log is written to %TEMP%/agent-terminal-sync.log and truncated at startup,
// with one timestamped line per journal append, resize/broadcast, attach,
// snapshot, and input point of interest.
// ---------------------------------------------------------------------------

static SYNC_DEBUG_ENABLED: OnceLock<bool> = OnceLock::new();

fn sync_debug_enabled() -> bool {
    *SYNC_DEBUG_ENABLED.get_or_init(|| {
        std::env::var("AGENT_TERMINAL_SYNC_DEBUG")
            .is_ok_and(|value| !matches!(value.as_str(), "" | "0" | "false" | "no" | "off"))
    })
}

fn sync_log_path() -> PathBuf {
    std::env::temp_dir().join("agent-terminal-sync.log")
}

/// Raw byte dump of one session's PTY stream (gated by AGENT_TERMINAL_SYNC_DEBUG),
/// written per append so a failing TUI resize can be replayed byte-for-byte.
fn journal_dump_path(session_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("agent-terminal-journal-{session_id}.log"))
}

fn sync_log_line(scope: &str, message: fmt::Arguments<'_>) {
    let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    let line = format!("{timestamp} [{scope}] {message}\n");
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sync_log_path())
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

macro_rules! sync_log {
    ($scope:expr, $($arg:tt)*) => {
        if sync_debug_enabled() {
            sync_log_line($scope, format_args!($($arg)*));
        }
    };
}

/// Webview-side terminal sync diagnostics (TerminalPane decisions), mirrored
/// into the host log so a debug run captures both clients' merges in one file.
/// Gated by AGENT_TERMINAL_SYNC_DEBUG like the rest of the sync log; with the
/// env var unset the invoke returns immediately without touching the disk.
pub fn sync_debug_from_webview(message: &str) {
    if sync_debug_enabled() {
        sync_log_line("webview", format_args!("{message}"));
    }
}

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
    /// Current PTY grid (cols, rows): the focused client's dimensions.
    grid: (u16, u16),
    /// Grid history in stream order. Always starts with the spawn grid at
    /// offset 0; the last entry is the current grid.
    grid_epochs: Vec<GridEpoch>,
    /// Raw append-only PTY output journal (the `session.buffer` replay
    /// source). Every chunk is numbered by its absolute byte offset in the
    /// session stream via `journal_len`; the front is trimmed only when the
    /// cap is exceeded and never in the middle of an escape sequence.
    buffer: String,
    /// Total bytes ever appended to `buffer` (a monotonic stream position
    /// that survives front trimming, so offsets stay absolute for life).
    journal_len: u64,
    /// Per-session TUI mode classifier: watches the raw stream for evidence
    /// of who owns the grid (canonical / inline / fullscreen). See
    /// `crate::tui`. Confined to this session's reader thread.
    tui: TuiClassifier,
    /// True while the host's SYNTHETIC alt-screen enter (\x1b[?1049h) is
    /// still open: fullscreen TUIs that draw into the primary buffer are
    /// journaled inside a host-injected alt pair so their frames stay
    /// isolated from client scrollback. Cleared once the matching alt exit
    /// (synthetic or program-sent) has been journaled.
    synthetic_alt: bool,
    /// The viewport dimensions the focused client most recently announced
    /// (recorded even while the PTY is frozen). Applied to the PTY on the
    /// next alternate-screen entry so a freshly launched TUI opens at the
    /// focused client's size.
    requested_viewport: Option<(u16, u16)>,
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
    /// A saved remote identity re-verification run is in flight. The stored
    /// verdict is stale for its duration, so the badge stays on "pending"
    /// (Registering) until the task reports its terminal state.
    remote_verification_running: AtomicBool,
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
        if sync_debug_enabled() {
            let _ = fs::File::create(sync_log_path());
            sync_log_line("boot", format_args!("sync debug log started for the host session"));
        }
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
            remote_verification_running: AtomicBool::new(false),
            remote_port: AtomicU16::new(remote_port),
            direct_server_ready: AtomicBool::new(false),
            exit_requested: AtomicBool::new(false),
            presence_cache: Mutex::new(None),
            network_online: AtomicBool::new(true),
        });
        core.spawn_presence_refresh();
        core
    }

    /// Boots on the first saved project in the user's order, falling back to
    /// the home directory project when nothing is saved. No session is
    /// created, so the window opens with zero terminal tabs.
    pub fn initialize(self: &Arc<Self>) -> Result<()> {
        let project = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.ensure_network_identity()?;
            startup_project(&mut inner)?
        };
        self.ensure_project_window_with_focus(&project.id, true, None)?;
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

    /// The badge's Retry action. Re-verifies the saved registration first
    /// (a transient failure needs no new key and never will); the verify
    /// itself escalates to a fresh enrollment only when the control plane
    /// proves the saved node was removed.
    pub fn retry_remote_registration(self: &Arc<Self>) -> Result<()> {
        if self.desktop_enrollment_running.load(Ordering::Acquire)
            || self.remote_verification_running.load(Ordering::Acquire)
        {
            // A run is already resolving the registration; a second one
            // would only race its result.
            return Ok(());
        }
        if self.prepare_remote_verification() {
            self.verify_remote_node(true, false);
            return Ok(());
        }
        Err(anyhow!("Remote access has not been set up yet."))
    }

    pub fn resume_remote_node(self: &Arc<Self>) {
        if self.prepare_remote_verification() {
            // The launch resume is rung while the machine may still be
            // bringing its routes up, so a transient failure gets one
            // automatic retry before the badge shows the failure.
            self.verify_remote_node(false, true);
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
            self.verify_remote_node(true, false);
        }
        Ok(())
    }

    /// Writes the pending state and reports whether a verification may begin.
    /// Nothing is ever verified for a host that has never paired, which keeps
    /// the badge on "Pair a device"; a host whose last device was revoked
    /// falls into the same bucket. Registration starts on the first pairing
    /// instead (the pair flow forces the enrollment run).
    fn prepare_remote_verification(&self) -> bool {
        let network = self.network_state();
        let has_known_registration = network.enrolled
            || network.node_id.is_some()
            || network.registration_status != "unregistered";
        if !has_known_registration {
            return false;
        }
        if self.paired_device_id().is_none() {
            // Without a device nothing can use the overlay route, so there is
            // nothing to verify; the badge shows "Pair a device" and the node
            // stays off until the first pairing re-registers it fresh.
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

    fn verify_remote_node(self: &Arc<Self>, force_restart: bool, retry_on_transient_failure: bool) {
        self.remote_verification_running.store(true, Ordering::Release);
        let core = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // The flag makes the badge show "Registering" while this run is
            // in flight (the renderer may first paint mid-run at launch); it
            // must be cleared right before the terminal broadcast so the last
            // state the window sees carries the real verdict. The guard is a
            // safety net for any other exit path.
            let _guard = RemoteVerificationGuard(Arc::clone(&core));
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
                    core.remote_verification_running.store(false, Ordering::Release);
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
                core.remote_verification_running.store(false, Ordering::Release);
                core.broadcast();
                return;
            }

            match core.wait_for_embedded_node().await {
                Ok(node) => {
                    let _ = core.set_remote_registration("enrolled", None, true, Some(&node));
                    core.remote_verification_running.store(false, Ordering::Release);
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
                    } else if retry_on_transient_failure {
                        // A freshly launched machine can race its Wi-Fi, DNS
                        // and DERP connectivity: the first resume of a
                        // known-good node is often failing only because the
                        // route was not up yet. Retry once automatically
                        // before declaring the failure, and keep the badge on
                        // Registering during the wait (the stored verdict is
                        // still pending).
                        eprintln!(
                            "Agent Terminal embedded network node did not resume: {error:#}; retrying once"
                        );
                        let retry_core = Arc::clone(&core);
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(4));
                            retry_core.verify_remote_node(true, false);
                        });
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
                    core.remote_verification_running.store(false, Ordering::Release);
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
        // With no authorized device there is nobody the overlay route could
        // serve, so the badge says "Pair a device" regardless of any stored
        // verdict from an older session.
        let remote_status = registration_status_for_display(
            !inner.store.devices().is_empty(),
            self.network_online.load(Ordering::Acquire),
            &network.registration_status,
            self.remote_verification_running.load(Ordering::Acquire)
                || self.desktop_enrollment_running.load(Ordering::Acquire),
        );
        DesktopState {
            snapshot: snapshot_from_inner(&inner, &online_device_ids),
            current_project_id,
            open_projects_in_new_windows: inner.store.settings().open_projects_in_new_windows,
            confirm_external_links: inner.store.settings().confirm_external_links,
            follow_working_directory: inner.store.settings().follow_working_directory,
            remote_registration: RemoteRegistration {
                status: remote_status,
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
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let fallback_project = preferred_project(&mut inner).map(|project| project.id);
            (inner.windows.last_or_any(), fallback_project)
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

    /// Ensures the project owns a window so its sessions have a place to
    /// render, without taking focus and without reassigning any window that
    /// currently hosts a different project. Used when a session is opened
    /// outside of the desktop's explicit open-project flow (the phone's
    /// `New terminal`, or the desktop's add-tab button): the tab must exist,
    /// but it must not pull the desktop app to the front or tear the user
    /// out of the project they are looking at.
    fn ensure_project_window_quietly(self: &Arc<Self>, project_id: &str) -> Result<()> {
        let (open_new_windows, existing) = {
            let inner = self.inner.lock().expect("desktop state poisoned");
            (
                inner.store.settings().open_projects_in_new_windows,
                inner
                    .windows
                    .window_for_project(project_id)
                    .map(str::to_owned),
            )
        };
        if !should_open_quiet_window(open_new_windows, existing.is_some()) {
            // The project already owns a window (or the desktop is in
            // single-window mode, where switching a window to the project is
            // how the desktop changes its selected project): leave every
            // window alone. Opening the project from the desktop focuses it.
            return Ok(());
        }
        let project = self.project_by_id(project_id)?;
        let label = format!("terminal-{}", Uuid::new_v4());
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.windows.assign(&label, &project.id);
        }
        let built =
            WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::App("index.html".into()))
                .title(format!("{} — Agent Terminal", project.name))
                .inner_size(1320.0, 820.0)
                .min_inner_size(680.0, 560.0)
                .visible(false)
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
        window.show()?;
        Ok(())
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
                .min_inner_size(680.0, 560.0)
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
        }
        self.ensure_project_window_with_focus(project_id, true, preferred_window)?;
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

    pub fn set_follow_working_directory(&self, enabled: bool) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.set_follow_working_directory(enabled)?;
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

        // The PTY starts at a default grid and follows focus afterwards:
        // whichever client is actively using the session (desktop focused or
        // the phone) resizes it to its own dimensions. History stays exact
        // across these grid switches because every change is journaled as an
        // epoch and every emulator reflows through the same resize sequence.
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: SESSION_DEFAULT_ROWS,
            cols: SESSION_DEFAULT_COLS,
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
            tui_mode: TuiMode::Canonical,
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
                    grid: (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
                    grid_epochs: vec![GridEpoch {
                        offset: 0,
                        cols: SESSION_DEFAULT_COLS,
                        rows: SESSION_DEFAULT_ROWS,
                    }],
            buffer: String::new(),
            journal_len: 0,
            tui: TuiClassifier::new(SESSION_DEFAULT_ROWS),
            synthetic_alt: false,
            requested_viewport: None,
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

        if let Err(error) = self.ensure_project_window_quietly(&project.id) {
            self.close_session(&id);
            return Err(error);
        }
        sync_log!(
            "session",
            "created id={id} project={} shell={} grid={SESSION_DEFAULT_COLS}x{SESSION_DEFAULT_ROWS}",
            project.id,
            shell.id
        );
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
            sync_log!("session", "close id={session_id}");
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
        let grid_changed = {
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
                    apply_grid_if_tui(session, cols, rows);
                }
            }
            sync_log!(
                "input",
                "session={session_id} controller={controller:?} bytes={} grid_hint={:?}",
                data.len(),
                size
            );

            if data.contains('\r') || data.contains('\n') {
                session.has_run_command = true;
            }
            let _ = session.writer.write_all(data.as_bytes());
            let _ = session.writer.flush();

            session
                .grid_epochs
                .last()
                .filter(|epoch| epoch.offset == session.journal_len)
                .copied()
        };
        if let Some(epoch) = grid_changed {
            sync_log!(
                "grid",
                "change session={session_id} new={}x{} at_offset={}",
                epoch.cols,
                epoch.rows,
                epoch.offset
            );
            self.broadcast_grid_change(session_id, epoch);
        }
    }

    /// The focused client owns the PTY grid. Snapshots and live output never
    /// re-wrap the stream: the grid change is recorded at its exact stream
    /// offset, every emulator reflows through the same epoch sequence, and
    /// history content stays identical on every device.
    fn resize_session_from(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        controller: TerminalController,
    ) {
        let epoch = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            if session.metadata.status != "running" {
                return;
            }
            session.terminal_controller = Some(controller.clone());
            apply_grid_if_tui(session, cols, rows)
        };
        sync_log!(
            "grid",
            "request session={session_id} controller={controller:?} wanted={cols}x{rows} applied={} (tui-held)",
            epoch.is_some()
        );
        if let Some(epoch) = epoch {
            self.broadcast_grid_change(session_id, epoch);
        }
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

    pub fn attach_window_session(
        &self,
        label: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<SessionSnapshot> {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let window_project_id = inner
            .windows
            .project_for_window(label)
            .map(str::to_owned)
            .ok_or_else(|| {
                anyhow!("Terminal window is no longer registered with the tray host.")
            })?;
        let (session_project_id, snapshot, epoch) = match inner.sessions.get_mut(session_id) {
            // Record the attaching window's viewport. The session grid only
            // moves while a TUI owns the alternate screen (focus-driven);
            // otherwise the grid stays fixed and clients render viewports.
            Some(session) => {
                session.terminal_controller = Some(TerminalController::Desktop(label.to_string()));
                let epoch = apply_grid_if_tui(session, cols, rows);
                (
                    session.metadata.project_id.clone(),
                    snapshot_of(session),
                    epoch,
                )
            }
            None => return Err(anyhow!("Terminal session not found.")),
        };
        if session_project_id != window_project_id {
            return Err(anyhow!("Terminal session moved to another project window."));
        }
        if !inner.windows.attach(label, session_id) {
            return Err(anyhow!(
                "Terminal window is no longer registered with the tray host."
            ));
        }
        sync_log!(
            "attach",
            "desktop window={label} session={session_id} grid={cols}x{rows} segments={} end_offset={}",
            snapshot.segments.len(),
            snapshot.end_offset
        );
        drop(inner);
        if let Some(epoch) = epoch {
            self.broadcast_grid_change(session_id, epoch);
        }
        Ok(snapshot)
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

    fn session_snapshot(&self, session_id: &str) -> SessionSnapshot {
        let snapshot = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .sessions
            .get(session_id)
            .map(snapshot_of)
            .unwrap_or(SessionSnapshot {
                segments: Vec::new(),
                end_offset: 0,
            });
        sync_log!(
            "snapshot",
            "session={session_id} segments={} bytes={} end_offset={}",
            snapshot.segments.len(),
            snapshot
                .segments
                .iter()
                .map(|segment| segment.data.len())
                .sum::<usize>(),
            snapshot.end_offset
        );
        snapshot
    }

    /// Tell every attached device (and every desktop window) that the host
    /// reclassified the session's TUI mode at this stream offset. Inline and
    /// fullscreen clients own the PTY grid (strict cell grid, no reflow
    /// heuristics); canonical clients render the journal as their own
    /// viewport.
    fn broadcast_tui_mode(&self, session_id: &str, mode: TuiMode, offset: u64) {
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
        for client_id in &targets {
            self.send_to_client(
                client_id,
                ServerMessage::SessionMode {
                    session_id: session_id.to_string(),
                    mode,
                    offset,
                },
            );
        }
        let event = TerminalTuiModeEvent {
            session_id: session_id.to_string(),
            mode,
            offset,
        };
        let windows = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .subscribers(session_id);
        sync_log!(
            "mode",
            "broadcast session={session_id} mode={mode:?} at_offset={offset} clients={}",
            targets.len()
        );
        for label in windows {
            let _ = self.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-mode",
                event.clone(),
            );
        }
    }

    /// Tell every attached device (and every desktop window) that the PTY
    /// grid changed at this stream offset, so all emulators reflow in step.
    /// The resizing client receives the notice too; applying its own grid is
    /// a no-op reflow, and this keeps the event order deterministic.
    fn broadcast_grid_change(&self, session_id: &str, epoch: GridEpoch) {
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
        for client_id in &targets {
            self.send_to_client(
                client_id,
                ServerMessage::SessionGrid {
                    session_id: session_id.to_string(),
                    cols: epoch.cols,
                    rows: epoch.rows,
                    offset: epoch.offset,
                },
            );
        }
        let event = TerminalGridEvent {
            session_id: session_id.to_string(),
            cols: epoch.cols,
            rows: epoch.rows,
            offset: epoch.offset,
        };
        let windows = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .subscribers(session_id);
        let windows_count = windows.len();
        sync_log!(
            "grid",
            "broadcast session={session_id} new={}x{} at_offset={} clients={} windows={windows_count}",
            epoch.cols,
            epoch.rows,
            epoch.offset,
            targets.len()
        );
        for label in windows {
            let _ = self.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-grid",
                event.clone(),
            );
        }
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
        let no_devices_left = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.revoke_device(device_id)?;
            inner.store.devices().is_empty()
        };
        self.disconnect_device(device_id);
        if no_devices_left {
            // No device is left that could use the overlay route, so the node
            // has nobody to serve. The badge itself switches to "Pair a
            // device" (derived from the device list, not from the stored
            // verdict), the node stays off, and the next pairing re-registers
            // it fresh even though the saved verdict is stale.
            self.stop_embedded_node();
        }
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
                // The very first pairing is the moment remote access becomes
                // meaningful: it must always launch a fresh registration even
                // when a stale verdict was left behind by an older session
                // (the enrollment only skips a healthy, current node).
                let first_device = {
                    let inner = self.inner.lock().expect("desktop state poisoned");
                    inner.store.devices().is_empty()
                };
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
                let _ = self.start_desktop_enrollment(paired_device_id, first_device);
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
                    // An authenticated device was paired on an earlier
                    // session. The enrollment gate is about device
                    // authorization, not socket locality, so enrollments are
                    // allowed on this session too: without this a node that
                    // was revoked or expired can never re-register on a
                    // reconnect, and the mobile Retry button is denied
                    // instantly while its banner says pairing is required.
                    client.paired_connection = true;
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
            ClientMessage::ShellDefault { request_id, shell_id } => {
                self.set_default_shell(&shell_id)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::SessionAttach {
                request_id,
                session_id,
                cols,
                rows,
            } => {
                // Attaching focuses this client: the PTY takes its grid.
                self.resize_remote_session(client_id, &session_id, cols, rows);
                let snapshot = self.session_snapshot(&session_id);
                Some(ServerMessage::SessionBuffer {
                    request_id,
                    session_id: session_id.clone(),
                    segments: snapshot.segments,
                    end_offset: snapshot.end_offset,
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
            ClientMessage::DebugDiagnostics { message } => {
                // Phone-side terminal sync diagnostics ([ATSync] lines from
                // MobileTerminal), mirrored into the host log so a debug run
                // captures both sides of the sync in one file. Only logged
                // when AGENT_TERMINAL_SYNC_DEBUG is enabled.
                sync_log!("diagnostics", "client={client_id} {message}");
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

    fn send_terminal_output(&self, session_id: &str, data: &str, offset: u64) {
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
        let targets_count = targets.len();
        sync_log!(
            "output",
            "session={session_id} offset={offset} len={} targets={targets_count}",
            data.len()
        );
        for client_id in &targets {
            self.send_to_client(
                client_id,
                ServerMessage::SessionOutput {
                    session_id: session_id.to_string(),
                    data: data.to_string(),
                    offset,
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
        let (
            reported_cwd,
            title_changed,
            window_clients,
            offset,
            payload,
            mode_change,
            tui_entry_grid,
        ) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            // Append to the journal and number the chunk with its absolute
            // stream offset. The offset is monotonic for the lifetime of the
            // session: front trimming moves `offset` forward in `buffer`, but
            // `journal_len` keeps counting from stream position zero, so a
            // replay snapshot and a live chunk can be compared exactly.
            let offset = session.journal_len;
            // TUI mode classification: the per-session stream-signal
            // classifier decides when the foreground program takes (or
            // releases) grid ownership. The chunk is journaled together
            // with any host-injected synthetic alt-screen bytes so replay
            // and live clients see the exact same stream.
            let tui_transition = session.tui.feed(&data, Instant::now(), session.grid.1);
            // History isolation: a fullscreen TUI that never enters the
            // alternate screen of its own (a raw primary-buffer harness)
            // is wrapped in a host-injected alt pair so its frames stay
            // out of client scrollback. The enter is injected BEFORE the
            // first TUI bytes of this chunk; the exit before the first
            // post-TUI bytes of theirs.
            let mut injected = String::new();
            if let Some(transition) = tui_transition {
                if transition.to != TuiMode::Canonical && !transition.via_alt_enter {
                    injected.push_str("\x1b[?1049h");
                    session.synthetic_alt = true;
                } else if transition.to == TuiMode::Canonical
                    && session.synthetic_alt
                    && !transition.program_alt_exit
                {
                    injected.push_str("\x1b[?1049l");
                    session.synthetic_alt = false;
                }
            }
            let mut payload = String::with_capacity(injected.len() + data.len());
            payload.push_str(&injected);
            payload.push_str(&data);
            session.buffer.push_str(&payload);
            let before_trim = session.buffer.len();
            session.journal_len = offset.saturating_add(payload.len() as u64);
            truncate_journal_front(&mut session.buffer, MAX_TERMINAL_JOURNAL_BYTES);
            if session.buffer.len() != before_trim {
                sync_log!(
                    "journal",
                    "trim session={session_id} trimmed={} remaining={}",
                    before_trim - session.buffer.len(),
                    session.buffer.len()
                );
            }
            sync_log!(
                "journal",
                "append session={session_id} offset={offset} len={} journal_len={}",
                payload.len(),
                session.journal_len
            );
            if sync_debug_enabled() {
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(journal_dump_path(session_id))
                    .and_then(|mut file| file.write_all(payload.as_bytes()));
                // A full-screen clear is the universal TUI repaint op; probe
                // the bytes so an unrecognized alternate-screen protocol can
                // be identified (and matched) from a single run.
                if payload.contains("\x1b[2J") {
                    let preview: String = payload
                        .as_bytes()
                        .iter()
                        .take(200)
                        .map(|byte| format!("{byte:02x} "))
                        .collect();
                    sync_log_line("alt", format_args!("repaint chunk (hex) = {preview}"));
                }
            }
            session.control_tail.push_str(&data);
            truncate_front(&mut session.control_tail, MAX_CONTROL_BYTES);
            session.pending_cursor_reports =
                session
                    .pending_cursor_reports
                    .saturating_add(record_cursor_position_requests(
                        &mut session.cursor_query_tail,
                        &data,
                    ));
            // TUI mode transition (canonical / inline / fullscreen): a
            // program taking or releasing grid ownership changes how
            // clients may treat the data block (strict grid, no reflow
            // heuristics). The transition is recorded on the session with
            // its stream offset and broadcast immediately.
            let mode_change = if let Some(transition) = tui_transition {
                session.metadata.tui_mode = transition.to;
                sync_log!(
                    "mode",
                    "session={session_id} mode={:?} reason={} at_offset={offset}",
                    transition.to,
                    transition.reason
                );
                Some((transition.to, offset))
            } else {
                None
            };
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
            // On TUI entry (inline or fullscreen), open the program at the
            // focused client's recorded viewport so it starts at the right
            // dimensions (SIGWINCH triggers its native repaint).
            let tui_entry_grid = if tui_transition.is_some_and(|t| t.to != TuiMode::Canonical) {
                session
                    .requested_viewport
                    .and_then(|(cols, rows)| apply_session_grid(session, cols, rows))
            } else {
                None
            };
            (
                reported,
                title_changed,
                inner.windows.subscribers(session_id),
                offset,
                payload,
                mode_change,
                tui_entry_grid,
            )
        };
        let event = TerminalDataEvent {
            session_id: session_id.to_string(),
            data: payload.clone(),
            offset,
        };
        for label in window_clients {
            let _ = self.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-data",
                event.clone(),
            );
        }
        self.send_terminal_output(session_id, &payload, offset);
        if let Some((mode, transition_offset)) = mode_change {
            self.broadcast_tui_mode(session_id, mode, transition_offset);
        }
        if let Some(epoch) = tui_entry_grid {
            self.broadcast_grid_change(session_id, epoch);
        }
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
        let outcome = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            resolve_working_directory(&mut inner, session_id, &cwd)
        };
        let plan = match outcome {
            CdOutcome::Missing => return,
            // Follow-working-directory is off: the cwd was recorded and the
            // session stays in its project, so only refresh the UI. Recording
            // the cwd here also stops the change detector re-firing.
            CdOutcome::Recorded => {
                self.broadcast();
                return;
            }
            CdOutcome::Reassigned(plan) => plan,
        };
        if plan.project_changed {
            if let Some(label) = plan.displaced_window
                && let Some(window) = self.app.get_webview_window(&label)
            {
                let _ = window.destroy();
            }

            if let Some(label) = plan.active_window {
                if let Some(window) = self.app.get_webview_window(&label) {
                    let _ = window.set_title(&format!("{} — Agent Terminal", plan.project.name));
                    if plan.old_has_sessions && plan.open_projects_in_new_windows {
                        let _ = self.ensure_project_window_in_background(&plan.previous_project_id);
                    } else {
                        self.cleanup_empty_temporary_project(&plan.previous_project_id);
                    }
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    self.mark_window_focused(&label);
                }
            } else {
                let _ = self.ensure_project_window(&plan.project.id);
                if plan.old_has_sessions {
                    let _ = self.ensure_project_window_in_background(&plan.previous_project_id);
                } else {
                    self.cleanup_empty_temporary_project(&plan.previous_project_id);
                }
            }
        }
        self.broadcast();
    }

    fn cleanup_empty_temporary_project(&self, project_id: &str) {
        let (window_label, replacement) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            match retire_empty_temporary_project(&mut inner, project_id) {
                RetireOutcome::NotEligible => return,
                RetireOutcome::Removed {
                    window_label,
                    replacement,
                } => (window_label, replacement),
            }
        };
        let Some(window_label) = window_label else {
            return;
        };
        let Some(replacement) = replacement else {
            // The window cannot stay attached to a project: using a bare
            // WebviewWindow would render an unowned empty state, so the last
            // resort is closing it (the tray can always reopen the window).
            if let Some(window) = self.app.get_webview_window(&window_label) {
                let _ = window.destroy();
            }
            return;
        };
        let displaced = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.windows.clear_attachments(&window_label);
            inner
                .windows
                .assign(&window_label, &replacement.id)
                .displaced_window
        };
        if let Some(displaced) = displaced
            && let Some(window) = self.app.get_webview_window(&displaced)
        {
            let _ = window.destroy();
        }
        if let Some(window) = self.app.get_webview_window(&window_label) {
            let _ = window.set_title(&format!("{} — Agent Terminal", replacement.name));
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            self.mark_window_focused(&window_label);
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

/// Resolves the startup (home directory) project, reusing a saved or
/// temporary project that already covers it and creating a new temporary
/// project when none exists. Guarantees the app always has a default project
/// to fall back on, even after every unsaved project has been closed.
fn ensure_home_project(inner: &mut Inner) -> Result<Project> {
    let start_folder = canonical_directory(
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?),
    )?;
    if let Some(project) = inner
        .store
        .projects()
        .iter()
        .find(|saved| normalized_path(Path::new(&saved.path)) == normalized_path(&start_folder))
        .cloned()
        .or_else(|| {
            inner
                .temporary_projects
                .values()
                .find(|project| {
                    normalized_path(Path::new(&project.path)) == normalized_path(&start_folder)
                })
                .cloned()
        })
    {
        return Ok(project);
    }
    let project = Project {
        id: format!("temporary-{}", Uuid::new_v4()),
        name: folder_name(&start_folder),
        path: start_folder.to_string_lossy().into_owned(),
        persistent: false,
        created_at: None,
    };
    inner
        .temporary_projects
        .insert(project.id.clone(), project.clone());
    inner.project_order.push(project.id.clone());
    Ok(project)
}

/// The project a startup window opens on: the first saved project in the
/// user's saved order, falling back to the home directory project when
/// nothing is saved. Unsaved temporary projects never win, even while one
/// still has live sessions or an open window, because a fresh start means
/// none of those exist yet. No session is created, so a fresh app opens
/// with zero terminal tabs.
fn startup_project(inner: &mut Inner) -> Result<Project> {
    if let Some(project) = public_projects(inner).into_iter().find(|project| {
        inner
            .store
            .projects()
            .iter()
            .any(|saved| saved.id == project.id)
    }) {
        return Ok(project);
    }
    ensure_home_project(inner)
}

/// A saved project is always usable; a temporary project is only usable while
/// it still has a session or an open window.
fn project_is_usable(inner: &Inner, project_id: &str) -> bool {
    if inner
        .store
        .projects()
        .iter()
        .any(|project| project.id == project_id)
    {
        return true;
    }
    if !inner.temporary_projects.contains_key(project_id) {
        return false;
    }
    inner
        .sessions
        .values()
        .any(|session| session.metadata.project_id == project_id)
        || inner.windows.has_project(project_id)
}

#[derive(Debug)]
enum RetireOutcome {
    /// The project is not an empty temporary project; nothing was removed.
    NotEligible,
    /// The empty temporary project was removed. When a registered window was
    /// still attached to it, `window_label` and the requested replacement
    /// project are returned so the caller can hand the window over.
    Removed {
        window_label: Option<String>,
        replacement: Option<Project>,
    },
}

/// Removes an empty temporary project from the registry. The replacement is
/// only requested when the project still had a window, so a windowless
/// temporary project (for example one left behind after its window was
/// destroyed) is retired without spawning a window.
fn retire_empty_temporary_project(inner: &mut Inner, project_id: &str) -> RetireOutcome {
    if !inner.temporary_projects.contains_key(project_id)
        || inner
            .sessions
            .values()
            .any(|session| session.metadata.project_id == project_id)
    {
        return RetireOutcome::NotEligible;
    }
    inner.temporary_projects.remove(project_id);
    inner.project_order.retain(|id| id != project_id);
    let window_label = inner
        .windows
        .window_for_project(project_id)
        .map(str::to_owned);
    let replacement = window_label.as_ref().and_then(|_| preferred_project(inner));
    RetireOutcome::Removed {
        window_label,
        replacement,
    }
}

/// Picks the project a window should fall back to when its current project is
/// being removed: the last focused project still in use, the most recently
/// created running session's project, or the first public project. As a last
/// resort the home directory project is created so a window always has a
/// project to attach to.
fn preferred_project(inner: &mut Inner) -> Option<Project> {
    if let Some(project_id) = inner
        .windows
        .last_project()
        .filter(|project_id| project_is_usable(inner, project_id))
        .map(str::to_owned)
    {
        return project_by_id(inner, &project_id);
    }
    newest_running_session_project_id(inner.sessions.values().map(|session| &session.metadata))
        .or_else(|| {
            public_projects(inner)
                .first()
                .map(|project| project.id.clone())
        })
        .and_then(|project_id| project_by_id(inner, &project_id))
        .or_else(|| ensure_home_project(inner).ok())
}

/// The project that owns the most recently created running session. Exited
/// sessions are ignored, so a dead terminal cannot resurrect a project.
fn newest_running_session_project_id<'a>(
    sessions: impl Iterator<Item = &'a TerminalSession>,
) -> Option<String> {
    sessions
        .filter(|session| session.status == "running")
        .max_by(|left, right| left.created_at.cmp(&right.created_at))
        .map(|session| session.project_id.clone())
}

/// The result of applying a reported working directory to a session.
#[derive(Debug)]
enum CdOutcome {
    /// No session matched the id; nothing changed and no broadcast is needed.
    Missing,
    /// Follow-working-directory is off: the new cwd was recorded, but the
    /// session stays in its current project and no window is moved or opened.
    Recorded,
    /// Follow-working-directory is on: the session was reassigned to a project;
    /// the window side-effects to run outside the lock are in the plan.
    Reassigned(CdPlan),
}

/// Window decisions implied by a working-directory change, computed under the
/// state lock and applied by the caller once it is free of the lock.
#[derive(Debug, Clone)]
struct CdPlan {
    project: Project,
    previous_project_id: String,
    project_changed: bool,
    active_window: Option<String>,
    displaced_window: Option<String>,
    old_has_sessions: bool,
    open_projects_in_new_windows: bool,
}

/// Whether a session created outside of the desktop's explicit open-project
/// flow (the phone's `New terminal`, or the desktop's add-tab button) needs a
/// fresh background window: only when the project does not already own one
/// and the desktop is in per-project-window mode. A project that already has
/// a window is left alone (no focus, no hoisting), and in single-window mode
/// nothing is created because switching a window to the project is exactly
/// how the desktop changes its selected project.
fn should_open_quiet_window(open_projects_in_new_windows: bool, project_has_window: bool) -> bool {
    open_projects_in_new_windows && !project_has_window
}

/// Resolve which project a session's new working directory belongs to and
/// update the session's stored cwd. With follow-working-directory on the
/// session is moved to the matching project (creating a temporary one when
/// none matches) and a window plan is returned; with it off the cwd is
/// recorded but the session is left in its project.
fn resolve_working_directory(inner: &mut Inner, session_id: &str, cwd: &Path) -> CdOutcome {
    let Some(current) = inner
        .sessions
        .get(session_id)
        .map(|session| session.metadata.clone())
    else {
        return CdOutcome::Missing;
    };
    let cwd_text = cwd.to_string_lossy().into_owned();
    if let Some(session) = inner.sessions.get_mut(session_id) {
        session.metadata.cwd = cwd_text.clone();
    }
    if !inner.store.settings().follow_working_directory {
        return CdOutcome::Recorded;
    }
    let mut saved = inner
        .store
        .projects()
        .iter()
        .filter(|project| is_within_project(cwd, Path::new(&project.path)))
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
                .find(|project| normalized_path(Path::new(&project.path)) == normalized_path(cwd))
                .cloned()
        })
        .unwrap_or_else(|| {
            let project = Project {
                id: format!("temporary-{}", Uuid::new_v4()),
                name: folder_name(cwd),
                path: cwd_text.clone(),
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
    CdOutcome::Reassigned(CdPlan {
        project,
        previous_project_id: current.project_id,
        project_changed,
        active_window,
        displaced_window,
        old_has_sessions,
        open_projects_in_new_windows,
    })
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

/// Trim the front of the raw PTY journal so a replayed snapshot never starts in
/// the middle of an ANSI escape sequence. Clients replay the journal into a
/// blank xterm emulator, so the first byte they see must be at a sequence
/// boundary (`ESC` or plain printable output); cutting in the middle of a CSI
/// or OSC sequence would leave the emulator in a corrupted drawing state.
fn truncate_journal_front(value: &mut String, maximum: usize) {
    if value.len() <= maximum {
        return;
    }
    let mut start = value.len() - maximum;
    if let Some(relative) = value.get(start..).and_then(|tail| tail.find('\x1b')) {
        start += relative;
    }
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value.drain(..start);
}

/// Dual-path grid policy. The session grid may ONLY change while a TUI owns
/// the screen (inline or fullscreen - focus-driven ownership): the program
/// gets a SIGWINCH and repaints natively. In canonical mode the session grid
/// is fixed, so client sizes are recorded as the next TUI's viewport but
/// never applied to the PTY - clients render the frozen session as
/// independent viewports.
fn apply_grid_if_tui(session: &mut ManagedSession, cols: u16, rows: u16) -> Option<GridEpoch> {
    session.requested_viewport = Some((cols, rows));
    if session.tui.mode() != TuiMode::Canonical {
        apply_session_grid(session, cols, rows)
    } else {
        None
    }
}

/// Resize the PTY to the requesting client's grid and record the epoch, or
/// nothing if the grid did not actually change. `apply_session_grid` runs
/// under the session lock, so the recorded epoch offset is always aligned to
/// a journal chunk boundary.
fn apply_session_grid(session: &mut ManagedSession, cols: u16, rows: u16) -> Option<GridEpoch> {
    let cols = cols.clamp(2, 500);
    let rows = rows.clamp(1, 200);
    if (cols, rows) == session.grid {
        return None;
    }
    // A resize is already a PTY notification. Do not pulse through a second
    // row count: ConPTY can make a focused line editor beep or lose the key
    // being entered when it sees the synthetic rows-1 -> rows transition.
    let _ = session.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    session.grid = (cols, rows);
    let epoch = GridEpoch {
        offset: session.journal_len,
        cols,
        rows,
    };
    session.grid_epochs.push(epoch);
    Some(epoch)
}

fn snapshot_of(session: &ManagedSession) -> SessionSnapshot {
    let base = session.journal_len.saturating_sub(session.buffer.len() as u64);
    SessionSnapshot {
        segments: split_journal_by_epochs(&session.buffer, &session.grid_epochs, base),
        end_offset: session.journal_len,
    }
}

/// Split the (possibly front-trimmed) journal into per-grid segments. Every
/// epoch's stream offset maps to a byte position in the string because the
/// journal is only ever trimmed as a prefix and appends always land on
/// character boundaries. Zero-length segments are kept for back-to-back grid
/// swaps (no output between two resizes), so a replay reflows through every
/// intermediate grid exactly the way live clients did.
fn split_journal_by_epochs(
    journal: &str,
    epochs: &[GridEpoch],
    base_offset: u64,
) -> Vec<SessionSegment> {
    if journal.is_empty() {
        return Vec::new();
    }
    let mut segments = Vec::new();
    let mut cursor_byte = 0_usize;
    let mut current = GridEpoch {
        offset: base_offset,
        cols: SESSION_DEFAULT_COLS,
        rows: SESSION_DEFAULT_ROWS,
    };
    for epoch in epochs {
        if epoch.offset < base_offset {
            current = *epoch;
            continue;
        }
        let mut relative = (epoch.offset - base_offset) as usize;
        if relative > journal.len() {
            break;
        }
        while relative < journal.len() && !journal.is_char_boundary(relative) {
            relative += 1;
        }
        let start = cursor_byte.min(relative);
        let mut cursor = start;
        while cursor < relative && !journal.is_char_boundary(cursor) {
            cursor += 1;
        }
        if relative > cursor {
            segments.push(SessionSegment {
                cols: current.cols,
                rows: current.rows,
                data: journal[cursor..relative].to_string(),
            });
        } else if (current.cols, current.rows) != (epoch.cols, epoch.rows) {
            // A back-to-back grid swap with no output in between: keep the
            // zero-length segment so replay reflows through the intermediate
            // grid exactly as the live clients did.
            segments.push(SessionSegment {
                cols: current.cols,
                rows: current.rows,
                data: String::new(),
            });
        }
        cursor_byte = relative;
        current = *epoch;
    }
    if cursor_byte < journal.len() {
        segments.push(SessionSegment {
            cols: current.cols,
            rows: current.rows,
            data: journal[cursor_byte..].to_string(),
        });
    }
    // Pin the final (current) grid even when it produced no bytes yet, so a
    // replay always ends at the same grid the live clients are on.
    if !segments.last().is_some_and(|segment: &SessionSegment| {
        (segment.cols, segment.rows) == (current.cols, current.rows)
    }) {
        segments.push(SessionSegment {
            cols: current.cols,
            rows: current.rows,
            data: String::new(),
        });
    }
    segments
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

/// Clears the in-flight verification flag when its task exits on a path that
/// did not reach a terminal broadcast (unexpected return or panic).
struct RemoteVerificationGuard(Arc<Core>);
impl Drop for RemoteVerificationGuard {
    fn drop(&mut self) {
        self.0.remote_verification_running.store(false, Ordering::Release);
    }
}

/// The badge status for a given connectivity reading: no authorized device
/// means nobody can use the overlay route, so the badge says "Pair a device"
/// regardless of any stored verdict; while the machine has no internet the
/// stored registration verdict is hidden and the badge shows "No internet"
/// instead of a stale enrolled/pending/failed state; an in-flight
/// verification or enrollment run keeps the badge on "pending": the stored
/// verdict is stale for its whole duration, and a first render that lands
/// mid-run must not skip straight back to the saved state.
fn registration_status_for_display(
    has_devices: bool,
    online: bool,
    stored: &str,
    verifying: bool,
) -> String {
    if !has_devices {
        "unpaired".to_owned()
    } else if !online {
        "offline".to_owned()
    } else if verifying {
        "pending".to_owned()
    } else {
        stored.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CdOutcome, CdPlan, ConnectivityAction, ConnectivityTracker, EmbeddedNodeStatus, Inner,
        ManagedSession, PRESENCE_WINDOW_MS, PairingGrant, RetireOutcome, ensure_home_project,
        folder_name, is_cursor_position_report, is_dropped_node_status, is_within_project,
        newest_running_session_project_id, parse_terminal_titles, parse_working_directories,
        apply_grid_if_tui, apply_session_grid, preferred_project, presence_alive,
        project_is_usable, project_name_or_folder, record_cursor_position_requests,
        registration_status_for_display, resolve_working_directory, retire_empty_temporary_project,
        should_open_quiet_window, snapshot_from_inner,
        split_journal_by_epochs, startup_project, take_valid_pairing_grant, truncate_journal_front,
        validate_project_name, GridEpoch, SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS,
    };
    use crate::{
        models::{AuthorizedDevice, Project, TerminalSession, TuiMode},
        store::DesktopStore,
        tui::TuiClassifier,
        window_clients::WindowClients,
    };
    use portable_pty::{ChildKiller, MasterPty, PtySize};
    use std::{
        collections::{HashMap, HashSet},
        fs,
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    #[test]
    fn journal_truncation_starts_the_tail_at_an_escape_boundary() {
        let mut journal = String::new();
        journal.push_str("C:\\repo> ls\r\n");
        for index in 0..100 {
            journal.push_str(&format!("file-{index:03}.txt\r\n"));
        }
        journal.push_str("C:\\repo> echo \x1b[31mred\x1b[0m\r\n");
        journal.push_str("\x1b]9;9;C:\\repo\\docs\x07journal tail\r\n");

        let expected_tail =
            String::from("\x1b[31mred\x1b[0m\r\n\x1b]9;9;C:\\repo\\docs\x07journal tail\r\n");

        truncate_journal_front(&mut journal, 64);
        assert_eq!(journal, expected_tail);
    }

    #[test]
    fn journal_truncation_mid_sequence_skips_to_the_next_escape() {
        // The natural cut point lands inside "\x1b[1;5C", and a second escape
        // ("\x1b[32m") follows it. The trimmed journal must start at that next
        // ESC so a replayed snapshot never begins inside a sequence.
        let mut journal = String::from("seed \x1b[1;5C");
        journal.push_str(&"x".repeat(20));
        journal.push_str("\x1b[32m");
        journal.push_str(&"y".repeat(60));

        truncate_journal_front(&mut journal, 90);
        assert_eq!(journal, format!("\x1b[32m{}", "y".repeat(60)));
    }

    #[test]
    fn journal_truncation_handles_tiny_caps_without_panicking() {
        let mut journal = String::from("\x1b[1A text goes here");
        truncate_journal_front(&mut journal, 4);
        assert!(journal.len() > 0);
        truncate_journal_front(&mut journal, 0);
        assert!(journal.is_empty());
        truncate_journal_front(&mut journal, usize::MAX);
        assert!(journal.is_empty());
    }

    #[test]
    fn journal_splits_into_per_grid_segments_without_losing_bytes() {
        let stream = "PS C:\\repo> dir\r\nfile-one.txt\r\nfile-two.txt\r\nPS C:\\repo> git status\r\n";
        // Offsets: 18 lands inside "file-one.txt" (a mid-line grid switch is
        // fine - reflow takes over the already-printed row), 45 is exactly
        // the start of the next prompt line.
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: 18, cols: 45, rows: 35 },
            GridEpoch { offset: 45, cols: 100, rows: 40 },
        ];
        let segments = split_journal_by_epochs(stream, &epochs, 0);
        let joined: String = segments.iter().map(|segment| segment.data.as_str()).collect();
        assert_eq!(joined, stream, "no byte may be lost or duplicated across grid slices");
        assert_eq!(segments[0].cols, 120);
        assert_eq!(segments[1].cols, 45);
        assert_eq!(segments[1].data, "ile-one.txt\r\nfile-two.txt\r\n");
        assert_eq!(segments[2].cols, 100);
        assert_eq!(segments[2].data, "PS C:\\repo> git status\r\n");
    }

    #[test]
    fn journal_split_keeps_zero_length_segments_for_back_to_back_swaps() {
        // Two grid swaps with no output between them must still appear as
        // resize steps so a replay reflows through the intermediate grid and
        // always ends on the current grid.
        let stream = "abc";
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: 3, cols: 45, rows: 35 },
            GridEpoch { offset: 3, cols: 100, rows: 40 },
        ];
        let segments = split_journal_by_epochs(stream, &epochs, 0);
        assert_eq!(segments.len(), 3);
        assert_eq!((segments[0].cols, segments[0].rows), (120, 30));
        assert_eq!(segments[0].data, "abc");
        assert_eq!((segments[1].cols, segments[1].rows), (45, 35));
        assert_eq!(segments[1].data, "");
        assert_eq!((segments[2].cols, segments[2].rows), (100, 40));
        assert_eq!(segments[2].data, "");
        let joined: String = segments.iter().map(|segment| segment.data.as_str()).collect();
        assert_eq!(joined, "abc");
    }

    #[test]
    fn journal_split_after_front_trimming_starts_at_the_trimmed_base() {
        let journal = &"A".repeat(500)[200..];
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: 480, cols: 60, rows: 40 },
        ];
        let base = 200_u64;
        let segments = split_journal_by_epochs(journal, &epochs, base);
        assert_eq!(segments[0].cols, 120, "the last epoch at or before the base still applies");
        let joined: String = segments.iter().map(|segment| segment.data.as_str()).collect();
        assert_eq!(joined, journal);
    }

    #[test]
    fn journal_split_survives_multibyte_characters_at_epoch_boundaries() {
        let stream = "PS> 日本語ファイル.txt\r\n日本語列もそのまま\r\n";
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: (stream.len() - "日本語列もそのまま\r\n".len()) as u64, cols: 80, rows: 24 },
        ];
        let segments = split_journal_by_epochs(stream, &epochs, 0);
        let joined: String = segments.iter().map(|segment| segment.data.as_str()).collect();
        assert_eq!(joined, stream);
        assert_eq!(segments[1].cols, 80);
    }

    #[test]
    fn journal_split_starts_at_an_epoch_that_sits_exactly_on_the_trimmed_base() {
        // base_offset == an epoch offset: that epoch's grid must own the
        // whole trimmed journal, with no bytes ascribed to the stale grid.
        let journal = "PS> dir\r\nfile.txt\r\n";
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: 200, cols: 45, rows: 35 },
        ];
        let segments = split_journal_by_epochs(journal, &epochs, 200);
        let joined: String = segments.iter().map(|segment| segment.data.as_str()).collect();
        assert_eq!(joined, journal);
        assert_eq!(segments.last().unwrap().cols, 45);
    }

    #[test]
    fn journal_split_ignores_epochs_beyond_the_trimmed_journal() {
        // The journal was front-trimmed so far that an archive epoch now sits
        // past the end of the retained bytes; slicing must not panic or emit
        // unreachable segments, and the retained grid stays the latest one.
        let journal = "tail-content\r\n";
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: 10, cols: 72, rows: 26 },
            GridEpoch { offset: 5000, cols: 113, rows: 39 },
        ];
        let segments = split_journal_by_epochs(journal, &epochs, 200);
        let joined: String = segments.iter().map(|segment| segment.data.as_str()).collect();
        assert_eq!(joined, journal);
        assert_eq!(segments.last().unwrap().cols, 72);
    }

    #[test]
    fn journal_split_of_an_empty_journal_yields_no_segments() {
        let epochs = vec![GridEpoch { offset: 0, cols: 120, rows: 30 }];
        assert!(split_journal_by_epochs("", &epochs, 0).is_empty());
    }

    #[test]
    fn journal_split_pins_the_current_grid_when_the_trimmed_journal_has_no_epoch_yet() {
        // base sits before the first (zero-byte) epoch that already changed
        // the grid: the split must still end on the epoch's grid, never on
        // the spawn default.
        let journal = "abc";
        let epochs = vec![
            GridEpoch { offset: 0, cols: 120, rows: 30 },
            GridEpoch { offset: 3, cols: 45, rows: 35 },
        ];
        let segments = split_journal_by_epochs(journal, &epochs, 0);
        assert_eq!(segments.last().unwrap().cols, 45);
        assert_eq!(
            segments[0].cols,
            120,
            "the bytes before the epoch still carry the previous grid"
        );
    }

    #[test]
    fn applying_the_same_grid_is_a_no_op_and_changing_it_records_an_epoch() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let first = apply_session_grid(&mut session, 113, 39);
        assert_eq!(first, Some(GridEpoch { offset: 0, cols: 113, rows: 39 }));
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.grid_epochs.len(), 2);

        let noop = apply_session_grid(&mut session, 113, 39);
        assert_eq!(noop, None);
        assert_eq!(session.grid_epochs.len(), 2, "a no-op must not add an epoch");

        let second = apply_session_grid(&mut session, 72, 26);
        assert_eq!(second, Some(GridEpoch { offset: 0, cols: 72, rows: 26 }));
        assert_eq!(session.grid, (72, 26));
        assert_eq!(session.grid_epochs.len(), 3);
    }

    #[test]
    fn applying_a_grid_uses_the_current_journal_position_for_the_epoch() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        session.buffer.push_str("existing history");
        session.journal_len = 19;
        let epoch = apply_session_grid(&mut session, 100, 34);
        assert_eq!(epoch, Some(GridEpoch { offset: 19, cols: 100, rows: 34 }));
    }

    /// Feed one chunk to the session's TUI classifier, advancing the test
    /// clock, and mirror the host's metadata sync (what `on_terminal_data`
    /// does with a reported transition).
    fn feed_session(
        session: &mut ManagedSession,
        clock: &mut Instant,
        step_ms: u64,
        chunk: &str,
    ) -> Option<crate::tui::TuiTransition> {
        *clock += Duration::from_millis(step_ms);
        let transition = session.tui.feed(chunk, *clock, session.grid.1);
        if let Some(t) = transition {
            session.metadata.tui_mode = t.to;
        }
        transition
    }

    #[test]
    fn tui_classifier_moves_a_session_between_modes() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // A split alt-enter sequence bridges chunk boundaries and commits
        // to fullscreen immediately.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?104").is_none());
        let enter = feed_session(&mut session, &mut clock, 5, "9h").expect("alt enter");
        assert_eq!(enter.to, TuiMode::Fullscreen);
        assert!(enter.via_alt_enter, "the program's own alt enter is reported");
        assert_eq!(session.metadata.tui_mode, TuiMode::Fullscreen);
        // TUI frames do not re-trigger a transition.
        assert!(feed_session(&mut session, &mut clock, 10, "top - 0.3 up\r\n").is_none());
        // The program's own alt exit is observed, but the mode only
        // releases once the cursor is visible and the stream goes quiet.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        assert_eq!(session.metadata.tui_mode, TuiMode::Fullscreen);
        let exit = feed_session(&mut session, &mut clock, 350, "\r\n").expect("quiet alt exit");
        assert_eq!(exit.to, TuiMode::Canonical);
        assert!(exit.program_alt_exit);
        assert_eq!(session.metadata.tui_mode, TuiMode::Canonical);
    }

    #[test]
    fn tui_classifier_keeps_shell_activity_in_canonical() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // An orphan alt exit (no entry), the shell's `clear` (ED2 +
        // home), and bracketed-paste state must never leave canonical
        // mode - and still must not after the confirmation window.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[2J\x1b[H").is_none());
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?2004h").is_none());
        assert!(feed_session(&mut session, &mut clock, 10, "\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 60, "").is_none());
        assert_eq!(session.tui.mode(), TuiMode::Canonical);
        assert_eq!(session.metadata.tui_mode, TuiMode::Canonical);
    }

    #[test]
    fn tui_classifier_treats_a_repaint_harness_as_inline() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // A primary-buffer bottom-region harness (fzf-style) repaints a
        // bounded region: the session goes inline - output stays in the
        // scrollback - instead of fullscreen.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?25l").is_none());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[3A\x1b[2Kline a\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[3A\x1b[2Kline b\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[3A\x1b[2Kline c\r\n").is_none());
        let inline = feed_session(&mut session, &mut clock, 60, "").expect("inline commit");
        assert_eq!(inline.to, TuiMode::Inline);
        assert!(!inline.via_alt_enter);
        // The program's own alt enter upgrades the period to fullscreen.
        let upgrade = feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").expect("upgrade");
        assert_eq!(upgrade.to, TuiMode::Fullscreen);
        assert!(upgrade.via_alt_enter);
    }

    #[test]
    fn grid_policy_records_but_does_not_reapply_an_unaltered_viewport() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        let first = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(first, Some(GridEpoch { offset: 0, cols: 113, rows: 39 }));
        // Re-asserting the SAME viewport while the TUI still owns the screen
        // yields no epoch (no spurious SIGWINCH).
        let second = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(second, None);
        assert_eq!(session.grid_epochs.len(), 2);
        // Leaving the TUI: the grid freezes; the next client viewport is
        // recorded only, never applied to the PTY.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        assert!(feed_session(&mut session, &mut clock, 350, "\r\n").is_some());
        let third = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(third, None);
        assert_eq!(session.requested_viewport, Some((113, 39)));
    }

    #[test]
    fn grid_policy_only_resizes_while_a_tui_is_active() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // Canonical: client sizes are recorded for the next TUI, never applied.
        assert!(apply_grid_if_tui(&mut session, 72, 26).is_none());
        assert_eq!(
            session.grid,
            (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
            "the session grid must stay frozen in canonical mode"
        );
        assert_eq!(session.requested_viewport, Some((72, 26)));

        // TUI active: focus-driven ownership applies the announced viewport.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        let epoch = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(epoch, Some(GridEpoch { offset: 0, cols: 113, rows: 39 }));
        assert_eq!(session.grid, (113, 39));

        // TUI exit: the grid freezes at the last TUI size, and the next
        // client viewport is only recorded again.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        assert!(feed_session(&mut session, &mut clock, 350, "\r\n").is_some());
        assert!(apply_grid_if_tui(&mut session, 90, 30).is_none());
        assert_eq!(session.grid, (113, 39), "grid freezes after TUI exit");
        assert_eq!(session.requested_viewport, Some((90, 30)));
    }

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
                registration_status_for_display(true, false, stored, false),
                "offline",
                "offline must hide a stored {stored} status"
            );
            assert_eq!(registration_status_for_display(true, true, stored, false), stored);
        }
    }

    #[test]
    fn a_running_verification_holds_the_badge_on_pending() {
        for stored in ["unregistered", "pending", "enrolled", "failed"] {
            assert_eq!(
                registration_status_for_display(true, true, stored, true),
                "pending",
                "an in-flight run must override a stored {stored} status"
            );
        }
    }

    #[test]
    fn no_devices_always_show_pair_a_device() {
        for online in [true, false] {
            for verifying in [true, false] {
                for stored in ["unregistered", "pending", "enrolled", "failed"] {
                    assert_eq!(
                        registration_status_for_display(false, online, stored, verifying),
                        "unpaired",
                        "no device + online={online} verifying={verifying} stored={stored} must show pair a device"
                    );
                }
            }
        }
    }

    #[test]
    fn offline_beats_a_running_verification() {
        assert_eq!(
            registration_status_for_display(true, false, "enrolled", true),
            "offline"
        );
    }

    #[test]
    fn a_stored_pending_verdict_survives_a_finished_run_when_no_device_was_ever_registered() {
        // The gate only reports pending while a run is in flight; a finished
        // run with no verification shows the stored verdict as-is.
        assert_eq!(registration_status_for_display(true, true, "pending", false), "pending");
        assert_eq!(registration_status_for_display(true, true, "enrolled", false), "enrolled");
        assert_eq!(registration_status_for_display(true, true, "failed", false), "failed");
        assert_eq!(registration_status_for_display(true, true, "unregistered", false), "unregistered");
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

    #[test]
    fn snapshot_reports_the_valid_default_shell_and_falls_back_on_a_stale_one() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        let shells = vec![
            shell_profile("powershell"),
            shell_profile("cmd"),
            shell_profile("git-bash"),
        ];
        store
            .set_default_shell("git-bash".into())
            .expect("pick a known shell");

        let mut inner = test_inner(store, shells.clone());
        assert_eq!(
            snapshot_from_inner(&inner, &HashSet::new()).default_shell_id,
            "git-bash",
            "the stored default name is reported unchanged"
        );

        // A shell profile that later disappears must not leak into snapshots:
        // the first available shell becomes the honest default instead.
        inner.store.set_default_shell("removed-profile".into()).expect("stale value");
        assert_eq!(
            snapshot_from_inner(&inner, &HashSet::new()).default_shell_id,
            "powershell",
            "a stale default falls back to the first available shell"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn snapshot_without_shell_profiles_falls_back_to_cmd() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let inner = test_inner(store, Vec::new());
        assert_eq!(
            snapshot_from_inner(&inner, &HashSet::new()).default_shell_id,
            "cmd",
            "an empty shell list still reports a usable default"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn the_default_shell_survives_a_store_reload() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        {
            let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
            store
                .set_default_shell("cmd".into())
                .expect("change the default");
        }
        {
            let shell = shell_profile("cmd");
            let store = DesktopStore::load(state_path.clone()).expect("reload store");
            let inner = test_inner(store, vec![shell]);
            assert_eq!(
                snapshot_from_inner(&inner, &HashSet::new()).default_shell_id,
                "cmd",
                "the desktop option persists across restarts so a phone pick sticks"
            );
        }
        fs::remove_file(state_path).expect("remove test state");
    }

    fn shell_profile(id: &str) -> crate::models::ShellProfile {
        crate::models::ShellProfile {
            id: id.into(),
            name: id.into(),
            executable: id.into(),
            args: Vec::new(),
        }
    }

    fn test_project(inner: &mut Inner, id: &str, path: &str, persistent: bool) -> Project {
        let project = Project {
            id: id.into(),
            name: id.into(),
            path: path.into(),
            persistent,
            created_at: Some("2026-08-27T00:00:00Z".into()),
        };
        if persistent {
            inner
                .store
                .save_project(project.clone())
                .expect("save test project");
        } else {
            inner
                .temporary_projects
                .insert(project.id.clone(), project.clone());
            inner.project_order.push(project.id.clone());
        }
        project
    }

    #[test]
    fn temporary_projects_are_only_usable_with_a_session_or_window() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        test_project(&mut inner, "saved-a", "C:\\Work\\SavedA", true);
        assert!(
            project_is_usable(&inner, "saved-a"),
            "saved projects stay usable"
        );

        // A temporary project that lost its window and sessions is not usable.
        test_project(&mut inner, "temp-gone", "C:\\Work\\TempGone", false);
        assert!(!project_is_usable(&inner, "temp-gone"));

        // ...but it stays usable while it still has an open window.
        inner.windows.assign("window-a", "temp-gone");
        assert!(project_is_usable(&inner, "temp-gone"));

        // Once the window goes away too, only the saved project remains.
        inner.windows.remove_window("window-a");
        assert!(!project_is_usable(&inner, "temp-gone"));

        assert!(!project_is_usable(&inner, "missing"));
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn preferred_project_prefers_the_last_focused_usable_project() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        let saved_a = test_project(&mut inner, "saved-a", "C:\\Work\\SavedA", true);
        inner.windows.assign("window-a", &saved_a.id);
        inner.windows.mark_focused("window-a");
        let saved_b = test_project(&mut inner, "saved-b", "C:\\Work\\SavedB", true);
        inner.windows.assign("window-b", &saved_b.id);
        inner.windows.mark_focused("window-b");

        assert_eq!(preferred_project(&mut inner).unwrap().id, "saved-b");

        // A last-focused project that was removed is skipped.
        inner.windows.assign("window-b", "temp-c");
        inner.windows.mark_focused("window-b");
        assert_eq!(preferred_project(&mut inner).unwrap().id, "saved-a");

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn preferred_project_falls_back_to_the_home_project_when_nothing_else_remains() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        inner.windows.assign("window-a", "temp-only");
        inner.windows.mark_focused("window-a");

        let home = preferred_project(&mut inner).expect("home fallback project");
        assert!(!home.persistent, "home fallback is a temporary project");
        assert_eq!(
            home.name,
            folder_name(Path::new(&home.path)),
            "home name matches its folder"
        );
        assert!(
            inner.temporary_projects.contains_key(&home.id),
            "the home fallback is registered"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn ensure_home_project_reuses_an_existing_saved_home_project() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        let home_path = std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir().expect("current directory"));
        let saved = Project {
            id: "saved-home".into(),
            name: "Home".into(),
            path: home_path.to_string_lossy().into_owned(),
            persistent: true,
            created_at: Some("2026-08-27T00:00:00Z".into()),
        };
        store
            .save_project(saved.clone())
            .expect("save home project");
        let mut inner = test_inner(store, Vec::new());

        let home = ensure_home_project(&mut inner).expect("home project");
        assert_eq!(home.id, "saved-home", "the saved home project is reused");
        assert!(inner.temporary_projects.is_empty());

        fs::remove_file(state_path).expect("remove test state");
    }

    fn home_path() -> PathBuf {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir().expect("current directory"))
    }

    fn store_with_cleanup() -> (DesktopStore, PathBuf) {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        (store, state_path)
    }

    #[test]
    fn ensure_home_project_reuses_saved_projects_with_other_case_or_separators() {
        let home = home_path().to_string_lossy().into_owned();
        for variant in [
            home.to_lowercase(),
            home.replace('\\', "/"),
            format!("{home}\\"),
        ] {
            let (store, state_path) = store_with_cleanup();
            let mut inner = test_inner(store, Vec::new());
            test_project(&mut inner, "saved-home", &variant, true);

            let home = ensure_home_project(&mut inner).expect("home project");
            assert_eq!(
                home.id, "saved-home",
                "the saved project matches {variant:?} case-insensitively"
            );
            assert!(
                inner.temporary_projects.is_empty(),
                "no duplicate temporary project is created"
            );
            fs::remove_file(state_path).expect("remove test state");
        }
    }

    #[test]
    fn ensure_home_project_reuses_an_existing_temporary_home_project() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        let variant = home_path().to_string_lossy().to_lowercase();
        let temporary = test_project(&mut inner, "temp-home", &variant, false);

        let home = ensure_home_project(&mut inner).expect("home project");
        assert_eq!(
            home.id, temporary.id,
            "the existing temporary home project is reused, not duplicated"
        );
        assert_eq!(
            inner.temporary_projects.len(),
            1,
            "no second home project appears"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn ensure_home_project_prefers_a_saved_home_project_over_a_temporary_one() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        let home = home_path().to_string_lossy().into_owned();
        let temporary = test_project(
            &mut inner,
            "temp-home",
            home.to_lowercase().as_str(),
            false,
        );

        let result = ensure_home_project(&mut inner).expect("home project");
        assert_eq!(
            result.id, temporary.id,
            "while nothing is saved the temporary home project is reused"
        );

        test_project(&mut inner, "saved-home", &home, true);
        let result = ensure_home_project(&mut inner).expect("home project");
        assert_eq!(
            result.id, "saved-home",
            "once a saved project covers the home path it wins over the temporary duplicate"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn ensure_home_project_creates_a_single_temporary_project_when_none_covers_home() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        test_project(&mut inner, "saved-elsewhere", "C:\\Work\\Other", true);

        let created = ensure_home_project(&mut inner).expect("home project");
        assert!(
            created.id.starts_with("temporary-"),
            "the home fallback is a temporary project"
        );
        assert!(!created.persistent);
        assert_eq!(created.name, folder_name(Path::new(&created.path)));
        assert!(inner.temporary_projects.contains_key(&created.id));
        assert!(inner.project_order.contains(&created.id));

        let again = ensure_home_project(&mut inner).expect("home project");
        assert_eq!(
            again.id, created.id,
            "re-running initialization reuses the fallback instead of duplicating it"
        );
        assert_eq!(
            inner.temporary_projects.len(),
            1,
            "exactly one home project exists"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn ensure_home_project_ignores_saved_projects_in_subdirectories() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        let nested = home_path().join("nested").to_string_lossy().into_owned();
        test_project(&mut inner, "saved-nested", &nested, true);

        let created = ensure_home_project(&mut inner).expect("home project");
        assert_ne!(
            created.id, "saved-nested",
            "a project in a subfolder of the home directory is not the home project"
        );
        assert!(created.id.starts_with("temporary-"));
        assert!(inner.temporary_projects.contains_key(&created.id));

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn startup_project_picks_the_first_saved_project_in_the_user_order() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        test_project(&mut inner, "saved-alpha", "C:\\Work\\Alpha", true);
        test_project(&mut inner, "saved-beta", "C:\\Work\\Beta", true);
        // The user reordered the sidebar so beta comes first; the startup
        // must honor that order rather than the order the store persisted
        // the records in.
        inner.project_order = vec!["saved-beta".into(), "saved-alpha".into()];

        let picked = startup_project(&mut inner).expect("startup project");
        assert_eq!(picked.id, "saved-beta");
        assert!(
            inner.sessions.is_empty(),
            "starting up must not open a terminal tab"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn startup_project_picks_the_saved_home_project_when_it_is_not_first() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        test_project(&mut inner, "saved-alpha", "C:\\Work\\Alpha", true);
        let home = home_path().to_string_lossy().into_owned();
        test_project(&mut inner, "saved-home", &home, true);
        // Alpha was moved ahead of the home project by the user.
        inner.project_order = vec!["saved-alpha".into(), "saved-home".into()];

        let picked = startup_project(&mut inner).expect("startup project");
        assert_eq!(
            picked.id, "saved-alpha",
            "a saved project is chosen purely by user order, not by being the home directory"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn startup_project_falls_back_to_the_home_project_when_nothing_is_saved() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        assert!(inner.store.projects().is_empty());

        let picked = startup_project(&mut inner).expect("startup project");
        assert!(
            picked.id.starts_with("temporary-"),
            "with no saved projects the home directory project is created"
        );
        assert!(!picked.persistent);
        assert!(inner.temporary_projects.contains_key(&picked.id));
        assert!(
            inner.sessions.is_empty(),
            "starting up must not open a terminal tab, not even for the fallback project"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn startup_project_reuses_an_existing_temporary_home_project_without_duplicating_it() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        let existing = test_project(
            &mut inner,
            "temp-home",
            home_path().to_string_lossy().to_lowercase().as_str(),
            false,
        );

        let picked = startup_project(&mut inner).expect("startup project");
        assert_eq!(picked.id, existing.id, "the existing temporary home project is reused");
        assert_eq!(inner.temporary_projects.len(), 1, "no second home project appears");

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn startup_project_skips_unsaved_temporary_projects_even_when_they_have_live_sessions() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        test_project(&mut inner, "saved-alpha", "C:\\Work\\Alpha", true);
        // An unsaved project ordered first that still has a running session:
        // it is eligible to appear in the sidebar, but a restart must not
        // boot into an unsaved project.
        let temporary = test_project(&mut inner, "temp-first", "C:\\Work\\First", false);
        inner.sessions.insert(
            "session-temp-first".into(),
            test_session("session-temp-first", &temporary.id, "C:\\Work\\First"),
        );
        inner.project_order = vec![temporary.id, "saved-alpha".into()];

        let picked = startup_project(&mut inner).expect("startup project");
        assert_eq!(
            picked.id, "saved-alpha",
            "unsaved projects never win a startup, even ahead in the order"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn startup_project_never_boots_into_a_temporary_duplicate_of_a_saved_path() {
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        let home = home_path().to_string_lossy().into_owned();
        test_project(&mut inner, "saved-home", &home, true);
        // A leftover temporary project that covers the same folder (in a
        // different case) must not shadow the saved record.
        let duplicate = test_project(
            &mut inner,
            "temp-home-duplicate",
            home.to_lowercase().as_str(),
            false,
        );
        inner.sessions.insert(
            "session-temp-dup".into(),
            test_session("session-temp-dup", &duplicate.id, &home),
        );
        inner.project_order = vec![duplicate.id, "saved-home".into()];

        let picked = startup_project(&mut inner).expect("startup project");
        assert_eq!(
            picked.id, "saved-home",
            "the saved record is used, never its unsaved path duplicate"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn newest_running_session_project_id_ignores_exited_sessions() {
        let sessions = [
            session("s-old", "project-old", "exited", "2026-08-30T00:00:01Z"),
            session(
                "s-latest",
                "project-latest",
                "running",
                "2026-08-30T00:00:03Z",
            ),
            session("s-mid", "project-mid", "running", "2026-08-30T00:00:02Z"),
        ];
        let newest = newest_running_session_project_id(sessions.iter());
        assert_eq!(
            newest,
            Some("project-latest".into()),
            "the newest running session wins and exited sessions are skipped"
        );

        let only_exited = [session(
            "s-dead",
            "project-dead",
            "exited",
            "2026-08-30T00:00:00Z",
        )];
        assert_eq!(
            newest_running_session_project_id(only_exited.iter()),
            None,
            "a project with no running sessions must not be selected"
        );
        assert_eq!(newest_running_session_project_id(std::iter::empty()), None);
    }

    #[test]
    fn retire_keeps_a_persistent_project_without_its_window() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        let saved = test_project(&mut inner, "saved-a", "C:\\Work\\SavedA", true);
        inner.windows.assign("window-a", &saved.id);

        assert!(matches!(
            retire_empty_temporary_project(&mut inner, &saved.id),
            RetireOutcome::NotEligible
        ));
        assert!(
            inner
                .store
                .projects()
                .iter()
                .any(|project| project.id == saved.id),
            "the saved project stays in the store"
        );
        assert_eq!(
            inner.windows.project_for_window("window-a"),
            Some(saved.id.as_str()),
            "the window registration is untouched"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn retire_reuses_the_current_window_for_another_project() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        let closed = test_project(&mut inner, "temp-closed", "C:\\Work\\TempClosed", false);
        inner.windows.assign("window-a", &closed.id);
        inner.windows.mark_focused("window-a");
        let saved = test_project(&mut inner, "saved-a", "C:\\Work\\SavedA", true);
        inner.windows.assign("window-b", &saved.id);

        let RetireOutcome::Removed {
            window_label,
            replacement,
        } = retire_empty_temporary_project(&mut inner, &closed.id)
        else {
            panic!("the empty temporary project must be retired");
        };
        assert_eq!(
            window_label,
            Some("window-a".into()),
            "the window survives and moves to the last focused project"
        );
        assert_eq!(
            replacement.map(|project| project.id),
            Some("saved-a".into()),
            "the replacement is the last focused project"
        );
        assert!(!inner.temporary_projects.contains_key(&closed.id));
        assert!(!inner.project_order.iter().any(|id| id == &closed.id));

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn retire_without_any_other_project_falls_back_to_the_home_project() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        let closed = test_project(&mut inner, "temp-closed", "C:\\Work\\TempClosed", false);
        inner.windows.assign("window-a", &closed.id);
        inner.windows.mark_focused("window-a");

        let RetireOutcome::Removed {
            window_label,
            replacement,
        } = retire_empty_temporary_project(&mut inner, &closed.id)
        else {
            panic!("the empty temporary project must be retired");
        };
        assert_eq!(window_label, Some("window-a".into()));
        let replacement = replacement.expect("a fallback project is always provided");
        assert!(
            !replacement.persistent,
            "the fallback is the temporary home project, never a dead one"
        );
        assert!(
            inner.temporary_projects.contains_key(&replacement.id),
            "the fallback project is registered so the tray can reuse it"
        );
        assert_ne!(
            replacement.path, closed.path,
            "the home fallback must not reuse the closed project's directory"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn retire_without_a_registered_window_removes_the_project_quietly() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        let closed = test_project(&mut inner, "temp-closed", "C:\\Work\\TempClosed", false);
        // No window was ever registered: for example the project was created by
        // a `cd` report and its window was later destroyed.
        let RetireOutcome::Removed {
            window_label,
            replacement,
        } = retire_empty_temporary_project(&mut inner, &closed.id)
        else {
            panic!("the empty temporary project must be retired");
        };
        assert_eq!(
            window_label, None,
            "retiring a windowless project must not manufacture a window"
        );
        assert!(replacement.is_none());
        assert!(!inner.temporary_projects.contains_key(&closed.id));

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn retire_is_a_noop_for_unknown_projects() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let store = DesktopStore::load(state_path.clone()).expect("initial store");
        let mut inner = test_inner(store, Vec::new());

        test_project(&mut inner, "saved-a", "C:\\Work\\SavedA", true);
        assert!(matches!(
            retire_empty_temporary_project(&mut inner, "does-not-exist"),
            RetireOutcome::NotEligible,
        ));
        assert!(inner.project_order.is_empty());

        fs::remove_file(state_path).expect("remove test state");
    }

    fn session(id: &str, project_id: &str, status: &str, created_at: &str) -> TerminalSession {
        TerminalSession {
            id: id.into(),
            project_id: project_id.into(),
            title: "PowerShell".into(),
            cwd: "C:\\".into(),
            shell_id: "powershell".into(),
            status: status.into(),
            created_at: created_at.into(),
            exit_code: None,
                tui_mode: TuiMode::Canonical,
        }
    }

    fn test_inner(store: DesktopStore, shells: Vec<crate::models::ShellProfile>) -> Inner {
        Inner {
            store,
            shells,
            temporary_projects: HashMap::new(),
            project_order: Vec::new(),
            sessions: HashMap::new(),
            session_order: Vec::new(),
            windows: WindowClients::default(),
            pairing_grants: HashMap::new(),
        }
    }

    // Inert pty handles so tests can build real sessions without spawning a
    // terminal. Only the host-platform (Windows) surface is implemented. The
    // concrete types satisfy the `Downcast` supertrait through downcast-rs's
    // blanket `impl<T: Any> Downcast for T`, so no macro is required.
    struct InertMaster;
    impl MasterPty for InertMaster {
        fn resize(&self, _size: PtySize) -> Result<(), anyhow::Error> {
            Ok(())
        }
        fn get_size(&self) -> Result<PtySize, anyhow::Error> {
            Ok(PtySize::default())
        }
        fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, anyhow::Error> {
            Ok(Box::new(std::io::empty()))
        }
        fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, anyhow::Error> {
            Ok(Box::new(std::io::sink()))
        }
    }

    struct InertKiller;
    impl std::fmt::Debug for InertKiller {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("InertKiller")
        }
    }
    impl ChildKiller for InertKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(InertKiller)
        }
    }

    fn test_session(session_id: &str, project_id: &str, cwd: &str) -> ManagedSession {
        ManagedSession {
            metadata: TerminalSession {
                id: session_id.into(),
                project_id: project_id.into(),
                title: "Test".into(),
                cwd: cwd.into(),
                shell_id: "powershell".into(),
                status: "running".into(),
                created_at: "now".into(),
                exit_code: None,
                tui_mode: TuiMode::Canonical,
            },
            master: Box::new(InertMaster),
            writer: Box::new(std::io::sink()),
            killer: Box::new(InertKiller),
            grid: (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
            grid_epochs: vec![GridEpoch {
                offset: 0,
                cols: SESSION_DEFAULT_COLS,
                rows: SESSION_DEFAULT_ROWS,
            }],
            buffer: String::new(),
            journal_len: 0,
            tui: TuiClassifier::new(SESSION_DEFAULT_ROWS),
            synthetic_alt: false,
            requested_viewport: None,
            control_tail: String::new(),
            cursor_query_tail: String::new(),
            pending_cursor_reports: 0,
            has_run_command: false,
            terminal_controller: None,
        }
    }

    fn inner_with_settings(follow: bool, open_new_windows: bool) -> (Inner, PathBuf) {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        store
            .set_follow_working_directory(follow)
            .expect("set follow working directory");
        store
            .set_open_projects_in_new_windows(open_new_windows)
            .expect("set open projects in new windows");
        (test_inner(store, Vec::new()), state_path)
    }

    fn expect_reassigned(outcome: CdOutcome) -> CdPlan {
        match outcome {
            CdOutcome::Reassigned(plan) => plan,
            other => panic!("expected a reassigned plan, got {other:?}"),
        }
    }

    #[test]
    fn follow_off_records_cwd_but_keeps_the_session_project() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        test_project(&mut inner, "b", r"C:\Work\B", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");
        inner.windows.attach("window-a", "s1");

        let outcome = resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\B"));
        assert!(
            matches!(outcome, CdOutcome::Recorded),
            "with follow off the cwd is recorded, not reassigned"
        );
        let session = &inner.sessions["s1"].metadata;
        assert_eq!(session.cwd, r"C:\Work\B", "the new cwd is stored");
        assert_eq!(
            session.project_id, "a",
            "the session stays in its project when follow is off"
        );
        assert!(
            inner.temporary_projects.is_empty(),
            "no temporary project is created while follow is off"
        );
        assert_eq!(
            inner.windows.window_for_project("a"),
            Some("window-a"),
            "no window is moved while follow is off"
        );
        assert!(inner.windows.window_for_project("b").is_none());
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_off_creates_no_temporary_project_for_an_unmatched_folder() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        // A folder that matches no saved or temporary project.
        let outcome =
            resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Somewhere\Else"));
        assert!(matches!(outcome, CdOutcome::Recorded));
        assert_eq!(inner.sessions["s1"].metadata.project_id, "a");
        assert!(
            inner.temporary_projects.is_empty(),
            "an unmatched folder must not spawn a temporary project while follow is off"
        );
        assert!(inner.project_order.is_empty());
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_off_keeps_a_session_inside_a_temporary_project() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "temp-a", r"C:\Work\TempA", false);
        inner.sessions.insert("s1".into(), test_session("s1", "temp-a", r"C:\Work\TempA"));
        inner.windows.assign("window-t", "temp-a");
        inner.windows.attach("window-t", "s1");

        let outcome = resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\TempA\sub"));
        assert!(matches!(outcome, CdOutcome::Recorded));
        assert_eq!(inner.sessions["s1"].metadata.project_id, "temp-a");
        assert_eq!(
            inner.windows.window_for_project("temp-a"),
            Some("window-t"),
            "the temporary project's window is untouched while follow is off"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn resolve_missing_session_reports_missing_regardless_of_follow() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        assert!(matches!(
            resolve_working_directory(&mut inner, "ghost", Path::new(r"C:\Work\A")),
            CdOutcome::Missing
        ));
        inner.store
            .set_follow_working_directory(true)
            .expect("turn follow on");
        assert!(matches!(
            resolve_working_directory(&mut inner, "ghost", Path::new(r"C:\Work\A")),
            CdOutcome::Missing
        ));
        assert!(inner.sessions.is_empty());
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_reassigns_to_a_saved_project_that_contains_the_cwd() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        test_project(&mut inner, "b", r"C:\Work\B", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");
        inner.windows.attach("window-a", "s1");

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner, "s1", Path::new(r"C:\Work\B\deep"),
        ));
        assert_eq!(inner.sessions["s1"].metadata.project_id, "b");
        assert_eq!(plan.previous_project_id, "a");
        assert!(plan.project_changed);
        assert_eq!(plan.project.id, "b");
        assert_eq!(plan.active_window.as_deref(), Some("window-a"));
        assert_eq!(plan.displaced_window, None);
        assert!(inner.temporary_projects.is_empty());
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_prefers_the_deeper_nested_saved_project() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "outer", r"C:\Work", true);
        test_project(&mut inner, "inner", r"C:\Work\Deep", true);
        inner.sessions.insert("s1".into(), test_session("s1", "outer", r"C:\Work"));

        let plan =
            expect_reassigned(resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\Deep\x")));
        assert_eq!(plan.project.id, "inner", "the more specific project wins");
        assert_eq!(inner.sessions["s1"].metadata.project_id, "inner");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_reuses_an_existing_temporary_project() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        let temp = test_project(&mut inner, "temp-c", r"C:\Work\C", false);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        let temp_count = inner.temporary_projects.len();

        let plan =
            expect_reassigned(resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\C")));
        assert_eq!(plan.project.id, temp.id, "the existing temporary project is reused");
        assert_eq!(inner.sessions["s1"].metadata.project_id, "temp-c");
        assert_eq!(
            inner.temporary_projects.len(),
            temp_count,
            "reusing a temporary project must not create a duplicate"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_creates_a_temporary_project_when_nothing_matches() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        let order_len = inner.project_order.len();

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner, "s1", Path::new(r"C:\Fresh\Folder"),
        ));
        assert!(!plan.project.persistent, "a freshly matched folder becomes a temporary project");
        assert_eq!(plan.project.path, r"C:\Fresh\Folder");
        assert!(inner.temporary_projects.contains_key(&plan.project.id));
        assert_eq!(inner.sessions["s1"].metadata.project_id, plan.project.id);
        assert_eq!(inner.project_order.len(), order_len + 1);
        assert!(plan.project_changed);
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_same_project_makes_no_window_changes() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        let plan =
            expect_reassigned(resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\A\sub")));
        assert!(!plan.project_changed, "staying inside the same project is not a change");
        assert_eq!(plan.active_window, None);
        assert_eq!(plan.displaced_window, None);
        assert_eq!(inner.sessions["s1"].metadata.cwd, r"C:\Work\A\sub");
        assert_eq!(inner.sessions["s1"].metadata.project_id, "a");
        assert_eq!(inner.windows.window_for_project("a"), Some("window-a"));
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn quiet_window_is_created_only_for_unowned_projects_in_multi_window_mode() {
        // The contract behind a session opened by the phone or the add-tab
        // button: a project that already owns a window is never touched, and
        // single-window mode stays on the desktop's current project.
        assert!(
            should_open_quiet_window(true, false),
            "multi-window mode with no window for the project opens a background one"
        );
        assert!(
            !should_open_quiet_window(true, true),
            "a project that already owns a window is not hoisted or refocused"
        );
        assert!(
            !should_open_quiet_window(false, false),
            "in single-window mode creating a window would switch the desktop's project"
        );
        assert!(
            !should_open_quiet_window(false, true),
            "single-window mode never touches an existing window either"
        );
    }

    #[test]
    fn follow_on_moves_the_active_window_and_reports_the_displaced_one() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        test_project(&mut inner, "b", r"C:\Work\B", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");
        inner.windows.assign("window-b", "b");
        inner.windows.attach("window-a", "s1");

        let plan =
            expect_reassigned(resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\B")));
        assert!(plan.project_changed);
        assert_eq!(plan.active_window.as_deref(), Some("window-a"));
        assert_eq!(
            plan.displaced_window.as_deref(),
            Some("window-b"),
            "moving window-a to project b displaces project b's existing window"
        );
        assert_eq!(inner.windows.window_for_project("b"), Some("window-a"));
        assert_eq!(inner.windows.window_for_project("a"), None);
        assert_eq!(inner.sessions["s1"].metadata.project_id, "b");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_keeps_the_old_project_open_when_other_sessions_remain() {
        let (mut inner, state_path) = inner_with_settings(true, true);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        test_project(&mut inner, "b", r"C:\Work\B", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.sessions.insert("s2".into(), test_session("s2", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        let plan =
            expect_reassigned(resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\B")));
        assert!(
            plan.old_has_sessions,
            "another session still lives in the old project"
        );
        assert!(plan.open_projects_in_new_windows);
        assert_eq!(inner.sessions["s2"].metadata.project_id, "a", "the sibling session is untouched");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_reports_no_remaining_sessions_when_moving_the_last_one() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        test_project(&mut inner, "b", r"C:\Work\B", true);
        inner.sessions.insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        let plan =
            expect_reassigned(resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Work\B")));
        assert!(
            !plan.old_has_sessions,
            "the moved session was the last one in the old project"
        );
        fs::remove_file(state_path).expect("remove test state");
    }
}
