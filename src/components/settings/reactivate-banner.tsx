"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchMe } from "@/lib/use-me";
import {
  cancellationDateLabel,
  hasScheduledCancellation,
  type CancellationState,
} from "@/lib/subscription-cancellation";

type SubState = CancellationState & { plan?: string };

// Shows when a card subscription is scheduled to cancel; lets the user undo it in-app.
// Renders nothing when there is no scheduled cancellation.
//
// HERO-20: this used to gate on `cancelAtPeriodEnd` alone. Stripe reports the
// schedule as a `cancel_at` date instead, so the boolean was false for every
// production subscriber and this banner had never rendered for anyone. Both
// shapes now go through the shared reader.
export function ReactivateBanner() {
  const [state, setState] = useState<SubState | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchMe().then(d => { if (d) setState(d as SubState); }).catch(() => {});
  }, []);

  if (!hasScheduledCancellation(state)) return null;

  const plan = state?.plan ?? "PRO";
  const dateLabel = cancellationDateLabel(state);

  async function reactivate() {
    setLoading(true);
    try {
      const res = await fetch("/api/payments/reactivate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "ทำรายการไม่สำเร็จ"); return; }
      // Clear both shapes, or the banner would stay up on the shape we did not clear.
      setState(s => (s ? { ...s, cancelAtPeriodEnd: false, cancelAt: null } : s));
      toast.success(`ใช้แพ็ก ${plan} ต่อแล้ว — ยกเลิกการยกเลิกเรียบร้อย`);
    } catch {
      toast.error("เชื่อมต่อไม่ได้");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center"
      style={{ background: "hsl(38 92% 50% / 0.08)", border: "1px solid hsl(38 92% 50% / 0.3)" }}
    >
      <AlertTriangle className="h-5 w-5 shrink-0" style={{ color: "hsl(38 92% 55%)" }} strokeWidth={2.25} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>
          แพ็ก {plan} จะยกเลิกวันที่ {dateLabel}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
          ใช้งานได้ถึงวันนั้น — กดด้านขวาเพื่อใช้ต่อแบบต่ออัตโนมัติ
        </p>
      </div>
      <button
        onClick={reactivate}
        disabled={loading}
        className="flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        style={{ background: "hsl(38 92% 50%)", color: "#1a1205" }}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        ใช้ {plan} ต่อ
      </button>
    </div>
  );
}
