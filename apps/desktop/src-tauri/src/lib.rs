mod activity;
mod core;
mod default_terminal;

/// Registers the handoff class object on the calling (main) thread.
pub fn register_handoff_on_main_thread() {
    default_terminal::register_handoff_on_calling_thread();
}

mod models;
mod network;
mod path_utils;
mod provisioning;
mod remote;
mod shells;
mod store;
mod stream_opt;
mod tui;
mod window_clients;

use std::sync::Arc;

use arboard::Clipboard;
use core::Core;
use models::{
    DesktopState, FocusSessionEvent, PairingPayload, Project, SessionSnapshot, TerminalSession,
};
use store::DesktopStore;
use tauri::{
    Manager, State, WebviewWindow, Wry,
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[tauri::command]
fn get_state(window: WebviewWindow, state: State<'_, Arc<Core>>) -> DesktopState {
    state.state_for_window(window.label())
}

#[tauri::command]
async fn create_project(state: State<'_, Arc<Core>>) -> Result<Option<Project>, String> {
    let core = Arc::clone(state.inner());
    let folder = rfd::AsyncFileDialog::new()
        .set_title("Choose a project folder")
        .pick_folder()
        .await;
    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = folder.path().to_string_lossy().into_owned();
    let name = folder
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Project");
    let project = core
        .create_persistent_project(name, &path)
        .map_err(error_string)?;
    let has_session = core
        .snapshot()
        .sessions
        .iter()
        .any(|session| session.project_id == project.id);
    if !has_session {
        core.create_session(&project.id, None)
            .map_err(error_string)?;
    }
    core.ensure_project_window(&project.id)
        .map_err(error_string)?;
    Ok(Some(project))
}

#[tauri::command]
fn rename_project(
    state: State<'_, Arc<Core>>,
    project_id: String,
    name: String,
) -> Result<Project, String> {
    state
        .rename_project(&project_id, &name)
        .map_err(error_string)
}

#[tauri::command]
fn remove_project(state: State<'_, Arc<Core>>, project_id: String) -> Result<(), String> {
    state
        .set_project_persistence(&project_id, false)
        .map(|_| ())
        .map_err(error_string)
}

#[tauri::command]
fn set_project_persistent(
    state: State<'_, Arc<Core>>,
    project_id: String,
    persistent: bool,
) -> Result<Project, String> {
    state
        .set_project_persistence(&project_id, persistent)
        .map_err(error_string)
}

#[tauri::command]
async fn open_project(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
    project_id: String,
) -> Result<(), String> {
    Arc::clone(state.inner())
        .open_project(&project_id, Some(window.label()))
        .map_err(error_string)
}

#[tauri::command]
fn reorder_projects(state: State<'_, Arc<Core>>, project_ids: Vec<String>) -> Result<(), String> {
    state.reorder_projects(&project_ids).map_err(error_string)
}

#[tauri::command]
async fn create_session(
    state: State<'_, Arc<Core>>,
    project_id: String,
    shell_id: Option<String>,
) -> Result<TerminalSession, String> {
    Arc::clone(state.inner())
        .create_session(&project_id, shell_id.as_deref())
        .map_err(error_string)
}

#[tauri::command]
fn close_session(state: State<'_, Arc<Core>>, session_id: String) {
    Arc::clone(state.inner()).close_session(&session_id);
}

#[tauri::command]
fn reorder_sessions(
    state: State<'_, Arc<Core>>,
    project_id: String,
    session_ids: Vec<String>,
) -> Result<(), String> {
    state
        .reorder_project_sessions(&project_id, &session_ids)
        .map_err(error_string)
}

#[tauri::command]
fn write_session(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
    session_id: String,
    data: String,
    cols: Option<u16>,
    rows: Option<u16>,
) {
    state.write_desktop_session(window.label(), &session_id, &data, cols, rows);
}

#[tauri::command]
fn resize_session(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
    session_id: String,
    cols: u16,
    rows: u16,
    claim: bool,
) {
    state.resize_desktop_session(window.label(), &session_id, cols, rows, claim);
}

#[tauri::command]
fn attach_session(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
    session_id: String,
    cols: u16,
    rows: u16,
    claim: bool,
) -> Result<SessionSnapshot, String> {
    state
        .attach_window_session(window.label(), &session_id, cols, rows, claim)
        .map_err(error_string)
}

#[tauri::command]
fn detach_session(window: WebviewWindow, state: State<'_, Arc<Core>>, session_id: String) {
    state.detach_window_session(window.label(), &session_id);
}

#[tauri::command]
fn release_session_viewport(window: WebviewWindow, state: State<'_, Arc<Core>>, session_id: String) {
    state.release_window_viewport(window.label(), &session_id);
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())
}

/// The system clipboard's text, for a pane's Ctrl+V: the WebView swallows
/// the native paste before xterm can turn it into a paste event, so the pane
/// reads the clipboard here and types it in as ordinary input.
#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn log_debug(message: String) {
    core::sync_debug_from_webview(&message);
}

#[tauri::command]
fn start_pairing(state: State<'_, Arc<Core>>) -> Result<PairingPayload, String> {
    state.start_pairing().map_err(error_string)
}

#[tauri::command]
fn retry_remote_registration(state: State<'_, Arc<Core>>) -> Result<(), String> {
    Arc::clone(state.inner())
        .retry_remote_registration()
        .map_err(error_string)
}

#[tauri::command]
fn revoke_device(state: State<'_, Arc<Core>>, device_id: String) -> Result<(), String> {
    state.revoke_device(&device_id).map_err(error_string)
}

#[tauri::command]
fn set_default_shell(state: State<'_, Arc<Core>>, shell_id: String) -> Result<(), String> {
    state.set_default_shell(&shell_id).map_err(error_string)
}

#[tauri::command]
fn set_default_terminal(state: State<'_, Arc<Core>>) -> Result<(), String> {
    // Per-user registry write; the state broadcast below recomputes
    // `is_default_terminal`, so the settings row flips to Undo on success.
    crate::default_terminal::set_as_default_terminal()?;
    state.broadcast();
    Ok(())
}

#[tauri::command]
fn unset_default_terminal(state: State<'_, Arc<Core>>) -> Result<(), String> {
    crate::default_terminal::clear_as_default_terminal()?;
    state.broadcast();
    Ok(())
}

/// The handoff a console asked us to bring forward, claimed once by the
/// window that asks first. The matching event is emitted too, but a window
/// created *by* the handoff is not listening yet when it goes out.
#[tauri::command]
fn take_focus_session(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
) -> Option<FocusSessionEvent> {
    state.take_pending_focus(window.label())
}

#[tauri::command]
fn set_terminal_theme(
    state: State<'_, Arc<Core>>,
    dark_scheme_id: String,
    light_scheme_id: String,
) -> Result<(), String> {
    state
        .set_terminal_theme(&dark_scheme_id, &light_scheme_id)
        .map_err(error_string)
}

#[tauri::command]
fn set_open_projects_in_new_windows(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
    enabled: bool,
) -> Result<(), String> {
    state
        .set_open_projects_in_new_windows(enabled, Some(window.label()))
        .map_err(error_string)
}

#[tauri::command]
fn set_confirm_external_links(
    state: State<'_, Arc<Core>>,
    enabled: bool,
) -> Result<(), String> {
    state
        .set_confirm_external_links(enabled)
        .map_err(error_string)
}

#[tauri::command]
fn set_follow_working_directory(
    state: State<'_, Arc<Core>>,
    enabled: bool,
) -> Result<(), String> {
    state
        .set_follow_working_directory(enabled)
        .map_err(error_string)
}

#[tauri::command]
async fn select_shell(
    state: State<'_, Arc<Core>>,
    session_id: Option<String>,
    shell_id: String,
) -> Result<Option<TerminalSession>, String> {
    Arc::clone(state.inner())
        .select_shell(session_id.as_deref(), &shell_id)
        .map_err(error_string)
}

pub fn run() {
    // COM starts us with `-Embedding` to serve a console handoff. That
    // instance has to keep running and register the handoff class itself,
    // so it must not hand its command line to an existing instance and
    // exit the way a second user-launched window would.
    let com_embedding = std::env::args().any(|arg| arg.eq_ignore_ascii_case("-Embedding"));
    let mut builder = tauri::Builder::default();
    if !com_embedding {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(core) = app.try_state::<Arc<Core>>() {
                show_terminal_window_from_worker(Arc::clone(core.inner()));
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_path = std::env::var_os("AGENT_TERMINAL_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?)
                .join("agent-terminal.json");
            let store = DesktopStore::load(data_path)?;
            let core = Core::new(app.handle().clone(), store);
            app.manage(Arc::clone(&core));
            build_tray(app)?;
            core.initialize()?;
            default_terminal::start(Arc::clone(&core));
            remote::start(Arc::clone(&core));
            core.start_connectivity_monitor();
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                window
                    .state::<Arc<Core>>()
                    .mark_window_focused(window.label());
            }
            tauri::WindowEvent::Destroyed => {
                window
                    .state::<Arc<Core>>()
                    .unregister_window(window.label());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            create_project,
            rename_project,
            remove_project,
            set_project_persistent,
            open_project,
            reorder_projects,
            create_session,
            close_session,
            reorder_sessions,
            write_session,
            resize_session,
            attach_session,
            detach_session,
            release_session_viewport,
            copy_text,
            read_clipboard,
            log_debug,
            start_pairing,
            retry_remote_registration,
            revoke_device,
            set_default_shell,
            set_terminal_theme,
            set_open_projects_in_new_windows,
            set_confirm_external_links,
            set_follow_working_directory,
            select_shell,
            set_default_terminal,
            unset_default_terminal,
            take_focus_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agent Terminal");

    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. }
            if !handle.state::<Arc<Core>>().exit_requested() =>
        {
            api.prevent_exit();
        }
        tauri::RunEvent::Exit => handle.state::<Arc<Core>>().shutdown(),
        _ => {}
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    // The label above Exit is a read-only status line, so it is built
    // disabled: it renders but never fires a menu event.
    let core = Arc::clone(app.state::<Arc<Core>>().inner());
    let session_count = MenuItem::with_id(
        app,
        "session-count",
        session_count_label(core.session_counts()),
        false,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&session_count, &exit])?;
    // Reuse the icon embedded into the app binary (the same one the window
    // and taskbar show) so the tray always matches the desktop icon; the
    // procedural glyph only stands in if no icon was embedded.
    let tray_icon = app.default_window_icon().cloned().unwrap_or_else(|| tray_icon());
    TrayIconBuilder::with_id("agent-terminal")
        .icon(tray_icon)
        .tooltip("Agent Terminal")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "exit" {
                app.state::<Arc<Core>>().request_exit();
                app.state::<Arc<Core>>().shutdown();
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let core = Arc::clone(tray.app_handle().state::<Arc<Core>>().inner());
                show_terminal_window_from_worker(core);
            }
        })
        .build(app)?;
    spawn_tray_session_count_refresher(core, session_count);
    Ok(())
}

/// How often the tray's session label re-reads the live count. Half a second
/// keeps it responsive to tabs opening and closing; the label is rewritten
/// in place only when the count actually moved, so an idle host never hands
/// work to the main thread between changes.
const TRAY_SESSION_COUNT_TICK_MS: u64 = 500;

fn spawn_tray_session_count_refresher(core: Arc<Core>, label: MenuItem<Wry>) {
    let mut last = session_count_label(core.session_counts());
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(TRAY_SESSION_COUNT_TICK_MS));
        let text = session_count_label(core.session_counts());
        if text != last {
            last = text.clone();
            let _ = label.set_text(&text);
        }
    });
}

/// The tray's one-line summary of what the host is doing: how many open
/// tabs are running something, out of how many are open. A bare count of
/// open tabs reads as a claim about activity it was not making, so the
/// word "active" is reserved for the tabs that earned it, and the plain
/// count stands when none have.
fn session_count_label((active, open): (usize, usize)) -> String {
    if active > 0 {
        let sessions = if open == 1 { "session" } else { "sessions" };
        return format!("{active} of {open} {sessions} active");
    }
    match open {
        0 => "No open sessions".to_string(),
        1 => "1 open session".to_string(),
        open => format!("{open} open sessions"),
    }
}

// WebView2 can deadlock when a second webview is constructed directly inside a
// Windows event handler. Keep tray and single-instance callbacks off that thread.
fn show_terminal_window_from_worker(core: Arc<Core>) {
    let _ = std::thread::spawn(move || core.show_terminal_window());
}

fn tray_icon() -> Image<'static> {
    // Fallback only: see build_tray, which prefers the embedded app icon.
    let width = 32_u32;
    let height = 32_u32;
    let mut rgba = vec![0_u8; (width * height * 4) as usize];
    for y in 3..29 {
        for x in 3..29 {
            let rounded_corner = !(6..=26).contains(&x) && !(6..=26).contains(&y);
            if rounded_corner {
                continue;
            }
            set_pixel(&mut rgba, width, x, y, [22, 29, 38, 255]);
        }
    }
    for offset in 0..8 {
        set_pixel(
            &mut rgba,
            width,
            9 + offset,
            10 + offset / 2,
            [126, 224, 201, 255],
        );
        set_pixel(
            &mut rgba,
            width,
            16 - offset,
            14 + offset / 2,
            [126, 224, 201, 255],
        );
    }
    for x in 17..24 {
        for y in 21..23 {
            set_pixel(&mut rgba, width, x, y, [126, 224, 201, 255]);
        }
    }
    Image::new_owned(rgba, width, height)
}

fn set_pixel(rgba: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 4]) {
    let start = ((y * width + x) * 4) as usize;
    rgba[start..start + 4].copy_from_slice(&color);
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::session_count_label;

    #[test]
    fn label_reports_zero_as_no_open_sessions() {
        assert_eq!(session_count_label((0, 0)), "No open sessions");
    }

    #[test]
    fn label_uses_the_singular_form_for_one_idle_session() {
        assert_eq!(session_count_label((0, 1)), "1 open session");
    }

    #[test]
    fn label_uses_the_plural_form_from_two_idle_sessions_up() {
        assert_eq!(session_count_label((0, 2)), "2 open sessions");
        assert_eq!(session_count_label((0, 42)), "42 open sessions");
    }

    #[test]
    fn label_reports_how_many_of_the_open_tabs_are_running_something() {
        assert_eq!(session_count_label((1, 2)), "1 of 2 sessions active");
        assert_eq!(session_count_label((3, 3)), "3 of 3 sessions active");
    }

    #[test]
    fn label_keeps_the_singular_when_the_one_open_tab_is_the_busy_one() {
        assert_eq!(session_count_label((1, 1)), "1 of 1 session active");
    }
}
