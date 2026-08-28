import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const JSON_LIMIT_BYTES = 4_096;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function loadConfig(env = process.env) {
  const tokenHashes = (env.PROVISIONING_CLIENT_TOKEN_HASHES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (tokenHashes.length === 0 || tokenHashes.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("PROVISIONING_CLIENT_TOKEN_HASHES must contain one or more comma-separated SHA-256 hashes");
  }

  const headscaleApiKey = required(env, "HEADSCALE_PROVISION_API_KEY");
  const headscaleUserId = required(env, "HEADSCALE_USER_ID");
  if (!/^\d+$/.test(headscaleUserId)) throw new Error("HEADSCALE_USER_ID must be a numeric Headscale user ID");

  const keyTtlSeconds = boundedInteger(env.PROVISIONING_KEY_TTL_SECONDS, 300, 60, 3_600, "PROVISIONING_KEY_TTL_SECONDS");
  const activationTtlSeconds = boundedInteger(env.PROVISIONING_ACTIVATION_TTL_SECONDS, 60, 15, 300, "PROVISIONING_ACTIVATION_TTL_SECONDS");
  return {
    port: boundedInteger(env.PORT, 8090, 1, 65_535, "PORT"),
    headscaleUrl: (env.HEADSCALE_INTERNAL_URL ?? "http://headscale:8080").replace(/\/+$/, ""),
    headscaleApiKey,
    headscaleUserId,
    aclTags: (env.HEADSCALE_ACL_TAGS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    tokenHashes,
    keyTtlSeconds,
    activationTtlSeconds,
    nonceRetentionMs: boundedInteger(env.PROVISIONING_NONCE_RETENTION_SECONDS, 3_600, keyTtlSeconds, 86_400, "PROVISIONING_NONCE_RETENTION_SECONDS") * 1_000,
    rateWindowMs: boundedInteger(env.PROVISIONING_RATE_WINDOW_SECONDS, 60, 10, 3_600, "PROVISIONING_RATE_WINDOW_SECONDS") * 1_000,
    rateLimit: boundedInteger(env.PROVISIONING_RATE_LIMIT, 10, 1, 1_000, "PROVISIONING_RATE_LIMIT")
  };
}

export function createProvisioningServer(config, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const request = dependencies.fetch ?? fetch;
  const usedNonces = new Map();
  const activations = new Map();
  const rateBuckets = new Map();

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    setSecurityHeaders(res, requestId);
    const url = new URL(req.url ?? "/", "http://provisioner.invalid");

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method !== "POST" || (url.pathname !== "/v1/activate" && url.pathname !== "/v1/enroll")) {
      return json(res, 404, { error: "not_found" });
    }
    const source = clientAddress(req);
    cleanup(usedNonces, activations, rateBuckets, now());
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return json(res, error?.code === "BODY_TOO_LARGE" ? 413 : 400, { error: "invalid_request" });
    }
    if (!validEnrollment(body)) return json(res, 400, { error: "invalid_request" });

    if (url.pathname === "/v1/activate") {
      const tokenIdentity = authenticate(req.headers.authorization, config.tokenHashes);
      if (!tokenIdentity) return json(res, 401, { error: "unauthorized" });
      if (!takeRateLimit(rateBuckets, `token:${tokenIdentity}`, config, now()) ||
          !takeRateLimit(rateBuckets, `source:${source}`, config, now())) {
        res.setHeader("Retry-After", String(Math.ceil(config.rateWindowMs / 1_000)));
        return json(res, 429, { error: "rate_limited" });
      }
      const nonceIdentity = sha256(`${tokenIdentity}:${body.nonce}`);
      if (usedNonces.has(nonceIdentity)) return json(res, 409, { error: "nonce_already_used" });
      usedNonces.set(nonceIdentity, now() + config.nonceRetentionMs);

      const activationToken = randomBytes(32).toString("base64url");
      const expiresAt = now() + config.activationTtlSeconds * 1_000;
      activations.set(sha256(activationToken), { ...body, expiresAt });
      return json(res, 201, { activationToken, expiresAt: new Date(expiresAt).toISOString() });
    }

    const activationToken = bearerToken(req.headers.authorization);
    const activationIdentity = activationToken && sha256(activationToken);
    const activation = activationIdentity && activations.get(activationIdentity);
    if (!activation || activation.expiresAt <= now()) return json(res, 401, { error: "unauthorized" });
    // Consume before validation or Headscale access. An activation can return
    // an enrollment credential at most once, even during concurrent calls.
    activations.delete(activationIdentity);
    if (activation.nonce !== body.nonce || activation.hostId !== body.hostId || activation.deviceId !== body.deviceId) {
      return json(res, 403, { error: "activation_mismatch" });
    }
    if (!takeRateLimit(rateBuckets, `source:${source}`, config, now())) {
      res.setHeader("Retry-After", String(Math.ceil(config.rateWindowMs / 1_000)));
      return json(res, 429, { error: "rate_limited" });
    }

    try {
      const expiresAt = new Date(now() + config.keyTtlSeconds * 1_000).toISOString();
      const headscaleResponse = await request(`${config.headscaleUrl}/api/v1/preauthkey`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.headscaleApiKey}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          user: config.headscaleUserId,
          reusable: false,
          ephemeral: false,
          expiration: expiresAt,
          aclTags: config.aclTags
        }),
        signal: AbortSignal.timeout(8_000)
      });
      if (!headscaleResponse.ok) throw new Error(`Headscale returned HTTP ${headscaleResponse.status}`);
      const result = await headscaleResponse.json();
      const key = result?.preAuthKey?.key;
      if (typeof key !== "string" || key.length < 20) throw new Error("Headscale returned no pre-auth key");

      // Never include the nonce, client credential, Headscale credential, or key in logs.
      console.info(JSON.stringify({ event: "enrollment_issued", requestId, hostId: body.hostId, deviceId: body.deviceId }));
      return json(res, 201, { authKey: key, expiresAt });
    } catch (error) {
      console.error(JSON.stringify({ event: "enrollment_failed", requestId, reason: safeReason(error) }));
      return json(res, 502, { error: "provisioning_unavailable" });
    }
  });
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function authenticate(header, allowedHashes) {
  const token = bearerToken(header);
  if (!token) return undefined;
  if (token.length < 32 || token.length > 512) return undefined;
  const candidate = Buffer.from(sha256(token), "hex");
  for (const hash of allowedHashes) {
    if (timingSafeEqual(candidate, Buffer.from(hash, "hex"))) return hash.slice(0, 16);
  }
  return undefined;
}

function bearerToken(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  return token.length >= 32 && token.length <= 512 ? token : undefined;
}

function validEnrollment(body) {
  return body && typeof body === "object" &&
    typeof body.nonce === "string" && NONCE_PATTERN.test(body.nonce) &&
    typeof body.hostId === "string" && ID_PATTERN.test(body.hostId) &&
    typeof body.deviceId === "string" && ID_PATTERN.test(body.deviceId) &&
    Object.keys(body).every((key) => key === "nonce" || key === "hostId" || key === "deviceId");
}

async function readJson(req) {
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new Error("JSON required");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      const error = new Error("request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function takeRateLimit(buckets, identity, config, timestamp) {
  const current = buckets.get(identity);
  if (!current || current.resetAt <= timestamp) {
    buckets.set(identity, { count: 1, resetAt: timestamp + config.rateWindowMs });
    return true;
  }
  current.count += 1;
  return current.count <= config.rateLimit;
}

function cleanup(nonces, activations, buckets, timestamp) {
  for (const [key, expiresAt] of nonces) if (expiresAt <= timestamp) nonces.delete(key);
  for (const [key, activation] of activations) if (activation.expiresAt <= timestamp) activations.delete(key);
  for (const [key, bucket] of buckets) if (bucket.resetAt <= timestamp) buckets.delete(key);
}

function clientAddress(req) {
  // Caddy replaces X-Forwarded-For, so only the right-most value is needed.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length <= 256) return forwarded.split(",").at(-1)?.trim() ?? "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

function setSecurityHeaders(res, requestId) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Request-Id", requestId);
}

function json(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeReason(error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 160);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const config = loadConfig();
  createProvisioningServer(config).listen(config.port, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "provisioning_started", port: config.port }));
  });
}
