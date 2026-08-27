# Agent Terminal

Agent Terminal is a Windows terminal host with an Android-first companion app. It runs real interactive shells through Windows ConPTY, renders them with xterm.js, and lets an authorized phone create projects, open terminal sessions, and interact with those sessions over the local network.

This repository is an end-to-end MVP, not a UI-only prototype.

## What is implemented

### Windows desktop

- Interactive ConPTY terminal sessions with Command Prompt, Windows PowerShell, PowerShell 7, WSL, and Git Bash detection.
- A collapsible project sidebar. Opening a different project creates/focuses a dedicated desktop window.
- Multiple terminal tabs per project.
- Native folder picker for saved projects.
- QR pairing codes that expire after five minutes and can only be used once.
- Persistent authorized-device registry with token hashing, last-seen timestamps, and immediate revocation.
- Local WebSocket host on port `47831`.
- Desktop-owned persistence for projects, devices, and the default shell.

### Android-first mobile app

- Native QR scanning with a manual pairing-code fallback.
- Automatic reconnect to the one saved desktop host.
- Live project/session discovery whenever the app connects.
- Saved-project marker and automatic temporary projects for open desktop folders that were not saved.
- Project creation against an existing absolute folder path on the desktop.
- Session creation and full terminal input/output.
- Latchable Ctrl, Alt, and Shift modifiers plus Esc, Tab, arrows, word navigation, Backspace, and Enter.
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
- Phone and desktop on the same local network for the current transport.

No Visual Studio C++ workload is required: the desktop uses a prebuilt ConPTY binding.

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
3. Open the mobile app and scan the QR code.
4. The phone saves only that host connection. Future launches authenticate automatically until the desktop revokes the phone.
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

