#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Diagnostic: run the handoff COM registration in a bare Rust process
    // (no Tauri/WebView2) and stay alive, so a cross-process client can
    // test whether the endpoint is published to RPCSS. Usage:
    //   agent-terminal.exe --rpc-probe
    if std::env::args().any(|arg| arg == "--rpc-probe") {
        agent_terminal_lib::register_handoff_on_main_thread();
        eprintln!("rpc-probe: handoff registration started on the main thread; staying alive");
        std::thread::park();
        return;
    }
    agent_terminal_lib::run();
}
