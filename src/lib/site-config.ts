import { prisma } from "@/lib/prisma";

/**
 * Reads several SiteConfig rows in ONE query instead of one `findUnique` per
 * key (Task B2). No in-memory cache — admin edits via PATCH must be visible
 * on the very next GET, so every call hits the DB. No env-var fallback here;
 * that stays call-site-specific (e.g. src/app/api/admin/settings/route.ts's
 * `resolveSettingValue`) because the fallback map differs per caller.
 *
 * Missing keys resolve to `null`, never `undefined`, so callers can rely on
 * `key in result` always being true for every key they asked for.
 */
export async function getConfigs(
  keys: readonly string[]
): Promise<Record<string, string | null>> {
  const rows = await prisma.siteConfig.findMany({
    where: { key: { in: [...keys] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value] as const));
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    result[key] = byKey.get(key) ?? null;
  }
  return result;
}
