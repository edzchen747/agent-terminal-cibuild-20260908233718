use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::UdpSocket,
    path::{Path, PathBuf},
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
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;
use url::Url;
use uuid::Uuid;

use crate::{
    models::{
        AuthorizedDevice, ClientMessage, DesktopState, HostInfo, HostSnapshot, PROTOCOL_VERSION,
        PairingPayload, Project, RelayMessage, ServerMessage, ShellProfile, TerminalDataEvent,
        TerminalSession,
    },
    shells::{command_for, detect_shells},
    store::{DesktopStore, random_token},
    window_clients::WindowClients,
};

const MAX_SCROLLBACK_BYTES: usize = 512_000;
const MAX_CONTROL_BYTES: usize = 8_192;

struct ManagedSession {
    metadata: TerminalSession,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buffer: String,
    control_tail: String,
}

#[derive(Clone)]
pub enum ClientSink {
    Direct {
        messages: mpsc::UnboundedSender<String>,
        close: mpsc::UnboundedSender<()>,
    },
    Relay {
        connection_id: String,
    },
}

struct RemoteClient {
    device_id: Option<String>,
    attached_sessions: HashSet<String>,
    sink: ClientSink,
}

struct PairingGrant {
    expires_at_ms: i64,
}

struct Inner {
    store: DesktopStore,
    shells: Vec<ShellProfile>,
    temporary_projects: HashMap<String, Project>,
    sessions: HashMap<String, ManagedSession>,
    windows: WindowClients,
    pairing_grants: HashMap<String, PairingGrant>,
}

pub struct Core {
    app: AppHandle,
    inner: Mutex<Inner>,
    clients: Mutex<HashMap<String, RemoteClient>>,
    relay_sender: Mutex<Option<mpsc::UnboundedSender<RelayMessage>>>,
    remote_port: AtomicU16,
    direct_server_ready: AtomicBool,
    exit_requested: AtomicBool,
}

impl Core {
    pub fn new(app: AppHandle, store: DesktopStore) -> Arc<Self> {
        let remote_port = store.settings().port;
        Arc::new(Self {
            app,
            inner: Mutex::new(Inner {
                store,
                shells: detect_shells(),
                temporary_projects: HashMap::new(),
                sessions: HashMap::new(),
                windows: WindowClients::default(),
                pairing_grants: HashMap::new(),
            }),
            clients: Mutex::new(HashMap::new()),
            relay_sender: Mutex::new(None),
            remote_port: AtomicU16::new(remote_port),
            direct_server_ready: AtomicBool::new(false),
            exit_requested: AtomicBool::new(false),
        })
    }

    pub fn initialize(self: &Arc<Self>) -> Result<()> {
        let start_folder = std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let project = Project {
            id: format!("temporary-{}", Uuid::new_v4()),
            name: folder_name(&start_folder),
            path: start_folder.to_string_lossy().into_owned(),
            persistent: false,
            created_at: None,
        };
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner
                .temporary_projects
                .insert(project.id.clone(), project.clone());
        }
        self.create_session(&project.id, None)?;
        Ok(())
    }

    pub fn shutdown(&self) {
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
            match client.sink {
                ClientSink::Direct { close, .. } => {
                    let _ = close.send(());
                }
                ClientSink::Relay { connection_id } => {
                    if let Some(sender) = self
                        .relay_sender
                        .lock()
                        .expect("relay sender poisoned")
                        .as_ref()
                    {
                        let _ = sender.send(RelayMessage::Disconnect { connection_id });
                    }
                }
            }
        }
        self.set_relay_sender(None);
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

    pub fn request_exit(&self) {
        self.exit_requested.store(true, Ordering::Release);
    }

    pub fn exit_requested(&self) -> bool {
        self.exit_requested.load(Ordering::Acquire)
    }

    pub fn relay_endpoint(&self) -> Option<String> {
        let value = std::env::var("AGENT_TERMINAL_RELAY_URL")
            .ok()?
            .trim()
            .trim_end_matches('/')
            .to_string();
        if value.is_empty() {
            return None;
        }
        Some(if let Some(rest) = value.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if let Some(rest) = value.strip_prefix("https://") {
            format!("wss://{rest}")
        } else {
            value
        })
    }

    pub fn relay_identity(&self) -> (String, String) {
        let inner = self.inner.lock().expect("desktop state poisoned");
        let token = std::env::var("AGENT_TERMINAL_RELAY_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| inner.store.host().relay_token.clone());
        (inner.store.host().id.clone(), token)
    }

    pub fn state_for_window(&self, label: &str) -> DesktopState {
        let snapshot = self.snapshot();
        let current_project_id = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .project_for_window(label)
            .map(str::to_owned)
            .or_else(|| snapshot.projects.first().map(|project| project.id.clone()))
            .unwrap_or_default();
        DesktopState {
            snapshot,
            current_project_id,
        }
    }

    pub fn snapshot(&self) -> HostSnapshot {
        let inner = self.inner.lock().expect("desktop state poisoned");
        snapshot_from_inner(&inner)
    }

    pub fn broadcast(&self) {
        for (label, window) in self.app.webview_windows() {
            let _ = window.emit("desktop-state", self.state_for_window(&label));
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
            (
                inner.windows.last_or_any(),
                public_projects(&inner)
                    .first()
                    .map(|project| project.id.clone()),
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
        self.ensure_project_window_with_focus(project_id, true)
    }

    fn ensure_project_window_in_background(self: &Arc<Self>, project_id: &str) -> Result<()> {
        self.ensure_project_window_with_focus(project_id, false)
    }

    fn ensure_project_window_with_focus(
        self: &Arc<Self>,
        project_id: &str,
        focus: bool,
    ) -> Result<()> {
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

    pub fn open_project(self: &Arc<Self>, project_id: &str) -> Result<()> {
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
            self.ensure_project_window(project_id)?;
        }
        Ok(())
    }

    pub fn create_persistent_project(
        self: &Arc<Self>,
        name: &str,
        folder: &str,
    ) -> Result<Project> {
        let resolved = canonical_directory(folder)?;
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
                    name: if name.trim().is_empty() {
                        folder_name(&resolved)
                    } else {
                        name.trim().to_string()
                    },
                    path: resolved.to_string_lossy().into_owned(),
                    persistent: true,
                    created_at: Some(Utc::now().to_rfc3339()),
                };
                inner.store.save_project(project.clone())?;
                project
            }
        };
        if let Some(project_id) = persisted_existing {
            return self.set_project_persistence(&project_id, true);
        }
        self.broadcast();
        Ok(project)
    }

    pub fn set_project_persistence(&self, project_id: &str, persistent: bool) -> Result<Project> {
        let project = {
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
                inner
                    .temporary_projects
                    .insert(project_id.to_string(), project.clone());
            }
            project
        };
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
                },
            );
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

        self.ensure_project_window(&project.id)?;
        self.broadcast();
        Ok(metadata)
    }

    pub fn close_session(self: &Arc<Self>, session_id: &str) {
        let project_id = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(mut session) = inner.sessions.remove(session_id) else {
                return;
            };
            let _ = session.killer.kill();
            session.metadata.project_id
        };
        self.cleanup_empty_temporary_project(&project_id);
        self.broadcast();
    }

    pub fn write_session(&self, session_id: &str, data: &str) {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let Some(session) = inner.sessions.get_mut(session_id) else {
            return;
        };
        if session.metadata.status == "running" {
            let _ = session.writer.write_all(data.as_bytes());
            let _ = session.writer.flush();
        }
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16, force: bool) {
        let inner = self.inner.lock().expect("desktop state poisoned");
        let Some(session) = inner.sessions.get(session_id) else {
            return;
        };
        if session.metadata.status != "running" {
            return;
        }
        let cols = cols.clamp(2, 500);
        let rows = rows.clamp(1, 200);
        if force {
            let pulse_rows = if rows > 1 { rows - 1 } else { rows + 1 };
            let _ = session.master.resize(PtySize {
                rows: pulse_rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        let _ = session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn attach_window_session(&self, label: &str, session_id: &str) -> Result<String> {
        let mut inner = self.inner.lock().expect("desktop state poisoned");
        let buffer = inner
            .sessions
            .get(session_id)
            .map(|session| session.buffer.clone())
            .ok_or_else(|| anyhow!("Terminal session not found."))?;
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

    pub fn start_pairing(&self) -> Result<PairingPayload> {
        let relay = self.relay_endpoint();
        if relay.is_none() && !self.direct_server_ready.load(Ordering::Acquire) {
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
        Ok(PairingPayload {
            version: PROTOCOL_VERSION,
            host_id,
            host_name,
            endpoint: relay.clone().unwrap_or_else(|| {
                format!(
                    "ws://{}:{}",
                    local_address(),
                    self.remote_port.load(Ordering::Relaxed)
                )
            }),
            transport: if relay.is_some() {
                "relay".into()
            } else {
                "direct".into()
            },
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
                    attached_sessions: HashSet::new(),
                    sink: ClientSink::Direct { messages, close },
                },
            );
    }

    pub fn ensure_relay_client(&self, connection_id: &str) {
        let mut clients = self.clients.lock().expect("remote clients poisoned");
        clients
            .entry(connection_id.to_string())
            .or_insert_with(|| RemoteClient {
                device_id: None,
                attached_sessions: HashSet::new(),
                sink: ClientSink::Relay {
                    connection_id: connection_id.to_string(),
                },
            });
    }

    pub fn remove_client(&self, id: &str) {
        self.clients
            .lock()
            .expect("remote clients poisoned")
            .remove(id);
    }

    pub fn clear_relay_clients(&self) {
        self.clients
            .lock()
            .expect("remote clients poisoned")
            .retain(|_, client| !matches!(client.sink, ClientSink::Relay { .. }));
    }

    pub fn set_relay_sender(&self, sender: Option<mpsc::UnboundedSender<RelayMessage>>) {
        *self.relay_sender.lock().expect("relay sender poisoned") = sender;
    }

    pub fn handle_client_raw(self: &Arc<Self>, client_id: &str, raw: &str) {
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
                }
                self.send_to_client(
                    client_id,
                    ServerMessage::PairAccepted {
                        request_id,
                        device_token,
                        snapshot: self.snapshot(),
                    },
                );
                self.broadcast();
                return;
            }
            ClientMessage::Auth {
                request_id,
                device_id,
                device_token,
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
        match self.execute_client_message(message) {
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
                self.resize_session(&session_id, cols, rows, false);
                Some(ServerMessage::SessionBuffer {
                    request_id,
                    session_id: session_id.clone(),
                    data: self.session_buffer(&session_id),
                })
            }
            ClientMessage::SessionDetach { request_id, .. } => {
                Some(ServerMessage::Ok { request_id })
            }
            ClientMessage::SessionInput { session_id, data } => {
                self.write_session(&session_id, &data);
                None
            }
            ClientMessage::SessionResize {
                session_id,
                cols,
                rows,
                force,
            } => {
                self.resize_session(&session_id, cols, rows, force.unwrap_or(false));
                None
            }
            ClientMessage::Pair { .. } | ClientMessage::Auth { .. } => None,
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
            Some(ClientSink::Relay { connection_id }) => {
                if let Some(sender) = self
                    .relay_sender
                    .lock()
                    .expect("relay sender poisoned")
                    .as_ref()
                {
                    let _ = sender.send(RelayMessage::Message {
                        connection_id,
                        payload,
                    });
                }
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
            match client.sink {
                ClientSink::Direct { close, .. } => {
                    let _ = close.send(());
                }
                ClientSink::Relay { connection_id } => {
                    if let Some(sender) = self
                        .relay_sender
                        .lock()
                        .expect("relay sender poisoned")
                        .as_ref()
                    {
                        let _ = sender.send(RelayMessage::Disconnect { connection_id });
                    }
                }
            }
        }
    }

    fn on_terminal_data(self: &Arc<Self>, session_id: &str, data: String) {
        let (reported_cwd, window_clients) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            session.buffer.push_str(&data);
            truncate_front(&mut session.buffer, MAX_SCROLLBACK_BYTES);
            session.control_tail.push_str(&data);
            truncate_front(&mut session.control_tail, MAX_CONTROL_BYTES);
            let reported = parse_working_directories(&session.control_tail)
                .into_iter()
                .last()
                .filter(|cwd| {
                    normalize_text_path(cwd) != normalize_text_path(&session.metadata.cwd)
                });
            (reported, inner.windows.subscribers(session_id))
        };
        let event = TerminalDataEvent {
            session_id: session_id.to_string(),
            data: data.clone(),
        };
        for label in window_clients {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.emit("desktop-data", event.clone());
            }
        }
        self.send_terminal_output(session_id, &data);
        if let Some(cwd) = reported_cwd {
            self.handle_session_working_directory(session_id, &cwd);
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
        let (project, previous_project_id, active_window, displaced_window, old_has_sessions) = {
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
            let displaced_window = active_window
                .as_ref()
                .and_then(|label| inner.windows.assign(label, &project.id).displaced_window);
            let old_has_sessions = project_changed
                && inner
                    .sessions
                    .values()
                    .any(|session| session.metadata.project_id == current.project_id);
            (
                project,
                current.project_id,
                active_window,
                displaced_window,
                old_has_sessions,
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
                    if old_has_sessions {
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

fn snapshot_from_inner(inner: &Inner) -> HostSnapshot {
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
    HostSnapshot {
        host: HostInfo {
            id: inner.store.host().id.clone(),
            name: inner.store.host().name.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        projects: public_projects(inner),
        sessions: inner
            .sessions
            .values()
            .map(|session| session.metadata.clone())
            .collect(),
        devices: inner
            .store
            .devices()
            .iter()
            .map(|device| device.device.clone())
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
    projects.extend(
        inner
            .temporary_projects
            .values()
            .filter(|project| {
                active.contains(project.id.as_str()) || inner.windows.has_project(&project.id)
            })
            .cloned(),
    );
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
    Ok(resolved)
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

fn local_address() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr().map(|address| address.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
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

#[cfg(test)]
mod tests {
    use super::{
        PairingGrant, is_within_project, parse_working_directories, take_valid_pairing_grant,
    };
    use std::{collections::HashMap, path::Path};

    #[test]
    fn parses_windows_terminal_working_directory_reports() {
        let output = "before\x1b]9;9;C:\\Users\\edzch\\Project\x1b\\after\x1b]7;file:///C:/Users/edzch/Other%20Project\x07";
        assert_eq!(
            parse_working_directories(output),
            vec!["C:\\Users\\edzch\\Project", "C:/Users/edzch/Other Project"]
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
}
