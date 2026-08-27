import "server-only";

import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const MAPC_WINDOW_DAYS = 30;
export const MAPC_IMAGE_SURFACES = ["hero_video", "automix", "scene_reroll"] as const;

export type NorthStarUserEvidence = {
  id: string;
  email: string;
  role: string;
  plan: string;
  suspended: boolean;
  stripeSubscriptionId: string | null;
  subStatus: string | null;
  billingPeriod: string | null;
  planExpiresAt: Date | null;
  bundleSubscriptionId: string | null;
  bundleStatus: string | null;
  bundleBillingPeriod: string | null;
  bundleAccessExpiresAt: Date | null;
  bundleAmountThb: number | null;
  payments: readonly { plan: string; status: string; amount: number; periodDays: number; note: string | null }[];
};

export type NorthStarOutcomeEvidence = {
  videoUserIds: readonly string[];
  scriptUserIds: readonly string[];
  imageUserIds: readonly string[];
};

export type SubscriptionNorthStar = {
  metric: "MAPC";
  label: "Monthly Active Paying Creators";
  asOf: string;
  window: { days: 30; since: string; until: string };
  activeRecurringPayers: number;
  activePayingCustomers: number;
  activeCreators: number;
  creatorRatePct: number;
  monthlyCreators: number;
  annualCreators: number;
  outcomes: { videoCreators: number; scriptCreators: number; imageCreators: number };
  formula: string;
  exclusions: string[];
};

type BillingCohort = "monthly" | "annual";

function exactEmailDomain(email: string): string {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  return separator > 0 ? normalized.slice(separator + 1) : "";
}

export function isInternalNorthStarAccount(user: Pick<NorthStarUserEvidence, "email" | "role">): boolean {
  return user.role === "ADMIN"
    || user.email.trim().toLowerCase() === "duckyhero@gmail.com"
    || exactEmailDomain(user.email) === "aoacademy.co";
}

/**
 * A recurring payer needs a currently-active recurring relationship and cash
 * evidence. A PRO/BUSINESS label, Trial, coupon, or Administrator Grant alone
 * can never enter the North Star denominator.
 */
export function recurringBillingCohort(
  user: NorthStarUserEvidence,
  now: Date,
): BillingCohort | null {
  if (user.suspended || isInternalNorthStarAccount(user)) return null;

  const hasQualifyingCashPayment = user.payments.some((payment) =>
    payment.status === "PAID"
      && payment.amount > 0
      && payment.periodDays > 0
      && payment.note !== "credits"
      && (payment.plan === "PRO" || payment.plan === "BUSINESS"),
  );
  const directRecurring = Boolean(
    hasQualifyingCashPayment
      && user.stripeSubscriptionId
      && user.subStatus === "active"
      && user.planExpiresAt
      && user.planExpiresAt > now,
  );
  const bundleRecurring = Boolean(
    user.bundleSubscriptionId
      && user.bundleStatus === "ACTIVE"
      && user.bundleAccessExpiresAt
      && user.bundleAccessExpiresAt > now
      && (user.bundleAmountThb ?? 0) > 0,
  );
  if (!directRecurring && !bundleRecurring) return null;

  const activePeriods = [
    directRecurring ? user.billingPeriod : null,
    bundleRecurring ? user.bundleBillingPeriod : null,
  ].filter((period): period is string => Boolean(period));
  return activePeriods.length > 0 && activePeriods.every((period) => period === "annual")
    ? "annual"
    : "monthly";
}

/**
 * MAPC follows customer value, not payment mechanics. A customer who paid for
 * an annual term up front is still a paying customer for the life of that term,
 * even though Stripe will not auto-bill them next month.
 */
export function activePayingBillingCohort(
  user: NorthStarUserEvidence,
  now: Date,
): BillingCohort | null {
  if (user.suspended || isInternalNorthStarAccount(user)) return null;
  const hasPlanCash = user.payments.some((payment) =>
    payment.status === "PAID"
      && payment.amount > 0
      && payment.periodDays > 0
      && payment.note !== "credits"
      && (payment.plan === "PRO" || payment.plan === "BUSINESS"),
  );
  const hasActiveDirectAccess = Boolean(
    hasPlanCash
      && (user.plan === "PRO" || user.plan === "BUSINESS")
      && (
        (user.planExpiresAt && user.planExpiresAt > now)
        || (user.stripeSubscriptionId && user.subStatus === "active")
        || (!user.planExpiresAt && !user.stripeSubscriptionId)
      ),
  );
  const hasActiveBundleAccess = Boolean(
    user.bundleSubscriptionId
      && user.bundleStatus === "ACTIVE"
      && user.bundleAccessExpiresAt
      && user.bundleAccessExpiresAt > now
      && (user.bundleAmountThb ?? 0) > 0,
  );
  if (!hasActiveDirectAccess && !hasActiveBundleAccess) return null;

  const periods = [
    hasActiveDirectAccess ? user.billingPeriod : null,
    hasActiveBundleAccess ? user.bundleBillingPeriod : null,
  ].filter((period): period is string => Boolean(period));
  return periods.length > 0 && periods.every((period) => period === "annual") ? "annual" : "monthly";
}

export function computeSubscriptionNorthStar(input: {
  users: readonly NorthStarUserEvidence[];
  outcomes: NorthStarOutcomeEvidence;
  now?: Date;
}): SubscriptionNorthStar {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - MAPC_WINDOW_DAYS * DAY_MS);
  const billingByUser = new Map<string, BillingCohort>();
  for (const user of input.users) {
    const cohort = activePayingBillingCohort(user, now);
    if (cohort) billingByUser.set(user.id, cohort);
  }
  const activeRecurringPayers = input.users.filter((user) => recurringBillingCohort(user, now)).length;

  const payerIds = new Set(billingByUser.keys());
  const videos = new Set(input.outcomes.videoUserIds.filter((id) => payerIds.has(id)));
  const scripts = new Set(input.outcomes.scriptUserIds.filter((id) => payerIds.has(id)));
  const images = new Set(input.outcomes.imageUserIds.filter((id) => payerIds.has(id)));
  const creators = new Set([...videos, ...scripts, ...images]);
  let monthlyCreators = 0;
  let annualCreators = 0;
  for (const id of creators) {
    if (billingByUser.get(id) === "annual") annualCreators += 1;
    else monthlyCreators += 1;
  }

  return {
    metric: "MAPC",
    label: "Monthly Active Paying Creators",
    asOf: now.toISOString(),
    window: { days: MAPC_WINDOW_DAYS, since: since.toISOString(), until: now.toISOString() },
    activeRecurringPayers,
    activePayingCustomers: payerIds.size,
    activeCreators: creators.size,
    creatorRatePct: payerIds.size > 0 ? Math.round((creators.size / payerIds.size) * 100) : 0,
    monthlyCreators,
    annualCreators,
    outcomes: { videoCreators: videos.size, scriptCreators: scripts.size, imageCreators: images.size },
    formula: "ลูกค้าจ่ายเงินจริงที่ยังมีสิทธิ์ และสร้างผลลัพธ์สำเร็จอย่างน้อย 1 อย่างใน 30 วันที่ผ่านมา",
    exclusions: [
      "บัญชีทีมงานและ Administrator",
      "FREE, Trial, คูปอง และสิทธิ์ Administrator Grant ที่ไม่มีเงินเข้า",
      "การเปิดดู พรีวิว งานล้มเหลว งานยกเลิก และการ retry",
    ],
  };
}

export async function getSubscriptionNorthStar(now: Date = new Date()): Promise<SubscriptionNorthStar> {
  const since = new Date(now.getTime() - MAPC_WINDOW_DAYS * DAY_MS);
  const users = await prisma.user.findMany({
    where: {
      suspended: false,
      OR: [
        { payments: { some: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } } } },
        { bundleSubscriptionId: { not: null }, bundleStatus: "ACTIVE", bundleAccessExpiresAt: { gt: now }, bundleAmountThb: { gt: 0 } },
      ],
    },
    select: {
      id: true, email: true, role: true, plan: true, suspended: true,
      stripeSubscriptionId: true, subStatus: true, billingPeriod: true, planExpiresAt: true,
      bundleSubscriptionId: true, bundleStatus: true, bundleBillingPeriod: true,
      bundleAccessExpiresAt: true, bundleAmountThb: true,
      payments: {
        where: { status: "PAID", amount: { gt: 0 }, periodDays: { gt: 0 } },
        select: { plan: true, status: true, amount: true, periodDays: true, note: true },
      },
    },
  });
  const payerIds = users.filter((user) => activePayingBillingCohort(user, now)).map((user) => user.id);
  if (payerIds.length === 0) {
    return computeSubscriptionNorthStar({ users, outcomes: { videoUserIds: [], scriptUserIds: [], imageUserIds: [] }, now });
  }

  const [videoRows, scriptRows, imageRows] = await Promise.all([
    prisma.video.findMany({
      where: {
        userId: { in: payerIds }, status: "COMPLETED", updatedAt: { gte: since },
        OR: [{ videoUrl: { not: null } }, { avatarVideoUrl: { not: null } }],
      },
      select: { userId: true, videoUrl: true, avatarVideoUrl: true },
      distinct: ["userId"],
    }),
    prisma.script.findMany({
      where: { userId: { in: payerIds }, createdAt: { gte: since } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.aiGenerationJob.findMany({
      where: {
        userId: { in: payerIds }, kind: "image", status: "completed", chargeState: "settled",
        outputUrl: { not: null }, productSurface: { in: [...MAPC_IMAGE_SURFACES] },
        OR: [{ finishedAt: { gte: since } }, { finishedAt: null, updatedAt: { gte: since } }],
      },
      select: { userId: true, outputUrl: true },
      distinct: ["userId"],
    }),
  ]);

  return computeSubscriptionNorthStar({
    users,
    outcomes: {
      videoUserIds: videoRows.filter((row) => Boolean(row.videoUrl?.trim() || row.avatarVideoUrl?.trim())).map((row) => row.userId),
      scriptUserIds: scriptRows.map((row) => row.userId),
      imageUserIds: imageRows.filter((row) => Boolean(row.outputUrl?.trim())).map((row) => row.userId),
    },
    now,
  });
}

export function bangkokSnapshotDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function writeSubscriptionNorthStarSnapshot(now: Date = new Date()) {
  const northStar = await getSubscriptionNorthStar(now);
  const snapshotDate = bangkokSnapshotDate(now);
  const data = {
    asOf: now,
    activeRecurringPayers: northStar.activeRecurringPayers,
    activePayingCustomers: northStar.activePayingCustomers,
    activeCreators: northStar.activeCreators,
    monthlyCreators: northStar.monthlyCreators,
    annualCreators: northStar.annualCreators,
    videoCreators: northStar.outcomes.videoCreators,
    scriptCreators: northStar.outcomes.scriptCreators,
    imageCreators: northStar.outcomes.imageCreators,
  };
  await prisma.northStarDailySnapshot.upsert({
    where: { snapshotDate },
    create: { snapshotDate, ...data },
    update: data,
  });
  return { snapshotDate, ...northStar };
}
