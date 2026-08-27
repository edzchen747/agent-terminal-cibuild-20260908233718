# Security model

Agent Terminal exposes command execution, so the desktop is deliberately authoritative and pairing is explicit.

## Current controls

- Single-use, 192-bit QR authorization grants expire after five minutes; they authorize a device binding rather than ordinary reconnects.
- Successful pairing rotates into a separate 256-bit device credential.
- The desktop stores only SHA-256 credential hashes.
- Credential comparisons use a timing-safe comparison.
- A production relay can require a shared host-registration secret (`RELAY_SHARED_SECRET` / `AGENT_TERMINAL_RELAY_SECRET`) so an offline host ID cannot be impersonated by another desktop.
- Every command requires an authenticated socket.
- Device revocation closes currently connected sockets immediately.
- Remote project paths must resolve to existing desktop directories.
- Terminal dimensions and WebSocket payload sizes are bounded.
- Tauri webviews have no Node runtime and use an allowlisted command/event capability surface.

## Transport and relay boundary

For cross-network use, configure a production `wss://` relay. The desktop and phone make outbound connections, and the relay only forwards protocol payloads; project state, terminal state, and device authorization remain on the desktop. The desktop still verifies the saved device credential after the relay routes the connection. Configure the relay registration secret in production; an unset secret is intended only for local development.

The direct `ws://` transport on port `47831` is a development fallback only. Do not expose it to the public internet. It is suitable only for a trusted private network while testing without a relay.

Before an internet-facing release, add relay admission/rate controls, relay abuse protection, device-credential rotation, and an external security review. TLS termination must be configured for the relay, and the relay must avoid logging terminal payloads or credentials. A VPN remains a valid alternative for deployments that do not want a public relay.

## Desktop data

The portable app stores project metadata, device records, and settings in Tauri's per-user application data directory, migrating the previous Electron JSON record when present. Terminal output is retained only in memory and is discarded when the tray process exits. The mobile app stores one host connection record through Capacitor Preferences and no project/session state.
