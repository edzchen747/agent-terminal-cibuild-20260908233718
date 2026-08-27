# Architecture

## Runtime topology

```text
Android / future iOS client
        │ local WebSocket
        ▼
Electron main process (desktop authority)
        ├── pairing and device authorization
        ├── project/device JSON persistence
        ├── project-window and session-tab routing
        └── ConPTY session manager
                 │
                 ▼
        PowerShell / cmd / WSL / Git Bash

Electron renderer
        └── xterm.js views over typed IPC
```

The Electron main process is the only authority. Renderers and mobile clients request operations; they never access the file system or spawn processes directly.

## State ownership

| State | Lifetime | Owner |
| --- | --- | --- |
| Saved projects | Persistent | Desktop JSON store |
| Authorized devices | Persistent | Desktop JSON store |
| Default shell | Persistent | Desktop JSON store |
| Terminal processes and scrollback | Desktop process lifetime | Desktop session manager |
| Paired host endpoint and credential | Persistent | Mobile Capacitor Preferences |
| Current mobile screen, project snapshots, terminal output | In memory | Mobile app |

Temporary projects are derived from live desktop sessions. They disappear when their final session closes unless the folder is explicitly saved as a project.

## Window and tab routing

- A project owns at most one desktop window.
- A session belongs to exactly one project.
- Creating the first live session for a project opens its window.
- Creating another session in that project adds a tab to the existing window.
- Closing a project window terminates that project's sessions.

## Pairing lifecycle

1. The desktop creates a cryptographically random, one-use token with a five-minute expiry.
2. The QR payload includes protocol version, host identity, LAN endpoint, token, and expiry.
3. The phone submits its generated device ID, display name, platform, and token.
4. The desktop consumes the token and returns a 256-bit device credential.
5. The phone stores the host record. The desktop stores only a SHA-256 hash of the credential.
6. Later connections authenticate with the device ID and credential. Revocation removes the hash and disconnects active sockets for that device.

## Protocol

`packages/protocol` is the canonical shared contract. Messages cover:

- pairing and authentication;
- host snapshots;
- project creation/removal;
- session create/close/attach/detach;
- terminal input, output, and resize events.

An attached mobile terminal receives a bounded 512 KB scrollback snapshot followed by live output. Desktop xterm views maintain their own larger visual scrollback.

## iOS path

The mobile UI and connection layer use browser APIs plus Capacitor abstractions. Adding iOS consists of installing `@capacitor/ios`, running `cap add ios`, adding the camera usage description, and validating local-network permission behavior. No protocol or desktop changes are required.

