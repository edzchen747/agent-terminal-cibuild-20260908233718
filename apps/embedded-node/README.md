# Embedded node runtime

This is the process-isolated overlay runtime used by the desktop and Android
launchers. It uses `tailscale.com/tsnet`, so every Agent Terminal instance
gets a private userspace node and its own persistent state directory. It does
not install `tailscaled`, create a system VPN, or require a user-installed
Tailscale client.

Build signed binaries for each release target and place them at:

- Desktop: `apps/desktop/src-tauri/resources/embedded-node/embedded-node.exe`
- Android: app-private files directory as `embedded-node` (the release build
  includes the ABI asset; the Capacitor bridge copies it into app-private
  storage before invoking it)

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
go build -trimpath -ldflags='-s -w' -o embedded-node ./
```

The auth key is supplied only at enrollment time through
`AGENT_TERMINAL_NODE_AUTH_KEY`; the long-lived node identity remains in the
state directory and must be preserved across app restarts.
