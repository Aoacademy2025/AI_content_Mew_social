"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ArrowRight, Check, ChevronDown, Crown, Loader2,
  ShieldCheck, Building2, Zap, Tag, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CouponBox } from "@/components/settings/coupon-box";
import { computeDisplayPrice } from "@/lib/pricing-display";
import { marketingPlanFeatures, supplementalPlanFeatures } from "@/lib/marketing-plan-facts";
import {
  isFoundingAnnualConversionEligible,
  paidPlanCardMode,
  PLAN_RANK,
} from "@/lib/plan-change";
import { trackEvent } from "@/lib/client-telemetry";
import { PRESERVE_TRIAL_CONVERT_LINE } from "@/lib/preserve-trial";
import { customerApiErrorMessage } from "@/lib/customer-api-error";

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
  paymentResult,
  acquisitionSource,
  minuteQuotaEnabled,
  preserveTrialOnConvert = false,
}: {
  initialPlans: PlanConfig;
  initialFounding: { active: boolean; remaining: number; total: number; percentOff: number };
  paymentResult: string | null;
  acquisitionSource: string | null;
  minuteQuotaEnabled: boolean;
  /** #348 — PRESERVE_TRIAL_ON_CONVERT, read on the server and passed down. */
  preserveTrialOnConvert?: boolean;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [period, setPeriod] = useState<BillingPeriod>("annual");
  const [method, setMethod] = useState<PaymentMethod>("promptpay");
  const [faqOpen, setFaqOpen] = useState<number>(-1);
  const [showCoupon, setShowCoupon] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; percentOff: number | null } | null>(null);
  const founding = initialFounding;
  const [me, setMe] = useState<Me>(null);
  const [userChecked, setUserChecked] = useState(false);
  const [planConfig] = useState<PlanConfig>(initialPlans);

  const yearly = period === "annual";

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
        // PromptPay one-time purchase that the server correctly blocks.
        if (d?.subStatus === "active" && d?.billingPeriod === "monthly") setMethod("card");
        setUserChecked(true);
      })
      .catch(() => { /* leave userChecked false → CTAs stay in loading state, no wrong redirect */ });
  }, []);

  useEffect(() => {
    if (!acquisitionSource?.startsWith("hero_script")) return;
    trackEvent("hero_script_pricing_viewed", {
      properties: { source: acquisitionSource },
    });
  }, [acquisitionSource]);

  const currentPlan = me?.plan ?? null;
  const daysLeft = me?.trialEndsAt ? Math.max(0, Math.ceil((new Date(me.trialEndsAt).getTime() - Date.now()) / 86400000)) : 0;
  const onTrial = currentPlan === "PRO" && daysLeft > 0;
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
    if (acquisitionSource?.startsWith("hero_script")) {
      trackEvent("hero_script_checkout_requested", {
        status: "started",
        properties: {
          source: acquisitionSource,
          plan: planKey,
          period,
          method: period === "monthly" ? "card" : method,
        },
      });
    }
    setLoading(planKey);
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Monthly is card-only (the method toggle is hidden in monthly mode, so the promptpay default
        // would otherwise build an invalid monthly+promptpay session). Server coerces too.
        body: JSON.stringify({ plan: planKey, period, method: period === "monthly" ? "card" : method, couponCode: appliedCoupon?.code }),
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

  // No annual total shown — the per-month figure is the hero; total appears at checkout.
  function priceBlock(monthlyPrice: number) {
    const display = computeDisplayPrice({ monthlyPrice, period, coupon: appliedCoupon, founding });
    if (!yearly) {
      return { amount: monthlyPrice.toLocaleString(), sub: "ต่ออัตโนมัติรายเดือน · ยกเลิกได้", was: undefined as string | undefined };
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
        <div className="mx-auto mb-6 flex max-w-2xl items-center gap-3 rounded-2xl p-4"
          style={{ background: "rgba(248,113,113,.10)", border: "1px solid rgba(248,113,113,.25)" }}>
          <AlertCircle className="h-5 w-5 shrink-0" style={{ color: "#F87171" }} />
          <p className="text-sm" style={{ color: "#FCA5A5" }}>ยกเลิกการชำระเงินแล้ว — กลับมาเลือกแพ็กได้ทุกเมื่อ</p>
        </div>
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

      {/* controls — clean cluster */}
      <div className="mb-2 flex justify-center">
        <div className="ve-card inline-flex rounded-full p-1">
          <button onClick={() => setPeriod("monthly")} className={cn("rounded-full px-5 py-2 text-sm font-semibold transition")} style={!yearly ? { background: VIOLET_GRAD, color: "#fff" } : { color: "var(--ui-text-muted)" }}>รายเดือน</button>
          <button onClick={() => setPeriod("annual")} className={cn("inline-flex items-center rounded-full px-5 py-2 text-sm font-semibold transition")} style={yearly ? { background: VIOLET_GRAD, color: "#fff" } : { color: "var(--ui-text-muted)" }}>
            รายปี <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[11px]" style={{ border: `1px solid ${VIOLET_TILE_BORDER}`, background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>2 เดือนฟรี</span>
          </button>
        </div>
      </div>

      {yearly && (
        <div className="mb-2 flex justify-center">
          <div className="inline-flex gap-1 text-[12px]">
            <button onClick={() => setMethod("promptpay")} className="rounded-full px-3 py-1 font-medium transition"
              style={method === "promptpay" ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT } : { color: "var(--ui-text-muted)" }}>PromptPay · จ่ายครั้งเดียว</button>
            <button onClick={() => setMethod("card")} className="rounded-full px-3 py-1 font-medium transition"
              style={method === "card" ? { background: VIOLET_TILE_BG, color: VIOLET_LIGHT } : { color: "var(--ui-text-muted)" }}>บัตร · ต่ออัตโนมัติ</button>
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
                paymentMethod: period === "monthly" ? "card" : method,
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
          const pb = isPaid ? priceBlock(price) : null;

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

          return <div key={key} className="relative">{card}</div>;
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
