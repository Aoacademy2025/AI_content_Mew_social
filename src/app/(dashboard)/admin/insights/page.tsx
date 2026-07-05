"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  Gauge,
  HelpCircle,
  Loader2,
  Radio,
  TimerReset,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import CostMarginPanel from "@/components/admin/cost-margin-panel";

type FunnelRow = { key: string; label: string; count: number; conversionPct: number; dropOffPct: number; previousCount: number };
type StepRow = { step: string; label: string; started: number; done: number; error: number; skipped: number; notFinished: number; p50Ms: number | null; p95Ms: number | null; successPct: number };
type ErrorRow = { count: number; label: string; stepLabel: string; lastSeen: string };
type NoiseRow = ErrorRow & { reason?: string };
type VitalRow = { metric: "LCP" | "INP" | "CLS" | string; p75: number | null; count: number };
type CountRow = { label: string; count: number };

type InsightSummary = {
  totals: {
    sessions: number; users: number; editorSessions: number; editorOpens: number; pipelineJobs: number;
    pipelineStarts: number; events: number; errors: number; byokErrorCount: number; quotaErrorCount: number; rawErrors: number;
    noiseEvents: number; frontendErrors: number; serverErrors: number; renderSuccessPct: number;
    videoCompletionPct: number; renderTaskSuccessPct: number; healthScore: number;
    funnelMode: "run" | "event" | "session" | "job"; funnelRuns: number;
    videoJobs: { total: number; completed: number; processing: number; failed: number; pending: number; outputReady: number; statusStuckWithOutput: number; processingWithoutOutput: number; completionPct: number; outputReadyPct: number };
  };
  funnel: FunnelRow[];
  steps: StepRow[];
  errors: ErrorRow[];
  byokErrors: ErrorRow[];
  noise: NoiseRow[];
  vitals: VitalRow[];
  broll: {
    p95Ms: number | null; runs: number; requests: number; successPct: number;
    searchP95Ms: number | null; rankingP95Ms: number | null; downloadP95Ms: number | null; normalizeP95Ms: number | null;
    cacheHitPct: number; cacheHitCount: number; downloadedCount: number; downloadFailPct: number; downloadFailCount: number;
    servedClipAvg: number | null; searchQueriesAvg: number | null; selectedPexelsCount: number; selectedPixabayCount: number;
    normalizeRanCount: number; normalizeSkippedCount: number; normalizeFailedCount: number;
    profileFallbackUsedCount: number; forcedFallbackCount: number; noCandidateKeywords: number;
  };
  playback: {
    sessions: number; errors: number; firstFrameP50Ms: number | null; firstFrameP95Ms: number | null; canPlayP95Ms: number | null;
    firstFrames: number; waitingEvents: number; stalledEvents: number; bufferingSessionPct: number; pages: CountRow[]; routes: CountRow[];
  };
  staleProcessing: { total: number; completeCandidates: number; failCandidates: number; existingOutput: number; oldestAgeMinutes: number | null };
  recommendations: string[];
};

type ActivationData = {
  signups: number; internalTeam: number; hasGeminiKey: number; hasStockKey: number;
  paidTotal: number; trialActive: number; compedPaid: number; managed?: boolean;
  payingCanceling?: number; mrrAtRisk?: number;
  openedEditor: number; startedPipeline: number; completedFirstVideo: number; repeatCreators: number;
  windowCompletedUsers: number; prevWindowCompletedUsers: number;
};

type RenderStats = {
  total: number; done: number; failed: number; running: number; queued: number; cancelled: number;
  web: number; mcp: number; successPct: number; p50Ms: number | null; p95Ms: number | null; burnTotal: number; burnDone: number;
};

type JobOutcomes = {
  total: number; done: number; failed: number; processing: number; queued: number;
  systemFailed: number; byokFailed: number; quotaFailed: number; noiseFailed: number;
  failedByStage: Array<{ stage: string; stageLabel: string; kind: "system" | "byok" | "quota" | "noise"; count: number; sample: string }>;
};

type InsightsResponse = {
  range: { days: number; since: string; until: string };
  activation: ActivationData;
  renderStats: RenderStats;
  jobOutcomes: JobOutcomes;
  current: InsightSummary;
  previous: InsightSummary;
};

type ReconcileApplyResponse = { error?: string; applied?: { completed?: number; failed?: number; skipped?: number } | null };

const metricHelp: Record<string, string> = {
  "Health Score": "คะแนนสุขภาพระบบ 0–100 — คิดเฉพาะ error ของระบบเรา (ไม่รวมคีย์ลูกค้า/noise) + render p95 + video completion + งานค้าง ยิ่งใกล้ 100 ยิ่งดี",
  "Error telemetry": "เหตุการณ์ error จาก telemetry ฝั่ง client+server (ตัด noise/คีย์ลูกค้า/quota ออกแล้ว) — เป็น 'สัญญาณ' ไม่ใช่จำนวนบั๊กชี้ขาด เพราะ editor v2 แทบไม่ยิง telemetry. จำนวนบั๊กระบบที่เชื่อถือได้ (authoritative) ดูที่แผง 'งานจริง (server)' ซึ่งนับจาก VideoJob",
  "Job outcomes": "ผลงานจริงจาก VideoJob ฝั่ง server (status เซิร์ฟเวอร์เขียน ไม่หายตอนปิดแท็บ) — บอกว่างานที่ล้มเหลวพังที่ขั้นไหน และเป็นบั๊กเราหรือคีย์ลูกค้า",
  "Drop-off": "เปอร์เซ็นต์ session ที่ไปไม่ถึงขั้นถัดไป — นับต่อ session หน่วยเดียวกันทุกขั้น จึงเทียบกันได้จริง",
  "Activation": "สัดส่วนคนที่ได้ 'คุณค่าครั้งแรก' = ได้วิดีโอเสร็จอย่างน้อย 1 ตัว เป็นตัวชี้วัดว่าคนใช้ product ได้จริงไหม",
  "Session funnel": "เส้นทางการสร้างวิดีโอ นับจากงานเรนเดอร์จริง (VideoJob) ฝั่ง server ตาม progress/status — วัดทุก editor version (รวม v2) และตัดบัญชีทีมงาน (@aoacademy) ออกแล้ว",
  "p50": "ค่ากลาง: ผู้ใช้ครึ่งหนึ่งเร็วกว่าเวลานี้ และอีกครึ่งช้ากว่านี้",
  "p95": "เคสช้าเกือบสุด: 95% ของงานเร็วกว่าเวลานี้ ใช้หาคอขวดและเคสหนัก",
  "LCP": "เวลาที่เนื้อหาหลักของหน้าขึ้นจอ ถ้าสูง ผู้ใช้รู้สึกว่าหน้าโหลดช้า",
  "INP": "ความหน่วงตอนกด คลิก หรือพิมพ์ ถ้าสูง UI จะรู้สึกหน่วง",
  "CLS": "คะแนนหน้ากระโดดหรือเลื่อนเอง ถ้าสูง ผู้ใช้อาจกดผิดหรืออ่านยาก",
  "First frame": "เวลาจากการกด play จนวิดีโอเริ่มแสดงภาพจริง ถ้าสูง ผู้ใช้จะรู้สึกว่าคลิปเปิดช้า",
  "Buffering sessions": "เปอร์เซ็นต์ session ที่มี waiting หรือ stalled ระหว่างดู ใช้วัดอาการกระตุกจริง",
  "Video completed": "เปอร์เซ็นต์งานจากตาราง Video ที่ status เป็น COMPLETED ในช่วงเวลาที่เลือก",
};

function InfoTip({ label }: { label: keyof typeof metricHelp | string }) {
  const text = metricHelp[label] ?? label;
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-label={text} className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition hover:bg-white/10 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-400/50">
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      <span className="pointer-events-none absolute left-1/2 top-6 z-30 hidden w-64 -translate-x-1/2 rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-left text-xs leading-relaxed text-slate-200 shadow-xl group-hover:block group-focus-within:block">{text}</span>
    </span>
  );
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(value);
}
function pctOf(value: number, total: number) { return total ? Math.round((value / total) * 100) : 0; }
function formatMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.round(value)} ms`;
  const sec = value / 1000;
  if (sec < 90) return `${sec.toFixed(sec < 10 ? 1 : 0)} วิ`;
  return `${Math.round(sec / 60)} นาที`;
}
function statusTone(score: number) {
  if (score >= 80) return "text-emerald-300 bg-emerald-500/12 border-emerald-400/20";
  if (score >= 60) return "text-amber-300 bg-amber-500/12 border-amber-400/20";
  return "text-rose-300 bg-rose-500/12 border-rose-400/20";
}

function MetricTile({ label, value, helper, icon: Icon, tone }: { label: string; value: string; helper: string; icon: React.ElementType; tone: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">{label}{metricHelp[label] && <InfoTip label={label} />}</div>
          <div className="mt-2 text-3xl font-semibold tracking-normal text-white">{value}</div>
        </div>
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-md border", tone)}><Icon className="h-5 w-5" /></div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{helper}</p>
    </div>
  );
}

function VitalPill({ vital }: { vital: VitalRow }) {
  const metric = vital.metric.toUpperCase();
  const value = metric === "CLS" ? (vital.p75 == null ? "-" : Number(vital.p75).toFixed(3)) : formatMs(vital.p75);
  const good = metric === "LCP" ? (vital.p75 ?? Infinity) <= 2500 : metric === "INP" ? (vital.p75 ?? Infinity) <= 200 : metric === "CLS" ? (vital.p75 ?? Infinity) <= 0.1 : false;
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">{metric}<InfoTip label={metric} /></div>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", good ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300")}>{good ? "ดี" : "ต้องดู"}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
      <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">p75 · {formatNumber(vital.count)} ครั้ง</div>
    </div>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5", className)}>{children}</div>;
}

export default function AdminInsightsPage() {
  const [days, setDays] = useState(1);
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);
  const [devOpen, setDevOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/insights?days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "โหลดข้อมูลไม่ได้");
        return body as InsightsResponse;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, refreshNonce]);

  const current = data?.current;
  const previous = data?.previous;
  const activation = data?.activation;
  const jobOutcomes = data?.jobOutcomes;
  const renderStats = data?.renderStats;
  const hasData = !!current && (current.totals.events > 0 || current.totals.videoJobs.total > 0);
  const worstDrop = useMemo(() => current ? (current.funnel.slice(1).sort((a, b) => b.dropOffPct - a.dropOffPct)[0] ?? null) : null, [current]);
  const activationSteps = useMemo(() => {
    if (!activation) return [];
    return [
      { label: "สมัคร", count: activation.signups, cause: "" },
      { label: "เปิด editor", count: activation.openedEditor, cause: "สมัครแล้วไม่เข้าใช้ — onboarding / อีเมลต้อนรับ" },
      { label: "กดเริ่มสร้าง", count: activation.startedPipeline, cause: "เข้าแล้วไม่กดเริ่ม — UX / onboarding" },
      { label: "ได้วิดีโอเสร็จ", count: activation.completedFirstVideo, cause: "เริ่มแล้วไม่จบ — เช็คความเร็วระบบ (p95) ในโซน dev" },
      { label: "ทำซ้ำ ≥2", count: activation.repeatCreators, cause: "ทำครั้งเดียวแล้วหาย — คุณภาพ / ความคุ้มค่า" },
    ];
  }, [activation]);

  async function applyProcessingReconcile() {
    setReconcileBusy(true);
    setReconcileMessage(null);
    try {
      const res = await fetch("/api/admin/videos/reconcile-processing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, staleAfterMinutes: 20, failAfterHours: 24, failMissingOutput: false, limit: 100 }),
      });
      const body = await res.json().catch(() => ({})) as ReconcileApplyResponse;
      if (!res.ok) throw new Error(body.error ?? "reconcile ไม่สำเร็จ");
      setReconcileMessage(`แก้สถานะแล้ว ${formatNumber(body.applied?.completed ?? 0)} งาน · ข้าม ${formatNumber(body.applied?.skipped ?? 0)} งาน`);
      setRefreshNonce((v) => v + 1);
    } catch (err) {
      setReconcileMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setReconcileBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#080b12] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        {/* ── Header + single global time control ─────────────────────────────── */}
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-200">
              <Activity className="h-3.5 w-3.5" /> Real Usage Insights
            </div>
            <h1 className="text-2xl font-semibold tracking-normal text-white sm:text-3xl">ระบบใช้งานจริงบอกอะไรเรา</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">รายได้ &amp; ลูกค้าจ่ายจริง → คนหลุดตรงไหน → สุขภาพระบบ → รายละเอียด dev (กดเปิด). ตัวเลขทั้งหมดมาจากระบบจริง</p>
          </div>
          <div className="inline-flex w-full rounded-lg border border-white/10 bg-white/[0.035] p-1 sm:w-auto">
            {[1, 7, 30].map((option) => (
              <button key={option} type="button" onClick={() => setDays(option)}
                className={cn("flex-1 rounded-md px-4 py-2 text-sm font-semibold transition sm:flex-none", days === option ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/10 hover:text-white")}>
                {option === 1 ? "24 ชม." : `${option} วัน`}
              </button>
            ))}
          </div>
        </header>

        {/* ── 1. Revenue & Customers (driven by the same global `days`) ────────── */}
        <CostMarginPanel days={days} />

        {loading && (
          <div className="flex h-72 items-center justify-center rounded-lg border border-white/10 bg-white/[0.025]"><Loader2 className="h-6 w-6 animate-spin text-sky-300" /></div>
        )}
        {!loading && error && (
          <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
        )}

        {!loading && !error && current && (
          <>
            {!hasData && (
              <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-100">ยังไม่มีข้อมูลสะสม ลองใช้งาน Video Editor 1-2 รอบ แล้วกลับมาดูหน้านี้อีกครั้ง</div>
            )}

            {/* ── 2. North Star: Activation ─────────────────────────────────────── */}
            {activation && (
              <section className="rounded-lg border border-sky-400/25 bg-gradient-to-r from-sky-500/12 via-sky-500/5 to-transparent p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-200">North Star · Activation <InfoTip label="Activation" /></div>
                    <div className="mt-2 text-2xl font-semibold text-white sm:text-3xl">
                      {formatNumber(activation.signups)} สมัคร <span className="text-slate-500">→</span> {formatNumber(activation.completedFirstVideo)} ได้วิดีโอแรก{" "}
                      <span className={cn("ml-1 text-xl font-bold sm:text-2xl", pctOf(activation.completedFirstVideo, activation.signups) < 20 ? "text-rose-300" : "text-emerald-300")}>({pctOf(activation.completedFirstVideo, activation.signups)}%)</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-400">
                      ช่วงที่เลือก: ได้วิดีโอ {formatNumber(activation.windowCompletedUsers)} คน · ก่อนหน้า {formatNumber(activation.prevWindowCompletedUsers)} คน
                      {activation.windowCompletedUsers !== activation.prevWindowCompletedUsers && (
                        <span className={cn("ml-1 font-semibold", activation.windowCompletedUsers >= activation.prevWindowCompletedUsers ? "text-emerald-300" : "text-rose-300")}>{activation.windowCompletedUsers >= activation.prevWindowCompletedUsers ? "▲" : "▼"}</span>
                      )}
                    </p>
                  </div>
                  {/* Customer reality at a glance — real payers vs trial vs comped */}
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md border border-emerald-400/25 bg-emerald-500/10 px-3 py-2"><div className="text-lg font-bold text-emerald-200">{formatNumber(activation.paidTotal)}</div><div className="text-[11px] text-emerald-300/80">จ่ายจริง</div></div>
                    <div className="rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2"><div className="text-lg font-bold text-amber-200">{formatNumber(activation.trialActive)}</div><div className="text-[11px] text-amber-300/80">Trial</div></div>
                    <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2"><div className="text-lg font-bold text-white">{formatNumber(activation.compedPaid)}</div><div className="text-[11px] text-slate-500">แจกฟรี</div></div>
                  </div>
                </div>
                {!!activation.payingCanceling && activation.payingCanceling > 0 && (
                  <p className="mt-3 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                    ⚠️ จ่ายอยู่ {formatNumber(activation.paidTotal)} · ในนั้น {formatNumber(activation.payingCanceling)} ยกเลิกแล้ว รอหมดรอบ (MRR เสี่ยง ฿{formatNumber(activation.mrrAtRisk)})
                  </p>
                )}
                <p className="mt-3 border-t border-white/10 pt-3 text-xs leading-relaxed text-sky-100/70">
                  💡 <span className="font-semibold">สำหรับ CEO:</span> ตัวเลขสุขภาพธุรกิจตัวแรกที่ต้องดู — ถ้า &ldquo;ได้วิดีโอแรก %&rdquo; ตก = ปัญหาใหญ่กว่า metric ระบบทุกตัวรวมกัน → ทุ่มแก้ activation ก่อน
                  {activation.internalTeam > 0 && <span className="text-sky-100/50"> · หมายเหตุ: ตัดบัญชีทีมงาน (@aoacademy) {formatNumber(activation.internalTeam)} บัญชีออกแล้ว · นับรวมนักเรียน workshop (ลูกค้าจริง)</span>}
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  หมายเหตุ: &ldquo;จ่ายจริง&rdquo; = ลูกค้าที่จ่ายเงินสดจริง · MRR (ดูแผงรายได้ด้านบน) อิงราคา list — สมาชิก founding/คูปองนับเต็มราคา จึง<span className="font-semibold text-slate-400">ไม่ใช่เงินสดที่เก็บได้จริง</span> · ดูเงินสดจริงที่ &ldquo;เงินสดเข้าจริง&rdquo; (Cash-in)
                </p>
              </section>
            )}

            {/* ── 3. Activation funnel ──────────────────────────────────────────── */}
            {activation && (
              <Panel>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">Activation funnel — เสียลูกค้าตรงไหน</h2>
                    <p className="mt-1 text-xs text-slate-500">นับต่อ &ldquo;คน&rdquo; · ภาพรวมสะสมทั้งหมด (ไม่ขึ้นกับช่วงเวลาด้านบน)</p>
                  </div>
                  <Users className="h-5 w-5 text-sky-300" />
                </div>
                <div className="space-y-3">
                  {activationSteps.map((item, index) => {
                    const prev = index === 0 ? item.count : activationSteps[index - 1].count;
                    const conv = index === 0 ? 100 : pctOf(item.count, prev);
                    const drop = index === 0 ? 0 : Math.max(0, 100 - conv);
                    const width = Math.max(5, Math.min(100, conv));
                    return (
                      <div key={item.label} className="grid gap-2 sm:grid-cols-[150px_1fr_220px] sm:items-center">
                        <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-100">{index + 1}. {item.label}</div><div className="text-xs text-slate-500">{formatNumber(item.count)} คน</div></div>
                        <div className="h-9 overflow-hidden rounded-md bg-slate-900 ring-1 ring-white/10"><div className={cn("flex h-full items-center justify-end rounded-md px-2 text-xs font-semibold text-slate-950 transition-all", index === 0 ? "bg-slate-200" : drop > 60 ? "bg-rose-300" : drop > 40 ? "bg-amber-300" : "bg-emerald-300")} style={{ width: `${width}%` }}>{conv}%</div></div>
                        <div className="text-xs text-slate-400">{index === 0 ? <span className="text-slate-600">— ฐานเริ่มต้น</span> : <><span className={cn("font-semibold", drop > 60 ? "text-rose-300" : drop > 40 ? "text-amber-300" : "text-emerald-300")}>หลุด {drop}%</span><span className="text-slate-500"> · {item.cause}</span></>}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
                  {activation.managed ? (
                    <div className="rounded-md border border-emerald-400/20 bg-emerald-500/[0.07] p-3"><div className="text-xs text-emerald-300/80">Gemini — ระบบจัดการ (managed)</div><div className="mt-1 text-lg font-semibold text-emerald-200">ไม่ต้องตั้ง key</div></div>
                  ) : (
                    <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">Gemini key (บังคับ)</div><div className="mt-1 text-lg font-semibold text-white">{formatNumber(activation.hasGeminiKey)}/{formatNumber(activation.signups)} ตั้งแล้ว</div></div>
                  )}
                  <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">Stock key (Pexels/Pixabay)</div><div className="mt-1 text-lg font-semibold text-white">{formatNumber(activation.hasStockKey)}/{formatNumber(activation.signups)} ตั้งแล้ว</div></div>
                </div>
              </Panel>
            )}

            {/* ── 4. System health metric tiles ─────────────────────────────────── */}
            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <MetricTile label="Health Score" value={`${current.totals.healthScore}`} helper={`ช่วงก่อนหน้า ${previous?.totals.healthScore ?? 0}`} icon={Gauge} tone={statusTone(current.totals.healthScore)} />
              <MetricTile label="Video completed" value={`${current.totals.videoCompletionPct}%`} helper={`${formatNumber(current.totals.videoJobs.completed)}/${formatNumber(current.totals.videoJobs.total)} jobs · output ready ${formatNumber(current.totals.videoJobs.outputReady)}`} icon={CheckCircle2} tone="border-emerald-400/20 bg-emerald-500/12 text-emerald-300" />
              <MetricTile label="Error telemetry" value={formatNumber(current.totals.errors)} helper={`เหตุการณ์ telemetry (client+server) · คีย์ลูกค้า ${formatNumber(current.totals.byokErrorCount)} · โควต้า ${formatNumber(current.totals.quotaErrorCount)} · noise ${formatNumber(current.totals.noiseEvents)} · บั๊กชี้ขาดดูแผง 'งานจริง (server)'`} icon={AlertTriangle} tone="border-rose-400/20 bg-rose-500/12 text-rose-300" />
              <MetricTile label="เปิด Editor (ครั้ง)" value={formatNumber(current.totals.editorOpens)} helper={`${formatNumber(current.totals.users)} users · ${formatNumber(current.totals.sessions)} sessions · started ${formatNumber(current.totals.pipelineStarts)} · jobs ${formatNumber(current.totals.pipelineJobs)}`} icon={Users} tone="border-sky-400/20 bg-sky-500/12 text-sky-300" />
            </section>

            {/* ── 5. Server job outcomes ────────────────────────────────────────── */}
            {jobOutcomes && jobOutcomes.total > 0 && (
              <Panel>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">งานจริง (server) — บั๊กระบบตัวจริง (งานเรนเดอร์ที่ล้มเหลว) <InfoTip label="Job outcomes" /></h2>
                  <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                </div>
                <p className="mb-4 text-xs text-slate-500">แผงนี้คือจำนวนบั๊กระบบที่เชื่อถือได้ (authoritative) — นับจาก VideoJob ที่ล้มเหลวจริงฝั่ง server ไม่ใช่ telemetry ฝั่ง client</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">งานทั้งหมด</div><div className="mt-1 text-2xl font-semibold text-white">{formatNumber(jobOutcomes.total)}</div><div className="mt-1 text-xs text-slate-500">done {formatNumber(jobOutcomes.done)} · processing {formatNumber(jobOutcomes.processing)}</div></div>
                  <div className="rounded-md border border-rose-400/20 bg-rose-500/[0.07] p-3"><div className="text-xs text-rose-300/80">ล้มเหลว: บั๊กระบบ</div><div className="mt-1 text-2xl font-semibold text-rose-200">{formatNumber(jobOutcomes.systemFailed)}</div><div className="mt-1 text-xs text-rose-300/70">ของเรา → แก้โค้ด</div></div>
                  <div className="rounded-md border border-violet-400/20 bg-violet-500/[0.07] p-3"><div className="text-xs text-violet-300/80">ชนเพดานแผน (โควต้า)</div><div className="mt-1 text-2xl font-semibold text-violet-200">{formatNumber(jobOutcomes.quotaFailed)}</div><div className="mt-1 text-xs text-violet-300/70">ชนเพดานนาที/คลิป — สัญญาณราคา/อัปเกรด ไม่ใช่บั๊ก</div></div>
                  <div className="rounded-md border border-amber-400/20 bg-amber-500/[0.07] p-3"><div className="text-xs text-amber-300/80">ล้มเหลว: คีย์ลูกค้า</div><div className="mt-1 text-2xl font-semibold text-amber-200">{formatNumber(jobOutcomes.byokFailed)}</div><div className="mt-1 text-xs text-amber-300/70">BYOK → แจ้งลูกค้า</div></div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">ล้มเหลว: noise</div><div className="mt-1 text-2xl font-semibold text-slate-300">{formatNumber(jobOutcomes.noiseFailed)}</div><div className="mt-1 text-xs text-slate-600">superseded/cancel</div></div>
                </div>
                {jobOutcomes.failedByStage.length > 0 && (
                  <div className="mt-4 divide-y divide-white/10">
                    {jobOutcomes.failedByStage.map((row) => (
                      <div key={`${row.stage}:${row.kind}`} className="grid gap-2 py-3 sm:grid-cols-[150px_1fr_56px] sm:items-center">
                        <div className={cn("inline-flex w-fit items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold", row.kind === "system" ? "bg-rose-500/10 text-rose-300" : row.kind === "quota" ? "bg-violet-500/10 text-violet-300" : row.kind === "byok" ? "bg-amber-500/10 text-amber-300" : "bg-white/10 text-slate-300")}>{row.stageLabel} · {row.kind === "system" ? "ระบบ" : row.kind === "quota" ? "ชนเพดานแผน" : row.kind === "byok" ? "คีย์ลูกค้า" : "noise"}</div>
                        <div className="min-w-0 truncate text-sm text-slate-300">{row.sample || "-"}</div>
                        <div className="text-right text-lg font-semibold text-white">{formatNumber(row.count)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            )}

            {/* ── 6. Session funnel + AI Notes ──────────────────────────────────── */}
            <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
              <Panel>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">งานสร้างวิดีโอ — หลุดตรงไหน <InfoTip label="Session funnel" /></h2>
                    <p className="mt-1 text-xs text-slate-500">จุดหลุดสูงสุด: {worstDrop ? `${worstDrop.label} (${worstDrop.dropOffPct}%)` : "-"} · นับจากงานเรนเดอร์จริง (VideoJob) {formatNumber(current.totals.funnelRuns)} งาน — ตัดบัญชีทีมงานออก · ช่วงที่เลือก</p>
                  </div>
                  <BarChart3 className="h-5 w-5 text-sky-300" />
                </div>
                <div className="space-y-3">
                  {current.funnel.map((item, index) => {
                    const width = Math.max(5, Math.min(100, item.conversionPct));
                    return (
                      <div key={item.key} className="grid gap-2 sm:grid-cols-[150px_1fr_92px] sm:items-center">
                        <div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-100">{index + 1}. {item.label}</div><div className="text-xs text-slate-500">{formatNumber(item.count)} ครั้ง</div></div>
                        <div className="h-9 overflow-hidden rounded-md bg-slate-900 ring-1 ring-white/10"><div className={cn("flex h-full items-center justify-end rounded-md px-2 text-xs font-semibold text-slate-950 transition-all", index === 0 ? "bg-slate-200" : item.dropOffPct > 35 ? "bg-rose-300" : item.dropOffPct > 20 ? "bg-amber-300" : "bg-emerald-300")} style={{ width: `${width}%` }}>{item.conversionPct}%</div></div>
                        <div className="flex items-center gap-1 text-xs text-slate-400 sm:justify-end">Drop-off <InfoTip label="Drop-off" /><span className={cn("font-semibold", item.dropOffPct > 35 ? "text-rose-300" : item.dropOffPct > 20 ? "text-amber-300" : "text-emerald-300")}>{item.dropOffPct}%</span></div>
                      </div>
                    );
                  })}
                </div>
              </Panel>
              <Panel>
                <h2 className="text-lg font-semibold text-white">AI Notes — ข้อสังเกตอัตโนมัติ</h2>
                <div className="mt-4 space-y-3">
                  {(current.recommendations.length ? current.recommendations : ["ยังไม่มีสัญญาณผิดปกติชัดเจน รอข้อมูลจริงสะสมเพิ่ม"]).map((item) => (
                    <div key={item} className="rounded-md border border-white/10 bg-black/20 p-3 text-sm leading-relaxed text-slate-200">{item}</div>
                  ))}
                </div>
              </Panel>
            </section>

            {/* ── 7. Pipeline steps + Status stuck ──────────────────────────────── */}
            <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
              <Panel>
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-lg font-semibold text-white">ขั้นตอน pipeline — ช้า/พังตรงไหน</h2>
                  <div className="flex items-center gap-2 text-xs text-slate-500">p50 <InfoTip label="p50" /> p95 <InfoTip label="p95" /></div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-sm">
                    <thead className="border-b border-white/10 text-xs uppercase text-slate-500"><tr><th className="py-3 font-semibold">ขั้นตอน</th><th className="py-3 font-semibold">เริ่ม</th><th className="py-3 font-semibold">สำเร็จ</th><th className="py-3 font-semibold">Error</th><th className="py-3 font-semibold">ยังไม่จบ</th><th className="py-3 font-semibold">p50</th><th className="py-3 font-semibold">p95</th><th className="py-3 font-semibold">Success</th></tr></thead>
                    <tbody className="divide-y divide-white/10">
                      {current.steps.map((step) => (
                        <tr key={step.step} className="text-slate-300">
                          <td className="py-3 font-semibold text-white">{step.label}</td>
                          <td className="py-3">{formatNumber(step.started)}</td>
                          <td className="py-3 text-emerald-300">{formatNumber(step.done)}</td>
                          <td className="py-3 text-rose-300">{formatNumber(step.error)}</td>
                          <td className="py-3 text-amber-300">{formatNumber(step.notFinished)}</td>
                          <td className="py-3">{formatMs(step.p50Ms)}</td>
                          <td className={cn("py-3", (step.p95Ms ?? 0) > 20 * 60_000 && "font-semibold text-amber-300")}>{formatMs(step.p95Ms)}</td>
                          <td className="py-3">{step.successPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {current.steps.length === 0 && <div className="py-8 text-center text-sm text-slate-500">ยังไม่มีข้อมูล pipeline</div>}
                </div>
              </Panel>
              <Panel>
                <h2 className="text-lg font-semibold text-white">Status stuck</h2>
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">PROCESSING &gt;20 นาที</div><div className="mt-2 text-2xl font-semibold text-white">{formatNumber(current.staleProcessing.total)}</div></div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">มี output แล้ว</div><div className="mt-2 text-xl font-semibold text-emerald-300">{formatNumber(current.staleProcessing.existingOutput)}</div></div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">ไม่มี output</div><div className="mt-2 text-xl font-semibold text-rose-300">{formatNumber(current.staleProcessing.total - current.staleProcessing.existingOutput)}</div></div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-slate-500">งานเก่าสุด {current.staleProcessing.oldestAgeMinutes == null ? "-" : `${formatNumber(current.staleProcessing.oldestAgeMinutes / 60, 1)} ชม.`} · complete ได้ {formatNumber(current.staleProcessing.completeCandidates)} · fail ได้ {formatNumber(current.staleProcessing.failCandidates)}</p>
                <button type="button" onClick={applyProcessingReconcile} disabled={reconcileBusy || current.staleProcessing.completeCandidates <= 0}
                  className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-3 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-45">
                  {reconcileBusy && <Loader2 className="h-4 w-4 animate-spin" />} แก้สถานะงานที่มี output
                </button>
                {reconcileMessage && <p className="mt-2 text-xs leading-relaxed text-slate-400">{reconcileMessage}</p>}
              </Panel>
            </section>

            {/* ── 8. System errors ──────────────────────────────────────────────── */}
            <Panel>
              <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">Error telemetry — เหตุการณ์ที่ต้องไล่ดู (client+server) <InfoTip label="Error telemetry" /></h2>
              <p className="mt-1 text-xs text-slate-500">จาก telemetry — เป็นสัญญาณ; จำนวนบั๊กชี้ขาดดูแผง &ldquo;งานจริง (server)&rdquo; ด้านบน</p>
              <div className="mt-4 divide-y divide-white/10">
                {current.errors.length === 0 && <div className="py-6 text-sm text-emerald-300/80">ไม่มี error telemetry ในช่วงนี้ 🎉 (คีย์ลูกค้า/quota/noise แยกไว้ด้านล่าง)</div>}
                {current.errors.map((item) => (
                  <div key={`${item.stepLabel}:${item.label}`} className="grid gap-2 py-3 sm:grid-cols-[110px_1fr_80px] sm:items-center">
                    <div className="rounded-full bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300">{item.stepLabel}</div>
                    <div className="min-w-0 text-sm text-slate-200"><div className="truncate">{item.label}</div><div className="mt-1 text-xs text-slate-500">ล่าสุด {new Date(item.lastSeen).toLocaleString("th-TH")}</div></div>
                    <div className="text-right text-lg font-semibold text-white">{formatNumber(item.count)}</div>
                  </div>
                ))}
              </div>
              {current.byokErrors.length > 0 && (
                <div className="mt-5 rounded-md border border-amber-400/20 bg-amber-500/[0.06] p-3">
                  <div className="text-sm font-semibold text-amber-200">ปัญหาคีย์ลูกค้า (BYOK) — ให้ support ช่วย ไม่ใช่บั๊กเรา</div>
                  <div className="mt-2 divide-y divide-white/10">
                    {current.byokErrors.map((item) => (
                      <div key={`byok:${item.stepLabel}:${item.label}`} className="grid gap-2 py-2 text-sm sm:grid-cols-[140px_1fr_64px] sm:items-center"><div className="text-xs font-semibold text-amber-300">{item.stepLabel}</div><div className="min-w-0 text-slate-300"><div className="truncate">{item.label}</div></div><div className="text-right font-semibold text-slate-200">{formatNumber(item.count)}</div></div>
                    ))}
                  </div>
                </div>
              )}
              {current.noise.length > 0 && (
                <div className="mt-5 rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-sm font-semibold text-slate-200">Noise ที่แยกออก (ไม่กระทบ Health Score)</div>
                  <div className="mt-2 divide-y divide-white/10">
                    {current.noise.map((item) => (
                      <div key={`${item.reason}:${item.stepLabel}:${item.label}`} className="grid gap-2 py-2 text-sm sm:grid-cols-[140px_1fr_64px] sm:items-center"><div className="text-xs font-semibold text-amber-300">{item.reason ?? "noise"}</div><div className="min-w-0 text-slate-400"><div className="truncate">{item.label}</div><div className="mt-0.5 text-xs text-slate-600">{item.stepLabel}</div></div><div className="text-right font-semibold text-slate-200">{formatNumber(item.count)}</div></div>
                    ))}
                  </div>
                </div>
              )}
            </Panel>

            {/* ── 9. DEV DRAWER — technical detail, collapsed by default ─────────── */}
            <section className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
              <button type="button" onClick={() => setDevOpen((v) => !v)} className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-white/[0.03]">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-500/15"><Database className="h-4 w-4 text-slate-300" /></div>
                <div><div className="text-sm font-semibold text-white">รายละเอียดสำหรับทีม dev</div><div className="text-xs text-slate-500">Web Vitals · Playback · B-roll · Render — เชิงเทคนิค</div></div>
                <span className="ml-auto text-slate-500">{devOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
              </button>
              {devOpen && (
                <div className="border-t border-white/10 p-4 sm:p-5 space-y-5">
                  {/* Render + Web Vitals */}
                  <div className="grid gap-5 lg:grid-cols-2">
                    {renderStats && (
                      <Panel>
                        <h3 className="flex items-center gap-2 text-lg font-semibold text-white"><TimerReset className="h-5 w-5 text-amber-300" /> Render (จาก RenderJob)</h3>
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">งานเรนเดอร์</div><div className="mt-1 text-2xl font-semibold text-white">{formatNumber(renderStats.done)}<span className="text-sm font-normal text-slate-500">/{formatNumber(renderStats.total)}</span></div><div className="mt-1 text-xs text-slate-500">success {renderStats.successPct}% · fail {formatNumber(renderStats.failed)}</div></div>
                          <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">เวลา p95 / p50</div><div className="mt-1 text-2xl font-semibold text-white">{formatMs(renderStats.p95Ms)}</div><div className="mt-1 text-xs text-slate-500">p50 {formatMs(renderStats.p50Ms)}</div></div>
                          <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">Web / MCP</div><div className="mt-1 text-lg font-semibold text-white">{formatNumber(renderStats.web)} / {formatNumber(renderStats.mcp)}</div></div>
                          <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">คิว / กำลังทำ</div><div className="mt-1 text-lg font-semibold text-white">{formatNumber(renderStats.queued)} / {formatNumber(renderStats.running)}</div></div>
                        </div>
                        <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">ฝังซับ (BURN): <span className="font-semibold text-emerald-300">{formatNumber(renderStats.burnDone)}/{formatNumber(renderStats.burnTotal)}</span> · ยกเลิก {formatNumber(renderStats.cancelled)}</div>
                      </Panel>
                    )}
                    <Panel>
                      <h3 className="text-lg font-semibold text-white">Web Vitals</h3>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">{current.vitals.map((vital) => <VitalPill key={vital.metric} vital={vital} />)}</div>
                    </Panel>
                  </div>
                  {/* Playback + B-roll */}
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel>
                      <h3 className="flex items-center gap-2 text-lg font-semibold text-white"><Radio className="h-5 w-5 text-sky-300" /> Playback Health</h3>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="flex items-center gap-1 text-xs text-slate-500">First frame p95 <InfoTip label="First frame" /></div><div className="mt-2 text-2xl font-semibold text-white">{formatMs(current.playback.firstFrameP95Ms)}</div><div className="mt-1 text-xs text-slate-500">p50 {formatMs(current.playback.firstFrameP50Ms)} · {formatNumber(current.playback.firstFrames)} ครั้ง</div></div>
                        <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="flex items-center gap-1 text-xs text-slate-500">Buffering <InfoTip label="Buffering sessions" /></div><div className="mt-2 text-2xl font-semibold text-white">{current.playback.bufferingSessionPct}%</div><div className="mt-1 text-xs text-slate-500">waiting {formatNumber(current.playback.waitingEvents)} · stalled {formatNumber(current.playback.stalledEvents)}</div></div>
                      </div>
                      <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">Sessions <span className="font-semibold text-sky-300">{formatNumber(current.playback.sessions)}</span> · errors <span className="font-semibold text-rose-300">{formatNumber(current.playback.errors)}</span> · canplay p95 <span className="font-semibold text-white">{formatMs(current.playback.canPlayP95Ms)}</span></div>
                    </Panel>
                    <Panel>
                      <h3 className="flex items-center gap-2 text-lg font-semibold text-white"><Database className="h-5 w-5 text-emerald-300" /> B-roll Resource</h3>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">B-roll p95</div><div className="mt-1 text-2xl font-semibold text-white">{formatMs(current.broll.p95Ms)}</div><div className="mt-1 text-xs text-slate-500">runs {formatNumber(current.broll.runs)} · success {current.broll.successPct}%</div></div>
                        <div className="rounded-md border border-white/10 bg-black/20 p-3"><div className="text-xs text-slate-500">Cache hit / fail</div><div className="mt-1 text-2xl font-semibold text-emerald-300">{current.broll.cacheHitPct}%</div><div className="mt-1 text-xs text-slate-500">fail {current.broll.downloadFailPct}% · {formatNumber(current.broll.downloadedCount)} new</div></div>
                      </div>
                      <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">Provider: <span className="font-semibold text-emerald-300">Pexels {formatNumber(current.broll.selectedPexelsCount)}</span> · <span className="font-semibold text-emerald-300">Pixabay {formatNumber(current.broll.selectedPixabayCount)}</span> · served ~{formatNumber(current.broll.servedClipAvg, 1)}/run</div>
                      <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">phase p95 — search {formatMs(current.broll.searchP95Ms)} · rank {formatMs(current.broll.rankingP95Ms)} · download {formatMs(current.broll.downloadP95Ms)} · normalize {formatMs(current.broll.normalizeP95Ms)}</div>
                      <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">normalize ran/skip/fail {formatNumber(current.broll.normalizeRanCount)}/{formatNumber(current.broll.normalizeSkippedCount)}/{formatNumber(current.broll.normalizeFailedCount)} · no-candidate {formatNumber(current.broll.noCandidateKeywords)}</div>
                    </Panel>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
