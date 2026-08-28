import assert from "node:assert/strict";
import test from "node:test";
import { asEmbeddedNodeFailure, isDroppedNodeEnrollmentError } from "./nodeEnrollment.ts";

test("recognizes a dropped native node by its stable error code", () => {
  const error = Object.assign(new Error("localized message"), { code: "preauth_missing" });

  assert.equal(isDroppedNodeEnrollmentError(error), true);
  assert.equal(isDroppedNodeEnrollmentError(Object.assign(new Error("same text"), { code: "preauth_rejected" })), false);
});

test("preserves Capacitor error codes when normalizing native failures", () => {
  const error = asEmbeddedNodeFailure({ message: "node missing", code: "preauth_missing" });

  assert.equal(error.message, "node missing");
  assert.equal(error.code, "preauth_missing");
});
