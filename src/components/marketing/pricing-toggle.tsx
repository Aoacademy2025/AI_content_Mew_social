"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, CreditCard, Flame } from "lucide-react";
import { computeDisplayPrice, marketingPriceBlock } from "@/lib/pricing-display";
import { marketingPlanFeatures, supplementalPlanFeatures, type MarketingTierKey } from "@/lib/marketing-plan-facts";
import type { PlanConfig } from "@/lib/plan-config";

type Period = "monthly" | "yearly";
type FoundingStatus = { active: boolean; remaining: number; total: number; percentOff: number } | null;

const BRAND = "linear-gradient(135deg,#9D7BFF 0%,#7857F6 55%,#6844EF 100%)";
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;

export function PricingToggle({
  plans,
  founding = null,
  minuteQuotaEnabled = false,
}: {
  plans: PlanConfig;
  founding?: FoundingStatus;
  minuteQuotaEnabled?: boolean;
}) {
  const [period, setPeriod] = useState<Period>("yearly");
  const yearly = period === "yearly";
  const pricePeriod = yearly ? "annual" : "monthly";
  const proDisplay = computeDisplayPrice({ monthlyPrice: plans.pro.price, period: pricePeriod, coupon: null, founding });
  const bizDisplay = computeDisplayPrice({ monthlyPrice: plans.business.price, period: pricePeriod, coupon: null, founding });
  const hasFounding = Boolean(yearly && founding?.active);

  const proBlock = marketingPriceBlock({ monthlyPrice: plans.pro.price, period: pricePeriod, founding });
  const bizBlock = marketingPriceBlock({ monthlyPrice: plans.business.price, period: pricePeriod, founding });

  return (
    <div>
      <div
        role="group"
        aria-label="รูปแบบการชำระเงิน"
        className="mx-auto my-8 flex w-full max-w-[340px] rounded-[14px] border border-white/10 bg-[#100e15] p-1 sm:my-9 sm:inline-flex sm:w-auto sm:max-w-none"
      >
        <button
          type="button"
          aria-pressed={!yearly}
          onClick={() => setPeriod("monthly")}
          className={`min-h-11 flex-1 rounded-[10px] px-4 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 sm:flex-none sm:px-5 ${!yearly ? "bg-white/[0.09] text-white" : "text-white/45 hover:text-white/75"}`}
        >
          รายเดือน
        </button>
        <button
          type="button"
          aria-pressed={yearly}
          onClick={() => setPeriod("yearly")}
          className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-[10px] px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 sm:flex-none sm:px-5 ${yearly ? "bg-violet-500/18 text-violet-100" : "text-white/45 hover:text-white/75"}`}
        >
          รายปี
          <span className="ml-2 rounded-full bg-violet-400/14 px-2 py-0.5 text-[10px] text-violet-200">2 เดือนฟรี</span>
        </button>
      </div>

      {hasFounding && founding && (
        <div className="mx-auto mb-7 flex w-fit items-center gap-2 border-l-2 border-amber-300/70 pl-3 text-[12px] font-medium text-amber-100/90">
          <Flame className="h-3.5 w-3.5 text-amber-300" aria-hidden />
          Founding รายปีลด {founding.percentOff}% · เหลือ {founding.remaining}/{founding.total} ที่
        </div>
      )}

      <p className="mb-5 text-center text-[12px] leading-5 text-white/42 sm:mb-6 sm:text-[13px]">
        {yearly ? "ราคาใหญ่คือค่าเฉลี่ยต่อเดือน · ยอดที่ชำระจริงแสดงใต้ราคา" : "รายเดือนชำระด้วยบัตรและยกเลิกได้ทุกเมื่อ"}
      </p>

      <div className="grid items-stretch gap-4 text-left lg:grid-cols-3">
        <Tier
          tierKey="free"
          name={plans.free.name}
          tagline={plans.free.tagline}
          amount="฿0"
          sub="เริ่มฟรี ไม่ต้องใช้บัตร"
          features={plans.free.features}
          cta="เริ่มใช้ฟรี"
          ghost
          badge={plans.free.badge ?? undefined}
          planFeatures={marketingPlanFeatures("free", minuteQuotaEnabled)}
          orderClass="order-2 lg:order-1"
        />
        <Tier
          tierKey="pro"
          name={plans.pro.name}
          tagline={plans.pro.tagline}
          amount={proBlock.amount}
          unit={proBlock.unit}
          sub={proBlock.sub}
          billingNote={proBlock.billingNote}
          was={proBlock.was}
          features={plans.pro.features}
          cta={`เริ่มใช้ ${plans.pro.name}`}
          best
          badge={proDisplay.isFounding ? "Founding" : (plans.pro.badge ?? "แนะนำ")}
          planFeatures={marketingPlanFeatures("pro", minuteQuotaEnabled)}
          orderClass="order-1 lg:order-2"
        />
        <Tier
          tierKey="business"
          name={plans.business.name}
          tagline={plans.business.tagline}
          amount={bizBlock.amount}
          unit={bizBlock.unit}
          sub={bizBlock.sub}
          billingNote={bizBlock.billingNote}
          was={bizBlock.was}
          features={plans.business.features}
          cta={`เลือก ${plans.business.name}`}
          ghost
          badge={bizDisplay.isFounding ? "Founding" : (plans.business.badge ?? undefined)}
          planFeatures={marketingPlanFeatures("business", minuteQuotaEnabled)}
          orderClass="order-3"
        />
      </div>

      <div className="mx-auto mt-7 grid max-w-[720px] gap-2 text-left text-[12px] leading-5 text-white/48 sm:flex sm:flex-wrap sm:justify-center sm:gap-x-6">
        {["PromptPay หรือบัตร", "ทดลอง PRO ฟรี 7 วัน", "PromptPay รายปีไม่ตัดอัตโนมัติ"].map((item, index) => (
          <span key={item} className="inline-flex items-center gap-1.5">
            {index === 0 ? <CreditCard className="h-3.5 w-3.5 text-violet-300/75" aria-hidden /> : <Check className="h-3.5 w-3.5 text-emerald-300/75" aria-hidden />}
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function Tier({
  tierKey,
  name,
  tagline,
  amount,
  unit,
  sub,
  billingNote,
  was,
  features,
  cta,
  best,
  ghost,
  badge,
  planFeatures,
  orderClass,
}: {
  tierKey: MarketingTierKey;
  name: string;
  tagline: string;
  amount: string;
  unit?: string;
  sub?: string;
  billingNote?: string;
  was?: string;
  features: string[];
  cta: string;
  best?: boolean;
  ghost?: boolean;
  badge?: string;
  planFeatures: string[];
  orderClass: string;
}) {
  const allFeatures = [...planFeatures, ...supplementalPlanFeatures(features)];
  const mobileLimit = tierKey === "pro" ? 6 : 5;
  const desktopLimit = tierKey === "pro" ? 8 : 6;
  const mobileVisible = allFeatures.slice(0, mobileLimit);
  const mobileMore = allFeatures.slice(mobileLimit);
  const desktopVisible = allFeatures.slice(0, desktopLimit);
  const desktopMore = allFeatures.slice(desktopLimit);

  const featureItem = (feature: string) => (
    <li key={feature} className="flex gap-2.5 text-white/70">
      <Check className={`mt-1 h-3.5 w-3.5 shrink-0 ${best ? "text-violet-300" : "text-white/36"}`} strokeWidth={2.6} aria-hidden />
      <span>{feature}</span>
    </li>
  );

  return (
    <article
      data-plan-tier={tierKey}
      className={`relative flex h-full scroll-mt-24 flex-col overflow-hidden rounded-[22px] border p-6 sm:p-8 ${orderClass} ${best ? "border-violet-300/35 bg-[linear-gradient(180deg,rgba(139,92,246,.105),rgba(14,11,20,.96)_32%)] shadow-[0_30px_80px_-42px_rgba(139,92,246,.75)]" : "border-white/[0.09] bg-[#0d0b12]"}`}
    >
      {best && <span className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/80 to-transparent" aria-hidden />}
      {badge && (
        <span className={`absolute right-5 top-5 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.1em] ${best ? "bg-violet-400/16 text-violet-200" : "bg-white/[0.055] text-white/48"}`}>
          {badge}
        </span>
      )}

      <p className="text-[10px] font-semibold uppercase tracking-[.15em] text-white/30">PLAN</p>
      <h3 className="mt-2 pr-20 text-[23px] font-semibold text-white" style={HEAD}>{name}</h3>
      <p className="mt-2 min-h-10 text-[14px] leading-6 text-white/50 lg:text-[12.5px] lg:leading-5">{tagline}</p>

      <div className="mt-6 border-y border-white/[0.07] py-5 sm:mt-7 sm:py-6">
        <div className="flex flex-wrap items-end gap-x-1.5 gap-y-1">
          <span className="text-[40px] font-semibold leading-none tracking-[-.04em] text-white" style={HEAD}>{amount}</span>
          {unit && <span className="pb-0.5 text-[13px] text-white/42">{unit}</span>}
          {was && <span className="pb-0.5 text-[12px] text-white/28">ปกติ <span className="line-through">{was}</span></span>}
        </div>
        <p className={`mt-2 min-h-5 text-[13px] font-medium leading-5 sm:text-[11.5px] ${best ? "text-violet-200/80" : "text-white/48"}`}>{sub}</p>
        {billingNote && <p className="mt-1.5 text-[11px] leading-5 text-white/36">{billingNote}</p>}
      </div>

      <ul className="my-6 flex-1 space-y-3 text-[14px] leading-6 lg:hidden">
        {mobileVisible.map(featureItem)}
      </ul>

      {mobileMore.length > 0 && (
        <details className="group -mt-3 mb-6 lg:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-[11px] border border-white/[0.08] px-3 text-[13px] font-medium text-white/62 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [&::-webkit-details-marker]:hidden">
            ดูสิทธิ์ทั้งหมดอีก {mobileMore.length} ข้อ
            <ChevronDown className="h-4 w-4 text-violet-300 transition-transform duration-200 group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="mt-4 space-y-3 px-1 text-[14px] leading-6">{mobileMore.map(featureItem)}</ul>
        </details>
      )}

      <ul className="my-7 hidden flex-1 space-y-3 text-[13px] leading-5 lg:block">
        {desktopVisible.map(featureItem)}
      </ul>

      {desktopMore.length > 0 && (
        <details className="group -mt-4 mb-6 hidden lg:block">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-[11px] border border-white/[0.08] px-3 text-[12px] font-medium text-white/58 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [&::-webkit-details-marker]:hidden">
            ดูสิทธิ์ทั้งหมดอีก {desktopMore.length} ข้อ
            <ChevronDown className="h-4 w-4 text-violet-300 transition-transform duration-200 group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="mt-4 space-y-3 px-1 text-[13px] leading-5">{desktopMore.map(featureItem)}</ul>
        </details>
      )}

      <Link
        href="/register"
        className={`mt-auto inline-flex min-h-12 items-center justify-center gap-2 rounded-[13px] text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 ${ghost ? "border border-white/10 bg-white/[0.025] text-white/78 hover:border-white/20 hover:bg-white/[0.055] hover:text-white" : "sale-v2-cta text-white"}`}
        style={ghost ? undefined : { background: BRAND }}
      >
        {cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </article>
  );
}
