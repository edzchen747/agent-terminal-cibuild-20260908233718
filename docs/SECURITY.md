# Security model

Agent Terminal exposes command execution, so the desktop is deliberately authoritative and pairing is explicit.

## Current controls

- Single-use, 192-bit QR authorization grants expire after five minutes; they authorize a device binding rather than ordinary reconnects.
- Successful pairing rotates into a separate 256-bit device credential.
- The desktop stores only SHA-256 credential hashes.
- Credential comparisons use a timing-safe comparison.
- Headscale node expiry is disabled for age-based expiry; the public deployment bundle expires only nodes whose last activity is older than 30 days through a dedicated, server-only reaper API key.
- Pairing QR/manual data never contains a Headscale key. Separate post-pairing exchanges issue non-reusable desktop and mobile pre-auth keys with explicit short expiries.
- Public activation capabilities are bound to role, host, device, nonce, source address, and a short expiration. Redemption consumes them atomically before Headscale access. The service rejects extra policy fields and rate-limits exact IPs, IPv4 /24 or IPv6 /64 prefixes, host IDs, roles, and global traffic; it also caps bodies, active activations, concurrent upstream work, and request timeouts.
- Every paired host gets a deterministic Headscale user. The checked-in deny-by-default policy permits Agent Terminal TCP traffic only between nodes owned by that same user. Provisioning roles are fixed server metadata rather than Headscale ACL tags because Headscale 0.29 makes tags and user ownership mutually exclusive; global role tags would defeat pair isolation.
- `HEADSCALE_PROVISION_API_KEY` and `HEADSCALE_REAPER_API_KEY` remain inside the server environment. Neither app receives a Headscale administrative API credential, and Caddy blocks the public administrative `/api/v1/*` surface.
- Every command requires an authenticated socket.
- Device revocation closes currently connected sockets immediately.
- Remote project paths must resolve to existing desktop directories.
- Terminal dimensions and WebSocket payload sizes are bounded.
- Tauri webviews have no Node runtime and use an allowlisted command/event capability surface.

## Transport boundary

For cross-network use, deploy `server/relay`. Headscale coordinates the embedded nodes and its DERP/STUN service attempts a direct NAT-traversed path before encrypted fallback. The provisioning facade exposes only activation and enrollment—not a generic Headscale proxy. These public capability endpoints intentionally have no reusable desktop secret; their abuse controls do not replace an upstream WAF and volumetric DDoS service. Project state, terminal state, and device authorization remain on the desktop, which verifies the saved device credential after the overlay connection is established.

The direct `ws://` transport on port `47831` is the LAN pairing path and a trusted-network fast path only. Do not expose it to the public internet. The first QR exchange must occur on a trusted local network; remote reconnects use the saved credential and overlay path.

Before an internet-facing release, add device-credential rotation and an external security review. TLS termination must be configured for Headscale/DERP. A VPN remains a valid alternative for deployments that do not want a public Headscale endpoint.

## Desktop data

The portable app stores project metadata, device records, settings, and the embedded node identity in Tauri's per-user application data directory, migrating the previous Electron JSON record when present. Terminal output is retained only in memory and is discarded when the tray process exits. The mobile app stores its host connection and embedded node state through Capacitor Preferences and no project/session state. Builds that previously persisted `nodeAuthKey` delete it while loading the saved host. Native node state is kept in the app-private files directory.
