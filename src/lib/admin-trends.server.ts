/**
 * Daily Trend (CONTEXT.md § Operations & Admin) — the per-day count series behind /admin's trend
 * cards. One question only: "how is today going". Per ADR 0062 this surface renders NO money
 * amounts; จ่ายจริง is a COUNT of paid payments and nothing else.
 *
 * Day boundary is Asia/Bangkok midnight everywhere (UTC+7, no DST):
 *   SQLite  date(col / 1000, 'unixepoch', '+7 hours')   — DateTime columns are epoch-ms integers
 *   JS      Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' })
 * The comparison period is the equal-length window immediately before the current one.
 *
 * Where renders live: EVERY render is one RenderJob row — the editor path
 * (api/videos/render → enqueueRenderJob, parentJobId null) and the orchestrated/MCP path
 * (lib/render/job-store, parentJobId = VideoJob.id). VideoJob is the orchestration parent and has
 * no separate success population, so the success series read RenderJob ONLY and count every row
 * once, children included. The failure series reads both tables but skips child RenderJobs
 * (parentJobId IS NOT NULL) so an orchestrated failure is never counted twice.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { classifyJobError } from "./job-failure-class";
import { readDisk } from "./storage-health";

export type TrendDay = {
  date: string;
  signups: number;
  rendersDone: number;
  exportsDone: number;
  failedSystem: number;
  failedCustomer: number;
  paidPayments: number;
};
export type TrendTotals = Omit<TrendDay, "date">;
export type AdminTrends = {
  days: 14 | 30;
  timezone: "Asia/Bangkok";
  series: TrendDay[];
  totals: { current: TrendTotals; previous: TrendTotals };
  secondary: { serverErrorNotifications: number; frontendErrors: number };
  northStar: {
    snapshotDate: string;
    activeCreators: number;
    activePayingCustomers: number;
    deltaActiveCreatorsVs30d: number | null;
  } | null;
  queue: { renderQueued: number; videoJobsQueued: number };
  openTickets: number;
  diskUsedPercent: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const BANGKOK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" });
const NORTH_STAR_COMPARE_DAYS = 30;

/** The Asia/Bangkok calendar day (YYYY-MM-DD) that contains `at`. */
function bangkokDayKey(at: Date): string {
  return BANGKOK_DAY.format(at);
}

/** Bangkok midnight that opens the given day, as an absolute instant. */
function bangkokDayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00+07:00`);
}

function shiftDayKey(dayKey: string, deltaDays: number): string {
  return bangkokDayKey(new Date(bangkokDayStart(dayKey).getTime() + deltaDays * DAY_MS));
}

/** `?days=14|30`; anything else (absent, 7, junk) is the 30-day default. */
export function coerceTrendDays(raw: string | null | undefined): 14 | 30 {
  return raw === "14" ? 14 : 30;
}

// defaultTrendDays lives in admin-trends-shared.ts (no server-only imports) so the "use client"
// /admin page can import it directly without pulling prisma/fs/child_process into the browser
// bundle; re-exported here so server-side callers (e.g. verify-admin-trends.ts) keep one path.
export { defaultTrendDays } from "./admin-trends-shared";

function emptyTotals(): TrendTotals {
  return { signups: 0, rendersDone: 0, exportsDone: 0, failedSystem: 0, failedCustomer: 0, paidPayments: 0 };
}

type DayCountRow = { d: string | null; c: number | bigint };
type FailureRow = { d: string | null; text: string | null };

/** Fold `SELECT day, count` rows into a plain map; SQLite counts arrive as bigint. */
function countsByDay(rows: DayCountRow[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (!row.d) continue;
    byDay.set(row.d, (byDay.get(row.d) ?? 0) + Number(row.c));
  }
  return byDay;
}

export async function getAdminTrends(days: 14 | 30, now: Date = new Date()): Promise<AdminTrends> {
  const todayKey = bangkokDayKey(now);
  const currentDays: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) currentDays.push(shiftDayKey(todayKey, -i));
  const previousDays = new Set(currentDays.map((day) => shiftDayKey(day, -days)));

  const currentStart = bangkokDayStart(currentDays[0]);
  // One query per series spanning BOTH windows, split by day key in JS: identical numbers to two
  // shifted queries, half the scans — and /admin must stay the cheap page (ADR 0062).
  const previousStart = new Date(currentStart.getTime() - days * DAY_MS);

  const managedGemini = process.env.MANAGED_GEMINI === "1";

  const [
    signupRows,
    renderRows,
    videoFailureRows,
    renderFailureRows,
    paymentRows,
    serverErrorNotifications,
    frontendErrors,
    renderQueued,
    videoJobsQueued,
    openTickets,
    latestSnapshot,
    disk,
  ] = await Promise.all([
    // Signups exclude @aoacademy internal accounts — the same team exclusion /admin/insights
    // applies to its activation funnel, so this card matches the Signup Cohort in CONTEXT.md.
    prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
      SELECT date("createdAt" / 1000, 'unixepoch', '+7 hours') AS d, COUNT(*) AS c
      FROM "User"
      WHERE "createdAt" >= ${previousStart}
        AND lower("email") NOT LIKE '%@aoacademy%'
      GROUP BY d
    `),
    // Both success series in one pass. No parentJobId filter: every RenderJob row is one render.
    prisma.$queryRaw<(DayCountRow & { type: string })[]>(Prisma.sql`
      SELECT "type" AS type,
             date(COALESCE("finishedAt", "createdAt") / 1000, 'unixepoch', '+7 hours') AS d,
             COUNT(*) AS c
      FROM "RenderJob"
      WHERE "status" = 'DONE'
        AND "type" IN ('RENDER', 'BURN')
        AND COALESCE("finishedAt", "createdAt") >= ${previousStart}
      GROUP BY type, d
    `),
    prisma.$queryRaw<FailureRow[]>(Prisma.sql`
      SELECT date(COALESCE("finishedAt", "updatedAt") / 1000, 'unixepoch', '+7 hours') AS d,
             "errorMessage" AS text
      FROM "VideoJob"
      WHERE "status" = 'failed'
        AND COALESCE("finishedAt", "updatedAt") >= ${previousStart}
    `),
    // parentJobId IS NULL: a child RenderJob of a failed VideoJob is the SAME failure, already
    // counted above. Only standalone (editor) render failures are counted here.
    prisma.$queryRaw<FailureRow[]>(Prisma.sql`
      SELECT date(COALESCE("finishedAt", "createdAt") / 1000, 'unixepoch', '+7 hours') AS d,
             "error" AS text
      FROM "RenderJob"
      WHERE "status" = 'FAILED'
        AND "parentJobId" IS NULL
        AND COALESCE("finishedAt", "createdAt") >= ${previousStart}
    `),
    // จ่ายจริง = a PAID plan payment ABOVE ฿0, the definition Task C5a fixed on /admin/revenue. A
    // trial conversion and a 100 % coupon both write a PAID row for `amount` 0 satang; counting
    // those made 37 people look like payers in 30 days on prod. `amount` is in the WHERE clause
    // only — this card counts payments and renders no money at all (ADR 0062).
    prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
      SELECT date("paidAt" / 1000, 'unixepoch', '+7 hours') AS d, COUNT(*) AS c
      FROM "Payment"
      WHERE "status" = 'PAID' AND "amount" > 0 AND "paidAt" >= ${previousStart}
      GROUP BY d
    `),
    prisma.notification.count({ where: { type: "ERROR_SYSTEM", createdAt: { gte: currentStart } } }),
    prisma.telemetryEvent.count({ where: { name: "frontend_error", createdAt: { gte: currentStart } } }),
    prisma.renderJob.count({ where: { status: "QUEUED" } }),
    prisma.videoJob.count({ where: { status: "queued" } }),
    prisma.supportTicket.count({ where: { status: "OPEN" } }),
    prisma.northStarDailySnapshot.findFirst({ orderBy: { snapshotDate: "desc" } }),
    // readDisk is a single `df` call. NEVER a du walk — that is what made /admin the slow page.
    readDisk("/").catch(() => null),
  ]);

  const signups = countsByDay(signupRows);
  const rendersDone = countsByDay(renderRows.filter((row) => row.type === "RENDER"));
  const exportsDone = countsByDay(renderRows.filter((row) => row.type === "BURN"));
  const paidPayments = countsByDay(paymentRows);

  const failedSystem = new Map<string, number>();
  const failedCustomer = new Map<string, number>();
  for (const row of [...videoFailureRows, ...renderFailureRows]) {
    if (!row.d) continue;
    const kind = classifyJobError(row.text, managedGemini);
    if (kind === "noise") continue; // superseded/cancelled work is not a failure
    const bucket = kind === "system" ? failedSystem : failedCustomer;
    bucket.set(row.d, (bucket.get(row.d) ?? 0) + 1);
  }

  const dayOf = (date: string): TrendDay => ({
    date,
    signups: signups.get(date) ?? 0,
    rendersDone: rendersDone.get(date) ?? 0,
    exportsDone: exportsDone.get(date) ?? 0,
    failedSystem: failedSystem.get(date) ?? 0,
    failedCustomer: failedCustomer.get(date) ?? 0,
    paidPayments: paidPayments.get(date) ?? 0,
  });
  const sum = (dates: Iterable<string>): TrendTotals => {
    const totals = emptyTotals();
    for (const date of dates) {
      const day = dayOf(date);
      totals.signups += day.signups;
      totals.rendersDone += day.rendersDone;
      totals.exportsDone += day.exportsDone;
      totals.failedSystem += day.failedSystem;
      totals.failedCustomer += day.failedCustomer;
      totals.paidPayments += day.paidPayments;
    }
    return totals;
  };

  const series = currentDays.map(dayOf);

  let northStar: AdminTrends["northStar"] = null;
  if (latestSnapshot) {
    const priorKey = shiftDayKey(latestSnapshot.snapshotDate, -NORTH_STAR_COMPARE_DAYS);
    const prior = await prisma.northStarDailySnapshot.findUnique({ where: { snapshotDate: priorKey } });
    northStar = {
      snapshotDate: latestSnapshot.snapshotDate,
      activeCreators: latestSnapshot.activeCreators,
      activePayingCustomers: latestSnapshot.activePayingCustomers,
      deltaActiveCreatorsVs30d: prior ? latestSnapshot.activeCreators - prior.activeCreators : null,
    };
  }

  return {
    days,
    timezone: "Asia/Bangkok",
    series,
    totals: { current: sum(currentDays), previous: sum(previousDays) },
    secondary: { serverErrorNotifications, frontendErrors },
    northStar,
    queue: { renderQueued, videoJobsQueued },
    openTickets,
    diskUsedPercent: disk ? disk.usedPercent : null,
  };
}
