"use client";

import { useState } from "react";
import { Ticket, Loader2, Crown } from "lucide-react";
import { toast } from "sonner";

type ValidatedCoupon = { code: string; type: "GRANT" | "DISCOUNT"; plan: string; percentOff: number | null; discountDuration: string | null; durationDays: number };

export function CouponBox({ onDiscountApplied, variant = "card" }: { onDiscountApplied?: (c: ValidatedCoupon) => void; variant?: "card" | "inline" } = {}) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function redeem() {
    if (!code.trim()) return;
    setLoading(true);
    try {
      const vr = await fetch("/api/coupons/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const v = await vr.json();
      if (!vr.ok) { toast.error(v.error ?? "รหัสคูปองไม่ถูกต้อง"); return; }

      if (v.type === "DISCOUNT") {
        if (!onDiscountApplied) { toast.message("ใช้โค้ดส่วนลดนี้ที่หน้าราคา"); return; }
        onDiscountApplied(v as ValidatedCoupon);
        toast.success(`ใช้ส่วนลด ${v.percentOff}% แล้ว`);
        setCode("");
        return;
      }

      // GRANT — the server decides activation, append, or promo-only atomically.
      const res = await fetch("/api/coupons/redeem", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "เกิดข้อผิดพลาด"); return; }
      toast.success(data.message);
      setCode("");
      window.location.reload();
    } finally {
      setLoading(false);
    }
  }

  // Compact inline variant (e.g. on the lean pricing page) — matches the violet CI.
  if (variant === "inline") {
    return (
      <div className="flex w-full gap-2">
        <input
          type="text"
          placeholder="กรอกโค้ดส่วนลด"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && redeem()}
          className="h-11 flex-1 rounded-full border border-white/12 bg-white/5 px-4 text-sm font-mono uppercase tracking-wider text-white outline-none transition placeholder:font-sans placeholder:tracking-normal placeholder:text-white/35 focus:border-violet-400/50 focus:ring-2 focus:ring-violet-500/25"
          autoFocus
        />
        <button
          onClick={redeem}
          disabled={loading || !code.trim()}
          className="inline-flex h-11 items-center gap-1.5 rounded-full px-6 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: "linear-gradient(120deg,#8b5cf6,#a78bfa)", boxShadow: "0 0 24px rgba(139,92,246,.4)" }}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "ใช้โค้ด"}
        </button>
      </div>
    );
  }

  return (
    <div className="pp-card p-7"><span aria-hidden className="pp-card-border" />
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "linear-gradient(135deg, hsl(258 90% 66% / 0.18), hsl(258 90% 66% / 0.08))",
            border: "1px solid hsl(258 90% 66% / 0.3)",
            boxShadow: "0 4px 14px hsl(258 90% 66% / 0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}>
          <Ticket className="h-5 w-5 text-violet-400" strokeWidth={2.25} />
        </div>
        <div className="flex-1 space-y-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              ใช้รหัสคูปอง
            </h2>
            <p className="text-sm mt-1" style={{ color: "var(--ui-text-muted)" }}>
              มีรหัสคูปองอยู่แล้ว? กรอกที่นี่เพื่อรับสิทธิ์ตามเงื่อนไขของคูปอง
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="PROMO2025"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && redeem()}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-mono uppercase tracking-wider outline-none transition-all focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50"
              style={{
                background: "hsl(0 0% 100% / 0.03)",
                border: "1px solid hsl(0 0% 100% / 0.08)",
                color: "var(--ui-text-primary)",
              }}
            />
            <button
              onClick={redeem}
              disabled={loading || !code.trim()}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 active:scale-[0.98]"
              style={{
                background: "linear-gradient(180deg, #8B66F8, #6C4CF4)",
                color: "#ffffff",
                boxShadow: "0 6px 20px hsl(258 90% 66% / 0.3), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crown className="h-4 w-4" strokeWidth={2.5} />}
              ใช้คูปอง
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
