"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, CreditCard, Flame } from "lucide-react";
import { computeDisplayPrice } from "@/lib/pricing-display";
import type { PlanConfig } from "@/lib/plan-config";

type Period = "monthly" | "yearly";
type FoundingStatus = { active: boolean; remaining: number; total: number; percentOff: number } | null;
type MinutesPerPlan = { free: number; pro: number; business: number };
type PriceBlock = { amount: string; unit?: string; sub: string; was?: string };

const BRAND = "linear-gradient(135deg,#9D7BFF 0%,#7857F6 55%,#6844EF 100%)";
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;

export function PricingToggle({
  plans,
  founding = null,
  minutesPerPlan,
}: {
  plans: PlanConfig;
  founding?: FoundingStatus;
  minutesPerPlan?: MinutesPerPlan;
}) {
  const [period, setPeriod] = useState<Period>("yearly");
  const yearly = period === "yearly";
  const pricePeriod = yearly ? "annual" : "monthly";
  const proDisplay = computeDisplayPrice({ monthlyPrice: plans.pro.price, period: pricePeriod, coupon: null, founding });
  const bizDisplay = computeDisplayPrice({ monthlyPrice: plans.business.price, period: pricePeriod, coupon: null, founding });
  const hasFounding = Boolean(yearly && founding?.active);

  function priceBlock(display: typeof proDisplay, monthlyPrice: number): PriceBlock {
    if (!yearly) {
      return {
        amount: `฿${monthlyPrice.toLocaleString()}`,
        unit: "/เดือน",
        sub: "จ่ายรายเดือน · ยกเลิกได้ทุกเมื่อ",
      };
    }

    const monthlyEq = Math.round(display.final / 12);
    return {
      amount: `฿${monthlyEq.toLocaleString()}`,
      unit: "/เดือน",
      sub: display.isFounding
        ? `Founding ลด ${display.pct}% · จ่ายปีละครั้ง`
        : "จ่ายปีละครั้ง · ไม่ตัดอัตโนมัติ",
      was: `฿${monthlyPrice.toLocaleString()}`,
    };
  }

  const proBlock = priceBlock(proDisplay, plans.pro.price);
  const bizBlock = priceBlock(bizDisplay, plans.business.price);

  return (
    <div>
      <div
        role="group"
        aria-label="รูปแบบการชำระเงิน"
        className="mx-auto my-9 inline-flex rounded-[14px] border border-white/10 bg-[#100e15] p-1"
      >
        <button
          type="button"
          aria-pressed={!yearly}
          onClick={() => setPeriod("monthly")}
          className={`min-h-10 rounded-[10px] px-5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${!yearly ? "bg-white/[0.09] text-white" : "text-white/45 hover:text-white/75"}`}
        >
          รายเดือน
        </button>
        <button
          type="button"
          aria-pressed={yearly}
          onClick={() => setPeriod("yearly")}
          className={`inline-flex min-h-10 items-center rounded-[10px] px-5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${yearly ? "bg-violet-500/18 text-violet-100" : "text-white/45 hover:text-white/75"}`}
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

      <div className="grid items-stretch gap-4 text-left md:grid-cols-3">
        <Tier
          name={plans.free.name}
          tagline={plans.free.tagline}
          amount="฿0"
          sub="เริ่มฟรี ไม่ต้องใช้บัตร"
          features={plans.free.features}
          cta="เริ่มใช้ฟรี"
          ghost
          badge={plans.free.badge ?? undefined}
          minutesPerMonth={minutesPerPlan?.free}
        />
        <Tier
          name={plans.pro.name}
          tagline={plans.pro.tagline}
          amount={proBlock.amount}
          unit={proBlock.unit}
          sub={proBlock.sub}
          was={proBlock.was}
          features={plans.pro.features}
          cta={`เริ่มใช้ ${plans.pro.name}`}
          best
          badge={proDisplay.isFounding ? "Founding" : (plans.pro.badge ?? "แนะนำ")}
          minutesPerMonth={minutesPerPlan?.pro}
        />
        <Tier
          name={plans.business.name}
          tagline={plans.business.tagline}
          amount={bizBlock.amount}
          unit={bizBlock.unit}
          sub={bizBlock.sub}
          was={bizBlock.was}
          features={plans.business.features}
          cta={`เลือก ${plans.business.name}`}
          ghost
          badge={bizDisplay.isFounding ? "Founding" : (plans.business.badge ?? undefined)}
          minutesPerMonth={minutesPerPlan?.business}
        />
      </div>

      <div className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[12px] text-white/43">
        {["PromptPay หรือบัตร", "ทดลอง PRO ฟรี 7 วัน", "รายปีไม่ตัดเงินอัตโนมัติ"].map((item, index) => (
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
  name,
  tagline,
  amount,
  unit,
  sub,
  was,
  features,
  cta,
  best,
  ghost,
  badge,
  minutesPerMonth,
}: {
  name: string;
  tagline: string;
  amount: string;
  unit?: string;
  sub?: string;
  was?: string;
  features: string[];
  cta: string;
  best?: boolean;
  ghost?: boolean;
  badge?: string;
  minutesPerMonth?: number;
}) {
  return (
    <article
      className={`relative flex h-full flex-col overflow-hidden rounded-[22px] border p-7 sm:p-8 ${best ? "border-violet-300/35 bg-[linear-gradient(180deg,rgba(139,92,246,.105),rgba(14,11,20,.96)_32%)] shadow-[0_30px_80px_-42px_rgba(139,92,246,.75)]" : "border-white/[0.09] bg-[#0d0b12]"}`}
    >
      {best && <span className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/80 to-transparent" aria-hidden />}
      {badge && (
        <span className={`absolute right-5 top-5 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.1em] ${best ? "bg-violet-400/16 text-violet-200" : "bg-white/[0.055] text-white/48"}`}>
          {badge}
        </span>
      )}

      <p className="text-[10px] font-semibold uppercase tracking-[.15em] text-white/30">PLAN</p>
      <h3 className="mt-2 pr-20 text-[23px] font-semibold text-white" style={HEAD}>{name}</h3>
      <p className="mt-2 min-h-10 text-[12.5px] leading-5 text-white/45">{tagline}</p>

      <div className="mt-7 border-y border-white/[0.07] py-6">
        <div className="flex flex-wrap items-end gap-x-1.5 gap-y-1">
          <span className="text-[40px] font-semibold leading-none tracking-[-.04em] text-white" style={HEAD}>{amount}</span>
          {unit && <span className="pb-0.5 text-[13px] text-white/42">{unit}</span>}
          {was && <span className="pb-0.5 text-[12px] text-white/24 line-through">{was}</span>}
        </div>
        <p className={`mt-2 min-h-5 text-[11.5px] ${best ? "text-violet-200/75" : "text-white/38"}`}>{sub}</p>
        {minutesPerMonth !== undefined && (
          <p className="mt-2 text-[11px] text-white/35">
            {minutesPerMonth} นาที/เดือน <span className="text-white/22">· ประมาณ {minutesPerMonth} คลิป @ 1 นาที</span>
          </p>
        )}
      </div>

      <ul className="my-7 flex-1 space-y-3 text-[13px] leading-5">
        {features.map((feature) => (
          <li key={feature} className="flex gap-2.5 text-white/68">
            <Check className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${best ? "text-violet-300" : "text-white/32"}`} strokeWidth={2.6} aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

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
