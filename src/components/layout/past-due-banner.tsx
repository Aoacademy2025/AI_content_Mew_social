"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchMe } from "@/lib/use-me";
import { PAST_DUE_LINK, pastDueReminderLink } from "@/lib/past-due-dunning";

type Me = {
  plan: string;
  subStatus?: string | null;
  planExpiresAt?: string | null;
  billingPeriod?: string | null;
};
type BannerState = { tier: "PRO" | "BUSINESS"; stillEntitled: boolean; billingPeriod: string | null };

/**
 * HERO-33 — shown while Stripe reports the subscription `past_due` (a renewal or
 * Committed-Trial first charge was declined). One click opens the Stripe portal to
 * update the card; if the portal cannot be opened the banner falls back to Settings →
 * Billing, where the same button lives. Copy follows pastDueReminderCopy(): while
 * `planExpiresAt` is still ahead the tier is intact, otherwise it has already lapsed.
 *
 * `promptpayMonthly` (ADR 0066) is the PROMPTPAY_MONTHLY flag, read server-side by the
 * (dashboard) layout and passed down as a prop — this component has no env access.
 */
export function PastDueBanner({ promptpayMonthly = false }: { promptpayMonthly?: boolean }) {
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
      setState({
        tier: me.plan === "BUSINESS" ? "BUSINESS" : "PRO",
        stillEntitled,
        billingPeriod: me.billingPeriod ?? null,
      });
    }).catch(() => {});
  }, []);

  if (!state) return null;

  const text = state.stillEntitled
    ? `บัตรถูกปฏิเสธตอนต่ออายุ ${state.tier} — อัปเดตบัตรเพื่อใช้งานต่อไม่สะดุด`
    : `เก็บเงินไม่สำเร็จ สิทธิ์ ${state.tier} หยุดชั่วคราว — อัปเดตบัตรแล้วกลับมาใช้ได้ทันที`;
  // Always the not-entitled pricing link (Copy: "same link as the row above"),
  // regardless of this account's current entitlement — PromptPay is offered as an
  // instant alternative to fixing the card either way.
  const promptpayLink = promptpayMonthly
    ? pastDueReminderLink({ stillEntitled: false, plan: state.tier, billingPeriod: state.billingPeriod, promptpayMonthly: true })
    : null;

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
    <div
      data-testid="past-due-banner"
      className="flex w-full flex-col items-center gap-1 px-4 py-2 text-white"
      style={{ background: "linear-gradient(90deg,#DC2626,#B45309)" }}
    >
      <button
        type="button"
        onClick={openPortal}
        disabled={opening}
        data-testid="past-due-banner-update-card"
        className="flex w-full items-center justify-center gap-2 text-sm font-semibold transition hover:brightness-110 disabled:opacity-70"
      >
        {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" strokeWidth={2.5} />}
        <span>{text}</span>
        <span className="inline-flex items-center gap-1 underline underline-offset-2">
          อัปเดตบัตร <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      </button>
      {promptpayLink && (
        <button
          type="button"
          onClick={() => router.push(promptpayLink)}
          data-testid="past-due-banner-promptpay"
          className="text-xs font-medium underline underline-offset-2 opacity-90 hover:opacity-100"
        >
          หรือจ่ายด้วย PromptPay
        </button>
      )}
    </div>
  );
}
