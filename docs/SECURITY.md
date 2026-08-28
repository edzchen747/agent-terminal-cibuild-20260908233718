# Security model

Agent Terminal exposes command execution, so the desktop is deliberately authoritative and pairing is explicit.

## Current controls

- Single-use, 192-bit QR authorization grants expire after five minutes; they authorize a device binding rather than ordinary reconnects.
- Successful pairing rotates into a separate 256-bit device credential.
- The desktop stores only SHA-256 credential hashes.
- Credential comparisons use a timing-safe comparison.
- Headscale node expiry is disabled for age-based expiry; the public deployment bundle expires only nodes whose last activity is older than 30 days through a dedicated, server-only reaper API key.
- Pairing QR/manual data never contains a Headscale key. A separate post-pairing exchange issues one non-reusable mobile pre-auth key with an explicit short expiry.
- The enrollment service requires a hashed, per-installation client credential to mint a short-lived activation, consumes both the pairing nonce and activation once, fixes the Headscale user/tag/expiry, rate-limits by credential and source, rejects extra policy fields, and never logs returned keys.
- `HEADSCALE_PROVISION_API_KEY` and `HEADSCALE_REAPER_API_KEY` remain inside the server environment. Neither app receives a Headscale administrative API credential, and Caddy blocks the public administrative `/api/v1/*` surface.
- Every command requires an authenticated socket.
- Device revocation closes currently connected sockets immediately.
- Remote project paths must resolve to existing desktop directories.
- Terminal dimensions and WebSocket payload sizes are bounded.
- Tauri webviews have no Node runtime and use an allowlisted command/event capability surface.

## Transport boundary

For cross-network use, deploy `server/relay`. Headscale coordinates the embedded nodes and its DERP/STUN service attempts a direct NAT-traversed path before encrypted fallback. The provisioning facade exposes only activation and enrollment—not a generic Headscale proxy. Project state, terminal state, and device authorization remain on the desktop, which verifies the saved device credential after the overlay connection is established.

The direct `ws://` transport on port `47831` is the LAN pairing path and a trusted-network fast path only. Do not expose it to the public internet. The first QR exchange must occur on a trusted local network; remote reconnects use the saved credential and overlay path.

Before an internet-facing release, add device-credential rotation and an external security review. TLS termination must be configured for Headscale/DERP. A VPN remains a valid alternative for deployments that do not want a public Headscale endpoint.

## Desktop data

The portable app stores project metadata, device records, settings, and the embedded node identity in Tauri's per-user application data directory, migrating the previous Electron JSON record when present. Terminal output is retained only in memory and is discarded when the tray process exits. The mobile app stores its host connection and embedded node state through Capacitor Preferences and no project/session state. Builds that previously persisted `nodeAuthKey` delete it while loading the saved host. Native node state is kept in the app-private files directory.
