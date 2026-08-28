# Agent Terminal Headscale deployment

This directory is the public deployment bundle for `node.hopto.org`. It runs
Headscale and its embedded DERP server behind one HTTPS hostname:

- Headscale is the control plane for the embedded desktop/mobile nodes. Its
  embedded DERP server provides encrypted relay fallback and UDP/3478 STUN for
  NAT discovery; direct node-to-node paths are selected by the node engine
  when ICE/NAT probing succeeds.
- The provisioning service exposes only activation and single-use enrollment.
  It holds the Headscale API key inside the server network and fixes the user,
  tags, five-minute key expiry, reusability, and ephemeral policy.

The QR flow is intentionally LAN-only. The desktop publishes its local
WebSocket endpoint in the QR payload, and the phone must reach that endpoint
to exchange the one-time pairing grant. The QR never carries a Headscale key.
After authorization, the desktop obtains a short-lived provisioner activation
and returns one dedicated mobile enrollment key over that same LAN socket.
The phone stores its host credential and node identity, not the enrollment
key, and does not need another QR scan.

## Configure and start

1. Point an A/AAAA record for `node.hopto.org` (or your chosen
   `NODE_DOMAIN`) at the server. Open TCP 80 and 443 and UDP 3478 in the
   firewall.
2. Copy `.env.example` to `.env`, set the public address, and start Headscale
   alone for initial administration:

   ```sh
   cp .env.example .env
   docker compose up -d headscale-config headscale
   ```

3. Create the fixed Headscale user and two dedicated server API keys. Record
   the numeric user ID and each API key when printed; Headscale cannot show an
   API key again.

   ```sh
   docker compose exec headscale headscale users create agent-terminal
   docker compose exec headscale headscale users list
   docker compose exec headscale headscale apikeys create
   docker compose exec headscale headscale apikeys create
   ```

   Put the first key in `HEADSCALE_PROVISION_API_KEY`, the second in
   `HEADSCALE_REAPER_API_KEY`, and the numeric ID in `HEADSCALE_USER_ID`.
   These values stay in `.env` on the server.

4. Generate a different provisioning client token for each desktop install.
   Store only its SHA-256 hash in `PROVISIONING_CLIENT_TOKEN_HASHES` (comma
   separated when several installs are allowed), and put the raw token in
   that desktop's `AGENT_TERMINAL_PROVISIONING_TOKEN` environment variable.
   This credential can only call the fixed-policy facade; it is not a
   Headscale API key.

   ```sh
   TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
   printf %s "$TOKEN" | sha256sum
   printf 'Desktop token (store on that desktop only): %s\n' "$TOKEN"
   ```

5. Fill the remaining `.env` values and start the complete stack:

   ```sh
   docker compose up -d --build
   ```

   Caddy obtains the TLS certificate automatically once DNS and ports 80/443
   are correct. Check `https://node.hopto.org/health` and
   `https://node.hopto.org/version`. `/api/v1/*` is deliberately blocked at
   Caddy; administer Headscale with `docker compose exec headscale ...`.

For a desktop's own first enrollment, create a separate, single-use key and
provide it only as `AGENT_TERMINAL_NODE_AUTH_KEY` on that desktop. It is never
serialized into QR or pairing data:

```sh
docker compose exec headscale headscale preauthkeys create --user agent-terminal
```

Mobile enrollment always goes through the provisioner. Its sequence is:

1. trusted LAN device binding;
2. authenticated `POST /api/provision/v1/activate` with the fresh nonce and
   fixed host/device binding;
3. one redemption at `POST /api/provision/v1/enroll` within 60 seconds;
4. one non-reusable Headscale pre-auth key with an explicit five-minute
   expiry, returned only to that authorized desktop socket.

## Node lifetime policy

`headscale/config.yaml.template` sets `node.expiry: 0`, so keys do not expire
because of age. The `node-reaper` job applies the only automatic expiry rule:
nodes whose `lastSeen` is older than `NODE_INACTIVITY_DAYS` (30 by default)
are expired through the internal Headscale API. Generate a dedicated Headscale API key
for that job and set `HEADSCALE_REAPER_API_KEY` in `.env`; without it the
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
AGENT_TERMINAL_PROVISIONING_URL=https://your-domain.example/api/provision
AGENT_TERMINAL_PROVISIONING_TOKEN=<unique-per-installation-token>
```

Release packages must contain the signed process-isolated `embedded-node`
runtime. Desktop looks for it in its bundled `embedded-node` resource folder;
Android looks for an executable named `embedded-node` in the app's private
files directory. Both clients persist the node private key and network state
locally. Do not commit those values or put a shared private key in this
directory.

## Operations

```sh
docker compose logs -f headscale provisioner caddy node-reaper
docker compose exec headscale headscale nodes list
docker compose exec headscale headscale configtest
```

Back up the `headscale-data` volume. It contains the SQLite database and the
Noise/DERP keys that identify this control plane.
