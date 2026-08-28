# Embedded node runtime

Release packaging places the signed platform-specific `embedded-node` engine
in this directory. The Tauri process starts it with `--state-dir`,
`--control-url`, `--node-id`, and `--target-port`; the long-lived private key
is supplied through `AGENT_TERMINAL_NODE_PRIVATE_KEY`.

The development build intentionally leaves this executable out and uses the
configured relay fallback. Do not commit private keys or a development node
binary to this directory.
