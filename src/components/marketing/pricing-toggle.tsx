"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

type Period = "monthly" | "yearly";

const FREE_FEATURES = ["ทดลอง PRO ฟรี 7 วัน", "ไม่ต้องใช้บัตร", "หลังทดลอง: 2 คลิป/เดือน"];
const PRO_FEATURES = [
  "AI Avatar + ตัดต่ออัตโนมัติ",
  "ซับไทย (ยาว/keyword)",
  "B-roll + เพลง + โคลนเสียง",
  "100 คลิป/เดือน",
  "เก็บวิดีโอ 7 วัน",
];
const BUSINESS_FEATURES = ["ทุกอย่างใน PRO", "300 คลิป/เดือน", "คลิปยาว 10 นาที", "เก็บวิดีโอ 14 วัน"];

const BRAND = "linear-gradient(120deg,#8b5cf6,#22d3ee)";
const HEAD = { fontFamily: "'Bai Jamjuree', sans-serif" } as const;

export function PricingToggle({ proPrice, businessPrice }: { proPrice: number; businessPrice: number }) {
  const [period, setPeriod] = useState<Period>("yearly");
  const yearly = period === "yearly";
  const proAmt = yearly ? proPrice * 10 : proPrice;
  const bizAmt = yearly ? businessPrice * 10 : businessPrice;

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
          <span className="ml-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/15 px-1.5 py-0.5 text-[11px] text-emerald-300">
            ประหยัด 2 เดือน
          </span>
        </button>
      </div>

      <div className="grid gap-4 text-left md:grid-cols-3">
        <Tier name="FREE" amount="฿0" features={FREE_FEATURES} cta="เริ่มใช้ฟรี" ghost />
        <Tier
          name="PRO"
          amount={`฿${proAmt.toLocaleString()}`}
          unit={yearly ? "/ปี" : "/เดือน"}
          perm={yearly ? `≈ ฿${Math.round((proPrice * 10) / 12).toLocaleString()}/เดือน · ` : "เก็บรายเดือน ยกเลิกได้"}
          was={yearly ? `฿${(proPrice * 12).toLocaleString()}` : undefined}
          features={PRO_FEATURES}
          cta="เริ่มใช้ PRO"
          best
          badge="แนะนำ ⭐"
        />
        <Tier
          name="BUSINESS"
          amount={`฿${bizAmt.toLocaleString()}`}
          unit={yearly ? "/ปี" : "/เดือน"}
          perm={yearly ? `≈ ฿${Math.round((businessPrice * 10) / 12).toLocaleString()}/เดือน · ` : "เก็บรายเดือน"}
          was={yearly ? `฿${(businessPrice * 12).toLocaleString()}` : undefined}
          features={BUSINESS_FEATURES}
          cta="เลือก BUSINESS"
          ghost
        />
      </div>

      {/* payment reassurance chips */}
      <div className="mt-7 flex flex-wrap justify-center gap-2.5">
        {["💳 PromptPay", "💳 บัตร", "🛡️ คืนเงินใน 7 วัน", "🔁 จ่ายครั้งเดียว ไม่ตัดอัตโนมัติ"].map((c) => (
          <span key={c} className="rounded-full border border-cyan-400/35 bg-cyan-400/10 px-3.5 py-1.5 text-[13px] text-cyan-200">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function Tier({
  name, amount, unit, perm, was, features, cta, best, ghost, badge,
}: {
  name: string;
  amount: string;
  unit?: string;
  perm?: string;
  was?: string;
  features: string[];
  cta: string;
  best?: boolean;
  ghost?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-[22px] p-7 transition-transform hover:-translate-y-1 ${best ? "" : "border border-white/10 bg-white/[0.045]"}`}
      style={
        best
          ? {
              background: "linear-gradient(#07070f,#07070f) padding-box, linear-gradient(120deg,#8b5cf6,#22d3ee) border-box",
              border: "1.5px solid transparent",
              boxShadow: "0 0 60px -14px rgba(139,92,246,.6)",
            }
          : undefined
      }
    >
      {badge && (
        <span
          className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-1 text-[13px] font-bold text-white"
          style={{ ...HEAD, background: BRAND }}
        >
          {badge}
        </span>
      )}
      <h3 className="text-center text-[22px] font-bold" style={HEAD}>{name}</h3>
      <div className="mt-1 text-center">
        <span className="text-[42px] font-bold leading-none" style={HEAD}>{amount}</span>
        {unit && <span className="ml-1 text-[15px] text-[#a7adcc]">{unit}</span>}
      </div>
      <div className="min-h-5 text-center text-[13px] text-cyan-300">
        {perm}
        {was && <span className="text-[#a7adcc] line-through">{was}</span>}
      </div>
      <ul className="my-5 flex-1 space-y-1.5 text-[14.5px]">
        {features.map((f) => (
          <li key={f} className="flex gap-2 text-[#d5d9ee]">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" strokeWidth={3} aria-hidden />
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
    </div>
  );
}
