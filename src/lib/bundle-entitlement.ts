import { prisma } from "@/lib/prisma";
import { resetMonthlyGranted } from "@/lib/credits";
import { limitsForPlan, minutesPerMonthForPlan } from "@/lib/plan-limits";

export type BundleEntitlementAction =
  | {
      action: "grant";
      email: string;
      grantId: string;
      eventId: string;
      subscriptionId: string | null;
      expiresAt: Date;
      occurredAt: Date;
      billingPeriod: "monthly" | "annual";
      amountThb: number;
    }
  | {
      action: "revoke";
      email: string;
      eventId: string;
      subscriptionId: string | null;
      occurredAt: Date;
      reason: string;
    };

export function normalizeBundleEmail(email: string): string {
  return email.trim().toLowerCase();
}

function freshUsageWindow(plan: string, from: Date) {
  const clips = limitsForPlan(plan).clips;
  return {
    usageCount: 0,
    usageLimit: Number.isFinite(clips) ? Number(clips) : 100,
    usagePeriodStartedAt: from,
    minutesUsed: 0,
    minutesLimit: minutesPerMonthForPlan(plan),
    aiAudioMinutesUsed: 0,
    aiTextCallsUsed: 0,
  };
}

/** Persist an absolute source state. Event time prevents stale retries from regressing it. */
export async function recordBundleEntitlement(input: BundleEntitlementAction) {
  const email = normalizeBundleEmail(input.email);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.bundleEntitlement.findUnique({ where: { email } });
    if (existing?.lastEventId === input.eventId) {
      return { entitlement: existing, duplicate: true, stale: false };
    }
    if (existing && existing.eventOccurredAt > input.occurredAt) {
      return { entitlement: existing, duplicate: false, stale: true };
    }

    const accessEndsAt = input.action === "grant" ? input.expiresAt : input.occurredAt;
    const entitlement = await tx.bundleEntitlement.upsert({
      where: { email },
      create: {
        email,
        grantId: input.action === "grant" ? input.grantId : `revoked:${input.eventId}`,
        subscriptionId: input.subscriptionId,
        status: input.action === "grant" ? "ACTIVE" : "REVOKED",
        accessEndsAt,
        billingPeriod: input.action === "grant" ? input.billingPeriod : null,
        amountThb: input.action === "grant" ? input.amountThb : null,
        lastEventId: input.eventId,
        eventOccurredAt: input.occurredAt,
      },
      update: {
        ...(input.action === "grant" ? { grantId: input.grantId } : {}),
        subscriptionId: input.subscriptionId ?? existing?.subscriptionId ?? null,
        status: input.action === "grant" ? "ACTIVE" : "REVOKED",
        accessEndsAt,
        ...(input.action === "grant"
          ? { billingPeriod: input.billingPeriod, amountThb: input.amountThb }
          : {}),
        lastEventId: input.eventId,
        eventOccurredAt: input.occurredAt,
      },
    });
    return { entitlement, duplicate: false, stale: false };
  });
}

function independentlyPaid(user: {
  plan: string;
  subStatus: string | null;
  trialEndsAt: Date | null;
  planExpiresAt: Date | null;
  bundlePrimary: boolean;
}, now: Date): boolean {
  if (user.subStatus === "active") return true;
  if (user.planExpiresAt && user.planExpiresAt > now) return true;
  return user.plan !== "FREE" && !user.bundlePrimary && !user.trialEndsAt && !user.planExpiresAt;
}

/** Copy the latest email-backed Bundle state onto a Studio user exactly once per event. */
export async function syncStoredBundleEntitlementForUser(
  userId: string,
  now: Date = new Date(),
  options: { forcePrimary?: boolean } = {},
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      plan: true,
      subStatus: true,
      trialEndsAt: true,
      planExpiresAt: true,
      bundlePrimary: true,
      bundleLastEventId: true,
      bundleQuotaGrantId: true,
      bundleCreditsGrantId: true,
    },
  });
  if (!user) return { changed: false, activated: false };

  const entitlement = await prisma.bundleEntitlement.findUnique({
    where: { email: normalizeBundleEmail(user.email) },
  });
  if (!entitlement) {
    return { changed: false, activated: false };
  }

  const active = entitlement.status === "ACTIVE" && entitlement.accessEndsAt > now;
  const replaceLegacyManualTerm = Boolean(options.forcePrimary && user.subStatus !== "active");
  const primary = user.bundlePrimary || replaceLegacyManualTerm || !independentlyPaid(user, now);
  if (entitlement.lastEventId === user.bundleLastEventId) {
    let changed = false;
    if (active && replaceLegacyManualTerm && !user.bundlePrimary) {
      await prisma.user.update({
        where: { id: user.id },
        data: { bundlePrimary: true, planExpiresAt: null },
      });
      changed = true;
    }
    if (active && primary && user.bundleQuotaGrantId !== entitlement.grantId) {
      const plan = user.plan === "BUSINESS" ? "BUSINESS" : "PRO";
      await prisma.user.update({
        where: { id: user.id },
        data: { ...freshUsageWindow(plan, now), bundleQuotaGrantId: entitlement.grantId },
      });
      changed = true;
    }
    if (active && primary && user.bundleCreditsGrantId !== entitlement.grantId) {
      if (process.env.CREDITS_LIVE === "1") {
        await resetMonthlyGranted(user.id, user.plan === "BUSINESS" ? "BUSINESS" : "PRO");
        await prisma.user.update({
          where: { id: user.id },
          data: { bundleCreditsGrantId: entitlement.grantId },
        });
        changed = true;
      }
    }
    return { changed, activated: active };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      bundleGrantId: entitlement.grantId,
      bundleSubscriptionId: entitlement.subscriptionId,
      bundleAccessExpiresAt: entitlement.accessEndsAt,
      bundleStatus: entitlement.status,
      bundleBillingPeriod: entitlement.billingPeriod,
      bundleAmountThb: entitlement.amountThb,
      bundleLastEventId: entitlement.lastEventId,
      bundlePrimary: active ? primary : user.bundlePrimary,
      ...(active && replaceLegacyManualTerm ? { planExpiresAt: null } : {}),
      ...(active && primary ? { bundleQuotaGrantId: entitlement.grantId } : {}),
      ...(active
        ? {
            plan: user.plan === "BUSINESS" ? "BUSINESS" : "PRO",
            ...(primary ? freshUsageWindow(user.plan === "BUSINESS" ? "BUSINESS" : "PRO", now) : {}),
          }
        : {}),
    },
  });

  if (active && primary && process.env.CREDITS_LIVE === "1") {
    await resetMonthlyGranted(user.id, user.plan === "BUSINESS" ? "BUSINESS" : "PRO");
    await prisma.user.update({
      where: { id: user.id },
      data: { bundleCreditsGrantId: entitlement.grantId },
    });
  }
  return { changed: true, activated: active };
}
