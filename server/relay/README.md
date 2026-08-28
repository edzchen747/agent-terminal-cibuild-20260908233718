# Agent Terminal Headscale deployment

This directory is the public deployment bundle for `node.hopto.org`. It runs
Headscale and its embedded DERP server behind one HTTPS hostname:

- Headscale is the control plane for the embedded desktop/mobile nodes. Its
  embedded DERP server provides encrypted relay fallback and UDP/3478 STUN for
  NAT discovery; direct node-to-node paths are selected by the node engine
  when ICE/NAT probing succeeds.

The QR flow is intentionally LAN-only. The desktop publishes its local
WebSocket endpoint in the QR payload, and the phone must reach that endpoint
to exchange the one-time pairing grant. After that, the phone stores its host
credential and node identity; it does not need another QR scan.

## Configure and start

1. Point an A/AAAA record for `node.hopto.org` (or your chosen
   `NODE_DOMAIN`) at the server. Open TCP 80 and 443 and UDP 3478 in the
   firewall.
2. Copy `.env.example` to `.env` and set the public address and a private
   `HEADSCALE_API_KEY` after the first start. No source
   file needs editing.
3. Start the stack:

   ```sh
   cp .env.example .env
   docker compose up -d --build
   ```

   Caddy obtains the TLS certificate automatically once DNS and ports 80/443
   are correct. Check `https://node.hopto.org/health` and
   `https://node.hopto.org/version`.

4. Create the Headscale user and node enrollment key used by the release
   packaging/enrollment flow:

   ```sh
   docker compose exec headscale headscale users create agent-terminal
   docker compose exec headscale headscale preauthkeys create \
      --user agent-terminal --reusable --expiration 24h
   ```

   Keep the returned key private. It is an enrollment credential, not the
   long-lived private node key. A production enrollment service should mint a
   short-lived per-device key after LAN pairing. For a controlled deployment,
   set `AGENT_TERMINAL_NODE_AUTH_KEY` on the desktop before pairing; the
   desktop includes that optional enrollment key in the LAN QR so the mobile
   node can join without a user-installed Tailscale client. Never put a
   never-expiring reusable key in a QR.

## Node lifetime policy

`headscale/config.yaml.template` sets `node.expiry: 0`, so keys do not expire
because of age. The `node-reaper` job applies the only automatic expiry rule:
nodes whose `lastSeen` is older than `NODE_INACTIVITY_DAYS` (30 by default)
are expired through the Headscale API. Generate a dedicated Headscale API key
for that job and set `HEADSCALE_API_KEY` in `.env`; without it the
job intentionally does nothing.

## Client configuration

The stock desktop and mobile builds use `https://node.hopto.org` as the
control-plane default and the Headscale name
`ws://<desktop-host-id>.agent-terminal.internal:47831` as the remote endpoint.
Self-hosted values are supplied through the native build/runtime settings:

```text
AGENT_TERMINAL_CONTROL_URL=https://your-domain.example
AGENT_TERMINAL_REMOTE_ENDPOINT=ws://desktop-host-id.agent-terminal.internal:47831
AGENT_TERMINAL_REMOTE_TRANSPORT=overlay
AGENT_TERMINAL_TAILNET_DOMAIN=agent-terminal.internal
```

Release packages must contain the signed process-isolated `embedded-node`
runtime. Desktop looks for it in its bundled `embedded-node` resource folder;
Android looks for an executable named `embedded-node` in the app's private
files directory. Both clients persist the node private key and network state
locally. Do not commit those values or put a shared private key in this
directory.

## Operations

```sh
docker compose logs -f headscale caddy node-reaper
docker compose exec headscale headscale nodes list
docker compose exec headscale headscale configtest
```

Back up the `headscale-data` volume. It contains the SQLite database and the
Noise/DERP keys that identify this control plane.
