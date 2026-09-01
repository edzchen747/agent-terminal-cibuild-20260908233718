import assert from "node:assert/strict";
import test from "node:test";
import { asEmbeddedNodeFailure, enrollmentFailureMessage, isDroppedNodeEnrollmentError, savedHostRegistrationVerdict } from "./nodeEnrollment.ts";

test("recognizes a dropped native node by its stable error code", () => {
  const error = Object.assign(new Error("localized message"), { code: "preauth_missing" });

  assert.equal(isDroppedNodeEnrollmentError(error), true);
  assert.equal(isDroppedNodeEnrollmentError(Object.assign(new Error("same text"), { code: "preauth_rejected" })), true);
  assert.equal(isDroppedNodeEnrollmentError(Object.assign(new Error("unrelated"), { code: "embedded_node_start_failed" })), false);
  assert.equal(isDroppedNodeEnrollmentError(Object.assign(new Error("same text"), { code: "control_server_unavailable" })), false);
  assert.equal(isDroppedNodeEnrollmentError(new Error("no code at all")), false);
});

test("preserves Capacitor error codes when normalizing native failures", () => {
  const error = asEmbeddedNodeFailure({ message: "node missing", code: "preauth_missing" });

  assert.equal(error.message, "node missing");
  assert.equal(error.code, "preauth_missing");
});

test("preserves the code when the native failure is already an Error", () => {
  const value = Object.assign(new Error("plain"), { code: "preauth_rejected" });

  assert.equal(asEmbeddedNodeFailure(value), value);
  assert.equal(asEmbeddedNodeFailure(value).code, "preauth_rejected");
});

test("a non-object, non-Error native failure normalizes to the default message", () => {
  const error = asEmbeddedNodeFailure("boom");

  assert.equal(error.message, "The embedded network node is unavailable.");
  assert.equal(error.code, undefined);
});

test("the hosts-page verdict maps a dialed-but-refused peer to offline", () => {
  assert.equal(savedHostRegistrationVerdict(Object.assign(new Error("no route"), { code: "remote_host_unavailable" })), "offline");
});

test("the hosts-page verdict reads the code from a plain bridge rejection", () => {
  // The Capacitor bridge delivers plugin rejections as plain {message, code}
  // objects, not Error instances; the code must still win the verdict.
  assert.equal(savedHostRegistrationVerdict({ message: "The desktop overlay host is unavailable.", code: "remote_host_unavailable" }), "offline");
  assert.equal(savedHostRegistrationVerdict({ message: "The tsnet desktop host name could not be found.", code: "tsnet_host_not_found" }), "lanOnly");
  assert.equal(savedHostRegistrationVerdict({ message: "plain", code: "" }), "lanOnly");
});

test("the hosts-page verdict keeps everything else at lan only", () => {
  assert.equal(savedHostRegistrationVerdict(Object.assign(new Error("unknown host"), { code: "tsnet_host_not_found" })), "lanOnly");
  assert.equal(savedHostRegistrationVerdict(Object.assign(new Error("dropped"), { code: "preauth_missing" })), "lanOnly");
  assert.equal(savedHostRegistrationVerdict(Object.assign(new Error("no code"), { code: "embedded_node_start_failed" })), "lanOnly");
  assert.equal(savedHostRegistrationVerdict(new Error("nothing")), "lanOnly");
  assert.equal(savedHostRegistrationVerdict(Object.assign(new Error("control"), { code: "control_server_unavailable" })), "lanOnly");
});

test("enrollment failure message maps an old desktop's pairing denial to an actionable error", () => {
  assert.equal(
    enrollmentFailureMessage("Complete trusted LAN pairing before requesting a mobile enrollment key."),
    "The desktop rejected the registration request for this session. Update the desktop app, then retry from this paired session."
  );
});

test("enrollment failure message passes through update-the-desktop errors verbatim", () => {
  assert.equal(
    enrollmentFailureMessage("Update the desktop app and pair again."),
    "Update the desktop app and pair again."
  );
});

test("enrollment failure message falls back to the LAN-only notice for anything else", () => {
  assert.equal(
    enrollmentFailureMessage("A one-time mobile enrollment key could not be issued."),
    "Remote connection registration failed. LAN access is still available."
  );
  assert.equal(
    enrollmentFailureMessage(""),
    "Remote connection registration failed. LAN access is still available."
  );
});
