"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
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

type FunnelRow = {
  key: string;
  label: string;
  count: number;
  conversionPct: number;
  dropOffPct: number;
  previousCount: number;
};

type StepRow = {
  step: string;
  label: string;
  started: number;
  done: number;
  error: number;
  skipped: number;
  notFinished: number;
  p50Ms: number | null;
  p95Ms: number | null;
  successPct: number;
};

type ErrorRow = {
  count: number;
  label: string;
  stepLabel: string;
  lastSeen: string;
};

type NoiseRow = ErrorRow & {
  reason?: string;
};

type VitalRow = {
  metric: "LCP" | "INP" | "CLS" | string;
  p75: number | null;
  count: number;
};

type CountRow = {
  label: string;
  count: number;
};

type InsightSummary = {
  totals: {
    sessions: number;
    users: number;
    editorSessions: number;
    editorOpens: number;
    pipelineJobs: number;
    pipelineStarts: number;
    events: number;
    errors: number;
    byokErrorCount: number;
    rawErrors: number;
    noiseEvents: number;
    frontendErrors: number;
    serverErrors: number;
    renderSuccessPct: number;
    videoCompletionPct: number;
    renderTaskSuccessPct: number;
    healthScore: number;
    funnelMode: "run" | "event" | "session";
    funnelRuns: number;
    videoJobs: {
      total: number;
      completed: number;
      processing: number;
      failed: number;
      pending: number;
      outputReady: number;
      statusStuckWithOutput: number;
      processingWithoutOutput: number;
      completionPct: number;
      outputReadyPct: number;
    };
  };
  funnel: FunnelRow[];
  steps: StepRow[];
  errors: ErrorRow[];
  byokErrors: ErrorRow[];
  noise: NoiseRow[];
  vitals: VitalRow[];
  resource: {
    renderCount: number;
    renderStartedCount: number;
    mainRenderCount: number;
    mainRenderStartedCount: number;
    burnRenderCount: number;
    burnRenderStartedCount: number;
    renderTaskSuccessPct: number;
    renderP50Ms: number | null;
    renderP95Ms: number | null;
    avgConcurrency: number | null;
    avgActiveRenderSlots: number | null;
    renderQueueP50Ms: number | null;
    renderQueueP95Ms: number | null;
    minFreeMemGb: number | null;
    lowMemoryStarts: number;
  };
  broll: {
    requests: number;
    runs: number;
    errors: number;
    successPct: number;
    p50Ms: number | null;
    p95Ms: number | null;
    searchP95Ms: number | null;
    rankingP95Ms: number | null;
    selectionP95Ms: number | null;
    downloadP95Ms: number | null;
    normalizeP95Ms: number | null;
    cacheHitCount: number;
    downloadedCount: number;
    downloadFailCount: number;
    cacheHitPct: number;
    downloadFailPct: number;
    servedClipTotal: number;
    servedClipAvg: number | null;
    searchQueriesAvg: number | null;
    noCandidateKeywords: number;
    forcedFallbackCount: number;
    profileFallbackUsedCount: number;
    llmRankingUsedCount: number;
    llmRankingFailedCount: number;
    emptyResultCount: number;
    normalizeRanCount: number;
    normalizeSkippedCount: number;
    normalizeFailedCount: number;
    selectedPexelsCount: number;
    selectedPixabayCount: number;
    providerMix: CountRow[];
    resolvedSources: CountRow[];
    contentProfiles: CountRow[];
  };
  playback: {
    sessions: number;
    uniqueSessions: number;
    firstFrames: number;
    canPlay: number;
    waitingEvents: number;
    stalledEvents: number;
    errors: number;
    bufferingSessions: number;
    bufferingSessionPct: number;
    errorPct: number;
    firstFrameP50Ms: number | null;
    firstFrameP95Ms: number | null;
    canPlayP95Ms: number | null;
    startupFromLoadP95Ms: number | null;
    pages: CountRow[];
    routes: CountRow[];
  };
  staleProcessing: {
    total: number;
    completeCandidates: number;
    failCandidates: number;
    keepCandidates: number;
    withOutputUrl: number;
    existingOutput: number;
    missingOutput: number;
    oldestAgeMinutes: number | null;
  };
  recommendations: string[];
};

type ActivationData = {
  signups: number;
  hasGeminiKey: number;
  hasStockKey: number;
  paidTotal: number;
  paidWithoutGeminiKey: number;
  managed?: boolean;
  openedEditor: number;
  startedPipeline: number;
  completedFirstVideo: number;
  repeatCreators: number;
  windowSignups: number;
  windowCompletedUsers: number;
  prevWindowCompletedUsers: number;
};

type JobOutcomes = {
  total: number;
  done: number;
  failed: number;
  processing: number;
  queued: number;
  systemFailed: number;
  byokFailed: number;
  noiseFailed: number;
  failedByStage: Array<{
    stage: string;
    stageLabel: string;
    kind: "system" | "byok" | "noise";
    count: number;
    sample: string;
  }>;
};

type InsightsResponse = {
  range: { days: number; since: string; until: string };
  activation: ActivationData;
  jobOutcomes: JobOutcomes;
  current: InsightSummary;
  previous: InsightSummary;
  processingReconcile?: { dryRun: boolean };
};

type ReconcileApplyResponse = {
  error?: string;
  applied?: {
    completed?: number;
    failed?: number;
    skipped?: number;
  } | null;
};

const metricHelp: Record<string, string> = {
  "Health Score": "คะแนนสุขภาพระบบ 0–100 (v2) — คิดเฉพาะ error ของระบบเรา (ไม่รวมคีย์ลูกค้า/noise) + render p95 + video completion + งานค้าง ยิ่งใกล้ 100 ยิ่งดี",
  "Error ระบบ": "บั๊กของเราที่ต้องแก้โค้ด (ตัด noise และปัญหาคีย์ลูกค้าออกแล้ว) — กองนี้คือสิ่งที่ทีม dev ต้องไล่แก้",
  "Job outcomes": "ผลงานจริงจาก VideoJob ฝั่ง server (status เซิร์ฟเวอร์เขียน ไม่หายตอนปิดแท็บ) — บอกว่างานที่ล้มเหลวพังที่ขั้นไหน และเป็นบั๊กเราหรือคีย์ลูกค้า",
  "Drop-off": "เปอร์เซ็นต์ session ที่ไปไม่ถึงขั้นถัดไป — นับต่อ session หน่วยเดียวกันทุกขั้น (apples-to-apples) จึงเทียบกันได้จริง",
  "Activation": "สัดส่วนคนที่ได้ 'คุณค่าครั้งแรก' = ได้วิดีโอเสร็จอย่างน้อย 1 ตัว เป็นตัวชี้วัดว่าคนใช้ product ได้จริงไหม สำคัญกว่าตัวเลขระบบทุกตัว",
  "BYOK key": "ลูกค้าต้องใส่ API key ของตัวเอง (Gemini จำเป็นเสมอ) ถ้ายังไม่ตั้ง = ระบบเจนวิดีโอไม่ได้ แม้จ่ายเงินแล้ว — ไม่ใช่บั๊กของเรา แต่เสียลูกค้าจริง",
  "Activation funnel": "เส้นทางต่อ 'คน' (สะสมทั้งหมด ไม่ขึ้นกับช่วงเวลา): สมัคร → เปิด editor → กดเริ่ม → ได้วิดีโอ → ทำซ้ำ ใช้ดูว่าเสียลูกค้าตรงไหนกว่าจะได้ผลลัพธ์",
  "Session funnel": "เส้นทางต่อ 'session' ในช่วงเวลาที่เลือก ใช้ดูพฤติกรรมระหว่างใช้ editor หนึ่งครั้ง (คนละมุมกับ Activation ที่นับต่อคน)",
  "p50": "ค่ากลาง: ผู้ใช้ครึ่งหนึ่งเร็วกว่าเวลานี้ และอีกครึ่งหนึ่งช้ากว่านี้",
  "p75": "75% ของผู้ใช้ได้ผลลัพธ์เร็วกว่า/ดีกว่าค่านี้ ใช้ดูประสบการณ์จริงโดยรวม",
  "p95": "เคสช้าเกือบสุด: 95% ของงานเร็วกว่าเวลานี้ ใช้หาคอขวดและเคสหนัก",
  "LCP": "เวลาที่เนื้อหาหลักของหน้าขึ้นจอ ถ้าสูง ผู้ใช้รู้สึกว่าหน้าโหลดช้า",
  "INP": "ความหน่วงตอนกด คลิก หรือพิมพ์ ถ้าสูง UI จะรู้สึกหน่วง",
  "CLS": "คะแนนหน้ากระโดดหรือเลื่อนเอง ถ้าสูง ผู้ใช้อาจกดผิดหรืออ่านยาก",
  "Concurrency": "จำนวน thread/งานย่อยที่ server ใช้ช่วยเรนเดอร์พร้อมกัน ยิ่งสูงอาจเร็วขึ้นแต่กิน RAM/CPU มากขึ้น",
  "Render Queue": "เวลาที่งานรอคิวก่อนเข้า renderMedia ใช้ดูว่ามีการชนกันหลายงานพร้อมกันหรือไม่",
  "Free RAM": "RAM ที่เหลือบน server ตอนเริ่ม render ถ้าต่ำกว่า 1 GB เสี่ยงค้างหรือ fail",
  "Video completed": "เปอร์เซ็นต์งานจากตาราง Video ที่ status เป็น COMPLETED ในช่วงเวลาที่เลือก",
  "Telemetry errors": "error จริงหลังแยก noise ออกแล้ว เช่น play/pause race, cancelled, superseded จะไม่หัก Health Score",
  "First frame": "เวลาจากการกด play จนวิดีโอเริ่มแสดงภาพจริง ถ้าสูง ผู้ใช้จะรู้สึกว่าคลิปเปิดช้า",
  "Buffering sessions": "เปอร์เซ็นต์ session ที่มี waiting หรือ stalled ระหว่างดู ใช้วัดอาการกระตุกจริง",
  "B-roll p95": "เวลาฝั่ง server ของ fetch-stock ทั้งก้อน ใช้ดูว่าขั้นหา B-roll ช้าจริงแค่ไหน",
  "B-roll phase": "เวลาย่อยของ search/rank/select/download จะมีข้อมูลละเอียดขึ้นกับ event ใหม่หลัง deploy",
  "Cache hit": "สัดส่วนคลิปที่ใช้ไฟล์เดิมบน server ได้ ถ้าต่ำมาก server ต้องโหลด/normalize ใหม่บ่อย",
  "Download fail": "สัดส่วนโหลด stock ล้มเหลว ถ้าสูงให้ดู provider, network timeout หรือไฟล์ต้นทาง",
};

function InfoTip({ label }: { label: keyof typeof metricHelp | string }) {
  const text = metricHelp[label] ?? label;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={text}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition hover:bg-white/10 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-400/50"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      <span className="pointer-events-none absolute left-1/2 top-6 z-30 hidden w-64 -translate-x-1/2 rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-left text-xs leading-relaxed text-slate-200 shadow-xl group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(value);
}

function pctOf(value: number, total: number) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

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

function MetricTile({
  label,
  value,
  helper,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  helper: string;
  icon: React.ElementType;
  tone: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            {label}
            {metricHelp[label] && <InfoTip label={label} />}
          </div>
          <div className="mt-2 text-3xl font-semibold tracking-normal text-white">{value}</div>
        </div>
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-md border", tone)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-500">{helper}</p>
    </div>
  );
}

function VitalPill({ vital }: { vital: VitalRow }) {
  const metric = vital.metric.toUpperCase();
  const value = metric === "CLS"
    ? vital.p75 == null ? "-" : Number(vital.p75).toFixed(3)
    : formatMs(vital.p75);
  const good = metric === "LCP" ? (vital.p75 ?? Infinity) <= 2500
    : metric === "INP" ? (vital.p75 ?? Infinity) <= 200
    : metric === "CLS" ? (vital.p75 ?? Infinity) <= 0.1
    : false;

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
          {metric}
          <InfoTip label={metric} />
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", good ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300")}>
          {good ? "ดี" : "ต้องดู"}
        </span>
      </div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
      <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
        p75 <InfoTip label="p75" /> · {formatNumber(vital.count)} ครั้ง
      </div>
    </div>
  );
}

export default function AdminInsightsPage() {
  const [days, setDays] = useState(1);
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);

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
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [days, refreshNonce]);

  const current = data?.current;
  const previous = data?.previous;
  const activation = data?.activation;
  const jobOutcomes = data?.jobOutcomes;
  const hasData = !!current && (current.totals.events > 0 || current.totals.videoJobs.total > 0);
  const worstDrop = useMemo(() => {
    if (!current) return null;
    return current.funnel.slice(1).sort((a, b) => b.dropOffPct - a.dropOffPct)[0] ?? null;
  }, [current]);
  const activationSteps = useMemo(() => {
    if (!activation) return [];
    return [
      { label: "สมัคร", count: activation.signups, cause: "" },
      { label: "เปิด editor", count: activation.openedEditor, cause: "สมัครแล้วไม่เข้าใช้ — onboarding / อีเมลต้อนรับ" },
      { label: "กดเริ่มสร้าง", count: activation.startedPipeline, cause: activation.managed ? "เข้าแล้วไม่กดเริ่ม — UX / onboarding" : "เข้าแล้วไม่กดเริ่ม — UX หรือยังไม่ตั้งคีย์" },
      { label: "ได้วิดีโอเสร็จ", count: activation.completedFirstVideo, cause: "เริ่มแล้วไม่จบ — เช็คความเร็วระบบ (p95) ด้านล่าง" },
      { label: "ทำซ้ำ ≥2", count: activation.repeatCreators, cause: "ทำครั้งเดียวแล้วหาย — คุณภาพ / ความคุ้มค่า" },
    ];
  }, [activation]);

  async function applyProcessingReconcile() {
    setReconcileBusy(true);
    setReconcileMessage(null);
    try {
      const res = await fetch("/api/admin/videos/reconcile-processing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun: false,
          staleAfterMinutes: 20,
          failAfterHours: 24,
          failMissingOutput: false,
          limit: 100,
        }),
      });
      const body = await res.json().catch(() => ({})) as ReconcileApplyResponse;
      if (!res.ok) throw new Error(body.error ?? "reconcile ไม่สำเร็จ");
      const completed = body.applied?.completed ?? 0;
      const skipped = body.applied?.skipped ?? 0;
      setReconcileMessage(`แก้สถานะแล้ว ${formatNumber(completed)} งาน · ข้าม ${formatNumber(skipped)} งาน`);
      setRefreshNonce((value) => value + 1);
    } catch (err) {
      setReconcileMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setReconcileBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#080b12] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-200">
              <Activity className="h-3.5 w-3.5" />
              Real Usage Insights
            </div>
            <h1 className="text-2xl font-semibold tracking-normal text-white sm:text-3xl">ระบบใช้งานจริงบอกอะไรเรา</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              โฟกัสหน้า Video Editor: เห็นคนหลุดตรงไหน, ขั้นไหนช้า, error ไหนควรแก้ก่อน และ render ใช้ resource แค่ไหน
            </p>
          </div>

          <div className="inline-flex w-full rounded-lg border border-white/10 bg-white/[0.035] p-1 sm:w-auto">
            {[1, 7, 14, 30].map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDays(option)}
                className={cn(
                  "flex-1 rounded-md px-3 py-2 text-sm font-semibold transition sm:flex-none",
                  days === option ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/10 hover:text-white",
                )}
              >
                {option === 1 ? "24 ชม." : `${option} วัน`}
              </button>
            ))}
          </div>
        </header>

        {/* ── Cost & Margin panel (additive — do not modify below sections) ── */}
        <CostMarginPanel />

        {loading && (
          <div className="flex h-72 items-center justify-center rounded-lg border border-white/10 bg-white/[0.025]">
            <Loader2 className="h-6 w-6 animate-spin text-sky-300" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
            {error}
          </div>
        )}

        {!loading && !error && current && (
          <>
            {!hasData && (
              <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-100">
                ยังไม่มีข้อมูลสะสม ลองใช้งาน Video Editor 1-2 รอบ แล้วกลับมาดูหน้านี้อีกครั้ง
              </div>
            )}

            {activation && (
              <section className="rounded-lg border border-sky-400/25 bg-gradient-to-r from-sky-500/12 via-sky-500/5 to-transparent p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-200">
                      North Star · Activation <InfoTip label="Activation" />
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white sm:text-3xl">
                      {formatNumber(activation.signups)} สมัคร{" "}
                      <span className="text-slate-500">→</span>{" "}
                      {formatNumber(activation.completedFirstVideo)} ได้วิดีโอแรก{" "}
                      <span className={cn(
                        "ml-1 text-xl font-bold sm:text-2xl",
                        pctOf(activation.completedFirstVideo, activation.signups) < 20 ? "text-rose-300" : "text-emerald-300",
                      )}>
                        ({pctOf(activation.completedFirstVideo, activation.signups)}%)
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-400">
                      ช่วงที่เลือก: ได้วิดีโอ {formatNumber(activation.windowCompletedUsers)} คน · ก่อนหน้า {formatNumber(activation.prevWindowCompletedUsers)} คน
                      {activation.windowCompletedUsers !== activation.prevWindowCompletedUsers && (
                        <span className={cn("ml-1 font-semibold", activation.windowCompletedUsers >= activation.prevWindowCompletedUsers ? "text-emerald-300" : "text-rose-300")}>
                          {activation.windowCompletedUsers >= activation.prevWindowCompletedUsers ? "▲" : "▼"}
                        </span>
                      )}
                    </p>
                  </div>
                  {!activation.managed && activation.paidWithoutGeminiKey > 0 && (
                    <div className="rounded-md border border-rose-400/25 bg-rose-500/10 p-3 sm:max-w-xs">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-rose-200">
                        🔴 {formatNumber(activation.paidWithoutGeminiKey)}/{formatNumber(activation.paidTotal)} ลูกค้าจ่ายเงินยังไม่ตั้งคีย์
                        <InfoTip label="BYOK key" />
                      </div>
                      <div className="mt-1 text-xs leading-relaxed text-rose-300/80">
                        จ่ายแล้วแต่ใช้ระบบไม่ได้ — โอกาสปลดล็อก usage/รายได้ทันที (เบอร์ 1)
                      </div>
                    </div>
                  )}
                </div>
                <p className="mt-3 border-t border-white/10 pt-3 text-xs leading-relaxed text-sky-100/70">
                  💡 <span className="font-semibold">สำหรับ CEO:</span> ตัวเลขสุขภาพธุรกิจตัวเดียวที่ต้องดูก่อน — ถ้า &ldquo;ได้วิดีโอแรก %&rdquo; ตก = ปัญหาใหญ่กว่า metric ระบบทุกตัวรวมกัน → ทุ่มแก้ activation ก่อน
                </p>
              </section>
            )}

            {activation && (
              <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">
                      Activation funnel — เสียลูกค้าตรงไหน <InfoTip label="Activation funnel" />
                    </h2>
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
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-100">{index + 1}. {item.label}</div>
                          <div className="text-xs text-slate-500">{formatNumber(item.count)} คน</div>
                        </div>
                        <div className="h-9 overflow-hidden rounded-md bg-slate-900 ring-1 ring-white/10">
                          <div
                            className={cn(
                              "flex h-full items-center justify-end rounded-md px-2 text-xs font-semibold text-slate-950 transition-all",
                              index === 0 ? "bg-slate-200" : drop > 60 ? "bg-rose-300" : drop > 40 ? "bg-amber-300" : "bg-emerald-300",
                            )}
                            style={{ width: `${width}%` }}
                          >
                            {conv}%
                          </div>
                        </div>
                        <div className="text-xs text-slate-400">
                          {index === 0 ? (
                            <span className="text-slate-600">— ฐานเริ่มต้น</span>
                          ) : (
                            <>
                              <span className={cn("font-semibold", drop > 60 ? "text-rose-300" : drop > 40 ? "text-amber-300" : "text-emerald-300")}>หลุด {drop}%</span>
                              <span className="text-slate-500"> · {item.cause}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-3">
                  {activation.managed ? (
                    <div className="rounded-md border border-emerald-400/20 bg-emerald-500/[0.07] p-3">
                      <div className="text-xs text-emerald-300/80">Gemini — ระบบจัดการ (managed)</div>
                      <div className="mt-1 text-lg font-semibold text-emerald-200">ไม่ต้องตั้ง key <span className="text-sm font-normal text-slate-500">· ต้นทุน/กำไรดู Cost &amp; Margin ด้านบน</span></div>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Gemini key (บังคับ) <InfoTip label="BYOK key" /></div>
                        <div className="mt-1 text-lg font-semibold text-white">{formatNumber(activation.hasGeminiKey)}/{formatNumber(activation.signups)} <span className="text-sm font-normal text-slate-500">ตั้งแล้ว</span></div>
                      </div>
                      <div className="rounded-md border border-rose-400/20 bg-rose-500/[0.07] p-3">
                        <div className="text-xs text-rose-300/80">ลูกค้าจ่ายเงินยังไม่ตั้งคีย์</div>
                        <div className="mt-1 text-lg font-semibold text-rose-200">{formatNumber(activation.paidWithoutGeminiKey)}/{formatNumber(activation.paidTotal)}</div>
                      </div>
                    </>
                  )}
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="text-xs text-slate-500">Stock key (Pexels/Pixabay)</div>
                    <div className="mt-1 text-lg font-semibold text-white">{formatNumber(activation.hasStockKey)}/{formatNumber(activation.signups)} <span className="text-sm font-normal text-slate-500">ตั้งแล้ว</span></div>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-slate-500">
                  💡 <span className="font-semibold text-slate-400">สำหรับ CEO:</span> ขั้นที่หลุดเพราะ &ldquo;คีย์/UX&rdquo; แก้ด้วย onboarding (ทีม product) · ขั้นที่หลุดเพราะ &ldquo;ช้า&rdquo; แก้ด้วย perf (ทีม dev) — ดู p95 ในตาราง &ldquo;ขั้นที่ใช้เวลานาน&rdquo;
                </p>
              </section>
            )}

            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <MetricTile
                label="Health Score"
                value={`${current.totals.healthScore}`}
                helper={`ช่วงก่อนหน้า ${previous?.totals.healthScore ?? 0}`}
                icon={Gauge}
                tone={statusTone(current.totals.healthScore)}
              />
              <MetricTile
                label="คนเข้า Editor"
                value={formatNumber(current.totals.editorOpens)}
                helper={`${formatNumber(current.totals.users)} users · ${formatNumber(current.totals.sessions)} sessions · started ${formatNumber(current.totals.pipelineStarts)} ครั้ง · video jobs ${formatNumber(current.totals.pipelineJobs)}`}
                icon={Users}
                tone="border-sky-400/20 bg-sky-500/12 text-sky-300"
              />
              <MetricTile
                label="Video completed"
                value={`${current.totals.videoCompletionPct}%`}
                helper={`${formatNumber(current.totals.videoJobs.completed)}/${formatNumber(current.totals.videoJobs.total)} jobs · output ready ${formatNumber(current.totals.videoJobs.outputReady)}`}
                icon={CheckCircle2}
                tone="border-emerald-400/20 bg-emerald-500/12 text-emerald-300"
              />
              <MetricTile
                label="Error ระบบ"
                value={formatNumber(current.totals.errors)}
                helper={`ระบบเรา ${formatNumber(current.totals.errors)} · คีย์ลูกค้า ${formatNumber(current.totals.byokErrorCount)} · noise ${formatNumber(current.totals.noiseEvents)}`}
                icon={AlertTriangle}
                tone="border-rose-400/20 bg-rose-500/12 text-rose-300"
              />
            </section>

            <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">Session funnel หน้า Video Editor <InfoTip label="Session funnel" /></h2>
                    <p className="mt-1 text-xs text-slate-500">
                      จุดหลุดสูงสุด: {worstDrop ? `${worstDrop.label} (${worstDrop.dropOffPct}%)` : "-"}
                      {" "}· {current.totals.funnelMode === "session"
                        ? `นับต่อ session ${formatNumber(current.totals.funnelRuns)} · ช่วงที่เลือก`
                        : current.totals.funnelMode === "run"
                          ? `นับต่อ run ${formatNumber(current.totals.funnelRuns)} งาน`
                          : "event-count fallback"}
                    </p>
                  </div>
                  <BarChart3 className="h-5 w-5 text-sky-300" />
                </div>

                <div className="space-y-3">
                  {current.funnel.map((item, index) => {
                    const width = Math.max(5, Math.min(100, item.conversionPct));
                    return (
                      <div key={item.key} className="grid gap-2 sm:grid-cols-[150px_1fr_92px] sm:items-center">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-100">{index + 1}. {item.label}</div>
                          <div className="text-xs text-slate-500">{formatNumber(item.count)} ครั้ง</div>
                        </div>
                        <div className="h-9 overflow-hidden rounded-md bg-slate-900 ring-1 ring-white/10">
                          <div
                            className={cn(
                              "flex h-full items-center justify-end rounded-md px-2 text-xs font-semibold text-slate-950 transition-all",
                              index === 0 ? "bg-slate-200" : item.dropOffPct > 35 ? "bg-rose-300" : item.dropOffPct > 20 ? "bg-amber-300" : "bg-emerald-300",
                            )}
                            style={{ width: `${width}%` }}
                          >
                            {item.conversionPct}%
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-slate-400 sm:justify-end">
                          Drop-off <InfoTip label="Drop-off" />
                          <span className={cn("font-semibold", item.dropOffPct > 35 ? "text-rose-300" : item.dropOffPct > 20 ? "text-amber-300" : "text-emerald-300")}>
                            {item.dropOffPct}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="text-lg font-semibold text-white">AI Notes</h2>
                  <div className="mt-4 space-y-3">
                    {(current.recommendations.length ? current.recommendations : ["ยังไม่มีสัญญาณผิดปกติชัดเจน รอข้อมูลจริงสะสมเพิ่ม"]).map((item) => (
                      <div key={item} className="rounded-md border border-white/10 bg-black/20 p-3 text-sm leading-relaxed text-slate-200">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="text-lg font-semibold text-white">Status stuck</h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="text-xs text-slate-500">PROCESSING เกิน 20 นาที</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{formatNumber(current.staleProcessing.total)}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:col-span-2 xl:col-span-1">
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="text-xs text-slate-500">มี output แล้ว</div>
                        <div className="mt-2 text-xl font-semibold text-emerald-300">{formatNumber(current.staleProcessing.existingOutput)}</div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="text-xs text-slate-500">ไม่มี output</div>
                        <div className="mt-2 text-xl font-semibold text-rose-300">{formatNumber(current.staleProcessing.total - current.staleProcessing.existingOutput)}</div>
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-slate-500">
                    งานเก่าสุด {current.staleProcessing.oldestAgeMinutes == null ? "-" : `${formatNumber(current.staleProcessing.oldestAgeMinutes / 60, 1)} ชม.`} · complete ได้ {formatNumber(current.staleProcessing.completeCandidates)} · fail ได้ {formatNumber(current.staleProcessing.failCandidates)}
                  </p>
                  <button
                    type="button"
                    onClick={applyProcessingReconcile}
                    disabled={reconcileBusy || current.staleProcessing.completeCandidates <= 0}
                    className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-3 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {reconcileBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    แก้สถานะงานที่มี output
                  </button>
                  {reconcileMessage && (
                    <p className="mt-2 text-xs leading-relaxed text-slate-400">{reconcileMessage}</p>
                  )}
                </div>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="text-lg font-semibold text-white">Web Vitals</h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                    {current.vitals.map((vital) => <VitalPill key={vital.metric} vital={vital} />)}
                  </div>
                </div>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                    <Radio className="h-5 w-5 text-sky-300" />
                    Playback Health
                  </h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center gap-1 text-xs text-slate-500">First frame p95 <InfoTip label="First frame" /></div>
                      <div className="mt-2 text-2xl font-semibold text-white">{formatMs(current.playback.firstFrameP95Ms)}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        p50 {formatMs(current.playback.firstFrameP50Ms)} · samples {formatNumber(current.playback.firstFrames)}
                      </div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center gap-1 text-xs text-slate-500">Buffering sessions <InfoTip label="Buffering sessions" /></div>
                      <div className="mt-2 text-2xl font-semibold text-white">{current.playback.bufferingSessionPct}%</div>
                      <div className="mt-1 text-xs text-slate-500">
                        waiting {formatNumber(current.playback.waitingEvents)} · stalled {formatNumber(current.playback.stalledEvents)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                    Sessions: <span className="font-semibold text-sky-300">{formatNumber(current.playback.sessions)}</span>
                    {" "}· errors: <span className="font-semibold text-rose-300">{formatNumber(current.playback.errors)}</span>
                    {" "}· canplay p95: <span className="font-semibold text-white">{formatMs(current.playback.canPlayP95Ms)}</span>
                  </div>
                  <div className="mt-3 grid gap-3 text-xs text-slate-400 sm:grid-cols-2 xl:grid-cols-1">
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="mb-2 font-semibold text-slate-200">Pages</div>
                      {(current.playback.pages.length ? current.playback.pages : [{ label: "-", count: 0 }]).map((item) => (
                        <div key={item.label} className="flex items-center justify-between gap-3 py-1">
                          <span className="truncate">{item.label}</span>
                          <span className="font-semibold text-white">{formatNumber(item.count)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="mb-2 font-semibold text-slate-200">Routes</div>
                      {(current.playback.routes.length ? current.playback.routes : [{ label: "-", count: 0 }]).map((item) => (
                        <div key={item.label} className="flex items-center justify-between gap-3 py-1">
                          <span className="truncate">{item.label}</span>
                          <span className="font-semibold text-white">{formatNumber(item.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-lg font-semibold text-white">ขั้นที่ใช้เวลานาน</h2>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    p50 <InfoTip label="p50" /> p95 <InfoTip label="p95" />
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-sm">
                    <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-3 font-semibold">ขั้นตอน</th>
                        <th className="py-3 font-semibold">เริ่ม</th>
                        <th className="py-3 font-semibold">สำเร็จ</th>
                        <th className="py-3 font-semibold">Error</th>
                        <th className="py-3 font-semibold">ยังไม่จบ</th>
                        <th className="py-3 font-semibold">p50</th>
                        <th className="py-3 font-semibold">p95</th>
                        <th className="py-3 font-semibold">Success</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {(current.steps.length ? current.steps : []).map((step) => (
                        <tr key={step.step} className="text-slate-300">
                          <td className="py-3 font-semibold text-white">{step.label}</td>
                          <td className="py-3">{formatNumber(step.started)}</td>
                          <td className="py-3 text-emerald-300">{formatNumber(step.done)}</td>
                          <td className="py-3 text-rose-300">{formatNumber(step.error)}</td>
                          <td className="py-3 text-amber-300">{formatNumber(step.notFinished)}</td>
                          <td className="py-3">{formatMs(step.p50Ms)}</td>
                          <td className="py-3">{formatMs(step.p95Ms)}</td>
                          <td className="py-3">{step.successPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {current.steps.length === 0 && (
                    <div className="py-8 text-center text-sm text-slate-500">ยังไม่มีข้อมูล pipeline</div>
                  )}
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                    <Database className="h-5 w-5 text-emerald-300" />
                    B-roll Resource
                  </h2>
                  <div className="mt-4 grid gap-3">
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center gap-1 text-xs text-slate-500">B-roll p95 <InfoTip label="B-roll p95" /></div>
                      <div className="mt-2 text-2xl font-semibold text-white">{formatMs(current.broll.p95Ms)}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        runs {formatNumber(current.broll.runs)}/{formatNumber(current.broll.requests)} · success {current.broll.successPct}%
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Search p95 <InfoTip label="B-roll phase" /></div>
                        <div className="mt-2 text-xl font-semibold text-white">{formatMs(current.broll.searchP95Ms)}</div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Download p95 <InfoTip label="B-roll phase" /></div>
                        <div className="mt-2 text-xl font-semibold text-white">{formatMs(current.broll.downloadP95Ms)}</div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Rank p95 <InfoTip label="B-roll phase" /></div>
                        <div className="mt-2 text-xl font-semibold text-white">{formatMs(current.broll.rankingP95Ms)}</div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Normalize p95 <InfoTip label="B-roll phase" /></div>
                        <div className="mt-2 text-xl font-semibold text-white">{formatMs(current.broll.normalizeP95Ms)}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Cache hit <InfoTip label="Cache hit" /></div>
                        <div className="mt-2 text-xl font-semibold text-emerald-300">{current.broll.cacheHitPct}%</div>
                        <div className="mt-1 text-xs text-slate-500">{formatNumber(current.broll.cacheHitCount)} cached · {formatNumber(current.broll.downloadedCount)} new</div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Download fail <InfoTip label="Download fail" /></div>
                        <div className="mt-2 text-xl font-semibold text-rose-300">{current.broll.downloadFailPct}%</div>
                        <div className="mt-1 text-xs text-slate-500">{formatNumber(current.broll.downloadFailCount)} fails</div>
                      </div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      Served clips เฉลี่ย: <span className="font-semibold text-sky-300">{formatNumber(current.broll.servedClipAvg, 1)}</span>
                      {" "}· search queries/run: <span className="font-semibold text-sky-300">{formatNumber(current.broll.searchQueriesAvg, 1)}</span>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      Provider: <span className="font-semibold text-emerald-300">Pexels {formatNumber(current.broll.selectedPexelsCount)}</span>
                      {" "}· <span className="font-semibold text-emerald-300">Pixabay {formatNumber(current.broll.selectedPixabayCount)}</span>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      Normalize ran/skipped/failed: <span className="font-semibold text-white">{formatNumber(current.broll.normalizeRanCount)}/{formatNumber(current.broll.normalizeSkippedCount)}/{formatNumber(current.broll.normalizeFailedCount)}</span>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      Fallback: profile <span className="font-semibold text-amber-300">{formatNumber(current.broll.profileFallbackUsedCount)}</span>
                      {" "}· forced <span className="font-semibold text-amber-300">{formatNumber(current.broll.forcedFallbackCount)}</span>
                      {" "}· no candidate <span className="font-semibold text-rose-300">{formatNumber(current.broll.noCandidateKeywords)}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                    <TimerReset className="h-5 w-5 text-amber-300" />
                    Render Resource
                  </h2>
                  <div className="mt-4 grid gap-3">
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center gap-1 text-xs text-slate-500">p95 render <InfoTip label="p95" /></div>
                      <div className="mt-2 text-2xl font-semibold text-white">{formatMs(current.resource.renderP95Ms)}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        render tasks {formatNumber(current.resource.renderCount)}/{formatNumber(current.resource.renderStartedCount)} · {current.resource.renderTaskSuccessPct}%
                      </div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center gap-1 text-xs text-slate-500">Queue p95 <InfoTip label="Render Queue" /></div>
                      <div className="mt-2 text-2xl font-semibold text-white">{formatMs(current.resource.renderQueueP95Ms)}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Concurrency <InfoTip label="Concurrency" /></div>
                        <div className="mt-2 text-xl font-semibold text-white">{formatNumber(current.resource.avgConcurrency, 1)}</div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3">
                        <div className="flex items-center gap-1 text-xs text-slate-500">Free RAM <InfoTip label="Free RAM" /></div>
                        <div className="mt-2 text-xl font-semibold text-white">
                          {current.resource.minFreeMemGb == null ? "-" : `${formatNumber(current.resource.minFreeMemGb, 2)} GB`}
                        </div>
                      </div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      Active render slots เฉลี่ย: <span className="font-semibold text-sky-300">{formatNumber(current.resource.avgActiveRenderSlots, 1)}</span>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      Main render: <span className="font-semibold text-emerald-300">{formatNumber(current.resource.mainRenderCount)}/{formatNumber(current.resource.mainRenderStartedCount)}</span> · Burn subtitles: <span className="font-semibold text-emerald-300">{formatNumber(current.resource.burnRenderCount)}/{formatNumber(current.resource.burnRenderStartedCount)}</span>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-300">
                      RAM ต่ำกว่า 1 GB ตอนเริ่ม render: <span className="font-semibold text-amber-300">{formatNumber(current.resource.lowMemoryStarts)}</span> ครั้ง
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {jobOutcomes && jobOutcomes.total > 0 && (
              <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">
                    งานจริง (server) — ล้มเหลวที่ขั้นไหน <InfoTip label="Job outcomes" />
                  </h2>
                  <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="text-xs text-slate-500">งานทั้งหมด</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{formatNumber(jobOutcomes.total)}</div>
                    <div className="mt-1 text-xs text-slate-500">done {formatNumber(jobOutcomes.done)} · processing {formatNumber(jobOutcomes.processing)}</div>
                  </div>
                  <div className="rounded-md border border-rose-400/20 bg-rose-500/[0.07] p-3">
                    <div className="text-xs text-rose-300/80">ล้มเหลว: บั๊กระบบ</div>
                    <div className="mt-1 text-2xl font-semibold text-rose-200">{formatNumber(jobOutcomes.systemFailed)}</div>
                    <div className="mt-1 text-xs text-rose-300/70">ของเรา → แก้โค้ด</div>
                  </div>
                  <div className="rounded-md border border-amber-400/20 bg-amber-500/[0.07] p-3">
                    <div className="text-xs text-amber-300/80">ล้มเหลว: คีย์ลูกค้า</div>
                    <div className="mt-1 text-2xl font-semibold text-amber-200">{formatNumber(jobOutcomes.byokFailed)}</div>
                    <div className="mt-1 text-xs text-amber-300/70">BYOK → แจ้งลูกค้า</div>
                  </div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="text-xs text-slate-500">ล้มเหลว: noise</div>
                    <div className="mt-1 text-2xl font-semibold text-slate-300">{formatNumber(jobOutcomes.noiseFailed)}</div>
                    <div className="mt-1 text-xs text-slate-600">superseded/cancel</div>
                  </div>
                </div>
                {jobOutcomes.failedByStage.length > 0 && (
                  <div className="mt-4 divide-y divide-white/10">
                    {jobOutcomes.failedByStage.map((row) => (
                      <div key={`${row.stage}:${row.kind}`} className="grid gap-2 py-3 sm:grid-cols-[150px_1fr_56px] sm:items-center">
                        <div className={cn(
                          "inline-flex w-fit items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold",
                          row.kind === "system" ? "bg-rose-500/10 text-rose-300" : row.kind === "byok" ? "bg-amber-500/10 text-amber-300" : "bg-white/10 text-slate-300",
                        )}>
                          {row.stageLabel} · {row.kind === "system" ? "ระบบ" : row.kind === "byok" ? "คีย์ลูกค้า" : "noise"}
                        </div>
                        <div className="min-w-0 truncate text-sm text-slate-300">{row.sample || "-"}</div>
                        <div className="text-right text-lg font-semibold text-white">{formatNumber(row.count)}</div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-xs leading-relaxed text-slate-500">
                  💡 <span className="font-semibold text-slate-400">สำหรับ CEO:</span> นับจาก VideoJob ฝั่ง server (เชื่อถือได้ ไม่หายตอนปิดแท็บ) — โฟกัสกอง &ldquo;บั๊กระบบ&rdquo; ที่ต้องสั่งทีม dev แก้ ส่วน &ldquo;คีย์ลูกค้า&rdquo; ให้ support ช่วย
                </p>
              </section>
            )}

            <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">Error ระบบ (ที่ต้องแก้) <InfoTip label="Error ระบบ" /></h2>
              <div className="mt-4 divide-y divide-white/10">
                {current.errors.length === 0 && <div className="py-6 text-sm text-emerald-300/80">ไม่มี error ระบบในช่วงนี้ 🎉 (ปัญหาคีย์ลูกค้า/noise แยกไว้ด้านล่าง)</div>}
                {current.errors.map((item) => (
                  <div key={`${item.stepLabel}:${item.label}`} className="grid gap-2 py-3 sm:grid-cols-[110px_1fr_80px] sm:items-center">
                    <div className="rounded-full bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300">{item.stepLabel}</div>
                    <div className="min-w-0 text-sm text-slate-200">
                      <div className="truncate">{item.label}</div>
                      <div className="mt-1 text-xs text-slate-500">ล่าสุด {new Date(item.lastSeen).toLocaleString("th-TH")}</div>
                    </div>
                    <div className="text-right text-lg font-semibold text-white">{formatNumber(item.count)}</div>
                  </div>
                ))}
              </div>
              {current.byokErrors.length > 0 && (
                <div className="mt-5 rounded-md border border-amber-400/20 bg-amber-500/[0.06] p-3">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-200">ปัญหาคีย์ลูกค้า (BYOK) <InfoTip label="BYOK key" /></div>
                  <div className="mt-1 text-xs text-amber-300/70">ไม่ใช่บั๊กของเรา — ให้ support แจ้ง/ช่วยลูกค้าตั้งค่า</div>
                  <div className="mt-2 divide-y divide-white/10">
                    {current.byokErrors.map((item) => (
                      <div key={`byok:${item.stepLabel}:${item.label}`} className="grid gap-2 py-2 text-sm sm:grid-cols-[140px_1fr_64px] sm:items-center">
                        <div className="text-xs font-semibold text-amber-300">{item.stepLabel}</div>
                        <div className="min-w-0 text-slate-300">
                          <div className="truncate">{item.label}</div>
                          <div className="mt-0.5 text-xs text-slate-600">ล่าสุด {new Date(item.lastSeen).toLocaleString("th-TH")}</div>
                        </div>
                        <div className="text-right font-semibold text-slate-200">{formatNumber(item.count)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {current.noise.length > 0 && (
                <div className="mt-5 rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-sm font-semibold text-slate-200">Noise ที่แยกออก</div>
                  <div className="mt-2 divide-y divide-white/10">
                    {current.noise.map((item) => (
                      <div key={`${item.reason}:${item.stepLabel}:${item.label}`} className="grid gap-2 py-2 text-sm sm:grid-cols-[140px_1fr_64px] sm:items-center">
                        <div className="text-xs font-semibold text-amber-300">{item.reason ?? "noise"}</div>
                        <div className="min-w-0 text-slate-400">
                          <div className="truncate">{item.label}</div>
                          <div className="mt-0.5 text-xs text-slate-600">{item.stepLabel} · ล่าสุด {new Date(item.lastSeen).toLocaleString("th-TH")}</div>
                        </div>
                        <div className="text-right font-semibold text-slate-200">{formatNumber(item.count)}</div>
                      </div>
                    ))}
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
