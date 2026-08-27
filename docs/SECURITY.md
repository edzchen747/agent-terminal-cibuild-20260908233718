# Security model

Agent Terminal exposes command execution, so the desktop is deliberately authoritative and pairing is explicit.

## Current controls

- One-time, 192-bit QR pairing secrets expire after five minutes.
- Successful pairing rotates into a separate 256-bit device credential.
- The desktop stores only SHA-256 credential hashes.
- Credential comparisons use a timing-safe comparison.
- Every command requires an authenticated socket.
- Device revocation closes currently connected sockets immediately.
- Remote project paths must resolve to existing desktop directories.
- Terminal dimensions and WebSocket payload sizes are bounded.
- Electron renderers use context isolation, no Node integration, and a narrow preload API.

## Local-network transport limitation

Version 0.1 uses plain `ws://` on the local network so Android can connect to a desktop without certificate provisioning. Authorization prevents an unpaired client from using the terminal, but traffic and credentials are not encrypted against an attacker who can observe the local network.

Do not expose port `47831` to the public internet. Use only on a trusted private network.

Before an internet-facing release, replace the transport with authenticated encryption (for example, TLS with pinned host identity or a Noise-style application handshake), add origin/rate controls, and complete an external security review. Remote access across networks should be provided through a trusted VPN rather than router port forwarding.

## Desktop data

The installed app stores project metadata, device records, and settings in Electron's per-user application data directory. Terminal output is retained only in memory and is discarded when the desktop app exits. The mobile app stores one host connection record through Capacitor Preferences and no project/session state.

