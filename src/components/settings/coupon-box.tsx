"use client";

import { useState } from "react";
import { Ticket, Loader2, Crown } from "lucide-react";
import { toast } from "sonner";

export function CouponBox() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  async function redeem() {
    if (!code.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/coupons/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  return (
    <div className="pp-card p-7"><span aria-hidden className="pp-card-border" />
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "linear-gradient(135deg, hsl(45 100% 50% / 0.18), hsl(38 92% 55% / 0.08))",
            border: "1px solid hsl(45 100% 50% / 0.3)",
            boxShadow: "0 4px 14px hsl(45 100% 50% / 0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}>
          <Ticket className="h-5 w-5 text-yellow-400" strokeWidth={2.25} />
        </div>
        <div className="flex-1 space-y-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              ใช้รหัสคูปอง
            </h2>
            <p className="text-sm mt-1" style={{ color: "var(--ui-text-muted)" }}>
              มีรหัสคูปองอยู่แล้ว? กรอกที่นี่เพื่ออัปเกรดแผนการใช้งานทันที
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="PROMO2025"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && redeem()}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-mono uppercase tracking-wider outline-none transition-all focus:ring-2 focus:ring-yellow-500/30 focus:border-yellow-500/50"
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
                background: "linear-gradient(135deg, hsl(45 100% 55%), hsl(38 92% 55%))",
                color: "#1a1100",
                boxShadow: "0 6px 20px hsl(45 100% 50% / 0.3), inset 0 1px 0 rgba(255,255,255,0.2)",
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
