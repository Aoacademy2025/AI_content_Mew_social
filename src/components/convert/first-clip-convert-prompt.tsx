"use client";

import { useCallback, useEffect, useState } from "react";
import { Crown, X } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import type { FirstClipConvertDecision } from "@/lib/first-clip-convert";

const DISMISS_KEY = "first-clip-convert-dismissed-session";

function sessionStore() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function FirstClipConvertPrompt() {
  const [decision, setDecision] = useState<Extract<FirstClipConvertDecision, { show: true }> | null>(null);
  const [busy, setBusy] = useState<"monthly" | "annual" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (sessionStore()?.getItem(DISMISS_KEY) === "1") return;
    const res = await authenticatedFetch("/api/convert/first-clip");
    if (!res.ok) return;
    const data = await res.json() as FirstClipConvertDecision;
    if (data.show) setDecision(data);
    else setDecision(null);
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => { void load(); };
    const onCompleted = () => { void load(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("hero-first-clip-completed", onCompleted);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("hero-first-clip-completed", onCompleted);
    };
  }, [load]);

  function dismiss() {
    sessionStore()?.setItem(DISMISS_KEY, "1");
    setDecision(null);
  }

  async function checkout(period: "monthly" | "annual") {
    setBusy(period);
    setError(null);
    trackEvent("pricing_cta_clicked", {
      step: "first_clip_convert",
      properties: {
        period,
        founding: Boolean(decision?.founding),
        surface: "first_clip_convert_prompt",
      },
    });
    try {
      const body: { plan: "PRO"; period: "monthly" | "annual"; couponCode?: string } = {
        plan: "PRO",
        period,
      };
      if (period === "annual" && decision?.founding) body.couponCode = "FOUNDING100";
      const res = await authenticatedFetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error || "ไม่สามารถเปิดหน้าชำระเงินได้");
        setBusy(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("ไม่สามารถเปิดหน้าชำระเงินได้");
      setBusy(null);
    }
  }

  if (!decision) return null;

  const secondaryLabel = decision.founding
    ? `ซื้อรายปี Founding ฿${decision.founding.annualPriceThb.toLocaleString("th-TH")}`
    : `ซื้อรายปี ฿${decision.annualListThb.toLocaleString("th-TH")}`;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={dismiss} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-[#111118] p-6 shadow-2xl">
        <button
          type="button"
          onClick={dismiss}
          className="absolute right-4 top-4 text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="ปิด"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-4 flex justify-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ background: "linear-gradient(135deg, rgba(124,58,237,0.3), rgba(6,182,212,0.3))", border: "1px solid rgba(124,58,237,0.4)" }}
          >
            <Crown className="h-7 w-7 text-violet-400" />
          </div>
        </div>
        <h3 className="mb-2 text-center text-lg font-bold text-white">คลิปแรกออกแล้ว — สมัครต่อเลย</h3>
        <p className="mb-5 text-center text-sm leading-relaxed text-zinc-400">
          สมัครรายเดือนแบบต่ออายุอัตโนมัติ เพื่อใช้ Hero AI ต่อโดยไม่สะดุด หรือล็อกเรท Founding ทั้งปี
        </p>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void checkout("monthly")}
          className="w-full rounded-xl py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
          style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
        >
          {busy === "monthly" ? "กำลังเปิดหน้าชำระเงิน…" : `สมัครรายเดือน ฿${decision.monthlyPriceThb.toLocaleString("th-TH")}/เดือน`}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void checkout("annual")}
          className="mt-2 w-full rounded-xl border border-white/10 py-2.5 text-sm font-medium text-zinc-200 hover:bg-white/5 disabled:opacity-60"
        >
          {busy === "annual" ? "กำลังเปิดหน้าชำระเงิน…" : secondaryLabel}
        </button>
        {error && <p className="mt-3 text-center text-xs text-rose-300">{error}</p>}
        <button type="button" onClick={dismiss} className="mt-3 w-full py-2 text-xs text-zinc-500 hover:text-zinc-300">
          ไว้ทีหลัง
        </button>
      </div>
    </div>
  );
}
