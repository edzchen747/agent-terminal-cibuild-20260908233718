mod core;
mod embedded_node;
mod models;
mod network;
mod path_utils;
mod provisioning;
mod remote;
mod shells;
mod store;
mod window_clients;

use std::sync::Arc;

use arboard::Clipboard;
use core::Core;
use models::{DesktopState, PairingPayload, Project, TerminalSession};
use store::DesktopStore;
use tauri::{
    Manager, State, WebviewWindow,
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
    } else {
        core.ensure_project_window(&project.id)
            .map_err(error_string)?;
    }
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
async fn open_project(state: State<'_, Arc<Core>>, project_id: String) -> Result<(), String> {
    Arc::clone(state.inner())
        .open_project(&project_id)
        .map_err(error_string)
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
    state: State<'_, Arc<Core>>,
    session_id: String,
    data: String,
    cols: Option<u16>,
    rows: Option<u16>,
) {
    if let (Some(cols), Some(rows)) = (cols, rows) {
        state.resize_session(&session_id, cols, rows, true);
    }
    state.write_session(&session_id, &data);
}

#[tauri::command]
fn resize_session(
    state: State<'_, Arc<Core>>,
    session_id: String,
    cols: u16,
    rows: u16,
    force: Option<bool>,
) {
    state.resize_session(&session_id, cols, rows, force.unwrap_or(false));
}

#[tauri::command]
fn attach_session(
    window: WebviewWindow,
    state: State<'_, Arc<Core>>,
    session_id: String,
) -> Result<String, String> {
    state
        .attach_window_session(window.label(), &session_id)
        .map_err(error_string)
}

#[tauri::command]
fn detach_session(window: WebviewWindow, state: State<'_, Arc<Core>>, session_id: String) {
    state.detach_window_session(window.label(), &session_id);
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_pairing(state: State<'_, Arc<Core>>) -> Result<PairingPayload, String> {
    state.start_pairing().map_err(error_string)
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(core) = app.try_state::<Arc<Core>>() {
                show_terminal_window_from_worker(Arc::clone(core.inner()));
            }
        }))
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
            remote::start(core);
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
            create_session,
            close_session,
            reorder_sessions,
            write_session,
            resize_session,
            attach_session,
            detach_session,
            copy_text,
            start_pairing,
            revoke_device,
            set_default_shell,
            select_shell,
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
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&exit])?;
    TrayIconBuilder::with_id("agent-terminal")
        .icon(tray_icon())
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
    Ok(())
}

// WebView2 can deadlock when a second webview is constructed directly inside a
// Windows event handler. Keep tray and single-instance callbacks off that thread.
fn show_terminal_window_from_worker(core: Arc<Core>) {
    let _ = std::thread::spawn(move || core.show_terminal_window());
}

fn tray_icon() -> Image<'static> {
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
