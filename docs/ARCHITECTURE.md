# Architecture

## Runtime topology

```text
Android / future iOS client
        │ outbound WebSocket
        ▼
Relay service (cross-network routing only)
        │ outbound WebSocket
        ▼
Tauri 2 Rust process (desktop and tray authority)
        ├── pairing and device authorization
        ├── project/device JSON persistence
        ├── project-window and session-tab routing
        ├── direct and relay connection host
        ├── native system tray
        └── portable-pty / Windows ConPTY session manager
                 │
                 ▼
        PowerShell / cmd / WSL / Git Bash

Tauri WebView2 windows
        └── React + xterm.js views over allowlisted Tauri commands/events
```

When `AGENT_TERMINAL_RELAY_URL` is configured, both the desktop and phone initiate outbound WebSocket connections to the relay. The relay matches the desktop's host ID to the phone's temporary connection ID and forwards opaque protocol payloads. It has no project, device, or terminal state. If the variable is absent, the QR payload uses the desktop's direct LAN WebSocket as a development fallback.

The desktop is single-instance. A second launch delegates focus to the existing tray host and exits before starting another runtime. In direct mode, the desktop refuses to issue a QR unless its process successfully owns the configured WebSocket port.

The Rust tray process is the only authority. Tauri webviews and mobile clients request operations; they never access the file system or spawn processes directly. Terminal windows are disposable clients: closing every window does not disconnect paired phones or terminate PTYs, and the tray can create a fresh client later.

## State ownership

| State | Lifetime | Owner |
| --- | --- | --- |
| Saved projects | Persistent | Desktop JSON store |
| Authorized devices | Persistent | Desktop JSON store |
| Default shell | Persistent | Desktop JSON store |
| Terminal processes and scrollback | Tauri tray-process lifetime | Rust session manager |
| Paired host endpoint, transport, and credential | Persistent | Mobile Capacitor Preferences |
| Current mobile screen, project snapshots, terminal output | In memory | Mobile app |

Temporary projects are derived from live desktop sessions. They disappear when their final session closes unless the folder is explicitly saved as a project.

## Window and tab routing

- A project owns at most one desktop window.
- A session belongs to exactly one project.
- Creating the first live session for a project opens its window.
- Creating another session in that project adds a tab to the existing window.
- A terminal webview explicitly attaches to each rendered session. Attachment atomically returns the current scrollback and registers the window for subsequent live bytes, preventing gaps or duplicate output during tab/window transitions.
- Closing a project window destroys that client and its subscriptions; its sessions and remote connections remain owned by the tray process.
- If a shell changes directory into another project, the active window is reassigned to the destination project. Remaining tabs from the previous project are rendered by a replacement window shown behind the active window.
- Left-clicking the tray restores the most recently focused terminal window.
- Right-clicking the tray exposes the explicit Exit action that terminates sessions and the connection host.

## Pairing lifecycle

1. The desktop creates a cryptographically random pairing grant with a five-minute expiry.
2. The QR payload includes protocol version, host identity, relay endpoint (or direct development endpoint), transport, grant, and expiry.
3. The phone submits its generated device ID, display name, platform, and token.
4. The desktop consumes the grant once and returns a 256-bit device credential.
5. The phone stores the host record. The desktop stores only a SHA-256 hash of the credential.
6. Later connections authenticate with the device ID and credential through a new relay connection. No new QR scan is needed. Revocation removes the hash and disconnects active sockets for that device.

The relay connection is deliberately separate from authorization: the relay routes by host ID, while the desktop remains the authority that accepts or rejects the device credential.

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
