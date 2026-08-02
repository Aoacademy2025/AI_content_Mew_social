"use client";

import { useState } from "react";
import { toast } from "sonner";
import { fetchClientJson } from "@/lib/client-request-cache";
import { authenticatedFetch } from "@/lib/authenticated-fetch";

/**
 * Minute-quota + credit-overflow domain — extracted verbatim from page.tsx
 * (P1 behavior-preserving move). Shared by the legacy editor and Editor v2.
 */

// Credit overflow is build-baked OFF unless NEXT_PUBLIC_CREDITS_LIVE==="1". With it unset
// this is the literal `false`, so every guarded branch stays dead → page byte-identical.
export const CREDITS_LIVE_CLIENT = process.env.NEXT_PUBLIC_CREDITS_LIVE === "1";

export function useCreditsQuota() {
  // Bumped after render or burn completes so QuotaStatus re-fetches the updated balance
  const [quotaRefresh, setQuotaRefresh] = useState(0);
  // Credits overflow (NEXT_PUBLIC_CREDITS_LIVE): true when the render wall is hit AND
  // credits are also empty (canBuyCredits) → render a [ซื้อเครดิต] CTA in the error UI.
  const [outOfMinutes, setOutOfMinutes] = useState(false);

  /** Start a Stripe checkout for a credit pack and redirect to it. */
  async function buyCredits(pack: "starter" | "popular" | "pro" = "popular") {
    try {
      const res = await authenticatedFetch("/api/payments/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack }),
      });
      const data = await res.json();
      if (data?.url) window.location.href = data.url as string;
      else toast.error("เปิดหน้าซื้อเครดิตไม่สำเร็จ — กรุณาลองใหม่");
    } catch {
      toast.error("เปิดหน้าซื้อเครดิตไม่สำเร็จ — กรุณาลองใหม่");
    }
  }

  /**
   * Post-render receipt for a credit-funded (overflow) render: shows how many credits
   * were spent + the remaining balance (fetched separately, since the queue render path
   * carries no balance), plus a low-balance nudge. No-op unless credits are live and
   * the render actually spent credits.
   */
  async function fireCreditReceipt(creditsSpent: number | null | undefined) {
    if (!CREDITS_LIVE_CLIENT) return;
    const spent = Number(creditsSpent);
    if (!Number.isFinite(spent) || spent <= 0) return;
    let left: number | null = null;
    try {
      const result = await fetchClientJson<{ total?: number }>("/api/credits/balance");
      const b = result.ok ? result.data : null;
      left = typeof b?.total === "number" ? b.total : null;
    } catch { /* balance fetch is best-effort — still show the spend */ }
    toast(`ใช้ ${spent} เครดิต (฿${spent})${left != null ? ` · เหลือ ${left} เครดิต` : ""}`);
    if (left != null && left < 20) {
      toast("เครดิตใกล้หมด เติมเลยไหม?", { action: { label: "ซื้อเครดิต", onClick: () => buyCredits() } });
    }
  }

  return {
    quotaRefresh, setQuotaRefresh,
    outOfMinutes, setOutOfMinutes,
    buyCredits, fireCreditReceipt,
  };
}
