"use client";

import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Ticket, Plus, Trash2, Loader2, RefreshCw, Crown, Copy } from "lucide-react";
import { toast } from "sonner";

interface Coupon {
  id: string;
  code: string;
  plan: "FREE" | "PRO";
  durationDays: number;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  _count: { redemptions: number };
}

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
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">จัดการคูปอง</h1>
            <p className="text-sm text-zinc-400">สร้างและจัดการรหัสคูปองสำหรับอัปเกรดแผน</p>
          </div>
          <Button variant="ghost" size="sm" onClick={fetchCoupons} disabled={loading} className="gap-2 text-zinc-400 hover:text-white">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Create form */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Plus className="h-4 w-4 text-yellow-400" />
            <h2 className="text-sm font-semibold text-white">สร้างคูปองใหม่</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Code */}
            <div className="lg:col-span-2">
              <label className="mb-1 block text-xs text-zinc-400">รหัสคูปอง</label>
              <div className="flex gap-2">
                <input
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                  placeholder="เช่น PROMO2025"
                  className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-mono uppercase text-white outline-none focus:border-yellow-500/50"
                />
                <Button size="sm" variant="ghost" onClick={generateCode} className="text-xs text-zinc-400 hover:text-white whitespace-nowrap">
                  สุ่มรหัส
                </Button>
              </div>
            </div>

            {/* Plan */}
            <div>
              <label className="mb-1 block text-xs text-zinc-400">แผน</label>
              <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none">
                <option value="PRO">PRO</option>
                <option value="FREE">FREE</option>
              </select>
            </div>

            {/* Duration */}
            <div>
              <label className="mb-1 block text-xs text-zinc-400">ระยะเวลา (วัน) — 0 = ถาวร</label>
              <input type="number" min="0" value={form.durationDays}
                onChange={e => setForm(f => ({ ...f, durationDays: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-yellow-500/50"
              />
            </div>

            {/* Max uses */}
            <div>
              <label className="mb-1 block text-xs text-zinc-400">จำนวนครั้งที่ใช้ได้</label>
              <input type="number" min="1" value={form.maxUses}
                onChange={e => setForm(f => ({ ...f, maxUses: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-yellow-500/50"
              />
            </div>

            {/* Expires at */}
            <div>
              <label className="mb-1 block text-xs text-zinc-400">หมดอายุวันที่ (ว่าง = ไม่มีกำหนด)</label>
              <input type="date" value={form.expiresAt}
                onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-yellow-500/50"
              />
            </div>
          </div>

          <Button onClick={createCoupon} disabled={creating} className="mt-4 gap-2 bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/30">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ticket className="h-4 w-4" />}
            สร้างคูปอง
          </Button>
        </div>

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-zinc-600" /></div>
        ) : coupons.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/5 py-12 text-center text-sm text-zinc-500">ยังไม่มีคูปอง</div>
        ) : (
          <div className="space-y-2">
            {coupons.map(c => {
              const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
              const full = c.maxUses > 0 && c.usedCount >= c.maxUses;
              return (
                <div key={c.id} className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${expired || full ? "border-red-500/20 bg-red-500/5" : "border-white/10 bg-white/5"}`}>
                  {/* Code */}
                  <div className="flex items-center gap-2 min-w-[160px]">
                    <span className="font-mono text-sm font-bold text-white">{c.code}</span>
                    <button onClick={() => { navigator.clipboard.writeText(c.code); toast.success("คัดลอกแล้ว"); }}
                      className="text-zinc-600 hover:text-zinc-300 transition-colors">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Plan */}
                  <span className="flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs font-medium text-yellow-400">
                    <Crown className="h-3 w-3" />{c.plan}
                  </span>

                  {/* Duration */}
                  <span className="text-xs text-zinc-400">
                    {c.durationDays === 0 ? "ถาวร" : `${c.durationDays} วัน`}
                  </span>

                  {/* Usage */}
                  <span className={`text-xs ${full ? "text-red-400" : "text-zinc-400"}`}>
                    ใช้แล้ว {c.usedCount}/{c.maxUses === 0 ? "∞" : c.maxUses}
                  </span>

                  {/* Expiry */}
                  {c.expiresAt && (
                    <span className={`text-xs ${expired ? "text-red-400" : "text-zinc-500"}`}>
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
    </DashboardLayout>
  );
}
