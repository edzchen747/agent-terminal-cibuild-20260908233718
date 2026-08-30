import assert from "node:assert/strict";
import test from "node:test";
import { deviceName, userAgentModel } from "./device.ts";

test("android webview user agents yield the hardware model", () => {
  assert.equal(
    userAgentModel("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240505.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"),
    "Pixel 8"
  );
  assert.equal(
    userAgentModel("Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36"),
    "SM-S918B"
  );
  assert.equal(
    userAgentModel("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36"),
    "K"
  );
});

test("non-android user agents yield no model", () => {
  assert.equal(userAgentModel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"), null);
  assert.equal(userAgentModel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"), null);
  assert.equal(userAgentModel(""), null);
});

test("web platforms always produce a web identity", async () => {
  assert.equal(await deviceName(), "Web client");
});
