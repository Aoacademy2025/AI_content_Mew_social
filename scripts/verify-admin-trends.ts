// The /admin daily trend cards are only useful if every count lands on the right Asia/Bangkok day
// and no job is counted twice. This script builds a throwaway SQLite database, plants rows on both
// sides of a Bangkok midnight, and pins the numbers the cards render.
//
// Day boundary reference (Asia/Bangkok = UTC+7, no DST):
//   2026-09-10T16:59:00Z → Bangkok 2026-09-10 23:59 → day "2026-09-10"
//   2026-09-10T17:00:00Z → Bangkok 2026-09-11 00:00 → day "2026-09-11"
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-trends-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
// Classification must not depend on the machine that runs the test.
process.env.MANAGED_GEMINI = "0";
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string) {
  if (condition) { passed += 1; console.log(`ok: ${label}`); }
  else { failed += 1; console.error(`FAIL: ${label}`); }
}

const NOW = new Date("2026-09-12T05:00:00Z");        // Bangkok 2026-09-12 12:00
const LATE_DAY_10 = new Date("2026-09-10T16:59:00Z"); // Bangkok 2026-09-10 23:59
const EARLY_DAY_11 = new Date("2026-09-10T17:00:00Z"); // Bangkok 2026-09-11 00:00
const MID_DAY_09 = new Date("2026-09-09T05:00:00Z");  // Bangkok 2026-09-09 12:00
const PREVIOUS_WINDOW = new Date("2026-07-31T17:00:00Z"); // Bangkok 2026-08-01 00:00

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { Prisma } = await import("@prisma/client");
  const { getAdminTrends, coerceTrendDays, defaultTrendDays } = await import("../src/lib/admin-trends.server");

  // Every fixture row needs an owner. The owner is an @aoacademy account so it can never leak into
  // the signup series — the same team exclusion /admin/insights applies to its funnel.
  const OWNER = "owner-team";
  async function reset() {
    await prisma.renderJob.deleteMany();
    await prisma.videoJob.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.telemetryEvent.deleteMany();
    await prisma.supportTicket.deleteMany();
    await prisma.northStarDailySnapshot.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.create({
      data: { id: OWNER, name: "Team", email: "team@aoacademy.co", createdAt: LATE_DAY_10 },
    });
  }

  const signup = (id: string, email: string, createdAt: Date) =>
    prisma.user.create({ data: { id, name: id, email, createdAt } });
  const renderJob = (id: string, type: "RENDER" | "BURN", status: string, at: Date | null, extra: { parentJobId?: string; error?: string } = {}) =>
    prisma.renderJob.create({
      data: { id, userId: OWNER, type, status, payload: "{}", finishedAt: at, ...extra },
    });
  const videoJob = (id: string, status: string, at: Date | null, errorMessage?: string) =>
    prisma.videoJob.create({
      data: { id, userId: OWNER, status, inputJson: "{}", finishedAt: at, errorMessage },
    });
  const payment = (id: string, paidAt: Date, amount = 59_900) =>
    prisma.payment.create({
      data: { id, userId: OWNER, stripeSessionId: id, plan: "PRO", amount, status: "PAID", paidAt },
    });
  const dayOf = (trends: Awaited<ReturnType<typeof getAdminTrends>>, date: string) =>
    trends.series.find((d) => d.date === date);

  // ---- (a) Bangkok day boundary, every series ------------------------------------------------
  await reset();
  await Promise.all([
    signup("s-10", "ten@example.com", LATE_DAY_10),
    signup("s-11", "eleven@example.com", EARLY_DAY_11),
    renderJob("r-10", "RENDER", "DONE", LATE_DAY_10),
    renderJob("r-11", "RENDER", "DONE", EARLY_DAY_11),
    renderJob("b-10", "BURN", "DONE", LATE_DAY_10),
    renderJob("b-11", "BURN", "DONE", EARLY_DAY_11),
    payment("p-10", LATE_DAY_10),
    payment("p-11", EARLY_DAY_11),
    videoJob("f-10", "failed", LATE_DAY_10, "ffmpeg exited with code 1"),
    videoJob("f-11", "failed", EARLY_DAY_11, "ffmpeg exited with code 1"),
  ]);

  const a = await getAdminTrends(30, NOW);
  const d10 = dayOf(a, "2026-09-10");
  const d11 = dayOf(a, "2026-09-11");
  check(d10?.signups === 1 && d11?.signups === 1, "(a) signups split across Bangkok midnight, team account excluded");
  check(d10?.rendersDone === 1 && d11?.rendersDone === 1, "(a) rendersDone split across Bangkok midnight");
  check(d10?.exportsDone === 1 && d11?.exportsDone === 1, "(a) exportsDone split across Bangkok midnight");
  check(d10?.paidPayments === 1 && d11?.paidPayments === 1, "(a) paidPayments split across Bangkok midnight");
  check(d10?.failedSystem === 1 && d11?.failedSystem === 1, "(a) failures split across Bangkok midnight");
  check(a.timezone === "Asia/Bangkok" && a.days === 30, "(a) trends declare their day count and timezone");

  // ---- (b) every RenderJob row counts once, children included ---------------------------------
  await reset();
  await renderJob("edit-render", "RENDER", "DONE", MID_DAY_09);      // editor render, no parent
  await videoJob("mcp-video", "done", MID_DAY_09);                    // orchestration parent
  await renderJob("mcp-render", "RENDER", "DONE", MID_DAY_09, { parentJobId: "mcp-video" });
  await renderJob("mcp-burn", "BURN", "DONE", MID_DAY_09, { parentJobId: "mcp-video" });

  const b = await getAdminTrends(30, NOW);
  check(b.totals.current.rendersDone === 2, "(b) editor + orchestrated renders both count (2)");
  check(b.totals.current.exportsDone === 1, "(b) the orchestrated burn is the only export (1)");

  // ---- (c) a failure is counted once and noise is dropped -------------------------------------
  await reset();
  await videoJob("orch-fail", "failed", MID_DAY_09, "ffmpeg exited with code 1");
  await renderJob("orch-fail-child", "RENDER", "FAILED", MID_DAY_09, {
    parentJobId: "orch-fail", error: '{"message":"ffmpeg exited with code 1"}',
  });
  await renderJob("editor-fail", "RENDER", "FAILED", MID_DAY_09, {
    error: '{"message":"API_KEY_INVALID: api key not valid"}',
  });
  await renderJob("superseded", "RENDER", "FAILED", MID_DAY_09, {
    error: '{"message":"__SUPERSEDED__"}',
  });

  const c = await getAdminTrends(30, NOW);
  check(c.totals.current.failedSystem === 1, "(c) an orchestrated failure counts once, not once per table");
  check(c.totals.current.failedCustomer === 1, "(c) an editor BYOK failure is a customer-side failure");
  check(dayOf(c, "2026-09-09")?.failedSystem === 1, "(c) failures land on the Bangkok day they finished");

  // ---- (d) finishedAt may be null; updatedAt still places the row -----------------------------
  await reset();
  await videoJob("no-finish", "failed", null, "ffmpeg exited with code 1");
  await prisma.$executeRaw(Prisma.sql`UPDATE "VideoJob" SET "updatedAt" = ${MID_DAY_09} WHERE "id" = 'no-finish'`);

  const d = await getAdminTrends(30, NOW);
  check(d.totals.current.failedSystem === 1, "(d) a failed job with no finishedAt is still counted");
  check(dayOf(d, "2026-09-09")?.failedSystem === 1, "(d) it falls back to updatedAt for its Bangkok day");

  // ---- (d2) จ่ายจริง means money actually changed hands (Task C7 fix 2) ------------------------
  // C5a defined จ่ายจริง as a PAID plan payment ABOVE ฿0. The trend card counted every PAID row, so
  // the ฿0 rows a trial conversion or a 100 % coupon writes were counted as people paying: 37 in
  // 30 days on prod. The card is a COUNT of payments, never an amount (ADR 0062), so `amount` only
  // ever appears in the WHERE clause.
  await reset();
  await Promise.all([
    payment("cash-09", MID_DAY_09, 59_900),   // a real charge
    payment("cash-10", LATE_DAY_10, 1),       // ฿0.01 — still money
    payment("free-09", MID_DAY_09, 0),        // trial conversion / 100 % coupon
    payment("free-10", LATE_DAY_10, 0),
  ]);

  const d2 = await getAdminTrends(30, NOW);
  check(d2.totals.current.paidPayments === 2,
    `(d2) จ่ายจริง counts only payments above ฿0 (${d2.totals.current.paidPayments} of 4 PAID rows)`);
  check(dayOf(d2, "2026-09-09")?.paidPayments === 1 && dayOf(d2, "2026-09-10")?.paidPayments === 1,
    "(d2) the ฿0 rows are dropped on their own Bangkok day, not shifted to another one");

  await reset();
  await payment("free-only", MID_DAY_09, 0);
  const d2b = await getAdminTrends(30, NOW);
  check(d2b.totals.current.paidPayments === 0,
    "(d2) a day of nothing but ฿0 PAID rows reads zero, not one payer");

  const trendsSource = readFileSync("src/lib/admin-trends.server.ts", "utf8");
  check(/"amount"\s*>\s*0/.test(trendsSource),
    "(d2) the paid-payments query filters on the amount column itself, in SQL");
  const cardSource = readFileSync("src/app/(dashboard)/admin/_components/overview/TrendCards.tsx", "utf8");
  check(/ยอดมากกว่า 0/.test(cardSource),
    "(d2) the card's footnote says which payments it counts");

  // ---- (e) shape: zero-fill, order, previous period, coercion ---------------------------------
  await reset();
  await signup("s-prev", "prev@example.com", PREVIOUS_WINDOW);
  await signup("s-now", "now@example.com", MID_DAY_09);

  const e = await getAdminTrends(30, NOW);
  check(e.series.length === 30, "(e) the series is zero-filled to exactly `days` entries");
  check(e.series[0].date === "2026-08-14" && e.series[29].date === "2026-09-12",
    "(e) the series ends on today (Bangkok) and starts `days - 1` days earlier");
  check(e.series.every((day, i) => i === 0 || day.date > e.series[i - 1].date), "(e) the series is ascending");
  check(e.series.filter((day) => day.signups > 0).length === 1, "(e) only the day with a signup is non-zero");
  check(e.totals.current.signups === 1, "(e) the previous window's signup stays out of the current total");
  check(e.totals.previous.signups === 1, "(e) the previous period is the equal-length window before it");

  const e14 = await getAdminTrends(14, NOW);
  check(e14.days === 14 && e14.series.length === 14 && e14.series[0].date === "2026-08-30",
    "(e) a 14-day range is the last 14 Bangkok days");

  check(coerceTrendDays("14") === 14 && coerceTrendDays("30") === 30, "(e) ?days=14 and ?days=30 are honoured");
  check(coerceTrendDays(null) === 30 && coerceTrendDays("7") === 30 && coerceTrendDays("abc") === 30,
    "(e) any other ?days value falls back to 30");
  check(defaultTrendDays(639) === 14 && defaultTrendDays(640) === 30,
    "(e) narrow viewports default to 14 days, everything else to 30");

  // ---- context strip: secondary errors, North Star, queue, tickets, disk ----------------------
  await reset();
  await prisma.notification.create({
    data: { userId: OWNER, type: "ERROR_SYSTEM", title: "t", body: "b", createdAt: MID_DAY_09 },
  });
  await prisma.telemetryEvent.create({
    data: { name: "frontend_error", category: "error", source: "client", createdAt: MID_DAY_09 },
  });
  await renderJob("queued-render", "RENDER", "QUEUED", null);
  await videoJob("queued-video", "queued", null);
  await prisma.supportTicket.create({ data: { userId: OWNER, message: "m", status: "OPEN" } });
  const snapshot = (snapshotDate: string, activeCreators: number, activePayingCustomers: number) =>
    prisma.northStarDailySnapshot.create({
      data: {
        snapshotDate, asOf: NOW, activeRecurringPayers: 0, activePayingCustomers, activeCreators,
        monthlyCreators: 0, annualCreators: 0, videoCreators: 0, scriptCreators: 0, imageCreators: 0,
      },
    });
  await snapshot("2026-08-13", 10, 4);
  await snapshot("2026-09-12", 17, 9);

  const ctx = await getAdminTrends(30, NOW);
  check(ctx.secondary.serverErrorNotifications === 1 && ctx.secondary.frontendErrors === 1,
    "context: server-error notifications and frontend errors are counted for the window");
  check(ctx.queue.renderQueued === 1 && ctx.queue.videoJobsQueued === 1, "context: both queues are reported");
  check(ctx.openTickets === 1, "context: open support tickets are reported");
  check(ctx.northStar?.snapshotDate === "2026-09-12" && ctx.northStar.activeCreators === 17
    && ctx.northStar.activePayingCustomers === 9 && ctx.northStar.deltaActiveCreatorsVs30d === 7,
    "context: North Star reads the latest snapshot and its 30-day-earlier delta");
  check(ctx.diskUsedPercent === null || (typeof ctx.diskUsedPercent === "number" && ctx.diskUsedPercent >= 0),
    "context: disk usage comes from readDisk, never a du walk");

  await prisma.northStarDailySnapshot.deleteMany({ where: { snapshotDate: "2026-08-13" } });
  const noPrior = await getAdminTrends(30, NOW);
  check(noPrior.northStar?.deltaActiveCreatorsVs30d === null,
    "context: a missing 30-day-earlier snapshot reports no delta rather than a fake one");
  await prisma.northStarDailySnapshot.deleteMany();
  const noSnapshot = await getAdminTrends(30, NOW);
  check(noSnapshot.northStar === null, "context: no snapshot at all means no North Star block");

  await prisma.$disconnect();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
