import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Task C2 (admin re-org, ADR 0062): /admin is the thin "how is today going" page — North Star
// headline + four daily trend cards + today strip + health pills, fed by ONLY
// GET /api/admin/trends. Source-level checks (team pattern — see
// scripts/verify-admin-navigation.ts) plus one fixture render of TrendCards.

const REPO_ROOT = path.resolve(__dirname, "..");
const overviewDir = "src/app/(dashboard)/admin/_components/overview";
const pagePath = "src/app/(dashboard)/admin/page.tsx";

const pageSource = readFileSync(path.join(REPO_ROOT, pagePath), "utf8");
const overviewFiles = readdirSync(path.join(REPO_ROOT, overviewDir)).filter((f) => f.endsWith(".tsx"));
assert.ok(overviewFiles.length > 0, `${overviewDir} has component files`);
const overviewSources = overviewFiles.map((f) => readFileSync(path.join(REPO_ROOT, overviewDir, f), "utf8"));
const allSources = [pageSource, ...overviewSources];
const combined = allSources.join("\n");

// ── 1. /admin fetches only GET /api/admin/trends — none of the other admin routes, no money ──
const BANNED_STRINGS = [
  "/api/admin/storage", "/api/admin/settings", "/api/admin/music", "/api/admin/cleanup",
  "/api/admin/support?", "/api/admin/stats", "MRR", "จ่ายจริง (จ่ายเงินสด)",
];
for (const needle of BANNED_STRINGS) {
  assert.ok(!combined.includes(needle), `admin/page.tsx and overview components must not contain ${JSON.stringify(needle)}`);
}
assert.ok(pageSource.includes("/api/admin/trends"), `${pagePath} must fetch /api/admin/trends`);

// ── 2. defaultTrendDays(window.innerWidth) runs inside a mount-only useEffect, never at render ──
// defaultTrendDays comes from admin-trends-shared.ts, not admin-trends.server.ts directly: that
// server module imports prisma/readDisk (fs, child_process) at the top level, so a "use client"
// component importing anything by value from it would drag those Node built-ins into the browser
// bundle. admin-trends.server.ts re-exports defaultTrendDays from the shared module unchanged.
assert.match(
  pageSource,
  /import\s*\{[^}]*defaultTrendDays[^}]*\}\s*from\s*"@\/lib\/admin-trends-shared"/,
  `${pagePath} imports defaultTrendDays from the client-safe admin-trends-shared module`,
);
assert.match(
  pageSource,
  /useState<14 \| 30>\(30\)/,
  `${pagePath} initialises the days toggle to 30, not to defaultTrendDays(...)`,
);
assert.match(
  pageSource,
  /useEffect\(\(\)\s*=>\s*\{\s*setDays\(defaultTrendDays\(window\.innerWidth\)\);[\s\S]*?\},\s*\[\]\);/,
  `${pagePath} must call defaultTrendDays(window.innerWidth) inside a mount-only useEffect`,
);
const windowMentions = (pageSource.match(/\bwindow\b/g) ?? []).length;
assert.equal(windowMentions, 1, `${pagePath} must read \`window\` exactly once — inside that effect, never during render`);

// ── 3. the chart tooltip works on tap and keyboard, not just mouse-hover <title> ──
// Fix round 1 (C2 review F1): a native SVG <title> never surfaces on tap on iOS Safari / Android
// Chrome and has no keyboard path. The tooltip must be React state driven by pointer AND focus
// events, with an aria-live region — not a <title> element.
const chartFile = overviewFiles.find((f) => f === "TrendBarChart.tsx");
assert.ok(chartFile, `${overviewDir} has TrendBarChart.tsx`);
const chartSource = overviewSources[overviewFiles.indexOf(chartFile!)];
assert.ok(!chartSource.includes("<title>"), "TrendBarChart.tsx must not rely on an SVG <title> for the tooltip (no tap, no keyboard path)");
for (const handler of ["onPointerEnter", "onPointerDown", "onFocus", "onBlur"]) {
  assert.ok(chartSource.includes(handler), `TrendBarChart.tsx's hit-rect needs a ${handler} handler so touch and keyboard both reach the tooltip`);
}
assert.match(chartSource, /tabIndex=\{0\}/, "TrendBarChart.tsx's hit-rects must be keyboard-focusable");
assert.match(chartSource, /role="button"/, "TrendBarChart.tsx's hit-rects need role=\"button\" for the keyboard/AT path");
assert.match(chartSource, /role="img"/, "TrendBarChart.tsx's <svg> keeps role=\"img\" (unaffected by the tooltip fix)");
assert.match(chartSource, /aria-live="polite"/, "TrendBarChart.tsx's tooltip element needs aria-live=\"polite\"");
assert.match(chartSource, /useState<number \| null>\(null\)/, "TrendBarChart.tsx tracks the active day in React state, not via <title>");

// ── 4. the initial trends fetch waits for the viewport (days) decision — no double-fetch race ──
// Fix round 1 (C2 review F2): two independent mount effects (one sets `days`, one fetches) could
// fire an initial ?days=30 fetch and then an immediate ?days=14 fetch on narrow viewports, with no
// guarantee the second response wins. Fetching must be gated on a `ready` flag set by the mount
// effect, and a request-id must guard a stale response from an earlier toggle click.
assert.match(pageSource, /const \[ready, setReady\] = useState\(false\);/, `${pagePath} needs a ready flag gating the first fetch`);
assert.match(
  pageSource,
  /useEffect\(\(\)\s*=>\s*\{\s*setDays\(defaultTrendDays\(window\.innerWidth\)\);\s*setReady\(true\);\s*\},\s*\[\]\);/,
  `${pagePath}'s mount effect must set ready=true after the viewport decision`,
);
assert.match(pageSource, /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(ready\)\s*load\(days\);\s*\},\s*\[ready,\s*days,\s*load\]\);/,
  `${pagePath} must only fetch once \`ready\` is true`);
assert.match(pageSource, /requestId\.current/, `${pagePath} must guard against a stale response overwriting a newer one`);

// ── 5. render TrendCards with a fixture AdminTrends: four card titles + the — fallback ──
async function checkTrendCardsFixture() {
  const { TrendCards } = await import(path.join(REPO_ROOT, overviewDir, "TrendCards.tsx"));
  const zeroDay = { signups: 0, rendersDone: 0, exportsDone: 0, failedSystem: 0, failedCustomer: 0, paidPayments: 0 };
  const series = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 14) + i * 86_400_000);
    return { date: d.toISOString().slice(0, 10), ...zeroDay };
  });
  const fixture = {
    days: 30 as const,
    timezone: "Asia/Bangkok" as const,
    series,
    // previous.signups = 0 on purpose: exercises the "—" percentage fallback (previous total 0).
    totals: {
      current: { signups: 5, rendersDone: 20, exportsDone: 15, failedSystem: 2, failedCustomer: 1, paidPayments: 3 },
      previous: { signups: 0, rendersDone: 10, exportsDone: 8, failedSystem: 1, failedCustomer: 0, paidPayments: 2 },
    },
    secondary: { serverErrorNotifications: 0, frontendErrors: 0 },
    northStar: null,
    queue: { renderQueued: 0, videoJobsQueued: 0 },
    openTickets: 0,
    diskUsedPercent: null,
  };

  const html = renderToStaticMarkup(createElement(TrendCards, { trends: fixture, days: 30, onDaysChange: () => {} }));
  assert.match(html, /สมัครใหม่\/วัน/, "TrendCards renders the สมัครใหม่/วัน card title");
  assert.match(html, /สร้างคลิป\/วัน/, "TrendCards renders the สร้างคลิป/วัน card title");
  assert.match(html, /จ่ายจริง\/วัน/, "TrendCards renders the จ่ายจริง/วัน card title");
  assert.match(html, /งานล้มเหลว\/วัน/, "TrendCards renders the งานล้มเหลว/วัน card title");
  assert.ok(html.includes("—"), "TrendCards renders the — fallback when a previous total is 0");
}

checkTrendCardsFixture()
  .then(() => {
    console.log(
      "verify-admin-overview: PASS — /admin fetches only /api/admin/trends, defaultTrendDays runs only inside " +
        "a mount effect, the chart tooltip is state-driven (tap + keyboard, not <title>), the first fetch " +
        "waits for the viewport decision, TrendCards renders its four titles and the — fallback",
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
