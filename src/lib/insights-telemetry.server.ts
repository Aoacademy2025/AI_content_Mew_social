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
 * filter drops would silently see zero. It is the DECLARED SPEC of that read; since C7 the statement
 * that actually runs is CONSUMED_TELEMETRY_SQL, and assertion (j) of
 * scripts/verify-admin-number-telemetry-window.ts runs BOTH over the same 100,002-row fixture and
 * fails unless they return the same rows with the same values and the same types. Edit one and the
 * other must move with it — the test says so out loud instead of a number moving on /admin/insights.
 *
 * Task C7 fix 1 — the COST of that read, not its meaning. Reading the whole window made `days=30`
 * 2,738 ms warm on prod (826 ms with the old 20,000-row sample), and measured on a prod-shaped
 * 100,000-row fixture the dominant term is not SQLite and not the summarizers: it is the Prisma
 * query engine turning ~74,000 rows into ~74,000 JS objects, 6.3 µs a row. The same rows, same
 * columns, same order, read with a parameterised `$queryRaw` and mapped by hand cost 3.0 µs a row —
 * the window read drops from 398 ms to 235 ms and the route from 469 ms to ~300 ms, with NOT ONE
 * summarizer, predicate or number touched. Server-side aggregation was measured too and is worse:
 * four GROUP BY passes over the same window cost ~250 ms of SQLite time to replace ~165 ms of
 * hydration, and they would put a second copy of the Job Failure Class taxonomy in SQL. See the
 * C7 report for the numbers.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Safety valve, not a sample. A real 30-day window on prod is 102,501 rows *in total* and the
 * filter below keeps only a subset of those, so this never bites in normal operation — it exists so
 * a telemetry runaway degrades the admin page instead of the box. Crossing it sets `truncated`.
 */
export const TELEMETRY_ROW_CAP = 120_000;

/**
 * The columns the summarizers read — the declared spec for the raw read below, and the `select` the
 * verify script's query-builder twin uses to prove the two agree field by field. "What
 * /admin/insights reads from a telemetry row" stays stated in one place.
 */
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

/**
 * `CONSUMED_TELEMETRY_FILTER` as SQL, because the read above is a `$queryRaw` (see the C7 note at the
 * top of this file). It is the filter, clause for clause, in the form Prisma itself generates:
 * `contains` → `LIKE '%x%'`, `startsWith` → `LIKE 'x%'` with NO `ESCAPE`, so `_` stays the wildcard
 * it has always been here and this read keeps matching exactly the rows the query builder matched.
 * Change one and change the other: assertion (j) of
 * scripts/verify-admin-number-telemetry-window.ts runs the query-builder filter and this statement
 * over the same fixture — including rows built to catch the differences (`editorXopened`,
 * `EDITOR_opened`, `WEB_VITAL`, a `status` of `ERROR`) — and fails on the first row, field or type
 * where they disagree.
 */
const CONSUMED_TELEMETRY_SQL = Prisma.sql`(
  "category" = 'error'
  OR "status" = 'error'
  OR "name" LIKE '%error%'
  OR "name" LIKE '%fail%'
  OR "name" LIKE 'editor_%'
  OR "name" LIKE 'pipeline_%'
  OR "name" LIKE 'fetch_stock_server_%'
  OR "name" LIKE 'render_server_%'
  OR "name" LIKE 'video_playback_%'
  OR "name" LIKE 'managed_stock_%'
  OR "name" = 'web_vital'
  OR "path" = '/video-editor'
  OR "step" IS NOT NULL
)`;

/**
 * What SQLite hands back through `$queryRaw`: TEXT as string, INTEGER as number or bigint (the raw
 * client widens large integers), REAL as number, and a Prisma `DateTime` as the epoch milliseconds
 * it is stored as. `toInsightsTelemetryRow` restores exactly the shape `findMany` returned — a
 * bigint reaching a summarizer would poison every percentile it touches.
 */
type RawTelemetryRow = {
  name: string;
  category: string;
  source: string;
  sessionId: string | null;
  userId: string | null;
  step: string | null;
  status: string | null;
  durationMs: number | bigint | null;
  value: number | bigint | null;
  path: string | null;
  properties: string | null;
  createdAt: number | bigint | string | Date;
};

function toInsightsTelemetryRow(row: RawTelemetryRow): InsightsTelemetryRow {
  return {
    name: row.name,
    category: row.category,
    source: row.source,
    sessionId: row.sessionId,
    userId: row.userId,
    step: row.step,
    status: row.status,
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    value: row.value === null ? null : Number(row.value),
    path: row.path,
    properties: row.properties,
    // Epoch milliseconds today. A future driver returning an ISO string must not become
    // `new Date(NaN)`, which would silently mis-bucket every Bangkok day and every "newest first".
    createdAt: row.createdAt instanceof Date
      ? row.createdAt
      : new Date(typeof row.createdAt === "string" ? row.createdAt : Number(row.createdAt)),
  };
}

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
  const upper = range.lt ? Prisma.sql`AND "createdAt" < ${range.lt}` : Prisma.empty;
  const raw = await prisma.$queryRaw<RawTelemetryRow[]>(Prisma.sql`
    SELECT "name", "category", "source", "sessionId", "userId", "step", "status",
           "durationMs", "value", "path", "properties", "createdAt"
    FROM "TelemetryEvent"
    WHERE "createdAt" >= ${range.gte} ${upper} AND ${CONSUMED_TELEMETRY_SQL}
    ORDER BY "createdAt" DESC
    LIMIT ${cap}
  `);
  const rows = raw.map(toInsightsTelemetryRow);
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
