"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, CheckCircle2, Banknote, Ban } from "lucide-react";

// House tokens — match the other /admin billing cards (see admin/page.tsx).
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const cardStyle: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};
const inputCls =
  "w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-violet-500/50";

type Plan = "PRO" | "BUSINESS";
type Period = "monthly" | "annual";

type ManualItem = {
  id: string;
  email: string;
  plan: string;
  amountBaht: number;
  billingPeriod: Period;
  paidAt: string | null;
  note: string | null;
  recordedBy: string | null;
  status: string;
};

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export default function ManualPaymentPanel({
  proPrice = 599,
  businessPrice = 990,
}: {
  proPrice?: number;
  businessPrice?: number;
}) {
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<Plan>("PRO");
  const [billingPeriod, setBillingPeriod] = useState<Period>("monthly");
  const [amountBaht, setAmountBaht] = useState<string>(String(proPrice));
  const [amountDirty, setAmountDirty] = useState(false);
  const [paidDate, setPaidDate] = useState<string>(todayStr());
  const [note, setNote] = useState("");
  const [grantPlan, setGrantPlan] = useState(true);
  const [markFounder, setMarkFounder] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [items, setItems] = useState<ManualItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // Suggested price: monthly = plan list price; annual = plan price × 10 (2 months free).
  // Re-fills the amount whenever plan/period change UNLESS the admin has hand-edited it
  // (founder pays ~half → they override, and we keep their number).
  const suggested = (billingPeriod === "annual" ? 10 : 1) * (plan === "BUSINESS" ? businessPrice : proPrice);
  useEffect(() => {
    if (!amountDirty) setAmountBaht(String(suggested));
  }, [suggested, amountDirty]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/admin/manual-payment", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.items)) setItems(data.items);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function submit() {
    if (!email.trim()) return toast.error("ใส่อีเมลผู้ใช้ก่อน");
    const amt = Number(amountBaht);
    if (!Number.isFinite(amt) || amt <= 0) return toast.error("จำนวนเงินต้องมากกว่า 0");
    if (!note.trim()) return toast.error("ใส่หมายเหตุก่อน (เช่น โอนธนาคาร / founder)");

    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/manual-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          plan,
          billingPeriod,
          amountBaht: amt,
          paidAtMs: new Date(paidDate).getTime(),
          note: note.trim(),
          setPlan: grantPlan,
          markFounder,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "บันทึกไม่สำเร็จ");
        return;
      }
      toast.success("บันทึกแล้ว");
      setEmail("");
      setNote("");
      setMarkFounder(false);
      await loadList();
    } catch {
      toast.error("เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง");
    } finally {
      setSubmitting(false);
    }
  }

  async function voidPayment(id: string) {
    if (!confirm("ยืนยัน void รายการนี้?\nเงินจะถูกตัดออกจาก จ่ายจริง/MRR/cash (plan/founder ที่เซ็ตไว้จะไม่ถูกย้อน)")) return;
    setVoidingId(id);
    try {
      const res = await fetch(`/api/admin/manual-payment/${id}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "void ไม่สำเร็จ");
        return;
      }
      toast.success("void แล้ว");
      await loadList();
    } catch {
      toast.error("เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง");
    } finally {
      setVoidingId(null);
    }
  }

  const fmtBaht = (n: number) => "฿" + n.toLocaleString("th-TH");
  const fmtDate = (s: string | null) =>
    s ? new Date(s).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }) : "—";

  return (
    <div className="rounded-xl p-4 space-y-5" style={cardStyle}>
      <div>
        <div className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-white">บันทึกการจ่ายนอกระบบ (Manual Payment)</h2>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          บันทึกเงินที่รับนอก Stripe (โอนธนาคาร / จ่ายตรง) ให้ผู้ใช้นับใน จ่ายจริง / MRR / cash-in
          โดยไม่ต้องแก้ DB เอง
        </p>
      </div>

      {/* ── Form ─────────────────────────────────────────────────────── */}
      <div className="grid gap-3">
        <div>
          <label className="mb-1 block text-xs text-zinc-400">อีเมลผู้ใช้ (ปลายทาง)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            className={inputCls + " font-mono"}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">แผน</label>
            <select value={plan} onChange={(e) => setPlan(e.target.value as Plan)} className={inputCls}>
              <option value="PRO">PRO</option>
              <option value="BUSINESS">BUSINESS</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">รอบบิล</label>
            <select
              value={billingPeriod}
              onChange={(e) => setBillingPeriod(e.target.value as Period)}
              className={inputCls}
            >
              <option value="monthly">รายเดือน (monthly)</option>
              <option value="annual">รายปี (annual)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              จำนวนเงิน (฿) <span className="text-zinc-600">· แนะนำ {fmtBaht(suggested)}</span>
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={amountBaht}
              onChange={(e) => {
                setAmountDirty(true);
                setAmountBaht(e.target.value);
              }}
              placeholder="0"
              className={inputCls + " font-mono"}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">วันที่จ่าย</label>
            <input
              type="date"
              value={paidDate}
              max={todayStr()}
              onChange={(e) => setPaidDate(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-zinc-400">หมายเหตุ (บังคับ)</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="เช่น โอนธนาคาร · founder"
            className={inputCls}
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={grantPlan} onChange={(e) => setGrantPlan(e.target.checked)} className="accent-violet-500" />
            เซ็ต plan + วันหมดอายุให้ user
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={markFounder} onChange={(e) => setMarkFounder(e.target.checked)} className="accent-violet-500" />
            นับเป็น founder (bump FOUNDING100)
          </label>
        </div>

        <div className="flex justify-end">
          <button
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ background: VIOLET_GRAD }}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            บันทึกการจ่าย
          </button>
        </div>
      </div>

      {/* ── List ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">รายการที่บันทึกไว้</h3>
          {loadingList && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
        </div>

        {items.length === 0 && !loadingList ? (
          <p className="py-4 text-center text-xs text-zinc-600">ยังไม่มีรายการ manual payment</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--ui-card-border)] text-zinc-500">
                  <th className="py-2 pr-3 font-medium">อีเมล</th>
                  <th className="py-2 pr-3 font-medium">แผน</th>
                  <th className="py-2 pr-3 font-medium">฿</th>
                  <th className="py-2 pr-3 font-medium">รอบ</th>
                  <th className="py-2 pr-3 font-medium">วันที่จ่าย</th>
                  <th className="py-2 pr-3 font-medium">หมายเหตุ</th>
                  <th className="py-2 pr-3 font-medium">สถานะ</th>
                  <th className="py-2 pr-0 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const voided = it.status === "VOIDED";
                  return (
                    <tr
                      key={it.id}
                      className="border-b border-[var(--ui-card-border)]/50"
                      style={voided ? { opacity: 0.45 } : undefined}
                    >
                      <td className="py-2 pr-3 font-mono text-zinc-300" title={it.recordedBy ? `recordedBy: ${it.recordedBy}` : undefined}>
                        {it.email}
                      </td>
                      <td className="py-2 pr-3 text-zinc-300">{it.plan}</td>
                      <td className="py-2 pr-3 font-mono text-zinc-300">{fmtBaht(it.amountBaht)}</td>
                      <td className="py-2 pr-3 text-zinc-400">{it.billingPeriod === "annual" ? "รายปี" : "รายเดือน"}</td>
                      <td className="py-2 pr-3 text-zinc-400">{fmtDate(it.paidAt)}</td>
                      <td className="py-2 pr-3 text-zinc-400">{it.note || "—"}</td>
                      <td className="py-2 pr-3">
                        {voided ? (
                          <span className="rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">VOIDED</span>
                        ) : (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">PAID</span>
                        )}
                      </td>
                      <td className="py-2 pr-0 text-right">
                        {!voided && (
                          <button
                            onClick={() => voidPayment(it.id)}
                            disabled={voidingId === it.id}
                            className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-40"
                          >
                            {voidingId === it.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
                            void
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-zinc-600">
          void ลบเฉพาะบันทึกเงิน (ออกจาก จ่ายจริง/MRR/cash) — plan/founder ที่เซ็ตไว้ต้องปรับที่ /admin/users เอง
        </p>
      </div>
    </div>
  );
}
