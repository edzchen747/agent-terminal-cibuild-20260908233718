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

use crate::activity::{ActivityDetector, TUI_QUIET_MS, TUI_USER_ATTRIBUTION_MS};
use regex::Regex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;
use url::Url;
use uuid::Uuid;

use crate::{
    models::{
        AuthorizedDevice, ClientMessage, DesktopState, DirectoryEntry, DirectoryListing,
        FocusSessionEvent, HostInfo, HostSnapshot, PROTOCOL_VERSION, PairingPayload, Project,
        RemoteRegistration, ServerMessage, SessionActivity, SessionSegment, SessionSnapshot,
        ShellProfile, TaskbarProgress, TerminalActivityEvent, TerminalDataEvent, TerminalGridEvent,
        TerminalSession, TerminalTaskbarEvent, TerminalThemeSettings, TerminalTuiModeEvent,
        TuiMode, normalize_terminal_scheme_id,
    },
    network,
    path_utils::user_visible_path,
    provisioning,
    shells::{command_for, detect_shells},
    store::{DesktopStore, NetworkState, random_token},
    stream_opt::{
        MAX_MERGED_OUTPUT_BYTES, OUTPUT_MERGE_MAX_SPAN, OUTPUT_MERGE_WINDOW, StreamCompactor,
        take_decodable,
    },
    taskbar::SessionTaskbar,
    taskbar_engine::TaskbarEngine,
    tui::{ShellMarker, TuiClassifier},
    window_clients::WindowClients,
};

/// The PTY is spawned at this grid, then tracks the current OWNER's
/// announced viewport verbatim: the client that last claimed the session
/// (typed into it, clicked/tapped it, or explicitly opened it) fully owns
/// the PTY's dimensions, in every mode. Every other viewing client renders
/// that grid at whatever size fits its own container (scaled to fill,
/// never re-wrapped). Every change is journaled as a grid epoch (see
/// `GridEpoch`), so a later replay replays the raw stream 1:1.
pub(crate) const SESSION_DEFAULT_COLS: u16 = 120;
pub(crate) const SESSION_DEFAULT_ROWS: u16 = 30;
/// The largest grid a client may size the PTY to.
///
/// A bound, not a fit: it exists because a resize makes ConPTY redraw its
/// whole viewport, and because xterm allocates its scrollback per COLUMN, so
/// both the repaint every client has to receive and the client's buffer grow
/// with the grid's area. Sized to cover a fully zoomed-out pane on an
/// ultrawide display (a 3440px-wide window at the smallest zoom stop asks for
/// roughly 1460x460) with headroom, and no further.
///
/// Clients clamp their own announcements to the same numbers
/// (MAX_TERMINAL_COLS/ROWS in packages/protocol) so they can never propose a
/// grid this would silently rewrite; the clamp here is the backstop for a
/// client that does not, and the two are pinned together by
/// apps/desktop/src/renderer/src/grid-limits.test.ts.
const SESSION_MAX_COLS: u16 = 1600;
const SESSION_MAX_ROWS: u16 = 500;
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
/// Remote clients join a session's viewport set while they keep sending
/// anything within a small multiple of this interval (mirrors
/// VIEWPORT_KEEPALIVE_INTERVAL_MS in packages/protocol/src/index.ts). The
/// heartbeat doubles as the set-membership signal: a bare `ping` bumps
/// `last_seen` and nothing else.
const VIEWPORT_KEEPALIVE_INTERVAL_MS: u64 = 1_000;
/// A networked viewport whose last message is older than this is evicted from
/// S and the session's minimum boundary recomputed. Deliberately separate
/// from MOBILE_HEARTBEAT_INTERVAL_MS / PRESENCE_WINDOW_MS: sizing membership
/// is a 2-second concern, the green connectivity dot a 2-minute one.
const VIEWPORT_WATCHDOG_TIMEOUT_MS: u64 = 2_000;
/// Sweep cadence: half the keepalive interval, so a client that stops
/// pinging is evicted promptly after its watchdog window lapses.
const VIEWPORT_WATCHDOG_TICK_MS: u64 = VIEWPORT_KEEPALIVE_INTERVAL_MS / 2;
/// How often the host re-checks whether a session has gone idle. Idle is
/// a timeout - a session that stopped producing output produces no chunk
/// to notice it on - so it has to be swept for. The tick also releases
/// the deferred `Active` announcement (see `activity::ACTIVE_MIN_MS`),
/// which is why it is not slower than that delay.
const ACTIVITY_WATCHDOG_TICK_MS: u64 = 250;

// ---------------------------------------------------------------------------
// Terminal sync diagnostics (for debugging history parity between devices).
// Enable by setting AGENT_TERMINAL_SYNC_DEBUG=1 before starting the host. The
// log is written to %TEMP%/agent-terminal-sync.log and truncated at startup,
// with one timestamped line per journal append, resize/broadcast, attach,
// snapshot, and input point of interest. Lines in the `handoff` scope are
// written unconditionally: a console handoff with no window open has no
// console to surface a failure in, so the file is the only trace.
// ---------------------------------------------------------------------------

static SYNC_DEBUG_ENABLED: OnceLock<bool> = OnceLock::new();

pub(crate) fn sync_debug_enabled() -> bool {
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

pub(crate) fn sync_log_line(scope: &str, message: fmt::Arguments<'_>) {
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

/// Whether `data` is a Device Attributes reply - `ESC [ ? ... c` (primary)
/// or `ESC [ > ... c` (secondary), and nothing else.
fn is_device_attributes_report(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.len() < 4 || bytes[0] != 0x1b || bytes[1] != b'[' {
        return false;
    }
    let mut index = 2;
    if bytes[index] == b'?' || bytes[index] == b'>' {
        index += 1;
    } else {
        return false;
    }
    let start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_digit() || *byte == b';')
    {
        index += 1;
    }
    index > start && bytes.get(index) == Some(&b'c') && index + 1 == bytes.len()
}

/// Counts the queries the shell issued in one output chunk, including a
/// query split across the chunk boundary (`tail` carries the bytes needed to
/// recognize the leading half).
fn record_queries(tail: &mut String, data: &str, queries: &[&[u8]]) -> usize {
    let bytes = data.as_bytes();
    let mut found = 0;
    for query in queries {
        found += bytes
            .windows(query.len())
            .filter(|window| window == query)
            .count();
        found += usize::from((1..query.len()).any(|split| {
            tail.as_bytes().ends_with(&query[..split]) && bytes.starts_with(&query[split..])
        }));
    }
    let keep = queries.iter().map(|query| query.len()).max().unwrap_or(1) - 1;
    let combined = format!("{tail}{data}");
    *tail = combined
        .chars()
        .rev()
        .take(keep)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    found
}

fn record_cursor_position_requests(tail: &mut String, data: &str) -> usize {
    record_queries(tail, data, &[b"\x1b[6n", b"\x1b[?6n"])
}

/// Device Attributes queries: primary (`ESC [ c`, `ESC [ 0 c`), secondary
/// (`ESC [ > c`) and tertiary (`ESC [ = c`).
fn record_device_attribute_requests(tail: &mut String, data: &str) -> usize {
    record_queries(
        tail,
        data,
        &[
            b"\x1b[c",
            b"\x1b[0c",
            b"\x1b[>c",
            b"\x1b[>0c",
            b"\x1b[=c",
            b"\x1b[=0c",
        ],
    )
}

/// PTY input, kept off the desktop lock and off the UI thread.
///
/// A write into a pseudoconsole can block for as long as the console
/// declines to drain it - a handed-off console that has stopped reading its
/// input pipe never completes one at all. This write used to run inline, on
/// the main thread (`write_session` is a synchronous command), with the
/// desktop lock held, so a single wedged console froze every window and
/// every other session with it. Bytes now cross to a per-session thread
/// that owns the blocking half, and the caller returns immediately.
struct SessionWriter {
    bytes: std::sync::mpsc::SyncSender<Vec<u8>>,
}

impl SessionWriter {
    fn spawn(session_id: &str, mut writer: Box<dyn Write + Send>) -> Self {
        // Bounded: input nobody is consuming must not grow a queue. The
        // depth is a burst of paste-sized chunks, far more than a console
        // that is reading at all will ever leave outstanding.
        let (bytes, pending) = std::sync::mpsc::sync_channel::<Vec<u8>>(256);
        let session_id = session_id.to_owned();
        thread::Builder::new()
            .name("agent-terminal-pty-writer".into())
            .spawn(move || {
                while let Ok(chunk) = pending.recv() {
                    // Timed, because "the console stopped reading its input
                    // pipe" is otherwise invisible from this side: the write
                    // simply never returns.
                    let started = Instant::now();
                    let wrote = writer.write_all(&chunk).and_then(|()| writer.flush());
                    let elapsed = started.elapsed();
                    if elapsed > std::time::Duration::from_millis(500) {
                        sync_log!(
                            "input",
                            "slow write session={session_id} bytes={} took_ms={}",
                            chunk.len(),
                            elapsed.as_millis()
                        );
                    }
                    if wrote.is_err() {
                        sync_log!("input", "writer ended session={session_id}");
                        break;
                    }
                }
            })
            .ok();
        Self { bytes }
    }

    /// Queues one write. Never blocks: a full queue means the console has
    /// stopped reading, and dropping that session's input is strictly
    /// better than stalling a caller that holds the desktop lock.
    fn write(&self, session_id: &str, data: &str) {
        if self.bytes.try_send(data.as_bytes().to_vec()).is_err() {
            sync_log!(
                "input",
                "dropped session={session_id} bytes={} (console not reading)",
                data.len()
            );
        }
    }
}

struct ManagedSession {
    metadata: TerminalSession,
    master: Box<dyn MasterPty + Send>,
    writer: SessionWriter,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Current PTY grid (cols, rows): the current owner's announced
    /// viewport, verbatim (see `owner`).
    grid: (u16, u16),
    /// Every client currently displaying this session (the spec's set S),
    /// keyed by its stable identity so a reconnect on a new socket rebinds in
    /// place.
    viewports: HashMap<TerminalController, ClientViewport>,
    /// Which client's announced viewport the PTY grid currently tracks.
    /// Claimed by a real interaction (typed key, click, tap, or an explicit
    /// attach) - see `apply_owner_grid_for` - and otherwise inherited by the
    /// first client to announce into an ownerless session. `None` only when
    /// the session has never had a viewer, or its last owner departed with
    /// no survivor to hand the grid to.
    owner: Option<TerminalController>,
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
    /// A shell alt-screen entry (PSReadLine's Clear-Host) deferred its
    /// grid change: the classifier is Fullscreen and alt-anchored but
    /// the program has painted no TUI frame yet, so the PTY must not
    /// receive a SIGWINCH mid-shell-state. Cleared when paint evidence
    /// fires the deferred resize, or when the mode exits to canonical.
    deferred_tui_resize: bool,
    /// When the user's last keystroke was written to the PTY master. Output
    /// arriving within `TUI_USER_ATTRIBUTION_MS` of it is the screen
    /// *reacting* to the user, not the program working (see
    /// `output_is_user_driven`).
    last_user_input_at: Option<Instant>,
    /// When the PTY grid was last resized: a resize forces a redraw of the
    /// whole screen, and that redraw must not read as activity either.
    last_resize_at: Option<Instant>,
    /// The most recent grid target: the owning client's announced viewport,
    /// verbatim, in every mode - viewports are never combined across clients
    /// (see `apply_owner_grid_for`). Recorded even while the PTY is frozen,
    /// and applied to the PTY on the next alternate-screen entry so a freshly
    /// launched TUI opens at that grid.
    requested_viewport: Option<(u16, u16)>,
    /// Active/idle detection for this session, fed from the same
    /// classifier pass as the TUI mode.
    activity: ActivityDetector,
    /// The session's ConEmu `OSC 9;4` taskbar progress state machine
    /// (explicit program reports plus the shell's command lifecycle, and
    /// the running command's start time for the window's last-ran
    /// ordering); see `crate::taskbar`. Fed in the same stream pass as
    /// the activity detector.
    taskbar: SessionTaskbar,
    /// The host-persisted "come look" marker: the session's command just
    /// finished (its taskbar indicator moved non-clear to clear) and no
    /// client has viewed it since - the marker is never raised while a
    /// client is actively viewing the session, since that client is the
    /// look itself. A client that connects AFTER the edge
    /// reads it from the snapshot (`look_here_session_ids`) and raises
    /// its static-dot marker, the way a client that saw the live edge
    /// does. Cleared when a desktop window makes the session's tab its
    /// active tab, when a phone attaches (opens) the session, when a new
    /// command re-arms the indicator, or when the session exits.
    look_here: bool,
    control_tail: String,
    cursor_query_tail: String,
    pending_cursor_reports: usize,
    /// Outstanding Device Attributes queries, counted exactly like
    /// `pending_cursor_reports`: a replayed journal carries the shell's
    /// original `ESC [ c` with it, and the client answers it again on every
    /// remount. Without this the stale reply reaches the shell as typed
    /// input and lands at the prompt as `[?1;2c`.
    device_attributes_tail: String,
    pending_device_attributes: usize,
    has_run_command: bool,
}

/// One client's announced viewport in a session (the spec's set S member).
#[derive(Clone, Copy, Debug)]
struct ClientViewport {
    cols: u16,
    rows: u16,
    /// Last message from this client (including bare keepalive pings sent
    /// for OTHER sessions this device is also viewing). Networked clients
    /// are evicted after VIEWPORT_WATCHDOG_TIMEOUT; in-process desktop panes
    /// never expire (implicit 0 ms timeout) and are removed only on
    /// detach/window close.
    last_seen: Instant,
    /// Last time this client announced INTO THIS SESSION specifically (a
    /// resize, write, or attach) - never bumped by an unrelated keepalive
    /// ping. Used only to pick a successor when the owner departs: the
    /// survivor that was most recently showing this session takes over.
    last_active: Instant,
    networked: bool,
}

// `Ord` gives `reselect_owner_on_departure` a deterministic tiebreak when two
// viewports share the same `last_active` instant (the resolution of the
// underlying clock, or two announces landing in the same tick).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum TerminalController {
    Desktop(String),
    Remote(String),
}

/// Render an input write for the sync log: printable ASCII verbatim,
/// control characters as `\u{NN}` (or `\r`/`\n`/`\t`), truncated to
/// `max_chars` for readability.
fn log_escape(data: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, ch) in data.char_indices() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        match ch {
            c if c.is_ascii_graphic() || c == ' ' => out.push(c),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
        }
    }
    out
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
    /// Last per-device viewing set observed by the viewport watchdog, so a
    /// phone opening or closing a terminal broadcasts once.
    viewing_cache: Mutex<Option<HashMap<String, Vec<String>>>>,
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
    /// The console handoff waiting to be brought to the front, claimed by
    /// the renderer when it mounts. A window that the handoff opened has
    /// not finished loading its webview yet, and a window that already
    /// exists may still be loading it - in both cases the event emitted at
    /// handoff time goes nowhere, so the renderer claims this instead.
    pending_focus: Mutex<Option<PendingFocus>>,
    /// The COM thread that applies ConEmu `OSC 9;4` taskbar progress to
    /// the app's windows (see `taskbar_engine`).
    taskbar_engine: TaskbarEngine,
}

/// Claims `pending` for the window `label`, if it holds a focus meant for
/// that window and still inside its TTL. A claim clears the entry, so only
/// one window ever acts on a handoff; so does finding it expired, rather
/// than leaving a stale focus for the next window that happens to open.
fn claim_pending_focus(
    pending: &mut Option<PendingFocus>,
    label: &str,
) -> Option<FocusSessionEvent> {
    let expired = pending
        .as_ref()
        .is_some_and(|focus| focus.at.elapsed() >= PENDING_FOCUS_TTL);
    if expired {
        *pending = None;
        return None;
    }
    // The focus names the window it was recorded for; only that window may
    // act on it, so a later-unrelated window cannot be yanked onto a
    // stale tab.
    let claimable = pending.as_ref().is_some_and(|focus| focus.label == label);
    if !claimable {
        return None;
    }
    pending.take().map(|focus| FocusSessionEvent {
        project_id: focus.project_id,
        session_id: focus.session_id,
    })
}

/// Records `pending` as the handoff focus waiting for `label`, overwriting
/// any older entry: the newest console the user launched is the one they
/// are waiting to look at, so an unclaimed older focus must not pull the
/// window back to an older tab.
fn record_pending_focus(
    pending: &mut Option<PendingFocus>,
    label: &str,
    project_id: &str,
    session_id: &str,
) {
    *pending = Some(PendingFocus {
        label: label.to_owned(),
        project_id: project_id.to_owned(),
        session_id: session_id.to_owned(),
        at: Instant::now(),
    });
}

/// A handoff session that should be shown as soon as a window can show it.
struct PendingFocus {
    /// The window the focus was recorded for: the one that already showed
    /// the project, or the one the handoff just opened for it. The webview
    /// of either may still be loading, which is why the focus is claimed
    /// on mount rather than emitted live.
    label: String,
    project_id: String,
    session_id: String,
    at: Instant,
}

/// How long a pending focus stays claimable. Long enough to cover a cold
/// start (process launch, window creation, webview load), short enough that
/// a handoff nobody claimed cannot yank a much later window onto a stale
/// tab.
const PENDING_FOCUS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

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

/// Restores the native edge-resize behaviour on a freshly built window
/// (see edge_resize). These build sites can be reached from a worker
/// thread (async commands), and the WndProc subclass belongs on the thread
/// that dispatches the window's messages, so the attach is marshalled to
/// the main thread. Best effort: if the window is gone or the attach
/// fails, it simply keeps working without edge resizing.
fn install_edge_resize(app: &AppHandle, label: &str) {
    let for_thread = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = for_thread.get_webview_window(&label) {
            crate::edge_resize::install(&window);
        }
    });
}

impl Core {
    pub fn new(app: AppHandle, store: DesktopStore) -> Arc<Self> {
        if sync_debug_enabled() {
            let _ = fs::File::create(sync_log_path());
            sync_log_line(
                "boot",
                format_args!("sync debug log started for the host session"),
            );
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
            viewing_cache: Mutex::new(None),
            network_online: AtomicBool::new(true),
            pending_focus: Mutex::new(None),
            taskbar_engine: TaskbarEngine::start(),
        });
        core.spawn_presence_refresh();
        core.spawn_viewport_watchdog();
        core.spawn_activity_watchdog();
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
        let _ = self.ensure_project_window_with_focus(&project.id, true, None)?;
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
        // Clear every taskbar progress state the engine touched, and stop
        // the COM thread, so no spinner or bar survives the app exit.
        self.taskbar_engine.shutdown();
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
        if self.desktop_enrollment_running.load(Ordering::Acquire) {
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
        if let Err(error) = self.set_remote_registration("pending", None, network.enrolled, None) {
            eprintln!("Agent Terminal could not mark remote access as pending: {error:#}");
            return false;
        }
        self.broadcast();
        true
    }

    fn verify_remote_node(self: &Arc<Self>, force_restart: bool, retry_on_transient_failure: bool) {
        self.remote_verification_running
            .store(true, Ordering::Release);
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
                        Some(
                            "Remote connection registration failed. LAN access is still available."
                                .into(),
                        ),
                        true,
                        None,
                    );
                    core.remote_verification_running
                        .store(false, Ordering::Release);
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
                core.remote_verification_running
                    .store(false, Ordering::Release);
                core.broadcast();
                return;
            }

            match core.wait_for_embedded_node().await {
                Ok(node) => {
                    let _ = core.set_remote_registration("enrolled", None, true, Some(&node));
                    core.remote_verification_running
                        .store(false, Ordering::Release);
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
                            if let Err(retry_error) = core.start_desktop_enrollment(device_id, true)
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
                        eprintln!("Agent Terminal embedded network node did not resume: {error:#}");
                        let _ = core.set_remote_registration(
                            "failed",
                            Some("Remote connection registration failed. LAN access is still available.".into()),
                            true,
                            None,
                        );
                    }
                    core.remote_verification_running
                        .store(false, Ordering::Release);
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
            is_default_terminal: crate::default_terminal::is_default_terminal(),
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
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(
                    PRESENCE_REFRESH_INTERVAL_MS,
                ));
                core.refresh_online_presence();
            }
        });
    }

    fn refresh_online_presence(self: &Arc<Self>) {
        let online = self.online_device_ids();
        let mut cache = self.presence_cache.lock().expect("presence cache poisoned");
        if cache.as_ref() != Some(&online) {
            *cache = Some(online);
            drop(cache);
            self.broadcast();
        }
    }

    /// Viewport watchdog: every ~500 ms, evict networked viewports that
    /// stopped pinging (a backgrounded phone leaves set S within the
    /// timeout) and, if the evicted client owned a session's grid, hand it
    /// to the next most recently active survivor. Deliberately separate
    /// from the device-presence monitor: sizing membership is a 2-second
    /// concern, the green connectivity dot a 2-minute one.
    fn spawn_viewport_watchdog(self: &Arc<Self>) {
        let core = Arc::clone(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TICK_MS));
                core.sweep_stale_viewports();
            }
        });
    }

    fn spawn_activity_watchdog(self: &Arc<Self>) {
        let core = Arc::clone(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(ACTIVITY_WATCHDOG_TICK_MS));
                core.sweep_session_activity();
            }
        });
    }

    /// Re-evaluate every session's activity with no new bytes: this is
    /// where a command that has stopped producing output is finally
    /// called idle, and where an `Active` that has now lasted long enough
    /// to be worth showing is announced.
    /// The sweep's per-session activity pass: apply the quiet signals the
    /// session has earned since the last tick and sync every state the
    /// transition moves. A TUI screen that has had no *spontaneous*
    /// output for TUI_QUIET_MS no longer reads as active: user-driven
    /// repaints (keystroke reactions, resize redraws) never advanced the
    /// quiet clock, so they cannot keep the badge lit (see activity.rs
    /// for the Windows Terminal reference). Returns the new badge and its
    /// timestamp, plus the taskbar state when the transition moved the
    /// taskbar machine too - an idle command's implicit spinner goes
    /// clear, and the snapshot metadata must carry it: the grace
    /// transition runs outside the stream path, and every snapshot
    /// (desktop-state push, phone heartbeat) is built from that metadata,
    /// so a stale indeterminate state would resurrect a spinner on a
    /// quiet screen.
    fn sweep_session_activity_step(
        session: &mut ManagedSession,
        now: Instant,
        viewed: bool,
    ) -> Option<(SessionActivity, String, Option<TaskbarProgress>)> {
        let mode = session.metadata.tui_mode;
        let quiet_idle = session.tui.quiet_idle(now);
        let tui_quiet = session.tui.spontaneous_quiet_ms(now) >= TUI_QUIET_MS;
        let (activity, since) = session
            .activity
            .observe(&[], mode, quiet_idle, tui_quiet, false, false, now)?;
        session.metadata.activity = activity;
        session.metadata.activity_since = Some(since.clone());
        // The same transition moves the taskbar state machine: sync it
        // into the snapshot metadata as well (see the method docs).
        let taskbar = session
            .taskbar
            .on_activity(activity, now)
            .then(|| session.taskbar.effective());
        if let Some(taskbar) = &taskbar {
            session.metadata.taskbar = *taskbar;
            // And the "come look" marker moves with it: the finished
            // edge (the transition INTO the clear state) raises the
            // flag; a re-armed indicator would lower it, and the sweep
            // only clears the badge, so in practice it only ever raises
            // here - and only for a session no client is viewing (a
            // viewer is the look the marker exists for). (The sweep's
            // own broadcast carries the change.)
            move_look_here(session, *taskbar, viewed);
        }
        Some((activity, since, taskbar))
    }

    fn sweep_session_activity(self: &Arc<Self>) {
        let changed = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let now = Instant::now();
            // The "come look" marker is not raised for a session a
            // client is actively viewing (see `viewed_session_ids`):
            // the client looking at it is the look itself, so a command
            // finishing there earns no marker. Computed up front, while
            // `inner` is still unborrowed, so the per-session steps need
            // no shared borrow of `inner` while its sessions are
            // borrowed out.
            let viewed = viewed_session_ids(&inner);
            let mut changed = Vec::new();
            for session in inner.sessions.values_mut() {
                if session.metadata.status != "running" {
                    continue;
                }
                if let Some((activity, since, taskbar)) = Self::sweep_session_activity_step(
                    session,
                    now,
                    viewed.contains(&session.metadata.id),
                ) {
                    changed.push((
                        session.metadata.id.clone(),
                        activity,
                        since,
                        session.metadata.project_id.clone(),
                        taskbar,
                    ));
                }
            }
            changed
        };
        if changed.is_empty() {
            return;
        }
        for (session_id, activity, since, project_id, taskbar) in changed {
            self.broadcast_activity(&session_id, activity, &since);
            if let Some(taskbar) = taskbar {
                self.broadcast_taskbar(&session_id, taskbar);
                self.update_window_taskbar(&project_id);
            }
        }
        // The snapshot carries `activity` too, so a window that opens (or a
        // phone that reconnects) mid-command starts with the right badge.
        self.broadcast();
    }

    fn sweep_stale_viewports(self: &Arc<Self>) {
        let mut changed = Vec::new();
        let viewing = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let now = Instant::now();
            for session in inner.sessions.values_mut() {
                let evicted = evict_stale_viewports(
                    session,
                    now,
                    std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS),
                );
                if evicted.is_empty() {
                    continue;
                }
                if let Some(epoch) = reselect_owner_on_departure(session, &evicted) {
                    sync_log!(
                        "grid",
                        "watchdog evicted for session={} new={}x{} at_offset={}",
                        session.metadata.id,
                        epoch.cols,
                        epoch.rows,
                        epoch.offset
                    );
                    changed.push((session.metadata.id.clone(), epoch));
                }
            }
            viewing_sessions_by_device(&inner)
        };
        for (session_id, epoch) in changed {
            self.broadcast_grid_change(&session_id, epoch);
        }
        self.publish_viewing_change(viewing);
    }

    /// The status bar names which terminal each connected device has open, so
    /// a device joining or leaving a session's viewport set is state the
    /// clients need within a watchdog tick - far sooner than the presence
    /// refresher's minutes-scale sweep. Broadcast only on an actual change so
    /// an idle host stays quiet.
    fn publish_viewing_change(&self, viewing: HashMap<String, Vec<String>>) {
        let mut cache = self.viewing_cache.lock().expect("viewing cache poisoned");
        if cache.as_ref() == Some(&viewing) {
            return;
        }
        *cache = Some(viewing);
        drop(cache);
        self.broadcast();
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

    /// Records the session the window is actively showing (its active tab),
    /// or clears the window's entry when it shows no tab. The phone's
    /// "come look" markers reset against this set - a terminal the desktop
    /// actually opened, not merely a background tab - so the snapshot
    /// carries the active tabs, not the attachment sets. Broadcast: a
    /// phone should drop its marker the moment the user opens the tab on
    /// the desktop, not on the next heartbeat.
    pub fn set_active_session(&self, label: &str, session_id: Option<String>) {
        let look_here_session = session_id.clone();
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.windows.set_active_session(label, session_id);
            // A window's active tab is a look at the session: its
            // "come look" marker dies (and the snapshot's field with it).
            if let Some(session_id) = &look_here_session {
                clear_session_look_here(&mut inner, session_id);
            }
        }
        self.broadcast();
    }

    pub fn unregister_window(&self, label: &str) {
        let project_id = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .remove_window(label);
        // A destroyed window can no longer detach its sessions one by one:
        // drop every Desktop viewport for this label and hand ownership of
        // any session it owned to the next most recently active survivor.
        let mut changed = Vec::new();
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let controller = TerminalController::Desktop(label.to_string());
            for session in inner.sessions.values_mut() {
                let removed = session.viewports.remove(&controller);
                if removed.is_some()
                    && let Some(epoch) =
                        reselect_owner_on_departure(session, std::slice::from_ref(&controller))
                {
                    changed.push((session.metadata.id.clone(), epoch));
                }
            }
        }
        for (session_id, epoch) in changed {
            self.broadcast_grid_change(&session_id, epoch);
        }
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

    pub fn ensure_project_window(self: &Arc<Self>, project_id: &str) -> Result<String> {
        self.ensure_project_window_with_focus(project_id, true, None)
    }

    fn ensure_project_window_in_background(self: &Arc<Self>, project_id: &str) -> Result<String> {
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
                // Undecorated: the renderer paints its own title bar with the
                // traffic-light window controls (see WindowControls).
                .decorations(false)
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
        // The window is undecorated, so restore the native edge-resize
        // handle it lost (see edge_resize). The subclass is attached on the
        // main thread, where the window's messages are dispatched.
        install_edge_resize(&self.app, &label);
        window.show()?;
        // The window's taskbar button inherits the project's live state.
        self.update_window_taskbar(&project.id);
        Ok(())
    }

    /// Records the handoff to bring forward, for a renderer that is not
    /// listening yet. Overwrites any older entry: the newest console the
    /// user launched is the one they are waiting to look at.
    fn set_pending_focus(&self, label: &str, project_id: &str, session_id: &str) {
        record_pending_focus(
            &mut self.pending_focus.lock().expect("pending focus poisoned"),
            label,
            project_id,
            session_id,
        );
    }

    /// Claims the pending handoff focus for `label`, if it is for this
    /// window and still fresh. Claiming clears it, so only one window acts.
    pub fn take_pending_focus(&self, label: &str) -> Option<FocusSessionEvent> {
        claim_pending_focus(
            &mut self.pending_focus.lock().expect("pending focus poisoned"),
            label,
        )
    }

    /// The window a handed-off console should surface in: the one already
    /// showing its project, otherwise whichever window is in front.
    /// `None` when no window is open at all — the handoff path then opens
    /// one, shown and focused, so the console the user launched lands on
    /// screen.
    fn handoff_window(self: &Arc<Self>, project_id: &str) -> Option<String> {
        self.inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .handoff_target(project_id)
    }

    /// Ensures the project owns a window on screen, taking focus when
    /// asked. Single-window mode reassigns the preferred window (or the
    /// last-used one) to the project and destroys whatever that displaces;
    /// multi-window mode reuses the project's own window when it has one
    /// and opens a new window otherwise. Returns the label of the window
    /// that ends up showing the project.
    fn ensure_project_window_with_focus(
        self: &Arc<Self>,
        project_id: &str,
        focus: bool,
        preferred_window: Option<&str>,
    ) -> Result<String> {
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
                // A reassigned or newly surfaced window inherits the
                // project's live taskbar state (a running or failed
                // command's indicator must not die with the old window).
                self.update_window_taskbar(&project.id);
                self.broadcast();
                return Ok(label);
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
            // The window's taskbar button inherits the project's live
            // state (it may have been rebuilt after a destroy).
            self.update_window_taskbar(project_id);
            return Ok(label);
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
                // Undecorated: the renderer paints its own title bar with the
                // traffic-light window controls (see WindowControls).
                .decorations(false)
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
        // The window is undecorated, so restore the native edge-resize
        // handle it lost (see edge_resize). The subclass is attached on the
        // main thread, where the window's messages are dispatched.
        install_edge_resize(&self.app, &label);
        if !focus {
            window.show()?;
        }
        if focus {
            window.set_focus()?;
        }
        // A fresh window's taskbar button inherits the project's live
        // state (a running or failed command's indicator).
        self.update_window_taskbar(&project.id);
        Ok(label)
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
        let _ = self.ensure_project_window_with_focus(project_id, true, preferred_window)?;
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

    /// How many terminal tabs are open, and how many of those are
    /// running something. Open includes a tab kept for inspection after
    /// its shell exited non-zero; that tab can never be busy. The tray's
    /// session label reports both.
    pub fn session_counts(&self) -> (usize, usize) {
        let inner = self.inner.lock().expect("desktop state poisoned");
        (active_session_count(&inner), open_session_count(&inner))
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

        // The PTY starts at a default grid and tracks the minimum boundary
        // over the clients viewing the session afterwards: whichever device
        // is the narrowest/shortest defines the shared grid, and every
        // client renders it exactly, letterboxing the surplus. History stays
        // exact across these grid switches because every change is
        // journaled as an epoch and every emulator replays the same stream
        // at the same grid sequence.
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
        let reader = pair.master.try_clone_reader()?;
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
            activity: SessionActivity::Idle,
            activity_since: None,
            taskbar: TaskbarProgress::Clear,
        };
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.sessions.insert(
                id.clone(),
                ManagedSession {
                    metadata: metadata.clone(),
                    master: pair.master,
                    writer: SessionWriter::spawn(&id, writer),
                    killer,
                    grid: (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
                    viewports: HashMap::new(),
                    owner: None,
                    grid_epochs: vec![GridEpoch {
                        offset: 0,
                        cols: SESSION_DEFAULT_COLS,
                        rows: SESSION_DEFAULT_ROWS,
                    }],
                    buffer: String::new(),
                    journal_len: 0,
                    tui: TuiClassifier::new(SESSION_DEFAULT_ROWS),
                    synthetic_alt: false,
                    deferred_tui_resize: false,
                    last_user_input_at: None,
                    last_resize_at: None,
                    requested_viewport: None,
                    activity: ActivityDetector::new(Instant::now()),
                    taskbar: SessionTaskbar::new(),
                    look_here: false,
                    control_tail: String::new(),
                    cursor_query_tail: String::new(),
                    pending_cursor_reports: 0,
                    device_attributes_tail: String::new(),
                    pending_device_attributes: 0,
                    has_run_command: false,
                },
            );
            inner.session_order.push(id.clone());
        }

        // The PTY reader hands raw reads straight to a merge thread. ConPTY
        // delivers a repainting TUI as a burst of tiny writes - often one per
        // escape sequence - and each of those would otherwise become its own
        // journal append, Tauri event and WebSocket frame.
        self.spawn_session_reader(&id, reader);
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

    /// The session output pipeline, shared by spawned and ConPTY-handoff
    /// sessions: a raw PTY reader feeding a merge thread that coalesces
    /// ConPTY's burst of tiny writes before they are journaled.
    fn spawn_session_reader(
        self: &Arc<Self>,
        session_id: &str,
        mut reader: Box<dyn std::io::Read + Send>,
    ) {
        // Bounded, so a session whose output nobody can keep up with pushes
        // back on the PTY exactly as it did when the reader appended inline,
        // instead of growing a queue.
        let (raw_tx, raw_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
        thread::spawn(move || {
            let mut bytes = vec![0_u8; 16_384];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if raw_tx.send(bytes[..size].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let reader_core = Arc::clone(self);
        let reader_id = session_id.to_owned();
        thread::spawn(move || {
            let mut compactor = StreamCompactor::new();
            let mut buffered: Vec<u8> = Vec::new();
            while let Ok(chunk) = raw_rx.recv() {
                buffered.extend_from_slice(&chunk);
                // Merge whatever else arrives over the next couple of
                // milliseconds into the same chunk. Bounded by both a total
                // span and a size: output waiting here has no journal offset
                // yet, and a resize landing in the gap would record its grid
                // epoch ahead of bytes the program drew at the previous grid.
                let deadline = Instant::now() + OUTPUT_MERGE_MAX_SPAN;
                while buffered.len() < MAX_MERGED_OUTPUT_BYTES {
                    let wait =
                        OUTPUT_MERGE_WINDOW.min(deadline.saturating_duration_since(Instant::now()));
                    if wait.is_zero() {
                        break;
                    }
                    match raw_rx.recv_timeout(wait) {
                        Ok(next) => buffered.extend_from_slice(&next),
                        Err(_) => break,
                    }
                }
                let text = take_decodable(&mut buffered);
                if text.is_empty() {
                    continue;
                }
                let payload = compactor.compact(&text);
                if !payload.is_empty() {
                    reader_core.on_terminal_data(&reader_id, payload);
                }
            }
            // End of stream: nothing more is coming, so anything held back (a
            // half-received escape sequence, an undecodable trailing byte) is
            // emitted as-is rather than swallowed.
            let mut tail = compactor.flush();
            tail.push_str(&String::from_utf8_lossy(&buffered));
            if !tail.is_empty() {
                reader_core.on_terminal_data(&reader_id, tail);
            }
        });
    }

    /// Opens a session from a ConPTY handoff: the console that hosts the new
    /// process (cmd, pwsh, …) asked us to take over its terminal UI, so the
    /// "child" of this session is an existing process and the data path is
    /// the pipe we handed back plus the packed ConPTY control handle.
    #[cfg(windows)]
    pub fn create_handoff_session(
        self: &Arc<Self>,
        handoff: crate::default_terminal::HandoffSession,
    ) -> Result<TerminalSession> {
        let (project, shell) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            // A handed-off console belongs with the project it was launched
            // inside; only fall back to the startup project when the
            // directory matches nothing the user has open.
            let project = match handoff.cwd.as_deref() {
                Some(cwd) => match project_for_directory(&inner, cwd) {
                    Some(project) => project,
                    // A console started from the Start menu, the Run box or
                    // the taskbar inherits Explorer's working directory,
                    // which is the system directory - not somewhere the user
                    // is working. Opening a "System32" project for it is
                    // noise. Home is where such a shell effectively belongs
                    // (and where one launched from the user's own folder
                    // lands), so it shares that project rather than dropping
                    // into whichever project happens to be first.
                    None if is_system_directory(cwd) => ensure_home_project(&mut inner)?,
                    // Nothing the user has open owns this directory, so give
                    // the console a project of its own rather than filing it
                    // under an unrelated one.
                    None => ensure_directory_project(&mut inner, Path::new(cwd))?,
                },
                None => startup_project(&mut inner)?,
            };
            let wanted = inner.store.settings().default_shell_id.as_str();
            let shell = inner
                .shells
                .iter()
                .find(|shell| shell.id == wanted)
                .or_else(|| inner.shells.first())
                .cloned()
                .ok_or_else(|| anyhow!("No supported shell was found."))?;
            (project, shell)
        };
        let id = Uuid::new_v4().to_string();
        let metadata = TerminalSession {
            id: id.clone(),
            project_id: project.id.clone(),
            title: handoff.title.clone(),
            // Where the console was actually launched, when the client
            // process would tell us; the project path is the fallback.
            cwd: handoff.cwd.clone().unwrap_or_else(|| project.path.clone()),
            shell_id: shell.id.clone(),
            status: "running".into(),
            created_at: Utc::now().to_rfc3339(),
            exit_code: None,
            tui_mode: TuiMode::Canonical,
            activity: SessionActivity::Idle,
            activity_since: None,
            taskbar: TaskbarProgress::Clear,
        };
        let master = crate::default_terminal::build_handoff_master(
            handoff.reader,
            handoff.writer,
            handoff.hpc,
            PtySize {
                rows: SESSION_DEFAULT_ROWS,
                cols: SESSION_DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            },
        );
        let reader = master.try_clone_reader()?;
        let writer = master.take_writer()?;
        let killer = crate::default_terminal::HandoffKiller::new(handoff.client, handoff.hpc);
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.sessions.insert(
                id.clone(),
                ManagedSession {
                    metadata: metadata.clone(),
                    master: Box::new(master),
                    writer: SessionWriter::spawn(&id, writer),
                    killer: Box::new(killer),
                    grid: (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
                    viewports: HashMap::new(),
                    owner: None,
                    grid_epochs: vec![GridEpoch {
                        offset: 0,
                        cols: SESSION_DEFAULT_COLS,
                        rows: SESSION_DEFAULT_ROWS,
                    }],
                    buffer: String::new(),
                    journal_len: 0,
                    tui: TuiClassifier::new(SESSION_DEFAULT_ROWS),
                    synthetic_alt: false,
                    deferred_tui_resize: false,
                    last_user_input_at: None,
                    last_resize_at: None,
                    requested_viewport: None,
                    activity: ActivityDetector::new(Instant::now()),
                    taskbar: SessionTaskbar::new(),
                    look_here: false,
                    control_tail: String::new(),
                    cursor_query_tail: String::new(),
                    pending_cursor_reports: 0,
                    device_attributes_tail: String::new(),
                    pending_device_attributes: 0,
                    has_run_command: false,
                },
            );
            inner.session_order.push(id.clone());
        }
        self.spawn_session_reader(&id, reader);
        // The console exits when its client does, which ends the ConPTY and
        // this session; report the client's exit code so a non-zero end
        // keeps the tab for inspection, exactly like a spawned shell.
        let waiter_core = Arc::clone(self);
        let waiter_id = id.clone();
        let client_wait = handoff.client_wait as isize;
        thread::spawn(move || {
            let status = crate::default_terminal::wait_client_exit(client_wait);
            waiter_core.on_terminal_exit(&waiter_id, status);
        });
        sync_log!(
            "session",
            "created handoff id={id} project={} path={} title={} cwd={} from_client={}",
            project.id,
            project.path,
            handoff.title,
            metadata.cwd,
            handoff.cwd.is_some()
        );
        self.broadcast();
        // A handoff is the user launching a console, so it has to end up in
        // front: raise a window, then tell the renderer to open the console's
        // project and select its tab.
        //
        // The renderer owns the project switch deliberately — it drives it
        // through the same `open_project` command a sidebar click uses.
        // Switching a window's project from here deadlocks: the switch
        // re-attaches every session in the window while the desktop lock is
        // held. This side only ever raises a window, and does it on a worker
        // because the RPC thread has to return to the console promptly.
        let window_core = Arc::clone(self);
        let window_project = project.id.clone();
        let window_session = id.clone();
        std::thread::spawn(move || {
            // A console the user launched has to end up on screen. A
            // window that is open gets raised; when none is open - they
            // were all closed and the app keeps running from the tray -
            // open one for the console's project, shown and focused.
            // (The phone's "New terminal" deliberately does not do this:
            // its sessions land in a quiet background window that never
            // pulls the desktop forward, see `ensure_project_window_quietly`.)
            let label = match window_core.handoff_window(&window_project) {
                Some(label) => {
                    sync_log_line(
                        "handoff",
                        format_args!("surfacing the handoff in the open window {label}"),
                    );
                    // Record before raising anything: a window that exists
                    // may still be loading its webview, so the emit below
                    // goes nowhere and the renderer claims this instead
                    // when it mounts.
                    window_core.set_pending_focus(&label, &window_project, &window_session);
                    label
                }
                None => {
                    // No window is registered: opening the console has
                    // given the app nothing to show it in, so give it one.
                    sync_log_line(
                        "handoff",
                        format_args!(
                            "no window is open; opening one for the handoff (project {window_project})"
                        ),
                    );
                    let label = match window_core.ensure_project_window(&window_project) {
                        Ok(label) => {
                            sync_log_line(
                                "handoff",
                                format_args!("opened window {label} for the handoff"),
                            );
                            label
                        }
                        Err(error) => {
                            // Unconditional: with no window open there is no
                            // console to show the error in, and the tray has
                            // no error UI - the sync log is the only trace.
                            sync_log_line(
                                "handoff",
                                format_args!("could not open a window for the handoff: {error}"),
                            );
                            eprintln!(
                                "agent-terminal: could not open a window for the handed-off console: {error}"
                            );
                            return;
                        }
                    };
                    // The fresh webview is not listening yet, so the emit
                    // below goes nowhere; the renderer claims this when
                    // it mounts.
                    window_core.set_pending_focus(&label, &window_project, &window_session);
                    label
                }
            };
            if let Some(window) = window_core.app.get_webview_window(&label) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                window_core.mark_window_focused(&label);
            } else {
                // The label came from a registered window (or from
                // `ensure_project_window`, which registers before it
                // builds); a miss means the window was destroyed in the
                // meantime. The recorded focus still lets a later window
                // claim the handoff within its TTL.
                sync_log_line(
                    "handoff",
                    format_args!("window {label} was gone before the handoff could raise it"),
                );
            }
            let _ = window_core.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-focus-session",
                FocusSessionEvent {
                    project_id: window_project,
                    session_id: window_session,
                },
            );
        });
        Ok(metadata)
    }

    pub fn close_session(self: &Arc<Self>, session_id: &str) {
        let project_id = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            match close_session_in_inner(&mut inner, session_id, true) {
                Some(project_id) => project_id,
                // The tab was already closed; no state change, no retire,
                // no broadcast.
                None => return,
            }
        };
        self.cleanup_empty_temporary_project(&project_id);
        // The closed session's taskbar state is gone with it, so re-push
        // the window's combined state for whatever is left.
        self.update_window_taskbar(&project_id);
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
        let (grid_changed, activity_change) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            if session.metadata.status != "running" {
                return;
            }
            let mut activity_change = None;

            // The grid the PTY actually ended up on, if this write moved it.
            // Read from the apply call rather than re-derived from the epoch
            // list: consecutive resizes are coalesced there, so "the last
            // epoch sits at the current offset" no longer means this write
            // was the one that changed the grid.
            let mut applied_grid: Option<GridEpoch> = None;

            // A CPR is valid only as a response to a live query emitted by the
            // shell. Replayed PTY history and duplicate xterm responses otherwise
            // arrive on the same input stream as typed keys; PSReadLine interprets
            // those stale reports as an editing key and rings the bell.
            if is_cursor_position_report(data) {
                if session.pending_cursor_reports == 0 {
                    return;
                }
                session.pending_cursor_reports -= 1;
            } else if is_device_attributes_report(data) {
                // Same rule as a CPR: valid only as the answer to a query the
                // shell actually issued. A replay re-answers the query that
                // is still sitting in the journal.
                if session.pending_device_attributes == 0 {
                    sync_log!(
                        "input",
                        "dropped stale device-attributes reply session={session_id}"
                    );
                    return;
                }
                session.pending_device_attributes -= 1;
            } else {
                // The size hint refreshes the writer's viewport entry (the
                // pane's announced W_i x H_i). Typing is always an interaction:
                // it claims the PTY grid for the sender, in every mode.
                if let Some((cols, rows)) = size {
                    set_client_viewport(session, controller.clone(), cols, rows);
                    applied_grid = apply_owner_grid_for(session, &controller, cols, rows, true);
                }
            }
            sync_log!(
                "input",
                "session={session_id} controller={controller:?} bytes={} grid_hint={:?} data={}",
                data.len(),
                size,
                log_escape(data, 48),
            );

            if data.contains('\r') || data.contains('\n') {
                session.has_run_command = true;
                // A submitted line is a command start in a canonical
                // shell. The detector suppresses it inside a TUI period,
                // where the line belongs to the foreground program (a
                // menu selection, a composer submit), not to a shell.
                if let Some((activity, since)) = session.activity.on_input_line(Instant::now()) {
                    session.metadata.activity = activity;
                    session.metadata.activity_since = Some(since.clone());
                    activity_change = Some((activity, since));
                }
            }
            // Every byte the user types arms the user-attribution window:
            // output the screen produces within TUI_USER_ATTRIBUTION_MS of
            // it is a reaction to the user, not the program working.
            session.last_user_input_at = Some(Instant::now());
            session.writer.write(session_id, data);

            (applied_grid, activity_change)
        };
        if let Some((activity, since)) = activity_change {
            self.broadcast_activity(session_id, activity, &since);
            self.broadcast();
        }
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

    /// Grid ownership: the PTY tracks the current owner's announced viewport
    /// verbatim, in every mode (see `apply_owner_grid_for`). `claim` is set
    /// only on a real interaction (a forced/tap-or-click-driven announce);
    /// a plain layout resize from a non-owner is recorded but never takes
    /// the grid over.
    fn resize_session_from(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        controller: TerminalController,
        claim: bool,
    ) {
        let epoch = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            if session.metadata.status != "running" {
                return;
            }
            set_client_viewport(session, controller.clone(), cols, rows);
            apply_owner_grid_for(session, &controller, cols, rows, claim)
        };
        sync_log!(
            "grid",
            "request session={session_id} controller={controller:?} wanted={cols}x{rows} claim={claim} applied={}",
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
        claim: bool,
    ) {
        self.resize_session_from(
            session_id,
            cols,
            rows,
            TerminalController::Desktop(window_label.to_string()),
            claim,
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

    /// Sizing identity for a remote socket: the paired device when
    /// authenticated, otherwise the connection id. A device reconnecting on a
    /// new socket lands on the same key, so its viewport entry is replaced
    /// atomically - the stale entry's watchdog is moot and no redundant
    /// SIGWINCH is issued.
    fn remote_sizing_key(&self, client_id: &str) -> String {
        self.clients
            .lock()
            .expect("remote clients poisoned")
            .get(client_id)
            .and_then(|client| client.device_id.clone())
            .unwrap_or_else(|| client_id.to_string())
    }

    fn write_remote_session(
        &self,
        client_id: &str,
        session_id: &str,
        data: &str,
        size: Option<(u16, u16)>,
    ) {
        let key = self.remote_sizing_key(client_id);
        self.write_session_from(session_id, data, TerminalController::Remote(key), size);
    }

    fn resize_remote_session(
        &self,
        client_id: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
        claim: bool,
    ) {
        let key = self.remote_sizing_key(client_id);
        self.resize_session_from(
            session_id,
            cols,
            rows,
            TerminalController::Remote(key),
            claim,
        );
    }

    /// Viewport registration for a remote client's attach - a claimed attach
    /// only (see `attach_owner_grid_for`); the desktop counterpart is
    /// `attach_window_session`.
    fn attach_remote_session(
        &self,
        client_id: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
        claim: bool,
    ) {
        let key = self.remote_sizing_key(client_id);
        let controller = TerminalController::Remote(key);
        let (epoch, look_here_cleared) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            let epoch = attach_owner_grid_for(session, &controller, cols, rows, claim);
            // The phone just opened this terminal: its "come look" marker
            // dies, and every client's marker for it (the snapshot's
            // field is the source they seed from).
            let look_here_cleared = clear_session_look_here(&mut inner, session_id);
            (epoch, look_here_cleared)
        };
        if let Some(epoch) = epoch {
            self.broadcast_grid_change(session_id, epoch);
        }
        if look_here_cleared {
            self.broadcast();
        }
    }

    /// Leave set S, whether or not the stream itself is also being left:
    /// shared by `session.detach` (which additionally drops the device from
    /// `attached_sessions` - see the dispatch bookkeeping) and
    /// `session.viewport.release` (which does not, so the device keeps
    /// receiving output).
    fn release_remote_controller(&self, client_id: &str, session_id: &str) {
        let key = self.remote_sizing_key(client_id);
        let controller = TerminalController::Remote(key);
        let epoch = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            release_viewport(session, &controller)
        };
        if let Some(epoch) = epoch {
            self.broadcast_grid_change(session_id, epoch);
        }
    }

    pub fn attach_window_session(
        &self,
        label: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
        claim: bool,
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
            // A claimed attach (the pane was the active tab at mount) joins
            // set S and takes ownership at once; an unclaimed attach (a
            // background or hidden tab) is a pure stream subscription - it
            // must never steal the grid from whichever client is actually
            // in use (see `attach_owner_grid_for`).
            Some(session) => {
                let controller = TerminalController::Desktop(label.to_string());
                let epoch = attach_owner_grid_for(session, &controller, cols, rows, claim);
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
            "desktop window={label} session={session_id} grid={cols}x{rows} claim={claim} resized={} segments={} end_offset={}",
            epoch.is_some(),
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
        let controller = TerminalController::Desktop(label.to_string());
        let epoch = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            release_viewport(session, &controller)
        };
        if let Some(epoch) = epoch {
            self.broadcast_grid_change(session_id, epoch);
        }
    }

    /// Leave set S without leaving the stream: a hidden desktop tab (its
    /// pane stays mounted and subscribed - see `TerminalPane.tsx`) sends
    /// this instead of detaching, so switching back needs no journal
    /// replay. Unlike `detach_window_session`, the window's subscriber
    /// entry (`windows.attach`/`.detach`) is left untouched.
    pub fn release_window_viewport(&self, label: &str, session_id: &str) {
        let controller = TerminalController::Desktop(label.to_string());
        let epoch = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let Some(session) = inner.sessions.get_mut(session_id) else {
                return;
            };
            release_viewport(session, &controller)
        };
        if let Some(epoch) = epoch {
            self.broadcast_grid_change(session_id, epoch);
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
    /// reclassified the session's TUI mode at this stream offset.
    /// Fullscreen clients own the PTY grid (strict cell grid, no reflow
    /// heuristics); canonical clients render the journal as their own
    /// viewport.
    /// Announce a session's active/idle change to every client watching
    /// it. Modelled on `broadcast_tui_mode`, minus the stream offset: idle
    /// is discovered by a timeout, so there is no byte position to anchor
    /// it to.
    fn broadcast_activity(&self, session_id: &str, activity: SessionActivity, since: &str) {
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
                ServerMessage::SessionActivityChanged {
                    session_id: session_id.to_string(),
                    activity,
                    since: since.to_string(),
                },
            );
        }
        let event = TerminalActivityEvent {
            session_id: session_id.to_string(),
            activity,
            since: since.to_string(),
        };
        let windows = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .subscribers(session_id);
        sync_log!(
            "activity",
            "broadcast session={session_id} activity={activity:?} clients={}",
            targets.len()
        );
        for label in windows {
            let _ = self.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-activity",
                event.clone(),
            );
        }
    }

    /// Broadcasts the session's ConEmu `OSC 9;4` taskbar state to every
    /// remote client and to the desktop windows that subscribe to it.
    /// Unlike the activity broadcast this is not gated on attachment: a
    /// phone's tabs view renders progress for sessions it has not opened,
    /// and it must see the running-to-clear edge live to raise the
    /// "come look" marker - a heartbeat snapshot alone only carries the
    /// state if the whole transition happened to span one.
    fn broadcast_taskbar(&self, session_id: &str, taskbar: TaskbarProgress) {
        let targets = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .iter()
            .filter(|(_, client)| client.device_id.is_some())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for client_id in &targets {
            self.send_to_client(
                client_id,
                ServerMessage::SessionTaskbarChanged {
                    session_id: session_id.to_string(),
                    taskbar,
                },
            );
        }
        let event = TerminalTaskbarEvent {
            session_id: session_id.to_string(),
            taskbar,
        };
        let windows = self
            .inner
            .lock()
            .expect("desktop state poisoned")
            .windows
            .subscribers(session_id);
        sync_log!(
            "taskbar",
            "broadcast session={session_id} taskbar={taskbar:?} clients={}",
            targets.len()
        );
        for label in windows {
            let _ = self.app.emit_to(
                EventTarget::webview_window(label),
                "desktop-taskbar",
                event.clone(),
            );
        }
    }

    /// Recomputes the project's window taskbar state and pushes it to the
    /// taskbar engine. The button follows the project's last-ran command:
    /// the most-recently-started still-running command owns the button,
    /// so it animates that process's progress or spinner, and when it
    /// finishes the next-newest still-running command takes over, and so
    /// on (see `taskbar::window_state`). When no command is running, the
    /// button falls back to Windows Terminal's group rule (error, paused,
    /// value, indeterminate, clear) over the sessions' lingering states.
    fn update_window_taskbar(&self, project_id: &str) {
        let _ = project_id; // keep the argument on every platform
        #[cfg(windows)]
        {
            let (hwnd, taskbar) = {
                let inner = self.inner.lock().expect("desktop state poisoned");
                let Some(label) = inner.windows.window_for_project(project_id) else {
                    return;
                };
                let Some(window) = self.app.get_webview_window(label) else {
                    return;
                };
                let Ok(hwnd) = window.hwnd() else {
                    return;
                };
                let candidates = inner
                    .sessions
                    .values()
                    .filter(|session| session.metadata.project_id == project_id)
                    .map(|session| crate::taskbar::WindowTaskbarCandidate {
                        started_at: session.taskbar.command_started_at(),
                        state: session.taskbar.effective(),
                    });
                ((hwnd.0) as isize, crate::taskbar::window_state(candidates))
            };
            if taskbar.is_clear() {
                // A clear push also forgets the window in the engine's
                // tracking, so shutdown does not bother clearing it.
                self.taskbar_engine.clear(hwnd);
            } else {
                self.taskbar_engine
                    .set(hwnd, taskbar.state_code(), taskbar.progress());
            }
        }
    }

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

    /// Set the terminal schemes every client uses for its dark and light
    /// themes. Each id is validated against its own mode, so a dark scheme can
    /// never land in the light slot regardless of which client sent it.
    pub fn set_terminal_theme(&self, dark_scheme_id: &str, light_scheme_id: &str) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            inner.store.set_terminal_theme(
                normalize_terminal_scheme_id(dark_scheme_id, true),
                normalize_terminal_scheme_id(light_scheme_id, false),
            )?;
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
        let key = device_id.as_ref().map(String::as_str).unwrap_or(id);
        // The device's viewport entries leave set S in every session; any
        // session it owned hands the grid to the next most recently active
        // survivor (`reselect_owner_on_departure`).
        let mut changed = Vec::new();
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let controller = TerminalController::Remote(key.to_string());
            for session in inner.sessions.values_mut() {
                let removed = session.viewports.remove(&controller);
                if removed.is_some()
                    && let Some(epoch) =
                        reselect_owner_on_departure(session, std::slice::from_ref(&controller))
                {
                    changed.push((session.metadata.id.clone(), epoch));
                }
            }
        }
        for (session_id, epoch) in changed {
            self.broadcast_grid_change(&session_id, epoch);
        }
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

        let device_id = self
            .clients
            .lock()
            .expect("remote clients poisoned")
            .get(client_id)
            .and_then(|client| client.device_id.clone());
        if device_id.is_none() {
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
        // Every message (the bare ping included) is liveness for the
        // device's viewport entries: the watchdog keeps a networked client
        // in set S for VIEWPORT_WATCHDOG_TIMEOUT_MS after its last message.
        {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            let controller =
                TerminalController::Remote(device_id.as_ref().expect("checked above").clone());
            let now = Instant::now();
            for session in inner.sessions.values_mut() {
                if let Some(viewport) = session.viewports.get_mut(&controller) {
                    viewport.last_seen = now;
                }
            }
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
            ClientMessage::ShellDefault {
                request_id,
                shell_id,
            } => {
                self.set_default_shell(&shell_id)?;
                Some(ServerMessage::Snapshot {
                    request_id: Some(request_id),
                    snapshot: self.snapshot(),
                })
            }
            ClientMessage::TerminalTheme {
                request_id,
                dark_scheme_id,
                light_scheme_id,
            } => {
                self.set_terminal_theme(&dark_scheme_id, &light_scheme_id)?;
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
                claim,
            } => {
                // A claimed attach joins this device into set S and takes
                // ownership of the PTY grid at once; an unclaimed attach (a
                // plain buffer re-request) is a pure stream subscription
                // (see attach_owner_grid_for). Keyed on the paired device
                // id, so a reconnect on a new socket replaces the stale
                // entry atomically.
                self.attach_remote_session(client_id, &session_id, cols, rows, claim);
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
            ClientMessage::SessionInput {
                session_id,
                data,
                cols,
                rows,
            } => {
                self.write_remote_session(client_id, &session_id, &data, cols.zip(rows));
                None
            }
            ClientMessage::SessionResize {
                session_id,
                cols,
                rows,
                claim,
            } => {
                self.resize_remote_session(client_id, &session_id, cols, rows, claim);
                None
            }
            ClientMessage::SessionViewportRelease {
                request_id,
                session_id,
            } => {
                // Unlike SessionDetach, this deliberately leaves
                // attached_sessions untouched (see the dispatch bookkeeping
                // above) - the device stays subscribed, just no longer a
                // sizing candidate.
                self.release_remote_controller(client_id, &session_id);
                Some(ServerMessage::Ok { request_id })
            }
            ClientMessage::Ping => None,
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
            viewing_session_ids: Vec::new(),
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
            activity_change,
            taskbar_change,
            project_id,
            look_here_changed,
        ) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            // The "come look" marker is not raised for a session a
            // client is actively viewing (see `viewed_session_ids`):
            // the client looking at it is the look itself, so a command
            // finishing there earns no marker. Computed before the
            // session's mutable borrow: the viewing sets live in the
            // window and device state `inner` also owns, and a shared
            // borrow of them may not overlap the mutable borrow.
            let viewed = viewed_session_ids(&inner).contains(session_id);
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
            let now = Instant::now();
            let tui_transition = session.tui.feed(&data, now, session.grid.1);
            // History isolation: a FULLSCREEN TUI that never enters the
            // alternate screen of its own (a raw primary-buffer harness)
            // is wrapped in a host-injected alt pair so its frames stay
            // out of client scrollback. `Inline` is deliberately not
            // wrapped: an inline harness keeps a scrolling transcript on
            // the primary buffer and repaints only a bottom band, so the
            // alt screen would throw the transcript away and leave the
            // band alone on a blank screen. The enter is spliced in at
            // the sequence that announced the TUI, the exit at the one
            // that released it - bytes on either side of that boundary
            // belong to the buffer they were written for.
            let mut injected = String::new();
            let mut inject_at = 0usize;
            if let Some(transition) = tui_transition {
                if transition.to == TuiMode::Fullscreen && !transition.via_alt_enter {
                    injected.push_str("\x1b[?1049h");
                    session.synthetic_alt = true;
                    inject_at = transition.at;
                } else if transition.to == TuiMode::Canonical
                    && session.synthetic_alt
                    && !transition.program_alt_exit
                {
                    injected.push_str("\x1b[?1049l");
                    session.synthetic_alt = false;
                    inject_at = transition.at;
                }
            }
            // The classifier counts bytes. Every signal it can anchor a
            // transition to starts on a char boundary today (an ESC, or
            // the first byte of a run of text), but the splice is a
            // slicing operation on a `String`, so it walks forward to a
            // boundary rather than trusting that and panicking.
            let mut inject_at = inject_at.min(data.len());
            while inject_at < data.len() && !data.is_char_boundary(inject_at) {
                inject_at += 1;
            }
            let mut payload = String::with_capacity(injected.len() + data.len());
            payload.push_str(&data[..inject_at]);
            payload.push_str(&injected);
            payload.push_str(&data[inject_at..]);
            session.buffer.push_str(&payload);
            let before_trim = session.buffer.len();
            session.journal_len = offset.saturating_add(payload.len() as u64);
            // A whole-screen clear (`clear` / Clear-Host) is a history
            // boundary: drain the journal front up to its ESC so synced
            // devices never reflow the erased content. The cut keeps
            // the clear itself, so a replay still starts blank, then
            // repaints the prompt.
            if let Some(cut_rel) = session.tui.take_chunk_clear() {
                // Both indices are relative to `data`; the injection only
                // shifts the clear when it was spliced in ahead of it.
                let shift = if inject_at <= cut_rel {
                    injected.len()
                } else {
                    0
                };
                let clear_at = before_trim
                    .saturating_sub(payload.len())
                    .saturating_add(shift)
                    .saturating_add(cut_rel);
                if drain_journal_front_at(&mut session.buffer, clear_at) {
                    sync_log!(
                        "journal",
                        "clear session={session_id} trimmed_to={clear_at} remaining={}",
                        session.buffer.len()
                    );
                }
            }
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
            session.pending_device_attributes =
                session
                    .pending_device_attributes
                    .saturating_add(record_device_attribute_requests(
                        &mut session.device_attributes_tail,
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
            // dimensions (SIGWINCH triggers its native repaint). A shell
            // alt-screen cycle (PSReadLine's Clear-Host) enters the alt
            // screen but paints no TUI frames: defer ITS grid change until
            // paint evidence arrives, so the SIGWINCH never lands mid-
            // shell-state and desyncs PSReadLine's prompt-row tracking.
            let mut tui_entry_grid = if tui_transition.is_some_and(|t| t.to != TuiMode::Canonical) {
                if tui_transition.is_some_and(|t| t.via_alt_enter)
                    && session.tui.grid_change_suppressed()
                {
                    session.deferred_tui_resize = true;
                    None
                } else {
                    session
                        .requested_viewport
                        .and_then(|(cols, rows)| apply_session_grid(session, cols, rows))
                }
            } else {
                None
            };
            // Exiting to canonical clears a pending deferral BEFORE the
            // fire check below: in canonical mode the suppression
            // predicate is false, so without this ordering a bare shell
            // alt cycle would fire its deferred resize on the exit
            // chunk - the very transient mid-shell-state SIGWINCH this
            // deferral exists to prevent.
            if tui_transition.is_some_and(|t| t.to == TuiMode::Canonical) {
                session.deferred_tui_resize = false;
            }
            // The deferred alt-enter resize fires the moment paint
            // evidence (DECSTBM or a hidden-cursor write past row 1
            // while the program's alt screen is open) releases the
            // suppression. A bare shell alt cycle never produces
            // evidence, so its grid - and the shell's row tracking -
            // stay intact.
            if session.deferred_tui_resize && !session.tui.grid_change_suppressed() {
                session.deferred_tui_resize = false;
                tui_entry_grid = session
                    .requested_viewport
                    .and_then(|(cols, rows)| apply_session_grid(session, cols, rows));
            }
            // Active/idle detection runs off the same classifier pass:
            // the OSC 133 markers it accepted (a marker painted inside a
            // synchronized-output bracket is a program's own composer and
            // never reaches this list), the mode it settled on, and its
            // prompt-quiet verdict.
            let markers = session.tui.take_shell_markers();
            let reports = session.tui.take_progress_reports();
            let quiet_idle = session.tui.quiet_idle(now);
            // Output the user just caused - a keystroke reaction, a
            // resize repaint - must not read as the program working:
            // it neither earns nor extends the busy badge. Only
            // program-spontaneous chunks advance the quiet clock, so a
            // quiet screen stays quiet no matter how the user interacts
            // with it.
            let user_driven = output_is_user_driven(session, now);
            if !user_driven {
                session.tui.mark_spontaneous_output(now);
            }
            // The quiet verdict comes from the spontaneous clock, not the
            // last-chunk gap: user-driven repaints cannot keep a TUI
            // screen reading active (a Windows Terminal whose screen
            // stopped changing shows no busy indicator, whatever caused
            // the last repaint).
            let tui_quiet = session.tui.spontaneous_quiet_ms(now) >= TUI_QUIET_MS;
            let tui_spontaneous = !user_driven;
            let mode_now = session.metadata.tui_mode;
            let activity_change = session
                .activity
                .observe(
                    &markers,
                    mode_now,
                    quiet_idle,
                    tui_quiet,
                    true,
                    tui_spontaneous,
                    now,
                )
                .map(|(activity, since)| {
                    session.metadata.activity = activity;
                    session.metadata.activity_since = Some(since.clone());
                    (activity, since)
                });
            // Taskbar progress runs off the same pass (Windows Terminal's
            // ConEmu `OSC 9;4` path, microsoft/terminal #8055): explicit
            // program reports first, then the shell's command lifecycle -
            // a running command is an indeterminate spinner, and a
            // non-zero exit leaves an error until the next command
            // starts.
            let mut taskbar_changed = false;
            for report in reports {
                taskbar_changed |= session.taskbar.apply_report(report);
            }
            if let Some((activity, _)) = &activity_change {
                taskbar_changed |= session.taskbar.on_activity(*activity, now);
            }
            let failed_exit = markers.iter().any(|marker| {
                matches!(
                    marker,
                    ShellMarker::CommandEnd {
                        exit_code: Some(code)
                    } if *code != 0
                )
            });
            if failed_exit {
                taskbar_changed |= session.taskbar.on_failed_exit();
            }
            // Both values are computed before the tuple: the tuple's
            // `subscribers` call takes a shared borrow of `inner`, which
            // may not overlap the session's mutable borrow.
            let project_id = session.metadata.project_id.clone();
            let taskbar_change = taskbar_changed.then_some(session.taskbar.effective());
            // The snapshot's session JSON is built from this metadata - the
            // taskbar machine itself is never serialized - and a phone in
            // its tabs view receives no attached-only taskbar events:
            // keep the two in lockstep so the phone's next snapshot reads
            // the session's true progress state.
            if let Some(taskbar) = taskbar_change {
                session.metadata.taskbar = taskbar;
            }
            // The "come look" marker moves with the indicator (see the
            // helper): the finished edge raises it, a re-armed one drops
            // it. A move here must reach the snapshot - clients seed
            // their markers from it - so it reports a change broadcast.
            let mut look_here_changed = false;
            if let Some(taskbar) = taskbar_change {
                look_here_changed = move_look_here(session, taskbar, viewed);
            }
            (
                reported,
                title_changed,
                inner.windows.subscribers(session_id),
                offset,
                payload,
                mode_change,
                tui_entry_grid,
                activity_change,
                taskbar_change,
                project_id,
                look_here_changed,
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
        if let Some((activity, since)) = &activity_change {
            self.broadcast_activity(session_id, *activity, since);
        }
        if let Some(taskbar) = taskbar_change {
            self.broadcast_taskbar(session_id, taskbar);
            self.update_window_taskbar(&project_id);
        }
        if let Some(cwd) = reported_cwd {
            self.handle_session_working_directory(session_id, &cwd);
        }
        // A look-here flag move must reach the snapshot: clients seed
        // their "come look" markers from it. (A cwd handler may have
        // broadcast already; a duplicate is one extra snapshot push,
        // while a lost flag move would drop a marker.)
        if title_changed || activity_change.is_some() || look_here_changed {
            self.broadcast();
        }
    }

    fn on_terminal_exit(self: &Arc<Self>, session_id: &str, exit_code: u32) {
        let (closed_project, exited_project, taskbar_clear) = {
            let mut inner = self.inner.lock().expect("desktop state poisoned");
            // The taskbar state the process was showing, for the
            // kept-open exited tab: its indicator has to be dropped
            // explicitly, since no stream is left to clear it.
            let previous = inner
                .sessions
                .get(session_id)
                .map(|session| session.taskbar.effective());
            if exit_code == 0 {
                // The shell finished normally: close the tab instead of
                // leaving a dead one behind. The process is already gone,
                // so no kill is attempted. If the user closed the tab
                // first the session is already removed and this is a
                // no-op.
                (
                    close_session_in_inner(&mut inner, session_id, false),
                    None,
                    None,
                )
            } else {
                // Non-zero exit: keep the tab so the user can inspect
                // what failed.
                let found = mark_session_exited(&mut inner, session_id, exit_code);
                let project = found
                    .then(|| inner.sessions.get(session_id))
                    .flatten()
                    .map(|session| session.metadata.project_id.clone());
                (
                    None,
                    project,
                    previous.filter(|taskbar| !taskbar.is_clear()),
                )
            }
        };
        if let Some(project_id) = &closed_project {
            self.cleanup_empty_temporary_project(project_id);
            // The closed session's state is gone with it, so re-push the
            // window's taskbar in case the surviving sessions' priority
            // changed.
            self.update_window_taskbar(project_id);
        }
        if let Some(project_id) = &exited_project {
            // An exited tab kept for inspection must not keep an
            // indicator: the process that owned it is gone.
            if taskbar_clear.is_some() {
                self.broadcast_taskbar(session_id, TaskbarProgress::Clear);
            }
            self.update_window_taskbar(project_id);
        }
        // The manual-close path already broadcast when it removed the
        // session first, so a no-op close here stays silent.
        if closed_project.is_some() || exited_project.is_some() {
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
            // The moved session's taskbar state now belongs to the other
            // project; make sure both projects' windows carry the states
            // that result.
            self.update_window_taskbar(&plan.project.id);
            self.update_window_taskbar(&plan.previous_project_id);
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

/// Which sessions each paired device is displaying, read off the sessions'
/// viewport sets: a remote viewport is keyed by the device id once the socket
/// is authenticated (`remote_sizing_key`), so set S inverts directly into
/// per-device viewing lists. Session ids are ordered by `session_order` so a
/// client can compare them without sorting.
fn viewing_sessions_by_device(inner: &Inner) -> HashMap<String, Vec<String>> {
    let mut viewing: HashMap<String, Vec<String>> = HashMap::new();
    for session_id in ordered_session_ids(inner) {
        let Some(session) = inner.sessions.get(&session_id) else {
            continue;
        };
        for controller in session.viewports.keys() {
            if let TerminalController::Remote(device_id) = controller {
                viewing
                    .entry(device_id.clone())
                    .or_default()
                    .push(session_id.clone());
            }
        }
    }
    viewing
}

/// Session ids in presentation order: the explicit order first, then any
/// session missing from it (oldest first), matching `snapshot_from_inner`.
fn ordered_session_ids(inner: &Inner) -> Vec<String> {
    let mut ids = inner
        .session_order
        .iter()
        .filter(|id| inner.sessions.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let mut missing = inner
        .sessions
        .values()
        .filter(|session| !inner.session_order.contains(&session.metadata.id))
        .map(|session| session.metadata.clone())
        .collect::<Vec<_>>();
    missing.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    ids.extend(missing.into_iter().map(|session| session.id));
    ids
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

    let viewing = viewing_sessions_by_device(inner);

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
                entry.viewing_session_ids = viewing.get(&entry.id).cloned().unwrap_or_default();
                entry
            })
            .collect(),
        desktop_active_session_ids: inner.windows.active_session_ids(),
        // The host-persisted "come look" markers: sessions whose command
        // just finished and that no client has viewed yet. A client
        // connecting after the edge reads the field and raises the same
        // static-dot marker a live client raised from the event stream.
        look_here_session_ids: {
            let mut ids: Vec<String> = inner
                .sessions
                .values()
                .filter(|session| session.look_here)
                .map(|session| session.metadata.id.clone())
                .collect();
            ids.sort();
            ids
        },
        shells: inner.shells.clone(),
        default_shell_id,
        // Re-normalized on the way out so a settings file edited by hand, or
        // written by a build that knew different scheme ids, still reaches
        // clients as a readable dark/light pair.
        terminal_theme: TerminalThemeSettings {
            dark_scheme_id: normalize_terminal_scheme_id(
                &inner.store.settings().terminal_dark_scheme_id,
                true,
            ),
            light_scheme_id: normalize_terminal_scheme_id(
                &inner.store.settings().terminal_light_scheme_id,
                false,
            ),
        },
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
    let home = std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    ensure_directory_project(inner, &home)
}

/// The project for `directory`: an existing saved or temporary one at that
/// exact path, or a new temporary project standing for it.
fn ensure_directory_project(inner: &mut Inner, directory: &Path) -> Result<Project> {
    let start_folder = canonical_directory(directory)?;
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
/// The project a directory belongs to: the one whose path is the directory
/// itself or its closest ancestor. Nested projects therefore resolve to the
/// innermost one, and a directory outside every project matches nothing.
fn project_for_directory(inner: &Inner, directory: &str) -> Option<Project> {
    let wanted = normalized_path(Path::new(directory));
    public_projects(inner)
        .into_iter()
        .filter(|project| {
            let root = normalized_path(Path::new(&project.path));
            wanted == root || wanted.starts_with(&format!("{root}\\"))
        })
        // Deepest match wins; a saved project beats a temporary one sharing
        // the same path, so the console lands on the sidebar entry the user
        // actually keeps.
        .max_by_key(|project| {
            (
                normalized_path(Path::new(&project.path)).len(),
                project.persistent,
            )
        })
}

/// Whether a directory lives under the Windows directory: where a console
/// launched from Explorer's own shell surfaces starts, and never a place the
/// user keeps a project.
fn is_system_directory(directory: &str) -> bool {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let root = normalized_path(Path::new(&root));
    let wanted = normalized_path(Path::new(directory));
    wanted == root || wanted.starts_with(&format!("{root}\\"))
}

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

/// Removes a session from state (session map and tab order). Returns the
/// owning project id so the caller can retire an empty temporary project;
/// `None` when the session was already removed (for example the user closed
/// the tab first), in which case nothing changed. `kill_process` kills the
/// child only on a manual close: on the normal-exit path the process has
/// already terminated and killing is pointless.
fn close_session_in_inner(
    inner: &mut Inner,
    session_id: &str,
    kill_process: bool,
) -> Option<String> {
    let mut session = inner.sessions.remove(session_id)?;
    inner.session_order.retain(|id| id != session_id);
    if kill_process {
        let _ = session.killer.kill();
    }
    sync_log!("session", "close id={session_id}");
    Some(session.metadata.project_id)
}

/// Marks a still-open session as exited. Returns `true` when the session
/// was found and updated, `false` when the tab was already closed, so the
/// caller can skip the redundant broadcast.
fn mark_session_exited(inner: &mut Inner, session_id: &str, exit_code: u32) -> bool {
    let Some(session) = inner.sessions.get_mut(session_id) else {
        return false;
    };
    session.metadata.status = "exited".into();
    session.metadata.exit_code = Some(exit_code);
    // An exited tab must not keep a busy badge, and no further signal is
    // coming to clear one: the stream is closed and the sweeper skips
    // sessions that are no longer running.
    session.activity.on_exit(Instant::now());
    session.metadata.activity = session.activity.state();
    session.metadata.activity_since = Some(session.activity.since().to_string());
    // Same for the taskbar: whatever progress the process was showing
    // belongs to a process that no longer exists. Sync it into the
    // metadata the snapshot is built from, so an exited tab kept for
    // inspection never resurrects a progress bar in a phone's tabs view.
    session.taskbar.on_exit();
    session.metadata.taskbar = session.taskbar.effective();
    // The process is gone, so its "come look" marker dies with it.
    session.look_here = false;
    true
}

/// Move a session's "come look" marker with its taskbar indicator and
/// report whether the flag changed. The flag is raised by the finished
/// edge (the indicator's only transition INTO the clear state) and
/// dropped whenever the indicator is re-armed - a new command or an
/// explicit state, i.e. any non-clear state. The finished edge raises
/// the flag only when no client is viewing the session (`viewed`):
/// a client that IS on it is the look the marker exists for, so a
/// command finishing there needs no marker. Callers invoke it only
/// after the state machine actually changed state; the flag's other
/// death is a look at the session ({@link clear_session_look_here}) or
/// the session's exit ({@link mark_session_exited}).
fn move_look_here(session: &mut ManagedSession, taskbar: TaskbarProgress, viewed: bool) -> bool {
    let look_here = taskbar == TaskbarProgress::Clear && !viewed;
    if session.look_here != look_here {
        session.look_here = look_here;
        true
    } else {
        false
    }
}

/// The session ids a client is actively viewing right now: a desktop
/// window's active tabs (a terminal merely attached in a window's
/// background is not a look - its finished edge still earns a marker,
/// the way the window's own tab indicators show it), and the sessions a
/// remote device keeps a live viewport in (a phone attaches only the
/// terminal page it is showing, so its viewport set is exactly the
/// terminal it is on). A session in this set needs no "come look"
/// marker when its command finishes: the client looking at it is the
/// look itself, and raising the flag would let a later snapshot re-seed
/// the marker on the very client that watched the finish.
fn viewed_session_ids(inner: &Inner) -> HashSet<String> {
    let mut viewed: HashSet<String> = inner
        .windows
        .active_session_ids()
        .into_iter()
        .collect();
    for session in inner.sessions.values() {
        for controller in session.viewports.keys() {
            if matches!(controller, TerminalController::Remote(_)) {
                viewed.insert(session.metadata.id.clone());
            }
        }
    }
    viewed
}

/// A look at a session - a desktop window making its tab active, or a
/// phone opening its terminal - dies the session's "come look" marker.
/// Returns whether the flag was held (and is now cleared), so the
/// caller can skip the redundant broadcast.
fn clear_session_look_here(inner: &mut Inner, session_id: &str) -> bool {
    let Some(session) = inner.sessions.get_mut(session_id) else {
        return false;
    };
    let cleared = session.look_here;
    session.look_here = false;
    cleared
}

/// How many terminal tabs are open, including a tab kept for inspection
/// after its shell exited non-zero: that tab stays until the user closes
/// it, so it is part of the count the tray's session label reports.
fn open_session_count(inner: &Inner) -> usize {
    inner.sessions.len()
}

/// How many open tabs are blocked on a foreground program. An exited tab
/// is never counted: `mark_session_exited` drops its activity, and the
/// sweeper stops looking at it.
fn active_session_count(inner: &Inner) -> usize {
    inner
        .sessions
        .values()
        .filter(|session| {
            session.metadata.status == "running"
                && session.metadata.activity == SessionActivity::Active
        })
        .count()
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
    saved.sort_by_key(|project| std::cmp::Reverse(Path::new(&project.path).components().count()));
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

/// Drain the journal front up to (not including) a whole-screen clear,
/// so a replay never reflows content the program erased. The classifier
/// anchors the cut at the clear's ESC (a sequence boundary); a position
/// on a non-character boundary is advanced defensively. Returns true
/// when bytes were removed.
fn drain_journal_front_at(buffer: &mut String, keep_from: usize) -> bool {
    if keep_from == 0 || keep_from >= buffer.len() {
        return false;
    }
    let mut start = keep_from;
    while !buffer.is_char_boundary(start) {
        start += 1;
    }
    if start == buffer.len() {
        return false;
    }
    buffer.drain(..start);
    true
}

/// Register (or refresh) a client's announced viewport in the session's set
/// S, and its recency of USE (`last_active`) - never touched by an unrelated
/// keepalive ping, only by an actual resize/write/attach into this session.
/// Desktop panes never expire from S; remote entries carry the watchdog
/// clock (`last_seen`, refreshed separately by any message from the device).
fn set_client_viewport(
    session: &mut ManagedSession,
    controller: TerminalController,
    cols: u16,
    rows: u16,
) {
    let networked = matches!(controller, TerminalController::Remote(_));
    let now = Instant::now();
    session
        .viewports
        .entry(controller)
        .and_modify(|viewport| {
            viewport.cols = cols;
            viewport.rows = rows;
            viewport.last_seen = now;
            viewport.last_active = now;
        })
        .or_insert(ClientViewport {
            cols,
            rows,
            last_seen: now,
            last_active: now,
            networked,
        });
}

/// Pure core of the watchdog sweep: evict networked viewports whose
/// last_seen is older than `timeout`, leaving desktop entries alone (an
/// in-process pane has no heartbeat and an implicit 0 ms timeout). Returns
/// the evicted clients' identities so the caller can tell whether the grid
/// owner was among the departures (`reselect_owner_on_departure`).
fn evict_stale_viewports(
    session: &mut ManagedSession,
    now: Instant,
    timeout: std::time::Duration,
) -> Vec<TerminalController> {
    let mut evicted = Vec::new();
    session.viewports.retain(|controller, viewport| {
        let keep = !viewport.networked || now.duration_since(viewport.last_seen) < timeout;
        if !keep {
            evicted.push(controller.clone());
        }
        keep
    });
    evicted
}

/// Grid policy: applies `cols`x`rows` to the PTY, unless a shell alt-screen
/// cycle is in progress (`grid_change_suppressed`), in which case the size
/// is recorded but held until the program paints a TUI frame (or never, for
/// a bare shell cycle) - a SIGWINCH mid-shell-state desyncs PSReadLine's
/// prompt-row tracking. This is the background-event apply path (a
/// departure reselecting a successor): it does not decide who owns the
/// grid, only when a decided size may land - see `apply_owner_grid` for the
/// real-interaction path that bypasses this hold.
fn apply_grid_if_tui(session: &mut ManagedSession, cols: u16, rows: u16) -> Option<GridEpoch> {
    session.requested_viewport = Some((cols, rows));
    if session.tui.grid_change_suppressed() {
        return None;
    }
    apply_session_grid(session, cols, rows)
}

/// Claim or confirm ownership of the PTY grid for `controller`, then apply
/// its viewport if it now owns the session, in every mode. A real
/// interaction (`claim`) always takes ownership over from whoever held it;
/// with no explicit claim, a controller that already owns the session keeps
/// applying its own resizes (so an owner's window naturally resizing still
/// tracks), and an ownerless session (never viewed, or its last owner
/// departed with no survivor) claims itself onto whichever client shows up
/// first, so a lone client still sizes its PTY. A non-owner's unclaimed
/// announce is recorded into set S (a candidate for `reselect_owner_on_departure`)
/// but never resizes the PTY out from under the owner.
fn apply_owner_grid_for(
    session: &mut ManagedSession,
    controller: &TerminalController,
    cols: u16,
    rows: u16,
    claim: bool,
) -> Option<GridEpoch> {
    if claim || session.owner.is_none() {
        session.owner = Some(controller.clone());
    }
    if session.owner.as_ref() != Some(controller) {
        return None;
    }
    apply_owner_grid(session, cols, rows)
}

/// The owner's announced viewport is applied to the PTY immediately,
/// bypassing the fullscreen suppression hold - a real interaction (typed
/// key, click, tap) or the owner's own resize is the strongest signal that
/// the program should redraw at the new size. The applied size is recorded
/// as the next TUI-entry target (`requested_viewport`).
fn apply_owner_grid(session: &mut ManagedSession, cols: u16, rows: u16) -> Option<GridEpoch> {
    session.requested_viewport = Some((cols, rows));
    apply_session_grid(session, cols, rows)
}

/// Viewport registration for the attach path only: an unclaimed attach is a
/// pure stream subscription - a background desktop tab, or a device
/// re-requesting the buffer - and must never join set S or be handed the
/// grid while it is not actually shown (an ownerless session would
/// otherwise bootstrap onto whichever background pane happens to attach
/// first). A claimed attach joins S and takes ownership at once, exactly
/// like a real interaction.
fn attach_owner_grid_for(
    session: &mut ManagedSession,
    controller: &TerminalController,
    cols: u16,
    rows: u16,
    claim: bool,
) -> Option<GridEpoch> {
    if !claim {
        return None;
    }
    set_client_viewport(session, controller.clone(), cols, rows);
    apply_owner_grid_for(session, controller, cols, rows, true)
}

/// Grid policy for one or more departing clients (socket disconnect, remote
/// detach, remote viewport release, window destroy/hide, or a watchdog
/// sweep evicting several at once). The PTY grid is untouched unless the
/// current owner is among `departed`, in which case ownership passes to
/// whichever SURVIVING client was most recently active in this session
/// (`last_active`) - the "last used client" - and its announced viewport
/// applies. Ties (the same instant, or two clients that never differ once
/// clock resolution is spent) break on controller identity, so the choice
/// is always deterministic. An empty survivor set clears the owner and
/// keeps the last grid. This is a background event, not a real interaction,
/// so it respects the fullscreen suppression hold (`apply_grid_if_tui`)
/// instead of bypassing it like `apply_owner_grid`.
fn reselect_owner_on_departure(
    session: &mut ManagedSession,
    departed: &[TerminalController],
) -> Option<GridEpoch> {
    let owner_departed = session
        .owner
        .as_ref()
        .is_some_and(|owner| departed.contains(owner));
    if !owner_departed {
        return None;
    }
    let successor = session
        .viewports
        .iter()
        .max_by(|(a_controller, a_viewport), (b_controller, b_viewport)| {
            a_viewport
                .last_active
                .cmp(&b_viewport.last_active)
                .then_with(|| a_controller.cmp(b_controller))
        })
        .map(|(controller, viewport)| (controller.clone(), viewport.cols, viewport.rows));
    match successor {
        Some((controller, cols, rows)) => {
            session.owner = Some(controller);
            apply_grid_if_tui(session, cols, rows)
        }
        None => {
            session.owner = None;
            None
        }
    }
}

/// Remove `controller`'s entry from set S (it is no longer displaying the
/// session) and reselect the owner if it was the one departing. Shared by
/// every departure path - `session.detach`, `session.viewport.release`, a
/// hidden/destroyed desktop window, a socket disconnect, and the watchdog
/// sweep - so they all resolve ownership identically regardless of client
/// kind.
fn release_viewport(
    session: &mut ManagedSession,
    controller: &TerminalController,
) -> Option<GridEpoch> {
    session.viewports.remove(controller);
    reselect_owner_on_departure(session, std::slice::from_ref(controller))
}

/// Resize the PTY to the requesting client's grid and record the epoch, or
/// nothing if the grid did not actually change. `apply_session_grid` runs
/// under the session lock, so the recorded epoch offset is always aligned to
/// a journal chunk boundary.
fn output_is_user_driven(session: &ManagedSession, now: Instant) -> bool {
    [session.last_user_input_at, session.last_resize_at]
        .into_iter()
        .flatten()
        .max()
        .is_some_and(|at| {
            now.checked_duration_since(at)
                .is_some_and(|gap| gap.as_millis() as u64 <= TUI_USER_ATTRIBUTION_MS)
        })
}

fn apply_session_grid(session: &mut ManagedSession, cols: u16, rows: u16) -> Option<GridEpoch> {
    let cols = cols.clamp(2, SESSION_MAX_COLS);
    let rows = rows.clamp(1, SESSION_MAX_ROWS);
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
    // A resize repaints the whole screen; attribute that repaint to the
    // user, not to the program.
    session.last_resize_at = Some(Instant::now());
    session.grid = (cols, rows);
    let epoch = GridEpoch {
        offset: session.journal_len,
        cols,
        rows,
    };
    // Coalesce consecutive resizes: dragging a window corner produces a burst
    // of grids, and an epoch the stream never wrote a byte under is one no
    // replay can observe. Only epochs at the SAME stream offset are merged -
    // the moment output lands at a size, that size is load-bearing (a TUI
    // repaints its frame for the grid it was told about), so its epoch stays
    // and the frame keeps the grid it was drawn for.
    if session
        .grid_epochs
        .last()
        .is_some_and(|last| last.offset == epoch.offset)
    {
        session.grid_epochs.pop();
    }
    // A burst that ends back on the grid it started from leaves the surviving
    // epoch alone; re-recording it would only add a zero-length replay
    // segment. The epoch is still returned, because live clients are told
    // about the grid they are on now either way.
    if !session
        .grid_epochs
        .last()
        .is_some_and(|last| (last.cols, last.rows) == (cols, rows))
    {
        session.grid_epochs.push(epoch);
    }
    Some(epoch)
}

fn snapshot_of(session: &ManagedSession) -> SessionSnapshot {
    let base = session
        .journal_len
        .saturating_sub(session.buffer.len() as u64);
    SessionSnapshot {
        segments: collapse_superseded_repaints(split_journal_by_epochs(
            &session.buffer,
            &session.grid_epochs,
            base,
        )),
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

/// Drop the resize repaints a later repaint has already erased.
///
/// Every SIGWINCH makes the Windows pseudoconsole redraw the whole visible
/// screen: hide the cursor, home it, rewrite each row with an erase-to-end,
/// put the cursor back, show it. So a burst of resizes - dragging a window
/// edge, or spamming Win+Arrow - journals one full-screen repaint per
/// intermediate grid, each under its own epoch. Coalescing at record time
/// cannot touch those (the repaint IS output between the two resizes, and
/// output between resizes is exactly what must never be collapsed blind), so
/// a client attaching afterwards replays dozens of grid changes and tens of
/// kilobytes to arrive at a screen the final repaint would have drawn on its
/// own.
///
/// A repaint immediately followed by another repaint contributes nothing to
/// the final screen: the next one rewrites every cell of the viewport. It is
/// dropped only when `is_superseded_repaint` can show it also left nothing
/// behind it - it never scrolled a line into scrollback, and carried no
/// metadata a client is meant to keep.
fn collapse_superseded_repaints(segments: Vec<SessionSegment>) -> Vec<SessionSegment> {
    let mut kept: Vec<SessionSegment> = Vec::with_capacity(segments.len());
    for segment in segments {
        if starts_with_screen_repaint(&segment.data) {
            while let Some(cut) = superseded_tail(&kept) {
                kept.truncate(cut);
            }
        }
        kept.push(segment);
    }
    kept
}

/// Where `kept` has to be cut back to for its tail to stop being a repaint
/// another one replaces. A zero-length segment is a bare grid swap that drew
/// nothing, so it is transparent here and goes with the repaint it sits
/// against - dropping the intermediate grid is the point.
fn superseded_tail(kept: &[SessionSegment]) -> Option<usize> {
    let mut index = kept.len();
    while index > 0 && kept[index - 1].data.is_empty() {
        index -= 1;
    }
    (index > 0 && is_superseded_repaint(&kept[index - 1])).then(|| index - 1)
}

/// The opening of a full-screen repaint: the cursor is hidden and homed
/// before anything is drawn, so what follows overwrites the viewport from its
/// first cell rather than continuing from wherever the last write left off.
fn starts_with_screen_repaint(data: &str) -> bool {
    let Some(mut rest) = data.strip_prefix("\x1b[?25l") else {
        return false;
    };
    // ConPTY sets the pen up before it homes the cursor (`CSI ?25l CSI 34m
    // CSI 1m CSI H ...`). SGR paints no cell, so it does not make the repaint
    // any less of a repaint.
    while let Some(after) = strip_leading_sgr(rest) {
        rest = after;
    }
    rest.starts_with("\x1b[H") || rest.starts_with("\x1b[1;1H")
}

/// Strip one leading `CSI ... m`, if that is what `data` starts with.
fn strip_leading_sgr(data: &str) -> Option<&str> {
    let rest = data.strip_prefix("\x1b[")?;
    let end = rest.find(|character: char| !matches!(character, '0'..='9' | ';' | ':'))?;
    (rest.as_bytes()[end] == b'm').then(|| &rest[end + 1..])
}

/// True when this segment is a self-contained screen repaint that a later
/// repaint fully replaces. Every condition here is about what the segment
/// might have left OUTSIDE the viewport the next repaint redraws:
///
/// - fewer line feeds than the grid has rows, and no explicit scroll or
///   scroll-region change, so nothing it drew can have been pushed into
///   scrollback;
/// - no alternate-screen switch, which would make the bytes belong to a
///   different buffer entirely;
/// - no OSC and no BEL, so no title or working-directory report is lost.
fn is_superseded_repaint(segment: &SessionSegment) -> bool {
    let data = segment.data.as_str();
    if !starts_with_screen_repaint(data) || !data.contains("\x1b[?25h") {
        return false;
    }
    if data.matches('\n').count() >= segment.rows.max(1) as usize {
        return false;
    }
    if data.contains('\x07') || data.contains("\x1b]") {
        return false;
    }
    if data.contains("\x1b[?1049") || data.contains("\x1b[?1047") || data.contains("\x1b[?47") {
        return false;
    }
    if data.contains("\x1bD") || data.contains("\x1bM") {
        return false;
    }
    // `CSI S` / `CSI T` scroll the screen; `CSI r` (DECSTBM) redefines the
    // scrolling region, which changes what a later repaint even covers.
    !contains_csi_final(data, b"STr")
}

/// Whether any CSI in `data` ends in one of `finals`. Parameter and
/// intermediate bytes are skipped by class, so parameterized forms
/// (`CSI 3 S`, `CSI 1;40 r`) are caught as well as the bare ones.
fn contains_csi_final(data: &str, finals: &[u8]) -> bool {
    let bytes = data.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
            index += 1;
            continue;
        }
        let mut cursor = index + 2;
        while cursor < bytes.len() && (0x20..=0x3f).contains(&bytes[cursor]) {
            cursor += 1;
        }
        match bytes.get(cursor) {
            Some(final_byte) if finals.contains(final_byte) => return true,
            Some(_) => index = cursor + 1,
            None => return false,
        }
    }
    false
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
    matches!(
        status.error_code.as_str(),
        "preauth_missing" | "preauth_rejected"
    )
}

/// Clears the in-flight verification flag when its task exits on a path that
/// did not reach a terminal broadcast (unexpected return or panic).
struct RemoteVerificationGuard(Arc<Core>);
impl Drop for RemoteVerificationGuard {
    fn drop(&mut self) {
        self.0
            .remote_verification_running
            .store(false, Ordering::Release);
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
        ActivityDetector, CdOutcome, CdPlan, ConnectivityAction, ConnectivityTracker,
        Core, EmbeddedNodeStatus, GridEpoch, Inner, ManagedSession, PENDING_FOCUS_TTL,
        PRESENCE_WINDOW_MS, PairingGrant, PendingFocus, RetireOutcome, SESSION_DEFAULT_COLS,
        SESSION_DEFAULT_ROWS, SESSION_MAX_COLS, SESSION_MAX_ROWS, SessionActivity, SessionWriter,
        TUI_QUIET_MS, TUI_USER_ATTRIBUTION_MS, TerminalController, VIEWPORT_WATCHDOG_TIMEOUT_MS,
        active_session_count, apply_grid_if_tui, apply_owner_grid, apply_owner_grid_for,
        apply_session_grid, attach_owner_grid_for, claim_pending_focus, clear_session_look_here,
        close_session_in_inner,
        collapse_superseded_repaints, contains_csi_final, drain_journal_front_at,
        ensure_home_project, evict_stale_viewports, folder_name, is_cursor_position_report,
        is_device_attributes_report, is_dropped_node_status, is_system_directory,
        is_within_project, log_escape, mark_session_exited, move_look_here,
        newest_running_session_project_id,
        open_session_count, output_is_user_driven, parse_terminal_titles,
        parse_working_directories, preferred_project, presence_alive, project_for_directory,
        project_is_usable, project_name_or_folder, record_cursor_position_requests,
        record_device_attribute_requests, record_pending_focus, registration_status_for_display,
        release_viewport, reselect_owner_on_departure, resolve_working_directory,
        retire_empty_temporary_project, set_client_viewport, should_open_quiet_window,
        snapshot_from_inner, snapshot_of, split_journal_by_epochs, starts_with_screen_repaint,
        startup_project, take_valid_pairing_grant, truncate_journal_front, validate_project_name,
        viewed_session_ids,
    };
    use crate::models::TaskbarProgress;
    use crate::taskbar::SessionTaskbar;
    use crate::{
        models::{AuthorizedDevice, Project, SessionSegment, TerminalSession, TuiMode},
        store::DesktopStore,
        tui::TuiClassifier,
        window_clients::WindowClients,
    };
    use portable_pty::{ChildKiller, MasterPty, PtySize};
    use std::{
        collections::{HashMap, HashSet},
        fs,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
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
    fn drain_at_a_clear_keeps_the_clear_from_the_cut() {
        // The classifier anchors the cut at the clear's ESC; the journal
        // keeps the clear itself so a replay still starts blank and
        // repaints the prompt.
        let mut journal = "history more\r\n\x1b[2J\x1b[HPS C:\\> ".to_string();
        let cut = journal.find("\x1b[2J").unwrap();
        assert!(drain_journal_front_at(&mut journal, cut));
        assert_eq!(journal, "\x1b[2J\x1b[HPS C:\\> ");
    }

    #[test]
    fn drain_at_zero_or_past_end_is_a_noop() {
        let mut journal = "abc".to_string();
        assert!(!drain_journal_front_at(&mut journal, 0));
        assert!(!drain_journal_front_at(&mut journal, 3));
        assert!(!drain_journal_front_at(&mut journal, 10));
        assert_eq!(journal, "abc");
    }

    #[test]
    fn drain_advances_past_a_non_boundary_cut() {
        // A cut inside a multibyte character moves to the next character
        // boundary instead of splicing the bytes.
        let mut journal = "abéx\x1b[2J".to_string();
        assert!(drain_journal_front_at(&mut journal, 3));
        assert_eq!(journal, "x\x1b[2J");
    }

    #[test]
    fn journal_splits_into_per_grid_segments_without_losing_bytes() {
        let stream =
            "PS C:\\repo> dir\r\nfile-one.txt\r\nfile-two.txt\r\nPS C:\\repo> git status\r\n";
        // Offsets: 18 lands inside "file-one.txt" (a mid-line grid switch is
        // fine - reflow takes over the already-printed row), 45 is exactly
        // the start of the next prompt line.
        let epochs = vec![
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: 18,
                cols: 45,
                rows: 35,
            },
            GridEpoch {
                offset: 45,
                cols: 100,
                rows: 40,
            },
        ];
        let segments = split_journal_by_epochs(stream, &epochs, 0);
        let joined: String = segments
            .iter()
            .map(|segment| segment.data.as_str())
            .collect();
        assert_eq!(
            joined, stream,
            "no byte may be lost or duplicated across grid slices"
        );
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
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: 3,
                cols: 45,
                rows: 35,
            },
            GridEpoch {
                offset: 3,
                cols: 100,
                rows: 40,
            },
        ];
        let segments = split_journal_by_epochs(stream, &epochs, 0);
        assert_eq!(segments.len(), 3);
        assert_eq!((segments[0].cols, segments[0].rows), (120, 30));
        assert_eq!(segments[0].data, "abc");
        assert_eq!((segments[1].cols, segments[1].rows), (45, 35));
        assert_eq!(segments[1].data, "");
        assert_eq!((segments[2].cols, segments[2].rows), (100, 40));
        assert_eq!(segments[2].data, "");
        let joined: String = segments
            .iter()
            .map(|segment| segment.data.as_str())
            .collect();
        assert_eq!(joined, "abc");
    }

    #[test]
    fn journal_split_after_front_trimming_starts_at_the_trimmed_base() {
        let journal = &"A".repeat(500)[200..];
        let epochs = vec![
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: 480,
                cols: 60,
                rows: 40,
            },
        ];
        let base = 200_u64;
        let segments = split_journal_by_epochs(journal, &epochs, base);
        assert_eq!(
            segments[0].cols, 120,
            "the last epoch at or before the base still applies"
        );
        let joined: String = segments
            .iter()
            .map(|segment| segment.data.as_str())
            .collect();
        assert_eq!(joined, journal);
    }

    #[test]
    fn journal_split_survives_multibyte_characters_at_epoch_boundaries() {
        let stream = "PS> 日本語ファイル.txt\r\n日本語列もそのまま\r\n";
        let epochs = vec![
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: (stream.len() - "日本語列もそのまま\r\n".len()) as u64,
                cols: 80,
                rows: 24,
            },
        ];
        let segments = split_journal_by_epochs(stream, &epochs, 0);
        let joined: String = segments
            .iter()
            .map(|segment| segment.data.as_str())
            .collect();
        assert_eq!(joined, stream);
        assert_eq!(segments[1].cols, 80);
    }

    #[test]
    fn journal_split_starts_at_an_epoch_that_sits_exactly_on_the_trimmed_base() {
        // base_offset == an epoch offset: that epoch's grid must own the
        // whole trimmed journal, with no bytes ascribed to the stale grid.
        let journal = "PS> dir\r\nfile.txt\r\n";
        let epochs = vec![
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: 200,
                cols: 45,
                rows: 35,
            },
        ];
        let segments = split_journal_by_epochs(journal, &epochs, 200);
        let joined: String = segments
            .iter()
            .map(|segment| segment.data.as_str())
            .collect();
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
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: 10,
                cols: 72,
                rows: 26,
            },
            GridEpoch {
                offset: 5000,
                cols: 113,
                rows: 39,
            },
        ];
        let segments = split_journal_by_epochs(journal, &epochs, 200);
        let joined: String = segments
            .iter()
            .map(|segment| segment.data.as_str())
            .collect();
        assert_eq!(joined, journal);
        assert_eq!(segments.last().unwrap().cols, 72);
    }

    #[test]
    fn journal_split_of_an_empty_journal_yields_no_segments() {
        let epochs = vec![GridEpoch {
            offset: 0,
            cols: 120,
            rows: 30,
        }];
        assert!(split_journal_by_epochs("", &epochs, 0).is_empty());
    }

    #[test]
    fn journal_split_pins_the_current_grid_when_the_trimmed_journal_has_no_epoch_yet() {
        // base sits before the first (zero-byte) epoch that already changed
        // the grid: the split must still end on the epoch's grid, never on
        // the spawn default.
        let journal = "abc";
        let epochs = vec![
            GridEpoch {
                offset: 0,
                cols: 120,
                rows: 30,
            },
            GridEpoch {
                offset: 3,
                cols: 45,
                rows: 35,
            },
        ];
        let segments = split_journal_by_epochs(journal, &epochs, 0);
        assert_eq!(segments.last().unwrap().cols, 45);
        assert_eq!(
            segments[0].cols, 120,
            "the bytes before the epoch still carry the previous grid"
        );
    }

    #[test]
    fn applying_the_same_grid_is_a_no_op_and_changing_it_records_an_epoch() {
        let mut session = test_session("s1", "p1", "C:\repo");
        let first = apply_session_grid(&mut session, 113, 39);
        assert_eq!(
            first,
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            })
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(
            session.grid_epochs.len(),
            1,
            "the spawn epoch had no output under it"
        );

        let noop = apply_session_grid(&mut session, 113, 39);
        assert_eq!(noop, None);
        assert_eq!(
            session.grid_epochs.len(),
            1,
            "a no-op must not add an epoch"
        );

        // Output at 113x39 pins that grid: the next resize is a new epoch
        // rather than a correction of the last one.
        session.journal_len = 40;
        let second = apply_session_grid(&mut session, 72, 26);
        assert_eq!(
            second,
            Some(GridEpoch {
                offset: 40,
                cols: 72,
                rows: 26
            })
        );
        assert_eq!(session.grid, (72, 26));
        assert_eq!(session.grid_epochs.len(), 2);
    }

    /// One ConPTY resize repaint, shaped exactly like the ones in a real
    /// session: hide the cursor, home it, rewrite every row with an
    /// erase-to-end, restore the cursor, show it again. Deliberately built
    /// with `rows - 1` line feeds - the last row is drawn without one, which
    /// is what keeps the repaint from scrolling anything into scrollback.
    fn conpty_repaint(cols: u16, rows: u16, first_line: &str) -> SessionSegment {
        // The pen setup before the home is what a real ConPTY repaint emits.
        let mut data = format!("\x1b[?25l\x1b[34m\x1b[1m\x1b[H\x1b[K{first_line}");
        for _ in 1..rows {
            data.push_str("\r\n\x1b[K");
        }
        data.push_str("\x1b[2;3H\x1b[?25h");
        SessionSegment { cols, rows, data }
    }

    #[test]
    fn a_burst_of_resize_repaints_replays_as_the_last_one() {
        // Win+Arrow spam: the shell prints nothing, but every SIGWINCH makes
        // ConPTY redraw the screen, so each intermediate grid gets an epoch
        // with a full repaint under it. The replay only needs the last.
        let segments = vec![
            SessionSegment {
                cols: 112,
                rows: 38,
                data: "$ ls\r\nfile.txt\r\n".into(),
            },
            conpty_repaint(209, 65, "$ "),
            conpty_repaint(209, 28, "$ "),
            conpty_repaint(72, 51, "$ "),
            conpty_repaint(118, 65, "$ "),
            SessionSegment {
                cols: 118,
                rows: 65,
                data: String::new(),
            },
        ];
        let collapsed = collapse_superseded_repaints(segments.clone());
        assert_eq!(
            collapsed,
            vec![
                segments[0].clone(),
                segments[4].clone(),
                segments[5].clone()
            ],
            "only the repaint that survived on screen is replayed"
        );
    }

    #[test]
    fn a_repaint_is_recognized_before_and_after_its_pen_setup() {
        // ConPTY homes the cursor either straight away or after restoring the
        // attributes it was drawing with; both are the same repaint.
        assert!(starts_with_screen_repaint("\x1b[?25l\x1b[H\x1b[Ktext"));
        assert!(starts_with_screen_repaint(
            "\x1b[?25l\x1b[34m\x1b[1m\x1b[1;1Htext"
        ));
        // Anything that draws before homing is not a full-screen repaint.
        assert!(!starts_with_screen_repaint("\x1b[?25l\x1b[5;1Htext"));
        assert!(!starts_with_screen_repaint("\x1b[?25ltext\x1b[H"));
        assert!(!starts_with_screen_repaint("\x1b[Htext"));
    }

    #[test]
    fn a_repaint_that_could_have_scrolled_is_never_dropped() {
        // One line feed per row means the last row scrolled: whatever was on
        // the top row went into scrollback, and dropping the segment would
        // lose it.
        let mut scrolled = conpty_repaint(80, 24, "$ ");
        scrolled.data.push_str("\r\n");
        let segments = vec![scrolled.clone(), conpty_repaint(80, 30, "$ ")];
        assert_eq!(collapse_superseded_repaints(segments.clone()), segments);
    }

    #[test]
    fn a_repaint_carrying_program_output_is_never_dropped() {
        // A repaint is only redundant while it is JUST a repaint. Shell
        // integration metadata, a bell, an alt-screen switch or a scroll all
        // mean the segment did something the next repaint does not undo.
        for extra in [
            "\x1b]9;9;C:\repo\x07",
            "\x07",
            "\x1b[?1049h",
            "\x1b[3S",
            "\x1b[1;40r",
            "\x1bM",
        ] {
            let mut segment = conpty_repaint(80, 24, "$ ");
            segment.data.push_str(extra);
            let segments = vec![segment, conpty_repaint(80, 30, "$ ")];
            assert_eq!(
                collapse_superseded_repaints(segments.clone()),
                segments,
                "a segment containing {extra:?} is not a pure repaint"
            );
        }
    }

    #[test]
    fn real_output_between_two_repaints_stops_the_collapse() {
        // The rule only ever removes a repaint that another repaint replaces.
        // A command's output in between is history and stays, along with the
        // repaint that preceded it.
        let segments = vec![
            conpty_repaint(80, 24, "$ "),
            SessionSegment {
                cols: 80,
                rows: 24,
                data: "$ ls\r\nfile.txt\r\n".into(),
            },
            conpty_repaint(90, 24, "$ "),
        ];
        assert_eq!(collapse_superseded_repaints(segments.clone()), segments);
    }

    #[test]
    fn a_trailing_repaint_is_always_kept() {
        // Nothing follows it, so it is the screen: only a LATER repaint can
        // make one redundant.
        let segments = vec![conpty_repaint(80, 24, "$ ")];
        assert_eq!(collapse_superseded_repaints(segments.clone()), segments);
    }

    #[test]
    fn each_run_of_repaints_collapses_to_its_own_last() {
        // Two separate resize bursts with a command between them: each burst
        // loses its intermediate repaints, and the output between survives.
        let output = SessionSegment {
            cols: 90,
            rows: 24,
            data: "$ ls\r\nfile.txt\r\n".into(),
        };
        let segments = vec![
            conpty_repaint(80, 24, "a"),
            conpty_repaint(85, 24, "b"),
            conpty_repaint(90, 24, "c"),
            output.clone(),
            conpty_repaint(100, 30, "d"),
            conpty_repaint(110, 30, "e"),
        ];
        assert_eq!(
            collapse_superseded_repaints(segments.clone()),
            vec![segments[2].clone(), output, segments[5].clone()]
        );
    }

    #[test]
    fn an_empty_segment_between_two_repaints_does_not_break_the_run() {
        // A zero-length segment is a bare grid swap - it draws nothing, so
        // the repaint before it is still superseded by the one after.
        let empty = SessionSegment {
            cols: 85,
            rows: 24,
            data: String::new(),
        };
        let segments = vec![
            conpty_repaint(80, 24, "a"),
            empty,
            conpty_repaint(90, 24, "b"),
        ];
        let collapsed = collapse_superseded_repaints(segments.clone());
        assert_eq!(collapsed, vec![segments[2].clone()]);
    }

    #[test]
    fn a_zero_row_segment_never_panics_on_the_scroll_check() {
        // rows can only be zero through a malformed epoch, but the newline
        // count is compared against it, so the floor has to hold.
        let mut segment = conpty_repaint(80, 24, "$ ");
        segment.rows = 0;
        let segments = vec![segment, conpty_repaint(80, 30, "$ ")];
        assert_eq!(collapse_superseded_repaints(segments.clone()), segments);
    }

    #[test]
    fn a_repaint_without_its_closing_show_cursor_is_kept() {
        // Truncated (a journal front-trim can cut a segment short): it cannot
        // be proven to be a self-contained repaint, so it stays.
        let mut segment = conpty_repaint(80, 24, "$ ");
        segment.data = segment.data.replace("\x1b[?25h", "");
        let segments = vec![segment, conpty_repaint(80, 30, "$ ")];
        assert_eq!(collapse_superseded_repaints(segments.clone()), segments);
    }

    #[test]
    fn an_empty_segment_list_collapses_to_nothing() {
        assert!(collapse_superseded_repaints(Vec::new()).is_empty());
    }

    #[test]
    fn a_truncated_csi_at_the_end_of_a_segment_is_not_a_scroll() {
        // contains_csi_final walks off the end rather than reading past it.
        assert!(!contains_csi_final("text\x1b[", b"STr"));
        assert!(!contains_csi_final("text\x1b[1;40", b"STr"));
        assert!(contains_csi_final("text\x1b[1;40r", b"STr"));
        assert!(contains_csi_final("\x1b[S", b"STr"));
        assert!(!contains_csi_final("\x1b[m\x1b[H", b"STr"));
    }

    #[test]
    fn a_journal_with_no_repaints_is_returned_untouched() {
        let segments = vec![
            SessionSegment {
                cols: 80,
                rows: 24,
                data: "$ ls\r\n".into(),
            },
            SessionSegment {
                cols: 90,
                rows: 24,
                data: "file.txt\r\n".into(),
            },
        ];
        assert_eq!(collapse_superseded_repaints(segments.clone()), segments);
    }

    #[test]
    fn consecutive_resizes_with_no_output_between_them_collapse_to_the_last() {
        // Dragging a window corner: a burst of grids with nothing drawn under
        // any of them. Only the size the program actually painted at can be
        // observed on replay, so only the final one is journaled - while
        // every step still resizes the PTY and is still broadcast live.
        let mut session = test_session("s1", "p1", "C:\repo");
        session.journal_len = 512;
        for (cols, rows) in [(80, 24), (82, 24), (85, 25)] {
            assert_eq!(
                apply_session_grid(&mut session, cols, rows),
                Some(GridEpoch {
                    offset: 512,
                    cols,
                    rows
                })
            );
        }
        assert_eq!(
            session.grid_epochs,
            vec![
                GridEpoch {
                    offset: 0,
                    cols: SESSION_DEFAULT_COLS,
                    rows: SESSION_DEFAULT_ROWS
                },
                GridEpoch {
                    offset: 512,
                    cols: 85,
                    rows: 25
                },
            ]
        );
    }

    #[test]
    fn a_resize_burst_that_lands_back_on_the_previous_grid_journals_nothing() {
        let mut session = test_session("s1", "p1", "C:\repo");
        session.journal_len = 512;
        assert!(apply_session_grid(&mut session, 82, 24).is_some());
        // Back to the spawn grid with still nothing drawn in between: the
        // journal is exactly as it was, and the live broadcast still says
        // which grid the PTY ended on.
        assert_eq!(
            apply_session_grid(&mut session, SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
            Some(GridEpoch {
                offset: 512,
                cols: SESSION_DEFAULT_COLS,
                rows: SESSION_DEFAULT_ROWS
            })
        );
        assert_eq!(
            session.grid_epochs,
            vec![GridEpoch {
                offset: 0,
                cols: SESSION_DEFAULT_COLS,
                rows: SESSION_DEFAULT_ROWS
            }]
        );
        assert_eq!(session.grid, (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS));
    }

    #[test]
    fn a_coalesced_burst_still_clamps_to_the_grid_limits() {
        // The clamp runs before the coalescing, so an out-of-range burst
        // records the clamped grid once rather than one epoch per attempt.
        let mut session = test_session("s1", "p1", "C:\repo");
        session.journal_len = 64;
        assert!(apply_session_grid(&mut session, 0, 0).is_some());
        assert_eq!(session.grid, (2, 1));
        assert!(apply_session_grid(&mut session, 9_000, 9_000).is_some());
        assert_eq!(session.grid, (SESSION_MAX_COLS, SESSION_MAX_ROWS));
        assert_eq!(
            session.grid_epochs,
            vec![
                GridEpoch {
                    offset: 0,
                    cols: SESSION_DEFAULT_COLS,
                    rows: SESSION_DEFAULT_ROWS
                },
                GridEpoch {
                    offset: 64,
                    cols: SESSION_MAX_COLS,
                    rows: SESSION_MAX_ROWS
                },
            ]
        );
    }

    #[test]
    fn a_grid_at_the_ceiling_is_applied_verbatim() {
        // The ceiling is inclusive. A client that correctly clamps its own
        // announcement to MAX_TERMINAL_COLS/ROWS must get that grid back
        // unchanged - an announcement that comes back rewritten is what a
        // client reads as "another client owns this grid".
        let mut session = test_session("s1", "p1", "C:\repo");
        assert!(apply_session_grid(&mut session, SESSION_MAX_COLS, SESSION_MAX_ROWS).is_some());
        assert_eq!(session.grid, (SESSION_MAX_COLS, SESSION_MAX_ROWS));
    }

    #[test]
    fn the_widest_representable_grid_still_clamps_to_the_ceiling() {
        // u16::MAX is what a corrupt or hostile client can put on the wire;
        // the clamp is the backstop, so it must saturate rather than wrap.
        let mut session = test_session("s1", "p1", "C:\repo");
        assert!(apply_session_grid(&mut session, u16::MAX, u16::MAX).is_some());
        assert_eq!(session.grid, (SESSION_MAX_COLS, SESSION_MAX_ROWS));
    }

    #[test]
    fn a_repeat_of_the_clamped_grid_is_still_a_no_op() {
        let mut session = test_session("s1", "p1", "C:\repo");
        assert!(apply_session_grid(&mut session, 9_000, 9_000).is_some());
        assert_eq!(
            apply_session_grid(&mut session, SESSION_MAX_COLS + 100, SESSION_MAX_ROWS + 100),
            None,
            "both clamp to the same grid"
        );
    }

    #[test]
    fn a_resize_after_output_keeps_the_grid_the_output_was_drawn_at() {
        // The unsafe collapse the coalescing must never make: bytes drawn at
        // 82 columns stay ascribed to 82 columns, however fast the next
        // resize follows them.
        let mut session = test_session("s1", "p1", "C:\repo");
        assert!(apply_session_grid(&mut session, 82, 24).is_some());
        session.buffer.push_str("frame drawn at 82 columns");
        session.journal_len = session.buffer.len() as u64;
        assert!(apply_session_grid(&mut session, 85, 25).is_some());
        let segments = snapshot_of(&session).segments;
        let drawn = segments
            .iter()
            .find(|segment| !segment.data.is_empty())
            .expect("the frame is journaled");
        assert_eq!((drawn.cols, drawn.rows), (82, 24));
        assert_eq!(drawn.data, "frame drawn at 82 columns");
        assert_eq!(segments.last().unwrap().cols, 85);
    }

    #[test]
    fn applying_a_grid_uses_the_current_journal_position_for_the_epoch() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        session.buffer.push_str("existing history");
        session.journal_len = 19;
        let epoch = apply_session_grid(&mut session, 100, 34);
        assert_eq!(
            epoch,
            Some(GridEpoch {
                offset: 19,
                cols: 100,
                rows: 34
            })
        );
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
        assert!(
            enter.via_alt_enter,
            "the program's own alt enter is reported"
        );
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
        // mode - none of it is TUI evidence.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[2J\x1b[H").is_none());
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?2004h").is_none());
        assert!(feed_session(&mut session, &mut clock, 10, "\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 60, "").is_none());
        assert_eq!(session.tui.mode(), TuiMode::Canonical);
        assert_eq!(session.metadata.tui_mode, TuiMode::Canonical);
    }

    #[test]
    fn tui_classifier_treats_a_repaint_harness_as_canonical() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // A primary-buffer bottom-region harness (fzf-style) repaints a
        // bounded region: repaint signals are no longer evidence, so the
        // session stays canonical instead of going inline.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?25l").is_none());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[3A\x1b[2Kline a\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[3A\x1b[2Kline b\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[3A\x1b[2Kline c\r\n").is_none());
        assert!(feed_session(&mut session, &mut clock, 60, "").is_none());
        assert_eq!(session.tui.mode(), TuiMode::Canonical);
        assert_eq!(session.metadata.tui_mode, TuiMode::Canonical);
        // The program's own alt-screen entry is still definitive and
        // takes the period fullscreen.
        let upgrade = feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").expect("upgrade");
        assert_eq!(upgrade.to, TuiMode::Fullscreen);
        assert!(upgrade.via_alt_enter);
    }

    #[test]
    fn grid_policy_resizes_the_pty_to_the_client_viewport() {
        // apply_grid_if_tui is the low-level "apply, respecting the
        // fullscreen suppression hold" primitive used by the background
        // reselection path (see reselect_owner_on_departure); it applies
        // whatever grid it is given, unconditionally of who or why.
        // Re-asserting the SAME viewport emits no epoch (no spurious
        // SIGWINCH).
        let mut session = test_session("s1", "p1", "C:\\repo");
        let first = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(
            first,
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            }),
            "a viewport announcement resizes the PTY"
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.requested_viewport, Some((113, 39)));
        let repeat = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(repeat, None, "an unaltered viewport must not re-resize");
        assert_eq!(
            session.grid_epochs.len(),
            1,
            "the resize replaced the spawn epoch it sat on"
        );
        // A changed viewport resizes again.
        let second = apply_grid_if_tui(&mut session, 72, 26);
        assert_eq!(
            second,
            Some(GridEpoch {
                offset: 0,
                cols: 72,
                rows: 26
            })
        );
        assert_eq!(session.grid, (72, 26));
    }

    #[test]
    fn ownership_is_unaffected_by_tui_mode_transitions() {
        // The owner's grid applies unconditionally of TuiMode: there is no
        // background path (watchdog, detach, disconnect) that may resize a
        // session out from under its owner, in ANY mode - only another
        // claim, or the owner's own resize, ever moves the grid.
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        let window = TerminalController::Desktop("window-a".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 113, 39, false),
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            }),
            "the lone client becomes owner and its grid applies"
        );
        assert_eq!(session.owner, Some(window.clone()));
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[1;39r").is_none());
        // The owner's own resize still applies mid-TUI-period, with no
        // claim needed - it is already the owner.
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 90, 30, false),
            Some(GridEpoch {
                offset: 0,
                cols: 90,
                rows: 30
            })
        );
        assert_eq!(session.grid, (90, 30));
        assert_eq!(session.requested_viewport, Some((90, 30)));
        // Leaving the TUI period changes nothing about ownership.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        let exit = feed_session(&mut session, &mut clock, 350, "\r\n").expect("quiet exit");
        assert_eq!(exit.to, TuiMode::Canonical);
        assert_eq!(session.owner, Some(window));
        assert_eq!(
            session.grid,
            (90, 30),
            "no background resize on a mode transition"
        );
    }

    #[test]
    fn interaction_overrides_the_alt_suppression_hold() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        assert!(session.tui.grid_change_suppressed());
        // Real user action (typed key, click, tap) wins even while the
        // bare-shell-cycle suppression is up: the program redraws at the
        // new size.
        let epoch = apply_owner_grid(&mut session, 72, 26);
        assert_eq!(
            epoch,
            Some(GridEpoch {
                offset: 0,
                cols: 72,
                rows: 26
            })
        );
        assert_eq!(session.grid, (72, 26));
        assert!(
            session.tui.grid_change_suppressed(),
            "the hold itself is untouched"
        );
    }

    #[test]
    fn owner_grid_is_a_noop_when_the_size_matches() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        let first = apply_owner_grid(&mut session, 90, 30);
        assert_eq!(
            first,
            Some(GridEpoch {
                offset: 0,
                cols: 90,
                rows: 30
            })
        );
        assert_eq!(
            session.grid_epochs.len(),
            1,
            "the resize replaced the spawn epoch it sat on"
        );
        // Re-asserting the SAME size is a no-op: no extra epoch, no
        // spurious SIGWINCH for the running program.
        let repeat = apply_owner_grid(&mut session, 90, 30);
        assert_eq!(repeat, None);
        assert_eq!(
            session.grid_epochs.len(),
            1,
            "the resize replaced the spawn epoch it sat on"
        );
        assert_eq!(session.requested_viewport, Some((90, 30)));
    }

    #[test]
    fn owner_grid_clamps_degenerate_sizes() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        // A degenerate announce (0 rows, sub-2-column viewport) must not
        // panic or produce an unusable PTY grid.
        let epoch = apply_owner_grid(&mut session, 1, 0);
        assert_eq!(
            epoch,
            Some(GridEpoch {
                offset: 0,
                cols: 2,
                rows: 1
            })
        );
        assert_eq!(session.grid, (2, 1));
    }

    #[test]
    fn grid_policy_holds_the_grid_through_a_bare_alt_cycle() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // Canonical: the client's viewport applies immediately.
        assert!(apply_grid_if_tui(&mut session, 113, 39).is_some());
        assert_eq!(session.grid, (113, 39));
        // A bare alt-enter (the shell's Clear-Host) must not let a new
        // viewport announcement land a SIGWINCH mid-shell-state.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        let held = apply_grid_if_tui(&mut session, 90, 30);
        assert_eq!(held, None, "the grid is held through the bare alt cycle");
        assert_eq!(session.requested_viewport, Some((90, 30)));
        assert_eq!(session.grid, (113, 39));
        // A real TUI frame (DECSTBM) releases the hold: the recorded
        // viewport applies.
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[1;39r").is_none());
        let epoch = apply_grid_if_tui(&mut session, 90, 30);
        assert_eq!(
            epoch,
            Some(GridEpoch {
                offset: 0,
                cols: 90,
                rows: 30
            })
        );
        assert_eq!(session.grid, (90, 30));
        // Exit to canonical: the next client viewport applies again -
        // the grid is NOT frozen after a TUI period.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049l").is_none());
        assert!(feed_session(&mut session, &mut clock, 350, "\r\n").is_some());
        let resumed = apply_grid_if_tui(&mut session, 113, 39);
        assert_eq!(
            resumed,
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            })
        );
        assert_eq!(session.grid, (113, 39));
    }

    /// Mirror the `on_terminal_data` TUI-entry grid decision for one
    /// chunk: entering while suppressed defers the recorded viewport;
    /// a canonical exit clears a pending deferral first (nothing is
    /// restored and nothing fires on the exit chunk); a still-active
    /// deferral fires the moment paint evidence releases the
    /// suppression.
    fn on_chunk_tui_grid(
        session: &mut ManagedSession,
        tui_transition: Option<crate::tui::TuiTransition>,
    ) -> Option<GridEpoch> {
        let mut epoch = if tui_transition.is_some_and(|t| t.to != TuiMode::Canonical) {
            if session.tui.grid_change_suppressed() {
                session.deferred_tui_resize = true;
                None
            } else {
                session
                    .requested_viewport
                    .and_then(|(cols, rows)| apply_session_grid(session, cols, rows))
            }
        } else {
            None
        };
        if tui_transition.is_some_and(|t| t.to == TuiMode::Canonical) {
            session.deferred_tui_resize = false;
        }
        if session.deferred_tui_resize && !session.tui.grid_change_suppressed() {
            session.deferred_tui_resize = false;
            epoch = session
                .requested_viewport
                .and_then(|(cols, rows)| apply_session_grid(session, cols, rows));
        }
        epoch
    }

    #[test]
    fn deferred_alt_resize_fires_on_real_tui_paint() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        // The focused client's viewport is recorded while the shell is
        // canonical (forced fit on every keystroke).
        session.requested_viewport = Some((113, 39));
        session.buffer.push_str(&"a".repeat(100));
        session.journal_len = 100;
        // Bare alt-enter (a real TUI like vim): the entry chunk defers
        // the resize instead of landing a SIGWINCH on an unpainted
        // program.
        let entry = feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").expect("alt-enter");
        assert!(entry.via_alt_enter);
        assert_eq!(on_chunk_tui_grid(&mut session, Some(entry)), None);
        assert!(session.deferred_tui_resize);
        assert_eq!(session.grid, (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS));
        assert_eq!(session.grid_epochs.len(), 1);
        // The program's first painted frame (DECSTBM + hidden multi-row
        // CUP) releases the suppression: the recorded viewport fires as
        // a journal epoch at the current offset.
        let frame = feed_session(&mut session, &mut clock, 5, "\x1b[?25l\x1b[1;39r\x1b[5;10H");
        assert_eq!(
            on_chunk_tui_grid(&mut session, frame),
            Some(GridEpoch {
                offset: 100,
                cols: 113,
                rows: 39
            })
        );
        assert!(!session.deferred_tui_resize);
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.grid_epochs.len(), 2);
        // Exit: the TUI re-shows its cursor, leaves the alt screen, and
        // goes quiet: the grid freezes at the TUI size, nothing is
        // restored.
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?25h\x1b[?1049l").is_none());
        let exit = feed_session(&mut session, &mut clock, 350, "\r\n").expect("quiet exit");
        assert_eq!(on_chunk_tui_grid(&mut session, Some(exit)), None);
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.grid_epochs.len(), 2);
    }

    #[test]
    fn bare_shell_alt_cycle_never_fires_the_deferred_resize() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        session.requested_viewport = Some((79, 26));
        // PSReadLine's Clear-Host: alt-enter, hidden row-1 prompt
        // redraws, alt-exit, main-screen backspace redraws (hidden CUP
        // past row 1 on the MAIN screen - not paint evidence), quiet
        // exit. No DECSTBM ever appears while the program's alt screen
        // is open, so the grid must never move.
        let entry = feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").expect("alt-enter");
        assert_eq!(on_chunk_tui_grid(&mut session, Some(entry)), None);
        assert!(session.deferred_tui_resize);
        let alt_content = feed_session(
            &mut session,
            &mut clock,
            5,
            "\x1b[?25l\x1b[HPS C:\\> \x1b[?25h",
        );
        assert_eq!(on_chunk_tui_grid(&mut session, alt_content), None);
        assert!(session.deferred_tui_resize, "still held mid-alt-cycle");
        let alt_out = feed_session(&mut session, &mut clock, 10, "\x1b[?1049l");
        assert_eq!(on_chunk_tui_grid(&mut session, alt_out), None);
        assert!(
            session.deferred_tui_resize,
            "pending until the period exits"
        );
        let redraw = feed_session(
            &mut session,
            &mut clock,
            5,
            "\x1b[?25l\x1b[6;11HPS C:\\> \x1b[?25h",
        );
        assert_eq!(on_chunk_tui_grid(&mut session, redraw), None);
        let exit = feed_session(&mut session, &mut clock, 350, "\r\n").expect("quiet exit");
        assert_eq!(on_chunk_tui_grid(&mut session, Some(exit)), None);
        assert!(
            !session.deferred_tui_resize,
            "deferral cleared on canonical exit"
        );
        assert_eq!(session.grid, (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS));
        assert_eq!(session.grid_epochs.len(), 1, "no epoch was ever emitted");
        // After the cycle the shell is idle at the prompt: a client
        // resize applies normally again (no desync risk at the prompt).
        let resumed = apply_grid_if_tui(&mut session, 79, 26);
        assert_eq!(
            resumed,
            Some(GridEpoch {
                offset: 0,
                cols: 79,
                rows: 26
            })
        );
        assert_eq!(session.grid, (79, 26));
    }

    #[test]
    fn a_lone_client_claims_ownership_and_sizes_the_pty() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        assert_eq!(session.owner, None, "an unviewed session has no owner");
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 113, 39, false),
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            }),
            "an ownerless session claims itself onto the first client to announce"
        );
        assert_eq!(session.owner, Some(window.clone()));
        assert_eq!(session.grid, (113, 39));
        // The owner re-asserting the same size emits no second epoch (no
        // spurious SIGWINCH).
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 113, 39, false),
            None
        );
        assert_eq!(
            session.grid_epochs.len(),
            1,
            "the resize replaced the spawn epoch it sat on"
        );
    }

    #[test]
    fn an_unclaimed_announce_from_a_non_owner_never_resizes_the_pty() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, false).is_some());
        // The phone announces a much smaller, then a much larger viewport,
        // neither claimed: the owner's grid is untouched either way, but
        // both are recorded (candidates for reselect_owner_on_departure).
        set_client_viewport(&mut session, phone.clone(), 45, 20);
        assert_eq!(
            apply_owner_grid_for(&mut session, &phone, 45, 20, false),
            None
        );
        assert_eq!(session.grid, (113, 39));
        set_client_viewport(&mut session, phone.clone(), 250, 80);
        assert_eq!(
            apply_owner_grid_for(&mut session, &phone, 250, 80, false),
            None,
            "a non-owner can never resize the pty, larger or smaller"
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(
            session.viewports.get(&phone).map(|v| (v.cols, v.rows)),
            Some((250, 80))
        );
        assert_eq!(session.owner, Some(window));
    }

    #[test]
    fn a_claim_takes_ownership_over_verbatim_regardless_of_size() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 200, 60);
        assert!(apply_owner_grid_for(&mut session, &window, 200, 60, false).is_some());
        // A tap on the phone claims the grid over, at the phone's own
        // size - even though it is far smaller than the desktop's.
        set_client_viewport(&mut session, phone.clone(), 45, 20);
        assert_eq!(
            apply_owner_grid_for(&mut session, &phone, 45, 20, true),
            Some(GridEpoch {
                offset: 0,
                cols: 45,
                rows: 20
            })
        );
        assert_eq!(session.grid, (45, 20));
        assert_eq!(session.owner, Some(phone));
    }

    #[test]
    fn the_owners_own_resize_keeps_applying_without_a_claim() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, false).is_some());
        // The owner's window naturally resizes: a plain layout announce,
        // no claim, but it still applies because it is already the owner.
        set_client_viewport(&mut session, window.clone(), 160, 45);
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 160, 45, false),
            Some(GridEpoch {
                offset: 0,
                cols: 160,
                rows: 45
            })
        );
        assert_eq!(session.grid, (160, 45));
    }

    #[test]
    fn reconnect_under_the_same_device_key_replaces_the_entry_without_a_new_epoch() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let phone = TerminalController::Remote("phone-device".into());
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert!(apply_owner_grid_for(&mut session, &phone, 45, 36, false).is_some());
        let epochs = session.grid_epochs.len();
        // The phone drops and reconnects on a new socket under the same
        // device id: the entry is replaced atomically, and an unchanged
        // viewport must not resize the PTY even without a claim (it is
        // already the owner).
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert_eq!(
            apply_owner_grid_for(&mut session, &phone, 45, 36, false),
            None
        );
        assert_eq!(session.grid_epochs.len(), epochs);
        assert_eq!(session.viewports.len(), 1);
    }

    #[test]
    fn watchdog_evicts_stale_networked_entries_but_never_a_desktop_entry() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let now = Instant::now();
        let stale = now - Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS + 100);
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert!(apply_owner_grid_for(&mut session, &phone, 45, 36, true).is_some());
        assert_eq!(session.grid, (45, 36));
        session
            .viewports
            .get_mut(&phone)
            .expect("recorded phone entry")
            .last_seen = stale;
        let timeout = std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS);
        let evicted = evict_stale_viewports(&mut session, now, timeout);
        assert_eq!(evicted.len(), 1, "the stale networked entry is evicted");
        assert_eq!(session.viewports.len(), 1);
        assert!(session.viewports.contains_key(&window));
        assert_eq!(session.viewports.get(&window).unwrap().networked, false);
        assert_eq!(
            reselect_owner_on_departure(&mut session, &evicted),
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            }),
            "the departed phone owner hands the grid to the surviving desktop pane"
        );
        assert_eq!(session.owner, Some(window));
        assert!(
            evict_stale_viewports(&mut session, now, timeout).is_empty(),
            "a second sweep is a no-op"
        );
    }

    #[test]
    fn watchdog_evicts_only_stale_members_of_a_mixed_set() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let now = Instant::now();
        let stale = now - Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS + 100);
        let window = TerminalController::Desktop("window".into());
        let phone_a = TerminalController::Remote("phone-a".into());
        let phone_b = TerminalController::Remote("phone-b".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone_a.clone(), 45, 36);
        set_client_viewport(&mut session, phone_b.clone(), 100, 20);
        assert!(apply_owner_grid_for(&mut session, &phone_a, 45, 36, true).is_some());
        session
            .viewports
            .get_mut(&phone_a)
            .expect("stale entry")
            .last_seen = stale;
        let timeout = std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS);
        let evicted = evict_stale_viewports(&mut session, now, timeout);
        assert_eq!(evicted, vec![phone_a.clone()]);
        assert!(
            session.viewports.contains_key(&phone_b),
            "the still-live networked entry survives"
        );
        assert!(
            session.viewports.contains_key(&window),
            "the desktop entry survives even a stale clock"
        );
        // phone-a owned the grid; its eviction hands ownership to whichever
        // survivor was most recently active - phone-b, announced after the
        // window.
        assert_eq!(
            reselect_owner_on_departure(&mut session, &evicted),
            Some(GridEpoch {
                offset: 0,
                cols: 100,
                rows: 20
            })
        );
        assert_eq!(session.owner, Some(phone_b));
    }

    #[test]
    fn evicting_a_non_owner_produces_no_grid_epoch() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let now = Instant::now();
        let stale = now - Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS + 100);
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone.clone(), 150, 60);
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 113, 39, false),
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            })
        );
        let epochs = session.grid_epochs.len();
        // The phone never claimed ownership: its eviction must not resize
        // (no redundant SIGWINCH) even though the set changed.
        session
            .viewports
            .get_mut(&phone)
            .expect("stale entry")
            .last_seen = stale;
        let timeout = std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS);
        let evicted = evict_stale_viewports(&mut session, now, timeout);
        assert_eq!(evicted, vec![phone]);
        assert_eq!(reselect_owner_on_departure(&mut session, &evicted), None);
        assert_eq!(session.grid_epochs.len(), epochs);
        assert_eq!(session.grid, (113, 39));
    }

    #[test]
    fn disconnecting_a_non_owner_keeps_the_owner_grid() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert_eq!(
            apply_owner_grid_for(&mut session, &window, 113, 39, true),
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            })
        );
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[1;39r").is_none());
        let epochs = session.grid_epochs.len();
        // The phone is not the owner: its departure must not resize the
        // running program out from under its owner.
        session.viewports.remove(&phone);
        assert_eq!(
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&phone)),
            None
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.grid_epochs.len(), epochs);
        // A controller with no entry in set S (and that never owned
        // anything) departing is also a no-op.
        let ghost = TerminalController::Remote("ghost".into());
        assert_eq!(
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&ghost)),
            None
        );
        assert_eq!(session.grid, (113, 39));
    }

    #[test]
    fn disconnecting_the_owner_reselects_the_most_recently_active_survivor() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        let window = TerminalController::Desktop("window".into());
        let phone_a = TerminalController::Remote("phone-a".into());
        let phone_b = TerminalController::Remote("phone-b".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        // phone-a is wider than phone-b: a size-based reselection would
        // pick phone-b. Recency-based reselection must not.
        set_client_viewport(&mut session, phone_a.clone(), 100, 20);
        set_client_viewport(&mut session, phone_b.clone(), 45, 36);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[1;39r").is_none());
        // phone-a announces again (still unclaimed, just a passive
        // resize), becoming the most recently active viewer.
        set_client_viewport(&mut session, phone_a.clone(), 100, 20);
        session.viewports.remove(&window);
        assert_eq!(
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&window)),
            Some(GridEpoch {
                offset: 0,
                cols: 100,
                rows: 20
            }),
            "the most recently active survivor takes over, even though phone-b's dimensions are smaller"
        );
        assert_eq!(session.grid, (100, 20));
        assert_eq!(session.owner, Some(phone_a));
        assert_eq!(session.requested_viewport, Some((100, 20)));
    }

    #[test]
    fn disconnecting_the_sole_owner_keeps_the_last_grid_and_clears_ownership() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        // With one client, its departure leaves no survivor to take over,
        // so the PTY keeps the last grid and the session goes ownerless.
        session.viewports.remove(&window);
        assert_eq!(
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&window)),
            None,
            "no survivor to take over"
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.owner, None);
        // A later announce from anyone reclaims ownership (the first-
        // claimant bootstrap), even without a claim.
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert_eq!(
            apply_owner_grid_for(&mut session, &phone, 45, 36, false),
            Some(GridEpoch {
                offset: 0,
                cols: 45,
                rows: 36
            })
        );
        assert_eq!(session.owner, Some(phone));
    }

    #[test]
    fn releasing_a_viewport_hands_the_grid_to_the_remaining_client() {
        // release_viewport is what a hidden desktop tab and a backgrounded
        // phone both call (session.viewport.release / a window losing
        // focus) - it must resolve identically to a real departure.
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        assert_eq!(
            release_viewport(&mut session, &window),
            Some(GridEpoch {
                offset: 0,
                cols: 45,
                rows: 36
            }),
            "the sole survivor takes over"
        );
        assert_eq!(session.grid, (45, 36));
        assert_eq!(session.owner, Some(phone));
        assert!(
            !session.viewports.contains_key(&window),
            "the releasing client leaves set S"
        );
    }

    #[test]
    fn releasing_a_non_owner_keeps_the_owner_grid() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone.clone(), 45, 36);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        assert_eq!(
            release_viewport(&mut session, &phone),
            None,
            "a non-owner's departure is a no-op"
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.owner, Some(window));
        assert!(!session.viewports.contains_key(&phone));
    }

    #[test]
    fn releasing_the_sole_viewer_keeps_the_last_grid_and_clears_ownership() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        assert_eq!(
            release_viewport(&mut session, &window),
            None,
            "no survivor to take over"
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.owner, None);
    }

    #[test]
    fn an_unclaimed_attach_never_joins_the_viewport_set() {
        // A desktop tab that mounts in the background, or a device
        // re-requesting the buffer, must not size the PTY or become a
        // reselection candidate while it is not actually shown.
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        let background = TerminalController::Desktop("background-window".into());
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        assert_eq!(
            attach_owner_grid_for(&mut session, &background, 210, 66, false),
            None
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.owner, Some(window.clone()));
        assert!(
            !session.viewports.contains_key(&background),
            "an unclaimed attach is a pure stream subscription, not a member of set S"
        );
        // Departing the (unregistered) background attach is a no-op, and
        // departing the real owner has no fallback candidate to reselect.
        assert_eq!(release_viewport(&mut session, &background), None);
        assert_eq!(release_viewport(&mut session, &window), None);
        assert_eq!(session.owner, None);
        assert_eq!(session.grid, (113, 39));
    }

    #[test]
    fn a_claimed_attach_joins_the_viewport_set_and_takes_ownership() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        assert_eq!(
            attach_owner_grid_for(&mut session, &phone, 45, 36, true),
            Some(GridEpoch {
                offset: 0,
                cols: 45,
                rows: 36
            }),
            "opening a terminal claims the grid back from whoever held it"
        );
        assert_eq!(session.grid, (45, 36));
        assert_eq!(session.owner, Some(phone.clone()));
        assert_eq!(
            session.viewports.get(&phone).map(|v| (v.cols, v.rows)),
            Some((45, 36))
        );
    }

    #[test]
    fn successor_selection_is_deterministic_when_last_active_ties() {
        // Two viewports that share the exact same last_active instant (the
        // resolution of the clock, or two announces landing in the same
        // tick) must still resolve to the same survivor regardless of
        // HashMap iteration order - proven here by inserting them in both
        // orders and checking the pick does not flip.
        let window = TerminalController::Desktop("window".into());
        let phone_a = TerminalController::Remote("phone-a".into());
        let phone_b = TerminalController::Remote("phone-b".into());
        let tie = |first: &TerminalController, second: &TerminalController| {
            let mut session = test_session("s1", "p1", "C:\\repo");
            set_client_viewport(&mut session, window.clone(), 113, 39);
            assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
            set_client_viewport(&mut session, first.clone(), 45, 36);
            set_client_viewport(&mut session, second.clone(), 100, 20);
            let tied = session
                .viewports
                .get(first)
                .expect("first entry")
                .last_active;
            session
                .viewports
                .get_mut(second)
                .expect("second entry")
                .last_active = tied;
            session.viewports.remove(&window);
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&window))
                .map(|_| session.owner.clone())
        };
        assert_eq!(
            tie(&phone_a, &phone_b),
            tie(&phone_b, &phone_a),
            "the same tie must resolve to the same successor regardless of insertion order"
        );
    }

    #[test]
    fn sweep_evicting_the_owner_reselects_a_survivor() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        let phone_a = TerminalController::Remote("phone-a".into());
        let phone_b = TerminalController::Remote("phone-b".into());
        set_client_viewport(&mut session, phone_a.clone(), 45, 36);
        set_client_viewport(&mut session, phone_b.clone(), 100, 20);
        assert!(apply_owner_grid_for(&mut session, &phone_a, 45, 36, true).is_some());
        assert_eq!(session.grid, (45, 36));
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[1;39r").is_none());
        let now = Instant::now();
        session
            .viewports
            .get_mut(&phone_a)
            .expect("recorded owner entry")
            .last_seen = now - Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS + 100);
        let timeout = std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS);
        let evicted = evict_stale_viewports(&mut session, now, timeout);
        assert_eq!(evicted, vec![phone_a]);
        assert_eq!(
            reselect_owner_on_departure(&mut session, &evicted),
            Some(GridEpoch {
                offset: 0,
                cols: 100,
                rows: 20
            }),
            "the surviving client's announced size takes over the grid"
        );
        assert_eq!(session.grid, (100, 20));
        assert_eq!(session.owner, Some(phone_b));
    }

    #[test]
    fn sweep_evicting_a_non_owner_keeps_the_owner_grid() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        let phone_a = TerminalController::Remote("phone-a".into());
        let phone_b = TerminalController::Remote("phone-b".into());
        set_client_viewport(&mut session, phone_a.clone(), 45, 36);
        set_client_viewport(&mut session, phone_b.clone(), 100, 20);
        assert!(apply_owner_grid_for(&mut session, &phone_b, 100, 20, true).is_some());
        assert_eq!(session.grid, (100, 20));
        assert!(feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").is_some());
        assert!(feed_session(&mut session, &mut clock, 5, "\x1b[1;39r").is_none());
        let now = Instant::now();
        session
            .viewports
            .get_mut(&phone_a)
            .expect("recorded non-owner entry")
            .last_seen = now - Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS + 100);
        let timeout = std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS);
        let evicted = evict_stale_viewports(&mut session, now, timeout);
        assert_eq!(evicted, vec![phone_a]);
        let epochs = session.grid_epochs.len();
        assert_eq!(reselect_owner_on_departure(&mut session, &evicted), None);
        assert_eq!(session.grid, (100, 20));
        assert_eq!(session.grid_epochs.len(), epochs);
    }

    #[test]
    fn watchdog_sweep_binds_at_the_exact_timeout_boundary() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let now = Instant::now();
        let timeout = std::time::Duration::from_millis(VIEWPORT_WATCHDOG_TIMEOUT_MS);
        set_client_viewport(
            &mut session,
            TerminalController::Desktop("window".into()),
            113,
            39,
        );
        set_client_viewport(
            &mut session,
            TerminalController::Remote("exact".into()),
            45,
            36,
        );
        set_client_viewport(
            &mut session,
            TerminalController::Remote("fresh".into()),
            50,
            30,
        );
        // An entry exactly the timeout old is stale: the sweep keeps only
        // entries strictly younger than the timeout. The desktop pane is
        // ancient but never expires.
        session
            .viewports
            .get_mut(&TerminalController::Remote("exact".into()))
            .expect("recorded entry")
            .last_seen = now - timeout;
        session
            .viewports
            .get_mut(&TerminalController::Remote("fresh".into()))
            .expect("recorded entry")
            .last_seen = now - timeout + Duration::from_millis(1);
        let evicted = evict_stale_viewports(&mut session, now, timeout);
        assert_eq!(evicted.len(), 1, "only the exactly-stale entry is evicted");
        assert!(
            !session
                .viewports
                .contains_key(&TerminalController::Remote("exact".into()))
        );
        assert!(
            session
                .viewports
                .contains_key(&TerminalController::Remote("fresh".into()))
        );
        assert!(
            session
                .viewports
                .contains_key(&TerminalController::Desktop("window".into()))
        );
    }

    #[test]
    fn a_departure_with_no_recorded_entry_leaves_the_grid_untouched() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let window = TerminalController::Desktop("window".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        assert!(apply_owner_grid_for(&mut session, &window, 113, 39, true).is_some());
        let epochs = session.grid_epochs.len();
        // A controller that never announced into this session at all
        // departs: it cannot have been the owner, so nothing changes.
        let ghost = TerminalController::Remote("ghost".into());
        assert_eq!(
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&ghost)),
            None
        );
        assert_eq!(session.grid, (113, 39));
        assert_eq!(session.grid_epochs.len(), epochs);
    }

    #[test]
    fn disconnect_during_a_suppressed_hold_defers_the_reselected_owner() {
        let mut session = test_session("s1", "p1", "C:\\repo");
        let mut clock = Instant::now();
        let window = TerminalController::Desktop("window".into());
        let phone = TerminalController::Remote("phone".into());
        set_client_viewport(&mut session, window.clone(), 113, 39);
        set_client_viewport(&mut session, phone.clone(), 72, 26);
        assert!(apply_owner_grid_for(&mut session, &phone, 72, 26, true).is_some());
        assert_eq!(session.grid, (72, 26));
        // A bare alt-enter raises the suppression hold: no SIGWINCH may
        // land while the program's alt cycle is in flight.
        let entry = feed_session(&mut session, &mut clock, 10, "\x1b[?1049h").expect("alt enter");
        assert_eq!(on_chunk_tui_grid(&mut session, Some(entry)), None);
        // The owning phone disconnects mid-hold: the reselected
        // survivor's grid (113, 39) is recorded but must not resize the
        // unpainted program.
        session.viewports.remove(&phone);
        assert_eq!(
            reselect_owner_on_departure(&mut session, std::slice::from_ref(&phone)),
            None,
            "the reselection is held with the bare alt cycle"
        );
        assert_eq!(session.grid, (72, 26));
        assert_eq!(session.owner, Some(window.clone()));
        assert_eq!(session.requested_viewport, Some((113, 39)));
        // The first painted frame releases the hold: the deferred
        // reselection fires exactly where the deferred-alt-resize path
        // fires, as a journaled epoch.
        let frame = feed_session(&mut session, &mut clock, 5, "\x1b[?25l\x1b[1;39r\x1b[5;10H");
        assert_eq!(
            on_chunk_tui_grid(&mut session, frame),
            Some(GridEpoch {
                offset: 0,
                cols: 113,
                rows: 39
            })
        );
        assert_eq!(session.grid, (113, 39));
    }

    #[test]
    fn log_escape_renders_input_bytes_for_the_sync_log() {
        assert_eq!(log_escape("ls\r", 48), "ls\\r");
        assert_eq!(log_escape("\x1b[?1049h", 48), "\\u{1b}[?1049h");
        assert_eq!(log_escape("abcdefgh", 5), "abcde\u{2026}");
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
            viewing_session_ids: Vec::new(),
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
    fn snapshot_reports_the_sessions_each_device_is_viewing() {
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
            viewing_session_ids: Vec::new(),
        };
        store
            .authorize_device(device("phone-a", "Pixel 7"), "cred-a")
            .expect("authorize first device");
        store
            .authorize_device(device("phone-b", "Galaxy S23"), "cred-b")
            .expect("authorize second device");
        let mut inner = test_inner(store, Vec::new());
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work"));
        inner.session_order = vec!["s1".into(), "s2".into()];
        // phone-a has both terminals open, phone-b only the second; the
        // desktop pane in s1 is not a device and must not appear anywhere.
        for session_id in ["s1", "s2"] {
            let session = inner.sessions.get_mut(session_id).expect("session");
            set_client_viewport(
                session,
                TerminalController::Remote("phone-a".into()),
                80,
                24,
            );
        }
        let second = inner.sessions.get_mut("s2").expect("session");
        set_client_viewport(second, TerminalController::Remote("phone-b".into()), 45, 36);
        let first = inner.sessions.get_mut("s1").expect("session");
        set_client_viewport(
            first,
            TerminalController::Desktop("window-a".into()),
            120,
            40,
        );

        let online = HashSet::from(["phone-a".to_string(), "phone-b".to_string()]);
        let snapshot = snapshot_from_inner(&inner, &online);
        let viewing = |id: &str| {
            snapshot
                .devices
                .iter()
                .find(|device| device.id == id)
                .expect("device in snapshot")
                .viewing_session_ids
                .clone()
        };
        assert_eq!(viewing("phone-a"), vec!["s1".to_string(), "s2".to_string()]);
        assert_eq!(viewing("phone-b"), vec!["s2".to_string()]);

        // Leaving a session's viewport set drops it from the device's list.
        let second = inner.sessions.get_mut("s2").expect("session");
        second
            .viewports
            .remove(&TerminalController::Remote("phone-b".into()));
        let snapshot = snapshot_from_inner(&inner, &online);
        assert!(
            snapshot
                .devices
                .iter()
                .find(|device| device.id == "phone-b")
                .expect("device in snapshot")
                .viewing_session_ids
                .is_empty(),
            "a device with no viewport entries is viewing nothing"
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
    fn a_pending_focus_is_claimed_once_by_the_window_it_names() {
        let mut pending = Some(PendingFocus {
            label: "main".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now(),
        });

        let claimed = claim_pending_focus(&mut pending, "main").expect("claimed");
        assert_eq!(claimed.project_id, "p1");
        assert_eq!(claimed.session_id, "s1");
        assert!(
            pending.is_none(),
            "claiming clears the entry so a second window cannot act on it too"
        );
        assert!(claim_pending_focus(&mut pending, "main").is_none());
    }

    #[test]
    fn a_pending_focus_for_another_window_is_left_for_its_owner() {
        let mut pending = Some(PendingFocus {
            label: "main".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now(),
        });

        assert!(claim_pending_focus(&mut pending, "second").is_none());
        assert!(
            pending.is_some(),
            "the entry survives so the window it names can still claim it"
        );
        assert!(claim_pending_focus(&mut pending, "main").is_some());
    }

    #[test]
    fn a_focus_recorded_for_a_not_yet_loaded_window_is_claimed_when_it_mounts() {
        // The handoff opened a window for the console's project; its
        // webview is still loading, so the focus sits recorded against the
        // label until that window's renderer mounts and claims it.
        let mut pending = Some(PendingFocus {
            label: "terminal-fresh".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now(),
        });

        let claimed = claim_pending_focus(&mut pending, "terminal-fresh").expect("claimed");
        assert_eq!(claimed.session_id, "s1");
        assert!(pending.is_none());
    }

    #[test]
    fn an_expired_pending_focus_is_dropped_rather_than_shown_late() {
        let mut pending = Some(PendingFocus {
            label: "main".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now() - PENDING_FOCUS_TTL - std::time::Duration::from_secs(1),
        });

        assert!(claim_pending_focus(&mut pending, "main").is_none());
        assert!(
            pending.is_none(),
            "an expired focus is cleared so a much later window is not yanked onto a stale tab"
        );
    }

    #[test]
    fn no_pending_focus_claims_nothing() {
        let mut pending = None;
        assert!(claim_pending_focus(&mut pending, "main").is_none());
    }

    #[test]
    fn a_pending_focus_at_exactly_its_ttl_is_expired() {
        // The boundary uses `>=`, so a focus that has lived out its full
        // TTL is dropped even though the claim arrives (nanoseconds) later.
        let mut pending = Some(PendingFocus {
            label: "main".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now() - PENDING_FOCUS_TTL,
        });

        assert!(claim_pending_focus(&mut pending, "main").is_none());
        assert!(
            pending.is_none(),
            "the entry is cleared at the boundary, not left for a later claim"
        );
    }

    #[test]
    fn a_pending_focus_one_tick_before_its_ttl_is_still_claimable() {
        let mut pending = Some(PendingFocus {
            label: "main".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now() - (PENDING_FOCUS_TTL - Duration::from_millis(1)),
        });

        assert!(
            claim_pending_focus(&mut pending, "main").is_some(),
            "inside the TTL the focus is still fresh"
        );
    }

    #[test]
    fn an_expired_focus_is_cleared_even_when_its_window_never_mounts() {
        // Expiry is checked before the label, so a focus recorded for a
        // window that never loaded its webview cannot outlive its TTL and
        // yank some later claim onto a stale tab.
        let mut pending = Some(PendingFocus {
            label: "terminal-never-mounted".into(),
            project_id: "p1".into(),
            session_id: "s1".into(),
            at: Instant::now() - PENDING_FOCUS_TTL - Duration::from_secs(1),
        });

        assert!(claim_pending_focus(&mut pending, "main").is_none());
        assert!(pending.is_none(), "the expired entry is cleared for good");
    }

    #[test]
    fn a_newer_handoff_focus_replaces_the_older_unclaimed_one() {
        // Two consoles launched back to back while no window is open: the
        // window the second handoff opens must show the newest console, so
        // the older focus must not pull it back to the older tab.
        let mut pending: Option<PendingFocus> = None;
        record_pending_focus(&mut pending, "terminal-old", "p1", "s1");
        record_pending_focus(&mut pending, "terminal-new", "p2", "s2");

        let claimed = claim_pending_focus(&mut pending, "terminal-new").expect("the newest wins");
        assert_eq!(claimed.project_id, "p2");
        assert_eq!(claimed.session_id, "s2");
        assert!(
            claim_pending_focus(&mut pending, "terminal-old").is_none(),
            "the replaced focus is gone, not just unclaimed"
        );
    }

    /// A writer whose consumer never reads: the shape of a handed-off console
    /// that has stopped draining its input pipe.
    struct StalledWriter;

    impl std::io::Write for StalledWriter {
        fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
            std::thread::sleep(std::time::Duration::from_secs(60));
            unreachable!("the test finishes long before this returns");
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writing_to_a_console_that_stopped_reading_never_blocks_the_caller() {
        // The regression this guards: the write ran inline, on the UI thread,
        // holding the desktop lock, so one wedged console froze every window.
        let writer = SessionWriter::spawn("stalled", Box::new(StalledWriter));
        let started = Instant::now();
        // Far past the queue depth, so the bounded channel is full for most
        // of these and the drop path is exercised too.
        for _ in 0..1_000 {
            writer.write("stalled", "ls\r");
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "queued writes must not wait on the console; took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_project_rooted_in_the_system_directory_still_claims_its_consoles() {
        // `is_system_directory` only decides the *fallback*: a user who
        // really does keep a project there still gets their console filed
        // under it.
        let (store, state_path) = store_with_cleanup();
        let mut inner = test_inner(store, Vec::new());
        test_project(&mut inner, "saved-system", "C:\\Windows\\System32", true);

        let matched = project_for_directory(&inner, "C:\\Windows\\System32")
            .expect("a project rooted at the system directory matches");
        assert_eq!(matched.id, "saved-system");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn recognizes_only_complete_device_attributes_reports() {
        assert!(is_device_attributes_report("\x1b[?1;2c"));
        assert!(is_device_attributes_report("\x1b[?62;22c"));
        assert!(is_device_attributes_report("\x1b[>0;10;1c"));
        // A primary DA query, not a reply.
        assert!(!is_device_attributes_report("\x1b[c"));
        assert!(!is_device_attributes_report("\x1b[?1;2ctail"));
        assert!(!is_device_attributes_report("\x1b[1;2c"));
        assert!(!is_device_attributes_report("\x1b[?12;34R"));
    }

    #[test]
    fn records_live_device_attribute_queries_even_when_split_across_output_chunks() {
        let mut tail = String::new();
        assert_eq!(record_device_attribute_requests(&mut tail, "\x1b[c"), 1);
        assert_eq!(record_device_attribute_requests(&mut tail, "\x1b[>"), 0);
        assert_eq!(record_device_attribute_requests(&mut tail, "c"), 1);
        assert_eq!(
            record_device_attribute_requests(&mut tail, "\x1b[0c\x1b[=c"),
            2
        );
        // A DA reply in the stream is not a query.
        assert_eq!(record_device_attribute_requests(&mut tail, "\x1b[?1;2c"), 0);
    }

    #[test]
    fn counts_a_device_attributes_query_split_at_every_offset() {
        // The longest query is five bytes, so it can be cut four ways; each
        // has to survive the chunk boundary or a live reply gets dropped.
        let query = "\x1b[>0c";
        for split in 1..query.len() {
            let mut tail = String::new();
            assert_eq!(
                record_device_attribute_requests(&mut tail, &query[..split]),
                0,
                "the leading half is not a query on its own"
            );
            assert_eq!(
                record_device_attribute_requests(&mut tail, &query[split..]),
                1,
                "a query split at byte {split} is still counted once"
            );
        }
    }

    #[test]
    fn cursor_position_and_device_attributes_replies_are_told_apart() {
        // Both are CSI sequences answering a query; each guard must ignore
        // the other's replies or one counter drains the wrong pending count.
        assert!(!is_device_attributes_report("\x1b[12;34R"));
        assert!(!is_cursor_position_report("\x1b[?1;2c"));
        assert!(!is_cursor_position_report("\x1b[>0;10;1c"));
    }

    #[test]
    fn treats_the_windows_directory_as_no_project_location() {
        assert!(is_system_directory("C:\\Windows\\System32"));
        assert!(is_system_directory("c:\\windows"));
        assert!(!is_system_directory("C:\\Users\\edzch"));
        assert!(!is_system_directory("C:\\WindowsProjects"));
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
            assert_eq!(
                registration_status_for_display(true, true, stored, false),
                stored
            );
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
        assert_eq!(
            registration_status_for_display(true, true, "pending", false),
            "pending"
        );
        assert_eq!(
            registration_status_for_display(true, true, "enrolled", false),
            "enrolled"
        );
        assert_eq!(
            registration_status_for_display(true, true, "failed", false),
            "failed"
        );
        assert_eq!(
            registration_status_for_display(true, true, "unregistered", false),
            "unregistered"
        );
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
    fn a_snapshot_corrects_a_wrong_mode_terminal_scheme_before_clients_see_it() {
        // The settings file is editable, and an older or hostile client could
        // write anything. Every client resolves the pair straight into xterm,
        // so a light scheme in the dark slot would paint an unreadable
        // terminal; the snapshot repairs it on the way out.
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        store
            .set_terminal_theme("vintage".into(), "novel".into())
            .expect("valid pair");

        let mut inner = test_inner(store, vec![shell_profile("powershell")]);
        let snapshot = snapshot_from_inner(&inner, &HashSet::new());
        assert_eq!(snapshot.terminal_theme.dark_scheme_id, "vintage");
        assert_eq!(snapshot.terminal_theme.light_scheme_id, "novel");

        // Swap the slots the way a hand-edited file or a downgraded build
        // would: the store writes what it is given, and only Core's setter
        // normalizes, so this is exactly a bad value already on disk.
        inner
            .store
            .set_terminal_theme("novel".into(), "vintage".into())
            .expect("stale swapped pair");
        let repaired = snapshot_from_inner(&inner, &HashSet::new());
        assert_eq!(
            repaired.terminal_theme.dark_scheme_id,
            crate::models::DEFAULT_DARK_TERMINAL_SCHEME_ID,
            "a light scheme in the dark slot falls back"
        );
        assert_eq!(
            repaired.terminal_theme.light_scheme_id,
            crate::models::DEFAULT_LIGHT_TERMINAL_SCHEME_ID,
            "a dark scheme in the light slot falls back"
        );

        // An id from no scheme at all falls back the same way.
        inner
            .store
            .set_terminal_theme("not-a-scheme".into(), "novel".into())
            .expect("unknown id");
        assert_eq!(
            snapshot_from_inner(&inner, &HashSet::new())
                .terminal_theme
                .dark_scheme_id,
            crate::models::DEFAULT_DARK_TERMINAL_SCHEME_ID
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn setting_a_wrong_mode_terminal_scheme_stores_the_default_instead() {
        let test_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-state");
        fs::create_dir_all(&test_root).expect("test state directory");
        let state_path = test_root.join(format!("{}.json", Uuid::new_v4()));
        let mut store = DesktopStore::load(state_path.clone()).expect("initial store");
        // set_terminal_theme normalizes, so the bad value never reaches disk.
        store
            .set_terminal_theme(
                crate::models::normalize_terminal_scheme_id("novel", true),
                crate::models::normalize_terminal_scheme_id("vintage", false),
            )
            .expect("normalized pair");
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
        inner
            .store
            .set_default_shell("removed-profile".into())
            .expect("stale value");
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
        let temporary = test_project(&mut inner, "temp-home", home.to_lowercase().as_str(), false);

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
        assert_eq!(
            picked.id, existing.id,
            "the existing temporary home project is reused"
        );
        assert_eq!(
            inner.temporary_projects.len(),
            1,
            "no second home project appears"
        );

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
            RetireOutcome::NotEligible
        ));
        assert!(inner.project_order.is_empty());

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn normal_exit_closes_the_tab_and_never_kills_the_dead_process() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        let killed = Arc::new(AtomicBool::new(false));
        let session = test_session_with_killer(
            "s1",
            "p",
            r"C:\Work\P",
            Box::new(KillingProbe {
                killed: killed.clone(),
            }),
        );
        inner.sessions.insert("s1".into(), session);
        inner.session_order.push("s1".into());

        let project_id = close_session_in_inner(&mut inner, "s1", false)
            .expect("the exited session must be removed");
        assert_eq!(
            project_id, "p",
            "the owning project is reported so an empty temporary project can be retired"
        );
        assert!(!inner.sessions.contains_key("s1"), "the tab must be gone");
        assert!(
            !inner.session_order.contains(&"s1".to_string()),
            "the tab must leave the order"
        );
        assert!(
            !killed.load(Ordering::SeqCst),
            "the process already exited; no kill may be attempted"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn manual_close_still_kills_the_running_process() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        let killed = Arc::new(AtomicBool::new(false));
        let session = test_session_with_killer(
            "s1",
            "p",
            r"C:\Work\P",
            Box::new(KillingProbe {
                killed: killed.clone(),
            }),
        );
        inner.sessions.insert("s1".into(), session);
        inner.session_order.push("s1".into());

        let _ =
            close_session_in_inner(&mut inner, "s1", true).expect("the session must be removed");
        assert!(
            killed.load(Ordering::SeqCst),
            "a manual close must kill the live process"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn closing_an_already_closed_session_is_a_noop() {
        // The user closed the tab manually; the waiter thread's late exit-0
        // report must not touch the surviving state.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        inner.session_order.push("s1".into());
        inner.session_order.push("s2".into());

        let _ = close_session_in_inner(&mut inner, "s2", true)
            .expect("the manual close removes the session");
        assert!(
            close_session_in_inner(&mut inner, "s2", false).is_none(),
            "the late exit report for a removed session is a no-op"
        );
        assert!(
            inner.sessions.contains_key("s1"),
            "the sibling session must survive"
        );
        assert_eq!(
            inner.session_order,
            vec!["s1".to_string()],
            "the tab order keeps only the surviving session"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn active_session_count_ignores_idle_and_exited_tabs() {
        // The other half of the tray label. A tab that was running
        // something when its shell died must not stay in the numerator:
        // nothing is coming to clear it once the sweeper drops the
        // session.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        assert_eq!(
            active_session_count(&inner),
            0,
            "a fresh tab sits at its prompt"
        );

        for id in ["s1", "s2"] {
            inner
                .sessions
                .get_mut(id)
                .expect("test session")
                .metadata
                .activity = SessionActivity::Active;
        }
        assert_eq!(
            active_session_count(&inner),
            2,
            "both tabs are running something"
        );

        assert!(mark_session_exited(&mut inner, "s1", 1));
        assert_eq!(
            open_session_count(&inner),
            2,
            "the exited tab is still open"
        );
        assert_eq!(
            active_session_count(&inner),
            1,
            "but an exited tab is never counted as busy"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn marking_a_session_exited_clears_the_taskbar_in_the_snapshot_metadata() {
        // The snapshot's session JSON is built from the metadata, not the
        // taskbar machine: when the shell dies, the machine's cleared state
        // must be synced into the metadata, so an exited tab kept open for
        // inspection never resurrects a progress bar in a phone's tabs view.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        // The session's command is mid-run when the shell dies: the
        // machine's start record must die with it, so the window's
        // last-ran ordering never cascades onto a dead session's slot.
        inner.sessions.get_mut("s1").unwrap().taskbar.on_activity(
            SessionActivity::Active,
            Instant::now(),
        );
        inner.sessions.get_mut("s1").unwrap().metadata.taskbar = TaskbarProgress::Value(42);
        inner.sessions.get_mut("s1").unwrap().look_here = true;

        mark_session_exited(&mut inner, "s1", 1);

        assert_eq!(
            inner.sessions.get("s1").unwrap().metadata.taskbar,
            TaskbarProgress::Clear,
            "the metadata's taskbar must not outlive the process"
        );
        assert_eq!(
            inner.sessions.get("s1").unwrap().look_here, false,
            "the finished session's marker dies with the process"
        );
        assert_eq!(
            inner.sessions.get("s1").unwrap().taskbar.command_started_at(),
            None,
            "the running command's start record dies with the process"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn the_activity_sweep_step_syncs_the_cleared_taskbar_into_the_metadata() {
        // A non-reporting command's implicit spinner is cleared by the
        // active-to-idle grace transition, which the sweep (not the
        // stream pass) runs. When the sweep drops the badge it must sync
        // the cleared taskbar into the snapshot metadata, or every
        // snapshot after the command finished would resurrect a pulsing
        // ring on a quiet screen.
        let mut session = test_session("s1", "p", r"C:\Work\P");
        session.metadata.tui_mode = TuiMode::Fullscreen;
        let start = Instant::now();
        // The program is working: a spontaneous chunk earns the badge,
        // published once it has held for ACTIVE_MIN_MS.
        session.tui.mark_spontaneous_output(start);
        session
            .activity
            .observe(&[], TuiMode::Fullscreen, false, false, true, true, start);
        let settled = start + Duration::from_millis(crate::activity::ACTIVE_MIN_MS + 250);
        let announced = session
            .activity
            .observe(&[], TuiMode::Fullscreen, false, false, false, false, settled)
            .expect("the held badge is published");
        // The stream pass synced the running command's spinner the same
        // way its activity transition does, stamping the command's start
        // at the moment the transition was observed.
        let (activity, _) = announced;
        session.taskbar.on_activity(activity, settled);
        session.metadata.taskbar = session.taskbar.effective();
        assert_eq!(session.metadata.taskbar, TaskbarProgress::Indeterminate);
        assert_eq!(
            session.taskbar.command_started_at(),
            Some(settled),
            "the running command's start is recorded for the window's last-ran ordering"
        );

        // The screen has now been quiet for longer than TUI_QUIET_MS: the
        // sweep step drops the badge and moves the spinner to clear.
        let quiet = start + Duration::from_millis(crate::activity::ACTIVE_MIN_MS + TUI_QUIET_MS + 500);
        let step = Core::sweep_session_activity_step(&mut session, quiet, false)
            .expect("the quiet screen drops its badge");
        assert_eq!(step.0, SessionActivity::Idle);
        assert_eq!(step.2, Some(TaskbarProgress::Clear));
        assert_eq!(
            session.taskbar.command_started_at(),
            None,
            "the quiet screen ends the recorded run, so the window's last-ran ordering drops it"
        );
        assert_eq!(session.metadata.activity, SessionActivity::Idle);
        assert_eq!(
            session.metadata.taskbar,
            TaskbarProgress::Clear,
            "the cleared spinner must reach the snapshots the sweep's broadcast carries"
        );
        assert_eq!(
            session.look_here, true,
            "the finished edge raises the host's \"come look\" marker for a session no client is viewing"
        );
    }

    #[test]
    fn the_sweep_step_raises_no_marker_for_a_session_a_client_is_viewing() {
        // The same quiet-screen step, but a client is on the session (its
        // tab is active, its terminal page is open): the finished edge
        // must not raise the marker. The client watching the finish is
        // the look itself, and a persisted flag would only let a later
        // snapshot re-seed the marker once the client navigates away.
        let mut session = test_session("s1", "p", r"C:\Work\P");
        session.metadata.tui_mode = TuiMode::Fullscreen;
        let start = Instant::now();
        session.tui.mark_spontaneous_output(start);
        session
            .activity
            .observe(&[], TuiMode::Fullscreen, false, false, true, true, start);
        let settled = start + Duration::from_millis(crate::activity::ACTIVE_MIN_MS + 250);
        let announced = session
            .activity
            .observe(&[], TuiMode::Fullscreen, false, false, false, false, settled)
            .expect("the held badge is published");
        let (activity, _) = announced;
        session.taskbar.on_activity(activity, settled);
        session.metadata.taskbar = session.taskbar.effective();

        let quiet = start + Duration::from_millis(crate::activity::ACTIVE_MIN_MS + TUI_QUIET_MS + 500);
        let step = Core::sweep_session_activity_step(&mut session, quiet, true)
            .expect("the quiet screen drops its badge");
        assert_eq!(step.2, Some(TaskbarProgress::Clear));
        assert_eq!(
            session.look_here, false,
            "a viewed session's finished edge raises no marker"
        );
    }

    #[test]
    fn viewed_session_ids_unions_active_tabs_and_remote_viewports() {
        // "Viewed" means actively looking: a desktop window's ACTIVE tab
        // counts, a remote device's live viewport counts (a phone attaches
        // only the terminal page it is showing), and a desktop terminal
        // attached in a window's BACKGROUND does not - that tab still
        // earns a marker when its command finishes.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s3".into(), test_session("s3", "p", r"C:\Work\P"));
        // window-a is on s1; phone-a is on s2.
        inner.windows.set_active_session("window-a", Some("s1".into()));
        let second = inner.sessions.get_mut("s2").unwrap();
        set_client_viewport(second, TerminalController::Remote("phone-a".into()), 80, 24);
        // s3 is attached in window-b's background (attached, not active).
        let third = inner.sessions.get_mut("s3").unwrap();
        set_client_viewport(third, TerminalController::Desktop("window-b".into()), 120, 40);

        let viewed = viewed_session_ids(&inner);
        assert!(viewed.contains("s1"), "a window's active tab is viewed");
        assert!(viewed.contains("s2"), "a phone's open terminal is viewed");
        assert!(
            !viewed.contains("s3"),
            "a background-attached desktop terminal is not a look"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn the_snapshot_reports_the_sessions_still_holding_their_look_here_marker() {
        // The marker is host-persisted: a client that connects after the
        // finished edge reads the list from its first snapshot and raises
        // the same static-dot marker a live client raised from the event
        // stream.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner.sessions.insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner.sessions.insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        inner.sessions.get_mut("s1").unwrap().look_here = true;

        let empty: HashSet<String> = HashSet::new();
        let snapshot = snapshot_from_inner(&inner, &empty);
        assert_eq!(
            snapshot.look_here_session_ids,
            vec!["s1".to_string()],
            "only the marked session rides the list"
        );

        inner.sessions.get_mut("s1").unwrap().look_here = false;
        let cleared = snapshot_from_inner(&inner, &empty);
        assert!(
            cleared.look_here_session_ids.is_empty(),
            "a viewed (or re-armed) session leaves the list at once"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn the_look_here_flag_moves_with_the_taskbar_indicator() {
        // The finished edge (any transition INTO the clear state) raises
        // the marker; a re-armed indicator - a new command or an explicit
        // state, i.e. anything non-clear - drops it. This is the edge a
        // new command's first report produces, so a second command
        // running after a marker never keeps the "come look" dot.
        let mut session = test_session("s1", "p", r"C:\Work\P");
        assert!(!session.look_here, "a fresh session holds no marker");
        assert!(
            !move_look_here(&mut session, TaskbarProgress::Indeterminate, false),
            "a new command from an unmarked state stays unmarked"
        );
        assert!(
            move_look_here(&mut session, TaskbarProgress::Clear, false),
            "the finished edge raises the marker for a session nobody is viewing"
        );
        assert!(
            move_look_here(&mut session, TaskbarProgress::Indeterminate, false),
            "a re-armed indicator drops the marker"
        );
        assert!(
            !move_look_here(&mut session, TaskbarProgress::Value(57), false),
            "an explicit report on an unmarked state stays unmarked"
        );
        assert!(
            move_look_here(&mut session, TaskbarProgress::Clear, false),
            "a second finished edge raises the marker again"
        );
        assert!(
            move_look_here(&mut session, TaskbarProgress::Value(100), false),
            "the next command's 100% report drops it at once"
        );
        assert_eq!(session.look_here, false);
    }

    #[test]
    fn the_finished_edge_raises_no_marker_while_the_session_is_viewed() {
        // A client that is on the session (its active tab, its open
        // terminal) is the look the marker exists for: the finished edge
        // raises the flag only for a session nobody is viewing, and a
        // re-armed indicator still drops whatever the flag held.
        let mut session = test_session("s1", "p", r"C:\Work\P");
        assert!(!session.look_here, "a fresh session holds no marker");
        assert!(
            !move_look_here(&mut session, TaskbarProgress::Indeterminate, false),
            "the command's start earns no marker on an unviewed session"
        );
        assert!(
            !move_look_here(&mut session, TaskbarProgress::Clear, true),
            "a command finishing while a client is on the session raises nothing"
        );
        assert_eq!(session.look_here, false);
        // A marker that predates the view still dies when the indicator
        // re-arms, whatever the viewing state.
        session.look_here = true;
        assert!(
            move_look_here(&mut session, TaskbarProgress::Indeterminate, true),
            "a re-armed indicator on a viewed session still drops the marker"
        );
        assert_eq!(session.look_here, false);
    }

    #[test]
    fn viewing_one_session_does_not_suppress_the_marker_for_the_other() {
        // The suppression is per-session: a client sitting on s1 is a
        // look AT s1, not a look at s2. s1's finished edge is
        // suppressed while s2's still raises - the marker's job is to
        // pull the user back to the session they are NOT on.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        // phone-a is on s1; nobody is looking at s2.
        let first = inner.sessions.get_mut("s1").unwrap();
        set_client_viewport(first, TerminalController::Remote("phone-a".into()), 80, 24);

        // s1's command finishes while the phone is on it: suppressed.
        let s1_viewed = viewed_session_ids(&inner).contains("s1");
        assert!(s1_viewed, "the phone's open terminal counts as a look");
        let first = inner.sessions.get_mut("s1").unwrap();
        assert!(
            !move_look_here(first, TaskbarProgress::Indeterminate, s1_viewed),
            "a new command from an unmarked state stays unmarked"
        );
        assert!(
            !move_look_here(first, TaskbarProgress::Clear, s1_viewed),
            "a command finishing while a client is on the session raises nothing"
        );

        // s2's command finishes with nobody on it: raised, even though a
        // client is looking right now - at the other session.
        let s2_viewed = viewed_session_ids(&inner).contains("s2");
        assert!(!s2_viewed, "a client sitting on s1 is not a look at s2");
        let second = inner.sessions.get_mut("s2").unwrap();
        assert!(!move_look_here(second, TaskbarProgress::Indeterminate, s2_viewed));
        assert!(
            move_look_here(second, TaskbarProgress::Clear, s2_viewed),
            "the other session's finished edge still raises its marker"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn a_session_stops_counting_as_viewed_once_the_viewer_leaves() {
        // Suppression lasts only as long as the view: once the phone's
        // terminal page is gone (its live viewport evicted), the
        // session is unviewed again and the next finished edge raises
        // the marker the way it always did.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        let phone = TerminalController::Remote("phone-a".into());
        let first = inner.sessions.get_mut("s1").unwrap();
        set_client_viewport(first, phone.clone(), 80, 24);
        assert!(
            viewed_session_ids(&inner).contains("s1"),
            "the phone's open terminal counts as a look"
        );

        // The phone leaves the terminal page: the viewport is evicted.
        let first = inner.sessions.get_mut("s1").unwrap();
        first.viewports.remove(&phone);
        assert!(
            !viewed_session_ids(&inner).contains("s1"),
            "the evicted viewport no longer counts as a look"
        );

        // The command finishes with nobody on the session: the marker
        // earns itself again.
        let s1_viewed = viewed_session_ids(&inner).contains("s1");
        let first = inner.sessions.get_mut("s1").unwrap();
        assert!(!move_look_here(first, TaskbarProgress::Indeterminate, s1_viewed));
        assert!(
            move_look_here(first, TaskbarProgress::Clear, s1_viewed),
            "once the viewer leaves, the finished edge raises the marker"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn a_background_attached_session_still_earns_its_marker() {
        // A terminal attached in a window's BACKGROUND tab is not a
        // look: the window's "viewed" set is its active tab. The
        // attached session's finished edge must still raise the marker
        // so the window's tab indicator tells the user to come back.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        // window-b has s1 attached (background); its active tab is s2.
        let first = inner.sessions.get_mut("s1").unwrap();
        set_client_viewport(first, TerminalController::Desktop("window-b".into()), 120, 40);
        inner.windows.set_active_session("window-b", Some("s2".into()));
        assert!(
            !viewed_session_ids(&inner).contains("s1"),
            "a background-attached terminal is not a look"
        );
        assert!(
            viewed_session_ids(&inner).contains("s2"),
            "the active tab is a look"
        );

        // s1's command finishes while the window sits on s2: raised.
        let s1_viewed = viewed_session_ids(&inner).contains("s1");
        let first = inner.sessions.get_mut("s1").unwrap();
        assert!(!move_look_here(first, TaskbarProgress::Indeterminate, s1_viewed));
        assert!(
            move_look_here(first, TaskbarProgress::Clear, s1_viewed),
            "a background tab's finished edge still raises the marker"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn viewing_a_session_clears_its_look_here_marker() {
        // A look from any client - a desktop window making its tab
        // active, or a phone opening its terminal - dies the marker, and
        // the snapshot's field with it. The helper reports whether it
        // held anything, so the callers broadcast only on a real change.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner.sessions.insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner.sessions.get_mut("s1").unwrap().look_here = true;

        assert!(
            clear_session_look_here(&mut inner, "s1"),
            "a held marker is reported as cleared"
        );
        assert_eq!(inner.sessions.get("s1").unwrap().look_here, false);
        assert!(
            !clear_session_look_here(&mut inner, "s1"),
            "a session that holds no marker reports nothing"
        );
        assert!(
            !clear_session_look_here(&mut inner, "missing"),
            "an unknown session reports nothing"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn output_user_driven_uses_the_latest_of_input_and_resize() {
        // Keystrokes and resizes each arm the attribution window, and
        // the LATEST of the two governs: a resize while the user was
        // typing re-arms the window from the resize.
        let mut session = test_session("s1", "p", r"C:\Work\P");
        let now = Instant::now();
        assert!(
            !output_is_user_driven(&session, now),
            "no input or resize yet: the output is the program's own"
        );

        session.last_user_input_at = Some(now);
        assert!(
            output_is_user_driven(&session, now),
            "the keystroke's instant is inside its window"
        );
        assert!(
            output_is_user_driven(
                &session,
                now + std::time::Duration::from_millis(TUI_USER_ATTRIBUTION_MS)
            ),
            "the window is inclusive of its boundary"
        );
        assert!(
            !output_is_user_driven(
                &session,
                now + std::time::Duration::from_millis(TUI_USER_ATTRIBUTION_MS + 1)
            ),
            "past the window the output is the program's own"
        );

        // A resize later than the keystroke re-arms the window.
        let resize_at = now + std::time::Duration::from_millis(400);
        session.last_resize_at = Some(resize_at);
        assert!(output_is_user_driven(&session, resize_at));
        assert!(
            !output_is_user_driven(
                &session,
                resize_at + std::time::Duration::from_millis(TUI_USER_ATTRIBUTION_MS + 1)
            ),
            "the window runs from the LATEST of input and resize"
        );
    }

    // ---------------------------------------------------------------------
    // History replay must never read as activity. The bytes an attaching
    // client is served from the journal (a new window, a phone
    // reconnecting, a fresh client's snapshot) are already-delivered
    // history: running them through the classifier or the activity
    // detector would light the badge for work the program finished long
    // ago. The live reader loop (`on_terminal_data`) is the only feed
    // into the classifier and the detector, and the replay itself is a
    // pure read of `session.buffer` (see `snapshot_of`).
    // ---------------------------------------------------------------------

    /// A session whose journal holds a complete past TUI period: alt
    /// screen enter, a couple of frames, alt screen exit, and the shell
    /// prompt back. The session itself is idle: the period ended long
    /// ago and nothing has produced output since.
    fn session_with_tui_history_in_journal() -> ManagedSession {
        let mut session = test_session("s1", "p", r"C:\Work\P");
        let history =
            "\x1b[?1049h\x1b[2;1H\x1b[?25lframe 1\r\n\x1b[3;1Hframe 2\r\n\x1b[?1049lPS C:\\> ";
        session.buffer.push_str(history);
        session.journal_len = history.len() as u64;
        session
    }

    #[test]
    fn a_replay_snapshot_is_a_pure_read_of_the_journal() {
        let session = session_with_tui_history_in_journal();
        let journal_len = session.journal_len;
        let buffer_len = session.buffer.len();
        let mode = session.metadata.tui_mode;

        let snapshot = snapshot_of(&session);

        assert_eq!(
            snapshot.end_offset, journal_len,
            "the snapshot covers the whole journal"
        );
        assert!(
            snapshot
                .segments
                .iter()
                .any(|segment| segment.data.contains("\x1b[?1049h")),
            "the replay carries the alt-screen sequences verbatim"
        );
        assert_eq!(
            session.journal_len, journal_len,
            "serving the snapshot must not append to the journal"
        );
        assert_eq!(
            session.buffer.len(),
            buffer_len,
            "serving the snapshot must not mutate the buffer"
        );
        assert_eq!(
            session.metadata.tui_mode, mode,
            "the replay bytes are not fed to the classifier, so the mode is untouched"
        );
        assert_eq!(
            session.tui.spontaneous_quiet_ms(Instant::now()),
            u64::MAX,
            "the replay bytes are not stamped onto the spontaneous clock either"
        );
    }

    #[test]
    fn replayed_history_does_not_light_the_activity_badge() {
        // The TUI period in the journal ended long ago; the session is at
        // its prompt and the clients hold `Idle`. A client attaching now
        // is served the full journal - alt enter, frames, alt exit,
        // prompt - and serving it must not re-run any of it.
        let session = session_with_tui_history_in_journal();
        assert_eq!(session.metadata.activity, SessionActivity::Idle);

        let _ = snapshot_of(&session);
        assert_eq!(
            session.metadata.activity,
            SessionActivity::Idle,
            "a replay is already-delivered history, not new work"
        );
        assert_eq!(session.activity.state(), SessionActivity::Idle);
    }

    #[test]
    fn a_quiet_session_stays_idle_after_a_client_replays_its_history() {
        // The exact computation the activity sweeper runs for a session
        // that produced no new bytes: replaying the journal for a new
        // client creates no chunk, so the sweep must find nothing to
        // announce. If the replayed bytes were misread as output, the
        // sweep would re-earn a badge for a quiet screen.
        let mut session = session_with_tui_history_in_journal();
        let now = Instant::now();
        let mode = session.metadata.tui_mode;
        let quiet_idle = session.tui.quiet_idle(now);
        let tui_quiet = session.tui.spontaneous_quiet_ms(now) >= TUI_QUIET_MS;
        assert!(
            session
                .activity
                .observe(&[], mode, quiet_idle, tui_quiet, false, false, now)
                .is_none(),
            "the sweep reasserts the idle clients already hold and announces nothing"
        );
    }

    #[test]
    fn serving_a_snapshot_does_not_extend_the_spontaneous_quiet_window() {
        // The program last worked 1.5 s ago - inside TUI_QUIET_MS, so
        // its badge is still up. A client attaching at that same instant
        // is served the journal, and a naive implementation that fed the
        // journal through the classifier would stamp the spontaneous
        // clock to now and hold the badge past its rightful expiry.
        let mut session = session_with_tui_history_in_journal();
        let now = Instant::now();
        session
            .tui
            .mark_spontaneous_output(now - Duration::from_millis(1_500));

        let _ = snapshot_of(&session);

        assert_eq!(
            session.tui.spontaneous_quiet_ms(now),
            1_500,
            "the replay must not read as program work: the quiet window still runs from the last spontaneous chunk"
        );
    }

    #[test]
    fn replaying_an_open_tui_period_does_not_reclassify_or_rebadge() {
        // The journal ends INSIDE an alt screen: a paused htop. The live
        // stream already classified the session Fullscreen, and the
        // screen has been quiet for far longer than TUI_QUIET_MS, so
        // the badge is idle. A client that replays the journal must not
        // re-run the alt sequences: the mode is the live stream's
        // verdict, and the replay carries no new chunk.
        let mut session = test_session("s1", "p", r"C:\Work\P");
        session.metadata.tui_mode = TuiMode::Fullscreen;
        let open_period = "\x1b[?1049h\x1b[H\x1b[?25lpaused";
        session.buffer.push_str(open_period);
        session.journal_len = open_period.len() as u64;
        let now = Instant::now();
        session
            .tui
            .mark_spontaneous_output(now - Duration::from_secs(10));

        let _ = snapshot_of(&session);

        assert_eq!(
            session.metadata.tui_mode,
            TuiMode::Fullscreen,
            "the mode is the live stream's verdict, untouched by the replay"
        );
        assert_eq!(session.activity.state(), SessionActivity::Idle);
        let tui_quiet = session.tui.spontaneous_quiet_ms(now) >= TUI_QUIET_MS;
        assert!(tui_quiet, "the last spontaneous frame was ten seconds ago");
        assert_eq!(
            session.activity.observe(
                &[],
                TuiMode::Fullscreen,
                false,
                tui_quiet,
                false,
                false,
                now
            ),
            None,
            "the quiet sweep reasserts the idle clients already hold"
        );
    }

    #[test]
    fn open_session_count_tracks_tabs_through_exit_and_close() {
        // The tray's session label reports this count, so its edge cases
        // must hold: an empty tray reads zero, a tab kept for inspection
        // after a non-zero exit still counts, and only a close removes it.
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        assert_eq!(
            open_session_count(&inner),
            0,
            "no tabs before a session opens"
        );

        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        assert_eq!(open_session_count(&inner), 2, "every open tab counts");

        // A non-zero exit marks the tab exited but keeps it open for
        // inspection, so the count must not drop.
        assert!(mark_session_exited(&mut inner, "s1", 1));
        assert_eq!(
            open_session_count(&inner),
            2,
            "a kept-for-inspection tab still counts"
        );

        close_session_in_inner(&mut inner, "s2", true).expect("the close removes the session");
        assert_eq!(
            open_session_count(&inner),
            1,
            "closing a tab removes it from the count"
        );

        close_session_in_inner(&mut inner, "s1", false).expect("the close removes the session");
        assert_eq!(
            open_session_count(&inner),
            0,
            "closing the last tab empties the count"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn clean_exit_keeps_siblings_and_their_tab_order() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "p", r"C:\Work\P"));
        inner
            .sessions
            .insert("s3".into(), test_session("s3", "p", r"C:\Work\P"));
        inner
            .session_order
            .extend(["s1".into(), "s2".into(), "s3".into()]);

        let _ =
            close_session_in_inner(&mut inner, "s2", false).expect("the middle tab must be closed");
        assert!(inner.sessions.contains_key("s1") && inner.sessions.contains_key("s3"));
        assert_eq!(
            inner.session_order,
            vec!["s1".to_string(), "s3".to_string()],
            "closing one tab must not disturb the others' order"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn clean_exit_of_the_last_session_retires_the_temporary_project() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        let temp = test_project(&mut inner, "temp", r"C:\Work\Temp", false);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "temp", r"C:\Work\Temp"));
        inner.session_order.push("s1".into());

        let project_id =
            close_session_in_inner(&mut inner, "s1", false).expect("the tab must be closed");
        assert!(
            matches!(
                retire_empty_temporary_project(&mut inner, &project_id),
                RetireOutcome::Removed { .. }
            ),
            "the now-empty temporary project must be retired"
        );
        assert!(!inner.temporary_projects.contains_key(&temp.id));

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn clean_exit_keeps_a_persistent_project() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        let saved = test_project(&mut inner, "saved", r"C:\Work\Saved", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "saved", r"C:\Work\Saved"));
        inner.session_order.push("s1".into());

        let project_id =
            close_session_in_inner(&mut inner, "s1", false).expect("the tab must be closed");
        assert!(
            matches!(
                retire_empty_temporary_project(&mut inner, &project_id),
                RetireOutcome::NotEligible
            ),
            "a persistent project must never be retired"
        );
        assert!(
            inner
                .store
                .projects()
                .iter()
                .any(|project| project.id == saved.id),
            "the saved project stays in the store"
        );

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn nonzero_exit_keeps_the_tab_and_records_the_code() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        test_project(&mut inner, "p", r"C:\Work\P", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "p", r"C:\Work\P"));
        inner.session_order.push("s1".into());

        // Any non-zero code - ordinary failures, 128 + signal, or a
        // platform-maximum code - keeps the tab for inspection.
        for exit_code in [1_u32, 128, u32::MAX] {
            assert!(
                mark_session_exited(&mut inner, "s1", exit_code),
                "a live session must be marked exited"
            );
            let session = &inner.sessions["s1"].metadata;
            assert_eq!(session.status, "exited");
            assert_eq!(session.exit_code, Some(exit_code));
        }
        assert!(
            inner.sessions.contains_key("s1"),
            "a non-zero exit must keep the tab open"
        );
        assert_eq!(inner.session_order, vec!["s1".to_string()]);

        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn marking_exited_for_a_missing_session_is_a_noop() {
        let (mut inner, state_path) = inner_with_settings(false, false);
        assert!(
            !mark_session_exited(&mut inner, "ghost", 1),
            "an unknown session cannot be marked"
        );
        assert!(inner.sessions.is_empty());
        assert!(inner.session_order.is_empty());

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
            activity: SessionActivity::Idle,
            activity_since: None,
            taskbar: TaskbarProgress::Clear,
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

    /// Records whether it was ever asked to kill - proves the manual-close
    /// path kills a live process while the normal-exit path does not.
    struct KillingProbe {
        killed: Arc<AtomicBool>,
    }
    impl std::fmt::Debug for KillingProbe {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("KillingProbe")
        }
    }
    impl ChildKiller for KillingProbe {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(KillingProbe {
                killed: self.killed.clone(),
            })
        }
    }

    fn test_session(session_id: &str, project_id: &str, cwd: &str) -> ManagedSession {
        test_session_with_killer(session_id, project_id, cwd, Box::new(InertKiller))
    }

    fn test_session_with_killer(
        session_id: &str,
        project_id: &str,
        cwd: &str,
        killer: Box<dyn ChildKiller + Send + Sync>,
    ) -> ManagedSession {
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
                activity: SessionActivity::Idle,
                activity_since: None,
                taskbar: TaskbarProgress::Clear,
            },
            master: Box::new(InertMaster),
            writer: SessionWriter::spawn(session_id, Box::new(std::io::sink())),
            killer,
            grid: (SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS),
            viewports: HashMap::new(),
            owner: None,
            grid_epochs: vec![GridEpoch {
                offset: 0,
                cols: SESSION_DEFAULT_COLS,
                rows: SESSION_DEFAULT_ROWS,
            }],
            buffer: String::new(),
            journal_len: 0,
            tui: TuiClassifier::new(SESSION_DEFAULT_ROWS),
            synthetic_alt: false,
            deferred_tui_resize: false,
            last_user_input_at: None,
            last_resize_at: None,
            requested_viewport: None,
            activity: ActivityDetector::new(Instant::now()),
            taskbar: SessionTaskbar::new(),
            look_here: false,
            control_tail: String::new(),
            cursor_query_tail: String::new(),
            pending_cursor_reports: 0,
            device_attributes_tail: String::new(),
            pending_device_attributes: 0,
            has_run_command: false,
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        // A folder that matches no saved or temporary project.
        let outcome = resolve_working_directory(&mut inner, "s1", Path::new(r"C:\Somewhere\Else"));
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "temp-a", r"C:\Work\TempA"));
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
        inner
            .store
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");
        inner.windows.attach("window-a", "s1");

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\B\deep"),
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "outer", r"C:\Work"));

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\Deep\x"),
        ));
        assert_eq!(plan.project.id, "inner", "the more specific project wins");
        assert_eq!(inner.sessions["s1"].metadata.project_id, "inner");
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_reuses_an_existing_temporary_project() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        let temp = test_project(&mut inner, "temp-c", r"C:\Work\C", false);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        let temp_count = inner.temporary_projects.len();

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\C"),
        ));
        assert_eq!(
            plan.project.id, temp.id,
            "the existing temporary project is reused"
        );
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        let order_len = inner.project_order.len();

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Fresh\Folder"),
        ));
        assert!(
            !plan.project.persistent,
            "a freshly matched folder becomes a temporary project"
        );
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\A\sub"),
        ));
        assert!(
            !plan.project_changed,
            "staying inside the same project is not a change"
        );
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");
        inner.windows.assign("window-b", "b");
        inner.windows.attach("window-a", "s1");

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\B"),
        ));
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
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner
            .sessions
            .insert("s2".into(), test_session("s2", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\B"),
        ));
        assert!(
            plan.old_has_sessions,
            "another session still lives in the old project"
        );
        assert!(plan.open_projects_in_new_windows);
        assert_eq!(
            inner.sessions["s2"].metadata.project_id, "a",
            "the sibling session is untouched"
        );
        fs::remove_file(state_path).expect("remove test state");
    }

    #[test]
    fn follow_on_reports_no_remaining_sessions_when_moving_the_last_one() {
        let (mut inner, state_path) = inner_with_settings(true, false);
        test_project(&mut inner, "a", r"C:\Work\A", true);
        test_project(&mut inner, "b", r"C:\Work\B", true);
        inner
            .sessions
            .insert("s1".into(), test_session("s1", "a", r"C:\Work\A"));
        inner.windows.assign("window-a", "a");

        let plan = expect_reassigned(resolve_working_directory(
            &mut inner,
            "s1",
            Path::new(r"C:\Work\B"),
        ));
        assert!(
            !plan.old_has_sessions,
            "the moved session was the last one in the old project"
        );
        fs::remove_file(state_path).expect("remove test state");
    }
}
