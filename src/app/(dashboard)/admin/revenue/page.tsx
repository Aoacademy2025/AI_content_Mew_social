"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Crown, Clock, Tag, BarChart3 } from "lucide-react";
import CostMarginPanel from "@/components/admin/cost-margin-panel";
import RevenueGrowthDashboard from "@/components/admin/revenue-growth-dashboard";
import ManualPaymentPanel from "@/components/admin/manual-payment-panel";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — moved
// verbatim from admin/page.tsx (Task C4, ADR 0062: money renders only here).
const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
// Flat v2 card surface — inline var(--ui-*), matches settings/dashboard (no .ve-card helper)
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

interface AdminStats {
  totalUsers: number; freeUsers: number; paidUsers: number; suspendedUsers: number;
  totalContents: number; totalVideos: number; totalImages: number; newToday: number; newThisWeek: number;
  // Honest revenue split (see /api/admin/stats + src/lib/revenue-cohorts.ts)
  payingTotal: number; directPayingTotal: number; bundleActive: number;
  trialActive: number; compedPaid: number; mrr: number; directMrr: number; bundleMrr: number; lapsedPayers: number;
  payingCanceling?: number; mrrAtRisk?: number;
}

// Single stat card — matches the original grid card (byte-identical for non-hero);
// `hero` variant fills violet for the headline "จ่ายจริง" cash metric.
function StatCard({
  title, value, sub, icon: Icon, loading, hero = false,
}: {
  title: string;
  value: number | string;
  sub: string;
  icon: React.ElementType;
  loading: boolean;
  hero?: boolean;
}) {
  return (
    <Card className="shadow-none" style={hero ? { background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` } : cardStyle}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium" style={{ color: hero ? VIOLET_LIGHT : "var(--ui-text-secondary)" }}>{title}</CardTitle>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}>
          <Icon className="h-4 w-4" style={{ color: VIOLET }} strokeWidth={2.1} />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? null : (
          <div className="text-3xl font-bold" style={{ color: hero ? "#fff" : "var(--ui-text-primary)", fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>{value}</div>
        )}
        <p className="mt-1 text-xs" style={{ color: "var(--ui-text-muted)" }}>{sub}</p>
      </CardContent>
    </Card>
  );
}

export default function AdminRevenuePage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  // ManualPaymentPanel's suggested amount must reflect the DB-configured
  // PRO/BUSINESS list price, not the component's hardcoded 599/990 defaults —
  // moved verbatim from admin/page.tsx (Task C4).
  const [planProPrice, setPlanProPrice] = useState("599");
  const [planBusinessPrice, setPlanBusinessPrice] = useState("990");

  // CostMarginPanel's own time window — independent from any other page's
  // control, defaults to a trailing 30 days (brief: Task C4).
  const [costDays, setCostDays] = useState(30);

  useEffect(() => {
    fetch("/api/admin/stats").then(r => r.json()).then(setStats).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then(r => r.json())
      .then(d => {
        if (d.plan_pro_price) setPlanProPrice(d.plan_pro_price);
        if (d.plan_business_price) setPlanBusinessPrice(d.plan_business_price);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-8">
        {/* Header */}
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
            ผู้ดูแลระบบ · Admin Panel
          </p>
          <h1 className="text-[30px] font-bold leading-tight tracking-tight"
            style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
            รายได้
          </h1>
          <p className="mt-1 text-[15px]" style={{ color: "var(--ui-text-secondary)" }}>เงินสด ต้นทุน กำไร และการเติบโต — หน้าเดียวที่แสดงตัวเลขเงิน (ADR 0062)</p>
        </div>

        {/* ── รายได้จริง group — honest cash vs trial vs comped ────────────── */}
        <div>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: VIOLET_LIGHT }}>รายได้จริง</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard hero title="จ่ายจริง (จ่ายเงินสด)" value={stats?.payingTotal ?? 0} sub={`Studio ${stats?.directPayingTotal ?? 0} · Bundle ${stats?.bundleActive ?? 0}${stats?.payingCanceling ? ` · ${stats.payingCanceling} รอหมดรอบ` : ""}`} icon={Crown} loading={loading} />
            <StatCard title="Trial (ทดลอง)" value={stats?.trialActive ?? 0} sub="ทดลอง PRO ฟรี ยังไม่จ่ายเงิน" icon={Clock} loading={loading} />
            <StatCard title="Comped (แจกสิทธิ์)" value={stats?.compedPaid ?? 0} sub="admin/coupon — เป็นต้นทุน ไม่ใช่รายได้" icon={Tag} loading={loading} />
            <StatCard title="MRR (รายได้/เดือน)" value={`฿${Math.round(stats?.mrr ?? 0).toLocaleString()}`} sub={`Studio ฿${Math.round(stats?.directMrr ?? 0).toLocaleString()} · Bundle ฿${Math.round(stats?.bundleMrr ?? 0).toLocaleString()}`} icon={BarChart3} loading={loading} />
          </div>
          <p className="mt-3 text-xs" style={{ color: "var(--ui-text-muted)" }}>
            หมายเหตุ: ยอด &quot;บนแผน PRO/BUSINESS&quot; ทั้งหมด {stats?.paidUsers ?? 0} ราย ≈ จ่ายจริง {stats?.payingTotal ?? 0} + Trial {stats?.trialActive ?? 0} + Comped {stats?.compedPaid ?? 0} (ที่เหลือ = รอ cron ปรับสถานะ)
          </p>
        </div>

        {/* ── ต้นทุน & กำไร — own time window, defaults to 30 days ─────────── */}
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: VIOLET_LIGHT }}>ต้นทุน &amp; กำไร</p>
            <div className="inline-flex rounded-lg border p-1" style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg)" }}>
              {[1, 7, 30].map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setCostDays(option)}
                  className="rounded-md px-3 py-1.5 text-xs font-semibold transition"
                  style={costDays === option ? { background: VIOLET, color: "#fff" } : { color: "var(--ui-text-secondary)" }}
                >
                  {option === 1 ? "24 ชม." : `${option} วัน`}
                </button>
              ))}
            </div>
          </div>
          <CostMarginPanel days={costDays} />
        </div>

        {/* ── การเติบโต ─────────────────────────────────────────────────── */}
        <RevenueGrowthDashboard />

        {/* ── Manual / external (off-Stripe) payment log ───────────────────
            Moved verbatim from admin/page.tsx (Task C4, ADR 0062). */}
        <ManualPaymentPanel
          proPrice={Number(planProPrice) || 599}
          businessPrice={Number(planBusinessPrice) || 990}
        />
      </div>
    </div>
  );
}
