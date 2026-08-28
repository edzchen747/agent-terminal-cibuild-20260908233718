# Embedded node runtime

Release packaging places the signed platform-specific `embedded-node` engine
in this directory. The Tauri process starts it with `--state-dir`,
`--control-url`, `--node-id`, and `--target-port`; the long-lived private key
is supplied through `AGENT_TERMINAL_NODE_PRIVATE_KEY`.

The development build intentionally leaves this executable out; off-LAN
connections require a release build containing the embedded node. Do not
commit private keys or a development node binary to this directory.
