// Fetch only completed private HeyGen looks, including the per-look engine list used by
// both picker eligibility and the final pre-create compatibility check. Production uses
// the cursor-paginated v3 endpoint. The older group helpers remain as an injected legacy
// test seam; they are not used by the picker or paid-generation path.

import { HeyGenAuthError } from "./heygen-avatars";
import { isHeyGenAvatarEngine, type HeyGenAvatarEngine } from "./heygen-avatar-engine";
import { createHash } from "node:crypto";

const GROUP_LIST_URL = "https://api.heygen.com/v2/avatar_group.list";
const looksUrl = (groupId: string) =>
  `https://api.heygen.com/v2/avatar_group/${encodeURIComponent(groupId)}/avatars`;
const FETCH_TIMEOUT_MS = 25_000;
const TTL_MS = 5 * 60 * 1000;
const V3_LOOKS_URL = "https://api.heygen.com/v3/avatars/looks";
const MAX_V3_LOOK_PAGES = 100;
const MAX_V3_LOOKS = 5_000;

/** One selectable avatar look — `avatar_id` is generation-ready (character.avatar_id). */
export interface OwnAvatar {
  avatar_id: string;
  avatar_name: string; // the group name, e.g. "Mew"
  preview_image_url: string;
  group_id: string;
  supported_api_engines?: HeyGenAvatarEngine[];
}

export interface RawGroup { id: string; name?: string; group_type?: string }
export interface RawLook { id?: string; image_url?: string; status?: string; name?: string; group_id?: string }
export interface RawV3Look {
  id?: unknown;
  name?: unknown;
  preview_image_url?: unknown;
  group_id?: unknown;
  status?: unknown;
  supported_api_engines?: unknown;
}

/**
 * Flatten groups + their looks into selectable avatars. Pure — unit-tested by
 * scripts/verify-heygen-own-avatars.ts. Keeps group order, then look order. Skips a look
 * only when it has an explicit non-"completed" status (training/pending/failed) or no id;
 * a missing status is treated as usable so a good look is never hidden.
 */
export function flattenOwnAvatars(
  groups: RawGroup[],
  looksByGroupId: Record<string, RawLook[]>,
): OwnAvatar[] {
  const out: OwnAvatar[] = [];
  for (const g of groups) {
    const looks = looksByGroupId[g.id] ?? [];
    for (const lk of looks) {
      if (!lk.id) continue;
      const status = (lk.status ?? "").toLowerCase();
      if (status && status !== "completed") continue;
      out.push({
        avatar_id: lk.id,
        avatar_name: g.name?.trim() || "อวตาร",
        preview_image_url: lk.image_url ?? "",
        group_id: g.id,
        // Legacy test seam only. Production discovery below uses v3 look metadata.
        supported_api_engines: ["avatar_iii"],
      });
    }
  }
  return out;
}

export function parseOwnAvatarLookPage(value: unknown): {
  avatars: OwnAvatar[];
  hasMore: boolean;
  nextToken?: string;
} {
  const page = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const avatars = (Array.isArray(page.data) ? page.data : []).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const look = item as RawV3Look;
    if (typeof look.id !== "string" || !look.id || look.status !== "completed") return [];
    const advertisedEngines = look.supported_api_engines;
    const knownEngines = Array.isArray(advertisedEngines) && advertisedEngines.every((engine) => typeof engine === "string")
      ? advertisedEngines.filter(isHeyGenAvatarEngine)
      : undefined;
    const engines = knownEngines && (advertisedEngines as string[]).length > 0 && knownEngines.length === 0
      ? undefined
      : knownEngines;
    return [{
      avatar_id: look.id,
      avatar_name: typeof look.name === "string" && look.name.trim() ? look.name.trim() : "อวตาร",
      preview_image_url: typeof look.preview_image_url === "string" ? look.preview_image_url : "",
      group_id: typeof look.group_id === "string" ? look.group_id : "",
      ...(engines ? { supported_api_engines: engines } : {}),
    }];
  });
  return {
    avatars,
    hasMore: page.has_more === true,
    ...(typeof page.next_token === "string" && page.next_token
      ? { nextToken: page.next_token }
      : {}),
  };
}

type CacheEntry = { userId: string; at: number; data: OwnAvatar[] };
const cache = new Map<string, CacheEntry>();
const cacheKey = (userId: string, heygenKey: string) =>
  `${userId}:${createHash("sha256").update(heygenKey).digest("hex")}`;

async function heygenGet(url: string, heygenKey: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "X-Api-Key": heygenKey, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new HeyGenAuthError(res.status);
  if (!res.ok) throw new Error(`HeyGen look request failed (${res.status})`);
  return res.json();
}

async function defaultFetchGroups(heygenKey: string): Promise<RawGroup[]> {
  const d = await heygenGet(GROUP_LIST_URL, heygenKey);
  const root = typeof d === "object" && d !== null ? d as Record<string, unknown> : {};
  const data = typeof root.data === "object" && root.data !== null ? root.data as Record<string, unknown> : {};
  return Array.isArray(data.avatar_group_list) ? data.avatar_group_list as RawGroup[] : [];
}

async function defaultFetchLooks(groupId: string, heygenKey: string): Promise<RawLook[]> {
  const d = await heygenGet(looksUrl(groupId), heygenKey);
  const root = typeof d === "object" && d !== null ? d as Record<string, unknown> : {};
  const data = typeof root.data === "object" && root.data !== null ? root.data as Record<string, unknown> : {};
  const looks = Array.isArray(data.avatar_list) ? data.avatar_list : data.avatars;
  return Array.isArray(looks) ? looks as RawLook[] : [];
}

async function defaultFetchV3LookPage(
  heygenKey: string,
  token?: string,
): Promise<ReturnType<typeof parseOwnAvatarLookPage>> {
  const url = new URL(V3_LOOKS_URL);
  url.searchParams.set("ownership", "private");
  url.searchParams.set("limit", "50");
  if (token) url.searchParams.set("token", token);
  return parseOwnAvatarLookPage(await heygenGet(url.toString(), heygenKey));
}

/**
 * Get the user's own completed looks, fetched from HeyGen and cached in-memory for 5 min.
 * Auth errors propagate so the existing bad-key UI remains authoritative. The optional
 * group loaders preserve the legacy fixture seam; `fetchPage` drives the production shape.
 */
export async function getHeyGenOwnAvatars(
  userId: string,
  heygenKey: string,
  opts: {
    now?: number;
    refresh?: boolean;
    fetchGroups?: (key: string) => Promise<RawGroup[]>;
    fetchLooks?: (groupId: string, key: string) => Promise<RawLook[]>;
    fetchPage?: (key: string, token?: string) => Promise<ReturnType<typeof parseOwnAvatarLookPage>>;
  } = {},
): Promise<{ avatars: OwnAvatar[] }> {
  const key = cacheKey(userId, heygenKey);
  const now = opts.now ?? Date.now();
  for (const [cachedKey, entry] of cache) {
    if (now - entry.at >= TTL_MS || (entry.userId === userId && cachedKey !== key)) {
      cache.delete(cachedKey);
    }
  }
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && now - hit.at < TTL_MS) return { avatars: hit.data };
  }
  let avatars: OwnAvatar[];
  if (opts.fetchGroups || opts.fetchLooks) {
    const fetchGroups = opts.fetchGroups ?? defaultFetchGroups;
    const fetchLooks = opts.fetchLooks ?? defaultFetchLooks;
    const groups = await fetchGroups(heygenKey);
    const settled = await Promise.allSettled(groups.map((g) => fetchLooks(g.id, heygenKey)));
    const looksByGroupId: Record<string, RawLook[]> = {};
    groups.forEach((g, i) => {
      const result = settled[i];
      looksByGroupId[g.id] = result.status === "fulfilled" ? result.value : [];
    });
    avatars = flattenOwnAvatars(groups, looksByGroupId);
  } else {
    const fetchPage = opts.fetchPage ?? defaultFetchV3LookPage;
    avatars = [];
    let token: string | undefined;
    let pages = 0;
    const seenTokens = new Set<string>();
    do {
      if (++pages > MAX_V3_LOOK_PAGES) throw new Error("HeyGen look pagination limit exceeded");
      const page = await fetchPage(heygenKey, token);
      if (avatars.length + page.avatars.length > MAX_V3_LOOKS) {
        throw new Error("HeyGen look catalog limit exceeded");
      }
      avatars.push(...page.avatars);
      token = page.hasMore ? page.nextToken : undefined;
      if (page.hasMore && !token) throw new Error("HeyGen look pagination cursor missing");
      if (token && seenTokens.has(token)) throw new Error("HeyGen look pagination cursor repeated");
      if (token) seenTokens.add(token);
    } while (token);
  }
  cache.set(key, { userId, at: now, data: avatars });
  return { avatars };
}

/** Test/ops hook — drop all cached own-avatar lists. */
export function __clearOwnAvatarCache(): void {
  cache.clear();
}

/** Test/ops hook — ensure expired and superseded credential entries do not accumulate. */
export function __ownAvatarCacheSize(): number {
  return cache.size;
}
