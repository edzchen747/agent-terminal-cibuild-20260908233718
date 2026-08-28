import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";

const JSON_LIMIT_BYTES = 4_096;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES = new Set(["desktop", "mobile"]);

export function loadConfig(env = process.env) {
  const keyTtlSeconds = boundedInteger(env.PROVISIONING_KEY_TTL_SECONDS, 300, 60, 900, "PROVISIONING_KEY_TTL_SECONDS");
  return {
    port: boundedInteger(env.PORT, 8090, 1, 65_535, "PORT"),
    headscaleUrl: (env.HEADSCALE_INTERNAL_URL ?? "http://headscale:8080").replace(/\/+$/, ""),
    headscaleApiKey: required(env, "HEADSCALE_PROVISION_API_KEY"),
    keyTtlSeconds,
    activationTtlSeconds: boundedInteger(env.PROVISIONING_ACTIVATION_TTL_SECONDS, 45, 15, 120, "PROVISIONING_ACTIVATION_TTL_SECONDS"),
    nonceRetentionMs: boundedInteger(env.PROVISIONING_NONCE_RETENTION_SECONDS, 3_600, keyTtlSeconds, 86_400, "PROVISIONING_NONCE_RETENTION_SECONDS") * 1_000,
    rateWindowMs: boundedInteger(env.PROVISIONING_RATE_WINDOW_SECONDS, 60, 10, 600, "PROVISIONING_RATE_WINDOW_SECONDS") * 1_000,
    rateLimits: {
      source: boundedInteger(env.PROVISIONING_SOURCE_RATE_LIMIT, 12, 1, 1_000, "PROVISIONING_SOURCE_RATE_LIMIT"),
      subnet: boundedInteger(env.PROVISIONING_SUBNET_RATE_LIMIT, 32, 1, 5_000, "PROVISIONING_SUBNET_RATE_LIMIT"),
      host: boundedInteger(env.PROVISIONING_HOST_RATE_LIMIT, 12, 1, 1_000, "PROVISIONING_HOST_RATE_LIMIT"),
      desktop: boundedInteger(env.PROVISIONING_DESKTOP_RATE_LIMIT, 4, 1, 100, "PROVISIONING_DESKTOP_RATE_LIMIT"),
      mobile: boundedInteger(env.PROVISIONING_MOBILE_RATE_LIMIT, 6, 1, 100, "PROVISIONING_MOBILE_RATE_LIMIT"),
      global: boundedInteger(env.PROVISIONING_GLOBAL_RATE_LIMIT, 500, 1, 100_000, "PROVISIONING_GLOBAL_RATE_LIMIT")
    },
    maxConcurrentEnrollments: boundedInteger(env.PROVISIONING_MAX_CONCURRENT_ENROLLMENTS, 4, 1, 64, "PROVISIONING_MAX_CONCURRENT_ENROLLMENTS"),
    maxConnections: boundedInteger(env.PROVISIONING_MAX_CONNECTIONS, 128, 16, 2_048, "PROVISIONING_MAX_CONNECTIONS"),
    maxActiveActivations: boundedInteger(env.PROVISIONING_MAX_ACTIVE_ACTIVATIONS, 10_000, 100, 100_000, "PROVISIONING_MAX_ACTIVE_ACTIVATIONS"),
    upstreamTimeoutMs: boundedInteger(env.PROVISIONING_UPSTREAM_TIMEOUT_MS, 8_000, 1_000, 30_000, "PROVISIONING_UPSTREAM_TIMEOUT_MS")
  };
}

export function createProvisioningServer(config, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const request = dependencies.fetch ?? fetch;
  const usedNonces = new Map();
  const activations = new Map();
  const rateBuckets = new Map();
  let enrollmentCount = 0;

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    setSecurityHeaders(res, requestId);
    const url = new URL(req.url ?? "/", "http://provisioner.invalid");

    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method !== "POST" || (url.pathname !== "/v1/activate" && url.pathname !== "/v1/enroll")) {
      return json(res, 404, { error: "not_found" });
    }

    const source = clientAddress(req);
    const timestamp = now();
    cleanup(usedNonces, activations, rateBuckets, timestamp);
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      audit("request_rejected", { requestId, source, reason: error?.code === "BODY_TOO_LARGE" ? "body_too_large" : "invalid_json" });
      return json(res, error?.code === "BODY_TOO_LARGE" ? 413 : 400, { error: "invalid_request" });
    }
    if (!validEnrollment(body)) {
      audit("request_rejected", { requestId, source, reason: "invalid_fields" });
      return json(res, 400, { error: "invalid_request" });
    }

    const auditFields = { requestId, source, role: body.role, hostId: body.hostId, deviceId: body.deviceId };
    if (!takeRequestQuotas(rateBuckets, config, source, body, timestamp)) {
      res.setHeader("Retry-After", String(Math.ceil(config.rateWindowMs / 1_000)));
      audit("request_rate_limited", auditFields);
      return json(res, 429, { error: "rate_limited" });
    }

    if (url.pathname === "/v1/activate") {
      if (activations.size >= config.maxActiveActivations) {
        audit("activation_capacity_reached", auditFields);
        return json(res, 503, { error: "provisioning_busy" });
      }
      const nonceIdentity = sha256(`${body.role}:${body.hostId}:${body.deviceId}:${body.nonce}`);
      if (usedNonces.has(nonceIdentity)) {
        audit("activation_replay_rejected", auditFields);
        return json(res, 409, { error: "nonce_already_used" });
      }
      usedNonces.set(nonceIdentity, timestamp + config.nonceRetentionMs);

      const activationToken = randomBytes(32).toString("base64url");
      const expiresAt = timestamp + config.activationTtlSeconds * 1_000;
      activations.set(sha256(activationToken), { ...body, expiresAt, source });
      audit("activation_issued", auditFields);
      return json(res, 201, { activationToken, expiresAt: new Date(expiresAt).toISOString() });
    }

    const activationToken = bearerToken(req.headers.authorization);
    const activationIdentity = activationToken && sha256(activationToken);
    const activation = activationIdentity && activations.get(activationIdentity);
    if (!activation || activation.expiresAt <= timestamp) {
      audit("enrollment_unauthorized", auditFields);
      return json(res, 401, { error: "unauthorized" });
    }
    if (enrollmentCount >= config.maxConcurrentEnrollments) {
      res.setHeader("Retry-After", "2");
      audit("enrollment_capacity_reached", auditFields);
      return json(res, 503, { error: "provisioning_busy" });
    }

    // Delete synchronously before the first await. Concurrent requests can never
    // redeem the same capability twice, including failed or mismatched attempts.
    activations.delete(activationIdentity);
    if (!sameEnrollment(activation, body) || activation.source !== source) {
      audit("activation_mismatch", auditFields);
      return json(res, 403, { error: "activation_mismatch" });
    }

    enrollmentCount += 1;
    try {
      const userId = await ensureHeadscaleUser(config, request, body.hostId);
      const expiresAt = new Date(now() + config.keyTtlSeconds * 1_000).toISOString();
      const headscaleResponse = await headscaleRequest(config, request, "/api/v1/preauthkey", {
        method: "POST",
        body: {
          user: userId,
          reusable: false,
          ephemeral: false,
          expiration: expiresAt,
          // Headscale 0.29 tags remove user ownership. Keep this empty so the
          // same-user ACL can isolate every desktop/mobile pairing group.
          aclTags: []
        }
      });
      const result = await headscaleResponse.json();
      const key = result?.preAuthKey?.key;
      if (typeof key !== "string" || key.length < 20) throw new Error("Headscale returned no pre-auth key");

      audit("enrollment_issued", auditFields);
      return json(res, 201, { authKey: key, expiresAt });
    } catch (error) {
      audit("enrollment_failed", { ...auditFields, reason: safeReason(error) }, true);
      return json(res, 502, { error: "provisioning_unavailable" });
    } finally {
      enrollmentCount -= 1;
    }
  });

  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = config.maxConnections;
  server.maxRequestsPerSocket = 20;
  return server;
}

async function ensureHeadscaleUser(config, request, hostId) {
  const digest = sha256(hostId);
  const name = `at-${digest.slice(0, 24)}`;
  const existing = await findHeadscaleUser(config, request, name);
  if (existing) return String(existing.id);

  try {
    const response = await headscaleRequest(config, request, "/api/v1/user", {
      method: "POST",
      body: { name, displayName: `Agent Terminal ${digest.slice(0, 8)}` }
    });
    const result = await response.json();
    const user = result?.user ?? result;
    if (user?.id !== undefined) return String(user.id);
  } catch (error) {
    const raced = await findHeadscaleUser(config, request, name);
    if (raced) return String(raced.id);
    throw error;
  }
  throw new Error("Headscale returned no user ID");
}

async function findHeadscaleUser(config, request, name) {
  const response = await headscaleRequest(config, request, `/api/v1/user?name=${encodeURIComponent(name)}`, { method: "GET", allowNotFound: true });
  if (response.status === 404) return undefined;
  const result = await response.json();
  const users = Array.isArray(result?.users) ? result.users : [];
  return users.find((user) => user?.name === name);
}

async function headscaleRequest(config, request, path, options) {
  const response = await request(`${config.headscaleUrl}${path}`, {
    method: options.method,
    headers: {
      authorization: `Bearer ${config.headscaleApiKey}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs)
  });
  if (!response.ok && !(options.allowNotFound && response.status === 404)) {
    throw new Error(`Headscale returned HTTP ${response.status}`);
  }
  return response;
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

function bearerToken(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  return token.length >= 32 && token.length <= 128 ? token : undefined;
}

function validEnrollment(body) {
  return body && typeof body === "object" && ROLES.has(body.role) &&
    typeof body.nonce === "string" && NONCE_PATTERN.test(body.nonce) &&
    typeof body.hostId === "string" && ID_PATTERN.test(body.hostId) &&
    typeof body.deviceId === "string" && ID_PATTERN.test(body.deviceId) &&
    Object.keys(body).every((key) => key === "role" || key === "nonce" || key === "hostId" || key === "deviceId");
}

function sameEnrollment(left, right) {
  return left.role === right.role && left.nonce === right.nonce && left.hostId === right.hostId && left.deviceId === right.deviceId;
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

function takeRequestQuotas(buckets, config, source, body, timestamp) {
  const keys = [
    ["global", config.rateLimits.global],
    [`source:${source}`, config.rateLimits.source],
    [`subnet:${networkPrefix(source)}`, config.rateLimits.subnet],
    [`host:${sha256(body.hostId).slice(0, 24)}`, config.rateLimits.host],
    [`role:${body.role}:${sha256(body.hostId).slice(0, 24)}`, config.rateLimits[body.role]]
  ];
  return keys.every(([identity, limit]) => takeRateLimit(buckets, identity, limit, config.rateWindowMs, timestamp));
}

function takeRateLimit(buckets, identity, limit, windowMs, timestamp) {
  const current = buckets.get(identity);
  if (!current || current.resetAt <= timestamp) {
    buckets.set(identity, { count: 1, resetAt: timestamp + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function cleanup(nonces, activations, buckets, timestamp) {
  for (const [key, expiresAt] of nonces) if (expiresAt <= timestamp) nonces.delete(key);
  for (const [key, activation] of activations) if (activation.expiresAt <= timestamp) activations.delete(key);
  for (const [key, bucket] of buckets) if (bucket.resetAt <= timestamp) buckets.delete(key);
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = typeof forwarded === "string" && forwarded.length <= 256
    ? forwarded.split(",").at(-1)?.trim()
    : req.socket.remoteAddress;
  return normalizeAddress(raw ?? "unknown");
}

function normalizeAddress(address) {
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  return address.toLowerCase();
}

function networkPrefix(address) {
  if (isIP(address) === 4) return `${address.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIP(address) !== 6) return address;
  const [leftRaw, rightRaw = ""] = address.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const groups = rightRaw === "" && !address.includes("::")
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group || "0", 16).toString(16)).join(":")}::/64`;
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

function audit(event, fields, isError = false) {
  const output = JSON.stringify({ event, ...fields });
  (isError ? console.error : console.info)(output);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const config = loadConfig();
  createProvisioningServer(config).listen(config.port, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "provisioning_started", port: config.port }));
  });
}
