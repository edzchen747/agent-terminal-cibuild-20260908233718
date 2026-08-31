import { Preferences } from "@capacitor/preferences";

/**
 * Per-host cache of registration verdicts.
 *
 * The hosts-page checks pinging every paired host and the launch-time tsnet
 * node verification both produce a per-host verdict. Re-running either on
 * every visit/restart churns the process-isolated node engines, so a fresh
 * verdict is remembered per host id and reused until its TTL expires:
 * 1 minute for the hosts-page ping, 1 hour for the startup node check.
 */
export type RegistrationVerdict = "verified" | "lanOnly";
export type RegistrationCheckKind = "hostPing" | "nodeCheck";

const HOST_PING_TTL_MS = 60_000;
const NODE_CHECK_TTL_MS = 3_600_000;
const STORAGE_KEYS: Record<RegistrationCheckKind, string> = {
  hostPing: "agent-terminal-host-ping",
  nodeCheck: "agent-terminal-node-check"
};

export interface RegistrationCacheEntry {
  at: number;
  verdict: RegistrationVerdict;
}

export type RegistrationCacheMap = Record<string, RegistrationCacheEntry>;

export function registrationCacheTtlMs(kind: RegistrationCheckKind): number {
  return kind === "hostPing" ? HOST_PING_TTL_MS : NODE_CHECK_TTL_MS;
}

/** The cached verdict if the entry exists and its TTL has not expired. */
export function cachedVerdict(
  entries: RegistrationCacheMap | undefined,
  hostId: string,
  now: number,
  ttlMs: number
): RegistrationVerdict | null {
  const entry = entries?.[hostId];
  if (!entry) return null;
  if (now - entry.at >= ttlMs) return null;
  return entry.verdict;
}

/** Records (or replaces) one host's verdict, keeping every other entry. */
export function rememberVerdict(
  entries: RegistrationCacheMap | undefined,
  hostId: string,
  verdict: RegistrationVerdict,
  now: number
): RegistrationCacheMap {
  return { ...(entries ?? {}), [hostId]: { at: now, verdict } };
}

/** Drops one host's entry, keeping every other entry intact. */
export function removeVerdict(
  entries: RegistrationCacheMap | undefined,
  hostId: string
): RegistrationCacheMap {
  if (!entries) return {};
  const next = { ...entries };
  delete next[hostId];
  return next;
}

/** Reads this host's verdict from the persisted cache, or null if stale. */
export async function readRegistrationVerdict(
  kind: RegistrationCheckKind,
  hostId: string
): Promise<RegistrationVerdict | null> {
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEYS[kind] });
    if (!value) return null;
    const entries = JSON.parse(value) as RegistrationCacheMap;
    return cachedVerdict(entries, hostId, Date.now(), registrationCacheTtlMs(kind));
  } catch {
    return null;
  }
}

/** Persists this host's verdict for the kind's TTL window. */
export async function rememberRegistrationVerdict(
  kind: RegistrationCheckKind,
  hostId: string,
  verdict: RegistrationVerdict
): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: STORAGE_KEYS[kind] });
    const entries: RegistrationCacheMap | undefined = value ? JSON.parse(value) : undefined;
    await Preferences.set({
      key: STORAGE_KEYS[kind],
      value: JSON.stringify(rememberVerdict(entries, hostId, verdict, Date.now()))
    });
  } catch {
    // A cache is best-effort; the next check simply runs again.
  }
}

/** Drops every cache entry for a host that was unpaired. */
export async function forgetRegistrationVerdict(hostId: string): Promise<void> {
  for (const kind of ["hostPing", "nodeCheck"] as const) {
    try {
      const { value } = await Preferences.get({ key: STORAGE_KEYS[kind] });
      if (!value) continue;
      const entries = JSON.parse(value) as RegistrationCacheMap;
      await Preferences.set({
        key: STORAGE_KEYS[kind],
        value: JSON.stringify(removeVerdict(entries, hostId))
      });
    } catch {
      // Best-effort; stale cache entries expire by TTL.
    }
  }
}
