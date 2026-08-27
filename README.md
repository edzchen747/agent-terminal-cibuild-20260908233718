# Agent Terminal

Agent Terminal is a Windows terminal host with an Android-first companion app. It runs real interactive shells through Windows ConPTY, renders them with xterm.js, and lets an authorized phone create projects, open terminal sessions, and interact with those sessions remotely.

This repository is an end-to-end MVP, not a UI-only prototype.

## What is implemented

### Windows desktop

- Interactive ConPTY terminal sessions with Command Prompt, Windows PowerShell, PowerShell 7, WSL, and Git Bash detection.
- A collapsible project sidebar. Opening a different project creates/focuses a dedicated desktop window.
- Multiple terminal tabs per project.
- Automatic session regrouping when shell integration reports a changed working directory.
- Context-aware Ctrl+C: copies selected terminal text and otherwise sends the normal interrupt signal to the shell.
- Native folder picker for saved projects.
- QR pairing that authorizes a phone once; ordinary reconnects use the saved device credential.
- Persistent authorized-device registry with token hashing, last-seen timestamps, and immediate revocation.
- Outbound relay support for connections across Wi-Fi, mobile data, NAT, and firewall boundaries.
- Direct local WebSocket fallback on port `47831` for development without a relay.
- Desktop-owned persistence for projects, devices, and the default shell.
- Save or unsave the active project without closing its window or terminal sessions.

### Android-first mobile app

- Native QR scanning with a manual pairing-code fallback.
- Automatic reconnect to the one saved desktop host through the configured relay or direct fallback.
- Live project/session discovery whenever the app connects.
- Saved-project marker and automatic temporary projects for open desktop folders that were not saved.
- Project creation against an existing absolute folder path on the desktop.
- Save temporary projects or make saved projects temporary from the project screen.
- Session creation and full terminal input/output.
- Animated three-second key chords for Ctrl, Alt, Shift, Esc, Tab, arrows, word navigation, Backspace, and Enter; armed modifiers apply immediately to mobile keyboard input.
- Capacitor Android project checked into `apps/mobile/android` with minimum SDK 26.
- A web-first codebase that can add the Capacitor iOS target without rewriting the UI or protocol.

The mobile app persists only its host identity, endpoint, device ID, and device credential. Project data and authorization records remain on the desktop.

## Repository layout

```text
apps/
  desktop/       Electron host, ConPTY manager, remote server, desktop UI
  mobile/        React mobile UI and Capacitor Android project
packages/
  protocol/      Shared typed wire protocol and data model
scripts/         Workspace-local bootstrap and packaging helpers
docs/            Architecture and security notes
```

## Requirements

- Windows 10 1809 or newer (Windows 11 recommended).
- Node.js 22 or newer.
- Android Studio with Java 21 and Android SDK 36 to build the Android APK.
- A deployed WebSocket relay for cross-network use. The desktop connects to it with `AGENT_TERMINAL_RELAY_URL`.

No Visual Studio C++ workload is required: the desktop uses a prebuilt ConPTY binding.

## Run a relay

The relay is stateless with respect to projects and terminal sessions. It only forwards WebSocket messages between an online desktop and an already authorized phone. For local development:

```powershell
$env:AGENT_TERMINAL_RELAY_URL = "ws://127.0.0.1:8787"
$env:AGENT_TERMINAL_RELAY_SECRET = "local-development-secret"
$env:RELAY_SHARED_SECRET = "local-development-secret"
npm run build -w @agentterminal/relay
npm run start -w @agentterminal/relay
```

For production, deploy `apps/relay/Dockerfile` behind a TLS reverse proxy and configure the desktop with the resulting `wss://` URL:

```powershell
$env:AGENT_TERMINAL_RELAY_URL = "wss://relay.example.com"
$env:AGENT_TERMINAL_RELAY_SECRET = "use-a-long-random-secret"
npm run dev
```

Set `RELAY_SHARED_SECRET` to the same value in the relay deployment. The relay uses it only to authenticate the desktop's host registration; the desktop still authenticates every phone with its paired device credential.

The desktop must be able to make an outbound connection to the relay. The phone does not need to discover or expose the desktop's LAN address.

## Start the desktop app

From PowerShell in this repository:

```powershell
npm run bootstrap
npm run dev
```

The bootstrap helper keeps npm and Electron caches inside this repository. At runtime, an installed desktop build stores its user data in Electron's normal per-user application data directory.

To create a Windows installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

The installer is written to `apps/desktop/release`.

## Run and build Android

For browser-based mobile UI development:

```powershell
npm run dev:mobile
```

To sync the production web bundle into the checked-in Android project:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-android.ps1
npm run android:open
```

Then build/run from Android Studio. The QR scanner requires a physical device or an emulator with camera support.

## Pairing and use

1. Start Agent Terminal on Windows.
2. Select the phone button in the title bar.
3. Open the mobile app and scan the QR code once.
4. The phone saves only that host connection. Future launches authenticate automatically from any network until the desktop revokes the phone.
5. Open a project to see its live sessions, or create a terminal. A project without a current desktop window opens in a new window; another session in that project appears as a new tab.

See [Architecture](docs/ARCHITECTURE.md) and [Security](docs/SECURITY.md) for implementation details and production-hardening guidance.

## Verification commands

```powershell
npm run typecheck
npm run test
npm run build
```

## Current product boundary

The terminal path is real ConPTY + xterm.js and supports normal interactive shell programs, ANSI/VT output, resizing, and scrollback. Some Windows Terminal-specific features such as pane splitting, profile JSON import, GPU text rendering, and command palette parity are not yet implemented.
