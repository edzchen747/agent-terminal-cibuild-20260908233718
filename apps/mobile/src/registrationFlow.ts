import type { RegistrationVerdict } from "./registrationCache";

/**
 * The launch-time node check is a small state machine: a cached verdict
 * short-circuits it, the engine either confirms the registration or reports
 * a dropped node (there is nothing to confirm, so the phone re-enrolls), a
 * first transient failure keeps "Registering" and retries once, and only a
 * repeated transient failure surfaces the error. Pure so every branch
 * combination is testable without the native engine.
 */
export type RegistrationCheckPlan =
  | "stayEnrolled"
  | "reEnroll"
  | "markEnrolled"
  | "keepStored"
  | "retryOnce"
  | "showFailed";

export function registrationCheckPlan(input: {
  cached: RegistrationVerdict | null;
  engineStarted: boolean;
  failed: boolean;
  dropped: boolean;
  retryOnTransientFailure: boolean;
}): RegistrationCheckPlan {
  if (input.cached === "verified") return "stayEnrolled";
  if (input.cached === "lanOnly") return "reEnroll";
  if (!input.failed) {
    return input.engineStarted ? "markEnrolled" : "keepStored";
  }
  if (input.dropped) return "reEnroll";
  return input.retryOnTransientFailure ? "retryOnce" : "showFailed";
}
