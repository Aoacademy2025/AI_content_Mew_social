import "server-only";

import { prisma } from "@/lib/prisma";

// hero-image-rate-limit.ts — public-launch abuse caps for Hero AI Image.
//
// Counts usage straight from AiGenerationJob rows (kind="image") instead of a
// new table, so the cap works across every PM2 cluster instance with no extra
// state to keep consistent. EVERY chargeState counts — including refunded and
// failed attempts — because a refunded/failed generation still consumed a real
// RunPod provider slot; only the credit charge was undone, not the capacity.
//
// Semantics (deliberate — "never block one real clip, block loops"):
//   HOURLY (soft) gates whether a NEW batch may START: a fresh user (0 used this
//   hour) may still start one large batch that overshoots the cap mid-batch — a
//   single Hero clip can plan up to 60 images via targetClipCount — the hourly
//   ceiling exists to stop repeated batches, not to cap one real render.
//   DAILY (hard): the whole planned batch must fit inside the remaining daily
//   budget or it is rejected outright (no partial admit, no silent truncation).

/** Soft hourly ceiling — see module doc. */
export const HERO_IMAGE_HOURLY_CAP = 20;
/** Hard daily ceiling — see module doc. */
export const HERO_IMAGE_DAILY_CAP = 120;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type HeroImageRateCheck =
  | { ok: true }
  | { ok: false; scope: "hour" | "day"; usedHour: number; usedDay: number; retryAfterSec: number };

/**
 * Enforce the Hero AI Image rate caps for `userId` against a batch that would
 * generate `plannedImages` more images. Must be called BEFORE any credit
 * reservation on every Hero entry point (fetch-stock hero mode, fetch-stock
 * AutoMix AI slots, broll-window/generate).
 *
 * ADMIN bypass: team ops routinely batch-test/backfill and must never trip the
 * customer-abuse ceiling, so every call site should skip calling this entirely
 * when `actor.role === "ADMIN"`. `opts.isAdmin` is provided as a same-function
 * escape hatch (used by callers that already have the role in scope, and by the
 * verify script so the bypass is exercised against the exact function every
 * route calls) — passing it short-circuits straight to `{ ok: true }` without
 * touching the database.
 */
export async function checkHeroImageRate(
  userId: string,
  plannedImages: number,
  opts?: { isAdmin?: boolean },
): Promise<HeroImageRateCheck> {
  if (opts?.isAdmin) return { ok: true };

  const now = Date.now();
  const dayCutoff = new Date(now - DAY_MS);
  const rows = await prisma.aiGenerationJob.findMany({
    where: { userId, kind: "image", createdAt: { gte: dayCutoff } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const hourCutoffMs = now - HOUR_MS;
  const hourRows = rows.filter((row) => row.createdAt.getTime() >= hourCutoffMs);
  const usedHour = hourRows.length;
  const usedDay = rows.length;

  // HOURLY (soft): only blocks STARTING a new batch once the trailing-hour count
  // has already reached the cap. Never blocks a single in-flight/large batch
  // from proceeding, even when its planned count would push the running total
  // past the cap mid-batch.
  if (usedHour >= HERO_IMAGE_HOURLY_CAP) {
    const oldest = hourRows[0]?.createdAt.getTime() ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
    return { ok: false, scope: "hour", usedHour, usedDay, retryAfterSec };
  }

  // DAILY (hard): the whole planned batch must fit inside the remaining budget.
  if (usedDay + plannedImages > HERO_IMAGE_DAILY_CAP) {
    const oldest = rows[0]?.createdAt.getTime() ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000));
    return { ok: false, scope: "day", usedHour, usedDay, retryAfterSec };
  }

  return { ok: true };
}

/** Thai rate-limit message shared by every Hero entry point, so the three
 *  routes can never drift on copy. */
export function heroImageRateLimitMessage(check: Extract<HeroImageRateCheck, { ok: false }>): string {
  const scopeLabel = check.scope === "hour" ? "ต่อชั่วโมง" : "ต่อวัน";
  return `Hero AI Image ใช้ครบโควต้า${scopeLabel}แล้ว ลองใหม่ได้ในอีก ~${check.retryAfterSec} วินาที`;
}
