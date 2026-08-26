import { computeDisplayPrice } from "@/lib/pricing-display";

/**
 * How long a dismissal silences the prompt. The customer said "not now" once —
 * that answer is honoured for a full billing-ish cycle, not just a session
 * (issue #303: the prod build re-asked on the very next page because dismissal
 * lived in sessionStorage).
 */
export const FIRST_CLIP_CONVERT_COOLDOWN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Delay between "the exported clip is on screen" and the ask. The clip is the
 * reward; the ask waits until the customer has actually had it in front of
 * them. A download / open-gallery click short-circuits this.
 */
export const FIRST_CLIP_CONVERT_REVEAL_DELAY_MS = 6_000;

export type FirstClipConvertReason =
  | "internal"
  | "recurring_payer"
  | "paid_equivalent"
  | "no_completed_video"
  | "dismissed_cooldown";

export type FirstClipConvertBenefits = {
  /** Days an exported clip stays downloadable on PRO. */
  storageDays: number;
  /** Render minutes per 30-day window on PRO. */
  minutesPerMonth: number;
  /** Monthly AI-image credit grant on PRO. */
  monthlyCredits: number;
};

export type FirstClipConvertDecision =
  | { show: false; reason: FirstClipConvertReason }
  | {
      show: true;
      monthlyPriceThb: number;
      annualListThb: number;
      /** List annual expressed per month — the number the landing page shows. */
      annualMonthlyThb: number;
      benefits: FirstClipConvertBenefits;
      founding: {
        active: true;
        remaining: number;
        total: number;
        percentOff: number;
        annualPriceThb: number;
        /** Founding annual expressed per month (the ฿250 the landing page promises). */
        annualMonthlyThb: number;
      } | null;
    };

/** Annual prices are quoted per month on every surface (see CLAUDE.md pricing display rule). */
export function monthlyEquivalent(annualThb: number): number {
  return Math.round(annualThb / 12);
}

export function firstClipConvertCooldownActive(
  dismissedAt: Date | null | undefined,
  now: Date,
  cooldownDays: number = FIRST_CLIP_CONVERT_COOLDOWN_DAYS,
): boolean {
  if (!dismissedAt) return false;
  const elapsed = now.getTime() - dismissedAt.getTime();
  // A clock-skewed future timestamp still counts as "asked recently".
  if (elapsed < 0) return true;
  return elapsed < cooldownDays * DAY_MS;
}

export function decideFirstClipConvertPrompt(input: {
  isInternal: boolean;
  isRecurringPayer: boolean;
  /** True for any paid-equivalent entitlement: subscription, one-time/PromptPay term, Bundle, GRANT coupon, administrator grant. */
  isPaidEquivalent?: boolean;
  hasCompletedVideo: boolean;
  dismissedAt?: Date | null;
  now?: Date;
  monthlyPriceThb: number;
  benefits: FirstClipConvertBenefits;
  founding: { active: boolean; remaining: number; total?: number; percentOff: number } | null;
}): FirstClipConvertDecision {
  if (input.isInternal) return { show: false, reason: "internal" };
  if (input.isRecurringPayer) return { show: false, reason: "recurring_payer" };
  if (input.isPaidEquivalent) return { show: false, reason: "paid_equivalent" };
  if (!input.hasCompletedVideo) return { show: false, reason: "no_completed_video" };
  if (firstClipConvertCooldownActive(input.dismissedAt ?? null, input.now ?? new Date())) {
    return { show: false, reason: "dismissed_cooldown" };
  }

  const annualListThb = computeDisplayPrice({
    monthlyPrice: input.monthlyPriceThb,
    period: "annual",
    coupon: null,
    founding: null,
  }).final;
  const foundingActive = Boolean(input.founding?.active && (input.founding.remaining ?? 0) > 0);
  const foundingPrice = foundingActive && input.founding
    ? computeDisplayPrice({
        monthlyPrice: input.monthlyPriceThb,
        period: "annual",
        coupon: null,
        founding: { active: true, percentOff: input.founding.percentOff },
      }).final
    : null;

  return {
    show: true,
    monthlyPriceThb: input.monthlyPriceThb,
    annualListThb,
    annualMonthlyThb: monthlyEquivalent(annualListThb),
    benefits: input.benefits,
    founding: foundingActive && input.founding && foundingPrice != null
      ? {
          active: true,
          remaining: input.founding.remaining,
          total: input.founding.total ?? input.founding.remaining,
          percentOff: input.founding.percentOff,
          annualPriceThb: foundingPrice,
          annualMonthlyThb: monthlyEquivalent(foundingPrice),
        }
      : null,
  };
}

/**
 * Surfaces that already carry the offer, or that report on a payment in
 * flight. A convert modal on top of them is noise at best and can cover a
 * "payment successful" confirmation at worst.
 */
export const FIRST_CLIP_CONVERT_SUPPRESSED_PATHS: readonly string[] = ["/pricing", "/settings"];

export function firstClipConvertPathSuppressed(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return FIRST_CLIP_CONVERT_SUPPRESSED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Runtime reveal rule for the single mounted prompt.
 *
 * `exportedViewShown` is the honest gate: the server can say "this customer
 * qualifies" long before the clip is actually on screen, and #303 is precisely
 * about not asking before the customer has seen what they made. A render in
 * flight always wins — the Editor's rendering screen owns that viewport.
 */
export function canRevealFirstClipConvertPrompt(input: {
  decisionShown: boolean;
  exportedViewShown: boolean;
  renderActive: boolean;
  dismissed: boolean;
  pathname?: string | null;
}): boolean {
  if (!input.decisionShown) return false;
  if (input.dismissed) return false;
  if (!input.exportedViewShown) return false;
  if (input.renderActive) return false;
  if (firstClipConvertPathSuppressed(input.pathname)) return false;
  return true;
}

export type FirstClipConvertTrialContext = {
  /** Whole days left on an active PRO trial; 0 when there is no active trial. */
  trialDaysLeft: number;
  /** Render minutes left in the current window, or null when the minute meter is off. */
  minutesLeft: number | null;
};

/**
 * Honest trial line.
 *
 * NOTE (2026-08-26): the canvas draft read "สมัครวันนี้ไม่เสียวันทดลอง".
 * `checkout-plan-activation.ts` clears `trialEndsAt` and restarts the term from
 * `now` on conversion (and a card subscription ends at Stripe's period end), so
 * converting mid-trial DOES forfeit the remaining trial days. The copy below
 * states what actually happens. Change it only together with the billing code.
 */
export function firstClipConvertTrialLine(context: FirstClipConvertTrialContext): string {
  const minutes = context.minutesLeft != null && context.minutesLeft > 0
    ? ` · ${context.minutesLeft.toLocaleString("th-TH")} นาที`
    : "";
  if (context.trialDaysLeft > 0) {
    return `ทดลองของคุณเหลืออีก ${context.trialDaysLeft.toLocaleString("th-TH")} วัน${minutes} — สมัครวันนี้เริ่มรอบใหม่ทันที (วันทดลองที่เหลือจะสิ้นสุด)`;
  }
  if (context.minutesLeft != null && context.minutesLeft > 0) {
    return `รอบนี้เหลืออีก ${context.minutesLeft.toLocaleString("th-TH")} นาที — สมัครวันนี้ใช้ต่อได้ทันที`;
  }
  return "สมัครวันนี้ใช้ต่อได้ทันที ยกเลิกได้ทุกเมื่อ";
}

/** Whole days left on a trial, floored at 0. Mirrors trialStatus() in trial.ts. */
export function trialDaysLeftFrom(trialEndsAt: string | Date | null | undefined, now: Date): number {
  if (!trialEndsAt) return 0;
  const ends = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  const ms = ends.getTime();
  if (!Number.isFinite(ms) || ms <= now.getTime()) return 0;
  return Math.ceil((ms - now.getTime()) / DAY_MS);
}
