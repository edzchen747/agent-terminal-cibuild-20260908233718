import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { breakStorage, resetStorage } from "./test-support.mjs";

const { deviceIdentity } = await import("./device.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => resetStorage());
afterEach(() => resetStorage());

test("two identity reads for the same install return the same id", async () => {
  const first = await deviceIdentity("android");
  const second = await deviceIdentity("android");
  assert.equal(first.id, second.id);
  assert.match(first.id, UUID_RE);
});

test("the id survives across platforms: it is install-scoped, not platform-scoped", async () => {
  const android = await deviceIdentity("android");
  const ios = await deviceIdentity("ios");
  assert.equal(android.id, ios.id);
});

test("a fresh install (cleared storage) mints a new id", async () => {
  const first = await deviceIdentity("android");
  resetStorage();
  const second = await deviceIdentity("android");
  assert.notEqual(first.id, second.id);
});

test("storage failures still yield a usable session identity", async () => {
  const restore = breakStorage();
  try {
    const once = await deviceIdentity("android");
    const twice = await deviceIdentity("android");
    assert.match(once.id, UUID_RE);
    assert.match(twice.id, UUID_RE);
  } finally {
    restore();
  }
});

test("the name resolves without native plugins and the platform is passed through", async () => {
  const identity = await deviceIdentity("android");
  assert.equal(identity.platform, "android");
  assert.equal(typeof identity.name, "string");
  assert.ok(identity.name.length > 0);
});
