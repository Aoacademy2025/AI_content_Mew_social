"use client";

import { useState } from "react";
import { Settings2, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Opens the Stripe Billing Portal (manage / cancel / update card) for users on a card subscription.
export function ManageSubscriptionButton() {
  const [loading, setLoading] = useState(false);

  async function openPortal() {
    setLoading(true);
    try {
      const res = await fetch("/api/payments/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(
          data.error === "No subscription to manage"
            ? "คุณยังไม่มีการสมัครแบบต่ออัตโนมัติ (เฉพาะลูกค้าที่จ่ายด้วยบัตร)"
            : (data.error ?? "เกิดข้อผิดพลาด"),
        );
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
      onClick={openPortal}
      disabled={loading}
      className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-all hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: "hsl(0 0% 100% / 0.03)", border: "1px solid hsl(0 0% 100% / 0.08)", color: "var(--ui-text-secondary)" }}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" strokeWidth={2} />}
      จัดการการสมัคร / วิธีชำระเงิน
    </button>
  );
}
