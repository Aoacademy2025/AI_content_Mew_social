"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  CreditCard,
  HelpCircle,
  Loader2,
  Repeat,
  Server,
  TrendingDown,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (mirrors GET /api/admin/costs response) ────────────────────────────
interface HeroMetrics {
  mrr: number;
  cashCollected: number;
  variableCogs: number;
  grossMarginPct: number;
  aiCostPct: number;
  netProfit: number;
  infraProrated: number;
}

interface Breakdown {
  tts: number;
  image: number;
  video: number;
  infra: number;
  infraProrated: number;
}

interface Customers {
  payingTotal: number;
  directPayingTotal: number;
  bundleActive: number;
  paying: { subMonthly: number; subAnnual: number; oneTimeMonthly: number; oneTimeAnnual: number; bundleMonthly: number; bundleAnnual: number };
  payingByTier: { pro: number; business: number };
  mrr: number;
  directMrr: number;
  bundleMrr: number;
  mrrByTier: { pro: number; business: number };
  lapsedPayers: number;
  trialActive: number;
  compedPaid: number;
  compedByTier: { pro: number; business: number };
  comped: { team: number; coupon: number; other: number };
  internalTeam: number;
  expiredTrial: number;
  expiredPlan: number;
  expiredBundle: number;
  free: number;
  breakEvenSubs: number;
}

interface CashByType {
  total: number;
  planMonthly: number;
  planAnnual: number;
  packs: number;
  allTimeTotal: number | null;
  allTimeStripeNet: number | null;
  allTimeManual: number | null;
  allTimeRefunds: number | null;
  allTimeAsOf: string;
}

interface UsageMetrics {
  managedMinutes: number;
  images: { hero1k: number; flux1k: number; gpt1k: number; nano1k: number; gpt2k: number; nano2k: number };
  creditsSpent: number;
  creditsGranted: number;
  rendersWeb: number;
  rendersMcp: number;
  activeCreators: number;
}

interface TopUser { userId: string; cogs: number; minutes: number; images: number }
interface BreakEven { subs: number; target: number }
interface TrendRow { date: string; revenue: number; cogs: number }
interface RunpodImageCost {
  billedUsd: number;
  billedTimeMs: number;
  deliveredImages: number;
  costBahtPerImage: number | null;
  targetBahtPerImage: number;
  hardLimitBahtPerImage: number;
  minimumSample: number;
  status: "insufficient_data" | "healthy" | "warning" | "hard_stop" | "stale";
  admitted: boolean;
  lastSuccessfulSyncAt: string | null;
}

interface CostsResponse {
  period: { days: number; from: string };
  hero: HeroMetrics;
  customers: Customers;
  cash: CashByType;
  breakdown: Breakdown;
  usage: UsageMetrics;
  topUsers: TopUser[];
  breakEven: BreakEven;
  runpodImageCost: RunpodImageCost | null;
  trend: TrendRow[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtBaht(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "฿-";
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

function MetricHelp({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex align-middle">
      <span
        tabIndex={0}
        aria-label={`คำอธิบาย ${label}`}
        className="inline-flex cursor-help rounded-full text-slate-500 outline-none transition hover:text-slate-300 focus-visible:text-slate-200 focus-visible:ring-2 focus-visible:ring-sky-400/60"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-72 -translate-x-1/2 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-left text-xs font-normal leading-relaxed text-slate-300 shadow-2xl group-hover:block group-focus-within:block">
        {children}
      </span>
    </span>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────
function KpiTile({ label, value, sub, icon: Icon, tone }: {
  label: string; value: string; sub?: string; icon: React.ElementType; tone: string;
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

function BreakdownBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
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
// `days` is owned by the parent page's single global time control (no second selector here).
export default function CostMarginPanel({ days }: { days: number }) {
  const [open, setOpen] = useState(true);
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
      .then((body) => { if (!cancelled) setData(body); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const h = data?.hero;
  const cu = data?.customers;
  const cash = data?.cash;
  const bd = data?.breakdown;
  const u = data?.usage;
  const be = data?.breakEven;
  const runpodCost = data?.runpodImageCost;
  const trend = data?.trend ?? [];
  const windowLabel = days === 1 ? "24 ชม." : `${days} วัน`;

  const trendMax = Math.max(1, ...trend.map((r) => Math.max(r.revenue, r.cogs)));

  // Provider bars — only render lines that have a cost (drop always-empty AI Video / AI Image).
  const providerBars = bd
    ? [
        { label: "Gemini TTS (นาที)", value: bd.tts, color: "bg-violet-500" },
        { label: "AI Image (GPT/Nano)", value: bd.image, color: "bg-sky-500" },
        { label: "AI Video (Seedance)", value: bd.video, color: "bg-cyan-500" },
        { label: "Infra (ต่อเดือน)", value: bd.infraProrated, color: "bg-zinc-500" },
      ].filter((b) => b.value > 0 || b.label.startsWith("Gemini") || b.label.startsWith("Infra"))
    : [];
  const bdMax = Math.max(1, ...providerBars.map((b) => b.value));
  const costTotalWindow = bd ? bd.tts + bd.image + bd.video + bd.infraProrated : 0;

  const subCount = cu ? cu.paying.subMonthly + cu.paying.subAnnual + cu.paying.bundleMonthly : 0;
  const oneTimeCount = cu ? cu.paying.oneTimeMonthly + cu.paying.oneTimeAnnual : 0;
  const annualCount = cu ? cu.paying.subAnnual + cu.paying.oneTimeAnnual + cu.paying.bundleAnnual : 0;
  const monthlyCount = cu ? cu.paying.subMonthly + cu.paying.oneTimeMonthly + cu.paying.bundleMonthly : 0;
  const driftTotal = cu ? cu.lapsedPayers + cu.expiredTrial + cu.expiredPlan + cu.expiredBundle : 0;

  return (
    <section className="rounded-xl border border-violet-500/25 bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-white/[0.03]"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15">
          <Wallet className="h-4 w-4 text-violet-400" />
        </div>
        <div>
          <div className="text-sm font-semibold text-white">รายได้ &amp; ลูกค้า (Revenue &amp; Customers)</div>
          <div className="text-xs text-slate-500">
            {cu && h && cash
              ? `ลูกค้าจ่ายเงินจริงทั้งหมดตอนนี้ ${fmtNum(cu.payingTotal)} · MRR ${fmtBaht(h.mrr)} · รายได้สะสม ${fmtBaht(cash.allTimeTotal)}`
              : "กำลังโหลด..."}
          </div>
        </div>
        <span className="ml-auto text-slate-500">{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
      </button>

      {open && (
        <div className="border-t border-white/10 px-5 pb-6 pt-5 space-y-6">
          {loading && (
            <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-violet-400" /></div>
          )}
          {!loading && error && (
            <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>
          )}

          {!loading && !error && h && cu && cash && bd && u && be && (
            <>
              {/* ── CUSTOMERS: real payers vs trial (snapshot, not windowed) ───────── */}
              <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.06] p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-violet-200">ลูกค้าจ่ายเงินจริงทั้งหมดตอนนี้</div>
                    <div className="mt-2 flex items-end gap-3">
                      <span className="text-4xl font-bold text-white">{fmtNum(cu.payingTotal)}</span>
                      <span className="pb-1 text-sm text-slate-400">
                        PRO {fmtNum(cu.payingByTier.pro)} · BUSINESS {fmtNum(cu.payingByTier.business)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-slate-200"><Repeat className="h-3 w-3" /> Subscription {fmtNum(subCount)}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-slate-200"><CreditCard className="h-3 w-3" /> จ่ายครั้งเดียว {fmtNum(oneTimeCount)}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-200">Bundle {fmtNum(cu.bundleActive)}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2.5 py-1 text-violet-200">รายเดือน {fmtNum(monthlyCount)}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2.5 py-1 text-violet-200">รายปี {fmtNum(annualCount)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div className="rounded-md border border-emerald-400/25 bg-emerald-500/10 px-3 py-2">
                      <div className="flex items-center justify-center gap-1 text-[11px] text-emerald-300/80">
                        รายได้รวมสะสม
                        <MetricHelp label="รายได้รวมสะสม">
                          เงินที่รับจริงทั้งหมดจาก Studio และ Hero AI Bundle รวมสมาชิกรายเดือน รายปี การจ่ายครั้งเดียว และเครดิตแพ็ก หักเงินคืนแล้ว และรวมรายการรับเงินนอก Stripe ที่แอดมินบันทึกไว้ ไม่ใช่ตัวเลขคาดการณ์จาก MRR
                        </MetricHelp>
                      </div>
                      <div className="mt-1 text-lg font-bold text-emerald-200">{fmtBaht(cash.allTimeTotal)}</div>
                    </div>
                    <div className="rounded-md border border-violet-400/25 bg-violet-500/10 px-3 py-2">
                      <div className="flex items-center justify-center gap-1 text-[11px] text-violet-300/80">
                        MRR ต่อเดือน
                        <MetricHelp label="MRR">
                          Monthly Recurring Revenue (MRR) คือรายได้ประจำต่อเดือน ณ ตอนนี้ โดยนำรายปีมาเฉลี่ยเป็นรายเดือน ใช้ดูความเร็วของธุรกิจ ไม่ใช่ยอดเงินสดสะสม
                        </MetricHelp>
                      </div>
                      <div className="mt-1 text-lg font-bold text-violet-200">{fmtBaht(h.mrr)}</div>
                      <div className="text-[10px] text-violet-300/70">Studio {fmtBaht(cu.directMrr)} · Bundle {fmtBaht(cu.bundleMrr)}</div>
                    </div>
                    <div className="rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2">
                      <div className="text-lg font-bold text-amber-200">{fmtNum(cu.trialActive)}</div>
                      <div className="text-[11px] text-amber-300/80">Trial (ยังไม่จ่าย)</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
                      <div className="text-lg font-bold text-white">{fmtNum(cu.free)}</div>
                      <div className="text-[11px] text-slate-500">Free</div>
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-2 text-xs text-slate-400">
                  {/* Comped access — intentional grants (team + workshop/coupon), NOT revenue. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-slate-300">แจกฟรี (ไม่ใช่รายได้): <b className="text-white">{fmtNum(cu.compedPaid)}</b></span>
                    <span className="text-slate-500">ทีม {fmtNum(cu.comped.team)} · คูปอง/นักเรียน {fmtNum(cu.comped.coupon)} · อื่นๆ {fmtNum(cu.comped.other)}</span>
                  </div>
                  {/* Churn + entitlement drift. */}
                  {driftTotal > 0 && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:justify-end">
                      <span className="inline-flex items-center gap-1 font-semibold text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /></span>
                      {cu.lapsedPayers > 0 && <span>เคยจ่ายแล้วหลุด <b className="text-rose-300">{fmtNum(cu.lapsedPayers)}</b></span>}
                      {cu.expiredTrial > 0 && <span>· Trial หมดยังไม่ตัด <b className="text-amber-300">{fmtNum(cu.expiredTrial)}</b></span>}
                      {cu.expiredPlan > 0 && <span>· แพ็กหมดยังไม่ตัด <b className="text-amber-300">{fmtNum(cu.expiredPlan)}</b></span>}
                      {cu.expiredBundle > 0 && <span>· Bundle หมด/ยกเลิก <b className="text-amber-300">{fmtNum(cu.expiredBundle)}</b></span>}
                    </div>
                  )}
                </div>
                {cu.internalTeam > 0 && (
                  <p className="mt-2 text-[11px] text-slate-500">
                    * รวมบัญชีทีมงาน (@aoacademy) {fmtNum(cu.internalTeam)} บัญชี — ไม่ใช่ลูกค้าตลาดจริง (ปนอยู่ใน signups/trial ด้วย)
                  </p>
                )}
              </div>

              {/* ── CASH collected in window, by type ─────────────────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">รายการรับเงินใน Studio · ช่วง {windowLabel}</h3>
                  <span className="text-lg font-bold text-emerald-300">{fmtBaht(cash.total)}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="text-xs text-slate-500">Sub/รายเดือน</div>
                    <div className="mt-1 text-lg font-semibold text-white">{fmtBaht(cash.planMonthly)}</div>
                  </div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="text-xs text-slate-500">รายปี (card/PromptPay)</div>
                    <div className="mt-1 text-lg font-semibold text-white">{fmtBaht(cash.planAnnual)}</div>
                  </div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="text-xs text-slate-500">เครดิตแพ็ก</div>
                    <div className="mt-1 text-lg font-semibold text-white">{fmtBaht(cash.packs)}</div>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  ใช้ดูรายการตามช่วงเวลาที่เลือก ส่วน “รายได้รวมสะสม” ด้านบนดึงเงินรับจริงตลอดอายุธุรกิจจาก Stripe ทั้ง Studio และ Bundle รวมรายการนอก Stripe ที่บันทึกไว้ และหักเงินคืนแล้ว
                </p>
              </div>

              {/* ── Margin KPIs ───────────────────────────────────────────────────── */}
              {runpodCost && (
                <div className={cn(
                  "rounded-lg border p-4",
                  runpodCost.status === "healthy"
                    ? "border-emerald-400/25 bg-emerald-500/[0.06]"
                    : runpodCost.status === "warning" || runpodCost.status === "insufficient_data"
                      ? "border-amber-400/25 bg-amber-500/[0.06]"
                      : "border-rose-400/25 bg-rose-500/[0.08]",
                )}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                        RunPod Image · Fully-loaded COGS
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        รวม cold start, idle, fail/retry และ smoke · {fmtNum(runpodCost.deliveredImages)} รูปส่งมอบ
                      </div>
                    </div>
                    <div className="flex items-end gap-3">
                      <span className="text-2xl font-bold text-white">
                        {runpodCost.costBahtPerImage === null
                          ? "รอข้อมูล"
                          : `฿${fmtNum(runpodCost.costBahtPerImage, 3)}/รูป`}
                      </span>
                      <span className={cn(
                        "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                        runpodCost.admitted
                          ? "bg-emerald-500/15 text-emerald-200"
                          : "bg-rose-500/15 text-rose-200",
                      )}>
                        {runpodCost.admitted ? "รับงานได้" : "หยุดรับงาน"}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 text-xs text-slate-400 sm:grid-cols-3">
                    <span>เป้าหมาย ≤ ฿{fmtNum(runpodCost.targetBahtPerImage, 2)}</span>
                    <span>Hard stop &gt; ฿{fmtNum(runpodCost.hardLimitBahtPerImage, 2)}</span>
                    <span>Sample ขั้นต่ำ {fmtNum(runpodCost.minimumSample)} รูป</span>
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiTile label="ต้นทุนผันแปร AI (COGS)" value={fmtBaht(h.variableCogs)} sub="ต่อเดือน (30 วัน) · Gemini TTS + AI image" icon={Zap} tone="text-amber-300 bg-amber-500/12 border-amber-400/20" />
                <KpiTile label="Gross Margin %" value={fmtPct(h.grossMarginPct)} sub="(MRR - COGS) / MRR" icon={BarChart3} tone={marginTone(h.grossMarginPct)} />
                <KpiTile label="AI Cost % ของรายได้" value={fmtPct(h.aiCostPct)} sub="COGS / MRR — ยิ่งน้อยยิ่งดี" icon={TrendingDown} tone={h.aiCostPct < 20 ? "text-emerald-300 bg-emerald-500/12 border-emerald-400/20" : h.aiCostPct < 40 ? "text-amber-300 bg-amber-500/12 border-amber-400/20" : "text-rose-300 bg-rose-500/12 border-rose-400/20"} />
                <KpiTile label="กำไร/ขาดทุน (run-rate)" value={fmtBaht(h.netProfit)} sub="ต่อเดือน: MRR - COGS - Infra · ไม่ใช่เงินสดจริง" icon={Server} tone={profitTone(h.netProfit)} />
              </div>

              {/* ── Break-even (real payers) ──────────────────────────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Break-even (นับจากลูกค้าจ่ายจริง)</h3>
                  <span className={cn("text-xs font-semibold", be.subs >= be.target ? "text-emerald-300" : "text-amber-300")}>{be.subs}/{be.target} ราย</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-slate-900">
                  <div className={cn("h-full rounded-full transition-all", be.subs >= be.target ? "bg-emerald-500" : "bg-amber-500")} style={{ width: `${Math.max(0, Math.min(100, (be.subs / Math.max(1, be.target)) * 100))}%` }} />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {be.subs >= be.target
                    ? `คุ้ม infra แล้ว ✓ (เกินจุดคุ้มทุน +${be.subs - be.target} ราย)`
                    : `ต้องการอีก ${Math.max(0, be.target - be.subs)} ราย เพื่อ cover infra ฿${fmtNum(bd.infra)}/เดือน`}
                </p>
              </div>

              {/* ── Cost breakdown by provider (window-consistent) ────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">ต้นทุนแยก Provider · ต่อเดือน (30 วัน)</h3>
                <div className="space-y-3">
                  {providerBars.map((b) => <BreakdownBar key={b.label} label={b.label} value={b.value} max={bdMax} color={b.color} />)}
                </div>
                <div className="flex items-center justify-between border-t border-white/10 pt-2 text-xs">
                  <span className="font-semibold text-slate-300">รวม (COGS + Infra ต่อเดือน)</span>
                  <span className="font-mono font-semibold text-white">{fmtBaht(costTotalWindow)}</span>
                </div>
              </div>

              {/* ── Usage ─────────────────────────────────────────────────────────── */}
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">การใช้งาน · ช่วง {windowLabel}</h3>
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">นาทีที่จัดการ (Managed)</div>
                    <div className="text-lg font-semibold text-white">{fmtNum(u.managedMinutes, 1)} นาที</div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">Render Web / MCP</div>
                    <div className="text-lg font-semibold text-white">{fmtNum(u.rendersWeb)}<span className="text-sm font-normal text-slate-500"> / {fmtNum(u.rendersMcp)}</span></div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">เครดิตใช้ไป / รับ</div>
                    <div className="text-lg font-semibold text-white">{fmtNum(u.creditsSpent)}<span className="text-sm font-normal text-slate-500"> / {fmtNum(u.creditsGranted)}</span></div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs text-slate-500">ครีเอเตอร์ active</div>
                    <div className="text-lg font-semibold text-white"><Users className="mr-1 inline h-4 w-4 text-slate-400" />{fmtNum(u.activeCreators)} คน</div>
                  </div>
                </div>
              </div>

              {/* ── Top-cost Users ────────────────────────────────────────────────── */}
              {data.topUsers.length > 0 && (
                <div className="rounded-lg border border-white/10 bg-white/[0.03]">
                  <div className="px-4 py-3 border-b border-white/10">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Top-cost Users · ช่วง {windowLabel}</h3>
                  </div>
                  <div className="divide-y divide-white/10">
                    {data.topUsers.map((tu, i) => (
                      <div key={tu.userId} className="grid grid-cols-[24px_1fr_80px_72px_72px] items-center gap-3 px-4 py-2.5 text-sm">
                        <span className="text-xs font-mono text-slate-600">{i + 1}</span>
                        <span className="min-w-0 truncate font-mono text-xs text-slate-400">{tu.userId.slice(0, 16)}…</span>
                        <span className="text-right font-mono text-white">{fmtBaht(tu.cogs)}</span>
                        <span className="text-right text-xs text-slate-500">{fmtNum(tu.minutes, 1)} นาที</span>
                        <span className="text-right text-xs text-slate-500">{fmtNum(tu.images)} รูป</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Daily trend ───────────────────────────────────────────────────── */}
              {trend.length > 0 && (
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">เทรนด์รายวัน — MRR run-rate vs COGS</h3>
                  <div className="flex items-end gap-px overflow-x-auto pb-1" style={{ minHeight: 64 }}>
                    {trend.map((row) => {
                      const revH = Math.max(4, (row.revenue / trendMax) * 64);
                      const cogH = Math.max(4, (row.cogs / trendMax) * 64);
                      return (
                        <div key={row.date} className="group relative flex shrink-0 flex-col items-center gap-0.5" style={{ width: Math.max(6, Math.floor(400 / trend.length)) }}>
                          <div className="w-full rounded-t-sm bg-violet-500/50" style={{ height: revH }} title={`${row.date}: revenue ${fmtBaht(row.revenue)}`} />
                          <div className="w-full rounded-t-sm bg-rose-500/50" style={{ height: cogH }} title={`${row.date}: cogs ${fmtBaht(row.cogs)}`} />
                          <div className="pointer-events-none absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 whitespace-nowrap rounded border border-white/10 bg-slate-950 px-2 py-1 text-[10px] text-slate-200 shadow">
                            {row.date}<br />Rev: {fmtBaht(row.revenue)}<br />COGS: {fmtBaht(row.cogs)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-500/50" /> Revenue (MRR daily run-rate)</span>
                    <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500/50" /> COGS (variable AI cost)</span>
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
