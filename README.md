# Agent Terminal

Agent Terminal is a portable Tauri 2 Windows terminal host with an Android-first companion app. Its Rust tray process runs real interactive shells through Windows ConPTY, renders them with xterm.js, and lets an authorized phone create projects, open terminal sessions, and interact with those sessions remotely.

This repository is an end-to-end MVP, not a UI-only prototype.

## What is implemented

### Windows desktop

- One portable `agent-terminal.exe`; there is no installer, Electron runtime, Node sidecar, or separate connection process.
- A single native tray host owns every PTY and direct/overlay connection. Terminal windows are disposable clients that attach to tray-owned sessions and may all be closed without interrupting the host.
- Left-clicking the tray icon restores the terminal. Right-clicking opens a menu with Exit.
- Interactive ConPTY terminal sessions with Command Prompt, Windows PowerShell, PowerShell 7, WSL, and Git Bash detection.
- A collapsible project sidebar. Opening a different project creates/focuses a dedicated desktop window.
- Multiple terminal tabs per project.
- Automatic session regrouping when shell integration reports a changed working directory: the active window follows the moved tab, while remaining old-project tabs reopen together in a background window.
- Project-scoped session attachments prevent terminal windows from mirroring or adopting one another's tabs during directory changes.
- Clean Windows working-directory paths in prompts and project state, without the internal `\\?\` filesystem prefix.
- Seamless replacement of a pristine tab when its terminal type is changed; tabs with user input remain running and the selection becomes the default for new sessions.
- Context-aware Ctrl+C: copies selected terminal text and otherwise sends the normal interrupt signal to the shell.
- Native folder picker for saved projects.
- QR pairing that authorizes a phone once; ordinary reconnects use the saved device credential.
- Persistent authorized-device registry with token hashing, last-seen timestamps, and immediate revocation.
- Outbound Headscale/DERP node support for connections across Wi-Fi, mobile data, NAT, and firewall boundaries.
- Direct local WebSocket fallback on port `47831` for development without the overlay node.
- Desktop-owned persistence for projects, devices, and the default shell.
- Save or unsave the active project without closing its window or terminal sessions.

### Android-first mobile app

- Native QR scanning with a manual pairing-code fallback.
- Automatic reconnect to the one saved desktop host through the embedded overlay node or direct fallback.
- Live project/session discovery whenever the app connects.
- Saved-project marker and automatic temporary projects for open desktop folders that were not saved.
- Project creation against an existing absolute folder path on the desktop.
- Save temporary projects or make saved projects temporary from the project screen.
- Session creation and full terminal input/output.
- Animated three-second key chords for Ctrl, Alt, Shift, Esc, Tab, arrows, word navigation, Backspace, and Enter; armed modifiers apply immediately to mobile keyboard input.
- Capacitor Android project checked into `apps/mobile/android` with minimum SDK 26.
- A web-first codebase that can add the Capacitor iOS target without rewriting the UI or protocol.

The mobile app persists its host identity, LAN/remote endpoints, device credential, and embedded-node private key/network state. Project data and authorization records remain on the desktop.

## Repository layout

```text
apps/
    desktop/       Tauri/Rust tray host, ConPTY manager, connection server, React desktop UI
    mobile/        React mobile UI and Capacitor Android project
    embedded-node/ Go tsnet userspace node used by the desktop/Android process bridge
packages/
  protocol/      Shared typed wire protocol and data model
scripts/         Workspace-local bootstrap and packaging helpers
docs/            Architecture and security notes
```

## Requirements

- Windows 10 1809 or newer (Windows 11 recommended).
- Node.js 22 or newer.
- Rust stable and the Microsoft C++ desktop build tools for local desktop compilation.
- Microsoft Edge WebView2 at runtime. Supported Windows 10/11 systems normally include it.
- Android Studio with Java 21 and Android SDK 36 to build the Android APK.
- Go 1.24 or newer when packaging the process-isolated embedded node runtime.
- A deployed Headscale + embedded DERP/STUN stack for cross-network use. The stock build points at `https://node.hopto.org`.

No Visual Studio C++ workload is required: the desktop uses a prebuilt ConPTY binding.

## Run the Headscale stack

The public deployment bundle is in [`server/relay`](server/relay/README.md). It includes Headscale's embedded DERP/STUN server, the narrow enrollment service, Caddy TLS termination, and the 30-day inactive-node reaper. It is configured entirely through `.env`.

For production, copy `server/relay/.env.example` to `.env`, set DNS/ports/secrets, and run `docker compose up -d --build` from that directory. Self-hosted client values are supplied through:

```powershell
$env:AGENT_TERMINAL_CONTROL_URL = "https://headscale.example.com"
$env:AGENT_TERMINAL_REMOTE_ENDPOINT = "ws://desktop-host-id.agent-terminal.internal:47831"
$env:AGENT_TERMINAL_REMOTE_TRANSPORT = "overlay"
$env:AGENT_TERMINAL_TAILNET_DOMAIN = "agent-terminal.internal"
npm run dev
```

QR pairing is LAN-only: the QR contains the desktop's local WebSocket endpoint and a five-minute device-binding grant, never a Headscale key. Pairing commits as soon as the desktop consumes that grant and authorizes the phone, so terminals begin streaming even if remote registration is unavailable. The desktop then requests separate role-bound, single-use pre-auth keys for itself and the mobile in the background. Those keys exist only in process memory until the native nodes accept them; the apps persist only their node identities. A failed registration leaves LAN access running and shows a retryable warning. Later, the phone probes LAN for 1.5 seconds before using its persistent embedded-node identity over Headscale/DERP. Neither endpoint needs an inbound port-forwarding rule.

## Start the desktop app

From PowerShell in this repository:

```powershell
npm run bootstrap
npm run dev
```

The bootstrap helper keeps npm and Cargo caches inside this repository. At runtime, the portable desktop executable stores its desktop-owned state in Tauri's normal per-user application data directory. Closing all terminal windows leaves the tray host and active connections running.

For isolated development or automated tests, set `AGENT_TERMINAL_DATA_DIR` to keep the desktop state in a specific directory.

To create the portable Windows executable:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

The self-contained application executable is written to `apps/desktop/src-tauri/target/release/agent-terminal.exe`. It embeds the desktop web assets and Rust backend. Release packaging also places the signed process-isolated `embedded-node` executable in the Tauri resource directory; development builds require the embedded node for off-LAN connections. It relies on the system WebView2 runtime rather than bundling a second browser engine.

## Run and build Android

For browser-based mobile UI development:

```powershell
npm run dev:mobile
```

To sync the production web bundle into the checked-in Android project:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-embedded-node-android.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-android.ps1
npm run android:open
```

Then build/run from Android Studio. The QR scanner requires a physical device or an emulator with camera support.

For a command-line APK build, use `scripts/build-android.ps1`. It auto-detects a usable JDK (Java 21 preferred) and the Android SDK, writes the ignored `local.properties`, rebuilds `libembedded-node.so` when Go is installed (otherwise reuses the existing `jniLibs` binary), syncs the web bundle, and runs Gradle:

```powershell
# Unsigned, sideloadable debug APK
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Debug

# Signed release APK (keystore secrets via $env: or the User registry scope)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1
```

The APK lands in `apps/mobile/android/app/build/outputs/apk/{debug,release}/`. The script accepts `-JavaHome` and `-KeyStoreName` overrides.

### Android release signing

Android updates must use the same signing identity as the installed APK. Create the local, ignored keystore and Gradle properties once:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-android-signing.ps1
```

The generated files under `apps/mobile/android/keystore/` and `apps/mobile/android/keystore.properties` are ignored and must be backed up securely. A local release build uses them automatically:

```powershell
Push-Location apps/mobile/android
./gradlew assembleRelease
Pop-Location
```

The GitHub Actions workflow cannot access a workstation-local file, so configure these repository secrets with the same signing identity before pushing a release: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Encode the local keystore for the first secret with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('apps/mobile/android/keystore/agent-terminal-release.jks'))
```

Pushes to `main` and manual workflow runs then restore the keystore and upload a signed release APK. Pull requests intentionally build only a debug APK so untrusted code cannot access the signing key.

## Pairing and use

1. Start Agent Terminal on Windows.
2. Select the phone button in the title bar.
3. Put the phone on the same LAN, open the mobile app, and scan the QR code once.
4. The phone saves the host connection and embedded-node identity. Future launches authenticate automatically from any network until the desktop revokes the phone.
5. Open a project to see its live sessions, or create a terminal. A project without a current desktop window opens in a new window; another session in that project appears as a new tab.
6. Close terminal windows to leave the host running in the tray. Use the tray's Exit menu item for a full shutdown.

See [Architecture](docs/ARCHITECTURE.md) and [Security](docs/SECURITY.md) for implementation details and production-hardening guidance.

## Verification commands

```powershell
npm run typecheck
npm run test
npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Current product boundary

The terminal path is real ConPTY + xterm.js and supports normal interactive shell programs, ANSI/VT output, resizing, and scrollback. Some Windows Terminal-specific features such as pane splitting, profile JSON import, GPU text rendering, and command palette parity are not yet implemented.
