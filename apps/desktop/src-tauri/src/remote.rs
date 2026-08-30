use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::async_runtime;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

use crate::core::Core;

pub fn start(core: Arc<Core>) {
    // First launch exposes only the LAN pairing listener. A known remote
    // identity is re-verified against the control server before the badge may
    // show "enrolled" again; a previous failure gets one automatic recovery
    // on this launch and no retry loop during the session.
    core.resume_remote_node();
    let direct_core = Arc::clone(&core);
    async_runtime::spawn(async move {
        run_direct_server(direct_core).await;
    });
}

async fn run_direct_server(core: Arc<Core>) {
    let address = format!("0.0.0.0:{}", core.configured_port());
    let listener = match TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) => {
            core.set_direct_server_ready(false);
            eprintln!("Agent Terminal direct server could not bind {address}: {error}");
            return;
        }
    };
    if let Ok(address) = listener.local_addr() {
        core.set_remote_port(address.port());
    }
    core.set_direct_server_ready(true);
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let client_core = Arc::clone(&core);
                async_runtime::spawn(async move {
                    handle_direct_client(client_core, stream).await;
                });
            }
            Err(error) => eprintln!("Agent Terminal direct server accept error: {error}"),
        }
    }
}

async fn handle_direct_client(core: Arc<Core>, stream: TcpStream) {
    let socket = match accept_async(stream).await {
        Ok(socket) => socket,
        Err(_) => return,
    };
    let id = format!("direct-{}", Uuid::new_v4());
    let (mut writer, mut reader) = socket.split();
    let (message_tx, mut message_rx) = mpsc::unbounded_channel::<String>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();
    core.add_direct_client(id.clone(), message_tx, close_tx);

    loop {
        tokio::select! {
            Some(payload) = message_rx.recv() => {
                if writer.send(Message::Text(payload.into())).await.is_err() { break; }
            }
            Some(_) = close_rx.recv() => {
                let _ = writer.send(Message::Close(None)).await;
                break;
            }
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(payload))) => core.handle_client_raw(&id, payload.as_ref()),
                    Some(Ok(Message::Binary(payload))) => {
                        if let Ok(text) = std::str::from_utf8(&payload) { core.handle_client_raw(&id, text); }
                    }
                    Some(Ok(Message::Ping(payload))) => { let _ = writer.send(Message::Pong(payload)).await; }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
    core.remove_client(&id);
}
