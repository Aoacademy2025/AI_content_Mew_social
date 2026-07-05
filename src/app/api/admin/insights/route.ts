import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { getProcessingReconcilePlan, type ProcessingReconcileSummary } from "@/lib/video-reconcile";
import { computeRevenueCohorts } from "@/lib/revenue-cohorts";
import { getPlanConfig } from "@/lib/plan-config";

type RenderJobRow = {
  type: string;
  status: string;
  parentJobId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

// Render throughput from the RenderJob table (the source of truth for editor-v2 / worker renders).
// Replaces the old telemetry panel that read render_server_* events from the legacy sync route the
// background-render flow bypasses — hence it showed 0/0 while renders were clearly happening.
function summarizeRenderJobs(rows: RenderJobRow[]) {
  const render = rows.filter((r) => r.type === "RENDER");
  const burn = rows.filter((r) => r.type === "BURN");
  const doneRender = render.filter((r) => r.status === "DONE");
  const failedRender = render.filter((r) => r.status === "FAILED");
  const durations = doneRender
    .map((r) => (r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : NaN))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const settled = doneRender.length + failedRender.length;
  return {
    total: render.length,
    done: doneRender.length,
    failed: failedRender.length,
    running: render.filter((r) => r.status === "RUNNING").length,
    queued: render.filter((r) => r.status === "QUEUED").length,
    cancelled: render.filter((r) => r.status === "CANCELLED").length,
    web: render.filter((r) => !r.parentJobId).length,
    mcp: render.filter((r) => r.parentJobId).length,
    successPct: pct(doneRender.length, settled),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    burnTotal: burn.length,
    burnDone: burn.filter((r) => r.status === "DONE").length,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

type FunnelStep = {
  key: string;
  label: string;
  event?: string;
  step?: string;
};

// The funnel is the ONE linear path every render walks. `transcribe` is intentionally excluded:
// it only runs for avatar/upload sources (TTS-timed clips skip it), so it's a branch, not a step —
// counting it made later steps exceed the previous one (the "111% conversion" bug).
const EDITOR_FUNNEL: FunnelStep[] = [
  { key: "editor_opened", label: "เปิดหน้าตัดต่อ", event: "editor_opened" },
  { key: "script_ready", label: "เริ่มจากสคริปต์", event: "editor_script_ready" },
  { key: "tts_done", label: "สร้างเสียงเสร็จ", step: "tts" },
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
  source: string;
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

type VideoRow = {
  id: string;
  userId: string;
  status: string;
  videoUrl: string | null;
  avatarVideoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
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

function numberProp(row: TelemetryRow, key: string): number | null {
  const value = parseProps(row)[key];
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : null;
}

function booleanProp(row: TelemetryRow, key: string): boolean {
  return parseProps(row)[key] === true;
}

function eventKey(row: TelemetryRow) {
  return `${row.name}:${row.step ?? ""}:${row.createdAt.getTime()}`;
}

function sessionKey(row: TelemetryRow) {
  return row.sessionId ?? eventKey(row);
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

function eventCount(rows: TelemetryRow[], predicate: (row: TelemetryRow) => boolean) {
  return rows.filter(predicate).length;
}

function uniqueNonNullCount(values: Array<string | null>) {
  return new Set(values.filter((value): value is string => Boolean(value))).size;
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

function hasVideoOutput(video: VideoRow) {
  return Boolean(video.videoUrl?.trim() || video.avatarVideoUrl?.trim());
}

function summarizeVideoJobs(videos: VideoRow[]) {
  const completed = videos.filter((video) => video.status === "COMPLETED").length;
  const processing = videos.filter((video) => video.status === "PROCESSING").length;
  const failed = videos.filter((video) => video.status === "FAILED").length;
  const pending = videos.filter((video) => video.status === "PENDING").length;
  const outputReady = videos.filter(hasVideoOutput).length;
  const statusStuckWithOutput = videos.filter((video) => video.status === "PROCESSING" && hasVideoOutput(video)).length;
  const processingWithoutOutput = videos.filter((video) => video.status === "PROCESSING" && !hasVideoOutput(video)).length;

  return {
    total: videos.length,
    completed,
    processing,
    failed,
    pending,
    outputReady,
    statusStuckWithOutput,
    processingWithoutOutput,
    completionPct: pct(completed, videos.length),
    outputReadyPct: pct(outputReady, videos.length),
  };
}

function playbackGroupKey(row: TelemetryRow) {
  return [
    row.sessionId ?? eventKey(row),
    stringProp(row, "videoId") ?? "no-video-id",
    stringProp(row, "sourcePath") ?? "no-source-path",
  ].join(":");
}

function countByProp(rows: TelemetryRow[], key: string, fallback = "unknown") {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = stringProp(row, key) ?? fallback;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function sumProp(rows: TelemetryRow[], key: string) {
  return rows.reduce((sum, row) => sum + (numberProp(row, key) ?? 0), 0);
}

function propValues(rows: TelemetryRow[], key: string) {
  return rows
    .map((row) => numberProp(row, key))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function durationValues(rows: TelemetryRow[]) {
  return rows
    .map((row) => row.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function telemetryIssueLabel(row: TelemetryRow) {
  const props = parseProps(row);
  const msg = String(props.message ?? props.reason ?? "").trim();
  if (msg) return msg.slice(0, 160);
  // No message — describe by event name (+ source) instead of a bare "error"/status word,
  // so the row is at least traceable ("frontend_error · client" beats a lone "error").
  const label = [row.name, row.source ? `· ${row.source}` : ""].filter(Boolean).join(" ").trim();
  return (label || row.status || "ไม่ระบุสาเหตุ").slice(0, 160);
}

function benignTelemetryReason(row: TelemetryRow): string | null {
  const props = parseProps(row);
  const text = [
    row.name,
    row.status,
    props.message,
    props.reason,
    props.errorName,
  ].filter(Boolean).join(" ");

  if (/play\(\) request was interrupted by a call to pause/i.test(text)) return "browser play/pause race";
  if (/__SUPERSEDED__|(^|\s)superseded(\s|$)/i.test(text)) return "superseded job";
  if (/AbortError|aborted|cancelled|canceled|got cancelled|Request closed|cancelSignal/i.test(text)) return "intentional cancel";
  if (row.name === "frontend_error" && /^Script error\.?$/i.test(String(props.message ?? "").trim())) return "opaque script error";
  return null;
}

// OUR own plan caps (minute/clip quota) — an EXPECTED business rule (PRO 15-min cap thrown as 409),
// not a bug and not a customer-key fault. Must NOT inflate "ระบบเรา" (system) OR "คีย์ลูกค้า" (byok);
// it is a pricing/upgrade signal. Classified BEFORE byok so a plan cap never reads as a BYOK error.
export function quotaReasonFromText(text: string): string | null {
  if (/QUOTA_MINUTES|เกินโควต้านาที|เกินนาที/i.test(text)) return "ชนเพดานแผน: โควต้านาที";
  if (/QUOTA_CLIPS|QUOTA_[A-Z]+|เกินโควต้าคลิป|clip quota/i.test(text)) return "ชนเพดานแผน: โควต้าคลิป";
  return null;
}

// P2 กฎ #4: แยก error ฝั่ง "คีย์ลูกค้า" (BYOK) ออกจาก "ระบบเรา" — 429/503/RESOURCE_EXHAUSTED/rate-limit/
// billing/คีย์ผิด = ปัญหาของลูกค้า ไม่ใช่บั๊กระบบ. NOTE: bare "quota" was removed — our plan caps
// (QUOTA_MINUTES/QUOTA_CLIPS) now belong to quotaReasonFromText, not to BYOK.
function byokReasonFromText(text: string): string | null {
  if (/\b429\b|\b503\b|RESOURCE_EXHAUSTED|too many requests|rate limit/i.test(text)) return "คีย์ลูกค้า: เกินโควต้า/rate limit";
  if (/ผูกบัตร|billing/i.test(text)) return "คีย์ลูกค้า: ยังไม่ผูกบัตร/billing";
  if (/api[\s_-]?key|API_KEY_INVALID|invalid key|api key not valid|unauthorized|permission denied/i.test(text)) return "คีย์ลูกค้า: คีย์ผิด/ไม่มีสิทธิ์";
  return null;
}

function quotaErrorReason(row: TelemetryRow): string | null {
  const props = parseProps(row);
  const text = [row.name, row.status, props.message, props.reason, props.errorName].filter(Boolean).join(" ");
  return quotaReasonFromText(text);
}

function byokErrorReason(row: TelemetryRow): string | null {
  const props = parseProps(row);
  const text = [row.name, row.status, props.message, props.reason, props.errorName].filter(Boolean).join(" ");
  return byokReasonFromText(text);
}

// Classify a VideoJob failure. Order: noise → quota (our plan cap) → managed-key rate-limit → byok →
// system. `managed` = MANAGED_GEMINI: when on, a 429/RESOURCE_EXHAUSTED/rate-limit is OUR managed key
// hitting a ceiling (a capacity/infra signal = system), NOT a customer key. Pure + testable.
export function classifyJobError(message: string | null, managed: boolean): "system" | "byok" | "quota" | "noise" {
  const text = message ?? "";
  if (/__SUPERSEDED__|superseded|AbortError|aborted|cancelled|canceled/i.test(text)) return "noise";
  if (quotaReasonFromText(text)) return "quota";
  if (managed && /\b429\b|\b503\b|RESOURCE_EXHAUSTED|too many requests|rate limit/i.test(text)) return "system";
  if (byokReasonFromText(text)) return "byok";
  return "system";
}

function jobStepLabel(step: string | null) {
  if (!step) return "ไม่ระบุ";
  const alias: Record<string, string> = { stock: "หา B-roll", burn: "ฝังซับ" };
  return alias[step] ?? STEP_LABELS[step] ?? step;
}

function summarizeIssueGroups(rows: TelemetryRow[], reasonFn?: (row: TelemetryRow) => string | null) {
  const groups = new Map<string, { count: number; label: string; step: string | null; lastSeen: Date; reason?: string }>();
  for (const row of rows) {
    const label = telemetryIssueLabel(row);
    const reason = reasonFn?.(row) ?? undefined;
    const key = `${row.step ?? "ทั่วไป"}:${reason ?? ""}:${label}`;
    const entry = groups.get(key) ?? { count: 0, label, step: row.step, lastSeen: row.createdAt, reason };
    entry.count++;
    if (row.createdAt > entry.lastSeen) entry.lastSeen = row.createdAt;
    groups.set(key, entry);
  }

  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((entry) => ({
      ...entry,
      stepLabel: entry.step ? STEP_LABELS[entry.step] ?? entry.step : "ทั่วไป",
      lastSeen: entry.lastSeen.toISOString(),
    }));
}

function matchesFunnelStep(row: TelemetryRow, step: FunnelStep, includeServerFetchStock = false) {
  if (step.event) return row.name === step.event;
  if (step.step === "fetchStock") {
    return (row.name === "pipeline_step_done" && row.step === step.step) || (includeServerFetchStock && row.name === "fetch_stock_server_done");
  }
  return row.name === "pipeline_step_done" && row.step === step.step;
}

// P0 fix: นับเป็น "จำนวน session ที่ไปถึงแต่ละขั้น" — หน่วยเดียวกันทุกขั้น (apples-to-apples)
// เดิมขั้น 1 นับ raw event ส่วนขั้น 2-7 de-dup ด้วย pipelineRunId (เพิ่งเริ่มเก็บ 18 มิ.ย.)
// → ทำให้ "drop 96%" ปลอม เพราะคนละหน่วย/คนละช่วงเวลา ตอนนี้ใช้ distinct sessionId ทุกขั้น
function funnelStepSessionCount(rows: TelemetryRow[], step: FunnelStep) {
  return uniqueCount(
    rows,
    (row) => Boolean(row.sessionId) && matchesFunnelStep(row, step, false),
    (row) => row.sessionId ?? eventKey(row),
  );
}

// SUPERSEDED for the main path by summarizeJobFunnel(): editor v2 (the live default) emits ZERO
// client pipeline/session telemetry, so this telemetry funnel measures the dead legacy v1 editor
// only (the "v2 telemetry blind spot"). Kept because it's still used when no jobFunnel is supplied.
function summarizeEditorFunnel(rows: TelemetryRow[]) {
  const funnel = EDITOR_FUNNEL.map((step) => ({
    ...step,
    count: funnelStepSessionCount(rows, step),
    conversionPct: 0,
    dropOffPct: 0,
    previousCount: 0,
  })).map((step, index, all) => {
    const previousCount = index === 0 ? step.count : all[index - 1].count;
    // Clamp to 100: even off the transcribe branch, independent session counts can momentarily
    // exceed the prior step; a funnel step is never truly >100% conversion.
    const conversionPct = index === 0 ? 100 : Math.min(100, pct(step.count, previousCount));
    return {
      ...step,
      previousCount,
      conversionPct,
      dropOffPct: index === 0 ? 0 : Math.max(0, 100 - conversionPct),
    };
  });

  return {
    funnel,
    funnelMode: "session" as const,
    funnelRuns: funnel[0]?.count ?? 0,
  };
}

// Creation funnel from VideoJob (server truth) — the real path every generation walks, regardless
// of editor version. progress is server-written + monotonic; milestones match orchestrator step()
// calls: stock=55, config=65, render=75, done→100. This replaces the telemetry funnel above, which
// went blind when editor v2 became the default (v2 emits no client pipeline telemetry).
export type JobFunnelRow = { userId: string; status: string; progress: number };

const JOB_FUNNEL_STEPS = [
  { key: "created", label: "เริ่มสร้าง (สั่งเรนเดอร์)", reached: (_j: JobFunnelRow) => true },
  { key: "broll", label: "ได้ B-roll", reached: (j: JobFunnelRow) => j.progress >= 55 },
  { key: "config", label: "จัดคลิปเสร็จ", reached: (j: JobFunnelRow) => j.progress >= 65 },
  { key: "render", label: "เรนเดอร์", reached: (j: JobFunnelRow) => j.progress >= 75 },
  { key: "done", label: "เสร็จสมบูรณ์", reached: (j: JobFunnelRow) => j.status === "done" },
] as const;

export function summarizeJobFunnel(jobs: JobFunnelRow[]) {
  const funnel = JOB_FUNNEL_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    count: jobs.filter(s.reached).length,
    conversionPct: 0,
    dropOffPct: 0,
    previousCount: 0,
  })).map((step, i, all) => {
    const previousCount = i === 0 ? step.count : all[i - 1].count;
    const conversionPct = i === 0 ? 100 : Math.min(100, pct(step.count, previousCount));
    return { ...step, previousCount, conversionPct, dropOffPct: i === 0 ? 0 : Math.max(0, 100 - conversionPct) };
  });
  return { funnel, funnelMode: "job" as const, funnelRuns: funnel[0]?.count ?? 0 };
}

// Activation funnel counts (signups → opened → started → first video → repeat), with @aoacademy
// internal accounts EXCLUDED and everyone else (incl. workshop students) KEPT. Pure + testable so
// the exclusion rule is locked. `startedPipeline` uses server-truth VideoJob creators, not v1-only
// editor_script_ready telemetry (which editor v2 never emits).
export function computeActivationFunnel(input: {
  users: Array<{ id: string; email: string | null; createdAt: Date }>;
  openedUserIds: Array<string | null>;
  jobUserIds: string[];
  completedByUser: Array<{ userId: string; count: number }>;
  since: Date;
}) {
  const internalIds = new Set(
    input.users.filter((u) => (u.email ?? "").toLowerCase().includes("@aoacademy")).map((u) => u.id),
  );
  const notInternal = (id: string) => !internalIds.has(id);
  // openedEditor = "engaged" = union of {editor_opened telemetry} ∪ {VideoJob creators}. MCP/chat
  // users create jobs WITHOUT ever opening the web editor, so startedPipeline (server truth, all
  // surfaces) can exceed a telemetry-only openedEditor count — that would show >100% conversion /
  // negative drop-off on the funnel step. Anyone who created a job has, by definition, engaged, so
  // folding jobUserIds into the union keeps openedEditor >= startedPipeline always.
  const engagedIds = new Set<string>();
  for (const id of input.openedUserIds) if (id) engagedIds.add(id);
  for (const id of input.jobUserIds) engagedIds.add(id);
  return {
    internalTeam: internalIds.size,
    signups: input.users.length - internalIds.size,
    openedEditor: Array.from(engagedIds).filter(notInternal).length,
    startedPipeline: input.jobUserIds.filter(notInternal).length,
    completedFirstVideo: input.completedByUser.filter((g) => notInternal(g.userId)).length,
    repeatCreators: input.completedByUser.filter((g) => notInternal(g.userId) && g.count >= 2).length,
    windowSignups: input.users.filter((u) => u.createdAt >= input.since && notInternal(u.id)).length,
  };
}

function summarizeBroll(rows: TelemetryRow[]) {
  const doneRows = rows.filter((row) => row.name === "fetch_stock_server_done");
  const errorRows = rows.filter((row) => row.name === "fetch_stock_server_error");
  const durations = durationValues(doneRows);
  const normalizeTotals = propValues(doneRows, "normalizeMsTotal");
  const servedClips = propValues(doneRows, "servedClipCount");
  const searchQueries = propValues(doneRows, "searchQueries");
  const totalRequests = doneRows.length + errorRows.length;
  const cacheHitCount = sumProp(doneRows, "cacheHitCount");
  const downloadedCount = sumProp(doneRows, "downloadedCount");
  const downloadFailCount = sumProp(doneRows, "downloadFailCount");
  const selectedPexelsCount = sumProp(doneRows, "selectedPexelsCount");
  const selectedPixabayCount = sumProp(doneRows, "selectedPixabayCount");

  return {
    requests: totalRequests,
    runs: doneRows.length,
    errors: errorRows.length,
    successPct: pct(doneRows.length, totalRequests),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    searchP95Ms: percentile(propValues(doneRows, "searchPhaseMs"), 95),
    rankingP95Ms: percentile(propValues(doneRows, "rankingPhaseMs"), 95),
    selectionP95Ms: percentile(propValues(doneRows, "selectionPhaseMs"), 95),
    downloadP95Ms: percentile(propValues(doneRows, "downloadPhaseMs"), 95),
    normalizeP95Ms: percentile(normalizeTotals, 95),
    cacheHitCount,
    downloadedCount,
    downloadFailCount,
    cacheHitPct: pct(cacheHitCount, cacheHitCount + downloadedCount),
    downloadFailPct: pct(downloadFailCount, downloadedCount + downloadFailCount),
    servedClipTotal: sumProp(doneRows, "servedClipCount"),
    servedClipAvg: average(servedClips),
    searchQueriesAvg: average(searchQueries),
    noCandidateKeywords: sumProp(doneRows, "noCandidateKeywords"),
    forcedFallbackCount: sumProp(doneRows, "forcedFallbackCount"),
    profileFallbackUsedCount: sumProp(doneRows, "profileFallbackUsedCount"),
    llmRankingUsedCount: doneRows.filter((row) => booleanProp(row, "llmRankingUsed")).length,
    llmRankingFailedCount: doneRows.filter((row) => booleanProp(row, "llmRankingFailed")).length,
    emptyResultCount: doneRows.filter((row) => booleanProp(row, "emptyResult")).length,
    normalizeRanCount: sumProp(doneRows, "normalizeRanCount"),
    normalizeSkippedCount: sumProp(doneRows, "normalizeSkippedCount"),
    normalizeFailedCount: sumProp(doneRows, "normalizeFailedCount"),
    selectedPexelsCount,
    selectedPixabayCount,
    providerMix: [
      { label: "Pexels", count: selectedPexelsCount },
      { label: "Pixabay", count: selectedPixabayCount },
    ].filter((item) => item.count > 0),
    resolvedSources: countByProp(doneRows, "resolvedSource"),
    contentProfiles: countByProp(doneRows, "contentProfile"),
  };
}

function summarizePlayback(rows: TelemetryRow[]) {
  const playbackRows = rows.filter((row) => row.name.startsWith("video_playback_"));
  const startedRows = playbackRows.filter((row) => row.name === "video_playback_session_started");
  const firstFrameRows = playbackRows.filter((row) => row.name === "video_playback_first_frame");
  const canPlayRows = playbackRows.filter((row) => row.name === "video_playback_canplay");
  const waitingRows = playbackRows.filter((row) => row.name === "video_playback_waiting");
  const stalledRows = playbackRows.filter((row) => row.name === "video_playback_stalled");
  const errorRows = playbackRows.filter((row) => row.name === "video_playback_error");

  const startedKeys = new Set(startedRows.map(playbackGroupKey));
  const bufferingKeys = new Set([...waitingRows, ...stalledRows].map(playbackGroupKey));
  const firstFrameDurations = firstFrameRows
    .map((row) => row.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const canPlayDurations = canPlayRows
    .map((row) => row.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startupFromLoadValues = firstFrameRows
    .map((row) => Number(parseProps(row).startupFromLoadMs))
    .filter((value) => Number.isFinite(value));

  return {
    sessions: startedRows.length,
    uniqueSessions: startedKeys.size,
    firstFrames: firstFrameRows.length,
    canPlay: canPlayRows.length,
    waitingEvents: waitingRows.length,
    stalledEvents: stalledRows.length,
    errors: errorRows.length,
    bufferingSessions: bufferingKeys.size,
    bufferingSessionPct: pct(bufferingKeys.size, startedKeys.size || startedRows.length),
    errorPct: pct(errorRows.length, startedRows.length),
    firstFrameP50Ms: percentile(firstFrameDurations, 50),
    firstFrameP95Ms: percentile(firstFrameDurations, 95),
    canPlayP95Ms: percentile(canPlayDurations, 95),
    startupFromLoadP95Ms: percentile(startupFromLoadValues, 95),
    pages: countByProp(startedRows, "page"),
    routes: countByProp(startedRows, "sourceRoute"),
  };
}

function parseRangeDays(value: string | null) {
  const days = Number(value ?? 1);
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, Math.min(30, Math.floor(days)));
}

function summarize(
  rows: TelemetryRow[],
  videos: VideoRow[],
  processingSummary: ProcessingReconcileSummary = EMPTY_PROCESSING_SUMMARY,
  jobFunnel?: ReturnType<typeof summarizeJobFunnel>,
) {
  const videoJobs = summarizeVideoJobs(videos);
  const sessions = uniqueNonNullCount(rows.map((row) => row.sessionId));
  const users = new Set(rows.map((row) => row.userId).filter(Boolean)).size;
  const editorSessions = uniqueCount(rows, (row) => row.path === "/video-editor" || row.name.startsWith("editor_") || row.name.startsWith("pipeline_"), sessionKey);
  const editorOpens = eventCount(rows, (row) => row.name === "editor_opened");
  const pipelineStarts = eventCount(rows, (row) => row.name === "editor_script_ready");
  const pipelineJobs = videoJobs.total;
  const rawErrorRows = rows.filter((row) => row.category === "error" || row.status === "error" || /failed|error/i.test(row.name));
  const noiseRows = rawErrorRows.filter((row) => benignTelemetryReason(row));
  const realErrorRows = rawErrorRows.filter((row) => !benignTelemetryReason(row));
  // Split our plan-cap (quota) rows out FIRST — they're a pricing/upgrade signal, never a bug or a
  // customer-key fault, so they must not inflate byok OR system (same fix as the VideoJob path).
  const quotaErrorRows = realErrorRows.filter((row) => quotaErrorReason(row));
  const byokErrorRows = realErrorRows.filter((row) => !quotaErrorReason(row) && byokErrorReason(row));
  // errorRows = "ระบบเรา" เท่านั้น (ตัด noise + คีย์ลูกค้า + quota ออก) → ใช้คิด Health Score v2
  const errorRows = realErrorRows.filter((row) => !quotaErrorReason(row) && !byokErrorReason(row));
  const frontendErrorRows = errorRows.filter((row) => row.name === "frontend_error" || row.source === "client");
  const serverErrorRows = errorRows.filter((row) => row.source === "server");
  const serverRenderRows = rows.filter((row) => row.name === "render_server_done");
  const serverStartRows = rows.filter((row) => row.name === "render_server_started");
  const playback = summarizePlayback(rows);
  const broll = summarizeBroll(rows);
  const mainRenderDoneRows = serverRenderRows.filter((row) => stringProp(row, "compositionId") === "ShortVideoComposition");
  const mainRenderStartRows = serverStartRows.filter((row) => stringProp(row, "compositionId") === "ShortVideoComposition");
  const burnRenderDoneRows = serverRenderRows.filter((row) => stringProp(row, "compositionId") === "SubtitleOverlayComposition");
  const burnRenderStartRows = serverStartRows.filter((row) => stringProp(row, "compositionId") === "SubtitleOverlayComposition");

  // Prefer the VideoJob-derived creation funnel (server truth, counts editor v2). Falls back to the
  // legacy telemetry funnel only when no jobFunnel is supplied (keeps summarizeEditorFunnel testable).
  const { funnel, funnelMode, funnelRuns } = jobFunnel ?? summarizeEditorFunnel(rows);

  const stepMap = new Map<string, { durations: number[]; started: number; done: number; error: number; skipped: number }>();
  for (const row of rows) {
    if (!row.step) continue;
    const entry = stepMap.get(row.step) ?? { durations: [], started: 0, done: 0, error: 0, skipped: 0 };
    if (row.name === "pipeline_step_started") entry.started++;
    if (row.name === "pipeline_step_done") entry.done++;
    if (row.name === "pipeline_step_error" && !benignTelemetryReason(row) && !byokErrorReason(row) && !quotaErrorReason(row)) entry.error++;
    if (row.name === "pipeline_step_skipped") entry.skipped++;
    if (row.durationMs != null && row.durationMs >= 0) entry.durations.push(row.durationMs);
    stepMap.set(row.step, entry);
  }

  const steps = Array.from(stepMap.entries()).map(([step, data]) => {
    const p50 = percentile(data.durations, 50);
    const p95 = percentile(data.durations, 95);
    return {
      step,
      label: STEP_LABELS[step] ?? step,
      started: data.started,
      done: data.done,
      error: data.error,
      skipped: data.skipped,
      notFinished: Math.max(0, data.started - data.done - data.error - data.skipped),
      p50Ms: p50,
      p95Ms: p95,
      successPct: pct(data.done, data.started),
    };
  })
    // Drop phantom rows: steps that emitted only stray duration events but no lifecycle
    // (started/done/error/skipped all 0) — e.g. "preview"/"avatar_upload" showing "0% success"
    // next to a real p95, which reads as broken.
    .filter((s) => s.started > 0 || s.done > 0 || s.error > 0 || s.skipped > 0)
    .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));

  const errors = summarizeIssueGroups(errorRows);
  const byokErrors = summarizeIssueGroups(byokErrorRows, byokErrorReason);
  const noise = summarizeIssueGroups(noiseRows, benignTelemetryReason);

  const vitals = ["LCP", "INP", "CLS"].map((metric) => {
    const values = rows
      .filter((row) => row.name === "web_vital" && String(parseProps(row).metric ?? "").toUpperCase() === metric)
      .map((row) => row.value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return { metric, p75: percentile(values, 75), count: values.length };
  });

  const renderDurations = mainRenderDoneRows.map((row) => row.durationMs).filter((value): value is number => typeof value === "number");
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
  const renderStartedJobs = eventCount(rows, (row) => row.step === "render" && row.name === "pipeline_step_started");
  const renderDoneJobs = eventCount(rows, (row) => row.step === "render" && row.name === "pipeline_step_done");
  const renderTaskSuccessPct = pct(serverRenderRows.length, serverStartRows.length);
  const videoCompletionPenalty = videoJobs.total > 0
    ? Math.max(0, 100 - videoJobs.completionPct) / 3
    : 0;
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100
        - Math.min(30, frontendErrorRows.length * 3)
        - Math.min(25, serverErrorRows.length * 5)
        - Math.min(35, renderP95 ? renderP95 / 30_000 : 0)
        - Math.min(20, videoCompletionPenalty)
        - Math.min(15, videoJobs.statusStuckWithOutput * 2)
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
      ? `error ระบบที่เจอบ่อยสุดอยู่ที่ "${errors[0].stepLabel}" จำนวน ${errors[0].count} ครั้ง ควรแก้เป็นลำดับแรก`
      : null,
    byokErrorRows.length > 0
      ? `พบ error จากคีย์ลูกค้า (BYOK) ${byokErrorRows.length} ครั้ง เช่น "${byokErrors[0]?.label ?? ""}" — ไม่ใช่บั๊กระบบ ควรแจ้ง/ช่วยลูกค้าตั้งค่า ไม่ใช่งาน dev`
      : null,
    videoJobs.statusStuckWithOutput > 0
      ? `มีวิดีโอ ${videoJobs.statusStuckWithOutput} งานที่มี output แล้วแต่ status ยังเป็น PROCESSING ควร reconcile เพื่อให้ dashboard ตรงกับไฟล์จริง`
      : null,
    processingSummary.total > 0
      ? `ตรวจพบ status PROCESSING ค้าง ${processingSummary.total} งาน: complete ได้ ${processingSummary.completeCandidates}, fail ได้ ${processingSummary.failCandidates}`
      : null,
    playback.firstFrameP95Ms != null && playback.firstFrameP95Ms > 3_000
      ? `Playback เริ่มเห็นภาพช้า p95 ${Math.round(playback.firstFrameP95Ms / 1000)} วินาที ควรพิจารณา preview proxy 540p/720p หรือ CDN`
      : null,
    playback.bufferingSessionPct > 20
      ? `มี playback sessions ที่ buffering ${playback.bufferingSessionPct}% ควรแยกดู source route และ bitrate ของไฟล์ที่มีปัญหา`
      : null,
    broll.runs > 0 && (broll.p95Ms ?? 0) > 5 * 60_000
      ? `B-roll ช้า p95 ${Math.round((broll.p95Ms ?? 0) / 1000)} วินาที ควรดู phase search/download/normalize และ cache hit ก่อนเพิ่ม concurrency`
      : null,
    broll.runs > 0 && broll.cacheHitPct < 20 && broll.downloadedCount > 20
      ? `B-roll cache hit ต่ำ (${broll.cacheHitPct}%) ทำให้ต้องโหลด stock ใหม่บ่อย ควรดู reuse/cache policy ก่อนเพิ่มโหลด provider`
      : null,
    broll.runs > 0 && broll.downloadFailPct > 10
      ? `B-roll download fail ${broll.downloadFailPct}% ควรแยก provider/source และ network timeout ก่อนสรุปว่าเป็นปัญหา UI`
      : null,
  ].filter(Boolean);

  return {
    totals: {
      sessions,
      users,
      editorSessions,
      editorOpens,
      pipelineJobs,
      pipelineStarts,
      events: rows.length,
      errors: errorRows.length,
      byokErrorCount: byokErrorRows.length,
      quotaErrorCount: quotaErrorRows.length,
      rawErrors: rawErrorRows.length,
      noiseEvents: noiseRows.length,
      frontendErrors: frontendErrorRows.length,
      serverErrors: serverErrorRows.length,
      renderSuccessPct: pct(renderDoneJobs, renderStartedJobs),
      videoCompletionPct: videoJobs.completionPct,
      renderTaskSuccessPct,
      healthScore,
      videoJobs,
      funnelMode,
      funnelRuns,
    },
    funnel,
    steps,
    errors,
    byokErrors,
    noise,
    vitals,
    resource: {
      renderCount: serverRenderRows.length,
      renderStartedCount: serverStartRows.length,
      mainRenderCount: mainRenderDoneRows.length,
      mainRenderStartedCount: mainRenderStartRows.length,
      burnRenderCount: burnRenderDoneRows.length,
      burnRenderStartedCount: burnRenderStartRows.length,
      renderTaskSuccessPct,
      renderP50Ms: percentile(serverRenderDurations, 50),
      renderP95Ms: percentile(serverRenderDurations, 95),
      avgConcurrency: average(concurrencyValues),
      avgActiveRenderSlots: average(activeRenderSlotValues),
      renderQueueP50Ms: percentile(queueWaitValues, 50),
      renderQueueP95Ms: percentile(queueWaitValues, 95),
      minFreeMemGb: freeMemValues.length ? Math.min(...freeMemValues) : null,
      lowMemoryStarts: freeMemValues.filter((value) => value < 1).length,
    },
    broll,
    playback,
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
    const days = parseRangeDays(url.searchParams.get("days"));
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const previousSince = new Date(now.getTime() - days * 2 * DAY_MS);

    const videoSelect = {
      id: true,
      userId: true,
      status: true,
      videoUrl: true,
      avatarVideoUrl: true,
      createdAt: true,
      updatedAt: true,
    } as const;

    const [
      currentRows, previousRows, currentVideos, previousVideos, processingPlan,
      allUsers, openedUserRows, completedByUser, currentJobs,
      planConfig, renderJobRows, paidRows, previousJobs, jobUserRows,
    ] = await Promise.all([
      prisma.telemetryEvent.findMany({
        where: { createdAt: { gte: since } },
        select: {
          name: true, category: true, source: true, sessionId: true, userId: true, step: true, status: true,
          durationMs: true, value: true, path: true, properties: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20_000,
      }),
      prisma.telemetryEvent.findMany({
        where: { createdAt: { gte: previousSince, lt: since } },
        select: {
          name: true, category: true, source: true, sessionId: true, userId: true, step: true, status: true,
          durationMs: true, value: true, path: true, properties: true, createdAt: true,
        },
        take: 20_000,
      }),
      prisma.video.findMany({
        where: { createdAt: { gte: since } },
        select: videoSelect,
        orderBy: { createdAt: "desc" },
        take: 5_000,
      }),
      prisma.video.findMany({
        where: { createdAt: { gte: previousSince, lt: since } },
        select: videoSelect,
        orderBy: { createdAt: "desc" },
        take: 5_000,
      }),
      getProcessingReconcilePlan({ staleAfterMinutes: 20, failAfterHours: 3, limit: 100 }),
      // P1 Activation: lifecycle ทั้งหมด (ไม่ขึ้นกับ window) — สมัคร → ตั้งคีย์ → เปิด → เริ่ม → ได้วิดีโอ → ซ้ำ.
      // Now also selects the billing fields so we classify real payers vs trial (classifyEntitlement).
      prisma.user.findMany({
        select: {
          id: true, email: true, plan: true, role: true, geminiKey: true, pexelsKey: true, pixabayKey: true, createdAt: true,
          subStatus: true, billingPeriod: true, planExpiresAt: true,
          trialStartedAt: true, trialEndsAt: true, stripeSubscriptionId: true,
        },
      }),
      prisma.telemetryEvent.findMany({ where: { name: "editor_opened", userId: { not: null } }, select: { userId: true }, distinct: ["userId"] }),
      prisma.video.groupBy({ by: ["userId"], where: { status: "COMPLETED" }, _count: { _all: true } }),
      // P2 scorecard (server-authoritative): job outcome จาก VideoJob (status server เขียน, ไม่หายตอนปิดแท็บ)
      // Also drives the creation funnel (progress/status) — see summarizeJobFunnel.
      prisma.videoJob.findMany({
        where: { createdAt: { gte: since } },
        select: { userId: true, status: true, currentStep: true, errorMessage: true, progress: true, startedAt: true, finishedAt: true },
      }),
      getPlanConfig(),
      // Render throughput (window) from RenderJob — the source of truth for editor-v2/worker renders.
      prisma.renderJob.findMany({
        where: { createdAt: { gte: since } },
        select: { type: true, status: true, parentJobId: true, startedAt: true, finishedAt: true },
      }),
      // Cash ground truth — distinct users who ever completed a PAID payment.
      prisma.payment.findMany({ where: { status: "PAID" }, select: { userId: true }, distinct: ["userId"] }),
      // Previous-window VideoJobs — so previous.funnel is also job-derived (apples-to-apples).
      prisma.videoJob.findMany({
        where: { createdAt: { gte: previousSince, lt: since } },
        select: { userId: true, status: true, progress: true },
      }),
      // Server-truth "started pipeline": distinct users who ever created a VideoJob (any time).
      // Replaces the v1-only editor_script_ready telemetry, which editor v2 never emits.
      prisma.videoJob.findMany({ select: { userId: true }, distinct: ["userId"] }),
    ]);

    const nonEmpty = (value: string | null) => typeof value === "string" && value.trim().length > 0;
    const completedUsersIn = (videos: VideoRow[]) =>
      new Set(videos.filter((video) => video.status === "COMPLETED").map((video) => video.userId)).size;

    // Real revenue cohorts (reuses the users we already fetched — no extra query). "Paying" is
    // anchored on CASH (a PAID payment), so trials and comped/coupon access never count as paying.
    const paidUserIds = new Set(paidRows.map((r) => r.userId));
    const cohorts = computeRevenueCohorts(
      allUsers,
      paidUserIds,
      { pro: planConfig.pro.price, business: planConfig.business.price },
      now,
    );

    // Internal team = @aoacademy accounts. Excluded from ALL funnel/activation counts (they inflate
    // signups/started/completed), but workshop students (คลังแสง) and every other account are KEPT —
    // they are real prospects. Same rule as revenue-cohorts.ts.
    const internalUserIds = new Set(
      allUsers.filter((u) => (u.email ?? "").toLowerCase().includes("@aoacademy")).map((u) => u.id),
    );

    // Creation funnel input — VideoJob rows (server truth), internal team excluded.
    const currentJobsForFunnel = currentJobs
      .filter((j) => !internalUserIds.has(j.userId))
      .map((j) => ({ userId: j.userId, status: j.status, progress: j.progress }));
    const previousJobsForFunnel = previousJobs
      .filter((j) => !internalUserIds.has(j.userId))
      .map((j) => ({ userId: j.userId, status: j.status, progress: j.progress }));

    // Activation counts (pure + testable) — @aoacademy internal accounts excluded, workshop students kept.
    const activationFunnel = computeActivationFunnel({
      users: allUsers.map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt })),
      openedUserIds: openedUserRows.map((r) => r.userId),
      jobUserIds: jobUserRows.map((r) => r.userId),
      completedByUser: completedByUser.map((g) => ({ userId: g.userId, count: g._count?._all ?? 0 })),
      since,
    });

    const activation = {
      managed: process.env.MANAGED_GEMINI === "1",
      // These funnel/activation counts EXCLUDE @aoacademy internal accounts; workshop students are
      // intentionally kept (real prospects). internalTeam is surfaced so the UI can show what was cut.
      signups: activationFunnel.signups,
      internalTeam: cohorts.internalTeam,
      hasGeminiKey: allUsers.filter((u) => nonEmpty(u.geminiKey)).length,
      hasStockKey: allUsers.filter((u) => nonEmpty(u.pexelsKey) || nonEmpty(u.pixabayKey)).length,
      // Real paying customers = cash + currently entitled (was: any plan=PRO/BUSINESS, which swept in trials + comps).
      paidTotal: cohorts.payingTotal,
      payingCanceling: cohorts.payingCanceling,
      mrrAtRisk: cohorts.mrrAtRisk,
      trialActive: cohorts.trialActive,
      compedPaid: cohorts.compedPaid,
      openedEditor: activationFunnel.openedEditor,
      // Server truth: distinct users who ever created a VideoJob (was v1-only editor_script_ready telemetry).
      startedPipeline: activationFunnel.startedPipeline,
      completedFirstVideo: activationFunnel.completedFirstVideo,
      repeatCreators: activationFunnel.repeatCreators,
      windowSignups: activationFunnel.windowSignups,
      windowCompletedUsers: completedUsersIn(currentVideos),
      prevWindowCompletedUsers: completedUsersIn(previousVideos),
    };
    const renderStats = summarizeRenderJobs(renderJobRows);

    // Under managed Gemini a 429/RESOURCE_EXHAUSTED is OUR key (capacity), not a customer key.
    const managedGemini = process.env.MANAGED_GEMINI === "1";
    const failedJobs = currentJobs.filter((j) => j.status === "failed");
    const failedByStageMap = new Map<string, { stage: string; stageLabel: string; kind: "system" | "byok" | "quota" | "noise"; count: number; sample: string }>();
    for (const job of failedJobs) {
      const kind = classifyJobError(job.errorMessage, managedGemini);
      const key = `${job.currentStep ?? "unknown"}:${kind}`;
      const entry = failedByStageMap.get(key) ?? { stage: job.currentStep ?? "unknown", stageLabel: jobStepLabel(job.currentStep), kind, count: 0, sample: "" };
      entry.count++;
      if (!entry.sample && job.errorMessage) entry.sample = job.errorMessage.slice(0, 100);
      failedByStageMap.set(key, entry);
    }
    const jobOutcomes = {
      total: currentJobs.length,
      done: currentJobs.filter((j) => j.status === "done").length,
      failed: failedJobs.length,
      processing: currentJobs.filter((j) => j.status === "processing").length,
      queued: currentJobs.filter((j) => j.status === "queued").length,
      systemFailed: failedJobs.filter((j) => classifyJobError(j.errorMessage, managedGemini) === "system").length,
      byokFailed: failedJobs.filter((j) => classifyJobError(j.errorMessage, managedGemini) === "byok").length,
      quotaFailed: failedJobs.filter((j) => classifyJobError(j.errorMessage, managedGemini) === "quota").length,
      noiseFailed: failedJobs.filter((j) => classifyJobError(j.errorMessage, managedGemini) === "noise").length,
      failedByStage: Array.from(failedByStageMap.values()).sort((a, b) => b.count - a.count),
    };

    return NextResponse.json({
      range: { days, since: since.toISOString(), until: now.toISOString() },
      activation,
      renderStats,
      jobOutcomes,
      current: summarize(currentRows, currentVideos, processingPlan.summary, summarizeJobFunnel(currentJobsForFunnel)),
      previous: summarize(previousRows, previousVideos, undefined, summarizeJobFunnel(previousJobsForFunnel)),
      processingReconcile: { dryRun: true, ...processingPlan },
    });
  } catch (error) {
    return apiError({ route: "GET /api/admin/insights", error });
  }
}
