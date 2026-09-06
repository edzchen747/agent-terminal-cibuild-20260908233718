//! Default terminal app registration and ConPTY handoff hosting.
//!
//! Windows can hand the UI of a new console session (cmd, pwsh, …) to a
//! "terminal app". The per-user choice lives in the registry under
//! `HKCU\Console\\%%Startup` — a key whose name literally contains percent
//! signs: `DelegationConsole` names the console host (conhost) to use, and
//! `DelegationTerminal` names the terminal app that takes over a session's
//! ConPTY. Setting `DelegationTerminal` to our CLSID is exactly what the
//! Settings → Default terminal app picker writes for the entries it knows.
//!
//! When `DelegationTerminal` names us, the console hosting the new session
//! (the inbox conhost, or a delegated console such as OpenConsole) calls
//! `CoCreateInstance(our CLSID, CLSCTX_LOCAL_SERVER)` and drives
//! `ITerminalHandoff3::EstablishPtyHandoff`, passing us:
//!
//! * `in`/`out` — out parameters for pipe ends the terminal returns; the
//!   console then runs "headless" and pumps ConPTY data across the pipe;
//! * `signal` — the ConPTY signal pipe (resize and window control);
//! * `reference` — a ConDrv reference handle that keeps the console alive;
//! * `server` — a process handle to the console (the PTY server);
//! * `client` — a process handle to the app being run (cmd, pwsh, …);
//! * `startupInfo` — a STARTUPINFO-like struct (title, icon, show state).
//!
//! Like Windows Terminal (`CTerminalHandoff::s_StartListening`), we serve the
//! activation with a *runtime* local-server registration: the running
//! instance registers a class object via `CoRegisterClassObject` at
//! startup and hosts the handoff object in-process. The callback creates a
//! session in the host: a named 128 KiB overlapped duplex pipe (its far
//! ends go back to the console), a packed `HPCON` (the ABI-shared
//! `PseudoConsole` struct) so the session can resize the ConPTY through the
//! signal pipe, and a wait on the client process so the tab closes when the
//! command ends.
//!
//! If Agent Terminal is not running, the local-server activation simply
//! fails and the console falls back to its own UI — nothing breaks.

use std::sync::Arc;

use crate::core::Core;

/// The CLSID that identifies Agent Terminal as a terminal app in the
/// default terminal delegation (`DelegationTerminal` value). It is a
/// stable, application-owned identifier and must never change.
const AGENT_TERMINAL_CLSID_STR: &str = "{BCB79BF1-E2AF-41A0-871A-DF1CD2981F7D}";

/// The delegated console host that runs the session and performs the
/// terminal handoff: `OpenConsole.exe`, shipped in-box on Windows 11 as
/// part of the Windows Terminal package.
///
/// A terminal app does not host the console session itself — it receives
/// an already-running ConPTY. The console half of the delegation pair
/// therefore names a *console host*, not us, and reusing the in-box
/// OpenConsole is what the Settings picker does for any terminal that
/// does not ship a console host of its own.
#[cfg(windows)]
const DELEGATION_CONSOLE_CLSID_STR: &str = "{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}";

/// Whether the current user's default terminal delegation points at Agent
/// Terminal. Recomputed on every state broadcast, so the settings UI can
/// hide the "Set as default terminal app" option once it applies.
#[cfg(windows)]
pub fn is_default_terminal() -> bool {
    let Ok(key) = delegation_key() else {
        return false;
    };
    let terminal = key
        .get_value::<String, _>("DelegationTerminal")
        .is_ok_and(|current| current.eq_ignore_ascii_case(AGENT_TERMINAL_CLSID_STR));
    // A `DelegationTerminal` on its own is inert: the console host treats
    // the pair as "let Windows decide" unless the console half also names
    // a delegated host, and hands the session to its own UI instead.
    let console = key
        .get_value::<String, _>("DelegationConsole")
        .is_ok_and(|current| current.eq_ignore_ascii_case(DELEGATION_CONSOLE_CLSID_STR));
    terminal && console
}

#[cfg(not(windows))]
pub fn is_default_terminal() -> bool {
    false
}

/// Writes `DelegationTerminal` under `HKCU\Console\\%%Startup` so new console
/// sessions delegate their ConPTY to Agent Terminal. Per-user only; no
/// elevation required. The `DelegationConsole` value is left untouched, so
/// whatever console host the user already chose keeps starting the session.
#[cfg(windows)]
pub fn set_as_default_terminal() -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    // The console marshals the handoff call into us, so the proxy/stub
    // must be registered for the interfaces before the delegation is
    // switched on — otherwise the activation succeeds and the call fails.
    register_handoff_proxy()?;
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _disposition) = root
        .create_subkey_with_flags("Console\\%%Startup", KEY_WRITE)
        .map_err(|error| format!("could not create Console\\%%Startup: {error}"))?;
    // Both halves of the pair have to be written. The console host reads
    // them together and, if either is missing or names the in-box console,
    // it discards the pair entirely and keeps its own window — so writing
    // only `DelegationTerminal` looks applied but never hands anything
    // over.
    // Remember whatever was there so undoing this restores the user's
    // previous terminal rather than merely un-setting ours. Only recorded
    // when the current pair is not already ours, so applying twice cannot
    // overwrite the record with our own CLSIDs.
    if !is_default_terminal() {
        let previous_console = key.get_value::<String, _>("DelegationConsole").ok();
        let previous_terminal = key.get_value::<String, _>("DelegationTerminal").ok();
        save_previous_delegation(previous_console, previous_terminal)?;
    }
    key.set_value("DelegationConsole", &DELEGATION_CONSOLE_CLSID_STR)
        .map_err(|error| format!("could not set DelegationConsole: {error}"))?;
    key.set_value("DelegationTerminal", &AGENT_TERMINAL_CLSID_STR)
        .map_err(|error| format!("could not set DelegationTerminal: {error}"))?;
    Ok(())
}

/// Where the pre-Agent-Terminal delegation pair is parked, so `Undo` can put
/// it back. A missing value means the pair was absent before we wrote it.
#[cfg(windows)]
const PREVIOUS_DELEGATION_KEY: &str = "Software\\AgentTerminal\\PreviousDelegation";

#[cfg(windows)]
fn save_previous_delegation(console: Option<String>, terminal: Option<String>) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _disposition) = root
        .create_subkey_with_flags(PREVIOUS_DELEGATION_KEY, KEY_WRITE)
        .map_err(|error| format!("could not record the previous terminal: {error}"))?;
    // Absence is meaningful (it means "Windows decides"), so a missing value
    // is recorded by deleting ours rather than storing an empty string.
    match console {
        Some(value) => key
            .set_value("DelegationConsole", &value)
            .map_err(|error| format!("could not record DelegationConsole: {error}"))?,
        None => {
            let _ = key.delete_value("DelegationConsole");
        }
    }
    match terminal {
        Some(value) => key
            .set_value("DelegationTerminal", &value)
            .map_err(|error| format!("could not record DelegationTerminal: {error}"))?,
        None => {
            let _ = key.delete_value("DelegationTerminal");
        }
    }
    Ok(())
}

/// Restores the delegation pair to whatever it was before Agent Terminal
/// claimed it: the recorded previous terminal, or - when there was none, or
/// nothing was recorded - no pair at all, which is how Windows expresses
/// "let Windows decide" and returns consoles to the in-box host.
///
/// The proxy/stub and LocalServer32 registrations are deliberately left in
/// place: they are inert without the delegation pair, and keeping them makes
/// re-applying instant.
#[cfg(windows)]
pub fn clear_as_default_terminal() -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let root = RegKey::predef(HKEY_CURRENT_USER);
    let previous = root
        .open_subkey_with_flags(PREVIOUS_DELEGATION_KEY, KEY_READ)
        .ok()
        .map(|key| {
            (
                key.get_value::<String, _>("DelegationConsole").ok(),
                key.get_value::<String, _>("DelegationTerminal").ok(),
            )
        })
        .unwrap_or((None, None));
    let (key, _disposition) = root
        .create_subkey_with_flags("Console\\%%Startup", KEY_WRITE)
        .map_err(|error| format!("could not open Console\\%%Startup: {error}"))?;
    match previous.0 {
        Some(value) => key
            .set_value("DelegationConsole", &value)
            .map_err(|error| format!("could not restore DelegationConsole: {error}"))?,
        None => {
            let _ = key.delete_value("DelegationConsole");
        }
    }
    match previous.1 {
        Some(value) => key
            .set_value("DelegationTerminal", &value)
            .map_err(|error| format!("could not restore DelegationTerminal: {error}"))?,
        None => {
            let _ = key.delete_value("DelegationTerminal");
        }
    }
    let _ = root.delete_subkey_all(PREVIOUS_DELEGATION_KEY);
    Ok(())
}

/// The CLSID of the `PSFactoryBuffer` class in `agent-terminal-proxy.dll`
/// — the proxy/stub DLL built from `handoff-proxy/ITerminalHandoff.idl`.
/// It is pinned by `PROXY_CLSID_IS` in `build-proxy.bat` rather than left
/// to MIDL, which would otherwise reuse the first interface's IID and
/// give the proxy class the same GUID as `ITerminalHandoff2`. Changing it
/// orphans existing registrations, so it must stay fixed.
#[cfg(windows)]
const HANDOFF_PROXY_CLSID_STR: &str = "{A9328F6C-3412-4183-A19E-16E681843B92}";

/// The proxy/stub DLL, shipped next to the executable by `build.rs`.
#[cfg(windows)]
const HANDOFF_PROXY_DLL: &str = "agent-terminal-proxy.dll";

/// The handoff interfaces the proxy marshals, with the method count COM
/// needs to size the vtable (`IUnknown`'s three plus `EstablishPtyHandoff`).
#[cfg(windows)]
const HANDOFF_INTERFACES: [(&str, &str); 3] = [
    ("{59D55CCE-FC8A-48B4-ACE8-0A9286C6557F}", "ITerminalHandoff"),
    ("{AA6B364F-4A50-4176-9002-0AE755E7B5EF}", "ITerminalHandoff2"),
    ("{6F23DA90-15C5-4203-9DB0-64E73F1B1B00}", "ITerminalHandoff3"),
];

/// Locates the proxy/stub DLL: next to the running executable in a normal
/// (portable) install, falling back to the build tree so `cargo run` and
/// `tauri dev` work too.
#[cfg(windows)]
fn handoff_proxy_path() -> Option<std::path::PathBuf> {
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(HANDOFF_PROXY_DLL)));
    if let Some(path) = beside_exe.filter(|path| path.exists()) {
        return Some(path);
    }
    let in_tree = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("handoff-proxy")
        .join(HANDOFF_PROXY_DLL);
    in_tree.exists().then_some(in_tree)
}

/// Registers the handoff proxy/stub for the current user.
///
/// COM has no generic marshaler for these interfaces: their parameters are
/// `system_handle`s, which only MIDL-generated NDR code knows how to
/// duplicate across the process boundary. Both sides of the call (the
/// console host and this process) load the DLL named here, so without this
/// registration `CoCreateInstance` still succeeds and
/// `EstablishPtyHandoff` then fails to marshal.
///
/// Everything is written under `HKCU\\Software\\Classes`, which COM merges
/// over the machine-wide classes — no elevation, and no effect on other
/// users. Writing is idempotent: an up-to-date registration is left alone.
#[cfg(windows)]
pub fn register_handoff_proxy() -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let dll = handoff_proxy_path()
        .ok_or_else(|| format!("{HANDOFF_PROXY_DLL} is missing from the application directory"))?;
    let dll = dll.to_string_lossy().into_owned();

    let server_path = format!("CLSID\\{HANDOFF_PROXY_CLSID_STR}\\InprocServer32");
    let classes = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
        .map_err(|error| format!("could not open HKCU\\Software\\Classes: {error}"))?;
    let (server, _) = classes
        .create_subkey(&server_path)
        .map_err(|error| format!("could not create {server_path}: {error}"))?;
    server
        .set_value("", &dll)
        .map_err(|error| format!("could not point the proxy class at {dll}: {error}"))?;
    // "Both" lets COM use the proxy from the console's apartment and from
    // the RPC worker threads that deliver the handoff to us.
    server
        .set_value("ThreadingModel", &"Both")
        .map_err(|error| format!("could not set the proxy threading model: {error}"))?;

    // The class itself. The console host that activates us is a packaged
    // (MSIX) process, and its activation resolves the CLSID through the
    // registry rather than through this process's runtime
    // `CoRegisterClassObject` registration alone, so the class needs a
    // `LocalServer32` entry naming the executable. It also means a console
    // can be handed over when Agent Terminal is not running yet: COM
    // starts it with `-Embedding` and the new instance serves the handoff.
    let exe = std::env::current_exe()
        .map_err(|error| format!("could not locate the executable: {error}"))?;
    let (class, _) = classes
        .create_subkey(format!("CLSID\\{AGENT_TERMINAL_CLSID_STR}"))
        .map_err(|error| format!("could not create the class key: {error}"))?;
    class
        .set_value("", &"Agent Terminal")
        .map_err(|error| format!("could not name the class: {error}"))?;
    // A debug build must never claim the launch registration: it is a
    // console-subsystem binary (so COM starting it as the terminal
    // deadlocks against the console being handed over) and it loads the
    // dev server rather than the bundled frontend. Running `tauri dev`
    // would otherwise silently repoint the user's default terminal at it.
    if !cfg!(debug_assertions) {
        let (local_server, _) = class
            .create_subkey("LocalServer32")
            .map_err(|error| format!("could not create LocalServer32: {error}"))?;
        local_server
            .set_value("", &format!(r#""{}""#, exe.display()))
            .map_err(|error| format!("could not set LocalServer32: {error}"))?;
    }

    for (iid, name) in HANDOFF_INTERFACES {
        let (interface, _) = classes
            .create_subkey(format!("Interface\\{iid}"))
            .map_err(|error| format!("could not create Interface\\{iid}: {error}"))?;
        interface
            .set_value("", &name)
            .map_err(|error| format!("could not name {name}: {error}"))?;
        let (proxy, _) = interface
            .create_subkey("ProxyStubClsid32")
            .map_err(|error| format!("could not create ProxyStubClsid32 for {name}: {error}"))?;
        proxy
            .set_value("", &HANDOFF_PROXY_CLSID_STR)
            .map_err(|error| format!("could not set ProxyStubClsid32 for {name}: {error}"))?;
        let (methods, _) = interface
            .create_subkey("NumMethods")
            .map_err(|error| format!("could not create NumMethods for {name}: {error}"))?;
        methods
            .set_value("", &"4")
            .map_err(|error| format!("could not set NumMethods for {name}: {error}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn clear_as_default_terminal() -> Result<(), String> {
    Err("The default terminal integration is only available on Windows.".into())
}

#[cfg(not(windows))]
pub fn set_as_default_terminal() -> Result<(), String> {
    Err("The default terminal integration is only available on Windows.".into())
}

/// Registers the running instance as the local COM server for the
/// terminal-handoff CLSID so the OS can activate it. The registration lives
/// as long as the process; activation requests arrive on RPC worker threads
/// of this process. Safe to call once per process; a no-op outside Windows.
pub fn start(core: Arc<Core>) {
    #[cfg(windows)]
    win::start(core);
}

/// Registers the handoff class object on the **calling** thread (used by
/// the `--rpc-probe` diagnostic). Returns the HRESULT.
pub fn register_handoff_on_calling_thread() -> i32 {
    #[cfg(windows)]
    {
        win::register_handoff_class()
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[cfg(windows)]
pub use win::{build_handoff_master, wait_client_exit, HandoffKiller, HandoffSession};

/// Reads the per-user `%%Startup` delegation key read-only.
#[cfg(windows)]
fn delegation_key() -> Result<winreg::RegKey, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Console\\%%Startup", KEY_READ)
        .map_err(|error| format!("could not open Console\\%%Startup: {error}"))
}

#[cfg(windows)]
mod win {
    use std::io;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};

    use filedescriptor::FileDescriptor;
    use portable_pty::{ChildKiller, MasterPty, PtySize};
    use std::os::windows::io::{FromRawHandle, OwnedHandle as StdOwnedHandle};
    use winapi::ctypes::c_void;
    use winapi::shared::guiddef::GUID;
    use winapi::um::fileapi::{CreateFileW, OPEN_EXISTING};
    use winapi::um::handleapi::{CloseHandle, DuplicateHandle, INVALID_HANDLE_VALUE};
    use winapi::um::heapapi::{GetProcessHeap, HeapAlloc, HeapFree};
    use winapi::um::minwinbase::STILL_ACTIVE;
    use winapi::um::namedpipeapi::CreateNamedPipeW;
    use winapi::um::processthreadsapi::{
        GetExitCodeProcess, GetCurrentProcess, TerminateProcess,
    };
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::winbase::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, INFINITE, PIPE_ACCESS_INBOUND,
        PIPE_ACCESS_OUTBOUND,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
        QueryFullProcessImageNameW,
    };
    use winapi::um::wincon::COORD;
    use winapi::um::winnt::{
        DUPLICATE_SAME_ACCESS, FILE_SHARE_READ, FILE_SHARE_WRITE, GENERIC_READ, GENERIC_WRITE,
        PROCESS_QUERY_INFORMATION, PROCESS_TERMINATE, PROCESS_VM_READ, SYNCHRONIZE, HANDLE,
    };

    use crate::core::{Core, SESSION_DEFAULT_COLS, SESSION_DEFAULT_ROWS};

    // ------------------------------------------------------------------
    // COM identity: CLSID and interface IIDs
    // ------------------------------------------------------------------

    /// The application-owned CLSID of the terminal-handoff COM class.
    const AGENT_TERMINAL_CLSID: GUID = GUID {
        Data1: 0xBCB79BF1,
        Data2: 0xE2AF,
        Data3: 0x41A0,
        Data4: [0x87, 0x1A, 0xDF, 0x1C, 0xD2, 0x98, 0x1F, 0x7D],
    };

    /// `ITerminalHandoff` (v1) — the original handoff interface.
    const TERMINAL_HANDOFF_V1_IID: GUID = GUID {
        Data1: 0x59D55CCE,
        Data2: 0xFC8A,
        Data3: 0x48B4,
        Data4: [0xAC, 0xE8, 0x0A, 0x92, 0x86, 0xC6, 0x55, 0x7F],
    };

    /// `ITerminalHandoff2` — adds the `TERMINAL_STARTUP_INFO` parameter.
    const TERMINAL_HANDOFF_V2_IID: GUID = GUID {
        Data1: 0xAA6B364F,
        Data2: 0x4A50,
        Data3: 0x4176,
        Data4: [0x90, 0x02, 0x0A, 0xE7, 0x55, 0xE7, 0xB5, 0xEF],
    };

    /// `ITerminalHandoff3` — `in`/`out` became out parameters (the terminal
    /// chooses the pipe), what current conhost/OpenConsole activate.
    const TERMINAL_HANDOFF_V3_IID: GUID = GUID {
        Data1: 0x6F23DA90,
        Data2: 0x15C5,
        Data3: 0x4203,
        Data4: [0x9D, 0xB0, 0x64, 0xE7, 0x3F, 0x1B, 0x1B, 0x00],
    };

    /// `IClassFactory`.
    const ICLASSFACTORY_IID: GUID = GUID {
        Data1: 0x00000001,
        Data2: 0x0000,
        Data3: 0x0000,
        Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    /// `IUnknown` — the all-zero GUID. COM's stub manager queries every
    /// registered class object for it, so the factory must answer it.
    const IUNKNOWN_IID: GUID = GUID {
        Data1: 0x00000000,
        Data2: 0x0000,
        Data3: 0x0000,
        Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    // ------------------------------------------------------------------
    // Handoff payload
    // ------------------------------------------------------------------

    /// Everything a successful handoff needs to open a session: the console
    /// handed us its own process (the PTY server), the client process, the
    /// ConPTY signal pipe and a ConDrv reference handle; we packed those
    /// into an HPCON and created a duplex pipe for the data path.
    pub struct HandoffSession {
        pub title: String,
        /// The directory the console was launched in, read out of the
        /// client process. `None` when it could not be determined.
        pub cwd: Option<String>,
        /// Dup of our pipe end used to read the client app's output.
        pub reader: HANDLE,
        /// Dup of our pipe end used to write the user's input.
        pub writer: HANDLE,
        /// Client process handle: termination rights (tab close kills it).
        pub client: HANDLE,
        /// Client process handle: exit wait (drives the session's end).
        pub client_wait: HANDLE,
        /// Packed ConPTY control handle (a heap `PseudoConsole`).
        pub hpc: HANDLE,
    }

    /// The running instance's core, captured at startup so the RPC-thread
    /// handoff callback can create sessions in the host.
    static CORE: OnceLock<Arc<Core>> = OnceLock::new();

    /// The cookie of the live class registration, if it happened already
    /// (either pre-Tauri or on the main thread).
    static REGISTRATION_COOKIE: OnceLock<u32> = OnceLock::new();

    /// Registers the class object as a local (in-process) COM server on
    /// the calling thread. No-op if already registered in this process.
    pub fn register_handoff_class() -> i32 {
        if REGISTRATION_COOKIE.get().copied().is_some() {
            return S_OK;
        }
        // The console marshals `EstablishPtyHandoff` into this process, so
        // the proxy/stub for the handoff interfaces has to be registered
        // before the class object is published. Re-registering on every
        // start also repairs a stale path after the app is moved.
        if let Err(error) = super::register_handoff_proxy() {
            eprintln!("agent-terminal: could not register the handoff proxy: {error}");
        }
        // CoInitializeEx(MTA) is a harmless failure if this thread's COM
        // is already initialized (e.g. STA by the webview); register from
        // whatever apartment the thread has.
        let _ = ensure_com_init();
        let factory =
            Box::into_raw(Box::new(FactoryObject {
                vtable: &FACTORY_VTABLE,
                refs: AtomicUsize::new(1),
            }));
        let mut cookie: u32 = 0;
        let hr = unsafe {
            CoRegisterClassObject(
                &AGENT_TERMINAL_CLSID,
                factory as *mut c_void,
                CLSCTX_LOCAL_SERVER,
                REGCLS_MULTIPLEUSE,
                &mut cookie,
            )
        };
        // The registration AddRefs the factory; release our ref.
        unsafe {
            (FACTORY_VTABLE.release)(factory as *const FactoryObject);
        }
        crate::core::sync_log_line(
            "handoff",
            format_args!(
                "CoRegisterClassObject: hr=0x{:08x} cookie={cookie} argv={:?}",
                hr as u32,
                std::env::args().collect::<Vec<_>>()
            ),
        );
        if hr == S_OK {
            let _ = REGISTRATION_COOKIE.set(cookie);
        } else {
            eprintln!(
                "agent-terminal: default terminal handoff server failed to register: hr=0x{:08x} (thread={:?})",
                hr as u32,
                std::thread::current().name()
            );
            if crate::core::sync_debug_enabled() {
                crate::core::sync_log_line(
                    "handoff",
                    format_args!(
                        "CoRegisterClassObject failed: hr=0x{:08x} (thread={:?})",
                        hr as u32,
                        std::thread::current().name()
                    ),
                );
            }
        }
        hr
    }

    /// Registers the class object as a local (in-process) COM server (if
    /// not already registered pre-Tauri) and captures the running instance
    /// so RPC-thread handoff callbacks can create sessions in the host.
    /// Order matters: the core is published *before* the class object is
    /// registered. COM can deliver `EstablishPtyHandoff` within
    /// milliseconds of the registration becoming visible, and a handoff
    /// that arrives with no core to host it has to be rejected — which
    /// sends the console back to its own window.
    pub fn start(core: Arc<Core>) {
        if CORE.set(Arc::clone(&core)).is_err() {
            // Already started; the earlier registration still serves.
            return;
        }
        // Register from a dedicated MTA thread, never the Tauri main
        // thread. WebView2 initializes the main thread as an STA, and a
        // class object registered there has its calls dispatched by that
        // thread's message pump — so `EstablishPtyHandoff` would run on
        // the UI thread, and the window it needs to open cannot be built
        // from inside a message-pump dispatch: the event loop is already
        // busy delivering the call, and the app hangs. Registering in the
        // MTA hands the call to an RPC worker thread instead, leaving the
        // event loop free to service the window work.
        //
        // The thread then parks: the registration lives as long as the
        // apartment does.
        std::thread::Builder::new()
            .name("agent-terminal-handoff".into())
            .spawn(|| {
                let hr = register_handoff_class();
                if hr == S_OK && crate::core::sync_debug_enabled() {
                    crate::core::sync_log_line(
                        "handoff",
                        format_args!(
                            "handoff COM class live (MTA thread, cookie={})",
                            REGISTRATION_COOKIE.get().copied().unwrap_or(0)
                        ),
                    );
                }
                let (_tx, rx) = std::sync::mpsc::channel::<()>();
                let _ = rx.recv();
            })
            .ok();
    }

    // ------------------------------------------------------------------
    // COM plumbing
    // ------------------------------------------------------------------

    type HResult = i32;
    const S_OK: HResult = 0;
    const E_FAIL: HResult = 0x8000_4005_u32 as i32;
    const E_INVALIDARG: HResult = 0x8007_0057_u32 as i32;
    const E_NOINTERFACE: HResult = 0x8000_4002_u32 as i32;
    const E_POINTER: HResult = 0x8000_4003_u32 as i32;
    const CLASS_E_NOAGGREGATION: HResult = 0x8004_0115_u32 as i32;

    const CLSCTX_LOCAL_SERVER: u32 = 0x4;
    // Official header value: REGCLS_MULTIPLEUSE (winapi's enum value, 1).
    // Lets several console sessions activate handoffs at once.
    const REGCLS_MULTIPLEUSE: u32 = 1;
    const COINIT_MULTITHREADED: u32 = 0x0;

    unsafe extern "system" {
        fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> HResult;
        fn CoRegisterClassObject(
            rclsid: *const GUID,
            pUnk: *mut c_void,
            dwClsContext: u32,
            flags: u32,
            lpdwRegister: *mut u32,
        ) -> HResult;
        fn LoadLibraryW(libname: *const u16) -> *mut c_void;
        fn IsWow64Process(process: HANDLE, wow64: *mut i32) -> i32;
        fn ReadProcessMemory(
            process: HANDLE,
            address: *const c_void,
            buffer: *mut c_void,
            size: usize,
            read: *mut usize,
        ) -> i32;
        fn GetProcAddress(module: *mut c_void, procname: *const u8) -> *mut c_void;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(
            process: HANDLE,
            information_class: u32,
            information: *mut c_void,
            length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    fn ensure_com_init() -> HResult {
        unsafe { CoInitializeEx(std::ptr::null_mut(), COINIT_MULTITHREADED) }
    }

    fn guid_eq(a: *const GUID, b: &GUID) -> bool {
        if a.is_null() {
            return false;
        }
        unsafe {
            let a = &*a;
            a.Data1 == b.Data1 && a.Data2 == b.Data2 && a.Data3 == b.Data3 && a.Data4 == b.Data4
        }
    }

    /// Diagnostic rendering of a GUID pointer for the sync log.
    fn guid_str(g: *const GUID) -> String {
        if g.is_null() {
            return "null".to_owned();
        }
        unsafe {
            let g = &*g;
            format!(
                "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}}}",
                g.Data1,
                g.Data2,
                g.Data3,
                g.Data4[0],
                g.Data4[1],
                g.Data4[2],
                g.Data4[3],
                g.Data4[4],
                g.Data4[5],
                g.Data4[6],
                g.Data4[7]
            )
        }
    }

    /// The STARTUPINFO-like struct the console passes with the handoff
    /// (layout from `ITerminalHandoff.idl` in the Windows Terminal repo).
    /// The grid fields are zero: conhost fills only the title, icon and
    /// show-window fields, so the terminal picks its own initial grid.
    #[allow(dead_code)]
    #[repr(C)]
    struct TerminalStartupInfo {
        psz_title: *mut u16,
        psz_icon_path: *mut u16,
        icon_index: i32,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
    }

    /// BSTR → String. The console allocates the title with SysAllocString,
    /// so the length prefix two words before the pointer is always valid
    /// for non-null values.
    unsafe fn bstr_to_string(bstr: *mut u16) -> Option<String> {
        if bstr.is_null() {
            return None;
        }
        let byte_len = unsafe { *bstr.offset(-2) };
        if byte_len == 0 {
            return Some(String::new());
        }
        let wide = unsafe { std::slice::from_raw_parts(bstr, byte_len as usize / 2) };
        Some(String::from_utf16_lossy(wide))
    }

    /// The packed ConPTY control struct (ABI-shared with the OS winconpty
    /// library, see `winconpty.h` in the Windows Terminal repo):
    /// `ResizePseudoConsole`/close operate on these fields directly.
    #[repr(C)]
    struct PseudoConsole {
        h_signal: HANDLE,
        h_pty_reference: HANDLE,
        h_con_pty_process: HANDLE,
    }

    // ------------------------------------------------------------------
    // The handoff object: IUnknown + ITerminalHandoff{,2,3}
    // ------------------------------------------------------------------

    /// One object, three COM interfaces.
    ///
    /// A COM interface pointer points at a vtable pointer, and every
    /// interface needs its own: an `ITerminalHandoff3` pointer must have
    /// `EstablishPtyHandoff` in slot 3 of *its* vtable. Sharing one
    /// combined vtable across the three versions would dispatch a v3 call
    /// into the v1 method. The three vtable pointers therefore sit at the
    /// front of the object — the layout a C++ compiler gives a class with
    /// three interface bases, and the one WRL produces for Windows
    /// Terminal's `CTerminalHandoff` — so `QueryInterface` can hand out
    /// the right slot and each method can step back to the object.
    #[repr(C)]
    struct HandoffObject {
        v1: *const HandoffV1VTable,
        v2: *const HandoffV2VTable,
        v3: *const HandoffV3VTable,
        refs: AtomicUsize,
    }

    const V1_OFFSET: usize = 0;
    const V2_OFFSET: usize = std::mem::size_of::<usize>();
    const V3_OFFSET: usize = 2 * std::mem::size_of::<usize>();

    /// Recovers the object from an interface pointer at `offset`.
    unsafe fn handoff_object(this: *mut c_void, offset: usize) -> *const HandoffObject {
        unsafe { (this as *const u8).sub(offset) as *const HandoffObject }
    }

    #[repr(C)]
    struct HandoffV1VTable {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HResult,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        /// `ITerminalHandoff::EstablishPtyHandoff` (by-value handles).
        establish: unsafe extern "system" fn(
            *mut c_void,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
        ) -> HResult,
    }

    #[repr(C)]
    struct HandoffV2VTable {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HResult,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        /// `ITerminalHandoff2::EstablishPtyHandoff` (handles + startup info).
        establish: unsafe extern "system" fn(
            *mut c_void,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            *const TerminalStartupInfo,
        ) -> HResult,
    }

    #[repr(C)]
    struct HandoffV3VTable {
        query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HResult,
        add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        /// `ITerminalHandoff3::EstablishPtyHandoff` (the terminal returns
        /// the pipe ends through the two out parameters).
        establish: unsafe extern "system" fn(
            *mut c_void,
            *mut HANDLE,
            *mut HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            HANDLE,
            *const TerminalStartupInfo,
        ) -> HResult,
    }

    /// The shared `QueryInterface` body: hands back the vtable slot that
    /// matches the requested interface.
    unsafe fn handoff_query_interface(
        object: *const HandoffObject,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> HResult {
        if ppv.is_null() {
            return E_POINTER;
        }
        unsafe {
            *ppv = std::ptr::null_mut();
        }
        // IUnknown is answered through the first interface, the way a C++
        // object hands out its primary base.
        let offset = if guid_eq(riid, &IUNKNOWN_IID) || guid_eq(riid, &TERMINAL_HANDOFF_V1_IID) {
            V1_OFFSET
        } else if guid_eq(riid, &TERMINAL_HANDOFF_V2_IID) {
            V2_OFFSET
        } else if guid_eq(riid, &TERMINAL_HANDOFF_V3_IID) {
            V3_OFFSET
        } else {
            if crate::core::sync_debug_enabled() {
                crate::core::sync_log_line(
                    "handoff",
                    format_args!("QI rejected: riid={}", guid_str(riid)),
                );
            }
            return E_NOINTERFACE;
        };
        if crate::core::sync_debug_enabled() {
            crate::core::sync_log_line(
                "handoff",
                format_args!("QI granted: riid={}", guid_str(riid)),
            );
        }
        unsafe {
            *ppv = (object as *const u8).add(offset) as *mut c_void;
            handoff_add_ref(object);
        }
        S_OK
    }

    unsafe fn handoff_add_ref(object: *const HandoffObject) -> u32 {
        (unsafe { (*object).refs.fetch_add(1, Ordering::AcqRel) } + 1) as u32
    }

    unsafe fn handoff_release(object: *const HandoffObject) -> u32 {
        let previous = unsafe { (*object).refs.fetch_sub(1, Ordering::Release) };
        if previous == 1 {
            std::sync::atomic::fence(Ordering::Acquire);
            unsafe {
                drop(Box::from_raw(object as *mut HandoffObject));
            }
        }
        previous.saturating_sub(1) as u32
    }

    /// The per-interface `IUnknown` thunks. Each one translates its own
    /// interface pointer back to the object before delegating.
    macro_rules! handoff_iunknown_thunks {
        ($qi:ident, $add:ident, $rel:ident, $offset:expr) => {
            unsafe extern "system" fn $qi(
                this: *mut c_void,
                riid: *const GUID,
                ppv: *mut *mut c_void,
            ) -> HResult {
                unsafe { handoff_query_interface(handoff_object(this, $offset), riid, ppv) }
            }

            unsafe extern "system" fn $add(this: *mut c_void) -> u32 {
                unsafe { handoff_add_ref(handoff_object(this, $offset)) }
            }

            unsafe extern "system" fn $rel(this: *mut c_void) -> u32 {
                unsafe { handoff_release(handoff_object(this, $offset)) }
            }
        };
    }

    handoff_iunknown_thunks!(v1_query_interface, v1_add_ref, v1_release, V1_OFFSET);
    handoff_iunknown_thunks!(v2_query_interface, v2_add_ref, v2_release, V2_OFFSET);
    handoff_iunknown_thunks!(v3_query_interface, v3_add_ref, v3_release, V3_OFFSET);

    /// Shared v1/v2/v3 body: take ownership of the ConPTY handles, pack the
    /// HPCON, resize to the default grid, and open a session in the host.
    ///
    /// `reader`/`writer` are the session's data path: for v3 that is a dup
    /// of each end of the pipe we created (the console pumps through the
    /// pipe ends we wrote back); for v1/v2 it is the console's own pipe
    /// handles, already duplicated into our process by marshaling.
    unsafe fn host_handoff(
        reader: HANDLE,
        writer: HANDLE,
        signal: HANDLE,
        reference: HANDLE,
        server: HANDLE,
        client: HANDLE,
        info: *const TerminalStartupInfo,
    ) -> Result<(), String> {
        // The callback runs on an RPC worker thread of this process; make
        // COM available there (a no-op when already initialized).
        let _ = ensure_com_init();
        let Some(core) = CORE.get() else {
            return Err("handoff server not started".to_string());
        };
        // Take ownership of the ConPTY handles the console passes: every
        // dup below is what we keep; closing them ends our side of the
        // session (see `release_pseudo_console` in the killer's Drop).
        let owned_signal = duplicate_handle(signal, 0)
            .map_err(|error| format!("duplicate the signal handle: {error}"))?;
        let owned_reference = duplicate_handle(reference, 0)
            .map_err(|error| format!("duplicate the reference handle: {error}"))?;
        let owned_server = duplicate_handle(server, 0)
            .map_err(|error| format!("duplicate the server handle: {error}"))?;
        // The client process handle: termination rights for tab close, plus
        // query rights for the title. Fall back to plain access rights if
        // the process is already gone or access is denied.
        // PROCESS_VM_READ is what lets `client_working_directory` reach the
        // process parameters; the fallbacks below keep the handoff working
        // when it is refused.
        let wanted =
            PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE;
        let owned_client = duplicate_handle(client, wanted)
            .or_else(|_| duplicate_handle(client, PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE))
            .or_else(|_| duplicate_handle(client, 0))
            .map_err(|error| format!("duplicate client handle: {error}"))?;
        let wait_client =
            duplicate_handle(owned_client, SYNCHRONIZE | PROCESS_QUERY_INFORMATION)
                .unwrap_or(INVALID_HANDLE_VALUE);
        // The `[in]` handles belong to the RPC stub, which closes them once
        // this call returns — exactly what `CTerminalHandoff` relies on.
        // Closing them here as well is a double close: the values get
        // recycled by the duplicates taken just above, and the stub's
        // cleanup then shuts those down instead, tearing the ConPTY out
        // from under the session that was just handed to us.
        // Pack the ConPTY (the ABI PseudoConsole struct) so the session can
        // resize and close it exactly like a created ConPTY.
        let hpc = pack_pseudo_console(owned_server, owned_reference, owned_signal);
        if hpc.is_null() {
            unsafe {
                CloseHandle(owned_signal);
                CloseHandle(owned_reference);
                CloseHandle(owned_server);
                CloseHandle(owned_client);
                CloseHandle(wait_client);
            };
            return Err("could not pack the ConPTY control handle".to_string());
        }
        // Synchronize the ConPTY with the grid the session opens at (the
        // startup info carries no grid: conhost zeroes those fields).
        if let Some(resize) = resize_pseudo_console() {
            let _ = unsafe {
                resize(
                    hpc,
                    COORD {
                        X: SESSION_DEFAULT_COLS as i16,
                        Y: SESSION_DEFAULT_ROWS as i16,
                    },
                )
            };
        }
        let handoff = HandoffSession {
            title: handoff_title(info, owned_client),
            cwd: client_working_directory(owned_client),
            reader,
            writer,
            client: owned_client,
            client_wait: wait_client,
            hpc,
        };
        core.create_handoff_session(handoff)
            .map_err(|error| format!("create handoff session: {error:#}"))?;
        crate::core::sync_log_line("handoff", format_args!("hosted a console handoff session"));
        Ok(())
    }

    /// v1: the console's pipe handles by value (already dup'd in-process).
    ///
    /// Unverified: current conhost activates v3, so nothing here has ever
    /// run. In particular the `in`/`out` orientation below is the opposite
    /// of the one v3's out-parameters turned out to need - if a console
    /// ever does take this path and the tab stays blank, swap them first.
    unsafe extern "system" fn establish_v1(
        _this: *mut c_void,
        in_handle: HANDLE,
        out_handle: HANDLE,
        signal: HANDLE,
        reference: HANDLE,
        server: HANDLE,
        client: HANDLE,
    ) -> HResult {
        crate::core::sync_log_line("handoff", format_args!("EstablishPtyHandoff (v1) called"));
        // `in`/`out` belong to the RPC stub, which closes them when this
        // call returns; the session keeps its data path for the lifetime
        // of the tab, so it needs copies of its own.
        let result = (|| {
            let reader = duplicate_handle(in_handle, 0)
                .map_err(|error| format!("duplicate the console input handle: {error}"))?;
            let writer = duplicate_handle(out_handle, 0)
                .map_err(|error| format!("duplicate the console output handle: {error}"))?;
            unsafe {
                host_handoff(reader, writer, signal, reference, server, client, std::ptr::null())
            }
        })();
        match result {
            Ok(()) => S_OK,
            Err(error) => {
                eprintln!("agent-terminal: ConPTY handoff (v1) failed: {error}");
                E_FAIL
            }
        }
    }

    /// v2: by-value handles plus the startup info.
    unsafe extern "system" fn establish_v2(
        _this: *mut c_void,
        in_handle: HANDLE,
        out_handle: HANDLE,
        signal: HANDLE,
        reference: HANDLE,
        server: HANDLE,
        client: HANDLE,
        info: *const TerminalStartupInfo,
    ) -> HResult {
        crate::core::sync_log_line("handoff", format_args!("EstablishPtyHandoff (v2) called"));
        // `in`/`out` belong to the RPC stub, which closes them when this
        // call returns; the session keeps its data path for the lifetime
        // of the tab, so it needs copies of its own.
        let result = (|| {
            let reader = duplicate_handle(in_handle, 0)
                .map_err(|error| format!("duplicate the console input handle: {error}"))?;
            let writer = duplicate_handle(out_handle, 0)
                .map_err(|error| format!("duplicate the console output handle: {error}"))?;
            unsafe {
                host_handoff(reader, writer, signal, reference, server, client, info)
            }
        })();
        match result {
            Ok(()) => S_OK,
            Err(error) => {
                eprintln!("agent-terminal: ConPTY handoff (v2) failed: {error}");
                E_FAIL
            }
        }
    }

    /// v3 (what current conhost activates): we create the pipe and write
    /// our far ends back to the console's `in`/`out` out parameters; the
    /// console keeps pumping ConPTY data across the pipe while it sits
    /// headless for the lifetime of the session.
    unsafe extern "system" fn establish_v3(
        _this: *mut c_void,
        in_out: *mut HANDLE,
        out_out: *mut HANDLE,
        signal: HANDLE,
        reference: HANDLE,
        server: HANDLE,
        client: HANDLE,
        info: *const TerminalStartupInfo,
    ) -> HResult {
        crate::core::sync_log_line("handoff", format_args!("EstablishPtyHandoff (v3) called"));
        if in_out.is_null() || out_out.is_null() {
            return E_INVALIDARG;
        }
        unsafe {
            *in_out = std::ptr::null_mut();
            *out_out = std::ptr::null_mut();
        }
        let result: Result<(), String> = (|| {
            // Our side of the data path: one byte-stream pipe per
            // direction, 128 KiB each (see `create_handoff_pipe` for why a
            // single duplex pipe wedges the input side).
            let (reader, writer, console_writer, console_reader) =
                create_handoff_pipe().map_err(|error| format!("create the data pipe: {error}"))?;
            unsafe {
                host_handoff(
                    reader,
                    writer,
                    signal,
                    reference,
                    server,
                    client,
                    info,
                )
            }?;
            // Hand the console its ends. Ownership transfers through the
            // out-parameter marshaling (the RPC layer duplicates them into
            // the console's process when this call returns), so the local
            // copies are deliberately not closed here — mirroring
            // CTerminalHandoff, which releases its pipe handles into the
            // return values.
            // The out-parameters are the *console's* ends - it needs one
            // handle to read its input from and one to write its output to -
            // so they are named from the console's point of view: `in` is
            // the end the console reads (we write it), `out` the end the
            // console writes (we read it). The duplex pipe this replaced
            // handed the same handle back twice, which is why the
            // orientation never mattered before.
            unsafe {
                *in_out = console_reader;
                *out_out = console_writer;
            }
            Ok(())
        })();
        match result {
            Ok(()) => S_OK,
            Err(error) => {
                eprintln!("agent-terminal: ConPTY handoff (v3) failed: {error}");
                crate::core::sync_log_line(
                    "handoff",
                    format_args!("EstablishPtyHandoff (v3) failed: {error}"),
                );
                E_FAIL
            }
        }
    }

    static HANDOFF_V1_VTABLE: HandoffV1VTable = HandoffV1VTable {
        query_interface: v1_query_interface,
        add_ref: v1_add_ref,
        release: v1_release,
        establish: establish_v1,
    };

    static HANDOFF_V2_VTABLE: HandoffV2VTable = HandoffV2VTable {
        query_interface: v2_query_interface,
        add_ref: v2_add_ref,
        release: v2_release,
        establish: establish_v2,
    };

    static HANDOFF_V3_VTABLE: HandoffV3VTable = HandoffV3VTable {
        query_interface: v3_query_interface,
        add_ref: v3_add_ref,
        release: v3_release,
        establish: establish_v3,
    };

    // ------------------------------------------------------------------
    // The class factory: IClassFactory
    // ------------------------------------------------------------------

    #[repr(C)]
    struct FactoryObject {
        vtable: *const FactoryVTable,
        refs: AtomicUsize,
    }

    #[repr(C)]
    struct FactoryVTable {
        query_interface:
            unsafe extern "system" fn(*const FactoryObject, *const GUID, *mut *mut c_void) -> HResult,
        add_ref: unsafe extern "system" fn(*const FactoryObject) -> u32,
        release: unsafe extern "system" fn(*const FactoryObject) -> u32,
        /// `IClassFactory::CreateInstance(pUnkOuter, riid, ppvObject)` —
        /// the outer-unknown parameter comes **first**.
        create_instance: unsafe extern "system" fn(
            *const FactoryObject,
            *const c_void,
            *const GUID,
            *mut *mut c_void,
        ) -> HResult,
        lock_server: unsafe extern "system" fn(*const FactoryObject, i32) -> HResult,
    }

    unsafe extern "system" fn factory_query_interface(
        this: *const FactoryObject,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> HResult {
        if ppv.is_null() {
            return E_POINTER;
        }
        unsafe {
            *ppv = std::ptr::null_mut();
        }
        // COM marshals the registered class object by asking it for
        // IUnknown and IClassFactory; rejecting either makes every
        // cross-process activation of the CLSID fail with E_NOINTERFACE
        // before `CreateInstance` is ever reached.
        if !riid.is_null()
            && !guid_eq(riid, &ICLASSFACTORY_IID)
            && !guid_eq(riid, &IUNKNOWN_IID)
        {
            return E_NOINTERFACE;
        }
        unsafe {
            *ppv = this as *mut c_void;
        }
        unsafe {
            factory_add_ref(this);
        }
        S_OK
    }

    unsafe extern "system" fn factory_add_ref(this: *const FactoryObject) -> u32 {
        (unsafe { (*this).refs.fetch_add(1, Ordering::AcqRel) } + 1) as u32
    }

    unsafe extern "system" fn factory_release(this: *const FactoryObject) -> u32 {
        let previous = unsafe { (*this).refs.fetch_sub(1, Ordering::Release) };
        if previous == 1 {
            std::sync::atomic::fence(Ordering::Acquire);
            unsafe {
                drop(Box::from_raw(this as *mut FactoryObject));
            }
        }
        previous.saturating_sub(1) as u32
    }

    unsafe extern "system" fn factory_create_instance(
        _this: *const FactoryObject,
        outer: *const c_void,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> HResult {
        if ppv.is_null() {
            return E_POINTER;
        }
        unsafe {
            *ppv = std::ptr::null_mut();
        }
        if !outer.is_null() {
            // The handoff object does not support aggregation.
            return CLASS_E_NOAGGREGATION;
        }
        if crate::core::sync_debug_enabled() {
            crate::core::sync_log_line(
                "handoff",
                format_args!("CreateInstance: riid={}", guid_str(riid)),
            );
        }
        // `QueryInterface` below settles which interfaces are supported.
        let object = Box::into_raw(Box::new(HandoffObject {
            v1: &HANDOFF_V1_VTABLE,
            v2: &HANDOFF_V2_VTABLE,
            v3: &HANDOFF_V3_VTABLE,
            refs: AtomicUsize::new(1),
        }));
        // Hand back the vtable slot for the interface that was asked for,
        // then drop the reference the allocation started with.
        let hr = unsafe { handoff_query_interface(object, riid, ppv) };
        unsafe {
            handoff_release(object);
        }
        hr
    }

    unsafe extern "system" fn factory_lock_server(
        _this: *const FactoryObject,
        _lock: i32,
    ) -> HResult {
        S_OK
    }

    static FACTORY_VTABLE: FactoryVTable = FactoryVTable {
        query_interface: factory_query_interface,
        add_ref: factory_add_ref,
        release: factory_release,
        create_instance: factory_create_instance,
        lock_server: factory_lock_server,
    };
    // ------------------------------------------------------------------
    // Windows API helpers
    // ------------------------------------------------------------------

    fn duplicate_handle(handle: HANDLE, access: u32) -> io::Result<HANDLE> {
        let mut out: HANDLE = std::ptr::null_mut();
        let ok = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                GetCurrentProcess(),
                &mut out,
                access,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(out)
        }
    }

    /// Creates the v3 handoff data path: two named byte-stream pipes, one
    /// per direction, 128 KiB each. Returns
    /// `(our reader, our writer, the console's writer, the console's reader)`.
    ///
    /// One duplex pipe will not do, even though the ConPTY ABI is happy to
    /// take the same handle twice. Our ends are *synchronous* handles - the
    /// session pumps them with plain blocking `Read`/`Write`, and a
    /// NULL-overlapped operation on a handle opened for overlapped I/O
    /// fails outright - and Windows serializes every operation on a
    /// synchronous file object. Sharing one handle therefore means a write
    /// cannot begin until the outstanding read completes, and the reader
    /// thread is parked in `ReadFile` for as long as the console has
    /// nothing to say: precisely the moment the user types. Splitting the
    /// directions gives them independent file objects, so neither can block
    /// the other.
    fn create_handoff_pipe() -> io::Result<(HANDLE, HANDLE, HANDLE, HANDLE)> {
        // console -> us: the ConPTY's output, which the console writes.
        let (our_reader, console_writer) = create_pipe_pair(PIPE_ACCESS_INBOUND, GENERIC_WRITE)?;
        // us -> console: the ConPTY's input, which the console reads.
        let (our_writer, console_reader) =
            match create_pipe_pair(PIPE_ACCESS_OUTBOUND, GENERIC_READ) {
                Ok(pair) => pair,
                Err(error) => {
                    unsafe {
                        CloseHandle(our_reader);
                        CloseHandle(console_writer);
                    }
                    return Err(error);
                }
            };
        Ok((our_reader, our_writer, console_writer, console_reader))
    }

    /// One unidirectional pipe: a synchronous server end for us, an
    /// overlapped client end for the console (which pumps it asynchronously).
    fn create_pipe_pair(access: u32, client_access: u32) -> io::Result<(HANDLE, HANDLE)> {
        let name = format!("agent-terminal-handoff-{}", uuid::Uuid::new_v4());
        let full = format!("\\\\.\\pipe\\{name}");
        let wide: Vec<u16> = full.encode_utf16().chain(std::iter::once(0)).collect();
        let our_end = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                // dwOpenMode: one direction, and deliberately synchronous
                // (see `create_handoff_pipe`). First-instance rejects a
                // squatter on the same name.
                access | FILE_FLAG_FIRST_PIPE_INSTANCE,
                // dwPipeMode: a byte stream, blocking, local clients only.
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                128 * 1024,
                128 * 1024,
                0,
                std::ptr::null_mut(),
            )
        };
        if our_end == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        match open_pipe_end(&wide, client_access) {
            Ok(client) => Ok((our_end, client)),
            Err(error) => {
                unsafe { CloseHandle(our_end) };
                Err(error)
            }
        }
    }

    fn open_pipe_end(name_wide: &[u16], access: u32) -> io::Result<HANDLE> {
        let handle = unsafe {
            CreateFileW(
                name_wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(handle)
        }
    }

    /// Packs the ConPTY handles into an HPCON: a heap-allocated
    /// `PseudoConsole` (the same layout and allocator the OS winconpty
    /// library uses in `ConptyPackPseudoConsole`).
    fn pack_pseudo_console(server: HANDLE, reference: HANDLE, signal: HANDLE) -> HANDLE {
        let memory = unsafe { HeapAlloc(GetProcessHeap(), 0, std::mem::size_of::<PseudoConsole>()) };
        if memory.is_null() {
            return std::ptr::null_mut();
        }
        let pty = memory as *mut PseudoConsole;
        unsafe {
            (*pty).h_signal = signal;
            (*pty).h_pty_reference = reference;
            (*pty).h_con_pty_process = server;
        }
        memory as HANDLE
    }

    /// Closes the three packed handles and frees the struct. Closing the
    /// reference handle is what lets the console exit once the client is
    /// gone, so this must run exactly once per handoff session.
    pub(super) fn release_pseudo_console(hpc: HANDLE) {
        if hpc.is_null() {
            return;
        }
        let pty = hpc as *const PseudoConsole;
        unsafe {
            CloseHandle((*pty).h_signal);
            CloseHandle((*pty).h_pty_reference);
            CloseHandle((*pty).h_con_pty_process);
            HeapFree(GetProcessHeap(), 0, hpc);
        }
    }

    /// Duplicates a packed HPCON (for the split-out killer).
    pub(super) fn duplicate_pseudo_console(hpc: HANDLE) -> HANDLE {
        if hpc.is_null() {
            return hpc;
        }
        let pty = hpc as *const PseudoConsole;
        let (signal, reference, server) = unsafe {
            (
                (*pty).h_signal,
                (*pty).h_pty_reference,
                (*pty).h_con_pty_process,
            )
        };
        let signal = match duplicate_handle(signal, 0) {
            Ok(handle) => handle,
            Err(_) => return std::ptr::null_mut(),
        };
        let reference = match duplicate_handle(reference, 0) {
            Ok(handle) => handle,
            Err(_) => {
                unsafe {
                    CloseHandle(signal);
                }
                return std::ptr::null_mut();
            }
        };
        let server = match duplicate_handle(server, 0) {
            Ok(handle) => handle,
            Err(_) => {
                unsafe {
                    CloseHandle(signal);
                    CloseHandle(reference);
                }
                return std::ptr::null_mut();
            }
        };
        pack_pseudo_console(server, reference, signal)
    }

    /// `ConptyResizePseudoConsole`, loaded from kernel32 (which forwards the
    /// console API-set export) or the API-set DLL directly. It writes a
    /// resize message to the packed HPCON's signal pipe; the headless
    /// console on the other end resizes the ConPTY. Absent on pre-22H2
    /// builds, in which case the session keeps the grid the console chose.
    type ResizePseudoConsoleFn = unsafe extern "system" fn(HANDLE, COORD) -> HResult;
    static RESIZE_PSEUDO_CONSOLE: OnceLock<Option<ResizePseudoConsoleFn>> = OnceLock::new();

    fn resize_pseudo_console() -> Option<ResizePseudoConsoleFn> {
        *RESIZE_PSEUDO_CONSOLE.get_or_init(|| {
            // kernel32 exports the public `ResizePseudoConsole`; the
            // `Conpty`-prefixed name is the one the console API set uses
            // and is not present on every build. Looking only for the
            // latter silently disabled resizing altogether.
            let names = [c"ResizePseudoConsole", c"ConptyResizePseudoConsole"];
            for (dll, name) in [
                ("kernel32.dll", names[0]),
                ("kernel32.dll", names[1]),
                ("api-ms-win-core-console-l1-1-2.dll", names[1]),
            ] {
                let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
                let module = unsafe { LoadLibraryW(wide.as_ptr()) };
                if module.is_null() {
                    continue;
                }
                let pointer = unsafe { GetProcAddress(module, name.as_ptr() as *const u8) };
                if !pointer.is_null() {
                    return Some(
                        unsafe {
                            std::mem::transmute::<*mut c_void, ResizePseudoConsoleFn>(pointer)
                        },
                    );
                }
            }
            None
        })
    }

    /// The session title: the console's STARTUPINFO title when it has one
    /// (for a launched app it is the command line), otherwise the client
    /// process image name.
    /// The directory the handed-off console was started in.
    ///
    /// `TERMINAL_STARTUP_INFO` carries the title, icon and show state but
    /// not the working directory, so it has to be read out of the client
    /// process's `RTL_USER_PROCESS_PARAMETERS` — the same place Windows
    /// Terminal reads a defterm session's command line from. Returns
    /// `None` whenever anything is unavailable (denied rights, a 32-bit
    /// client whose structures are laid out differently, a process that
    /// already exited); the caller then falls back to the project path.
    fn client_working_directory(client: HANDLE) -> Option<String> {
        if client.is_null() || client == INVALID_HANDLE_VALUE {
            return None;
        }
        // The offsets below are the 64-bit layout. A WOW64 client keeps a
        // 32-bit PEB, so refuse rather than read the wrong words.
        let mut wow64: i32 = 0;
        if unsafe { IsWow64Process(client, &mut wow64) } == 0 || wow64 != 0 {
            return None;
        }
        /// `PEB.ProcessParameters` (x64).
        const PEB_PROCESS_PARAMETERS: usize = 0x20;
        /// `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath` (x64).
        const PARAMS_CURRENT_DIRECTORY: usize = 0x38;

        let mut info = ProcessBasicInformation::default();
        let status = unsafe {
            NtQueryInformationProcess(
                client,
                0, // ProcessBasicInformation
                &mut info as *mut ProcessBasicInformation as *mut c_void,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                std::ptr::null_mut(),
            )
        };
        if status < 0 || info.peb_base_address.is_null() {
            return None;
        }
        let parameters: usize =
            read_process_value(client, (info.peb_base_address as usize) + PEB_PROCESS_PARAMETERS)?;
        if parameters == 0 {
            return None;
        }
        let path: UnicodeString =
            read_process_value(client, parameters + PARAMS_CURRENT_DIRECTORY)?;
        if path.buffer.is_null() || path.length == 0 {
            return None;
        }
        let mut wide = vec![0_u16; (path.length / 2) as usize];
        let mut read = 0_usize;
        let ok = unsafe {
            ReadProcessMemory(
                client,
                path.buffer as *const c_void,
                wide.as_mut_ptr() as *mut c_void,
                path.length as usize,
                &mut read,
            )
        };
        if ok == 0 || read != path.length as usize {
            return None;
        }
        let directory = String::from_utf16_lossy(&wide);
        // The stored path keeps a trailing separator; the rest of the
        // app stores directories without one.
        let trimmed = directory.trim_end_matches('\\');
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }

    /// Reads one `T` out of another process at `address`.
    fn read_process_value<T: Default>(process: HANDLE, address: usize) -> Option<T> {
        let mut value = T::default();
        let mut read = 0_usize;
        let ok = unsafe {
            ReadProcessMemory(
                process,
                address as *const c_void,
                &mut value as *mut T as *mut c_void,
                std::mem::size_of::<T>(),
                &mut read,
            )
        };
        (ok != 0 && read == std::mem::size_of::<T>()).then_some(value)
    }

    /// The head of `PROCESS_BASIC_INFORMATION` (x64); only the PEB pointer
    /// is used, but the whole struct has to be the right size for the query.
    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: i32,
        _padding: i32,
        peb_base_address: *mut c_void,
        affinity_mask: usize,
        base_priority: i32,
        _padding2: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    impl Default for ProcessBasicInformation {
        fn default() -> Self {
            Self {
                exit_status: 0,
                _padding: 0,
                peb_base_address: std::ptr::null_mut(),
                affinity_mask: 0,
                base_priority: 0,
                _padding2: 0,
                unique_process_id: 0,
                inherited_from_unique_process_id: 0,
            }
        }
    }

    /// `UNICODE_STRING` (x64).
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        _padding: u32,
        buffer: *mut u16,
    }

    impl Default for UnicodeString {
        fn default() -> Self {
            Self {
                length: 0,
                maximum_length: 0,
                _padding: 0,
                buffer: std::ptr::null_mut(),
            }
        }
    }

    fn handoff_title(info: *const TerminalStartupInfo, client: HANDLE) -> String {
        let from_info = if info.is_null() {
            None
        } else {
            unsafe { bstr_to_string((*info).psz_title) }
        };
        if let Some(title) = from_info.filter(|title| !title.trim().is_empty()) {
            return title;
        }
        let mut buffer = [0_u16; 1024];
        let mut length = buffer.len() as u32;
        let copied =
            unsafe { QueryFullProcessImageNameW(client, 0, buffer.as_mut_ptr(), &mut length) };
        if copied > 0 {
            let image = String::from_utf16_lossy(&buffer[..copied as usize]);
            let name = image.rsplit('\\').next().unwrap_or(&image);
            if !name.is_empty() {
                return name.to_string();
            }
        }
        "Terminal".to_string()
    }

    /// Blocks until the client process exits and closes the wait handle;
    /// the exit code (0 when it could not be queried) decides whether the
    /// tab stays open for inspection.
    pub fn wait_client_exit(client_raw: isize) -> u32 {
        let client = client_raw as HANDLE;
        if client == INVALID_HANDLE_VALUE {
            return 0;
        }
        unsafe {
            WaitForSingleObject(client, INFINITE);
            let mut code: u32 = 0;
            let result = if GetExitCodeProcess(client, &mut code) == 0 || code == STILL_ACTIVE {
                0
            } else {
                code
            };
            CloseHandle(client);
            result
        }
    }

    // ------------------------------------------------------------------
    // The session's MasterPty / ChildKiller
    // ------------------------------------------------------------------

    struct HandoffMasterInner {
        /// Packed ConPTY control handle; resized in place, owned (and
        /// released) by the session's killer.
        hpc: HANDLE,
        /// Our duplex pipe end, readable side.
        readable: FileDescriptor,
        /// Our duplex pipe end, writable side (taken by the session layer).
        writable: Option<FileDescriptor>,
        size: PtySize,
    }

    // SAFETY: Windows handles are process-wide kernel objects that may be
    // used from any thread; a dup'd HPCON carries no thread affinity.
    unsafe impl Send for HandoffMasterInner {}

    #[derive(Clone)]
    pub struct HandoffMasterPty {
        inner: Arc<Mutex<HandoffMasterInner>>,
        /// Resizes are queued, never applied inline.
        /// `ResizePseudoConsole` writes to the console's signal pipe and
        /// blocks whenever the console is not draining it. The desktop calls
        /// `resize` while holding its state lock, so stalling here freezes
        /// every thread that touches desktop state — the attach that asked
        /// for the resize included, which is what left a tab loading forever.
        resizes: std::sync::mpsc::Sender<PtySize>,
    }

    impl MasterPty for HandoffMasterPty {
        fn resize(&self, size: PtySize) -> anyhow::Result<()> {
            // Record the target first so `get_size` stays truthful, then let
            // the worker push it to the ConPTY. A closed channel just means
            // the session is going away.
            self.inner
                .lock()
                .expect("handoff master poisoned")
                .size = size;
            let _ = self.resizes.send(size);
            Ok(())
        }

        fn get_size(&self) -> anyhow::Result<PtySize> {
            Ok(self.inner.lock().expect("handoff master poisoned").size)
        }

        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
            let readable = self
                .inner
                .lock()
                .expect("handoff master poisoned")
                .readable
                .try_clone()?;
            Ok(Box::new(readable))
        }

        fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
            Ok(Box::new(
                self.inner
                    .lock()
                    .expect("handoff master poisoned")
                    .writable
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("writer already taken"))?,
            ))
        }
    }

    /// Builds the session master from the handoff payload: the reader/writer
    /// dups become the pipe I/O, the packed HPCON the resize control.
    pub fn build_handoff_master(
        reader: HANDLE,
        writer: HANDLE,
        hpc: HANDLE,
        size: PtySize,
    ) -> HandoffMasterPty {
        // The worker holds only the packed HPCON value and ends as soon as
        // the master is dropped, so it cannot outlive the session.
        let (resizes, requests) = std::sync::mpsc::channel::<PtySize>();
        let hpc_value = hpc as usize;
        std::thread::Builder::new()
            .name("agent-terminal-conpty-resize".into())
            .spawn(move || {
                let Some(resize) = resize_pseudo_console() else {
                    return;
                };
                while let Ok(size) = requests.recv() {
                    // Dragging a window edge produces a burst; only the last
                    // size is worth sending to the console.
                    let size = requests.try_iter().last().unwrap_or(size);
                    let _ = unsafe {
                        resize(
                            hpc_value as HANDLE,
                            COORD {
                                X: size.cols as i16,
                                Y: size.rows as i16,
                            },
                        )
                    };
                }
            })
            .ok();
        HandoffMasterPty {
            inner: Arc::new(Mutex::new(HandoffMasterInner {
                hpc,
                readable: FileDescriptor::new(unsafe {
                    StdOwnedHandle::from_raw_handle(reader as *mut std::ffi::c_void)
                }),
                writable: Some(FileDescriptor::new(unsafe {
                    StdOwnedHandle::from_raw_handle(writer as *mut std::ffi::c_void)
                })),
                size,
            })),
            resizes,
        }
    }

    /// Termination of the client process on tab close, plus the one-shot
    /// release of the packed ConPTY handles when the session goes away.
    #[derive(Debug)]
    pub struct HandoffKiller {
        client: HANDLE,
        hpc: HANDLE,
    }

    // SAFETY: both fields are dup'd kernel handles that are valid from any
    // thread; the packed HPCON is only ever operated on through the OS
    // ConPTY APIs.
    unsafe impl Send for HandoffKiller {}
    unsafe impl Sync for HandoffKiller {}

    impl HandoffKiller {
        pub fn new(client: HANDLE, hpc: HANDLE) -> Self {
            HandoffKiller { client, hpc }
        }
    }

    impl ChildKiller for HandoffKiller {
        fn kill(&mut self) -> io::Result<()> {
            if self.client != INVALID_HANDLE_VALUE {
                // The headless console exits when its client goes, which
                // tears the ConPTY (and thus the session) down cleanly.
                let _ = unsafe { TerminateProcess(self.client, 1) };
            }
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            let client = if self.client == INVALID_HANDLE_VALUE {
                self.client
            } else {
                duplicate_handle(self.client, PROCESS_TERMINATE).unwrap_or(self.client)
            };
            let hpc = duplicate_pseudo_console(self.hpc);
            Box::new(HandoffKiller { client, hpc })
        }
    }

    impl Drop for HandoffKiller {
        fn drop(&mut self) {
            if self.client != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.client);
                }
            }
            release_pseudo_console(self.hpc);
        }
    }
}