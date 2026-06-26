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

export type HeyGenAvatarList = { avatars: any[]; talkingPhotos: any[] };

export const HEYGEN_AVATAR_TTL_MS = 5 * 60 * 1000;
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
 * Get the user's HeyGen avatar list, served from a short-TTL per-user cache.
 * Throws HeyGenAuthError on 401/403, or a generic Error if HeyGen is unreachable after retries
 * (callers decide how to degrade). `opts.fetcher`/`opts.now` are injection points for tests.
 */
export async function getHeyGenAvatarList(
  userId: string,
  heygenKey: string,
  opts: { refresh?: boolean; fetcher?: (key: string) => Promise<HeyGenAvatarList>; now?: number } = {}
): Promise<HeyGenAvatarList> {
  const key = cacheKey(userId, heygenKey);
  const now = opts.now ?? Date.now();
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && now - hit.at < HEYGEN_AVATAR_TTL_MS) return hit.data;
  }
  const fetcher = opts.fetcher ?? fetchAvatarListFromHeyGen;
  const data = await fetcher(heygenKey); // throws on failure → NOT cached (so reload retries)
  cache.set(key, { at: now, data });
  return data;
}

/** Test/ops hook — drop all cached lists. */
export function __clearHeyGenAvatarCache(): void {
  cache.clear();
}
