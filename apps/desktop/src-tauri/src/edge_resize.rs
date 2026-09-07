//! Native edge resizing for the app's undecorated windows (Windows).
//!
//! The project windows are built without decorations (see the
//! `WebviewWindowBuilder` calls in core.rs): the renderer paints its own
//! title bar and traffic-light controls, so Windows no longer offers the
//! window frame as a resize handle. This module restores that affordance
//! by subclassing the top-level WndProc and answering `WM_NCHITTEST`
//! ourselves: while the cursor is within `RESIZE_MARGIN` pixels of an edge
//! or corner, the matching `HT*` code is reported and the system runs the
//! resize with the familiar sizing cursors, exactly as it does for a
//! decorated window — no JavaScript involved.
//!
//! On Windows the system keeps hit-testing those bands for us throughout
//! the drag, which is why the resize stays smooth even when the cursor
//! leaves the window. Everything else is a no-op: on the other platforms
//! the product's windowing conventions differ (it targets Windows), so
//! only Windows needs the subclass.

/// Installs the edge-resize hit-test on `window`. Call it right after the
/// window has been built (the two `WebviewWindowBuilder` sites in core.rs).
///
/// Best effort by design: if the native handle cannot be read or the
/// subclass cannot be attached, the window simply keeps working without
/// edge resizing instead of failing to open.
pub fn install(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        sys::install(hwnd.0);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

// Non-client hit codes (winuser.h).
const HTCLIENT: isize = 1;
const HTLEFT: isize = 10;
const HTRIGHT: isize = 11;
const HTTOP: isize = 12;
const HTTOPLEFT: isize = 13;
const HTTOPRIGHT: isize = 14;
const HTBOTTOM: isize = 15;
const HTBOTTOMLEFT: isize = 16;
const HTBOTTOMRIGHT: isize = 17;

/// How close to a window edge the cursor must be for Windows to start a
/// resize, in physical pixels. 8 matches the grab band a decorated window
/// gets on Windows (the 4px resize frame plus the padded-border
/// allowance), so dragging feels the same as with the native frame.
const RESIZE_MARGIN: isize = 8;

/// Maps a cursor position in client-area coordinates (physical pixels, the
/// origin at the client area's top-left) to the non-client hit code the
/// window should report from `WM_NCHITTEST`: an edge/corner code when the
/// cursor is inside the resize band, `HTCLIENT` otherwise. Kept pure so
/// the geometry is unit-testable on every platform.
fn edge_hit_code(x: isize, y: isize, width: isize, height: isize) -> isize {
    let left = x < RESIZE_MARGIN;
    let right = x >= width - RESIZE_MARGIN;
    let top = y < RESIZE_MARGIN;
    let bottom = y >= height - RESIZE_MARGIN;
    if left || right {
        if top {
            return if left { HTTOPLEFT } else { HTTOPRIGHT };
        }
        if bottom {
            return if left { HTBOTTOMLEFT } else { HTBOTTOMRIGHT };
        }
    }
    if top {
        return HTTOP;
    }
    if bottom {
        return HTBOTTOM;
    }
    if left {
        return HTLEFT;
    }
    if right {
        return HTRIGHT;
    }
    HTCLIENT
}

#[cfg(target_os = "windows")]
mod sys {
    use std::ffi::c_void;

    const WM_NCHITTEST: u32 = 0x0008;

    /// Identifies our subclass; the value is opaque and only needs to be
    /// unique for the (window, proc) pair.
    const SUBCLASS_ID: u32 = 0x4154;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    type Hwnd = *mut c_void;

    /// The SUBCLASSPROC signature: (HWND, UINT, WPARAM, LPARAM, DWORD,
    /// DWORD_PTR) -> LRESULT.
    type SubclassProc =
        unsafe extern "system" fn(Hwnd, u32, usize, isize, u32, usize) -> isize;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn ScreenToClient(hwnd: Hwnd, point: *mut Point) -> i32;
        fn GetClientRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn IsZoomed(hwnd: Hwnd) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn SetWindowSubclass(hwnd: Hwnd, proc: SubclassProc, id: u32, ref_data: usize) -> i32;
        fn DefSubclassProc(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
    }

    /// The WndProc we hang off every undecorated window. Only
    /// `WM_NCHITTEST` is intercepted — to report the resize band — and even
    /// that only while the window is not maximised (a maximised borderless
    /// window has no edges to resize from; restoring is the green
    /// traffic-light's job). Everything else is forwarded to the previous
    /// procedure (tao's), so the rest of the app's window handling is
    /// untouched. Windows removes the subclass automatically when the
    /// window is destroyed.
    unsafe extern "system" fn edge_resize_proc(
        hwnd: Hwnd,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _id: u32,
        _ref_data: usize,
    ) -> isize {
        if msg == WM_NCHITTEST && unsafe { IsZoomed(hwnd) } == 0 {
            // WM_NCHITTEST hands us the cursor position in SCREEN
            // coordinates; make it relative to the client area before
            // comparing against the edge bands.
            let mut point = Point {
                x: (lparam & 0xFFFF) as i16 as i32,
                y: ((lparam >> 16) & 0xFFFF) as i16 as i32,
            };
            unsafe { ScreenToClient(hwnd, &mut point) };
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if unsafe { GetClientRect(hwnd, &mut rect) } != 0 {
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width > 0 && height > 0 {
                    return super::edge_hit_code(point.x as _, point.y as _, width as _, height as _);
                }
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub fn install(hwnd: Hwnd) {
        // Best effort: a stale handle or an OS refusal just means this
        // window keeps working without edge resizing.
        let _ = unsafe { SetWindowSubclass(hwnd, edge_resize_proc, SUBCLASS_ID, 0) };
    }
}

#[cfg(test)]
mod tests {
    use super::{edge_hit_code, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCLIENT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT};

    /// A 100x100 client area with the 8px margin: the bands are
    /// x in [0..8) left, x in [92..100) right, and y likewise.
    #[test]
    fn interior_reports_client() {
        assert_eq!(edge_hit_code(50, 50, 100, 100), HTCLIENT);
        assert_eq!(edge_hit_code(91, 50, 100, 100), HTCLIENT);
        assert_eq!(edge_hit_code(50, 91, 100, 100), HTCLIENT);
    }

    #[test]
    fn edges_report_their_side() {
        assert_eq!(edge_hit_code(50, 2, 100, 100), HTTOP);
        assert_eq!(edge_hit_code(50, 97, 100, 100), HTBOTTOM);
        assert_eq!(edge_hit_code(3, 50, 100, 100), HTLEFT);
        assert_eq!(edge_hit_code(95, 50, 100, 100), HTRIGHT);
    }

    #[test]
    fn corners_win_over_edges() {
        assert_eq!(edge_hit_code(2, 2, 100, 100), HTTOPLEFT);
        assert_eq!(edge_hit_code(97, 2, 100, 100), HTTOPRIGHT);
        assert_eq!(edge_hit_code(2, 97, 100, 100), HTBOTTOMLEFT);
        assert_eq!(edge_hit_code(97, 97, 100, 100), HTBOTTOMRIGHT);
    }

    #[test]
    fn cursor_just_outside_the_edge_still_resizes() {
        // Mid-drag the cursor sits inside the grab band, which on the
        // left/top side is outside the client area entirely.
        assert_eq!(edge_hit_code(-1, 50, 100, 100), HTLEFT);
        assert_eq!(edge_hit_code(50, -1, 100, 100), HTTOP);
        assert_eq!(edge_hit_code(-4, -4, 100, 100), HTTOPLEFT);
    }

    #[test]
    fn band_boundaries() {
        // 92 is the last right-band pixel, 91 back inside the interior.
        assert_eq!(edge_hit_code(92, 50, 100, 100), HTRIGHT);
        assert_eq!(edge_hit_code(91, 50, 100, 100), HTCLIENT);
        assert_eq!(edge_hit_code(8, 50, 100, 100), HTCLIENT);
        assert_eq!(edge_hit_code(7, 50, 100, 100), HTLEFT);
    }
}