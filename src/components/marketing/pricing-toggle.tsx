"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { computeDisplayPrice } from "@/lib/pricing-display";
import type { PlanConfig } from "@/lib/plan-config";

type Period = "monthly" | "yearly";
type FoundingStatus = { active: boolean; remaining: number; total: number; percentOff: number } | null;

const BRAND = "linear-gradient(180deg,#8B66F8,#6C4CF4)"; // house gradient (matches app gradientPrimary)
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;

type PriceBlock = { amount: string; unit?: string; sub: string; was?: string };

/** Minutes per plan threaded from server to avoid client-side DB access. */
type MinutesPerPlan = { free: number; pro: number; business: number };

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

  // Per-month figure is the hero; the annual total shows only at checkout.
  function priceBlock(display: typeof proDisplay, monthlyPrice: number): PriceBlock {
    if (!yearly) {
      return { amount: `฿${monthlyPrice.toLocaleString()}`, unit: "/เดือน", sub: "จ่ายรายเดือน · ยกเลิกได้ทุกเมื่อ" };
    }
    const monthlyEq = Math.round(display.final / 12);
    const sub = display.isFounding
      ? `🔥 Founding ลด ${display.pct}% · จ่ายปีละครั้ง`
      : `จ่ายปีละครั้ง · ไม่ตัดอัตโนมัติ`;
    return { amount: `฿${monthlyEq.toLocaleString()}`, unit: "/เดือน", sub, was: `฿${monthlyPrice.toLocaleString()}` };
  }

  const proBlock = priceBlock(proDisplay, plans.pro.price);
  const bizBlock = priceBlock(bizDisplay, plans.business.price);

  return (
    <div>
      {/* billing toggle */}
      <div role="group" aria-label="รูปแบบการชำระเงิน" className="mx-auto my-8 inline-flex rounded-full border border-white/10 bg-white/[0.045] p-1">
        <button
          type="button"
          aria-pressed={!yearly}
          onClick={() => setPeriod("monthly")}
          className={`rounded-full px-5 py-2 text-sm font-semibold transition ${!yearly ? "text-white" : "text-white/55"}`}
          style={!yearly ? { background: BRAND } : undefined}
        >
          รายเดือน
        </button>
        <button
          type="button"
          aria-pressed={yearly}
          onClick={() => setPeriod("yearly")}
          className={`inline-flex items-center rounded-full px-5 py-2 text-sm font-semibold transition ${yearly ? "text-white" : "text-white/55"}`}
          style={yearly ? { background: BRAND } : undefined}
        >
          รายปี
          <span className="ml-1.5 rounded-full border border-violet-400/40 bg-violet-400/15 px-1.5 py-0.5 text-[11px] text-violet-200">
            2 เดือนฟรี
          </span>
        </button>
      </div>

      {hasFounding && founding && (
        <p className="mb-5 text-center text-sm font-semibold text-amber-200">
          🔥 Founding รายปีลด {founding.percentOff}% — เหลือ {founding.remaining}/{founding.total} ที่นั่ง
        </p>
      )}

      <div className="grid gap-4 text-left md:grid-cols-3">
        <Tier name={plans.free.name} amount="฿0" sub="เริ่มฟรี ไม่ต้องใช้บัตร" features={plans.free.features} cta="เริ่มใช้ฟรี" ghost badge={plans.free.badge ?? undefined} minutesPerMonth={minutesPerPlan?.free} />
        <Tier
          name={plans.pro.name}
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

      {/* payment reassurance chips */}
      <div className="mt-7 flex flex-wrap justify-center gap-2.5">
        {["💳 PromptPay", "💳 บัตร", "🎁 ทดลอง PRO ฟรี 7 วัน", "🔁 จ่ายครั้งเดียว ไม่ตัดอัตโนมัติ"].map((c) => (
          <span key={c} className="rounded-full border border-violet-400/30 bg-violet-400/10 px-3.5 py-1.5 text-[13px] text-violet-200">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function Tier({
  name, amount, unit, sub, was, features, cta, best, ghost, badge, minutesPerMonth,
}: {
  name: string;
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
  const content = (
    <>
      <h3 className="text-center text-[22px] font-bold" style={HEAD}>{name}</h3>
      <div className="mt-1 text-center">
        <span className="text-[42px] font-bold leading-none" style={HEAD}>{amount}</span>
        {unit && <span className="ml-1 text-[15px] text-[#a7adcc]">{unit}</span>}
        {was && <span className="ml-2 text-[15px] text-[#7a7f9c] line-through">{was}</span>}
      </div>
      <div className="mt-1.5 min-h-[18px] text-center text-[12.5px] text-violet-300/90">{sub}</div>
      {minutesPerMonth !== undefined && (
        <div className="mt-2 text-center text-[12px] text-[#a7adcc]">
          {minutesPerMonth} นาที/เดือน{" "}
          <span className="text-[#6b7091]">(~{minutesPerMonth} คลิป @ ~1 นาที)</span>
        </div>
      )}
      <ul className="my-5 flex-1 space-y-1.5 text-[14.5px]">
        {features.map((f) => (
          <li key={f} className="flex gap-2 text-[#d5d9ee]">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" strokeWidth={3} aria-hidden />
            {f}
          </li>
        ))}
      </ul>
      <Link
        href="/register"
        className={`mt-auto block rounded-full py-3 text-center text-sm font-semibold ${ghost ? "border border-white/10 text-white" : "text-white"}`}
        style={ghost ? undefined : { background: BRAND, boxShadow: "0 0 34px rgba(139,92,246,.5)" }}
      >
        {cta}
      </Link>
    </>
  );

  if (best) {
    return (
      <div className="relative h-full">
        {badge && (
          <span className="absolute -top-3.5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-1 text-[13px] font-bold text-white" style={{ ...HEAD, background: BRAND }}>
            {badge}
          </span>
        )}
        <div className="relative h-full overflow-hidden rounded-[22px] p-[1.5px]" style={{ boxShadow: "0 0 60px -16px rgba(139,92,246,.6)" }}>
          <span
            aria-hidden
            className="sp-spin absolute left-1/2 top-1/2 aspect-square w-[170%]"
            style={{ background: "conic-gradient(from 0deg, transparent 0deg 210deg, #8b5cf6 280deg, #e9d5ff 320deg, #8b5cf6 340deg, transparent 360deg)" }}
          />
          <div className="relative flex h-full flex-col rounded-[21px] bg-[#06060b] p-7 transition-transform hover:-translate-y-1">
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {badge && (
        <span className="absolute -top-3.5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-1 text-[13px] font-bold text-white" style={{ ...HEAD, background: BRAND }}>
          {badge}
        </span>
      )}
      <div className="relative flex h-full flex-col rounded-[22px] border border-white/10 bg-white/[0.045] p-7 transition-transform hover:-translate-y-1">
        {content}
      </div>
    </div>
  );
}
