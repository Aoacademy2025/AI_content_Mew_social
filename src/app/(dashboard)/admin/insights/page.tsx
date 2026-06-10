"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Gauge,
  HelpCircle,
  Loader2,
  TimerReset,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

type VitalRow = {
  metric: "LCP" | "INP" | "CLS" | string;
  p75: number | null;
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
    frontendErrors: number;
    serverErrors: number;
    renderSuccessPct: number;
    videoCompletionPct: number;
    renderTaskSuccessPct: number;
    healthScore: number;
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

type InsightsResponse = {
  range: { days: number; since: string; until: string };
  current: InsightSummary;
  previous: InsightSummary;
  processingReconcile?: { dryRun: boolean };
};

const metricHelp: Record<string, string> = {
  "Health Score": "คะแนนรวมจาก video completion, error, render latency และ status stuck ยิ่งใกล้ 100 ยิ่งดี",
  "Drop-off": "เปอร์เซ็นต์ event ที่ไปไม่ถึงขั้นถัดไป ใช้ดูแนวโน้มเท่านั้นจนกว่าจะมี pipelineRunId ต่อหนึ่งงาน",
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
  "Telemetry errors": "error ที่ถูกส่งผ่าน telemetry แยกจาก production log โดยตรง",
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
  }, [days]);

  const current = data?.current;
  const previous = data?.previous;
  const hasData = !!current && (current.totals.events > 0 || current.totals.videoJobs.total > 0);
  const worstDrop = useMemo(() => {
    if (!current) return null;
    return current.funnel.slice(1).sort((a, b) => b.dropOffPct - a.dropOffPct)[0] ?? null;
  }, [current]);

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
                label="Telemetry errors"
                value={formatNumber(current.totals.errors)}
                helper={`frontend ${formatNumber(current.totals.frontendErrors)} · server ${formatNumber(current.totals.serverErrors)} · events ${formatNumber(current.totals.events)}`}
                icon={AlertTriangle}
                tone="border-rose-400/20 bg-rose-500/12 text-rose-300"
              />
            </section>

            <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Funnel หน้า Video Editor</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      จุดหลุดสูงสุด: {worstDrop ? `${worstDrop.label} (${worstDrop.dropOffPct}%)` : "-"}
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
                </div>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                  <h2 className="text-lg font-semibold text-white">Web Vitals</h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                    {current.vitals.map((vital) => <VitalPill key={vital.metric} vital={vital} />)}
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
            </section>

            <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <h2 className="text-lg font-semibold text-white">Error ที่เจอบ่อย</h2>
              <div className="mt-4 divide-y divide-white/10">
                {current.errors.length === 0 && <div className="py-6 text-sm text-slate-500">ยังไม่มี error ในช่วงนี้</div>}
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
            </section>
          </>
        )}
      </div>
    </main>
  );
}
