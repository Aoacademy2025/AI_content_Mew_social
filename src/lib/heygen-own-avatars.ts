// Fetch ONLY the user's OWN HeyGen avatars (the ones they created), fast.
//
// Why not /v2/avatars: that returns HeyGen's entire public catalog too (~512KB / ~65s on
// prod for a real account) — the picker then filtered it client-side but still paid the
// 65s. The user only wants THEIR avatars. HeyGen exposes those via avatar GROUPS:
//   GET /v2/avatar_group.list                 → the user's groups (e.g. "Mew", "Emma") ~1s
//   GET /v2/avatar_group/{group_id}/avatars   → the "looks" inside a group, each with the
//                                               `id` that is the real generation avatar_id
// A "look" id (32-hex) is what our render pipeline sends as character.avatar_id — verified
// against the user's working default + past DONE avatar renders. We fan out the per-group
// look fetches in parallel, so the whole thing is ~2s. Cached in-memory (5 min) — no durable
// store needed at this speed, and a live fetch each miss keeps auth errors surfacing.

import { HeyGenAuthError } from "./heygen-avatars";

const GROUP_LIST_URL = "https://api.heygen.com/v2/avatar_group.list";
const looksUrl = (groupId: string) =>
  `https://api.heygen.com/v2/avatar_group/${encodeURIComponent(groupId)}/avatars`;
const FETCH_TIMEOUT_MS = 25_000;
const TTL_MS = 5 * 60 * 1000;

/** One selectable avatar look — `avatar_id` is generation-ready (character.avatar_id). */
export interface OwnAvatar {
  avatar_id: string;
  avatar_name: string; // the group name, e.g. "Mew"
  preview_image_url: string;
  group_id: string;
}

export interface RawGroup { id: string; name?: string; group_type?: string }
export interface RawLook { id?: string; image_url?: string; status?: string; name?: string; group_id?: string }

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
      });
    }
  }
  return out;
}

type CacheEntry = { at: number; data: OwnAvatar[] };
const cache = new Map<string, CacheEntry>();
const cacheKey = (userId: string, heygenKey: string) => `${userId}:${heygenKey.slice(-6)}`;

async function heygenGet(url: string, heygenKey: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "X-Api-Key": heygenKey, accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new HeyGenAuthError(res.status);
  if (!res.ok) throw new Error(`HeyGen ${res.status} for ${url}`);
  return res.json();
}

async function defaultFetchGroups(heygenKey: string): Promise<RawGroup[]> {
  const d = await heygenGet(GROUP_LIST_URL, heygenKey);
  return (d?.data?.avatar_group_list ?? []) as RawGroup[];
}

async function defaultFetchLooks(groupId: string, heygenKey: string): Promise<RawLook[]> {
  const d = await heygenGet(looksUrl(groupId), heygenKey);
  return (d?.data?.avatar_list ?? d?.data?.avatars ?? []) as RawLook[];
}

/**
 * Get the user's own avatars (looks), fetched from HeyGen and cached in-memory for 5 min.
 * Group-list auth errors propagate (HeyGenAuthError) so a bad key surfaces; a single group's
 * look-fetch failing is tolerated (that group contributes nothing rather than failing all).
 * `opts.fetchGroups`/`fetchLooks`/`now` are test injection points.
 */
export async function getHeyGenOwnAvatars(
  userId: string,
  heygenKey: string,
  opts: {
    now?: number;
    refresh?: boolean;
    fetchGroups?: (key: string) => Promise<RawGroup[]>;
    fetchLooks?: (groupId: string, key: string) => Promise<RawLook[]>;
  } = {},
): Promise<{ avatars: OwnAvatar[] }> {
  const key = cacheKey(userId, heygenKey);
  const now = opts.now ?? Date.now();
  if (!opts.refresh) {
    const hit = cache.get(key);
    if (hit && now - hit.at < TTL_MS) return { avatars: hit.data };
  }
  const fetchGroups = opts.fetchGroups ?? defaultFetchGroups;
  const fetchLooks = opts.fetchLooks ?? defaultFetchLooks;

  const groups = await fetchGroups(heygenKey); // auth errors propagate here
  const settled = await Promise.allSettled(groups.map((g) => fetchLooks(g.id, heygenKey)));
  const looksByGroupId: Record<string, RawLook[]> = {};
  groups.forEach((g, i) => {
    const r = settled[i];
    looksByGroupId[g.id] = r.status === "fulfilled" ? r.value : [];
  });

  const avatars = flattenOwnAvatars(groups, looksByGroupId);
  cache.set(key, { at: now, data: avatars });
  return { avatars };
}

/** Test/ops hook — drop all cached own-avatar lists. */
export function __clearOwnAvatarCache(): void {
  cache.clear();
}
