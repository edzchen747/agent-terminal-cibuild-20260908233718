# Agent Terminal Headscale deployment

This bundle runs Headscale 0.29, embedded DERP/STUN, the narrow enrollment
service, Caddy, and the inactive-node reaper. Caddy exposes normal Headscale
node-control traffic and `/api/provision/*`, while blocking the administrative
`/api/v1/*` surface.

The two provisioning endpoints are public capability endpoints. Apps have no
provisioning, admin, or reusable Headscale credential. `HEADSCALE_PROVISION_API_KEY`
exists only in the provisioner container and `HEADSCALE_REAPER_API_KEY` only in
the maintenance container.

## Pairing and enrollment

1. The desktop starts its LAN WebSocket listener and issues a five-minute,
   one-use QR pairing grant containing only public connection metadata.
2. The phone redeems that grant over LAN. The desktop authorizes it and
   terminal streaming can start immediately.
3. Desktop and mobile registration proceed independently in the background.
   Each uses `POST /api/provision/v1/activate`, then atomically redeems the
   returned 45-second activation at `POST /api/provision/v1/enroll`.
4. The provisioner accepts only `desktop` or `mobile`, binds the activation to
   role, host ID, device ID, nonce, source address, and expiration, and asks
   Headscale for a non-reusable five-minute pre-auth key.
5. Each native node discards that key after enrollment and retains only its
   app-private node identity.

The provisioner derives one Headscale user from each host ID. Both devices in
that pairing group enroll as that user. `headscale/policy.hujson` is
deny-by-default and allows application TCP traffic only to `autogroup:self`,
so one public registration cannot reach unrelated pairings. Provisioning roles
remain fixed, audited server policy metadata rather than Headscale ACL tags:
Headscale 0.29 makes tags and user ownership mutually exclusive, and global
desktop/mobile tags would remove the same-user isolation boundary.

## Configure and start

1. Point an A/AAAA record for `NODE_DOMAIN` at the server. Open TCP 80/443 and
   UDP 3478.
2. Copy `.env.example` to `.env` and fill the public addresses and domains.
3. Start Headscale, create two server API keys, and put them in the named
   server-only variables:

   ```sh
   cp .env.example .env
   docker compose up -d headscale-config headscale
   docker compose exec headscale headscale apikeys create
   docker compose exec headscale headscale apikeys create
   ```

4. Start and validate the complete stack:

   ```sh
   docker compose up -d --build
   docker compose exec headscale headscale configtest
   docker compose ps
   ```

Caddy obtains the TLS certificate after DNS and TCP 80/443 are reachable.
Check `/api/provision/health` for the facade. Administer Headscale only from the
server with `docker compose exec headscale ...`.

## Abuse controls

The application layer enforces a 4 KiB JSON body limit; strict field sets;
nonce replay retention; exact-IP, IPv4 /24, IPv6 /64, host, role, and global
quotas; bounded activation storage; bounded Headscale concurrency; short
HTTP/upstream timeouts; and secret-free audit events. Caddy independently
rejects provisioning bodies above 4 KiB.

These controls protect service capacity but cannot absorb volumetric attacks.
For an internet deployment, place TCP 80/443 behind an upstream WAF/DDoS
provider, configure its proxy-address trust correctly, rate-limit both
provisioning paths there, and restrict origin ingress to the provider's
published address ranges. Keep UDP 3478 routed directly to the server because
it is the DERP STUN listener. Do not expose the desktop's LAN port 47831 on a
public router.

## Node lifetime

`node.expiry: 0` keeps an enrolled node stable across network changes. The
`node-reaper` expires nodes whose `lastSeen` exceeds `NODE_INACTIVITY_DAYS`.
It uses its own API key so provisioning and maintenance credentials can be
rotated independently.

## Client configuration

Stock clients use `https://node.hopto.org`. Self-hosted builds can override
only public routing values; no app secret is needed:

```text
AGENT_TERMINAL_CONTROL_URL=https://your-domain.example
AGENT_TERMINAL_REMOTE_ENDPOINT=ws://desktop-host-id.agent-terminal.internal:47831
AGENT_TERMINAL_REMOTE_TRANSPORT=overlay
AGENT_TERMINAL_TAILNET_DOMAIN=agent-terminal.internal
AGENT_TERMINAL_PROVISIONING_URL=https://your-domain.example/api/provision
```

Release packages must include the process-isolated `embedded-node` runtime.
Back up the `headscale-data` volume; it contains the Headscale database and
Noise/DERP identities. Never copy `.env`, native node state, or API keys into a
desktop/mobile artifact.

## Operations

```sh
docker compose logs -f headscale provisioner caddy node-reaper
docker compose exec headscale headscale nodes list
docker compose exec headscale headscale configtest
```
