// Shared, cached fetch of a user's HeyGen avatar list (`/v2/avatars`).
//
// Why: both /api/heygen/avatar-info (preview lookup) and /api/heygen/avatars (picker) fetched the
// ENTIRE HeyGen avatar list on every call just to find/show one avatar. HeyGen's list endpoint is
// intermittently slow (even a 35s + 3-retry call times out sometimes), so the preview "wouldn't
// load" while generation — which uses the avatarId directly — still worked. This caches the list
// per user (short TTL) so repeat lookups are instant and we stop hammering HeyGen.
//
// Cache rule: store ONLY successful fetches. A slow/failed fetch is never cached, so the explicit
// "reload" button (and the next request) actually retries HeyGen instead of serving a stale empty.

export class HeyGenAuthError extends Error {
  constructor(public status: number) {
    super(`HeyGen auth error ${status}`);
    this.name = "HeyGenAuthError";
  }
}

export type HeyGenAvatarList = {
  avatars: any[];
  talkingPhotos: any[];
  /** true when served from the durable fallback because the live HeyGen fetch failed (slow/unreachable). */
  stale?: boolean;
};

export const HEYGEN_AVATAR_TTL_MS = 5 * 60 * 1000;
/** How long a durable (DB-persisted) avatar list stays usable as a stale fallback. */
export const HEYGEN_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 35_000;
const HEYGEN_AVATARS_URL = "https://api.heygen.com/v2/avatars";

type CacheEntry = { at: number; data: HeyGenAvatarList };
const cache = new Map<string, CacheEntry>();

// Key by user + a fingerprint of the key, so rotating the HeyGen key busts the cache immediately
// (a different key can list different avatars).
function cacheKey(userId: string, heygenKey: string): string {
  return `${userId}:${heygenKey.slice(-6)}`;
}

async function fetchAvatarListFromHeyGen(heygenKey: string): Promise<HeyGenAvatarList> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(HEYGEN_AVATARS_URL, {
        headers: { "X-Api-Key": heygenKey, accept: "application/json" },
        signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw new HeyGenAuthError(res.status);
      if (!res.ok) throw new Error(`HeyGen API error ${res.status}`);
      const data: any = await res.json();
      return { avatars: data?.data?.avatars ?? [], talkingPhotos: data?.data?.talking_photos ?? [] };
    } catch (err) {
      if (err instanceof HeyGenAuthError) throw err; // auth failures: don't retry
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 500)); // 0.5s, 1s backoff
      }
    }
  }
  throw lastError ?? new Error("HeyGen avatars fetch failed");
}

/**
 * Get the user's HeyGen avatar list, served from a short-TTL per-user cache, with a DURABLE
 * fallback so the picker/preview keep working when HeyGen's list endpoint is slow.
 *
 * - On success: cache in-memory AND persist via `saveStale` (survives process restarts — the
 *   in-memory cache is wiped on every redeploy/restart, so a durable copy is what actually
 *   protects the cold-cache + slow-HeyGen failure mode).
 * - On a non-auth fetch failure: if `loadStale` returns a saved list, SERVE IT (flagged `stale`)
 *   instead of throwing, so the avatar still resolves. With no durable stale, the old
 *   degrade-to-unverified contract is preserved (throws).
 * - Auth errors (401/403) ALWAYS propagate and never serve stale — a bad/expired key must surface.
 *
 * `opts.fetcher`/`opts.now`/`opts.loadStale`/`opts.saveStale` are injection points for tests; the
 * routes wire the DB-backed durable store.
 */
export async function getHeyGenAvatarList(
  userId: string,
  heygenKey: string,
  opts: {
    refresh?: boolean;
    fetcher?: (key: string) => Promise<HeyGenAvatarList>;
    now?: number;
    loadStale?: (userId: string, heygenKey: string) => Promise<HeyGenAvatarList | null>;
    saveStale?: (userId: string, heygenKey: string, data: HeyGenAvatarList) => Promise<void>;
  } = {}
): Promise<HeyGenAvatarList> {
  const key = cacheKey(userId, heygenKey);
  const now = opts.now ?? Date.now();
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && now - hit.at < HEYGEN_AVATAR_TTL_MS) return hit.data;
  }
  const fetcher = opts.fetcher ?? fetchAvatarListFromHeyGen;
  let data: HeyGenAvatarList;
  try {
    data = await fetcher(heygenKey);
  } catch (err) {
    if (err instanceof HeyGenAuthError) throw err; // bad key → surface, never mask with stale
    if (opts.loadStale) {
      const stale = await opts.loadStale(userId, heygenKey);
      if (stale) return { avatars: stale.avatars, talkingPhotos: stale.talkingPhotos, stale: true };
    }
    throw err; // no durable stale → preserve degrade-to-unverified contract (reload retries)
  }
  cache.set(key, { at: now, data });
  if (opts.saveStale) {
    // Best-effort persistence — must never break the happy path.
    try { await opts.saveStale(userId, heygenKey, data); } catch { /* ignore durable-store write errors */ }
  }
  return data;
}

/** Test/ops hook — drop all cached lists. */
export function __clearHeyGenAvatarCache(): void {
  cache.clear();
}

// --- Durable store (DB-backed) serialize/parse — pure so the key-rotation + max-age + malformed
// guards are unit-tested without a database. The prisma read/write lives in heygen-avatars-store.ts.

/** Serialize a list for durable storage, stamping the key fingerprint (last 6) so a rotated key
 *  can be detected and its old list NOT served. */
export function serializeStale(heygenKey: string, data: HeyGenAvatarList): string {
  return JSON.stringify({ k: heygenKey.slice(-6), avatars: data.avatars, talkingPhotos: data.talkingPhotos });
}

/** Parse a durable blob back to a list, returning null when it's missing, malformed, too old, or
 *  was saved under a different key (so rotating the HeyGen key never serves another key's avatars). */
export function parseStale(
  raw: string | null | undefined,
  heygenKey: string,
  cachedAt: number | null | undefined,
  now: number,
  maxAgeMs: number = HEYGEN_STALE_MAX_MS
): HeyGenAvatarList | null {
  if (!raw) return null;
  if (cachedAt == null || now - cachedAt > maxAgeMs) return null;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || parsed.k !== heygenKey.slice(-6)) return null;
  if (!Array.isArray(parsed.avatars) || !Array.isArray(parsed.talkingPhotos)) return null;
  return { avatars: parsed.avatars, talkingPhotos: parsed.talkingPhotos };
}
