import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProvisioningServer, loadConfig } from "./server.mjs";

function config(overrides = {}) {
  return {
    ...loadConfig({
      HEADSCALE_PROVISION_API_KEY: "server-only-headscale-key",
      PROVISIONING_KEY_TTL_SECONDS: "120"
    }),
    ...overrides
  };
}

async function withServer(server, action) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(baseUrl, path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, value: await response.json() };
}

function upstream() {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes("/api/v1/user?")) return Response.json({ users: [] });
      if (url.endsWith("/api/v1/user")) return Response.json({ user: { id: "7" } });
      return Response.json({ preAuthKey: { key: "generated-single-use-auth-key" } });
    }
  };
}

test("public activation creates a role-bound, single-use key under a per-host user", async () => {
  const headscale = upstream();
  const server = createProvisioningServer(config(), {
    now: () => Date.parse("2026-08-28T12:00:00Z"),
    fetch: headscale.fetch
  });
  await withServer(server, async (baseUrl) => {
    const body = { role: "mobile", nonce: "abcdefghijklmnopqrstuvwxyzABCDEF", hostId: "host-1", deviceId: "device-1" };
    const activation = await post(baseUrl, "/v1/activate", body);
    assert.equal(activation.response.status, 201);
    const enrolled = await post(baseUrl, "/v1/enroll", body, activation.value.activationToken);
    assert.equal(enrolled.response.status, 201);
    assert.deepEqual(enrolled.value, {
      authKey: "generated-single-use-auth-key",
      expiresAt: "2026-08-28T12:02:00.000Z"
    });

    const digest = createHash("sha256").update("host-1").digest("hex");
    assert.equal(headscale.calls[0].url, `http://headscale:8080/api/v1/user?name=at-${digest.slice(0, 24)}`);
    assert.deepEqual(headscale.calls[1].body, { name: `at-${digest.slice(0, 24)}`, displayName: `Agent Terminal ${digest.slice(0, 8)}` });
    assert.deepEqual(headscale.calls[2].body, {
      user: "7",
      reusable: false,
      ephemeral: false,
      expiration: "2026-08-28T12:02:00.000Z",
      aclTags: []
    });
    assert.equal(headscale.calls[2].options.headers.authorization, "Bearer server-only-headscale-key");
  });
});

test("activation is bound to role, host, device, nonce, and source and consumed atomically", async () => {
  const headscale = upstream();
  const server = createProvisioningServer(config(), { fetch: headscale.fetch });
  await withServer(server, async (baseUrl) => {
    const body = { role: "desktop", nonce: "12345678901234567890123456789012", hostId: "host-1", deviceId: "device-1" };
    const activation = await post(baseUrl, "/v1/activate", body);
    assert.equal(activation.response.status, 201);
    const mismatch = await post(baseUrl, "/v1/enroll", { ...body, role: "mobile" }, activation.value.activationToken);
    assert.equal(mismatch.response.status, 403);
    assert.equal((await post(baseUrl, "/v1/enroll", body, activation.value.activationToken)).response.status, 401);
    assert.equal(headscale.calls.length, 0);
    assert.equal((await post(baseUrl, "/v1/activate", body)).response.status, 409);
  });
});

test("rejects caller-selected Headscale options and unsupported roles", async () => {
  const server = createProvisioningServer(config(), { fetch: async () => assert.fail("Headscale must not be called") });
  await withServer(server, async (baseUrl) => {
    const base = { role: "mobile", nonce: "abcdefghijklmnopqrstuvwxyzABCDEF", hostId: "host-1", deviceId: "device-1" };
    assert.equal((await post(baseUrl, "/v1/activate", { ...base, reusable: true })).response.status, 400);
    assert.equal((await post(baseUrl, "/v1/activate", { ...base, role: "admin" })).response.status, 400);
  });
});

test("rate limits exact sources before upstream work", async () => {
  const server = createProvisioningServer(config({ rateLimits: { source: 1, subnet: 100, host: 100, desktop: 100, mobile: 100, global: 100 } }), {
    fetch: async () => assert.fail("Headscale must not be called")
  });
  await withServer(server, async (baseUrl) => {
    const first = { role: "desktop", nonce: "abcdefghijklmnopqrstuvwxyzABCDEF", hostId: "host-1", deviceId: "device-1" };
    const second = { ...first, nonce: "12345678901234567890123456789012" };
    assert.equal((await post(baseUrl, "/v1/activate", first)).response.status, 201);
    assert.equal((await post(baseUrl, "/v1/activate", second)).response.status, 429);
  });
});
