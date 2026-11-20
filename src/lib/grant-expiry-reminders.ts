import { bangkokCalendarDaysBetween } from "@/lib/day21-convert-reminder";
import { isCashBackedRenewalTerm } from "@/lib/renewal-reminders";

const DAY_MS = 24 * 60 * 60 * 1_000;
const INTERNAL_OWNER_EMAIL = "duckyhero@gmail.com";
const INTERNAL_EMAIL_DOMAIN = "aoacademy.co";

export const GRANT_EXPIRY_REMINDER_KINDS = ["d7", "d3", "d1"] as const;
export type GrantExpiryReminderKind = typeof GRANT_EXPIRY_REMINDER_KINDS[number];
export type GrantPaidPlan = "PRO" | "BUSINESS";

export const GRANT_BANNER_MAX_DAYS = 14;
export const GRANT_BANNER_LINK = "/pricing?source=grant_banner";

const KIND_BY_DAYS: Readonly<Record<number, GrantExpiryReminderKind>> = {
  7: "d7",
  3: "d3",
  1: "d1",
};

export type GrantExpiryKindDecision =
  | { send: true; kind: GrantExpiryReminderKind }
  | { send: false; reason: "not_due" };

export function grantExpiryReminderDecision(daysLeft: number): GrantExpiryKindDecision {
  const kind = KIND_BY_DAYS[daysLeft];
  return kind ? { send: true, kind } : { send: false, reason: "not_due" };
}

export function grantExpiryReminderLink(kind: GrantExpiryReminderKind): string {
  return `/pricing?source=grant_expiry_${kind}`;
}

export function grantBannerCopy(plan: GrantPaidPlan, daysLeft: number): string {
  const safeDays = Math.max(1, Math.trunc(daysLeft));
  return `สิทธิ์คูปองเรียน ${plan} ของคุณจะหมดในอีก ${safeDays} วัน — ต่อสิทธิ์ต่อเนื่องเพื่อเก็บโปรเจกต์และแบรนด์ทั้งหมดไว้ใช้งานต่อ`;
}

export function isInternalGrantAccount(user: {
  role: string;
  email: string | null;
}): boolean {
  if (user.role === "ADMIN") return true;
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) return false;
  if (email === INTERNAL_OWNER_EMAIL) return true;
  const at = email.lastIndexOf("@");
  return at >= 0 && email.slice(at + 1) === INTERNAL_EMAIL_DOMAIN;
}

function isGrantPaidPlan(value: string | null | undefined): value is GrantPaidPlan {
  return value === "PRO" || value === "BUSINESS";
}

function planRank(plan: GrantPaidPlan): number {
  return plan === "BUSINESS" ? 2 : 1;
}

export type GrantRedemptionEvidence = {
  id: string;
  outcome: string;
  redeemedAt: Date;
  entitlementPlan: string | null;
  entitlementStartsAt: Date | null;
  entitlementExpiresAt: Date | null;
  coupon: {
    type: string;
    plan: string;
    durationDays: number;
  };
};

export type GrantCashPaymentEvidence = {
  plan: string;
  status: string;
  amount: number;
  periodDays: number;
  note: string | null;
  paidAt: Date | null;
  createdAt: Date;
};

export type GrantAdminEntitlementEvidence = {
  plan: string;
  startsAt: Date;
  expiresAt: Date | null;
  permanent: boolean;
  revokedAt: Date | null;
};

export type GrantEligibilityInput = {
  user: {
    role: string;
    email: string | null;
    plan: string;
    suspended: boolean;
    planExpiresAt: Date | null;
    stripeSubscriptionId: string | null;
    subStatus: string | null;
    cancelAtPeriodEnd: boolean;
    bundleStatus: string | null;
    bundleAccessExpiresAt: Date | null;
  };
  couponRedemptions: readonly GrantRedemptionEvidence[];
  payments: readonly GrantCashPaymentEvidence[];
  administratorGrants?: readonly GrantAdminEntitlementEvidence[];
  externalBundleExpiresAt?: Date | null;
};

export type GrantEligibilitySkipReason =
  | "suspended"
  | "internal"
  | "no_active_grant"
  | "permanent_grant"
  | "active_subscription"
  | "cash_term_extends_past_grant"
  | "admin_grant_extends_past_grant"
  | "active_bundle";

export type GrantEligibilityDecision =
  | {
      eligible: true;
      couponRedemptionId: string;
      plan: GrantPaidPlan;
      maxGrantExpiresAt: Date;
      daysLeft: number;
    }
  | {
      eligible: false;
      reason: GrantEligibilitySkipReason;
    };

type NormalizedTimedGrant = {
  id: string;
  plan: GrantPaidPlan;
  startsAt: Date;
  expiresAt: Date;
  redeemedAt: Date;
};

/**
 * Evaluate whether a user currently holds an unpaid GRANT coupon entitlement
 * without any recurring subscription, later cash term, later admin grant, or
 * active Hero AI Bundle covering past `maxGrantExpiresAt`.
 *
 * Stacked GRANT coupons resolve to `maxGrantExpiresAt` so an earlier grant
 * never warns prematurely when a later grant already extends access.
 */
export function resolveGrantExpiryEligibility(
  input: GrantEligibilityInput,
  now: Date = new Date(),
): GrantEligibilityDecision {
  const { user } = input;
  if (user.suspended) return { eligible: false, reason: "suspended" };
  if (isInternalGrantAccount(user)) return { eligible: false, reason: "internal" };

  const timedGrants: NormalizedTimedGrant[] = [];
  let hasPermanentGrant = false;

  for (const redemption of input.couponRedemptions) {
    if (redemption.coupon.type !== "GRANT") continue;
    const legacy = redemption.outcome === "LEGACY";
    if (!legacy && redemption.outcome === "PROMO_ONLY") continue;

    const resolvedPlan = legacy
      ? redemption.coupon.plan
      : (redemption.entitlementPlan ?? redemption.coupon.plan);
    if (!isGrantPaidPlan(resolvedPlan)) continue;

    const startsAt = legacy
      ? redemption.redeemedAt
      : (redemption.entitlementStartsAt ?? redemption.redeemedAt);

    if (
      redemption.coupon.durationDays === 0
      || (!legacy && redemption.entitlementExpiresAt === null && redemption.coupon.durationDays <= 0)
    ) {
      hasPermanentGrant = true;
      continue;
    }

    const expiresAt = redemption.entitlementExpiresAt
      ?? (legacy && redemption.coupon.durationDays > 0
        ? new Date(redemption.redeemedAt.getTime() + redemption.coupon.durationDays * DAY_MS)
        : null);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) continue;

    timedGrants.push({
      id: redemption.id,
      plan: resolvedPlan,
      startsAt,
      expiresAt,
      redeemedAt: redemption.redeemedAt,
    });
  }

  if (hasPermanentGrant) {
    return { eligible: false, reason: "permanent_grant" };
  }

  const activeNow = timedGrants.filter(
    (grant) => grant.startsAt.getTime() <= now.getTime() && grant.expiresAt.getTime() > now.getTime(),
  );
  if (activeNow.length === 0) {
    return { eligible: false, reason: "no_active_grant" };
  }

  // Pick the latest un-expired GRANT redemption (`maxGrantExpiresAt`) across
  // stacked grants so we never warn on an earlier grant while another active/
  // scheduled grant already extends entitlement further.
  const latestGrant = [...timedGrants].sort((left, right) =>
    right.expiresAt.getTime() - left.expiresAt.getTime()
    || planRank(right.plan) - planRank(left.plan)
    || right.redeemedAt.getTime() - left.redeemedAt.getTime()
    || left.id.localeCompare(right.id)
  )[0]!;

  // Effective plan during the grant horizon: keep the highest active/stacked grant tier.
  const effectivePlan: GrantPaidPlan = timedGrants.some((g) => g.plan === "BUSINESS")
    ? "BUSINESS"
    : latestGrant.plan;
  const maxGrantExpiresAt = latestGrant.expiresAt;

  // ── Strict Suppression Guard 1: Active auto-renewing Stripe subscription ──
  if (
    user.stripeSubscriptionId
    && (user.subStatus === "active" || user.subStatus === "trialing")
    && !user.cancelAtPeriodEnd
  ) {
    return { eligible: false, reason: "active_subscription" };
  }

  // ── Strict Suppression Guard 2: Cash-backed paid term past maxGrantExpiresAt ──
  const paidPlanPayments = input.payments.filter(
    (payment) =>
      payment.status === "PAID"
      && payment.amount > 0
      && payment.periodDays > 0
      && payment.note?.trim().toLowerCase() !== "credits"
      && isGrantPaidPlan(payment.plan),
  );
  const directCashExtendsPastGrant = paidPlanPayments.some((payment) => {
    const paidStart = (payment.paidAt ?? payment.createdAt).getTime();
    return paidStart + payment.periodDays * DAY_MS > maxGrantExpiresAt.getTime();
  });
  const storedCashTermExtendsPastGrant = Boolean(
    user.planExpiresAt
    && user.planExpiresAt.getTime() > maxGrantExpiresAt.getTime()
    && isCashBackedRenewalTerm({
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
      stripeSubscriptionId: null,
      payments: paidPlanPayments,
    }),
  );
  if (directCashExtendsPastGrant || storedCashTermExtendsPastGrant) {
    return { eligible: false, reason: "cash_term_extends_past_grant" };
  }

  // ── Strict Suppression Guard 3: AdministratorGrant past maxGrantExpiresAt ──
  const adminGrants = input.administratorGrants ?? [];
  const adminGrantExtendsPastGrant = adminGrants.some((grant) => {
    if (grant.revokedAt !== null || !isGrantPaidPlan(grant.plan)) return false;
    if (grant.startsAt.getTime() > maxGrantExpiresAt.getTime()) return false;
    if (grant.permanent || grant.expiresAt === null) return true;
    return grant.expiresAt.getTime() > maxGrantExpiresAt.getTime();
  });
  if (adminGrantExtendsPastGrant) {
    return { eligible: false, reason: "admin_grant_extends_past_grant" };
  }

  // ── Strict Suppression Guard 4: Active Hero AI Bundle past maxGrantExpiresAt ──
  const userBundleActivePastGrant = Boolean(
    user.bundleStatus === "ACTIVE"
    && user.bundleAccessExpiresAt
    && user.bundleAccessExpiresAt.getTime() > maxGrantExpiresAt.getTime(),
  );
  const externalBundleActivePastGrant = Boolean(
    input.externalBundleExpiresAt
    && input.externalBundleExpiresAt.getTime() > maxGrantExpiresAt.getTime(),
  );
  if (userBundleActivePastGrant || externalBundleActivePastGrant) {
    return { eligible: false, reason: "active_bundle" };
  }

  const daysLeft = bangkokCalendarDaysBetween(now, maxGrantExpiresAt);
  return {
    eligible: true,
    couponRedemptionId: latestGrant.id,
    plan: effectivePlan,
    maxGrantExpiresAt,
    daysLeft,
  };
}

export type ExpiringGrantBannerInfo = {
  plan: GrantPaidPlan;
  expiresAt: string;
  daysLeft: number;
  copy: string;
  href: string;
  /** True when the user has zero historical PAID plan/credit-period rows (matches checkout/route.ts). */
  canConvertCardImmediately: boolean;
};

export function resolveExpiringGrantBanner(
  input: GrantEligibilityInput,
  now: Date = new Date(),
): ExpiringGrantBannerInfo | null {
  const decision = resolveGrantExpiryEligibility(input, now);
  if (!decision.eligible) return null;
  if (decision.maxGrantExpiresAt.getTime() <= now.getTime()) return null;
  if (decision.daysLeft < 0 || decision.daysLeft > GRANT_BANNER_MAX_DAYS) return null;

  const displayDaysLeft = Math.max(1, decision.daysLeft);
  const hasAnyPaidPeriodRow = input.payments.some(
    (payment) => payment.status === "PAID" && payment.amount > 0 && payment.periodDays > 0,
  );
  return {
    plan: decision.plan,
    expiresAt: decision.maxGrantExpiresAt.toISOString(),
    daysLeft: displayDaysLeft,
    copy: grantBannerCopy(decision.plan, displayDaysLeft),
    href: GRANT_BANNER_LINK,
    canConvertCardImmediately: !hasAnyPaidPeriodRow,
  };
}

export type GrantCreatorAssetCounts = {
  brandProfiles: number;
  editorProjects: number;
  videos: number;
};

export function formatGrantCreatorAssetsSummary(assets?: GrantCreatorAssetCounts): string | null {
  if (!assets) return null;
  const parts: string[] = [];
  if (assets.brandProfiles > 0) parts.push(`Brand Profile ${assets.brandProfiles} แบรนด์`);
  if (assets.editorProjects > 0) parts.push(`โปรเจกต์ตัดต่อ ${assets.editorProjects} โปรเจกต์`);
  if (assets.videos > 0) parts.push(`คลิปที่สร้างไว้ ${assets.videos} คลิป`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function grantExpiryReminderCopy(input: {
  kind: GrantExpiryReminderKind;
  plan: GrantPaidPlan;
  assets?: GrantCreatorAssetCounts;
}): {
  daysLeft: number;
  subject: string;
  title: string;
  body: string;
  assetsSummary: string | null;
  cta: string;
  link: string;
} {
  const daysLeft = Number(input.kind.slice(1));
  const assetsSummary = formatGrantCreatorAssetsSummary(input.assets);
  const link = grantExpiryReminderLink(input.kind);

  const title = daysLeft === 1
    ? `พรุ่งนี้วันสุดท้าย — สิทธิ์คูปองเรียน ${input.plan} เหลือ 1 วัน`
    : `สิทธิ์คูปองเรียน ${input.plan} เหลืออีก ${daysLeft} วัน`;

  const subject = daysLeft === 1
    ? `เหลือ 1 วันสุดท้าย · ต่อสิทธิ์คูปองเรียน ${input.plan} เพื่อใช้งานต่อเนื่อง`
    : `สิทธิ์คูปองเรียน ${input.plan} เหลืออีก ${daysLeft} วัน — เก็บโปรเจกต์และแบรนด์ไว้ทำคลิปต่อ`;

  const body = assetsSummary
    ? `คุณมี ${assetsSummary} ที่บันทึกไว้ในสตูดิโอแล้ว — ต่อสิทธิ์ต่อเนื่องก่อนคูปองเรียน ${input.plan} หมดในอีก ${daysLeft} วัน เพื่อเก็บโปรเจกต์และแบรนด์ทั้งหมดไว้ทำคลิปต่อได้ไม่สะดุด`
    : `สิทธิ์คูปองเรียน ${input.plan} ของคุณจะหมดในอีก ${daysLeft} วัน — ต่อสิทธิ์ต่อเนื่องเพื่อเก็บโปรเจกต์ ตั้งค่าแบรนด์ และทำคลิปต่อได้ไม่สะดุด`;

  return {
    daysLeft,
    subject,
    title,
    body,
    assetsSummary,
    cta: "ต่อสิทธิ์ใช้งานต่อเนื่อง",
    link,
  };
}

export type GrantDeliveryState = {
  notificationDelivered: boolean;
  emailAttempted: boolean;
  emailDelivered: boolean;
};

export type GrantDeliveryStatus = "DELIVERED" | "PARTIAL" | "FAILED";

export function grantDeliveryStatus(state: GrantDeliveryState): GrantDeliveryStatus {
  if (state.notificationDelivered && (!state.emailAttempted || state.emailDelivered)) return "DELIVERED";
  if (state.notificationDelivered || state.emailDelivered) return "PARTIAL";
  return "FAILED";
}

export function grantDeliveryFailureCode(state: GrantDeliveryState): string | null {
  if (!state.notificationDelivered && state.emailAttempted && !state.emailDelivered) {
    return "notification_and_email_failed";
  }
  if (!state.notificationDelivered) return "notification_failed";
  if (state.emailAttempted && !state.emailDelivered) return "email_failed";
  return null;
}
