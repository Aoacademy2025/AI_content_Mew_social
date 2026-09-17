"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchMe } from "@/lib/use-me";
import { PAST_DUE_LINK } from "@/lib/past-due-dunning";

type Me = { plan: string; subStatus?: string | null; planExpiresAt?: string | null };
type BannerState = { tier: "PRO" | "BUSINESS"; stillEntitled: boolean };

/**
 * HERO-33 — shown while Stripe reports the subscription `past_due` (a renewal or
 * Committed-Trial first charge was declined). One click opens the Stripe portal to
 * update the card; if the portal cannot be opened the banner falls back to Settings →
 * Billing, where the same button lives. Copy follows pastDueReminderCopy(): while
 * `planExpiresAt` is still ahead the tier is intact, otherwise it has already lapsed.
 */
export function PastDueBanner() {
  const router = useRouter();
  const [state, setState] = useState<BannerState | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    fetchMe().then((d) => {
      const me = d as unknown as Me | null;
      if (!me || me.subStatus !== "past_due") return;
      const now = Date.now();
      const stillEntitled = (me.plan === "PRO" || me.plan === "BUSINESS")
        && !!me.planExpiresAt && new Date(me.planExpiresAt).getTime() > now;
      setState({ tier: me.plan === "BUSINESS" ? "BUSINESS" : "PRO", stillEntitled });
    }).catch(() => {});
  }, []);

  if (!state) return null;

  const text = state.stillEntitled
    ? `บัตรถูกปฏิเสธตอนต่ออายุ ${state.tier} — อัปเดตบัตรเพื่อใช้งานต่อไม่สะดุด`
    : `เก็บเงินไม่สำเร็จ สิทธิ์ ${state.tier} หยุดชั่วคราว — อัปเดตบัตรแล้วกลับมาใช้ได้ทันที`;

  async function openPortal() {
    setOpening(true);
    try {
      const res = await fetch("/api/payments/portal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string") {
        // Stripe-hosted page — a full navigation is the only way there.
        window.location.assign(data.url);
        return;
      }
      router.push(PAST_DUE_LINK);
    } catch {
      toast.error("เชื่อมต่อไม่ได้ — ลองใหม่จากหน้าตั้งค่า");
      router.push(PAST_DUE_LINK);
    } finally {
      setOpening(false);
    }
  }

  return (
    <button
      type="button"
      onClick={openPortal}
      disabled={opening}
      data-testid="past-due-banner"
      className="flex w-full items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-70"
      style={{ background: "linear-gradient(90deg,#DC2626,#B45309)" }}
    >
      {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" strokeWidth={2.5} />}
      <span>{text}</span>
      <span className="inline-flex items-center gap-1 underline underline-offset-2">
        อัปเดตบัตร <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    </button>
  );
}
