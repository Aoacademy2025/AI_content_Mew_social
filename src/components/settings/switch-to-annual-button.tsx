"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Monthly → annual for an ordinary subscriber (#302).
 *
 * Checkout refuses to mint a second subscription for someone who already has one, and the
 * generic billing portal shows nothing to switch with, so this used to be a dead end — a
 * paying customer wrote in saying "อยากซื้อรายปี ทำอะไรไม่ได้เลย". Rendered only for the
 * accounts the server route will actually accept, so it never becomes a button that errors.
 */
export function SwitchToAnnualButton() {
  const [eligible, setEligible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => {
        if (cancelled || !me) return;
        setEligible(
          me.subStatus === "active"
          && me.billingPeriod === "monthly"
          && (me.plan === "PRO" || me.plan === "BUSINESS"),
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!eligible) return null;

  async function switchToAnnual() {
    setLoading(true);
    try {
      const res = await fetch("/api/payments/switch-annual", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        toast.error(data?.error ?? "เปลี่ยนเป็นรายปีไม่สำเร็จ กรุณาลองใหม่");
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error("เชื่อมต่อไม่ได้");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={switchToAnnual}
      disabled={loading}
      className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-all hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: "hsl(var(--accent-primary) / 0.10)",
        border: "1px solid hsl(var(--accent-primary) / 0.28)",
        color: "var(--ui-text-primary)",
      }}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" strokeWidth={2} />}
      เปลี่ยนเป็นรายปี — จ่ายถูกลงต่อเดือน
    </button>
  );
}
