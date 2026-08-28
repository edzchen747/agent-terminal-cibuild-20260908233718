# Security model

Agent Terminal exposes command execution, so the desktop is deliberately authoritative and pairing is explicit.

## Current controls

- Single-use, 192-bit QR authorization grants expire after five minutes; they authorize a device binding rather than ordinary reconnects.
- Successful pairing rotates into a separate 256-bit device credential.
- The desktop stores only SHA-256 credential hashes.
- Credential comparisons use a timing-safe comparison.
- A production relay can require a shared host-registration secret (`RELAY_SHARED_SECRET` / `AGENT_TERMINAL_RELAY_SECRET`) so an offline host ID cannot be impersonated by another desktop.
- Headscale node expiry is disabled for age-based expiry; the public deployment bundle expires only nodes whose last activity is older than 30 days through its least-privilege reaper API key.
- An optional Headscale preauth key may be carried in the LAN-only QR for first node enrollment. Use a short-lived key and rotate it; never put a never-expiring reusable key in a QR.
- Every command requires an authenticated socket.
- Device revocation closes currently connected sockets immediately.
- Remote project paths must resolve to existing desktop directories.
- Terminal dimensions and WebSocket payload sizes are bounded.
- Tauri webviews have no Node runtime and use an allowlisted command/event capability surface.

## Transport and relay boundary

For cross-network use, deploy `server/relay`. Headscale coordinates the embedded nodes and its DERP/STUN service attempts a direct NAT-traversed path before encrypted relay fallback. The Agent Terminal relay remains a protocol-level fallback; it only forwards payloads, while project state, terminal state, and device authorization remain on the desktop. The desktop still verifies the saved device credential after any transport routes the connection. Configure the relay registration secret in production.

The direct `ws://` transport on port `47831` is the LAN pairing path and a trusted-network fallback only. Do not expose it to the public internet. The first QR exchange must occur on a trusted local network; remote reconnects use the saved credential and overlay/relay path.

Before an internet-facing release, add relay admission/rate controls, relay abuse protection, device-credential rotation, and an external security review. TLS termination must be configured for the relay, and the relay must avoid logging terminal payloads or credentials. A VPN remains a valid alternative for deployments that do not want a public relay.

## Desktop data

The portable app stores project metadata, device records, settings, and the embedded node identity in Tauri's per-user application data directory, migrating the previous Electron JSON record when present. Terminal output is retained only in memory and is discarded when the tray process exits. The mobile app stores its host connection and embedded node state through Capacitor Preferences and no project/session state. Native node state is kept in the app-private files directory.
