use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use tauri::async_runtime;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::sleep,
};
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message};
use uuid::Uuid;

use crate::{core::Core, embedded_node, models::RelayMessage};

pub fn start(core: Arc<Core>) {
    // Start the overlay node in its own process. The ordinary relay remains
    // available as a transport fallback when a release does not ship an
    // engine binary or when the node is still registering with Headscale.
    embedded_node::start(&core);
    let direct_core = Arc::clone(&core);
    async_runtime::spawn(async move {
        run_direct_server(direct_core).await;
    });
    if let Some(endpoint) = core.relay_endpoint() {
        async_runtime::spawn(async move {
            run_relay(core, endpoint).await;
        });
    }
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

async fn run_relay(core: Arc<Core>, endpoint: String) {
    loop {
        let socket = match connect_async(&endpoint).await {
            Ok((socket, _)) => socket,
            Err(error) => {
                eprintln!("Agent Terminal relay connection failed: {error}");
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let (mut writer, mut reader) = socket.split();
        let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<RelayMessage>();
        core.set_relay_sender(Some(outgoing_tx.clone()));
        let (host_id, host_token) = core.relay_identity();
        let _ = outgoing_tx.send(RelayMessage::Register {
            host_id,
            host_token,
        });

        loop {
            tokio::select! {
                Some(message) = outgoing_rx.recv() => {
                    let Ok(payload) = serde_json::to_string(&message) else { continue; };
                    if writer.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                incoming = reader.next() => {
                    let Some(Ok(Message::Text(payload))) = incoming else { break; };
                    let Ok(message) = serde_json::from_str::<RelayMessage>(payload.as_ref()) else { continue; };
                    match message {
                        RelayMessage::Message { connection_id, payload } => {
                            core.ensure_relay_client(&connection_id);
                            core.handle_client_raw(&connection_id, &payload);
                        }
                        RelayMessage::Disconnect { connection_id } => core.remove_client(&connection_id),
                        RelayMessage::Error { message } => eprintln!("Agent Terminal relay error: {message}"),
                        _ => {}
                    }
                }
            }
        }
        core.set_relay_sender(None);
        core.clear_relay_clients();
        sleep(Duration::from_secs(5)).await;
    }
}
