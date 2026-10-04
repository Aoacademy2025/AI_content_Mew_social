"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ArrowRight, Check, ChevronDown, Crown, Loader2,
  ShieldCheck, Building2, Zap, Tag, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CouponBox } from "@/components/settings/coupon-box";
import { computeDisplayPrice, foundingMemberUpgradeEligible, getDefaultPricingSelection } from "@/lib/pricing-display";
import { marketingPlanFeatures, supplementalPlanFeatures } from "@/lib/marketing-plan-facts";
import {
  isFoundingAnnualConversionEligible,
  paidPlanCardMode,
  PLAN_RANK,
} from "@/lib/plan-change";
import { trackEvent } from "@/lib/client-telemetry";
import { PRESERVE_TRIAL_CONVERT_LINE } from "@/lib/preserve-trial";
import { customerApiErrorMessage } from "@/lib/customer-api-error";
import {
  cancelBannerOffered,
  monthlyPromptpayAvailable,
  resolveMonthlyMethodForTier,
  shouldPreselectPromptpay,
  type PaidTier,
} from "@/lib/pricing-period-method";
// Type-only: erased at compile time, so promptpay-monthly.ts's server-only import
// (ensureStripeConfig/Prisma) never reaches this client bundle.
import type { CancelReturnParams } from "@/lib/promptpay-monthly";

// Credit pack display data — mirrors CREDIT_PACKS in src/lib/credits.ts (kept in sync manually).
// Inlined here to avoid importing credits.ts which pulls in prisma (server-only).
const CREDIT_PACKS_DISPLAY = [
  { id: "starter", label: "Starter", baht: 199, credits: 200 },
  { id: "popular", label: "Popular", baht: 499, credits: 540 },
  { id: "pro",     label: "Pro",     baht: 999, credits: 1150 },
] as const;

type PlanKey = "FREE" | "PRO" | "BUSINESS";
type BillingPeriod = "monthly" | "annual";
type PaymentMethod = "card" | "promptpay";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx, settings/page.tsx
const HEAD = { fontFamily: "var(--font-kanit), Kanit, sans-serif" } as const;
const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
const GLOW = "0 8px 26px rgba(108,76,244,.35)";

// .ve-card / .ve-card-hover now live in globals.css (Editor v2 house utilities).

// #300 — flag-gated default checkout path (OFF = today's annual+PromptPay default).
// Build-baked constant, same pattern as NEXT_PUBLIC_CREDITS_LIVE above.
const PRICING_DEFAULT_RECURRING = process.env.NEXT_PUBLIC_PRICING_DEFAULT_RECURRING === "1";

type TierData = { price: number; name: string; badge: string | null; tagline: string; features: string[] };
type PlanConfig = { free: TierData; pro: TierData; business: TierData };
type Me = {
  plan: PlanKey;
  usageCount?: number;
  usageLimit?: number;
  trialEndsAt?: string | null;
  subStatus?: string | null;
  /** Browser-safe evidence of a Stripe subscription (#348) — never the id itself. */
  hasStripeSubscription?: boolean;
  billingPeriod?: BillingPeriod | null;
  planExpiresAt?: string | null;
  minuteQuota?: boolean;
  minutesUsed?: number;
  minutesLimit?: number;
} | null;

const TIER_META: { key: PlanKey; cfgKey: keyof PlanConfig; icon: React.ElementType; highlight?: boolean }[] = [
  { key: "FREE", cfgKey: "free", icon: Zap },
  { key: "PRO", cfgKey: "pro", icon: Crown, highlight: true },
  { key: "BUSINESS", cfgKey: "business", icon: Building2 },
];

const FAQS = [
  { q: "รายปีจ่ายครั้งเดียว ตัดเงินอัตโนมัติไหม?", a: "ถ้าเลือก PromptPay = จ่ายครั้งเดียว ใช้ได้ 1 ปี ไม่ตัดอัตโนมัติ · ถ้าเลือกบัตร = ต่ออัตโนมัติ ยกเลิกได้จาก billing portal" },
  { q: "ยกเลิก / เปลี่ยนแผนได้ไหม?", a: "ได้ จัดการได้จากหน้า Settings → Billing ใช้งานต่อได้จนจบรอบที่จ่ายไว้" },
  { q: "จ่ายเงินยังไง?", a: "บัตรเครดิต/เดบิต หรือ PromptPay (สแกนจ่าย)" },
];

export function PricingClient({
  initialPlans,
  initialFounding,
  foundingMember = false,
  paymentResult,
  acquisitionSource,
  preferredPeriod,
  minuteQuotaEnabled,
  preserveTrialOnConvert = false,
  monthlyPromptpayOffered = { PRO: false, BUSINESS: false },
  promptpayMonthlyEnabledFlag = false,
  cancelReturn = {},
}: {
  initialPlans: PlanConfig;
  initialFounding: { active: boolean; remaining: number; total: number; percentOff: number };
  /** HERO-61 — the viewer holds a CONFIRMED founding seat (server-resolved). */
  foundingMember?: boolean;
  paymentResult: string | null;
  acquisitionSource: string | null;
  preferredPeriod: BillingPeriod | null;
  minuteQuotaEnabled: boolean;
  /** #348 — PRESERVE_TRIAL_ON_CONVERT, read on the server and passed down. */
  preserveTrialOnConvert?: boolean;
  /** ADR 0066 — `promptpayMonthlyOffered(plan)` per paid tier, resolved on the server. */
  monthlyPromptpayOffered?: Record<PaidTier, boolean>;
  /** ADR 0066 — `promptpayMonthlyEnabled()`, resolved on the server (no NEXT_PUBLIC_ twin). */
  promptpayMonthlyEnabledFlag?: boolean;
  /** ADR 0066 — the whitelisted cancel-return / `?method=promptpay` preselect params. */
  cancelReturn?: CancelReturnParams;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  // Base default (no known subscription state yet) — #300, flag-gated.
  const [period, setPeriod] = useState<BillingPeriod>(
    () => preferredPeriod
      ?? getDefaultPricingSelection({ recurringDefaultEnabled: PRICING_DEFAULT_RECURRING, subStatus: null, billingPeriod: null }).period,
  );
  const [method, setMethod] = useState<PaymentMethod>(
    () => getDefaultPricingSelection({ recurringDefaultEnabled: PRICING_DEFAULT_RECURRING, subStatus: null, billingPeriod: null }).method,
  );
  // ADR 0066 — monthly's method is tracked separately from annual's. Card is ALWAYS the
  // monthly default, independent of NEXT_PUBLIC_PRICING_DEFAULT_RECURRING; the only override
  // is an explicit `?method=promptpay` link (e.g. the past-due banner) that is actually
  // offered. Annual keeps its own `method` state and today's default logic, unchanged.
  const [monthlyMethod, setMonthlyMethod] = useState<PaymentMethod>(
    () => cancelReturn.period === "monthly" && shouldPreselectPromptpay(
      { period: "monthly", method: cancelReturn.method },
      { promptpayMonthlyEnabled: promptpayMonthlyEnabledFlag, monthlyOffered: monthlyPromptpayOffered },
    ) ? "promptpay" : "card",
  );
  const [faqOpen, setFaqOpen] = useState<number>(-1);
  const [showCoupon, setShowCoupon] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentOff: number | null } | null>(null);
  const [cancelBannerLoading, setCancelBannerLoading] = useState(false);
  const founding = initialFounding;
  const [me, setMe] = useState<Me>(null);
  const [userChecked, setUserChecked] = useState(false);
  const [planConfig] = useState<PlanConfig>(initialPlans);

  const yearly = period === "annual";
  const monthlyToggleVisible = monthlyPromptpayAvailable(monthlyPromptpayOffered);
  const monthlyMethodForTier = (tier: PaidTier): PaymentMethod =>
    resolveMonthlyMethodForTier(monthlyMethod, tier, monthlyPromptpayOffered);
  const cancelBanner = paymentResult === "cancelled"
    && cancelReturn.plan
    && cancelReturn.period
    && cancelBannerOffered(cancelReturn, { promptpayMonthlyEnabled: promptpayMonthlyEnabledFlag, monthlyOffered: monthlyPromptpayOffered })
    ? { plan: cancelReturn.plan, period: cancelReturn.period }
    : null;

  useEffect(() => {
    fetch("/api/user/me")
      // Only treat a real 401 as "signed out". A transient/non-401 failure must NOT collapse a
      // logged-in user to the signed-out CTA set (which would bounce them to /register on checkout).
      .then(async (r) => {
        if (r.ok) return r.json();
        if (r.status === 401) return null;
        throw new Error(`me ${r.status}`);
      })
      .then((d) => {
        setMe(d);
        // An existing card subscription can only be converted in place by card.
        // Default to that valid path instead of presenting an overlapping
        // PromptPay one-time purchase that the server correctly blocks — this override
        // applies regardless of the flag (see getDefaultPricingSelection).
        const resolved = getDefaultPricingSelection({
          recurringDefaultEnabled: PRICING_DEFAULT_RECURRING,
          subStatus: d?.subStatus ?? null,
          billingPeriod: d?.billingPeriod ?? null,
        });
        setPeriod(preferredPeriod ?? resolved.period);
        setMethod(resolved.method);
        setUserChecked(true);
      })
      .catch(() => { /* leave userChecked false → CTAs stay in loading state, no wrong redirect */ });
  }, [preferredPeriod]);

  const currentPlan = me?.plan ?? null;
  const daysLeft = me?.trialEndsAt ? Math.max(0, Math.ceil((new Date(me.trialEndsAt).getTime() - Date.now()) / 86400000)) : 0;
  const onTrial = currentPlan === "PRO" && daysLeft > 0;
  // HERO-61 — mirror what checkout applies, per tier: a member keeps the founding % only on an
  // annual upgrade (even when sold out) and pays full price otherwise (no second seat).
  const foundingFor = (planKey: PlanKey) => foundingMember
    ? { ...founding, active: foundingMemberUpgradeEligible({ currentPlan, targetPlan: planKey, period }) }
    : founding;

  // pricing_viewed — fires once per mount for ALL acquisition sources (previously
  // hero_script only), so conversion analysis of the new default isn't blind to the
  // rest of the funnel. Waits for userChecked so plan/onTrial reflect the real user.
  const trackedPricingViewRef = useRef(false);
  useEffect(() => {
    if (!userChecked || trackedPricingViewRef.current) return;
    trackedPricingViewRef.current = true;
    trackEvent("pricing_viewed", {
      properties: {
        source: acquisitionSource ?? "direct",
        plan: currentPlan,
        onTrial,
        defaultPeriod: period,
        defaultMethod: method,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userChecked]);
  const usageLimit = me?.usageLimit ?? 0;
  const usageCount = me?.usageCount ?? 0;
  const usagePct = me?.minuteQuota
    ? ((me.minutesLimit ?? 0) > 0 ? Math.min(100, Math.round(((me.minutesUsed ?? 0) / (me.minutesLimit ?? 1)) * 100)) : 0)
    : (usageLimit > 0 ? Math.min(100, Math.round((usageCount / usageLimit) * 100)) : 0);

  async function handleUpgrade(planKey: "PRO" | "BUSINESS") {
    if (userChecked && !currentPlan) {
      window.location.href = "/register";
      return;
    }
    const effectiveMethod = period === "monthly" ? monthlyMethodForTier(planKey) : method;
    const cfgKey = planKey === "PRO" ? "pro" : "business";
    const monthlyPrice = planConfig?.[cfgKey]?.price ?? (planKey === "PRO" ? 599 : 990);
    const isFounding = computeDisplayPrice({ monthlyPrice, period, coupon: appliedCoupon, founding: foundingFor(planKey) }).isFounding;
    trackEvent("pricing_cta_clicked", {
      step: "pricing_page",
      properties: {
        plan: planKey,
        period,
        method: effectiveMethod,
        couponCode: appliedCoupon?.code,
        founding: isFounding,
        surface: "pricing_tier_card",
        source: acquisitionSource ?? "direct",
      },
    });
    if (acquisitionSource?.startsWith("hero_script")) {
      trackEvent("hero_script_checkout_requested", {
        status: "started",
        properties: {
          source: acquisitionSource,
          plan: planKey,
          period,
          method: effectiveMethod,
        },
      });
    }
    setLoading(planKey);
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ADR 0066 — monthly PromptPay is only sent when offered for THIS tier
        // (monthlyMethodForTier coerces to card otherwise); the server coerces too.
        body: JSON.stringify({ plan: planKey, period, method: effectiveMethod, couponCode: appliedCoupon?.code }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(customerApiErrorMessage(data, "ยังเริ่มชำระเงินไม่ได้ กรุณาลองใหม่หรือติดต่อทีมงาน"));
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("เชื่อมต่อระบบชำระเงินไม่ได้ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setLoading(null);
    }
  }

  async function handleFoundingAnnual(planKey: "PRO" | "BUSINESS") {
    trackEvent("pricing_cta_clicked", {
      step: "pricing_page",
      properties: {
        plan: planKey,
        period: "annual",
        method: "card",
        founding: true,
        surface: "founding_annual_conversion",
        source: acquisitionSource ?? "direct",
      },
    });
    setLoading(planKey);
    try {
      const res = await fetch("/api/payments/founding-annual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(customerApiErrorMessage(data, "ยังเปลี่ยนเป็น Founding รายปีไม่ได้ กรุณาลองใหม่อีกครั้ง"));
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("เชื่อมต่อระบบชำระเงินไม่ได้ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setLoading(null);
    }
  }

  // ADR 0066 — the cancel-return banner's one-click PromptPay retry for the exact
  // plan+period the customer abandoned. Fires the same telemetry shape as the other
  // pricing CTAs, tagged with the dedicated surface so it's measurable on its own.
  async function handleCancelBannerCheckout(plan: PaidTier, cancelPeriod: BillingPeriod) {
    trackEvent("pricing_cta_clicked", {
      step: "pricing_page",
      properties: {
        plan,
        period: cancelPeriod,
        method: "promptpay",
        surface: "cancel_return_promptpay",
        source: acquisitionSource ?? "direct",
      },
    });
    setCancelBannerLoading(true);
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, period: cancelPeriod, method: "promptpay" }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(customerApiErrorMessage(data, "ยังเริ่มชำระเงินไม่ได้ กรุณาลองใหม่หรือติดต่อทีมงาน"));
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("เชื่อมต่อระบบชำระเงินไม่ได้ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setCancelBannerLoading(false);
    }
  }

  // No annual total shown — the per-month figure is the hero; total appears at checkout.
  function priceBlock(monthlyPrice: number, planKey: PlanKey) {
    const display = computeDisplayPrice({ monthlyPrice, period, coupon: appliedCoupon, founding: foundingFor(planKey) });
    if (!yearly) {
      // ADR 0066 — monthly + PromptPay (offered for this tier) replaces the card sub line.
      const sub = planKey !== "FREE" && monthlyMethodForTier(planKey) === "promptpay"
        ? `จ่ายครั้งเดียว ฿${monthlyPrice.toLocaleString()} · ใช้ได้ 30 วัน · ไม่ตัดเงินอัตโนมัติ`
        : "ต่ออัตโนมัติรายเดือน · ยกเลิกได้";
      return { amount: monthlyPrice.toLocaleString(), sub, was: undefined as string | undefined };
    }
    const monthlyEq = Math.round(display.final / 12);
    const sub = display.isFounding
      ? `🔥 Founding ลด ${display.pct}% · ${method === "promptpay" ? "จ่ายปีละครั้ง" : "บิลรายปี"}`
      : method === "promptpay"
        ? "จ่ายปีละครั้ง · ไม่ตัดอัตโนมัติ"
        : "บิลรายปี · ต่ออัตโนมัติ";
    return { amount: monthlyEq.toLocaleString(), sub, was: monthlyPrice.toLocaleString() };
  }

  return (
    <div className="relative mx-auto max-w-6xl px-4 pb-16 md:px-6">
      {/* payment result — semantic status colors (success/danger), not the house accent */}
      {paymentResult === "success" && (
        <div className="mx-auto mb-6 flex max-w-2xl items-center gap-3 rounded-2xl p-4"
          style={{ background: "rgba(52,211,153,.10)", border: "1px solid rgba(52,211,153,.25)" }}>
          <Check className="h-5 w-5 shrink-0" style={{ color: "#34D399" }} strokeWidth={3} />
          <p className="text-sm font-semibold" style={{ color: "#6EE7B7" }}>ชำระเงินสำเร็จ · อัปเกรดแผนให้เรียบร้อยแล้ว 🎉</p>
        </div>
      )}
      {paymentResult === "cancelled" && (
        cancelBanner ? (
          // ADR 0066 — the abandoned session was card and PromptPay is offered for this
          // exact plan+period: offer a one-click PromptPay retry instead of the plain text.
          <div className="mx-auto mb-6 flex max-w-2xl flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between"
            style={{ background: "rgba(248,113,113,.10)", border: "1px solid rgba(248,113,113,.25)" }}>
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "#F87171" }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: "#FCA5A5" }}>บัตรใช้ไม่ได้? จ่ายด้วย PromptPay แทนได้</p>
                <p className="mt-1 text-[13px]" style={{ color: "#FCA5A5" }}>
                  {cancelBanner.period === "monthly"
                    ? `สแกนจ่าย ฿${(cancelBanner.plan === "PRO" ? planConfig?.pro?.price : planConfig?.business?.price) ?? (cancelBanner.plan === "PRO" ? 599 : 990)} ใช้ ${cancelBanner.plan} ได้ 30 วัน ไม่ต้องใช้บัตร`
                    : `สแกนจ่ายครั้งเดียว ใช้ ${cancelBanner.plan} ได้ 1 ปี ไม่ต้องใช้บัตร`}
                </p>
              </div>
            </div>
            <button
              onClick={() => handleCancelBannerCheckout(cancelBanner.plan, cancelBanner.period)}
              disabled={cancelBannerLoading}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed"
              style={{ background: VIOLET_GRAD, color: "#fff" }}
            >
              {cancelBannerLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "จ่ายด้วย PromptPay"}
            </button>
          </div>
        ) : (
          <div className="mx-auto mb-6 flex max-w-2xl items-center gap-3 rounded-2xl p-4"
            style={{ background: "rgba(248,113,113,.10)", border: "1px solid rgba(248,113,113,.25)" }}>
            <AlertCircle className="h-5 w-5 shrink-0" style={{ color: "#F87171" }} />
            <p className="text-sm" style={{ color: "#FCA5A5" }}>ยกเลิกการชำระเงินแล้ว — กลับมาเลือกแพ็กได้ทุกเมื่อ</p>
          </div>
        )
      )}

      {/* personalized status band */}
      {userChecked && currentPlan && (
        <div className="ve-card mx-auto mb-8 max-w-3xl overflow-hidden rounded-[18px] p-5" style={{ borderColor: "hsl(258 90% 66% / .22)" }}>
          {onTrial ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-[15px] font-semibold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>
                  <Clock className="h-4 w-4" style={{ color: "#FBBF24" }} strokeWidth={2.5} aria-hidden />
                  ทดลอง PRO เหลือ <span style={{ color: "#FBBF24" }}>{daysLeft} วัน</span>
                </span>
                {me?.minuteQuota
                  ? ((me.minutesLimit ?? 0) > 0 && <span className="text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>ใช้ไป {me.minutesUsed}/{me.minutesLimit} นาทีเดือนนี้</span>)
                  : (usageLimit > 0 && <span className="text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>ใช้ไป {usageCount}/{usageLimit} คลิปเดือนนี้</span>)}
              </div>
              {(me?.minuteQuota ? (me.minutesLimit ?? 0) > 0 : usageLimit > 0) && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--ui-divider)" }}>
                  <div className="h-full rounded-full" style={{ width: `${usagePct}%`, background: VIOLET_GRAD }} />
                </div>
              )}
              {me?.minuteQuota && (
                <p className="mt-2 text-[13px] font-semibold" style={{ color: "#FBBF24" }}>
                  โควต้าทดลอง: 15 นาที ใน 7 วัน
                </p>
              )}
              <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
                หลังหมดทดลองจะกลับเป็น Free — เหลือ <b style={{ color: "var(--ui-text-primary)" }}>{me?.minuteQuota ? "5 นาที/เดือน · ~5 คลิป" : "2 คลิป/เดือน"}</b> · เก็บวิดีโอ 3 วัน · ปิด Avatar / โคลนเสียง / ตัดต่อในเว็บ
                <b style={{ color: VIOLET_LIGHT }}> อัปเกรดเพื่อใช้ต่อไม่สะดุด</b>
              </p>
              {preserveTrialOnConvert && (
                <p className="mt-2 text-[13px] font-semibold" style={{ color: "#34D399" }}>
                  {PRESERVE_TRIAL_CONVERT_LINE}
                </p>
              )}
            </>
          ) : currentPlan === "FREE" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[15px] font-semibold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>คุณกำลังใช้แผน Free</span>
                {me?.minuteQuota
                  ? ((me.minutesLimit ?? 0) > 0 && <span className="text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>ใช้ไป {me.minutesUsed}/{me.minutesLimit} นาทีเดือนนี้</span>)
                  : (usageLimit > 0 && <span className="text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>ใช้ไป {usageCount}/{usageLimit} คลิปเดือนนี้</span>)}
              </div>
              {(me?.minuteQuota ? (me.minutesLimit ?? 0) > 0 : usageLimit > 0) && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--ui-divider)" }}>
                  <div className="h-full rounded-full" style={{ width: `${usagePct}%`, background: VIOLET_GRAD }} />
                </div>
              )}
              <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
                อัปเกรด PRO ปลดล็อก <b style={{ color: "var(--ui-text-primary)" }}>{me?.minuteQuota ? "80 นาที/เดือน · ~80 คลิป" : "100 คลิป/เดือน"}</b> · AI Avatar · เสียงโคลน · ซับไวรัล · ตัดต่อในเว็บ
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-[15px] font-semibold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>
                <ShieldCheck className="h-4 w-4" style={{ color: VIOLET_LIGHT }} strokeWidth={2.5} aria-hidden />
                คุณอยู่แผน {currentPlan} 🎉{" "}
                {me?.minuteQuota
                  ? ((me.minutesLimit ?? 0) > 0 && <span className="text-[13px] font-normal" style={{ color: "var(--ui-text-secondary)" }}>· ใช้ไป {me.minutesUsed}/{me.minutesLimit} นาที</span>)
                  : (usageLimit > 0 && <span className="text-[13px] font-normal" style={{ color: "var(--ui-text-secondary)" }}>· ใช้ไป {usageCount}/{usageLimit} คลิป</span>)}
              </span>
              <Link href="/settings?tab=billing" className="text-[13px] font-medium transition-colors" style={{ color: VIOLET_LIGHT }}>จัดการบิล →</Link>
            </div>
          )}
        </div>
      )}

      {/* founding — semantic amber (promo urgency), not the house accent */}
      {founding?.active && !appliedCoupon && (
        <p className="mb-5 text-center text-sm font-semibold" style={{ color: "#FBBF24" }}>
          🔥 ราคาผู้ก่อตั้ง — รายปีลด {founding.percentOff}% · เหลือ {founding.remaining}/{founding.total} ที่นั่ง
        </p>
      )}

      {/* controls — clean cluster. Touch targets ≥44px tall (#334): min-h-11 + flex-wrap so
          this survives down to a 360px-wide viewport without clipping. */}
      <div className="mb-2 flex justify-center px-2">
        <div className="ve-card flex flex-wrap items-center justify-center gap-1 rounded-full p-1">
          <button onClick={() => setPeriod("monthly")} className={cn("inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-semibold transition")} style={!yearly ? { background: VIOLET_GRAD, color: "#fff" } : { color: "var(--ui-text-muted)" }}>รายเดือน</button>
          <button onClick={() => setPeriod("annual")} className={cn("inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-semibold transition")} style={yearly ? { background: VIOLET_GRAD, color: "#fff" } : { color: "var(--ui-text-muted)" }}>
            รายปี <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[11px]" style={{ border: `1px solid ${VIOLET_TILE_BORDER}`, background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>2 เดือนฟรี</span>
          </button>
        </div>
      </div>

      {yearly && (
        <div className="mb-2 flex justify-center px-2">
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-[13px]">
            {/* #300: recurring-first order when the flag is on; today's PromptPay-first order otherwise. */}
            {(PRICING_DEFAULT_RECURRING ? (["card", "promptpay"] as const) : (["promptpay", "card"] as const)).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className="inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 font-medium transition"
                style={method === m ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT } : { color: "var(--ui-text-muted)" }}
              >
                {m === "promptpay" ? "PromptPay · จ่ายครั้งเดียว" : "บัตร · ต่ออัตโนมัติ"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ADR 0066 — monthly PromptPay 30-day term, only when offered. Card is always first
          and always the default; no flag-based reordering (unlike the annual toggle above). */}
      {!yearly && monthlyToggleVisible && (
        <div className="mb-2 flex justify-center px-2">
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-[13px]">
            {(["card", "promptpay"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMonthlyMethod(m)}
                className="inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 font-medium transition"
                style={monthlyMethod === m ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT } : { color: "var(--ui-text-muted)" }}
              >
                {m === "promptpay" ? "PromptPay · 30 วัน" : "บัตร · ต่ออัตโนมัติ"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* coupon (collapsed) */}
      <div className="mb-8 flex flex-col items-center">
        {appliedCoupon ? (
          <span className="inline-flex items-center gap-2 text-xs" style={{ color: "#6EE7B7" }}>
            ✓ ใช้โค้ด {appliedCoupon.code}{appliedCoupon.percentOff !== null ? ` ลด ${appliedCoupon.percentOff}%` : ""} แล้ว
            <button className="underline opacity-80 hover:opacity-100" onClick={() => setAppliedCoupon(null)}>ลบ</button>
          </span>
        ) : showCoupon ? (
          <div className="w-full max-w-md">
            <CouponBox variant="inline" onDiscountApplied={(c) => setAppliedCoupon({ code: c.code, percentOff: c.percentOff })} />
          </div>
        ) : (
          <button onClick={() => setShowCoupon(true)} className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition"
            style={{ border: `1px solid ${VIOLET_TILE_BORDER}`, background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>
            <Tag className="h-4 w-4" strokeWidth={2.3} /> มีโค้ดส่วนลด? แตะกรอกที่นี่
          </button>
        )}
      </div>

      {/* tiers */}
      <div className="grid gap-4 md:grid-cols-3">
        {TIER_META.map(({ key, cfgKey, icon: Icon, highlight }) => {
          const data = planConfig?.[cfgKey];
          const price = data?.price ?? (key === "PRO" ? 599 : key === "BUSINESS" ? 990 : 0);
          const features = [
            ...marketingPlanFeatures(cfgKey, minuteQuotaEnabled),
            ...supplementalPlanFeatures(data?.features ?? []),
          ];
          const name = data?.name ?? key;
          const tagline = data?.tagline ?? "";
          const badge = key === "PRO" ? (data?.badge ?? "แนะนำ") : data?.badge ?? null;
          // A trial user holds PRO but hasn't paid — they MUST still be able to subscribe, so the
          // PRO card is NOT treated as "current" for them (otherwise the button is disabled and
          // there is no way to convert a trial into a paid plan in-product).
          const isPaid = key !== "FREE";
          const isTrialPlan = onTrial && key === "PRO";
          const cardMode = currentPlan && isPaid
              ? paidPlanCardMode({
                currentPlan,
                subStatus: me?.subStatus ?? null,
                // Trial state belongs to the account, not only the PRO card:
                // an active PRO trial must also be able to convert to BUSINESS.
                isTrialPlan: onTrial,
                billingPeriod: me?.billingPeriod ?? null,
                planExpiresAt: me?.planExpiresAt ? new Date(me.planExpiresAt) : null,
                paymentMethod: period === "monthly" ? monthlyMethodForTier(key as PaidTier) : method,
                // A converted-but-still-trialing subscription must read as
                // "manage/current", not as a second purchase the API rejects.
                hasStripeSubscription: me?.hasStripeSubscription ?? false,
                preserveTrialOnConvert,
              }, key, period)
            : null;
          const isCurrentTier = !!currentPlan && currentPlan === key && !isTrialPlan;
          const isCurrent = cardMode === "current";
          const isRenewCurrent = cardMode === "renew";
          const isLoading = loading === key;
          const isSignedOut = userChecked && !currentPlan;
          const pb = isPaid ? priceBlock(price, key) : null;

          const hasActiveSub = me?.subStatus === "active";
          const isFoundingConversion = !!currentPlan && isPaid && isFoundingAnnualConversionEligible({
            currentPlan,
            targetPlan: key,
            subStatus: me?.subStatus ?? null,
            billingPeriod: me?.billingPeriod ?? null,
            selectedPeriod: period,
            paymentMethod: method,
            foundingActive: !!founding?.active && !appliedCoupon,
          });
          const isPromptPayOverlap = !!currentPlan
            && isPaid
            && hasActiveSub
            && me?.billingPeriod === "monthly"
            && period === "annual"
            && method === "promptpay"
            && (PLAN_RANK[key] ?? 0) >= (PLAN_RANK[currentPlan] ?? 0);
          const isManageViaPortal = cardMode === "manage";
          const isTimedPlanCardWait = cardMode === "wait";
          const isDowngradeLocked = cardMode === "downgrade";

          const card = (
            <div className={cn("ve-card relative flex h-full flex-col rounded-[18px] p-6")}
              style={{
                ...(highlight ? { borderColor: "hsl(258 90% 66% / .4)", boxShadow: "0 0 50px -18px rgba(139,92,246,.55)" } : {}),
                ...(isCurrentTier ? { boxShadow: "0 0 0 1px hsl(258 90% 66% / .5)" } : {}),
              }}>
              {badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3.5 py-1 text-[12px] font-bold text-white" style={{ ...HEAD, background: VIOLET_GRAD }}>{badge}</span>
              )}
              <div className="mb-4 flex items-center justify-between">
                <div className="flex h-11 w-11 items-center justify-center rounded-[13px]" style={{ border: `1px solid ${VIOLET_TILE_BORDER}`, background: VIOLET_TILE_BG }}>
                  <Icon className="h-5 w-5" style={{ color: VIOLET }} strokeWidth={2.3} aria-hidden />
                </div>
                {isCurrentTier && <span className="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider" style={{ border: "1px solid hsl(258 90% 66% / .25)", background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>แผนปัจจุบัน</span>}
                {isTrialPlan && <span className="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider" style={{ border: "1px solid rgba(251,191,36,.25)", background: "rgba(251,191,36,.10)", color: "#FBBF24" }}>ทดลองอยู่ · {daysLeft} วัน</span>}
              </div>

              <h3 className="text-xl font-bold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>{name}</h3>
              <p className="mt-1 min-h-[40px] text-[13px] leading-5" style={{ color: "var(--ui-text-secondary)" }}>{tagline}</p>

              <div className="mt-3 border-t pt-4" style={{ borderColor: "var(--ui-divider)" }}>
                {key === "FREE" ? (
                  <div className="flex items-end gap-1.5"><span className="text-[40px] font-bold leading-none" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>฿0</span><span className="pb-1 text-[13px]" style={{ color: "var(--ui-text-secondary)" }}>หลังทดลอง</span></div>
                ) : (
                  <>
                    <div className="flex items-end gap-1">
                      <span className="text-[40px] font-bold leading-none" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>฿{pb!.amount}</span>
                      <span className="pb-1 text-[14px]" style={{ color: "var(--ui-text-secondary)" }}>/เดือน</span>
                      {pb!.was && <span className="ml-1.5 pb-1 text-[14px] line-through" style={{ color: "var(--ui-text-muted)" }}>฿{pb!.was}</span>}
                    </div>
                    <p className="mt-1.5 text-[12px]" style={{ color: VIOLET_LIGHT }}>{pb!.sub}</p>
                  </>
                )}
              </div>

              <ul className="my-5 flex-1 space-y-2 text-[14px]">
                {features.map((f) => (
                  <li key={f} className="flex items-start gap-2" style={{ color: "var(--ui-text-secondary)" }}>
                    <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: VIOLET_LIGHT }} strokeWidth={3} aria-hidden />
                    <span className="leading-5">{f}</span>
                  </li>
                ))}
              </ul>

              {!userChecked ? (
                // Pre-load placeholder — avoids a CTA flash that could mis-route a click before we
                // know who the user is (the FREE card used to flash "ใช้แผน Free" → /dashboard).
                <div className="ve-card inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-sm font-semibold" style={{ color: "var(--ui-text-muted)" }}>
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : isPaid ? (
                isFoundingConversion ? (
                  <button
                    onClick={() => handleFoundingAnnual(key as "PRO" | "BUSINESS")}
                    disabled={isLoading}
                    className={cn("inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed", !highlight && "ve-card ve-card-hover")}
                    style={highlight ? { background: VIOLET_GRAD, color: "#fff", boxShadow: GLOW } : { color: "var(--ui-text-primary)" }}
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>เปลี่ยนเป็น Founding รายปี <ArrowRight className="h-4 w-4" strokeWidth={2.5} /></>}
                  </button>
                ) : isPromptPayOverlap ? (
                  <div className="ve-card inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-center text-sm font-semibold" style={{ color: "var(--ui-text-muted)" }}>
                    PromptPay รายปีเริ่มได้หลังสมาชิกรายเดือนสิ้นสุด
                  </div>
                ) : isTimedPlanCardWait ? (
                  <div className="ve-card inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-center text-sm font-semibold" style={{ color: "var(--ui-text-muted)" }}>
                    เริ่มบัตรได้หลังแพ็กเกจเดิมสิ้นสุด เพื่อรักษาวันคงเหลือ
                  </div>
                ) : isCurrent ? (
                  <div className="ve-card inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold" style={{ color: "var(--ui-text-secondary)" }}><ShieldCheck className="h-4 w-4" strokeWidth={2.5} /> แผนปัจจุบัน</div>
                ) : isManageViaPortal ? (
                  <Link href="/settings?tab=billing" className="ve-card ve-card-hover inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold transition-colors" style={{ color: "var(--ui-text-primary)" }}>
                    จัดการแผนผ่านบิล <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
                  </Link>
                ) : isDowngradeLocked ? (
                  <div className="ve-card inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-sm font-semibold" style={{ color: "var(--ui-text-muted)" }}>รวมอยู่ในแผนของคุณ</div>
                ) : (
                  <button
                    onClick={() => handleUpgrade(key as "PRO" | "BUSINESS")}
                    disabled={isLoading}
                    className={cn("inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed",
                      !highlight && "ve-card ve-card-hover")}
                    style={highlight ? { background: VIOLET_GRAD, color: "#fff", boxShadow: GLOW } : { color: "var(--ui-text-primary)" }}
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : (<>{isTrialPlan ? `สมัคร ${name} เลย` : isRenewCurrent ? `ซื้อ / ต่ออายุ ${name}` : isSignedOut ? `สมัครเพื่อใช้ ${name}` : `อัปเกรดเป็น ${name}`} <ArrowRight className="h-4 w-4" strokeWidth={2.5} /></>)}
                  </button>
                )
              ) : isCurrentTier ? (
                <div className="inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold" style={{ border: "1px solid hsl(258 90% 66% / .2)", background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}><ShieldCheck className="h-4 w-4" strokeWidth={2.5} /> แผนปัจจุบัน</div>
              ) : isSignedOut ? (
                <Link href="/register" className="ve-card ve-card-hover inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-sm font-semibold transition-colors" style={{ color: "var(--ui-text-primary)" }}>
                  ทดลอง PRO ฟรี 7 วัน
                </Link>
              ) : hasActiveSub ? (
                // FREE card for an active subscriber — the real "downgrade" is cancel-in-portal.
                <Link href="/settings?tab=billing" className="ve-card ve-card-hover inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-sm font-semibold transition-colors" style={{ color: "var(--ui-text-primary)" }}>
                  จัดการ / ยกเลิกแผน
                </Link>
              ) : (
                // Logged-in trial / one-time / manual paid user: Free is their fallback, no action.
                <div className="ve-card inline-flex w-full items-center justify-center rounded-full px-4 py-3 text-sm font-semibold" style={{ color: "var(--ui-text-muted)" }}>รวมอยู่ในแผนของคุณ</div>
              )}
            </div>
          );

          return <div key={key} id={`plan-${key.toLowerCase()}`} className="relative scroll-mt-6">{card}</div>;
        })}
      </div>

      {/* trust row */}
      <div className="mt-7 flex flex-wrap justify-center gap-2.5">
        {["💳 บัตร", "📱 PromptPay", "🔁 จ่ายครั้งเดียว ไม่ตัดอัตโนมัติ", "🎁 ทดลอง PRO ฟรี 7 วัน"].map((c) => (
          <span key={c} className="rounded-full px-3.5 py-1.5 text-[13px]" style={{ border: `1px solid ${VIOLET_TILE_BORDER}`, background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>{c}</span>
        ))}
      </div>

      {/* credit packs — flag-gated, compact */}
      {process.env.NEXT_PUBLIC_CREDITS_LIVE === "1" && (
        <div className="mx-auto mt-10 max-w-2xl">
          <p className="mb-4 text-center text-[12px] font-semibold uppercase tracking-[.12em]" style={{ ...HEAD, color: VIOLET_LIGHT }}>เครดิตเติมนาที</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {CREDIT_PACKS_DISPLAY.map((pack) => {
              const bonusPctRaw = pack.credits > pack.baht ? Math.round(((pack.credits - pack.baht) / pack.baht) * 100) : 0;
              const bonusPct = bonusPctRaw >= 2 ? bonusPctRaw : undefined;
              return (
                <div key={pack.id} className="ve-card relative rounded-[14px] p-4 text-left"
                  style={pack.id === "popular" ? { borderColor: "hsl(258 90% 66% / .4)", background: "rgba(139,92,246,.06)" } : undefined}>
                  {pack.id === "popular" && (
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-0.5 text-[10px] font-bold text-white" style={{ background: VIOLET_GRAD }}>ยอดนิยม</span>
                  )}
                  <p className="text-[14px] font-bold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>{pack.label}</p>
                  <p className="mt-0.5 text-[20px] font-bold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>฿{pack.baht.toLocaleString()}</p>
                  <p className="mt-0.5 text-[12px]" style={{ color: "var(--ui-text-secondary)" }}>
                    {pack.credits} เครดิต
                    {bonusPct ? <span className="ml-1" style={{ color: VIOLET_LIGHT }}>+{bonusPct}%</span> : null}
                  </p>
                  <Link href="/settings?tab=billing" className="mt-3 block rounded-full py-1.5 text-center text-[12px] font-semibold transition"
                    style={{ border: `1px solid ${VIOLET_TILE_BORDER}`, color: VIOLET_LIGHT }}>
                    ซื้อเครดิต →
                  </Link>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-center text-[11px] leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>
            1 เครดิต = ฿1 · 2 เครดิต = นาทีเรนเดอร์ส่วนเกิน 1 นาที · เครดิตที่ซื้อไม่หมดอายุ<br />
            เครดิตไม่ปลดล็อก Hero AI Image, Avatar หรือเสียงพรีเมียม; ฟีเจอร์เป็นไปตามแพ็กเกจ
          </p>
        </div>
      )}

      {/* mini FAQ */}
      <div className="mx-auto mt-12 max-w-2xl">
        <h2 className="mb-5 text-center text-2xl font-bold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>คำถามเรื่องการจ่ายเงิน</h2>
        <div className="space-y-3">
          {FAQS.map((item, i) => {
            const open = faqOpen === i;
            return (
              <button key={item.q} type="button" onClick={() => setFaqOpen(open ? -1 : i)} className="ve-card ve-card-hover w-full rounded-[16px] p-4 text-left transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold" style={{ ...HEAD, color: "var(--ui-text-primary)" }}>{item.q}</p>
                  <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} style={{ color: VIOLET_LIGHT }} strokeWidth={2.5} />
                </div>
                {open && <p className="mt-2 text-[13px] leading-6" style={{ color: "var(--ui-text-secondary)" }}>{item.a}</p>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
