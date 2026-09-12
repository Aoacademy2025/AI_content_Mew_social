/**
 * How /admin/insights reads TelemetryEvent (A4 rows #51, #52, #71, #72, #82, #86, #92, §3.0).
 *
 * The route used to read each window with `telemetryEvent.findMany({ take: 20_000 })`. On prod the
 * 30-day window holds 102,501 rows, so the page rendered the newest ~19.5 % of it (about 3.5 days)
 * and called it "30 วัน" — `editor_opened` read 693 instead of 3,886, the error classes read 745
 * instead of 5,615. Worse, the PREVIOUS window had no `orderBy`, so SQLite handed back rowid order:
 * the OLDEST 20,000 rows. Every "ดีขึ้น/แย่ลงจากช่วงก่อน" comparison was a newest-sample next to an
 * oldest-sample of two different sizes, with nothing in the payload or the UI admitting it.
 *
 * Two reads replace it, and they split along the only line that matters — whether a number can be
 * counted in SQL or needs the row in JS:
 *
 *   countInsightsTelemetry()   `sessions` / `users` / `events` are "all telemetry in this window",
 *                              so they are counted server-side over the whole window and are exact
 *                              no matter how many rows exist.
 *
 *   readInsightsTelemetryRows() everything else needs the row itself — `properties` is JSON that
 *                              only JS can classify (the Job Failure Class helpers, web vitals,
 *                              B-roll phases, playback grouping), and percentiles need the values.
 *                              Those rows are fetched in full, ordered newest-first on BOTH windows,
 *                              narrowed to exactly the predicates a summarizer inspects, and capped
 *                              only by a safety valve that is far above a real window — and when
 *                              that valve ever bites, `truncated` says so out loud.
 *
 * Keep CONSUMED_TELEMETRY_FILTER in step with the summarizers in the insights route: a row that
 * matches none of these predicates is never inspected, and a new summarizer that reads a row this
 * filter drops would silently see zero. scripts/verify-admin-number-telemetry-window.ts pins the
 * families that exist today.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Safety valve, not a sample. A real 30-day window on prod is 102,501 rows *in total* and the
 * filter below keeps only a subset of those, so this never bites in normal operation — it exists so
 * a telemetry runaway degrades the admin page instead of the box. Crossing it sets `truncated`.
 */
export const TELEMETRY_ROW_CAP = 120_000;

export const INSIGHTS_TELEMETRY_SELECT = {
  name: true,
  category: true,
  source: true,
  sessionId: true,
  userId: true,
  step: true,
  status: true,
  durationMs: true,
  value: true,
  path: true,
  properties: true,
  createdAt: true,
} as const;

export type InsightsTelemetryRow = {
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

/**
 * Every predicate the /admin/insights summarizers match a row on, as a deliberate SUPERSET:
 *
 *   category/status/name ~ error|fail  → rawErrorRows → errors / byok / quota / noise counts
 *   name ^ editor_                     → editorOpens, pipelineStarts, editorSessions, the funnel
 *   name ^ pipeline_                   → the pipeline step table, editorSessions
 *   name ^ fetch_stock_server_         → the B-roll panel
 *   name ^ render_server_              → the render resource panel
 *   name ^ video_playback_             → the playback panel
 *   name ^ managed_stock_              → the managed-stock capacity panel
 *   name = web_vital                   → LCP / INP / CLS
 *   path = /video-editor               → editorSessions
 *   step IS NOT NULL                   → the step p50/p95 arrays take a duration from ANY row that
 *                                        carries a step, not only the pipeline_step_* lifecycle
 *
 * SQLite's LIKE is case-insensitive for ASCII and treats `_` as a wildcard, so `startsWith` here
 * matches a little more than the JS `String.startsWith` it mirrors. That direction is safe: the JS
 * predicates still decide what each number counts; this filter only decides what is worth shipping.
 */
export const CONSUMED_TELEMETRY_FILTER: Prisma.TelemetryEventWhereInput = {
  OR: [
    { category: "error" },
    { status: "error" },
    { name: { contains: "error" } },
    { name: { contains: "fail" } },
    { name: { startsWith: "editor_" } },
    { name: { startsWith: "pipeline_" } },
    { name: { startsWith: "fetch_stock_server_" } },
    { name: { startsWith: "render_server_" } },
    { name: { startsWith: "video_playback_" } },
    { name: { startsWith: "managed_stock_" } },
    { name: "web_vital" },
    { path: "/video-editor" },
    { step: { not: null } },
  ],
};

export type TelemetryWindow = { gte: Date; lt?: Date };

function windowWhere(range: TelemetryWindow): Prisma.TelemetryEventWhereInput {
  return { createdAt: range.lt ? { gte: range.gte, lt: range.lt } : { gte: range.gte } };
}

/**
 * The rows a summarizer inspects, newest-first. `truncated` is true only if the safety cap bit, and
 * the insights page renders a visible note when it does — a sampled panel must never look complete.
 */
export async function readInsightsTelemetryRows(
  range: TelemetryWindow,
  cap: number = TELEMETRY_ROW_CAP,
): Promise<{ rows: InsightsTelemetryRow[]; truncated: boolean }> {
  const rows = await prisma.telemetryEvent.findMany({
    where: { ...windowWhere(range), ...CONSUMED_TELEMETRY_FILTER },
    select: INSIGHTS_TELEMETRY_SELECT,
    orderBy: { createdAt: "desc" },
    take: cap,
  });
  return { rows, truncated: rows.length >= cap };
}

/**
 * `events` / `sessions` / `users` over the WHOLE window — the three numbers that mean "all telemetry
 * here", counted in SQL so no cap can shrink them. `excludeUserIds` is the @aoacademy internal team,
 * the same exclusion the route applies in JS to every other customer KPI (rows with no userId are
 * kept: an anonymous event is a customer event).
 */
export async function countInsightsTelemetry(
  range: TelemetryWindow,
  excludeUserIds: string[],
): Promise<{ events: number; sessions: number; users: number }> {
  const where: Prisma.TelemetryEventWhereInput = {
    ...windowWhere(range),
    ...(excludeUserIds.length > 0
      ? { OR: [{ userId: null }, { userId: { notIn: excludeUserIds } }] }
      : {}),
  };

  const [events, sessionGroups, userGroups] = await Promise.all([
    prisma.telemetryEvent.count({ where }),
    prisma.telemetryEvent.groupBy({ by: ["sessionId"], where: { ...where, sessionId: { not: null } } }),
    prisma.telemetryEvent.groupBy({ by: ["userId"], where: { ...where, userId: { not: null } } }),
  ]);

  return { events, sessions: sessionGroups.length, users: userGroups.length };
}
