"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { fetchMe } from "@/lib/use-me";

type Me = { plan: string; trialStartedAt: string | null; trialEndsAt: string | null; minuteQuota?: boolean };

// #300 — flag-gated: stop pushing an annual upgrade on the expired-trial banner once the
// in-app default checkout is recurring monthly+card. Build-baked, same pattern as pricing-client.tsx.
const PRICING_DEFAULT_RECURRING = process.env.NEXT_PUBLIC_PRICING_DEFAULT_RECURRING === "1";

export function TrialBanner() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetchMe().then(d => { if (d) setMe(d as unknown as Me); }).catch(() => {});
  }, []);

  if (!me) return null;

  const now = Date.now();
  const endsAt = me.trialEndsAt ? new Date(me.trialEndsAt).getTime() : 0;
  const trialing = endsAt > now;
  const ended = me.plan === "FREE" && !!me.trialStartedAt && !me.trialEndsAt;
  if (!trialing && !ended) return null;

  const daysLeft = trialing ? Math.ceil((endsAt - now) / (24 * 60 * 60 * 1000)) : 0;
  const minuteNote = me.minuteQuota ? " · 15 นาที ใน 7 วัน" : "";
  const expiredText = PRICING_DEFAULT_RECURRING
    ? "สมัคร PRO เพื่อใช้ต่อไม่สะดุด"
    : "ทดลอง PRO หมดแล้ว — อัปเกรดรายปีรับราคาพิเศษ";
  const text = trialing ? `ทดลอง PRO เหลืออีก ${daysLeft} วัน${minuteNote}` : expiredText;
  const href = !trialing && PRICING_DEFAULT_RECURRING ? "/pricing?source=trial_banner" : "/pricing";

  return (
    <Link
      href={href}
      className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
      style={{ background: "linear-gradient(90deg,#8B66F8,#6C4CF4)" }}
    >
      <Sparkles className="h-4 w-4" strokeWidth={2.5} />
      <span>{text}</span>
      <span className="inline-flex items-center gap-1 underline underline-offset-2">
        {trialing ? "อัปเกรดเลย" : "ดูแพ็กเกจ"} <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    </Link>
  );
}
