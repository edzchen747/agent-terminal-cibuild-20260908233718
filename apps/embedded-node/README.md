# Embedded node runtime

This is the process-isolated overlay runtime used by the desktop and Android
launchers. It uses `tailscale.com/tsnet`, so every Agent Terminal instance
gets a private userspace node and its own persistent state directory. It does
not install `tailscaled`, create a system VPN, or require a user-installed
Tailscale client.

On Android, it uses `github.com/wlynxg/anet` for network-interface discovery.
Android 11 and newer restrict the netlink calls used by Go's standard
`net.Interfaces`; the Android build therefore requires the
`-checklinkname=0` linker flag.

Build signed binaries for each release target and place them at:

- Desktop: `apps/desktop/src-tauri/resources/embedded-node/embedded-node.exe`
- Android: packaged native library `libembedded-node.so` (Android extracts it
  into the app's executable native-library directory before invoking it)

The desktop launcher uses the `--state-dir`, `--control-url`, `--node-id`, and
`--target-port` flags. The Android bridge adds `--remote-address` and
`--proxy-listen` and reads `status.json` to discover its localhost proxy.

The desktop host name is the stable host ID, so the default mobile target is
`<host-id>.<tailnet-domain>:47831`. If `TAILNET_BASE_DOMAIN` is changed in the
Headscale deployment, set the matching `AGENT_TERMINAL_TAILNET_DOMAIN` client
value before pairing.

Build example:

```sh
go mod tidy
go build -trimpath -ldflags='-s -w -H=windowsgui' -o embedded-node.exe ./
```

An auth key is supplied only to the native process at enrollment time through
`AGENT_TERMINAL_NODE_AUTH_KEY`; the long-lived node identity remains in the
state directory and must be preserved across app restarts. For mobile this is
a separately provisioned, single-use key received after trusted LAN pairing,
not a value from the QR or saved host record. Desktop enrollment uses a
separate role-bound key obtained after pairing. The native process clears the
environment and in-memory server field once registration reaches `Running`,
and suppresses verbose tsnet logging so the capability is never written to
disk.
