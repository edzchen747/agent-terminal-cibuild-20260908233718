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
  return asEmbeddedNodeFailure(value).code === "preauth_missing";
}
