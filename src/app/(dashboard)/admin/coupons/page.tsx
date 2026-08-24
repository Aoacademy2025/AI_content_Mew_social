"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  Clock3,
  Copy,
  Crown,
  Download,
  Gift,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Save,
  ShieldCheck,
  Ticket,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";
const cardStyle: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};
const inputStyle = "w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30";

type Plan = "FREE" | "PRO" | "BUSINESS";
type CouponForm = {
  code: string;
  plan: "PRO" | "BUSINESS";
  durationDays: string;
  maxUses: string;
  expiresAt: string;
  promoCredits: string;
  promoCreditTtlDays: string;
  stackingPolicy: "SAFE_APPEND" | "REJECT_EXISTING";
  isActive: boolean;
};

interface Coupon {
  id: string;
  code: string;
  type: "GRANT" | "DISCOUNT";
  plan: Plan;
  durationDays: number;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  promoCredits: number;
  promoCreditTtlDays: number;
  stackingPolicy: "SAFE_APPEND" | "REJECT_EXISTING";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { redemptions: number };
  auditLogs: Array<{ id: string; action: string; actorUserId: string; createdAt: string }>;
}

interface CampaignReport {
  couponCode: string;
  refs: Array<{
    ref: string;
    signups: number;
    couponRedemptions: number;
    createdClips: number;
    paidConversions: number;
  }>;
  totals: { signups: number; couponRedemptions: number; createdClips: number; paidConversions: number };
  clicksAvailable: boolean;
  clicksNote: string;
}

const EMPTY_FORM: CouponForm = {
  code: "",
  plan: "PRO",
  durationDays: "30",
  maxUses: "500",
  expiresAt: "",
  promoCredits: "50",
  promoCreditTtlDays: "30",
  stackingPolicy: "SAFE_APPEND",
  isActive: true,
};

const PLAN_STYLES: Record<Plan, { bg: string; text: string; Icon: React.ElementType }> = {
  FREE: { bg: "bg-zinc-500/15", text: "text-zinc-400", Icon: Gift },
  PRO: { bg: "bg-violet-500/10", text: "text-violet-300", Icon: Crown },
  BUSINESS: { bg: "bg-violet-500/20", text: "text-violet-200", Icon: Building2 },
};

function bangkokLocalToIso(value: string) {
  if (!value) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return new Date(`${withSeconds}+07:00`).toISOString();
}

function isoToBangkokLocal(value: string | null) {
  if (!value) return "";
  const shifted = new Date(new Date(value).getTime() + 7 * 60 * 60 * 1_000);
  return shifted.toISOString().slice(0, 19);
}

function formatBangkok(value: string) {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formFromCoupon(coupon: Coupon): CouponForm {
  return {
    code: coupon.code,
    plan: coupon.plan === "BUSINESS" ? "BUSINESS" : "PRO",
    durationDays: String(coupon.durationDays),
    maxUses: String(coupon.maxUses),
    expiresAt: isoToBangkokLocal(coupon.expiresAt),
    promoCredits: String(coupon.promoCredits),
    promoCreditTtlDays: String(coupon.promoCreditTtlDays),
    stackingPolicy: coupon.stackingPolicy,
    isActive: coupon.isActive,
  };
}

function requestBody(form: CouponForm) {
  return {
    code: form.code,
    plan: form.plan,
    durationDays: Number(form.durationDays),
    maxUses: Number(form.maxUses),
    expiresAt: bangkokLocalToIso(form.expiresAt),
    promoCredits: Number(form.promoCredits),
    promoCreditTtlDays: Number(form.promoCreditTtlDays),
    stackingPolicy: form.stackingPolicy,
    isActive: form.isActive,
  };
}

function CouponFields({
  form,
  setForm,
  lockIdentity = false,
}: {
  form: CouponForm;
  setForm: React.Dispatch<React.SetStateAction<CouponForm>>;
  lockIdentity?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="lg:col-span-2">
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">รหัสคูปอง</label>
        <input
          value={form.code}
          disabled={lockIdentity}
          onChange={(event) => setForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))}
          placeholder="เช่น CLIP0819"
          className={`${inputStyle} font-mono uppercase disabled:cursor-not-allowed disabled:opacity-50`}
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">แผน</label>
        <select
          value={form.plan}
          disabled={lockIdentity}
          onChange={(event) => setForm((current) => ({ ...current, plan: event.target.value as CouponForm["plan"] }))}
          className={`${inputStyle} disabled:cursor-not-allowed disabled:opacity-50`}
          style={{ color: "var(--ui-text-primary)", background: "var(--ui-card-bg-3)" }}
        >
          <option value="PRO">PRO · 80 นาที / 50 monthly credits</option>
          <option value="BUSINESS">BUSINESS · 150 นาที / 150 monthly credits</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">ระยะเวลา · วัน</label>
        <input
          type="number"
          min="0"
          disabled={lockIdentity}
          value={form.durationDays}
          onChange={(event) => setForm((current) => ({ ...current, durationDays: event.target.value }))}
          className={`${inputStyle} disabled:cursor-not-allowed disabled:opacity-50`}
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">จำนวนสิทธิ์ · 0 = ไม่จำกัด</label>
        <input
          type="number"
          min="0"
          value={form.maxUses}
          onChange={(event) => setForm((current) => ({ ...current, maxUses: event.target.value }))}
          className={inputStyle}
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">หมดอายุ · เวลาไทย</label>
        <input
          type="datetime-local"
          step="1"
          value={form.expiresAt}
          onChange={(event) => setForm((current) => ({ ...current, expiresAt: event.target.value }))}
          className={inputStyle}
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">Promo credits</label>
        <input
          type="number"
          min="0"
          value={form.promoCredits}
          onChange={(event) => setForm((current) => ({ ...current, promoCredits: event.target.value }))}
          className={inputStyle}
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-[var(--ui-text-muted)]">Promo หมดอายุ · วัน</label>
        <input
          type="number"
          min="1"
          max="365"
          value={form.promoCreditTtlDays}
          onChange={(event) => setForm((current) => ({ ...current, promoCreditTtlDays: event.target.value }))}
          className={inputStyle}
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap gap-4 pt-1 text-xs text-[var(--ui-text-secondary)]">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={form.stackingPolicy === "SAFE_APPEND"}
            onChange={() => setForm((current) => ({ ...current, stackingPolicy: "SAFE_APPEND" }))}
          />
          ต่อท้ายสิทธิ์เดิมอย่างปลอดภัย
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={form.stackingPolicy === "REJECT_EXISTING"}
            onChange={() => setForm((current) => ({ ...current, stackingPolicy: "REJECT_EXISTING" }))}
          />
          ปฏิเสธบัญชีที่มีสิทธิ์อยู่แล้ว
        </label>
      </div>
    </div>
  );
}

export default function AdminCouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CouponForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CouponForm>(EMPTY_FORM);

  const fetchCoupons = useCallback(async () => {
    setLoading(true);
    try {
      const [couponResponse, reportResponse] = await Promise.all([
        fetch("/api/admin/coupons"),
        fetch("/api/admin/coupons/report?coupon=CLIP0819"),
      ]);
      const [couponData, reportData] = await Promise.all([couponResponse.json(), reportResponse.json()]);
      setCoupons(Array.isArray(couponData) ? couponData : []);
      setReport(reportResponse.ok ? reportData : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchCoupons(); }, [fetchCoupons]);

  const previewRows = useMemo(() => {
    const days = Number(form.durationDays) || 0;
    const promo = Number(form.promoCredits) || 0;
    const planCopy = `${form.plan} ${days === 0 ? "ถาวร" : `${days} วัน`}`;
    return [
      ["FREE / Trial", `${planCopy} · เริ่มรอบใหม่ทันที`],
      ["แผนมีวันหมดอายุ", form.stackingPolicy === "SAFE_APPEND" ? `ต่อ ${planCopy} หลังวันเดิม · +${promo} promo` : "ปฏิเสธ"],
      ["สิทธิ์ถาวร", promo > 0 ? `สิทธิ์เดิมไม่เปลี่ยน · +${promo} promo` : "ปฏิเสธ · ไม่มี benefit เพิ่ม"],
      ["Stripe ทุกสถานะ", promo > 0 ? `billing/แผน/วันเดิมไม่เปลี่ยน · +${promo} promo` : "ปฏิเสธ · ไม่มี benefit เพิ่ม"],
    ];
  }, [form]);

  async function createCoupon() {
    if (!form.code.trim()) return toast.error("กรุณากรอกรหัสคูปอง");
    setSaving(true);
    try {
      const response = await fetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody(form)),
      });
      const data = await response.json();
      if (!response.ok) return toast.error(data.error ?? "สร้างคูปองไม่สำเร็จ");
      toast.success("สร้างคูปองและบันทึก audit แล้ว");
      setForm(EMPTY_FORM);
      await fetchCoupons();
    } finally {
      setSaving(false);
    }
  }

  async function saveCoupon(coupon: Coupon) {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/coupons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: coupon.id, ...requestBody(editForm) }),
      });
      const data = await response.json();
      if (!response.ok) return toast.error(data.error ?? "บันทึกไม่สำเร็จ");
      toast.success("บันทึกและเขียน audit log แล้ว");
      setEditingId(null);
      await fetchCoupons();
    } finally {
      setSaving(false);
    }
  }

  async function setCouponActive(coupon: Coupon, isActive: boolean) {
    if (!isActive && !window.confirm(`ปิด ${coupon.code} ทันที? สิทธิ์ที่แจกสำเร็จแล้วจะยังคงอยู่`)) return;
    const response = await fetch("/api/admin/coupons", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: coupon.id, isActive }),
    });
    const data = await response.json();
    if (!response.ok) return toast.error(data.error ?? "เปลี่ยนสถานะไม่สำเร็จ");
    toast.success(isActive ? "เปิดใช้คูปองแล้ว" : "ปิดคูปองแล้ว · สิทธิ์เดิมไม่ถูกยกเลิก");
    await fetchCoupons();
  }

  return (
    <div className="ve-no-padding relative isolate flex-1 overflow-y-auto">
      <div className="relative z-10 mx-auto max-w-7xl space-y-7 px-4 pb-14 pt-3 md:px-6 md:pt-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
              Admin · Commercial controls
            </p>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight text-[var(--ui-text-primary)]" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>
              คูปองและสิทธิ์ใช้งาน
            </h1>
            <p className="mt-1 text-sm text-[var(--ui-text-secondary)]">เวลาในหน้านี้เป็น Asia/Bangkok · คูปองที่ใช้แล้วปิดได้ แต่ไม่ลบหลักฐาน</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void fetchCoupons()} disabled={loading} className="gap-2 text-zinc-400 hover:text-white">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> รีเฟรช
          </Button>
        </header>

        <section className="overflow-hidden rounded-xl" style={cardStyle}>
          <div className="grid lg:grid-cols-[minmax(0,1fr)_330px]">
            <div className="p-5 md:p-6">
              <div className="mb-5 flex items-center gap-2">
                <Plus className="h-4 w-4" style={{ color: VIOLET }} />
                <h2 className="text-sm font-semibold text-[var(--ui-text-primary)]">สร้าง GRANT coupon</h2>
              </div>
              <CouponFields form={form} setForm={setForm} />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={createCoupon} disabled={saving} className="gap-2 text-white hover:brightness-110" style={{ background: VIOLET_GRAD }}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ticket className="h-4 w-4" />} สร้างคูปอง
                </Button>
                <button
                  onClick={() => {
                    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
                    const code = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
                    setForm((current) => ({ ...current, code }));
                  }}
                  className="text-xs text-[var(--ui-text-muted)] transition hover:text-[var(--ui-text-primary)]"
                >
                  สุ่มรหัส
                </button>
              </div>
            </div>

            <aside className="border-t border-[var(--ui-card-border)] bg-violet-500/[0.035] p-5 lg:border-l lg:border-t-0">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-violet-200">
                <ShieldCheck className="h-4 w-4" /> Preview ผลลัพธ์
              </div>
              <div className="space-y-3">
                {previewRows.map(([label, result]) => (
                  <div key={label} className="grid grid-cols-[105px_1fr] gap-3 text-xs leading-relaxed">
                    <span className="text-[var(--ui-text-muted)]">{label}</span>
                    <span className="text-[var(--ui-text-primary)]">{result}</span>
                  </div>
                ))}
              </div>
              <p className="mt-5 border-t border-[var(--ui-card-border)] pt-4 text-[11px] leading-relaxed text-[var(--ui-text-muted)]">
                Promo เป็นถังแยก มีวันหมดอายุ และถูกใช้ก่อน purchased credits ตามวันหมดอายุจริง
              </p>
            </aside>
          </div>
        </section>

        {report && (
          <section className="rounded-xl" style={cardStyle}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ui-card-border)] px-4 py-3.5 md:px-5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--ui-text-primary)]">Live 0819 attribution</h2>
                <p className="mt-0.5 text-[11px] text-[var(--ui-text-muted)]">ref → สมัคร → ใช้ {report.couponCode} → สร้างคลิป → จ่ายเงินจริง</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {([
                  ["signup_no_redeem", "สมัคร/ยังไม่ใช้"],
                  ["redeemed", "ใช้คูปอง"],
                  ["created_clip", "สร้างคลิป"],
                  ["paid", "จ่ายเงินจริง"],
                ] as const).map(([segment, label]) => (
                  <a
                    key={segment}
                    href={`/api/admin/coupons/report?coupon=CLIP0819&segment=${segment}`}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-white"
                  >
                    <Download className="h-3 w-3" /> {label}
                  </a>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="text-[var(--ui-text-muted)]">
                  <tr className="border-b border-[var(--ui-card-border)]">
                    <th className="px-5 py-2.5 font-medium">Ref</th>
                    <th className="px-3 py-2.5 font-medium">สมัคร</th>
                    <th className="px-3 py-2.5 font-medium">ใช้คูปอง</th>
                    <th className="px-3 py-2.5 font-medium">สร้างคลิป</th>
                    <th className="px-3 py-2.5 font-medium">จ่ายเงินจริง</th>
                  </tr>
                </thead>
                <tbody>
                  {report.refs.map((row) => (
                    <tr key={row.ref} className="border-b border-[var(--ui-card-border)] last:border-0">
                      <td className="px-5 py-3 font-mono text-[var(--ui-text-primary)]">{row.ref}</td>
                      <td className="px-3 py-3 text-[var(--ui-text-secondary)]">{row.signups}</td>
                      <td className="px-3 py-3 text-[var(--ui-text-secondary)]">{row.couponRedemptions}</td>
                      <td className="px-3 py-3 text-[var(--ui-text-secondary)]">{row.createdClips}</td>
                      <td className="px-3 py-3 text-[var(--ui-text-secondary)]">{row.paidConversions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!report.clicksAvailable && <p className="border-t border-[var(--ui-card-border)] px-5 py-2.5 text-[11px] text-[var(--ui-text-muted)]">Clicks ยังอยู่ฝั่ง affiliate.heroaiengine.com; รายงานนี้เริ่มจาก signup ที่ Studio บันทึกได้</p>}
          </section>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-[var(--ui-text-primary)]">คูปองทั้งหมด</h2>
            <span className="text-xs text-[var(--ui-text-muted)]">{coupons.length} รายการ</span>
          </div>
          {!loading && coupons.length === 0 && (
            <div className="rounded-xl py-12 text-center text-sm text-zinc-500" style={cardStyle}>ยังไม่มีคูปอง</div>
          )}
          {coupons.map((coupon) => {
            const expired = Boolean(coupon.expiresAt && new Date(coupon.expiresAt) < new Date());
            const full = coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses;
            const editing = editingId === coupon.id;
            const planStyle = PLAN_STYLES[coupon.plan] ?? PLAN_STYLES.FREE;
            const PlanIcon = planStyle.Icon;
            return (
              <article key={coupon.id} className={`rounded-xl transition ${coupon.isActive ? "" : "opacity-65"}`} style={cardStyle}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                  <div className="flex min-w-[180px] items-center gap-2">
                    <span className="font-mono text-sm font-bold text-[var(--ui-text-primary)]">{coupon.code}</span>
                    <button onClick={() => { void navigator.clipboard.writeText(coupon.code); toast.success("คัดลอกแล้ว"); }} className="text-zinc-600 transition hover:text-zinc-300" aria-label="คัดลอกรหัส">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${planStyle.bg} ${planStyle.text}`}>
                    <PlanIcon className="h-3 w-3" /> {coupon.plan}
                  </span>
                  <span className="text-xs text-[var(--ui-text-muted)]">{coupon.durationDays === 0 ? "ถาวร" : `${coupon.durationDays} วัน`}</span>
                  <span className="text-xs text-[var(--ui-text-muted)]">ใช้ {coupon.usedCount}/{coupon.maxUses === 0 ? "∞" : coupon.maxUses}</span>
                  <span className="text-xs text-[var(--ui-text-muted)]">+{coupon.promoCredits} promo · {coupon.promoCreditTtlDays} วัน</span>
                  {coupon.expiresAt && (
                    <span className={`flex items-center gap-1 text-xs ${expired ? "text-red-400" : "text-[var(--ui-text-muted)]"}`}>
                      <Clock3 className="h-3 w-3" /> {formatBangkok(coupon.expiresAt)}
                    </span>
                  )}
                  {!coupon.isActive && <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-400">ปิดอยู่</span>}
                  {full && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-400">ใช้ครบ</span>}
                  <div className="ml-auto flex items-center gap-1">
                    {coupon.type === "GRANT" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingId(coupon.id); setEditForm(formFromCoupon(coupon)); }}
                        className="h-8 gap-1.5 text-xs text-zinc-400 hover:text-white"
                      >
                        <Pencil className="h-3.5 w-3.5" /> แก้ไข
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void setCouponActive(coupon, !coupon.isActive)}
                      className={`h-8 gap-1.5 text-xs ${coupon.isActive ? "text-zinc-500 hover:text-red-400" : "text-emerald-400 hover:text-emerald-300"}`}
                    >
                      {coupon.isActive ? <Power className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                      {coupon.isActive ? "ปิดทันที" : "เปิดใช้"}
                    </Button>
                  </div>
                </div>

                <div className={`grid transition-[grid-template-rows] duration-200 ${editing ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                    <div className="border-t border-[var(--ui-card-border)] bg-[var(--ui-input-bg)] p-4 md:p-5">
                      <CouponFields form={editForm} setForm={setEditForm} lockIdentity={coupon.usedCount > 0} />
                      {coupon.usedCount > 0 && <p className="mt-3 text-[11px] text-amber-300/80">ใช้แล้ว {coupon.usedCount} ครั้ง: รหัส แผน และจำนวนวันถูกล็อกเพื่อรักษาสิทธิ์เดิม</p>}
                      <div className="mt-4 flex items-center gap-2">
                        <Button size="sm" onClick={() => void saveCoupon(coupon)} disabled={saving} className="gap-2 text-white" style={{ background: VIOLET_GRAD }}>
                          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} บันทึก
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} className="gap-1.5 text-zinc-400">
                          <X className="h-3.5 w-3.5" /> ยกเลิก
                        </Button>
                        {coupon.auditLogs[0] && (
                          <span className="ml-auto text-[11px] text-[var(--ui-text-muted)]">
                            ล่าสุด {coupon.auditLogs[0].action} · {formatBangkok(coupon.auditLogs[0].createdAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      </div>
    </div>
  );
}
