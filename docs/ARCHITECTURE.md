# Architecture

## Runtime topology

```text
Android / future iOS client
        │ embedded tsnet node (userspace)
        ▼
Headscale at node.hopto.org
        ├── STUN/ICE-assisted direct path
        └── embedded DERP encrypted fallback
                 │
                 │ outbound encrypted node path
        ▼
Tauri 2 Rust process (desktop and tray authority)
        ├── pairing and device authorization
        ├── project/device JSON persistence
        ├── project-window and session-tab routing
        ├── direct and overlay connection host
        ├── native system tray
        └── portable-pty / Windows ConPTY session manager
                 │
                 ▼
        PowerShell / cmd / WSL / Git Bash

Tauri WebView2 windows
        └── React + xterm.js views over allowlisted Tauri commands/events
```

The QR payload always uses the desktop's direct LAN WebSocket for the first pairing. It also carries the remote endpoint and `https://node.hopto.org` control-plane address for later launches. On reconnect, mobile gives the saved LAN endpoint a 1.5-second probe; a successful probe uses the standard direct WebSocket. A failed probe starts the process-isolated embedded node and opens the saved tailnet endpoint. The live client sends application heartbeats and retries with backoff after a path loss, re-running the LAN probe before falling back to the overlay path. The stock endpoint is the desktop's Headscale DNS name on `agent-terminal.internal`; Headscale's embedded DERP handles encrypted fallback when direct NAT traversal is unavailable.

Headscale is the control plane in `server/relay`; its embedded DERP server supplies encrypted fallback relaying and UDP/3478 STUN-assisted NAT discovery. No application-level relay service is required.

The desktop is single-instance. A second launch delegates focus to the existing tray host and exits before starting another runtime. In direct mode, the desktop refuses to issue a QR unless its process successfully owns the configured WebSocket port.

The Rust tray process is the only authority. Tauri webviews and mobile clients request operations; they never access the file system or spawn processes directly. Terminal windows are disposable clients: closing every window does not disconnect paired phones or terminate PTYs, and the tray can create a fresh client later. Android's foreground service owns the user-visible connection status while the WebView owns the protocol client; the two are updated together, and a restarted service never claims the socket is connected until the WebView authenticates again.

## State ownership

| State | Lifetime | Owner |
| --- | --- | --- |
| Saved projects | Persistent | Desktop JSON store |
| Authorized devices | Persistent | Desktop JSON store |
| Default shell | Persistent | Desktop JSON store |
| Terminal processes and scrollback | Tauri tray-process lifetime | Rust session manager |
| Paired host LAN/remote endpoints, transport, and credential | Persistent | Mobile Capacitor Preferences |
| Embedded node private key and network state | Persistent | Desktop JSON store / mobile Capacitor Preferences |
| Current mobile screen, project snapshots, terminal output | In memory | Mobile app |

Temporary projects are derived from live desktop sessions. They disappear when their final session closes unless the folder is explicitly saved as a project.

## Window and tab routing

- A project owns at most one desktop window.
- A session belongs to exactly one project.
- Creating the first live session for a project opens its window.
- Creating another session in that project adds a tab to the existing window.
- A terminal webview explicitly attaches to each rendered session. Attachment atomically returns the current scrollback and registers the window for subsequent live bytes, preventing gaps or duplicate output during tab/window transitions.
- The tray validates that an attachment's session belongs to the webview's assigned project. Project reassignment retains the moved session's subscription in the active webview and removes only the old-project subscriptions before the background window renders them. Per-window snapshots and terminal bytes use label-targeted Tauri events rather than application-wide broadcasts.
- Closing a project window destroys that client and its subscriptions; its sessions and remote connections remain owned by the tray process.
- If a shell changes directory into another project, the active window is reassigned to the destination project. Remaining tabs from the previous project are rendered by a replacement window shown behind the active window.
- Left-clicking the tray restores the most recently focused terminal window, or recreates a client for its remembered project after every terminal window has been closed.
- Right-clicking the tray exposes the explicit Exit action that terminates sessions and the connection host.

## Pairing lifecycle

1. The desktop creates a cryptographically random pairing grant with a five-minute expiry and refuses to issue pairing data unless its LAN listener is ready.
2. The QR payload includes protocol version, host identity, LAN endpoint, remote endpoint/control URL, transport, grant, and expiry.
3. The phone submits its generated device ID, display name, platform, and token.
4. The desktop consumes the grant once and returns a 256-bit device credential.
5. The phone stores the host record. The desktop stores only a SHA-256 hash of the credential.
6. Later connections authenticate with the device ID and credential through the LAN endpoint when available, otherwise through the embedded node. No new QR scan is needed. Revocation removes the hash and disconnects active sockets for that device.

## Protocol

`packages/protocol` is the canonical shared contract. Messages cover:

- pairing and authentication;
- host snapshots;
- project creation/removal;
- session create/close/attach/detach;
- terminal input, output, and resize events.

An attached mobile or desktop terminal receives a bounded 512 KB scrollback snapshot followed by live output. Desktop xterm views maintain their own larger visual scrollback.

## iOS path

The mobile UI and connection layer use browser APIs plus Capacitor abstractions. Adding iOS consists of installing `@capacitor/ios`, running `cap add ios`, adding the camera usage description, and validating local-network permission behavior. No protocol or desktop changes are required.
