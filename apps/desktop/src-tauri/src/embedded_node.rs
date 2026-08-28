//! Process-isolated overlay node launcher.
//!
//! The release bundle supplies an `embedded-node` executable next to the
//! desktop binary. Keeping the node in a child process means a crashed or
//! upgraded overlay implementation cannot take down the terminal authority.
//! The executable is intentionally replaceable so a signed tsnet/Tailscale
//! userspace engine can be shipped without changing the Tauri protocol.

use std::sync::Arc;

use crate::core::Core;

pub fn start(core: &Arc<Core>) {
    if let Err(error) = core.start_embedded_node() {
        eprintln!("Agent Terminal embedded network node is unavailable: {error}");
    }
}
