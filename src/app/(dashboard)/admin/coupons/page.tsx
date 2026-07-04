"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Ticket, Plus, Trash2, Loader2, RefreshCw, Crown, Copy, Building2, Gift } from "lucide-react";
import { toast } from "sonner";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see admin/page.tsx + admin/users/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";
// Flat v2 card surface — inline var(--ui-*), matches settings/admin (no .ve-card helper)
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };
const inputStyle = "w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30";

interface Coupon {
  id: string;
  code: string;
  plan: "FREE" | "PRO" | "BUSINESS";
  durationDays: number;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  _count: { redemptions: number };
}

const PLAN_STYLES: Record<Coupon["plan"], { bg: string; text: string; Icon: React.ElementType }> = {
  FREE: { bg: "bg-zinc-500/15", text: "text-zinc-400", Icon: Gift },
  PRO: { bg: "bg-violet-500/10", text: "text-violet-300", Icon: Crown },
  BUSINESS: { bg: "bg-violet-500/20", text: "text-violet-200", Icon: Building2 },
};

export default function AdminCouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    code: "",
    plan: "PRO",
    durationDays: "30",
    maxUses: "1",
    expiresAt: "",
  });

  const fetchCoupons = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/coupons")
      .then(r => r.json())
      .then(d => setCoupons(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchCoupons(); }, [fetchCoupons]);

  function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    setForm(f => ({ ...f, code }));
  }

  async function createCoupon() {
    if (!form.code.trim()) { toast.error("กรุณากรอกรหัสคูปอง"); return; }
    setCreating(true);
    try {
      const res = await fetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code,
          plan: form.plan,
          durationDays: Number(form.durationDays),
          maxUses: Number(form.maxUses),
          expiresAt: form.expiresAt || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "เกิดข้อผิดพลาด"); return; }
      toast.success("สร้างคูปองสำเร็จ");
      setForm({ code: "", plan: "PRO", durationDays: "30", maxUses: "1", expiresAt: "" });
      fetchCoupons();
    } finally {
      setCreating(false);
    }
  }

  async function deleteCoupon(id: string) {
    const res = await fetch("/api/admin/coupons", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) { toast.success("ลบคูปองแล้ว"); setCoupons(prev => prev.filter(c => c.id !== id)); }
    else toast.error("ลบไม่สำเร็จ");
  }

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-3 md:pt-4 pb-12 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
              Admin · Coupons
            </p>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
              จัดการคูปอง
            </h1>
            <p className="text-sm mt-1" style={{ color: "var(--ui-text-secondary)" }}>สร้างและจัดการรหัสคูปองสำหรับอัปเกรดแผน</p>
          </div>
          <Button variant="ghost" size="sm" onClick={fetchCoupons} disabled={loading} className="gap-2 text-zinc-400 hover:text-white">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Create form */}
        <div className="rounded-xl p-5" style={cardStyle}>
          <div className="flex items-center gap-2 mb-4">
            <Plus className="h-4 w-4" style={{ color: VIOLET }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>สร้างคูปองใหม่</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Code */}
            <div className="lg:col-span-2">
              <label className="mb-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>รหัสคูปอง</label>
              <div className="flex gap-2">
                <input
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                  placeholder="เช่น PROMO2025"
                  className={`flex-1 font-mono uppercase ${inputStyle}`}
                  style={{ color: "var(--ui-text-primary)" }}
                />
                <Button size="sm" variant="ghost" onClick={generateCode} className="text-xs text-zinc-400 hover:text-white whitespace-nowrap">
                  สุ่มรหัส
                </Button>
              </div>
            </div>

            {/* Plan */}
            <div>
              <label className="mb-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>แผน</label>
              <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}
                className={inputStyle}
                style={{ color: "var(--ui-text-primary)", background: "var(--ui-card-bg-3)" }}>
                <option value="PRO">PRO</option>
                <option value="BUSINESS">BUSINESS</option>
                <option value="FREE">FREE</option>
              </select>
            </div>

            {/* Duration */}
            <div>
              <label className="mb-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>ระยะเวลา (วัน) — 0 = ถาวร</label>
              <input type="number" min="0" value={form.durationDays}
                onChange={e => setForm(f => ({ ...f, durationDays: e.target.value }))}
                className={inputStyle}
                style={{ color: "var(--ui-text-primary)" }}
              />
            </div>

            {/* Max uses */}
            <div>
              <label className="mb-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>จำนวนครั้งที่ใช้ได้</label>
              <input type="number" min="1" value={form.maxUses}
                onChange={e => setForm(f => ({ ...f, maxUses: e.target.value }))}
                className={inputStyle}
                style={{ color: "var(--ui-text-primary)" }}
              />
            </div>

            {/* Expires at */}
            <div>
              <label className="mb-1 block text-xs" style={{ color: "var(--ui-text-muted)" }}>หมดอายุวันที่ (ว่าง = ไม่มีกำหนด)</label>
              <input type="date" value={form.expiresAt}
                onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                className={inputStyle}
                style={{ color: "var(--ui-text-primary)" }}
              />
            </div>
          </div>

          <Button onClick={createCoupon} disabled={creating} className="mt-4 gap-2 text-white transition-all hover:brightness-110" style={{ background: VIOLET_GRAD }}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ticket className="h-4 w-4" />}
            สร้างคูปอง
          </Button>
        </div>

        {/* List */}
        {loading ? null : coupons.length === 0 ? (
          <div className="rounded-xl py-12 text-center text-sm text-zinc-500" style={cardStyle}>ยังไม่มีคูปอง</div>
        ) : (
          <div className="space-y-2">
            {coupons.map(c => {
              const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
              const full = c.maxUses > 0 && c.usedCount >= c.maxUses;
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl px-4 py-3"
                  style={expired || full ? { background: "hsl(0 70% 50% / 0.05)", border: "1px solid hsl(0 70% 55% / 0.25)" } : cardStyle}>
                  {/* Code */}
                  <div className="flex items-center gap-2 min-w-[160px]">
                    <span className="font-mono text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>{c.code}</span>
                    <button onClick={() => { navigator.clipboard.writeText(c.code); toast.success("คัดลอกแล้ว"); }}
                      className="text-zinc-600 hover:text-zinc-300 transition-colors">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Plan */}
                  {(() => {
                    const ps = PLAN_STYLES[c.plan] ?? PLAN_STYLES.FREE;
                    const { Icon } = ps;
                    return (
                      <span className={`flex items-center gap-1 rounded-full ${ps.bg} px-2 py-0.5 text-xs font-medium ${ps.text}`}>
                        <Icon className="h-3 w-3" />{c.plan}
                      </span>
                    );
                  })()}

                  {/* Duration */}
                  <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                    {c.durationDays === 0 ? "ถาวร" : `${c.durationDays} วัน`}
                  </span>

                  {/* Usage */}
                  <span className="text-xs" style={full ? { color: "hsl(0 70% 65%)" } : { color: "var(--ui-text-muted)" }}>
                    ใช้แล้ว {c.usedCount}/{c.maxUses === 0 ? "∞" : c.maxUses}
                  </span>

                  {/* Expiry */}
                  {c.expiresAt && (
                    <span className="text-xs" style={expired ? { color: "hsl(0 70% 65%)" } : { color: "var(--ui-text-muted)" }}>
                      {expired ? "หมดอายุ" : "หมดอายุ"} {new Date(c.expiresAt).toLocaleDateString("th-TH")}
                    </span>
                  )}

                  {(expired || full) && (
                    <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-400">
                      {expired ? "หมดอายุ" : "ใช้ครบแล้ว"}
                    </span>
                  )}

                  <div className="ml-auto">
                    <Button size="sm" variant="ghost" onClick={() => deleteCoupon(c.id)}
                      className="h-7 w-7 p-0 text-zinc-600 hover:text-red-400">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
