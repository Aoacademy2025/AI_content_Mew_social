import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { getProcessingReconcilePlan, type ProcessingReconcileSummary } from "@/lib/video-reconcile";

const DAY_MS = 24 * 60 * 60 * 1000;

type FunnelStep = {
  key: string;
  label: string;
  event?: string;
  step?: string;
};

const EDITOR_FUNNEL: FunnelStep[] = [
  { key: "editor_opened", label: "เปิดหน้าตัดต่อ", event: "editor_opened" },
  { key: "script_ready", label: "เริ่มจากสคริปต์", event: "editor_script_ready" },
  { key: "tts_done", label: "สร้างเสียงเสร็จ", step: "tts" },
  { key: "transcribe_done", label: "ถอดซับเสร็จ", step: "transcribe" },
  { key: "stock_done", label: "ได้ B-roll", step: "fetchStock" },
  { key: "config_done", label: "จัดคลิปเสร็จ", step: "config" },
  { key: "render_done", label: "เรนเดอร์เสร็จ", step: "render" },
];

const STEP_LABELS: Record<string, string> = {
  keywords: "หา keyword",
  fetchStock: "หา B-roll",
  tts: "สร้างเสียง",
  transcribe: "ถอดเสียงเป็นซับ",
  config: "จัดลำดับคลิป",
  render: "เรนเดอร์",
  avatar: "สร้าง Avatar",
  avatarTail: "Avatar ปิดท้าย",
  composite: "วาง Avatar บนวิดีโอ",
  burnSubtitles: "ฝังซับลงวิดีโอ",
};

type TelemetryRow = {
  name: string;
  category: string;
  sessionId: string | null;
  userId: string | null;
  step: string | null;
  status: string | null;
  durationMs: number | null;
  value: number | null;
  path: string | null;
  properties: string | null;
  createdAt: Date;
};

function parseProps(row: TelemetryRow): Record<string, unknown> {
  if (!row.properties) return {};
  try {
    return JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringProp(row: TelemetryRow, key: string): string | null {
  const value = parseProps(row)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function eventKey(row: TelemetryRow) {
  return `${row.name}:${row.step ?? ""}:${row.createdAt.getTime()}`;
}

function sessionKey(row: TelemetryRow) {
  return row.sessionId ?? eventKey(row);
}

function jobKey(row: TelemetryRow) {
  return stringProp(row, "jobId") ?? stringProp(row, "videoId") ?? row.sessionId ?? row.userId ?? eventKey(row);
}

function uniqueCount(
  rows: TelemetryRow[],
  predicate: (row: TelemetryRow) => boolean,
  keyFn: (row: TelemetryRow) => string = sessionKey,
) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    ids.add(keyFn(row));
  }
  return ids.size;
}

function pct(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const EMPTY_PROCESSING_SUMMARY: ProcessingReconcileSummary = {
  total: 0,
  completeCandidates: 0,
  failCandidates: 0,
  keepCandidates: 0,
  withOutputUrl: 0,
  existingOutput: 0,
  missingOutput: 0,
  oldestAgeMinutes: null,
};

function summarize(rows: TelemetryRow[], processingSummary: ProcessingReconcileSummary = EMPTY_PROCESSING_SUMMARY) {
  const sessions = uniqueCount(rows, () => true, sessionKey);
  const users = new Set(rows.map((row) => row.userId).filter(Boolean)).size;
  const editorSessions = uniqueCount(rows, (row) => row.path === "/video-editor" || row.name.startsWith("editor_") || row.name.startsWith("pipeline_"), sessionKey);
  const pipelineJobs = uniqueCount(rows, (row) => row.name.startsWith("pipeline_") || row.name.startsWith("render_server") || !!row.step, jobKey);
  const errorRows = rows.filter((row) => row.category === "error" || row.status === "error" || /failed|error/i.test(row.name));
  const completedRenders = rows.filter((row) => row.step === "render" && row.status === "done");
  const serverRenderRows = rows.filter((row) => row.name === "render_server_done");
  const serverStartRows = rows.filter((row) => row.name === "render_server_started");

  const funnel = EDITOR_FUNNEL.map((step, index) => {
    const count = uniqueCount(rows, (row) => {
      if (step.event) return row.name === step.event;
      return row.name === "pipeline_step_done" && row.step === step.step;
    }, step.event ? sessionKey : jobKey);
    const prev = index === 0 ? count : 0;
    return { ...step, count, conversionPct: 0, dropOffPct: 0, previousCount: prev };
  }).map((step, index, all) => {
    const previousCount = index === 0 ? step.count : all[index - 1].count;
    return {
      ...step,
      previousCount,
      conversionPct: index === 0 ? 100 : pct(step.count, previousCount),
      dropOffPct: index === 0 ? 0 : Math.max(0, 100 - pct(step.count, previousCount)),
    };
  });

  const stepMap = new Map<string, { durations: number[]; started: Set<string>; done: Set<string>; error: Set<string> }>();
  for (const row of rows) {
    if (!row.step) continue;
    const entry = stepMap.get(row.step) ?? { durations: [], started: new Set<string>(), done: new Set<string>(), error: new Set<string>() };
    const key = jobKey(row);
    if (row.name === "pipeline_step_started") entry.started.add(key);
    if (row.name === "pipeline_step_done") entry.done.add(key);
    if (row.name === "pipeline_step_error") entry.error.add(key);
    if (row.durationMs != null && row.durationMs >= 0) entry.durations.push(row.durationMs);
    stepMap.set(row.step, entry);
  }

  const steps = Array.from(stepMap.entries()).map(([step, data]) => {
    const p50 = percentile(data.durations, 50);
    const p95 = percentile(data.durations, 95);
    return {
      step,
      label: STEP_LABELS[step] ?? step,
      started: data.started.size,
      done: data.done.size,
      error: data.error.size,
      p50Ms: p50,
      p95Ms: p95,
      successPct: pct(data.done.size, data.done.size + data.error.size),
    };
  }).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));

  const errorGroups = new Map<string, { count: number; label: string; step: string | null; lastSeen: Date }>();
  for (const row of errorRows) {
    const props = parseProps(row);
    const label = String(props.message ?? props.reason ?? row.name).slice(0, 160);
    const key = `${row.step ?? "ทั่วไป"}:${label}`;
    const entry = errorGroups.get(key) ?? { count: 0, label, step: row.step, lastSeen: row.createdAt };
    entry.count++;
    if (row.createdAt > entry.lastSeen) entry.lastSeen = row.createdAt;
    errorGroups.set(key, entry);
  }

  const errors = Array.from(errorGroups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((entry) => ({
      ...entry,
      stepLabel: entry.step ? STEP_LABELS[entry.step] ?? entry.step : "ทั่วไป",
      lastSeen: entry.lastSeen.toISOString(),
    }));

  const vitals = ["LCP", "INP", "CLS"].map((metric) => {
    const values = rows
      .filter((row) => row.name === "web_vital" && String(parseProps(row).metric ?? "").toUpperCase() === metric)
      .map((row) => row.value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return { metric, p75: percentile(values, 75), count: values.length };
  });

  const renderDurations = completedRenders.map((row) => row.durationMs).filter((value): value is number => typeof value === "number");
  const renderP95 = percentile(renderDurations, 95);
  const serverRenderDurations = serverRenderRows.map((row) => row.durationMs).filter((value): value is number => typeof value === "number");
  const freeMemValues = serverStartRows
    .map((row) => Number(parseProps(row).freeMemGb))
    .filter((value) => Number.isFinite(value));
  const concurrencyValues = serverStartRows
    .map((row) => Number(parseProps(row).renderConcurrency))
    .filter((value) => Number.isFinite(value));
  const queueWaitValues = serverStartRows
    .map((row) => Number(parseProps(row).renderQueueWaitMs))
    .filter((value) => Number.isFinite(value));
  const activeRenderSlotValues = serverStartRows
    .map((row) => Number(parseProps(row).activeRenderSlots))
    .filter((value) => Number.isFinite(value));
  const renderStartedJobs = uniqueCount(rows, (row) => row.step === "render" && row.name === "pipeline_step_started", jobKey);
  const renderDoneJobs = uniqueCount(rows, (row) => row.step === "render" && row.name === "pipeline_step_done", jobKey);
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100
        - Math.min(40, errorRows.length * 4)
        - Math.min(35, renderP95 ? renderP95 / 30_000 : 0)
        - Math.min(25, Math.max(0, 100 - pct(renderDoneJobs, renderStartedJobs)) / 2)
        - Math.min(10, processingSummary.failCandidates * 2),
      ),
    ),
  );

  const bottleneck = steps[0] ?? null;
  const dropCandidate = funnel.slice(1).sort((a, b) => b.dropOffPct - a.dropOffPct)[0] ?? null;

  const recommendations = [
    dropCandidate && dropCandidate.dropOffPct > 25
      ? `ผู้ใช้หลุดมากที่ขั้น "${dropCandidate.label}" (${dropCandidate.dropOffPct}%) ควรเปิด session replay ของกลุ่มนี้แล้วดูว่าติด UI หรือรอนาน`
      : null,
    bottleneck && (bottleneck.p95Ms ?? 0) > 60_000
      ? `ขั้น "${bottleneck.label}" ช้าที่สุด p95 ${Math.round((bottleneck.p95Ms ?? 0) / 1000)} วินาที ควรแยกดู log/trace ของ provider และไฟล์ที่ใช้`
      : null,
    errors.length > 0
      ? `error ที่เจอบ่อยสุดอยู่ที่ "${errors[0].stepLabel}" จำนวน ${errors[0].count} ครั้ง ควรแก้เป็นลำดับแรก`
      : null,
    processingSummary.total > 0
      ? `มีวิดีโอ PROCESSING ค้าง ${processingSummary.total} งาน: complete ได้ ${processingSummary.completeCandidates}, fail ได้ ${processingSummary.failCandidates} ควร reconcile จาก admin endpoint`
      : null,
  ].filter(Boolean);

  return {
    totals: {
      sessions,
      users,
      editorSessions,
      pipelineJobs,
      events: rows.length,
      errors: errorRows.length,
      renderSuccessPct: pct(renderDoneJobs, renderStartedJobs),
      healthScore,
    },
    funnel,
    steps,
    errors,
    vitals,
    resource: {
      renderCount: serverRenderRows.length,
      renderP50Ms: percentile(serverRenderDurations, 50),
      renderP95Ms: percentile(serverRenderDurations, 95),
      avgConcurrency: average(concurrencyValues),
      avgActiveRenderSlots: average(activeRenderSlotValues),
      renderQueueP50Ms: percentile(queueWaitValues, 50),
      renderQueueP95Ms: percentile(queueWaitValues, 95),
      minFreeMemGb: freeMemValues.length ? Math.min(...freeMemValues) : null,
      lowMemoryStarts: freeMemValues.filter((value) => value < 1).length,
    },
    staleProcessing: processingSummary,
    recommendations,
  };
}

export async function GET(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const url = new URL(req.url);
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") ?? 7)));
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const previousSince = new Date(now.getTime() - days * 2 * DAY_MS);

    const [currentRows, previousRows, processingPlan] = await Promise.all([
      prisma.telemetryEvent.findMany({
        where: { createdAt: { gte: since } },
        select: {
          name: true, category: true, sessionId: true, userId: true, step: true, status: true,
          durationMs: true, value: true, path: true, properties: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20_000,
      }),
      prisma.telemetryEvent.findMany({
        where: { createdAt: { gte: previousSince, lt: since } },
        select: {
          name: true, category: true, sessionId: true, userId: true, step: true, status: true,
          durationMs: true, value: true, path: true, properties: true, createdAt: true,
        },
        take: 20_000,
      }),
      getProcessingReconcilePlan({ staleAfterMinutes: 20, failAfterHours: 3, limit: 100 }),
    ]);

    return NextResponse.json({
      range: { days, since: since.toISOString(), until: now.toISOString() },
      current: summarize(currentRows, processingPlan.summary),
      previous: summarize(previousRows),
      processingReconcile: { dryRun: true, ...processingPlan },
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/insights", error });
  }
}
