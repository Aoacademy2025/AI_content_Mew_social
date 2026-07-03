"use client";

import { useEffect, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Loader2,
  Server,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (mirrors GET /api/admin/costs response) ────────────────────────────
interface CostPeriod {
  days: number;
  from: string;
}

interface HeroMetrics {
  mrr: number;
  cashCollected: number;
  variableCogs: number;
  grossMarginPct: number;
  aiCostPct: number;
  netProfit: number;
}

interface Breakdown {
  tts: number;
  image: number;
  video: number;
  infra: number;
}

interface ImageCounts {
  flux1k: number;
  gpt1k: number;
  nano1k: number;
  gpt2k: number;
  nano2k: number;
}

interface UsageMetrics {
  managedMinutes: number;
  images: ImageCounts;
  creditsSpent: number;
  creditsGranted: number;
  rendersWeb: number;
  rendersMcp: number;
  activeCreators: number;
}

interface TopUser {
  userId: string;
  cogs: number;
  minutes: number;
  images: number;
}

interface BreakEven {
  subs: number;
  target: number;
}

interface TrendRow {
  date: string;
  revenue: number;
  cogs: number;
}

interface CostsResponse {
  period: CostPeriod;
  hero: HeroMetrics;
  breakdown: Breakdown;
  usage: UsageMetrics;
  topUsers: TopUser[];
  breakEven: BreakEven;
  trend: TrendRow[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtBaht(n: number) {
  if (!Number.isFinite(n)) return "฿-";
  return "฿" + new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number) {
  if (!Number.isFinite(n)) return "-%";
  return n.toFixed(1) + "%";
}

function fmtNum(n: number, digits = 0) {
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(n);
}

function marginTone(pct: number) {
  if (pct >= 50) return "text-emerald-300 bg-emerald-500/12 border-emerald-400/20";
  if (pct >= 20) return "text-amber-300 bg-amber-500/12 border-amber-400/20";
  return "text-rose-300 bg-rose-500/12 border-rose-400/20";
}

function profitTone(n: number) {
  if (n > 0) return "text-emerald-300 bg-emerald-500/12 border-emerald-400/20";
  if (n === 0) return "text-amber-300 bg-amber-500/12 border-amber-400/20";
  return "text-rose-300 bg-rose-500/12 border-rose-400/20";
}

// ── Sub-components ───────────────────────────────────────────────────────────
function KpiTile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  tone: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-slate-400">{label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-normal text-white">{value}</div>
        </div>
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-md border", tone)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      {sub && <p className="mt-3 text-xs leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}

function BreakdownBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-white">{fmtBaht(value)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-900">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function CostMarginPanel() {
  const [open, setOpen] = useState(true);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CostsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/admin/costs?days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((body as { error?: string }).error ?? "โหลดข้อมูลต้นทุนไม่ได้");
        return body as CostsResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [days]);

  const h = data?.hero;
  const bd = data?.breakdown;
  const u = data?.usage;
  const be = data?.breakEven;
  const trend = data?.trend ?? [];

  // Max for trend bars
  const trendMax = Math.max(1, ...trend.map((r) => Math.max(r.revenue, r.cogs)));

  // Max for breakdown bars
  const bdMax = bd ? Math.max(1, bd.tts, bd.image, bd.video, bd.infra) : 1;

  return (
    <section className="rounded-xl border border-violet-500/25 bg-white/[0.02] overflow-hidden">
      {/* Header / toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-white/[0.03]"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15">
          <BarChart3 className="h-4 w-4 text-violet-400" />
        </div>
        <div>
          <div className="text-sm font-semibold text-white">ต้นทุน &amp; กำไร (Cost &amp; Margin)</div>
          <div className="text-xs text-slate-500">
            {h
              ? `MRR ${fmtBaht(h.mrr)} · Gross margin ${fmtPct(h.grossMarginPct)}`
              : "กำลังโหลด..."}
          </div>
        </div>
        <span className="ml-auto text-slate-500">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-white/10 px-5 pb-6 pt-5 space-y-6">
          {/* Days selector */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {data
                ? `ข้อมูล ${data.period.days} วัน ตั้งแต่ ${new Date(data.period.from).toLocaleDateString("th-TH")}`
                : ""}
            </p>
            <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.035] p-1">
              {[7, 14, 30, 90].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setDays(opt)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-semibold transition",
                    days === opt
                      ? "bg-white text-slate-950"
                      : "text-slate-400 hover:bg-white/10 hover:text-white"
                  )}
                >
                  {opt} วัน
                </button>
              ))}
            </div>
          </div>

          {loading && (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
            </div>
          )}

          {!loading && error && (
            <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          {!loading && !error && h && bd && u && be && (
            <>
              {/* ── Hero KPIs ──────────────────────────────────────────── */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <KpiTile
                  label="MRR (รายรับจากสมาชิก/เดือน)"
                  value={fmtBaht(h.mrr)}
                  sub="คำนวณจาก active subs × ราคา"
                  icon={TrendingUp}
                  tone="text-violet-300 bg-violet-500/12 border-violet-400/20"
                />
                <KpiTile
                  label="เงินเข้าจริง"
                  value={fmtBaht(h.cashCollected)}
                  sub={`ช่วง ${days} วัน (subscription + credit pack)`}
                  icon={DollarSign}
                  tone="text-sky-300 bg-sky-500/12 border-sky-400/20"
                />
                <KpiTile
                  label="ต้นทุนผันแปร AI (COGS)"
                  value={fmtBaht(h.variableCogs)}
                  sub="Gemini TTS + AI image + AI video"
                  icon={Zap}
                  tone="text-amber-300 bg-amber-500/12 border-amber-400/20"
                />
                <KpiTile
                  label="Gross Margin %"
                  value={fmtPct(h.grossMarginPct)}
                  sub="(MRR - COGS) / MRR"
                  icon={BarChart3}
                  tone={marginTone(h.grossMarginPct)}
                />
                <KpiTile
                  label="AI Cost % รายได้"
                  value={fmtPct(h.aiCostPct)}
                  sub="COGS / MRR — ยิ่งน้อยยิ่งดี"
                  icon={TrendingDown}
                  tone={
                    h.aiCostPct < 20
                      ? "text-emerald-300 bg-emerald-500/12 border-emerald-400/20"
                      : h.aiCostPct < 40
                      ? "text-amber-300 bg-amber-500/12 border-amber-400/20"
                      : "text-rose-300 bg-rose-500/12 border-rose-400/20"
                  }
                />
                <KpiTile
                  label="กำไร/ขาดทุนสุทธิ"
                  value={fmtBaht(h.netProfit)}
                  sub="MRR - COGS - Infra (pro-rated)"
                  icon={Server}
                  tone={profitTone(h.netProfit)}
                />
              </div>

              {/* ── ต้นทุนแยก Provider ──────────────────────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  ต้นทุนแยก Provider
                </h3>
                <div className="space-y-3">
                  <BreakdownBar label="Gemini TTS (นาที)" value={bd.tts} max={bdMax} color="bg-violet-500" />
                  <BreakdownBar label="AI Image (GPT/Nano)" value={bd.image} max={bdMax} color="bg-sky-500" />
                  <BreakdownBar label="AI Video (Seedance) — เร็วๆ นี้" value={bd.video} max={bdMax} color="bg-cyan-500" />
                  <BreakdownBar label="Infra (เดือน pro-rate)" value={bd.infra} max={bdMax} color="bg-zinc-500" />
                </div>
                <div className="pt-2 border-t border-white/10">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-300">รวม</span>
                    <span className="font-mono font-semibold text-white">
                      {fmtBaht(bd.tts + bd.image + bd.video + bd.infra)}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── การใช้งาน ──────────────────────────────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  การใช้งาน
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">นาทีที่จัดการ (Managed)</div>
                    <div className="text-lg font-semibold text-white">
                      {fmtNum(u.managedMinutes, 1)} นาที
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">รูป AI (GPT-Image-2 มาตรฐาน)</div>
                    <div className="text-lg font-semibold text-white">
                      {fmtNum(u.images.gpt1k + u.images.gpt2k)} รูป
                    </div>
                    <div className="text-xs text-slate-600">
                      Flux (ประหยัด): {fmtNum(u.images.flux1k)} · Nano (ขั้นสูง): {fmtNum(u.images.nano1k + u.images.nano2k)}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">เครดิตใช้ไป / รับ</div>
                    <div className="text-lg font-semibold text-white">
                      {fmtNum(u.creditsSpent)}
                      <span className="text-sm font-normal text-slate-500">
                        {" "}/ {fmtNum(u.creditsGranted)}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">Render Web / MCP</div>
                    <div className="text-lg font-semibold text-white">
                      {fmtNum(u.rendersWeb)}
                      <span className="text-sm font-normal text-slate-500">
                        {" "}/ {fmtNum(u.rendersMcp)}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">ครีเอเตอร์ active</div>
                    <div className="text-lg font-semibold text-white">
                      <Users className="mr-1 inline h-4 w-4 text-slate-400" />
                      {fmtNum(u.activeCreators)} คน
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Top-cost Users ─────────────────────────────────────── */}
              {data.topUsers.length > 0 && (
                <div className="rounded-lg border border-white/10 bg-white/[0.03]">
                  <div className="px-4 py-3 border-b border-white/10">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Top-cost Users (เรียงตามต้นทุน)
                    </h3>
                  </div>
                  <div className="divide-y divide-white/10">
                    {data.topUsers.map((u, i) => (
                      <div
                        key={u.userId}
                        className="grid grid-cols-[24px_1fr_80px_72px_72px] items-center gap-3 px-4 py-2.5 text-sm"
                      >
                        <span className="text-xs font-mono text-slate-600">{i + 1}</span>
                        <span className="min-w-0 truncate font-mono text-xs text-slate-400">
                          {u.userId.slice(0, 16)}…
                        </span>
                        <span className="text-right font-mono text-white">{fmtBaht(u.cogs)}</span>
                        <span className="text-right text-xs text-slate-500">
                          {fmtNum(u.minutes, 1)} นาที
                        </span>
                        <span className="text-right text-xs text-slate-500">
                          {fmtNum(u.images)} รูป
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Break-even gauge ──────────────────────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Break-even
                  </h3>
                  <span
                    className={cn(
                      "text-xs font-semibold",
                      be.subs >= be.target ? "text-emerald-300" : "text-amber-300"
                    )}
                  >
                    {be.subs}/{be.target} subs
                  </span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-slate-900">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      be.subs >= be.target ? "bg-emerald-500" : "bg-amber-500"
                    )}
                    style={{ width: `${Math.min(100, (be.subs / be.target) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {be.subs >= be.target
                    ? `เกิน break-even แล้ว (+${be.subs - be.target} subs)`
                    : `ต้องการอีก ${be.target - be.subs} subs เพื่อ cover infra`}
                </p>
              </div>

              {/* ── เทรนด์รายวัน ──────────────────────────────────────── */}
              {trend.length > 0 && (
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    เทรนด์รายวัน — Revenue vs COGS
                  </h3>
                  <div className="flex items-end gap-px overflow-x-auto pb-1" style={{ minHeight: 64 }}>
                    {trend.map((row) => {
                      const revH = Math.max(4, (row.revenue / trendMax) * 64);
                      const cogH = Math.max(4, (row.cogs / trendMax) * 64);
                      return (
                        <div
                          key={row.date}
                          className="group relative flex shrink-0 flex-col items-center gap-0.5"
                          style={{ width: Math.max(6, Math.floor(400 / trend.length)) }}
                        >
                          {/* Revenue bar */}
                          <div
                            className="w-full rounded-t-sm bg-violet-500/50"
                            style={{ height: revH }}
                            title={`${row.date}: revenue ${fmtBaht(row.revenue)}`}
                          />
                          {/* COGS bar overlaid below */}
                          <div
                            className="w-full rounded-t-sm bg-rose-500/50"
                            style={{ height: cogH }}
                            title={`${row.date}: cogs ${fmtBaht(row.cogs)}`}
                          />
                          {/* Tooltip on hover */}
                          <div className="pointer-events-none absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 whitespace-nowrap rounded border border-white/10 bg-slate-950 px-2 py-1 text-[10px] text-slate-200 shadow">
                            {row.date}
                            <br />
                            Rev: {fmtBaht(row.revenue)}
                            <br />
                            COGS: {fmtBaht(row.cogs)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-500/50" />
                      Revenue (MRR daily run-rate)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500/50" />
                      COGS (variable AI cost)
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
