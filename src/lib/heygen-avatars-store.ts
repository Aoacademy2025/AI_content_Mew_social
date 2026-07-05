// DB-backed durable store for the HeyGen avatar list. The in-memory cache in heygen-avatars.ts is
// wiped on every redeploy/restart (ai-content restarts often), so a persisted copy is what actually
// protects the cold-cache + slow-HeyGen failure mode that made the avatar picker/preview look broken.
//
// Wired into /api/heygen/avatars and /api/heygen/avatar-info as the loadStale/saveStale hooks.
import { prisma } from "@/lib/prisma";
import { serializeStale, parseStale, type HeyGenAvatarList } from "@/lib/heygen-avatars";

/** Persist the last successful list (best-effort; callers already swallow errors). */
export async function saveStaleAvatars(userId: string, heygenKey: string, data: HeyGenAvatarList): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { heygenAvatarsCache: serializeStale(heygenKey, data), heygenAvatarsCachedAt: new Date() },
  });
}

/** Load the durable fallback list, honouring the key-fingerprint + max-age guards. */
export async function loadStaleAvatars(userId: string, heygenKey: string): Promise<HeyGenAvatarList | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { heygenAvatarsCache: true, heygenAvatarsCachedAt: true },
  });
  if (!row) return null;
  return parseStale(row.heygenAvatarsCache, heygenKey, row.heygenAvatarsCachedAt?.getTime() ?? null, Date.now());
}
