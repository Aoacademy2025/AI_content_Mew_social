import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { extendVideoExpiryForPlan } from "@/lib/plan-helpers";
import { createNotification } from "@/lib/notifications";
import { usageWindowForPlan } from "@/lib/usage-limits";

export const TRIAL_DAYS_PUBLIC = 7;
export const TRIAL_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize + hash an email for the UsedTrialEmail guard (MON-5). Hashed (not stored raw)
 * so a DB dump doesn't leak addresses; normalized (trim+lowercase) so casing tricks can't
 * dodge the guard.
 */
export function hashTrialEmail(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/**
 * Grant a PRO trial of `days` — only if the user has NEVER trialed and isn't an active
 * subscriber. Atomic via a conditional updateMany (one trial per user, race-safe).
 *
 * Anti-farming (MON-5, 2026-07-07): trialStartedAt lives on the User row, which is
 * hard-deleted on account deletion (Clerk `user.deleted` webhook) — that alone would let
 * someone delete + re-register with the same email for an unlimited string of new trials.
 * UsedTrialEmail is a separate, User-independent table: checked BEFORE granting (blocks a
 * re-signup under a previously-used email even though the row is brand new) and written
 * right after a successful grant. It outlives the User row across delete/re-create.
 * Returns true if granted, false if skipped. Safe to call from both signup paths.
 */
export async function grantTrial(userId: string, days: number): Promise<boolean> {
  const now = new Date();
  const end = new Date(now.getTime() + days * DAY_MS);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return false;
  const emailHash = hashTrialEmail(user.email);

  const alreadyUsed = await prisma.usedTrialEmail.findUnique({ where: { emailHash } });
  if (alreadyUsed) return false;

  const res = await prisma.user.updateMany({
    where: {
      id: userId,
      trialStartedAt: null,                                   // never trialed
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }], // not an active subscriber (null-safe)
    },
    data: {
      plan: "PRO",
      planExpiresAt: end,
      trialStartedAt: now,
      trialEndsAt: end,
      ...usageWindowForPlan("PRO", now),
    },
  });
  if (res.count !== 1) return false;

  // Race-safe: unique constraint on emailHash — a concurrent grant for the same email
  // (e.g. the webhook + lazy-create both firing) loses this insert but already lost the
  // updateMany above (trialStartedAt no longer null), so no double-grant either way.
  await prisma.usedTrialEmail.create({ data: { emailHash } }).catch(() => {});

  await extendVideoExpiryForPlan(userId, "PRO").catch(() => {});
  return true;
}

/**
 * Revert every unconverted, past-due trial to FREE and notify with the annual-upgrade prompt.
 * This is the downgrade the app otherwise lacks; scoped to trial users (trialEndsAt set) only —
 * paying customers cleared trialEndsAt on conversion, so they're never touched. Returns the count.
 */
export async function revertExpiredTrials(): Promise<number> {
  const now = new Date();
  const due = await prisma.user.findMany({
    where: {
      trialEndsAt: { not: null, lte: now },
      OR: [{ subStatus: null }, { subStatus: { not: "active" } }],
    },
    select: { id: true },
  });
  let reverted = 0;
  for (const u of due) {
    const res = await prisma.user.updateMany({
      // re-guard mirrors the outer query (idempotent + closes the TOCTOU where a user pays mid-loop)
      where: { id: u.id, trialEndsAt: { not: null, lte: now }, OR: [{ subStatus: null }, { subStatus: { not: "active" } }] },
      data: { plan: "FREE", planExpiresAt: null, trialEndsAt: null, ...usageWindowForPlan("FREE", now) },
    });
    if (res.count !== 1) continue;
    reverted++;
    await createNotification({
      userId: u.id,
      type: "LIMIT_REACHED",
      title: "ทดลอง PRO หมดอายุแล้ว",
      body: "อัปเกรดเป็นรายปีเพื่อใช้ฟีเจอร์ PRO ต่อ — รับราคาพิเศษที่หน้าราคา",
    }).catch(() => {});
  }
  return reverted;
}

/** UI helper — derive the trial display state from a user row. */
export function trialStatus(user: { trialStartedAt: Date | null; trialEndsAt: Date | null }): {
  active: boolean; daysLeft: number; hasUsedTrial: boolean;
} {
  const now = Date.now();
  const active = !!user.trialEndsAt && user.trialEndsAt.getTime() > now;
  const daysLeft = active ? Math.ceil((user.trialEndsAt!.getTime() - now) / DAY_MS) : 0;
  return { active, daysLeft, hasUsedTrial: !!user.trialStartedAt };
}
