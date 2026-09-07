//! The COM thread that owns `ITaskbarList3` and applies taskbar progress
//! states to the app's windows, the same native API Windows Terminal's
//! `IslandWindow` uses for its ConEmu `OSC 9;4` progress reports
//! (microsoft/terminal #8055).
//!
//! `ITaskbarList3` is an apartment-bound COM object: it must be created
//! on a single thread that pumps messages, and every call to it must
//! happen on that thread. The engine therefore owns a dedicated thread
//! with a hidden message-only window. The host queues a state change per
//! window handle; the pump applies the queue in stream order, so a
//! window never shows a stale indicator from an out-of-order write. On
//! shutdown the engine clears every window it set a state on - a progress
//! bar or spinner must never survive the app exit - and stops the
//! thread.
//!
//! On non-Windows hosts the module is a no-op: the desktop shell and its
//! taskbar do not exist there.

use std::sync::{Arc, Mutex};
#[cfg(not(windows))]
use std::thread::JoinHandle;

/// A queued state change for one window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskbarCommand {
    /// Apply ConEmu `st` code `state` (0-4) and its 0-100 `progress` to
    /// the window's taskbar button.
    Set { state: u8, progress: u32 },
    /// Remove the progress indicator (ConEmu state 0).
    Clear,
    /// Clear every window this engine touched and stop the pump.
    Shutdown,
}

/// The app's taskbar progress engine, owned by [`crate::core::Core`] and
/// shared across threads: the host queues commands, the engine thread
/// applies them.
pub struct TaskbarEngine {
    #[cfg(windows)]
    queue: Arc<Mutex<Queue>>,
    #[cfg(not(windows))]
    handle: Option<JoinHandle<()>>,
}

#[cfg(windows)]
struct Queue {
    /// Commands queued since the pump last drained, with the window
    /// handle each applies to.
    pending: Vec<(isize, TaskbarCommand)>,
    /// The hidden message-only window that wakes the pump; zero until
    /// the engine thread created it.
    msg_window: isize,
    /// Set when the host asked for shutdown; the pump applies it.
    shutdown_requested: bool,
}

impl TaskbarEngine {
    /// Starts the engine thread. No-op on non-Windows hosts.
    pub fn start() -> Self {
        #[cfg(windows)]
        {
            let queue = Arc::new(Mutex::new(Queue {
                pending: Vec::new(),
                msg_window: 0,
                shutdown_requested: false,
            }));
            let queue_thread = Arc::clone(&queue);
            let _ = std::thread::Builder::new()
                .name("taskbar-progress".into())
                .spawn(move || engine_loop(queue_thread));
            Self { queue }
        }
        #[cfg(not(windows))]
        {
            Self { handle: None }
        }
    }

    /// Queues the state for one window handle; the engine thread applies
    /// it in stream order.
    pub fn set(&self, hwnd: isize, state: u8, progress: u32) {
        self.queue_command(hwnd, TaskbarCommand::Set { state, progress })
    }

    /// Queues a clear for one window handle.
    pub fn clear(&self, hwnd: isize) {
        self.queue_command(hwnd, TaskbarCommand::Clear)
    }

    /// Clears every window the engine touched and stops the thread.
    /// The engine drains its queue before exiting, so the final clears
    /// land ahead of the process exit, which destroys the windows.
    pub fn shutdown(&self) {
        self.queue_command(0, TaskbarCommand::Shutdown);
        #[cfg(not(windows))]
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }

    #[cfg(windows)]
    fn queue_command(&self, hwnd: isize, command: TaskbarCommand) {
        use winapi::shared::windef::HWND;
        use winapi::um::winuser::{PostMessageW, WM_APP};
        let mut guard = self.queue.lock().expect("taskbar engine poisoned");
        let wake = guard.pending.is_empty();
        if matches!(command, TaskbarCommand::Shutdown) {
            guard.shutdown_requested = true;
        }
        guard.pending.push((hwnd, command));
        // One wake-up per batch: the pump drains the whole queue, so a
        // wake is only owed while the queue was empty and the window
        // exists to receive it.
        if wake && guard.msg_window != 0 {
            unsafe {
                PostMessageW(guard.msg_window as HWND, WM_APP, 0, 0);
            }
        }
    }

    #[cfg(not(windows))]
    fn queue_command(&self, _hwnd: isize, _command: TaskbarCommand) {}
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::ptr;
    use std::sync::{Arc, Mutex};

    use winapi::Interface;
    use winapi::shared::minwindef::{LPARAM, LPVOID, LRESULT, WPARAM};
    use winapi::shared::windef::HWND;
    use winapi::shared::wtypesbase::CLSCTX_INPROC_SERVER;
    use winapi::um::combaseapi::{CoCreateInstance, CoInitializeEx, CoUninitialize};
    use winapi::um::libloaderapi::GetModuleHandleW;
    use winapi::um::objbase::COINIT_APARTMENTTHREADED;
    use winapi::um::shobjidl_core::{
        CLSID_TaskbarList, ITaskbarList3, TBPF_ERROR, TBPF_INDETERMINATE, TBPF_NOPROGRESS,
        TBPF_NORMAL, TBPF_PAUSED, TBPFLAG,
    };
    use winapi::um::winuser::{
        CreateWindowExW, DefWindowProcW, HWND_MESSAGE, MSG, MsgWaitForMultipleObjects, PM_REMOVE,
        PeekMessageW, QS_ALLEVENTS, RegisterClassExW, WM_APP, WNDCLASSEXW,
    };

    use super::{Queue, TaskbarCommand};

    const INFINITE: u32 = u32::MAX;
    const WAIT_FAILED: u32 = u32::MAX;

    /// The engine thread. A single apartment-locked thread creates the
    /// taskbar object and applies every call to it, in stream order.
    pub(crate) fn engine_loop(queue: Arc<Mutex<Queue>>) {
        unsafe {
            let _ = CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED);
            // winapi's RIDL interfaces are structs wrapping a vtbl
            // pointer, and `CoCreateInstance` writes the object pointer
            // into a *variable of type `*mut ITaskbarList3``. The method
            // sugar then auto-derefs that pointer, so the receiver is
            // the COM object itself - whose first field is the real
            // vtbl. Storing the pointer in a zeroed struct local instead
            // makes the methods read the object pointer *as* the vtbl
            // and jump to garbage: an access violation on the first
            // call (and the app's startup crash, since the engine
            // thread starts with the process).
            let mut taskbar: *mut ITaskbarList3 = ptr::null_mut();
            let hr = CoCreateInstance(
                &CLSID_TaskbarList,
                ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &ITaskbarList3::uuidof(),
                &mut taskbar as *mut *mut ITaskbarList3 as *mut LPVOID,
            );
            let taskbar: Option<*mut ITaskbarList3> = if hr < 0 {
                // The taskbar object is unavailable (old Windows, or COM
                // failed): the pump still runs so shutdown can stop it,
                // but applies nothing.
                None
            } else {
                Some(taskbar)
            };

            // The hidden window that wakes the pump. A message-only
            // window has no taskbar or alt-tab presence of its own.
            let instance = GetModuleHandleW(ptr::null_mut());
            // The class name must be a NUL-terminated *wide* string:
            // `RegisterClassExW` and `CreateWindowExW` read UTF-16, and
            // a Rust `&str` is UTF-8, so the system would walk the
            // literal byte-for-byte past its end looking for a 16-bit
            // zero - an out-of-bounds read, or a garbage class name.
            let class_name: Vec<u16> = "AgentTerminalTaskbarProgress"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut window_class: WNDCLASSEXW = std::mem::zeroed();
            window_class.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            window_class.lpfnWndProc = Some(wnd_proc);
            window_class.hInstance = instance;
            window_class.lpszClassName = class_name.as_ptr() as *mut _;
            let atom = RegisterClassExW(&window_class);
            let msg_window = if atom != 0 {
                CreateWindowExW(
                    0,
                    class_name.as_ptr() as *mut _,
                    class_name.as_ptr() as *mut _,
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    ptr::null_mut(),
                    instance,
                    ptr::null_mut(),
                )
            } else {
                ptr::null_mut()
            };

            // Every window this engine set a non-clear state on, so
            // shutdown can clear them all.
            let mut applied: HashMap<isize, bool> = HashMap::new();
            let mut stopped = false;
            {
                let mut guard = queue.lock().expect("taskbar engine poisoned");
                guard.msg_window = msg_window as isize;
                // Commands queued before the pump was ready apply now,
                // through the same tracking as the live loop.
                let pending = std::mem::take(&mut guard.pending);
                let shutdown_requested = guard.shutdown_requested;
                for (hwnd, command) in &pending {
                    apply(*hwnd, *command, taskbar, &mut applied);
                    if matches!(command, TaskbarCommand::Shutdown) {
                        stopped = true;
                    }
                }
                if shutdown_requested {
                    stopped = true;
                }
            }
            while !stopped {
                let waited =
                    MsgWaitForMultipleObjects(0, ptr::null_mut(), 0, INFINITE, QS_ALLEVENTS);
                if waited == WAIT_FAILED {
                    break;
                }
                let mut message: MSG = std::mem::zeroed();
                while PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) == 1 {
                    if message.message != WM_APP {
                        continue;
                    }
                    let (batch, shutdown_pending) = {
                        let mut guard = queue.lock().expect("taskbar engine poisoned");
                        let batch = std::mem::take(&mut guard.pending);
                        (batch, guard.shutdown_requested)
                    };
                    for (hwnd, command) in &batch {
                        apply(*hwnd, *command, taskbar, &mut applied);
                        if matches!(command, TaskbarCommand::Shutdown) {
                            stopped = true;
                        }
                    }
                    if shutdown_pending {
                        stopped = true;
                    }
                }
            }
            // Balance the apartment init: release the object, then
            // tear down the apartment before the thread exits.
            if let Some(list) = taskbar {
                let list = list.as_ref().expect("taskbar object");
                list.Release();
            }
            CoUninitialize();
        }
    }

    fn apply(
        hwnd: isize,
        command: TaskbarCommand,
        taskbar: Option<*mut ITaskbarList3>,
        applied: &mut HashMap<isize, bool>,
    ) {
        let taskbar = unsafe { taskbar.and_then(|taskbar| taskbar.as_ref()) };
        let Some(taskbar) = taskbar else {
            return;
        };
        let handle = hwnd as HWND;
        match command {
            TaskbarCommand::Set { state, progress } => unsafe {
                let flag = tbp_flag(state);
                if state == 3 {
                    // Windows Terminal's stuck-spinner fix: a repeat
                    // indeterminate state must restart the animation,
                    // so clear it first.
                    let _ = taskbar.SetProgressState(handle, TBPF_NOPROGRESS);
                }
                let _ = taskbar.SetProgressState(handle, flag);
                // The taskbar ignores values on the non-NORMAL states,
                // but Windows Terminal sets them anyway (the value marks
                // the progress at which the error or pause happened).
                if matches!(state, 1 | 2 | 4) {
                    let _ = taskbar.SetProgressValue(handle, progress as u64, 100);
                }
                applied.insert(hwnd, state != 0);
            },
            TaskbarCommand::Clear => unsafe {
                let _ = taskbar.SetProgressState(handle, TBPF_NOPROGRESS);
                applied.remove(&hwnd);
            },
            TaskbarCommand::Shutdown => {
                // Never exit with a progress bar or spinner: clear every
                // window that still has an active state.
                for (window, active) in applied {
                    if *active {
                        unsafe {
                            let _ = taskbar.SetProgressState(*window as HWND, TBPF_NOPROGRESS);
                        }
                    }
                }
            }
        }
    }

    fn tbp_flag(state: u8) -> TBPFLAG {
        match state {
            1 => TBPF_NORMAL,
            2 => TBPF_ERROR,
            3 => TBPF_INDETERMINATE,
            4 => TBPF_PAUSED,
            _ => TBPF_NOPROGRESS,
        }
    }

    /// The window procedure of the hidden wake-up window: nothing to do,
    /// the pump reads its queue directly.
    #[allow(non_snake_case)]
    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        message: u32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, message, w_param, l_param) }
    }
}

#[cfg(windows)]
use imp::engine_loop;

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Duration;

    use crate::taskbar_engine::TaskbarEngine;

    /// Headless smoke test of the whole engine lifecycle: thread start,
    /// COM object creation, wake window, queued applies, shutdown.
    /// A fault in the COM interop (the startup-crash bug) surfaces
    /// here as an access violation, so this test guards the fix.
    #[test]
    #[cfg(windows)]
    fn engine_lifecycle_headless() {
        let engine = TaskbarEngine::start();
        thread::sleep(Duration::from_millis(500));
        engine.set(0x1_2345, 1, 50);
        engine.set(0x1_2345, 3, 0);
        engine.clear(0x1_2345);
        engine.shutdown();
        thread::sleep(Duration::from_millis(300));
    }
}
