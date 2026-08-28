import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProvisioningServer, loadConfig } from "./server.mjs";

const clientToken = "test-client-token-with-at-least-32-characters";
const tokenHash = createHash("sha256").update(clientToken).digest("hex");

function config(overrides = {}) {
  return {
    ...loadConfig({
      PROVISIONING_CLIENT_TOKEN_HASHES: tokenHash,
      HEADSCALE_PROVISION_API_KEY: "server-only-headscale-key",
      HEADSCALE_USER_ID: "7",
      HEADSCALE_ACL_TAGS: "tag:agent-terminal-mobile",
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

async function activate(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    body
  });
  return { response, value: await response.json() };
}

test("creates a fixed, single-use Headscale key without accepting policy parameters", async () => {
  let upstream;
  const server = createProvisioningServer(config(), {
    now: () => Date.parse("2026-08-28T12:00:00Z"),
    fetch: async (url, options) => {
      upstream = { url, options, body: JSON.parse(options.body) };
      return Response.json({ preAuthKey: { key: "generated-single-use-auth-key" } });
    }
  });
  await withServer(server, async (baseUrl) => {
    const body = JSON.stringify({ nonce: "abcdefghijklmnopqrstuvwxyzABCDEF", hostId: "host-1", deviceId: "device-1" });
    const activation = await activate(baseUrl, body);
    assert.equal(activation.response.status, 201);
    assert.equal(typeof activation.value.activationToken, "string");
    const response = await fetch(`${baseUrl}/v1/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${activation.value.activationToken}`, "content-type": "application/json" },
      body
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      authKey: "generated-single-use-auth-key",
      expiresAt: "2026-08-28T12:02:00.000Z"
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(upstream.url, "http://headscale:8080/api/v1/preauthkey");
    assert.equal(upstream.options.headers.authorization, "Bearer server-only-headscale-key");
    assert.deepEqual(upstream.body, {
      user: "7",
      reusable: false,
      ephemeral: false,
      expiration: "2026-08-28T12:02:00.000Z",
      aclTags: ["tag:agent-terminal-mobile"]
    });
  });
});

test("requires client authentication and consumes both nonce and activation once", async () => {
  let calls = 0;
  const server = createProvisioningServer(config(), {
    fetch: async () => {
      calls += 1;
      return Response.json({ preAuthKey: { key: "generated-single-use-auth-key" } });
    }
  });
  await withServer(server, async (baseUrl) => {
    const body = JSON.stringify({ nonce: "12345678901234567890123456789012", hostId: "host-1", deviceId: "device-1" });
    const unauthorized = await fetch(`${baseUrl}/v1/activate`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(unauthorized.status, 401);

    const activation = await activate(baseUrl, body);
    assert.equal(activation.response.status, 201);
    assert.equal((await activate(baseUrl, body)).response.status, 409);
    const headers = { authorization: `Bearer ${activation.value.activationToken}`, "content-type": "application/json" };
    assert.equal((await fetch(`${baseUrl}/v1/enroll`, { method: "POST", headers, body })).status, 201);
    assert.equal((await fetch(`${baseUrl}/v1/enroll`, { method: "POST", headers, body })).status, 401);
    assert.equal(calls, 1);
  });
});

test("rejects caller-selected Headscale options", async () => {
  const server = createProvisioningServer(config(), { fetch: async () => assert.fail("Headscale must not be called") });
  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        nonce: "abcdefghijklmnopqrstuvwxyzABCDEF",
        hostId: "host-1",
        deviceId: "device-1",
        reusable: true
      })
    });
    assert.equal(response.status, 400);
  });
});
