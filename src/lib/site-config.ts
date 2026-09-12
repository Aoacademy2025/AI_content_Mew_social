import { prisma } from "@/lib/prisma";

/**
 * Reads several SiteConfig rows in ONE query instead of one `findUnique` per
 * key (Task B2). No in-memory cache — admin edits via PATCH must be visible
 * on the very next GET, so every call hits the DB. No env-var fallback here;
 * that stays call-site-specific (see `resolveSettingValue` below) because the
 * fallback map differs per caller.
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

// Env-var fallback map for src/app/api/admin/settings/route.ts's 32 admin
// settings keys. Lives here (not in route.ts) because a Next.js route file
// may export ONLY route handlers/segment config — the build's `.next/types`
// route-shape check (stricter than plain `tsc`) rejects any other export,
// which is what broke CI when this used to live in route.ts.
//
// Pure — no DB access, no async, reads process.env fresh on every call
// (matters because route.ts's setConfig() patches process.env at runtime
// when an admin saves a new value, with no restart). Given a key and
// whatever getConfigs() resolved for it (`null` when the SiteConfig row
// doesn't exist), returns: the DB value when present (including an empty
// string — `dbValue != null` mirrors the original `if (row)` check), else
// the key's env-var fallback (7 of the 32 admin-settings keys have one),
// else "".
export function resolveSettingValue(key: string, dbValue: string | null): string {
  if (dbValue != null) return dbValue;
  const envMap: Record<string, string | undefined> = {
    support_email: process.env.SUPPORT_EMAIL,
    stripe_publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    stripe_secret_key: process.env.STRIPE_SECRET_KEY,
    stripe_webhook_secret: process.env.STRIPE_WEBHOOK_SECRET,
    stripe_price_pro: process.env.STRIPE_PRICE_PRO_MONTHLY,
    stripe_price_business: process.env.STRIPE_PRICE_BUSINESS_MONTHLY,
    server_gemini_key: process.env.LOANWORD_MINER_GEMINI_KEY,
  };
  return envMap[key] ?? "";
}
