"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchMe } from "@/lib/use-me";
import { hasScheduledCancellation, type CancellationState } from "@/lib/subscription-cancellation";

/**
 * The only way to stop a subscription from inside the product (HERO-24).
 *
 * Deliberately quiet: a muted text link, not a filled or red button, sitting under the
 * manage-subscription button. Present and pressable, nothing more. It hides once a
 * cancellation is scheduled, where ReactivateBanner takes over with the end date and the
 * undo, so the two controls are never on screen together.
 *
 * Confirms in place rather than through a native browser dialog, which blocks the page.
 */
export function CancelSubscriptionLink() {
  const [state, setState] = useState<(CancellationState & { plan?: string }) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchMe().then(d => { if (d) setState(d as CancellationState & { plan?: string }); }).catch(() => {});
  }, []);

  // No subscription to stop, or one already stopping.
  if (!state?.hasStripeSubscription) return null;
  if (hasScheduledCancellation(state)) return null;

  async function cancel() {
    setLoading(true);
    try {
      const res = await fetch("/api/payments/cancel-subscription", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "ทำรายการไม่สำเร็จ"); return; }
      // Re-read so the notice with the end date and the undo button appears immediately.
      const me = await fetchMe(true);
      setState(me as CancellationState & { plan?: string });
      toast.success("ยกเลิกการต่ออายุแล้ว ใช้งานได้ถึงวันสิ้นรอบ");
    } catch {
      toast.error("เชื่อมต่อไม่ได้");
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <div className="flex justify-center">
        <button
          onClick={() => setConfirming(true)}
          className="text-xs underline underline-offset-4 transition-colors hover:opacity-80"
          style={{ color: "var(--ui-text-muted)" }}
        >
          ยกเลิกการต่ออายุอัตโนมัติ
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
        ยกเลิกการต่ออายุ? ใช้งานได้ถึงวันสิ้นรอบที่จ่ายไว้แล้ว
      </span>
      <button
        onClick={cancel}
        disabled={loading}
        className="inline-flex items-center gap-1.5 text-xs font-semibold underline underline-offset-4 transition-colors hover:opacity-80 disabled:opacity-50"
        style={{ color: "var(--ui-text-secondary)" }}
      >
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        ยืนยันยกเลิก
      </button>
      <button
        onClick={() => setConfirming(false)}
        disabled={loading}
        className="text-xs underline underline-offset-4 transition-colors hover:opacity-80 disabled:opacity-50"
        style={{ color: "var(--ui-text-muted)" }}
      >
        ไม่ยกเลิก
      </button>
    </div>
  );
}
