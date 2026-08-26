import "server-only";

import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notifications";
import { sendTrialReminderEmail } from "@/lib/send-email";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { countCompletedExports } from "@/lib/trial-expired-telemetry";
import { bangkokCalendarDaysBetween } from "@/lib/day21-convert-reminder";
import { isInternalNorthStarAccount } from "@/lib/subscription-north-star.server";
import { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import {
  decideTrialReminder,
  effectiveTrialEnd,
  trialReminderCopy,
  trialReminderKindFor,
  TRIAL_REMINDER_KINDS,
  type TrialReminderKind,
} from "@/lib/trial-reminders";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Whole feature is OFF unless explicitly enabled. */
export function trialRemindersEnabled(): boolean {
  return process.env.TRIAL_REMINDERS === "1";
}

/** Second, narrower switch: in-app notifications can run without touching email. */
export function trialReminderEmailEnabled(): boolean {
  return process.env.TRIAL_REMINDERS_EMAIL === "1";
}

/** Clips the customer can still open today — the number the day-5 copy quotes. */
async function countLiveClips(userId: string, now: Date): Promise<number> {
  return prisma.video.count({
    where: {
      userId,
      status: "COMPLETED",
      OR: [{ videoUrl: { not: null } }, { avatarVideoUrl: { not: null } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  });
}

export type TrialReminderRun = {
  checked: number;
  sent: number;
  byKind: Record<TrialReminderKind, number>;
};

function emptyRun(checked = 0): TrialReminderRun {
  return { checked, sent: 0, byKind: { d5: 0, expiry: 0, d3after: 0 } };
}

/**
 * Send every trial-lifecycle reminder that is due today. Idempotent: TrialReminderLog
 * has a unique (userId, kind), and the row is claimed BEFORE delivery, so a retried
 * run — or two workers racing — can never send the same nudge twice.
 */
export async function sendDueTrialReminders(now: Date = new Date()): Promise<TrialReminderRun> {
  // Widest offset is -3 days; +2 is the earliest. Pad by a day on each side so a
  // timezone boundary can never drop a candidate before the pure rule sees it.
  const windowStart = new Date(now.getTime() - 4 * DAY_MS);
  const windowEnd = new Date(now.getTime() + 3 * DAY_MS);

  const candidates = await prisma.user.findMany({
    where: {
      trialStartedAt: { not: null },
      OR: [
        { trialEndsAt: { gte: windowStart, lte: windowEnd } },
        { trialEndedAt: { gte: windowStart, lte: windowEnd } },
      ],
    },
    select: {
      id: true,
      email: true,
      role: true,
      suspended: true,
      trialStartedAt: true,
      trialEndsAt: true,
      trialEndedAt: true,
      trialReminderLogs: { select: { kind: true } },
    },
  });

  const run = emptyRun(candidates.length);
  const origin = (process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const minuteQuotaEnabled = process.env.MINUTE_QUOTA === "1";
  const emailEnabled = trialReminderEmailEnabled();

  for (const candidate of candidates) {
    const endAt = effectiveTrialEnd(candidate);
    if (!endAt) continue;

    // Cheap pre-filters that mirror decideTrialReminder, so the per-user entitlement
    // and clip queries below only run for a user who is genuinely in a window.
    // decideTrialReminder stays authoritative — it is re-applied with full evidence.
    const windowKind = trialReminderKindFor(bangkokCalendarDaysBetween(now, endAt));
    if (!windowKind) continue;
    if (candidate.suspended || isInternalNorthStarAccount(candidate)) continue;
    const alreadySentKinds = candidate.trialReminderLogs.map((log) => log.kind);
    if (alreadySentKinds.includes(windowKind)) continue;

    const [entitlement, exportsCount, liveClipCount] = await Promise.all([
      resolvePaidEquivalentEntitlement(candidate.id, now),
      countCompletedExports(candidate.id),
      windowKind === "d5" ? countLiveClips(candidate.id, now) : Promise.resolve(0),
    ]);

    const decision = decideTrialReminder({
      isInternal: isInternalNorthStarAccount(candidate),
      suspended: candidate.suspended,
      paidEquivalent: entitlement.canUsePaidFeatures,
      trialStartedAt: candidate.trialStartedAt,
      trialEndsAt: candidate.trialEndsAt,
      trialEndedAt: candidate.trialEndedAt,
      hasCompletedVideo: exportsCount > 0,
      alreadySentKinds,
      now,
    });
    if (!decision.send) continue;

    const { kind } = decision;
    // Claim the slot first. Losing this create means another run already delivered
    // (or is delivering) this nudge — skipping is the correct, fail-closed outcome.
    try {
      await prisma.trialReminderLog.create({ data: { userId: candidate.id, kind, sentAt: now } });
    } catch {
      continue;
    }

    const copy = trialReminderCopy(kind, { clipCount: liveClipCount, minuteQuotaEnabled });

    await createNotification({
      userId: candidate.id,
      type: copy.type,
      title: copy.title,
      body: copy.body,
      link: copy.link,
    }).catch(() => {});
    await recordTelemetryEvent(candidate.id, {
      name: "trial_reminder_sent",
      category: "product",
      source: "server",
      status: "done",
      properties: { kind, channel: "notification" },
    }).catch(() => {});

    if (emailEnabled && candidate.email) {
      const emailed = await sendTrialReminderEmail({
        to: candidate.email,
        subject: copy.emailSubject,
        title: copy.title,
        body: copy.body,
        pricingUrl: `${origin}${copy.link}`,
      }).catch(() => false);
      if (emailed) {
        await recordTelemetryEvent(candidate.id, {
          name: "trial_reminder_sent",
          category: "product",
          source: "server",
          status: "done",
          properties: { kind, channel: "email" },
        }).catch(() => {});
      }
    }

    run.sent += 1;
    run.byKind[kind] += 1;
  }

  return run;
}

export { TRIAL_REMINDER_KINDS };
