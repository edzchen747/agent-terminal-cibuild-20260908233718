# Updated acceptance criteria

## Desktop runtime and distribution

- The Windows desktop runtime uses Tauri 2 with a Rust authority process; Electron, Electron Builder, Node PTY, and a Node desktop WebSocket process are not shipped.
- The desktop web UI, Rust backend, ConPTY integration, connection host, and tray behavior compile into one portable `agent-terminal.exe` with no installation step or sidecar process.
- The portable executable uses the WebView2 runtime provided by supported Windows 10 and Windows 11 systems.
- The Tauri process creates a system-tray icon and remains the sole owner of terminal sessions, pairing, direct WebSockets, relay connections, authorization, and desktop state independently of terminal-window lifetimes.
- Only one desktop host process may run at a time. Launching the executable again focuses the existing terminal window so every QR grant is issued by the process that owns the connection port.
- Every terminal window is a disposable client of the tray host. It explicitly attaches to visible sessions, receives an atomic scrollback-plus-live-output stream, and sends all terminal input and resize operations back to the tray authority.
- Left-clicking the tray icon opens or restores the terminal application.
- Right-clicking the tray icon opens a native menu containing an Exit action.
- Closing a terminal window destroys only that window client without stopping PTYs, the tray host, or active mobile connections. Exit from the tray is the explicit full-process shutdown path.
- The tray host is the extension point for additional connection methods added later.

## Pairing

- QR scanning is a one-time device-binding process for each phone.
- The user should not need to scan the QR code again for ordinary reconnects.
- The phone stores only the desktop host endpoint, host ID, phone device ID, and its device credential.
- The desktop stores the authorized device record and can revoke it.
- Revoking a device invalidates its saved credential and disconnects it.
- A new QR scan is required only when adding a new phone or after revocation.

## Network reachability

- After pairing, a phone can reconnect when the desktop and phone are on different Wi-Fi networks, mobile data, or behind separate NAT/firewall boundaries.
- Neither endpoint requires an inbound port-forwarding rule.
- The desktop and phone each make outbound WebSocket connections to a relay.
- The relay routes an authenticated phone connection to the paired desktop host ID and does not own project or terminal state.
- The relay must use wss:// in a production deployment.
- Direct LAN WebSocket remains available only as a local-development fallback when no relay URL is configured.
- The desktop QR modal and mobile onboarding must describe pairing as a one-time device binding, not a one-time reconnect code.
- Pairing UI must not label the QR as a one-time code or present its setup-grant expiry as the lifetime of the device pairing.
- The confirmation language must state that the phone remains authorized until explicitly revoked.
- The desktop QR modal closes as soon as the tray authority accepts the pairing and persists the authorized device.

## Session behavior

- Projects and authorized devices remain desktop-owned and persistent.
- Live sessions are discovered after every successful reconnect.
- New projects open desktop windows; additional sessions in one project open desktop tabs.
- Temporary projects are derived from live sessions and are not persisted.
- Desktop and mobile can save a temporary project or return a saved project to temporary status without interrupting its sessions.
- Terminal bytes travel over the live paired connection with resize and scrollback support.
- Desktop clicks and mobile taps force a PTY resize notification even when the cell dimensions are unchanged.
- Desktop and mobile text input force a PTY resize before the input bytes are delivered, so interactive TUIs promptly receive the current dimensions.
- Shell working-directory reports move sessions to the longest matching saved project, or to a temporary project for an unknown folder.
- When an active session changes to another project, its current window switches to the new project and removes the old project's tabs. Any remaining old-project tabs move into a replacement window opened behind the current window.
- A desktop window may attach only to sessions owned by its tray-assigned project; reassignment clears prior subscriptions so windows cannot mirror or switch between one another's tabs.
- Closing every terminal window retains the most recently focused project in tray memory. Reopening from the tray restores that project and reattaches its live session IDs and scrollback.
- User-facing and persisted Windows paths omit the verbatim `\\?\` prefix, including PowerShell prompts and saved project working directories.
- Changing the terminal type replaces the active session in place when it is still pristine; after the user has entered input, the selection changes only the default for future sessions.
- Mobile accessibility keys form animated three-second chords; mobile keyboard input consumes armed modifiers immediately.
- Desktop Ctrl+C copies when terminal text is selected; with no selection it must continue to send the shell interrupt signal.
- A successful selection copy displays a brief toast positioned above the selected terminal text.
