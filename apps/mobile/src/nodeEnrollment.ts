export type EmbeddedNodeFailure = Error & { code?: string };

export function asEmbeddedNodeFailure(value: unknown): EmbeddedNodeFailure {
  if (value instanceof Error) return value as EmbeddedNodeFailure;
  const message = value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? value.message
    : "The embedded network node is unavailable.";
  const error = new Error(message) as EmbeddedNodeFailure;
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    error.code = value.code;
  }
  return error;
}

export function isDroppedNodeEnrollmentError(value: unknown): boolean {
  // Both codes prove the node is no longer usable: preauth_missing means the
  // control server no longer recognizes the saved node key, preauth_rejected
  // that the control plane rejected a re-registration attempt. Either way the
  // registration must be refreshed from the desktop's live session.
  const code = asEmbeddedNodeFailure(value).code;
  return code === "preauth_missing" || code === "preauth_rejected";
}

/**
 * The hosts-page verdict for a failed saved-host verification. The embedded
 * node distinguishes its failure causes by code (see the Go engine): a peer
 * that resolved but refused the dial means the desktop's node is registered
 * and simply down, so the host is "offline"; every other failure means
 * registration could not be proven (the desktop node is gone from the
 * netmap, the phone node was dropped, the control plane was unreachable),
 * so the host stays LAN only.
 */
export function savedHostRegistrationVerdict(value: unknown): "lanOnly" | "offline" {
  return asEmbeddedNodeFailure(value).code === "remote_host_unavailable" ? "offline" : "lanOnly";
}

/**
 * The message the registration banner shows for a failed enrollment. The
 * desktop's own text is surfaced when it is actionable; denial from a
 * desktop session that predates the trusted-pairing rule is rewritten by
 * hand, because telling the user to "pair" when they already paired sends
 * them in circles.
 */
export function enrollmentFailureMessage(message: string): string {
  if (/Complete trusted LAN pairing/i.test(message)) {
    return "The desktop rejected the registration request for this session. Update the desktop app, then retry from this paired session.";
  }
  if (/update the desktop app/i.test(message)) return message;
  return "Remote connection registration failed. LAN access is still available.";
}
