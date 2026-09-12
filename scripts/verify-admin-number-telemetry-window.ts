// Task C5b fix 4 (A4 rows #51, #52, #71, #72, #82, #86, #92 and §3.0) — what the telemetry numbers
// on /admin/insights MEAN.
//
// Before: both windows were read with `telemetryEvent.findMany({ take: 20_000 })`. On prod the
// 30-day window holds 102,501 rows, so the page showed the newest ~19.5 % of it — and the PREVIOUS
// window had no `orderBy` at all, so SQLite returned it in rowid order: the OLDEST 20,000. Every
// "ดีขึ้น/แย่ลงจากช่วงก่อน" comparison put a newest-sample next to an oldest-sample, and nothing in
// the payload or the UI said the numbers were a sample.
//
// After: `sessions` / `users` / `events` are counted server-side over the WHOLE window, the row read
// is narrowed to exactly the rows a summarizer inspects and ordered newest-first on BOTH windows,
// and a `truncated` flag rides in the payload for the day the safety cap ever bites.
//
// Day boundary reference (Asia/Bangkok = UTC+7, no DST):
//   2026-09-10T16:59:00Z → Bangkok 2026-09-10 23:59 → day "2026-09-10"
//   2026-09-10T17:00:00Z → Bangkok 2026-09-11 00:00 → day "2026-09-11"
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-number-telemetry-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string) {
  if (condition) { passed += 1; console.log(`ok: ${label}`); }
  else { failed += 1; console.error(`FAIL: ${label}`); }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-12T05:00:00Z");            // Bangkok 2026-09-12 12:00
const SINCE = new Date(NOW.getTime() - 7 * DAY_MS);      // current window opens
const PREV_SINCE = new Date(NOW.getTime() - 14 * DAY_MS); // previous window opens
const LATE_DAY_10 = new Date("2026-09-10T16:59:00Z");    // Bangkok 2026-09-10 23:59
const EARLY_DAY_11 = new Date("2026-09-10T17:00:00Z");   // Bangkok 2026-09-11 00:00

// Names the /admin/insights summarizers actually inspect, one per predicate family.
const CONSUMED_NAMES = [
  "editor_opened",
  "editor_script_ready",
  "pipeline_step_done",
  "pipeline_step_error",
  "fetch_stock_server_done",
  "render_server_started",
  "video_playback_waiting",
  "managed_stock_used",
  "web_vital",
  "frontend_error",
];
// Names no summarizer ever looks at. They must still count towards `events`/`sessions`/`users`
// (those are "all telemetry in the window"), but they must NOT be shipped row-by-row.
const IGNORED_NAMES = ["page_view", "nav_click", "sidebar_toggle"];

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    readInsightsTelemetryRows,
    countInsightsTelemetry,
    TELEMETRY_ROW_CAP,
  } = await import("../src/lib/insights-telemetry.server");

  const TEAM = "user-team";      // @aoacademy — excluded from every customer KPI
  const CUSTOMER = "user-cust";  // a real customer

  await prisma.user.createMany({
    data: [
      { id: TEAM, name: "Team", email: "team@aoacademy.co" },
      { id: CUSTOMER, name: "Cust", email: "cust@example.com" },
    ],
  });

  // ---- 25,000 rows straddling the current/previous boundary ----------------------------------
  // Spread evenly so the newest rows of the PREVIOUS window sit far from its oldest rows: the old
  // unordered `take: 20_000` returned the oldest slice, and that is what this fixture detects.
  const rows: Array<{
    id: string; name: string; category: string; source: string;
    sessionId: string | null; userId: string | null; step: string | null; path: string | null;
    createdAt: Date;
  }> = [];
  // The current window is deliberately bigger than the old `take: 20_000` cap, so a sample of it
  // could never equal its truth. 7 and 10 are coprime, so every consumed name really gets planted.
  const CURRENT_ROWS = 21_000;
  const PREVIOUS_ROWS = 4_000;

  function plant(prefix: string, index: number, createdAt: Date) {
    const consumed = index % 7 !== 3;                 // ~86 % consumed, the rest ignored
    const name = consumed
      ? CONSUMED_NAMES[index % CONSUMED_NAMES.length]
      : IGNORED_NAMES[index % IGNORED_NAMES.length];
    const owner = index % 7 === 0 ? TEAM : index % 3 === 0 ? null : CUSTOMER;
    rows.push({
      id: `${prefix}-${index}`,
      name,
      category: name === "frontend_error" ? "error" : "product",
      source: index % 2 === 0 ? "client" : "server",
      sessionId: index % 11 === 0 ? null : `sess-${prefix}-${index % 97}`,
      userId: owner,
      step: name.startsWith("pipeline_step_") ? "tts" : null,
      path: index % 13 === 0 ? "/video-editor" : "/dashboard",
      createdAt,
    });
  }

  const currentSpan = NOW.getTime() - SINCE.getTime();
  for (let i = 0; i < CURRENT_ROWS; i++) {
    plant("cur", i, new Date(SINCE.getTime() + Math.floor((currentSpan * i) / CURRENT_ROWS)));
  }
  const prevSpan = SINCE.getTime() - PREV_SINCE.getTime();
  for (let i = 0; i < PREVIOUS_ROWS; i++) {
    plant("prev", i, new Date(PREV_SINCE.getTime() + Math.floor((prevSpan * i) / PREVIOUS_ROWS)));
  }
  // Bangkok-midnight straddle, inside the current window, both consumed, both customer-owned.
  rows.push({
    id: "boundary-late-10", name: "editor_opened", category: "product", source: "client",
    sessionId: "sess-boundary-a", userId: CUSTOMER, step: null, path: "/video-editor",
    createdAt: LATE_DAY_10,
  });
  rows.push({
    id: "boundary-early-11", name: "editor_opened", category: "product", source: "client",
    sessionId: "sess-boundary-b", userId: CUSTOMER, step: null, path: "/video-editor",
    createdAt: EARLY_DAY_11,
  });

  for (let i = 0; i < rows.length; i += 2_000) {
    await prisma.telemetryEvent.createMany({ data: rows.slice(i, i + 2_000) });
  }
  check(rows.length === 25_002, `fixture plants 25,002 telemetry rows (${rows.length})`);

  // ---- independent truth: the definitions as they were written in JS, over EVERY row ----------
  const internalIds = [TEAM];
  const isCustomer = (userId: string | null) => !userId || !internalIds.includes(userId);
  const inWindow = (at: Date, gte: Date, lt?: Date) =>
    at.getTime() >= gte.getTime() && (lt === undefined || at.getTime() < lt.getTime());

  function truthFor(gte: Date, lt?: Date) {
    const windowRows = rows.filter((r) => inWindow(r.createdAt, gte, lt) && isCustomer(r.userId));
    return {
      events: windowRows.length,
      sessions: new Set(windowRows.map((r) => r.sessionId).filter(Boolean)).size,
      users: new Set(windowRows.map((r) => r.userId).filter(Boolean)).size,
    };
  }

  const currentTruth = truthFor(SINCE);
  const previousTruth = truthFor(PREV_SINCE, SINCE);

  // ---- (a) both windows count the WHOLE window, not a 20,000-row sample ----------------------
  const currentCounts = await countInsightsTelemetry({ gte: SINCE }, internalIds);
  check(currentCounts.events === currentTruth.events,
    `(a) current events = full-window truth (${currentCounts.events} vs ${currentTruth.events})`);
  check(currentCounts.sessions === currentTruth.sessions,
    `(a) current sessions = distinct sessionId over the whole window (${currentCounts.sessions} vs ${currentTruth.sessions})`);
  check(currentCounts.users === currentTruth.users,
    `(a) current users = distinct userId over the whole window (${currentCounts.users} vs ${currentTruth.users})`);
  const rawCurrentRows = rows.filter((r) => inWindow(r.createdAt, SINCE)).length;
  check(rawCurrentRows > 20_000,
    `(a) the current window really is bigger than the old 20,000-row cap (${rawCurrentRows} rows), so a sample could never equal its truth`);

  const previousCounts = await countInsightsTelemetry({ gte: PREV_SINCE, lt: SINCE }, internalIds);
  check(previousCounts.events === previousTruth.events,
    `(b) previous events = full-window truth (${previousCounts.events} vs ${previousTruth.events})`);
  check(previousCounts.sessions === previousTruth.sessions,
    `(b) previous sessions = full-window truth (${previousCounts.sessions} vs ${previousTruth.sessions})`);
  check(previousCounts.users === previousTruth.users,
    `(b) previous users = full-window truth (${previousCounts.users} vs ${previousTruth.users})`);

  // ---- (c) the team account is excluded, exactly as the JS filter did ------------------------
  const withTeam = await countInsightsTelemetry({ gte: SINCE }, []);
  check(withTeam.events > currentCounts.events,
    "(c) @aoacademy rows exist and are excluded from the customer counts");
  check(withTeam.users === currentCounts.users + 1,
    "(c) excluding the team removes exactly the team account from distinct users");

  // ---- (d) the PREVIOUS window is ordered too (the oldest-20k bug) ---------------------------
  const previousRead = await readInsightsTelemetryRows({ gte: PREV_SINCE, lt: SINCE });
  check(previousRead.rows.length > 0, "(d) the previous window returns rows");
  check(
    previousRead.rows.every((r) => inWindow(r.createdAt, PREV_SINCE, SINCE)),
    "(d) the previous window returns only previous-window rows",
  );
  const descending = previousRead.rows.every(
    (r, i) => i === 0 || previousRead.rows[i - 1].createdAt.getTime() >= r.createdAt.getTime(),
  );
  check(descending, "(d) the previous window is ordered newest-first, like the current one");
  const newestConsumedPrevious = rows
    .filter((r) => inWindow(r.createdAt, PREV_SINCE, SINCE) && !IGNORED_NAMES.includes(r.name))
    .reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  check(
    previousRead.rows[0]?.createdAt.getTime() === newestConsumedPrevious.createdAt.getTime(),
    "(d) the newest row of the previous window is present (the old read returned the oldest slice)",
  );

  // ---- (e) the row read carries every row a summarizer inspects, and nothing else ------------
  const currentRead = await readInsightsTelemetryRows({ gte: SINCE });
  const readNames = new Set(currentRead.rows.map((r) => r.name));
  for (const name of CONSUMED_NAMES) {
    check(readNames.has(name), `(e) the row read keeps "${name}" (a summarizer reads it)`);
  }
  for (const name of IGNORED_NAMES) {
    check(!readNames.has(name) || currentRead.rows.some((r) => r.name === name && (r.path === "/video-editor" || r.step !== null)),
      `(e) "${name}" is only shipped when an editor-session predicate still needs it`);
  }
  const consumedTruth = rows.filter(
    (r) => inWindow(r.createdAt, SINCE)
      && (!IGNORED_NAMES.includes(r.name) || r.path === "/video-editor" || r.step !== null),
  ).length;
  check(currentRead.rows.length === consumedTruth,
    `(e) every consumed row in the window is read (${currentRead.rows.length} vs ${consumedTruth})`);
  check(currentRead.truncated === false,
    "(e) 25,000 rows are far under the safety cap, so nothing is flagged as truncated");
  check(TELEMETRY_ROW_CAP > 100_000,
    `(e) the safety cap sits above a real 30-day window on prod (102,501 rows), not at 20,000 (${TELEMETRY_ROW_CAP})`);

  // ---- (f) the 24-hour view is unchanged ----------------------------------------------------
  const dayStart = new Date(NOW.getTime() - DAY_MS);
  const dayTruth = truthFor(dayStart);
  const dayCounts = await countInsightsTelemetry({ gte: dayStart }, internalIds);
  check(dayCounts.events === dayTruth.events && dayCounts.sessions === dayTruth.sessions && dayCounts.users === dayTruth.users,
    `(f) the 24-hour view still equals the same JS truth it always did (${dayCounts.events} events)`);
  const dayRead = await readInsightsTelemetryRows({ gte: dayStart });
  check(dayRead.truncated === false && dayRead.rows.length > 0,
    "(f) the 24-hour view is never truncated");

  // ---- (g) the truncation flag actually works ------------------------------------------------
  const clipped = await readInsightsTelemetryRows({ gte: SINCE }, 500);
  check(clipped.rows.length === 500 && clipped.truncated === true,
    "(g) hitting the cap sets truncated:true instead of lying silently");
  const cappedCounts = await countInsightsTelemetry({ gte: SINCE }, internalIds);
  check(cappedCounts.events === currentTruth.events,
    "(g) the window counts are cap-independent — they are counted in SQL, never from the shipped rows");

  // ---- (h) the route and the page use them ---------------------------------------------------
  const route = readFileSync("src/app/api/admin/insights/route.ts", "utf8");
  check(!/take:\s*20_?000/.test(route),
    "(h) the route no longer reads telemetry through a silent 20,000-row sample");
  check((route.match(/readInsightsTelemetryRows\(/g) ?? []).length >= 2,
    "(h) BOTH windows read their rows through the shared, ordered reader");
  check((route.match(/countInsightsTelemetry\(/g) ?? []).length >= 2,
    "(h) BOTH windows get their counts from the full-window aggregate");
  const page = readFileSync("src/app/(dashboard)/admin/insights/page.tsx", "utf8");
  check(/telemetry\.truncated/.test(page),
    "(h) the page renders a visible note when the read was truncated");

  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
