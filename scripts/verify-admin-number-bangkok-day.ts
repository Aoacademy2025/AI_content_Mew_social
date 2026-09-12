// "Today" and every daily label on the admin surfaces mean an Asia/Bangkok calendar day.
//
// Audit A4 (2026-09-12), rows #8 / #9: the VPS runs with `TZ` unset (= Etc/UTC), so
// `/api/admin/stats` computed `newToday` from `new Date().setHours(0,0,0,0)` — a day that starts
// at 07:00 Bangkok. At 04:34 Bangkok the card showed 9 signups that had all happened the previous
// Bangkok day; Bangkok-today was 0. `newThisWeek` compounded that with a window of EIGHT calendar
// days (`now − 7d`, then floored) behind a label that says 7. `/api/admin/costs` labelled its
// daily trend with `toISOString().slice(0,10)` — UTC dates on a Thai dashboard.
//
// Fixtures are the exact boundary the audit names: 2026-09-10T16:59:00Z is 23:59 Bangkok on
// 09-10, and 2026-09-10T17:00:00Z is 00:00 Bangkok on 09-11. They must never share a day.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-admin-number-bangkok-day.ts
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-number-bangkok-day-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`ok: ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const DAY_MS = 86_400_000;
const LAST_MINUTE_OF_0910 = new Date("2026-09-10T16:59:00.000Z"); // 2026-09-10 23:59 Bangkok
const FIRST_MINUTE_OF_0911 = new Date("2026-09-10T17:00:00.000Z"); // 2026-09-11 00:00 Bangkok
// 04:34 Bangkok on 2026-09-12 — the hour the audit was taken, inside the 00:00–07:00 window
// where a UTC-based "today" is still reporting yesterday.
const NOW = new Date("2026-09-11T21:34:00.000Z");

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { bangkokDate, startOfBangkokDay, bangkokWindowStart } =
    await import("../src/lib/bangkok-day");

  // ── A. The boundary itself ──────────────────────────────────────────────────
  check(
    bangkokDate(LAST_MINUTE_OF_0910) === "2026-09-10",
    "A1: 16:59Z is still 2026-09-10 in Bangkok",
    bangkokDate(LAST_MINUTE_OF_0910),
  );
  check(
    bangkokDate(FIRST_MINUTE_OF_0911) === "2026-09-11",
    "A2: one minute later, 17:00Z, is already 2026-09-11 in Bangkok",
    bangkokDate(FIRST_MINUTE_OF_0911),
  );
  check(
    bangkokDate(LAST_MINUTE_OF_0910) !== bangkokDate(FIRST_MINUTE_OF_0911),
    "A3: the two instants never share a Bangkok day",
  );
  check(
    startOfBangkokDay(NOW).toISOString() === "2026-09-11T17:00:00.000Z",
    "A4: Bangkok 'today' at 04:34 began at 17:00Z the previous UTC day",
    startOfBangkokDay(NOW).toISOString(),
  );
  check(
    bangkokDate(startOfBangkokDay(NOW)) === bangkokDate(NOW),
    "A5: the day start belongs to the same Bangkok day it starts",
  );
  check(
    startOfBangkokDay(new Date(startOfBangkokDay(NOW).getTime() - 1)).getTime()
      === startOfBangkokDay(NOW).getTime() - DAY_MS,
    "A6: one millisecond before midnight is the previous Bangkok day",
  );
  check(
    bangkokWindowStart(NOW, 7).getTime() === startOfBangkokDay(NOW).getTime() - 6 * DAY_MS,
    "A7: a 7-day window is today plus the six days before it, not eight calendar days",
    bangkokWindowStart(NOW, 7).toISOString(),
  );

  // ── B. The same boundary through a real query ───────────────────────────────
  // One signup per Bangkok day for the last nine days, each at 00:00 Bangkok, plus the two
  // instants that straddle the 09-10/09-11 midnight.
  const todayStart = startOfBangkokDay(NOW);
  const seeded: Array<{ id: string; at: Date }> = [
    { id: "straddle-before", at: LAST_MINUTE_OF_0910 },
    { id: "straddle-after", at: FIRST_MINUTE_OF_0911 },
  ];
  for (let back = 0; back < 9; back++) {
    seeded.push({ id: `day-minus-${back}`, at: new Date(todayStart.getTime() - back * DAY_MS) });
  }
  // The last millisecond of the eighth day back — outside a true 7-day window, inside the old one.
  seeded.push({ id: "just-outside-week", at: new Date(todayStart.getTime() - 6 * DAY_MS - 1) });
  await prisma.user.createMany({
    data: seeded.map((s) => ({
      id: s.id, name: s.id, email: `${s.id}@example.test`, createdAt: s.at,
    })),
  });

  const newToday = await prisma.user.count({ where: { createdAt: { gte: todayStart } } });
  check(
    newToday === 1,
    "B1: 'สมัครใช้งานวันนี้' counts only the Bangkok day in progress",
    `newToday=${newToday} (expected 1: day-minus-0)`,
  );

  const weekStart = bangkokWindowStart(NOW, 7);
  const weekRows = await prisma.user.findMany({
    where: { createdAt: { gte: weekStart } },
    select: { id: true, createdAt: true },
  });
  const weekDays = new Set(weekRows.map((row) => bangkokDate(row.createdAt)));
  check(
    weekDays.size === 7,
    "B2: the 7-day card spans exactly 7 Bangkok days",
    `days=${weekDays.size} (${[...weekDays].sort().join(", ")})`,
  );
  check(
    !weekRows.some((row) => row.id === "day-minus-7" || row.id === "day-minus-8"),
    "B3: the eighth and ninth Bangkok days back are outside a window labelled 7 days",
    weekRows.map((row) => row.id).sort().join(" "),
  );
  const justOutside = await prisma.user.findFirst({
    where: { id: "just-outside-week", createdAt: { gte: weekStart } },
  });
  check(justOutside === null, "B3b: the last millisecond before the window opens is excluded");
  // The bound the route used to compute — `now − 7 days`, then floored to midnight — reaches
  // back over EIGHT Bangkok days behind a label that says 7 (audit A4 row #9).
  const eightDayRows = await prisma.user.findMany({
    where: { createdAt: { gte: startOfBangkokDay(new Date(NOW.getTime() - 7 * DAY_MS)) } },
    select: { createdAt: true },
  });
  check(
    new Set(eightDayRows.map((row) => bangkokDate(row.createdAt))).size === 8,
    "B3c: regression guard — the old `now − 7d` bound really did span eight Bangkok days",
    `days=${new Set(eightDayRows.map((row) => bangkokDate(row.createdAt))).size}`,
  );

  const straddlers = await prisma.user.findMany({
    where: { id: { in: ["straddle-before", "straddle-after"] } },
    select: { id: true, createdAt: true },
  });
  const labels = new Map(straddlers.map((u) => [u.id, bangkokDate(u.createdAt)]));
  check(
    labels.get("straddle-before") === "2026-09-10" && labels.get("straddle-after") === "2026-09-11",
    "B4: rows one minute apart across Bangkok midnight land on different daily labels",
    `${labels.get("straddle-before")} / ${labels.get("straddle-after")}`,
  );

  // ── C. The surfaces actually use it ─────────────────────────────────────────
  const stats = readFileSync("src/app/api/admin/stats/route.ts", "utf8");
  const costs = readFileSync("src/app/api/admin/costs/route.ts", "utf8");
  check(
    /from "@\/lib\/bangkok-day"/.test(stats) && /startOfBangkokDay\(/.test(stats),
    "C1: /api/admin/stats starts its day at Bangkok midnight",
  );
  check(
    /bangkokWindowStart\(\s*now\s*,\s*7\s*\)/.test(stats),
    "C2: …and takes a true seven-Bangkok-day week",
  );
  check(
    !/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(stats),
    "C3: …with no server-timezone midnight left in the route",
  );
  check(
    /from "@\/lib\/bangkok-day"/.test(costs) && /return bangkokDate\(/.test(costs),
    "C4: /api/admin/costs labels its daily trend with Bangkok dates",
  );
  check(
    !/toISOString\(\)\.slice\(0,\s*10\)/.test(costs),
    "C5: …with no UTC date label left in the route",
  );

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} ok, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
