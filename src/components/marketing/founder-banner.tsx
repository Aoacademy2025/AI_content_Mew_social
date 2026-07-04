"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Flame } from "lucide-react";

type FoundingStatus = { active: boolean; remaining: number; total: number; percentOff: number };

const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";

/**
 * Compact founder-urgency banner for the in-app dashboard. Shown ONLY to
 * non-paid users (FREE plan) while the founding promo still has seats left.
 * Mirrors the sale-page scarcity bar's copy/effect (house violet + 🔥 + glow),
 * but reads live status from /api/founding/status rather than server props.
 */
export function DashboardFounderBanner({ plan }: { plan: "FREE" | "PRO" | "BUSINESS" | undefined }) {
  const [status, setStatus] = useState<FoundingStatus | null>(null);

  useEffect(() => {
    if (plan !== "FREE") return;
    fetch("/api/founding/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, [plan]);

  if (plan !== "FREE" || !status || !status.active || status.remaining <= 0) return null;

  return (
    <div
      className="founder-glow ve-rise mb-6 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3"
      style={{ background: "rgba(139,92,246,.08)", border: "1px solid rgba(139,92,246,.30)" }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px]" style={{ background: VIOLET_GRAD }}>
        <Flame className="h-4 w-4 text-white" strokeWidth={2.5} aria-hidden />
      </div>
      <p className="min-w-0 flex-1 text-[13px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>
        🔥 ราคาผู้ก่อตั้ง — ลด {status.percentOff}% ตลอดชีพ · เหลือ {status.remaining}/{status.total} ที่นั่ง
      </p>
      <Link
        href="/pricing"
        className="shrink-0 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:brightness-110"
        style={{ background: VIOLET_GRAD }}
      >
        รับสิทธิ์
      </Link>
    </div>
  );
}
