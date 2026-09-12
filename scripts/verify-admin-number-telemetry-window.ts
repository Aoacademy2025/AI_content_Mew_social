// Task C5b fix 4 (A4 rows #51, #52, #71, #72, #82, #86, #92 and §3.0) — what the telemetry numbers
// on /admin/insights MEAN — and Task C7 fix 1 — what they COST.
//
// Before C5b: both windows were read with `telemetryEvent.findMany({ take: 20_000 })`. On prod the
// 30-day window holds 102,501 rows, so the page showed the newest ~19.5 % of it — and the PREVIOUS
// window had no `orderBy` at all, so SQLite returned it in rowid order: the OLDEST 20,000. Every
// "ดีขึ้น/แย่ลงจากช่วงก่อน" comparison put a newest-sample next to an oldest-sample, and nothing in
// the payload or the UI said the numbers were a sample.
//
// After C5b: `sessions` / `users` / `events` are counted server-side over the WHOLE window, the row
// read is narrowed to exactly the rows a summarizer inspects and ordered newest-first on BOTH
// windows, and a `truncated` flag rides in the payload for the day the safety cap ever bites.
//
// After C7: the same rows, in the same order, cost a fraction of what they cost to fetch. `days=30`
// was 2,738 ms warm on prod after C5b, and on a prod-shaped 100,000-row fixture the dominant term is
// the Prisma query engine building one JS object per row, not SQLite and not the summarizers. The
// read is now a parameterised `$queryRaw` mapped by hand: same predicate, same columns, same order,
// same numbers — the route's own payload proves it, byte for byte.
//
// The two assertions that hold C7 to its promise:
//   (i) GOLDEN — the FULL route payload, for a fixed `now` on this fixed fixture, is byte-identical
//       to the payload RECORDED FROM GOLDEN_BASE_COMMIT and checked in beside this script. The real
//       handler is bundled from source with Clerk stubbed and answers the same three ranges. The
//       default run needs no git history (CI checks out at depth 1); re-record with
//       C7_REGENERATE_GOLDEN=1, which is the only path that reads the base commit.
//   (j) TRANSPORT — the read is held to the query builder it replaced, on the same fixture, in the
//       same process, alternating: the same rows with the same values and types, for a fraction of
//       the time. `CONSUMED_TELEMETRY_FILTER` / `INSIGHTS_TELEMETRY_SELECT` are the declared spec
//       and this is what proves the SQL still matches them — editing one without the other fails
//       here rather than silently changing a number on /admin/insights.
//
// Day boundary reference (Asia/Bangkok = UTC+7, no DST):
//   2026-09-10T16:59:00Z → Bangkok 2026-09-10 23:59 → day "2026-09-10"
//   2026-09-10T17:00:00Z → Bangkok 2026-09-11 00:00 → day "2026-09-11"
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { Prisma } from "@prisma/client";

const dir = mkdtempSync(join(tmpdir(), "admin-number-telemetry-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.NODE_ENV = "test";
// The payload is compared byte for byte, so every flag that can move a number in it is pinned to
// its default here rather than inherited from whatever shell or runner is executing the script.
delete process.env.MANAGED_GEMINI;
delete process.env.MANAGED_STOCK;
delete process.env.MANAGED_STOCK_PEXELS_PER_MONTH;
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

/** The commit the checked-in golden payloads were recorded from. */
const GOLDEN_BASE_COMMIT = "4f4a2576";
/** The files C7 changes; only the re-record path bundles them as of that commit. */
const GOLDEN_BASE_FILES = [
  "src/lib/insights-telemetry.server.ts",
  "src/app/api/admin/insights/route.ts",
] as const;
/** The recorded payloads. Checked in, because CI clones at depth 1 and has no base commit to read. */
const GOLDEN_FILE = "scripts/verify-admin-number-telemetry-window.golden.json";
/**
 * `C7_REGENERATE_GOLDEN=1` re-records from GOLDEN_BASE_COMMIT (needs full git history);
 * `C7_REGENERATE_GOLDEN=head` re-records from the working tree — only for the day the fixture
 * legitimately changes AND the base commit is unreachable (this repo squashed `main` once already),
 * and only with the payload diff read by a human before it is committed.
 */
const REGENERATE = process.env.C7_REGENERATE_GOLDEN ?? "";

/**
 * (j) — the read must cost at most this share of the query-builder read it replaced, on the same
 * rows. Before the change the two ARE the same call, so the ratio is 1.00 and this is RED. A ratio,
 * not a wall-clock literal: CI hardware is slower than a laptop and a millisecond threshold tuned on
 * one would be flaky on the other; the two reads are measured ALTERNATELY so a machine that speeds
 * up or slows down mid-run moves both of them. Absolute numbers are printed either way. Measured on
 * this fixture (Apple silicon, 100,002 rows): builder 398 ms → raw 235 ms, 0.59.
 */
const TIMING_BUDGET_RATIO = 0.8;

// Names the /admin/insights summarizers actually inspect, one per predicate family — weighted the
// way prod is, so the boundary half of the fixture does not turn a 2 %-error product into a
// 40 %-error one and flatter the row read the C7 timing assertion measures.
const CONSUMED_NAMES = [
  "editor_opened",
  "web_vital",
  "pipeline_step_done",
  "video_playback_waiting",
  "editor_script_ready",
  "web_vital",
  "pipeline_step_done",
  "video_playback_waiting",
  "editor_opened",
  "web_vital",
  "pipeline_step_done",
  "video_playback_waiting",
  "editor_script_ready",
  "web_vital",
  "pipeline_step_done",
  "video_playback_waiting",
  "fetch_stock_server_done",
  "render_server_started",
  "managed_stock_used",
  "web_vital",
  "pipeline_step_error",
  "web_vital",
  "frontend_error",
];
// Names no summarizer ever looks at. They must still count towards `events`/`sessions`/`users`
// (those are "all telemetry in the window"), but they must NOT be shipped row-by-row.
const IGNORED_NAMES = ["page_view", "nav_click", "sidebar_toggle"];

// `CONSUMED_TELEMETRY_FILTER` in JS: the rows a summarizer inspects. C7 changed how these rows are
// TRANSPORTED (a parameterised `$queryRaw` instead of the query builder), never which rows they are,
// so this predicate is also what assertion (e) holds the raw read to.
const CONSUMED_PREFIXES = [
  "editor_", "pipeline_", "fetch_stock_server_", "render_server_", "video_playback_", "managed_stock_",
];
function isConsumedRow(row: {
  name: string; category: string; status: string | null; path: string | null; step: string | null;
}) {
  const name = row.name.toLowerCase();
  return row.category === "error" || row.status === "error"
    || name.includes("error") || name.includes("fail")
    || CONSUMED_PREFIXES.some((prefix) => name.startsWith(prefix))
    || row.name === "web_vital"
    || row.path === "/video-editor"
    || row.step !== null;
}

type FixtureRow = {
  id: string; name: string; category: string; source: string;
  sessionId: string | null; userId: string | null; step: string | null; status: string | null;
  durationMs: number | null; value: number | null; path: string | null; properties: string | null;
  createdAt: Date;
};

// ── The ~75,000-row prod-shaped half of the fixture ──────────────────────────────────────────────
// Shares are the shape /admin/insights actually sees: page views and Web Vitals dominate, playback
// is the next-biggest family, errors are a small minority, and the server families (B-roll, render,
// managed stock) are one event per job. Every family carries a `properties` payload of a few
// hundred bytes, because that payload is exactly what made the 30-day read expensive.
const PIPELINE_STEPS = ["keywords", "fetchStock", "tts", "captions", "config", "render", "avatar", "composite", "burnSubtitles"];
const VITAL_METRICS = ["LCP", "INP", "CLS"];
const FAMILY_SHARES: Array<[string, number]> = [
  ["noise", 33],
  ["web_vital", 20],
  ["playback", 17],
  ["pipeline", 13],
  ["editor", 7],
  ["render_server", 3],
  ["fetch_stock", 2],
  ["managed_stock", 2],
  ["frontend_error", 2],
  ["server_error", 1],
];
const SHARE_TOTAL = FAMILY_SHARES.reduce((sum, [, share]) => sum + share, 0);

function familyFor(index: number): string {
  let n = index % SHARE_TOTAL;
  for (const [family, share] of FAMILY_SHARES) {
    if (n < share) return family;
    n -= share;
  }
  return "noise";
}

/** Pad a properties payload out to prod size (a few hundred bytes) without changing its keys. */
function props(obj: Record<string, unknown>, bytes: number) {
  const json = JSON.stringify(obj);
  if (json.length >= bytes) return json;
  return JSON.stringify({ ...obj, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140".slice(0, bytes - json.length) });
}

function realisticRow(prefix: string, i: number, createdAt: Date, teamId: string, customerPrefix: string): FixtureRow {
  const family = familyFor(i);
  const base = {
    id: `${prefix}-${i}`,
    userId: i % 19 === 0 ? teamId : i % 3 === 0 ? null : `${customerPrefix}-${i % 40}`,
    sessionId: i % 29 === 0 ? null : `sess-${prefix}-${i % 1200}`,
    createdAt,
    category: "product",
    source: "client",
    step: null as string | null,
    status: null as string | null,
    durationMs: null as number | null,
    value: null as number | null,
    path: i % 11 === 0 ? "/video-editor" : "/dashboard",
    properties: null as string | null,
  };
  // Adversarial payloads, ~1 in 500 of each kind: malformed JSON (JS falls back to {}), a metric
  // that is not a string, a whitespace-only label, an absent key, a JSON null and a negative
  // duration. Every one of them is a place where a SQL mirror of a JS predicate could disagree.
  const nasty = i % 500;
  switch (family) {
    case "web_vital":
      return { ...base, name: "web_vital", category: "performance",
        value: nasty === 1 ? null : 900 + (i % 2600),
        properties: nasty === 3 ? "{not json" : nasty === 7 ? props({ metric: 42 }, 240)
          : nasty === 11 ? props({ metric: null }, 240)
            : props({ metric: VITAL_METRICS[i % 3], id: `v3-${i}`, rating: i % 5 === 0 ? "poor" : "good", navigationType: "navigate", page: "/dashboard" }, 250) };
    case "playback": {
      const names = ["video_playback_session_started", "video_playback_session_started", "video_playback_first_frame", "video_playback_canplay", "video_playback_waiting", "video_playback_stalled"];
      const name = i % 37 === 0 ? "video_playback_error" : names[i % names.length];
      return { ...base, name, category: "performance",
        durationMs: nasty === 5 ? null : 250 + (i % 2600),
        status: name.endsWith("_error") ? "error" : null,
        properties: nasty === 13 ? "[]" : nasty === 17 ? props({ videoId: 5, sourcePath: "   ", page: "  ", startupFromLoadMs: "820" }, 260)
          : nasty === 19 ? props({ videoId: `vid-${i % 700}` }, 250)
            : props({ videoId: `vid-${i % 700}`, sourcePath: `/renders/out-${i % 700}.mp4`, page: i % 4 === 0 ? "/videos" : "/dashboard", sourceRoute: i % 3 === 0 ? "gallery" : "editor", startupFromLoadMs: 380 + (i % 2100), readyState: 4 }, 280) };
    }
    case "pipeline": {
      const name = i % 23 === 0 ? "pipeline_step_error"
        : i % 17 === 0 ? "pipeline_step_skipped"
          : i % 2 === 0 ? "pipeline_step_started" : "pipeline_step_done";
      return { ...base, name, category: "pipeline", source: i % 2 === 0 ? "server" : "client",
        step: PIPELINE_STEPS[i % PIPELINE_STEPS.length],
        durationMs: nasty === 23 ? -5 : 400 + (i % 85_000),
        status: name.endsWith("_error") ? "error" : "ok",
        // Every third event re-uses a pipelineRunId: that repeat is the duplicate the step table
        // de-dupes on, and it has to de-duplicate identically in SQL.
        properties: nasty === 29 ? "{" : nasty === 31 ? props({ pipelineRunId: 7, jobId: `job-${i % 3000}` }, 260)
          : props({ pipelineRunId: `run-${prefix}-${Math.floor(i / 3) % 3000}`, jobId: `job-${i % 3000}`, message: name.endsWith("_error") ? "Gemini API key is invalid or missing permission" : "", attempt: 1, clipCount: 6 + (i % 5) }, 270) };
    }
    case "editor":
      return { ...base, name: i % 2 === 0 ? "editor_opened" : "editor_script_ready", path: "/video-editor",
        properties: props({ source: "dashboard", scriptChars: 350 + (i % 900), ui: "v2", projectId: `proj-${i % 700}` }, 240) };
    case "render_server": {
      const name = i % 2 === 0 ? "render_server_started" : "render_server_done";
      return { ...base, name, category: "pipeline", source: "server",
        durationMs: name === "render_server_done" ? 18_000 + (i % 380_000) : null,
        properties: props({ compositionId: i % 3 === 0 ? "SubtitleOverlayComposition" : "ShortVideoComposition", freeMemGb: 1 + ((i % 70) / 10), renderConcurrency: 1 + (i % 3), renderQueueWaitMs: i % 28_000, activeRenderSlots: i % 3, durationInFrames: 900 + (i % 400) }, 280) };
    }
    case "fetch_stock": {
      const name = i % 11 === 0 ? "fetch_stock_server_error" : "fetch_stock_server_done";
      return { ...base, name, category: "pipeline", source: "server",
        durationMs: 2_800 + (i % 190_000),
        status: name.endsWith("_error") ? "error" : "ok",
        properties: JSON.stringify({
          searchPhaseMs: i % 9000, rankingPhaseMs: i % 4000, selectionPhaseMs: i % 2000, downloadPhaseMs: i % 60_000,
          normalizeMsTotal: i % 30_000, servedClipCount: 4 + (i % 8), searchQueries: 3 + (i % 6),
          cacheHitCount: i % 7, downloadedCount: i % 9, downloadFailCount: i % 3,
          selectedPexelsCount: i % 5, selectedPixabayCount: i % 4, noCandidateKeywords: i % 2,
          forcedFallbackCount: i % 2, profileFallbackUsedCount: i % 2, llmRankingUsed: i % 3 === 0,
          llmRankingFailed: i % 11 === 0, emptyResult: i % 13 === 0, normalizeRanCount: i % 6,
          normalizeSkippedCount: i % 4, normalizeFailedCount: i % 12,
          resolvedSource: ["pexels", "pixabay", "cache"][i % 3], contentProfile: ["business", "lifestyle", "tech"][i % 3],
        }) };
    }
    case "managed_stock":
      return { ...base, name: i % 9 === 0 ? "managed_stock_throttled" : "managed_stock_used", source: "server",
        properties: props({ provider: i % 2 === 0 ? "pexels" : "pixabay", cacheHit: i % 3 === 0, reason: i % 9 === 0 ? "hourly_ceiling" : "", jobId: `job-${i % 3000}`, keySource: "team" }, 250) };
    case "frontend_error":
      return { ...base, name: "frontend_error", category: "error", status: "error",
        properties: props({ message: ["Script error.", "play() request was interrupted by a call to pause()", "Failed to fetch", "Cannot read properties of undefined (reading 'map')"][i % 4], errorName: "TypeError", stack: "at t (https://studio.example/_next/static/chunks/main-app.js:1:1)" }, 300) };
    case "server_error":
      return { ...base, name: "job_failed", category: "error", source: "server", status: "error",
        step: PIPELINE_STEPS[i % PIPELINE_STEPS.length],
        properties: props({ message: ["OUTPUT_INVALID", "Gemini API key not valid", "QUOTA_AI_AUDIO exceeded", "provider 404"][i % 4], reason: "provider", jobId: `job-${i % 3000}` }, 280) };
    default: {
      const names = ["page_view", "nav_click", "sidebar_toggle", "dashboard_view", "settings_view"];
      return { ...base, name: names[i % names.length],
        properties: props({ page: "/dashboard", ref: "direct", w: 1512, h: 982, plan: "PRO" }, 230) };
    }
  }
}

// ── The route subjects (base and head), bundled from real source with Clerk stubbed ─────────────
type Subject = { GET: (req: Request) => Promise<Response> };

function materializeBaseFiles(): string {
  const baseRoot = join(dir, "base");
  for (const file of GOLDEN_BASE_FILES) {
    const target = join(baseRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync("git", ["show", `${GOLDEN_BASE_COMMIT}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  }
  return baseRoot;
}

function resolveSource(base: string) {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${base}`);
}

/**
 * Bundle the real /api/admin/insights handler into one CommonJS file. `packages: "external"` keeps
 * @prisma/client and next/server real, and `src/lib/prisma.ts` resolves its client off globalThis,
 * so base, head and this script all share one PrismaClient and one SQLite file. With `baseRoot` the
 * two files C7 touches resolve to copies checked out of GOLDEN_BASE_COMMIT instead.
 */
async function loadSubject(tag: string, baseRoot?: string): Promise<Subject> {
  const cacheDir = resolve("node_modules/.cache/verify-admin-number-telemetry-window");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, `subject-${tag}.cjs`);
  const baseFiles = new Set(GOLDEN_BASE_FILES.map((file) => resolve(file)));
  const cwd = resolve(".");
  await build({
    stdin: {
      contents: `export { GET } from "@/app/api/admin/insights/route";`,
      resolveDir: process.cwd(),
      sourcefile: "verify-admin-number-telemetry-window-entry.ts",
      loader: "ts",
    },
    bundle: true,
    outfile,
    platform: "node",
    format: "cjs",
    packages: "external",
    logLevel: "error",
    plugins: [{
      name: "insights-subject",
      setup(builder) {
        builder.onResolve({ filter: /^@\// }, ({ path: specifier }) => {
          const real = resolveSource(resolve("src", specifier.slice(2)));
          if (baseRoot && baseFiles.has(real)) return { path: join(baseRoot, real.slice(cwd.length + 1)) };
          return { path: real };
        });
        // A base copy lives outside the source tree, so its own relative imports ("./prisma") have
        // to be pulled back into it — only the two files above are frozen at the base commit.
        builder.onResolve({ filter: /^\.\.?\// }, ({ path: specifier, importer }) => {
          if (!baseRoot || !importer.startsWith(baseRoot)) return null;
          const inBase = resolve(dirname(importer), specifier);
          return { path: resolveSource(join(cwd, inBase.slice(baseRoot.length + 1))) };
        });
        // Clerk and the request-scoped Next helpers are the ONLY stubs.
        builder.onResolve(
          { filter: /^(server-only|next\/headers|@clerk\/nextjs\/server)$/ },
          ({ path: specifier }) => ({ path: specifier, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path: specifier }) => {
          if (specifier === "server-only") return { contents: "export {};" };
          if (specifier === "next/headers") {
            return { contents: "export const cookies = async () => ({ get: () => undefined }); export const headers = async () => new Headers();" };
          }
          return {
            contents: "export const auth = async () => ({ userId: globalThis.__insightsVerifyClerkId });"
              + "export const currentUser = async () => null;",
          };
        });
      },
    }],
  });
  return createRequire(resolve("package.json"))(outfile) as Subject;
}

/** Freeze `new Date()` / `Date.now()` for the duration of one request, so payloads are comparable. */
async function withFixedNow<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  const Real = globalThis.Date;
  class Frozen extends Real {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) super(at.getTime());
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static now() { return at.getTime(); }
  }
  (globalThis as { Date: DateConstructor }).Date = Frozen as unknown as DateConstructor;
  try { return await fn(); }
  finally { (globalThis as { Date: DateConstructor }).Date = Real; }
}

async function payload(subject: Subject, days: number) {
  return withFixedNow(NOW, async () => {
    const res = await subject.GET(new Request(`http://local/api/admin/insights?days=${days}`));
    if (res.status !== 200) throw new Error(`GET days=${days} → ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.text();
  });
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    readInsightsTelemetryRows,
    countInsightsTelemetry,
    CONSUMED_TELEMETRY_FILTER,
    INSIGHTS_TELEMETRY_SELECT,
    TELEMETRY_ROW_CAP,
  } = await import("../src/lib/insights-telemetry.server");

  const TEAM = "user-team";      // @aoacademy — excluded from every customer KPI
  const CUSTOMER = "user-cust";  // a real customer

  await prisma.user.createMany({
    data: [
      { id: TEAM, name: "Team", email: "team@aoacademy.co", role: "ADMIN", clerkId: "clerk-team" },
      { id: CUSTOMER, name: "Cust", email: "cust@example.com" },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `${CUSTOMER}-${i}`, name: `C${i}`, email: `c${i}@example.com` })),
    ],
  });

  // ---- 25,000 rows straddling the current/previous boundary ----------------------------------
  // Spread evenly so the newest rows of the PREVIOUS window sit far from its oldest rows: the old
  // unordered `take: 20_000` returned the oldest slice, and that is what this fixture detects.
  const rows: FixtureRow[] = [];
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
      status: null,
      durationMs: name.startsWith("pipeline_step_") ? 1_000 + (index % 40_000) : null,
      value: name === "web_vital" ? 1_000 + (index % 1_500) : null,
      path: index % 13 === 0 ? "/video-editor" : "/dashboard",
      properties: name === "web_vital" ? JSON.stringify({ metric: VITAL_METRICS[index % 3] }) : null,
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
  const boundaryRow = (id: string, createdAt: Date, sessionId: string): FixtureRow => ({
    id, name: "editor_opened", category: "product", source: "client",
    sessionId, userId: CUSTOMER, step: null, status: null, durationMs: null, value: null,
    path: "/video-editor", properties: null, createdAt,
  });
  rows.push(boundaryRow("boundary-late-10", LATE_DAY_10, "sess-boundary-a"));
  rows.push(boundaryRow("boundary-early-11", EARLY_DAY_11, "sess-boundary-b"));

  const PLANTED_ROWS = rows.length;

  // ---- ~75,000 more rows, prod-shaped, spanning the whole 60-day two-window span --------------
  // This is the volume half of the fixture: 100,000 rows is the order of a real 30-day window on
  // prod (102,501 measured 2026-09-12), and the C7 timing assertion (j) is measured on it.
  const REALISTIC_ROWS = 75_000;
  const REALISTIC_SPAN = 60 * DAY_MS;
  const realisticStart = NOW.getTime() - REALISTIC_SPAN;
  for (let i = 0; i < REALISTIC_ROWS; i++) {
    rows.push(realisticRow("bulk", i, new Date(realisticStart + Math.floor((REALISTIC_SPAN * i) / REALISTIC_ROWS)), TEAM, CUSTOMER));
  }

  for (let i = 0; i < rows.length; i += 2_000) {
    await prisma.telemetryEvent.createMany({ data: rows.slice(i, i + 2_000) });
  }
  check(PLANTED_ROWS === 25_002, `fixture plants 25,002 boundary telemetry rows (${PLANTED_ROWS})`);
  check(rows.length >= 100_000, `fixture plants a prod-sized window in total (${rows.length} rows)`);

  // Enough of the rest of the schema that the route's non-telemetry half is not measuring an empty
  // database: creation jobs, videos, renders and payments in both windows.
  await prisma.videoJob.createMany({
    data: Array.from({ length: 400 }, (_, i) => ({
      id: `job-${i}`, userId: `${CUSTOMER}-${i % 40}`, type: i % 20 === 0 ? "export" : "create",
      status: ["done", "failed", "processing", "queued", "canceled"][i % 5],
      progress: (i % 5) * 25, inputJson: "{}", createdAt: new Date(NOW.getTime() - (i % 59) * DAY_MS),
      outputJson: i % 3 === 0 ? JSON.stringify({ videoUrl: `/renders/${i}.mp4` }) : null,
      errorMessage: i % 5 === 1 ? "Gemini API key not valid" : null,
    })),
  });
  await prisma.video.createMany({
    data: Array.from({ length: 300 }, (_, i) => ({
      id: `vid-${i}`, userId: `${CUSTOMER}-${i % 40}`, avatarModel: "none", voiceModel: "gemini",
      sceneCount: 5, script: "s", status: i % 9 === 0 ? "PROCESSING" : "COMPLETED",
      videoUrl: i % 4 === 0 ? `/renders/${i}.mp4` : null,
      createdAt: new Date(NOW.getTime() - (i % 59) * DAY_MS),
    })),
  });
  await prisma.renderJob.createMany({
    data: Array.from({ length: 300 }, (_, i) => ({
      id: `rj-${i}`, userId: `${CUSTOMER}-${i % 40}`, type: i % 4 === 0 ? "BURN" : "RENDER",
      status: ["DONE", "FAILED", "QUEUED", "RUNNING"][i % 4], payload: "{}",
      createdAt: new Date(NOW.getTime() - (i % 59) * DAY_MS),
      startedAt: new Date(NOW.getTime() - (i % 59) * DAY_MS),
      finishedAt: new Date(NOW.getTime() - (i % 59) * DAY_MS + 60_000),
    })),
  });
  await prisma.payment.createMany({
    data: Array.from({ length: 80 }, (_, i) => ({
      id: `pay-${i}`, userId: `${CUSTOMER}-${i % 40}`, stripeSessionId: `stripe-${i}`, plan: "PRO",
      amount: i % 4 === 0 ? 0 : 59_900, status: "PAID", periodDays: i % 3 === 0 ? 365 : 30,
      createdAt: new Date(NOW.getTime() - (i % 59) * DAY_MS),
      paidAt: new Date(NOW.getTime() - (i % 59) * DAY_MS),
    })),
  });

  // `@updatedAt` is stamped by Prisma from the real clock at insert time, and the reconcile plan
  // puts `Video.updatedAt` in the payload — so without this the payload could never be recorded
  // once and compared later. Pinned with raw UPDATEs, the same way verify-admin-trends.ts does it.
  await prisma.$executeRaw(Prisma.sql`UPDATE "Video" SET "updatedAt" = ${new Date(NOW.getTime() - DAY_MS)}`);
  await prisma.$executeRaw(Prisma.sql`UPDATE "VideoJob" SET "updatedAt" = ${new Date(NOW.getTime() - DAY_MS)}`);

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
    .filter((r) => inWindow(r.createdAt, PREV_SINCE, SINCE) && isConsumedRow(r))
    .reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  check(
    previousRead.rows[0]?.createdAt.getTime() === newestConsumedPrevious.createdAt.getTime(),
    "(d) the newest row of the previous window is present (the old read returned the oldest slice)",
  );

  // ---- (e) the row read carries every row a summarizer inspects, and nothing else, and it is
  //          TYPED the way the query builder typed it — a bigint or an epoch number reaching a
  //          summarizer would poison every percentile it touches (C7's raw read) ----------------
  const currentRead = await readInsightsTelemetryRows({ gte: SINCE });
  const readNames = new Set(currentRead.rows.map((r) => r.name));
  for (const name of CONSUMED_NAMES) {
    check(readNames.has(name), `(e) the row read keeps "${name}" (a summarizer reads it)`);
  }
  for (const name of IGNORED_NAMES) {
    check(!readNames.has(name) || currentRead.rows.some((r) => r.name === name && (r.path === "/video-editor" || r.step !== null)),
      `(e) "${name}" is only shipped when an editor-session predicate still needs it`);
  }
  const consumedTruth = rows.filter((r) => inWindow(r.createdAt, SINCE) && isConsumedRow(r)).length;
  check(currentRead.rows.length === consumedTruth,
    `(e) every consumed row in the window is read (${currentRead.rows.length} vs ${consumedTruth})`);
  check(currentRead.truncated === false,
    "(e) the fixture is far under the safety cap, so nothing is flagged as truncated");
  check(TELEMETRY_ROW_CAP > 100_000,
    `(e) the safety cap sits above a real 30-day window on prod (102,501 rows), not at 20,000 (${TELEMETRY_ROW_CAP})`);
  const typed = currentRead.rows.find((r) => r.durationMs !== null && r.value === null) ?? currentRead.rows[0];
  check(typed.createdAt instanceof Date && !Number.isNaN(typed.createdAt.getTime()),
    "(e) createdAt arrives as a Date, not the epoch integer SQLite stores");
  check(currentRead.rows.every((r) => (r.durationMs === null || typeof r.durationMs === "number")
    && (r.value === null || typeof r.value === "number")),
    "(e) durationMs and value arrive as numbers, never as bigint");
  check(currentRead.rows.every((r) => (r.sessionId === null || typeof r.sessionId === "string")
    && typeof r.name === "string" && (r.properties === null || typeof r.properties === "string")),
    "(e) the text columns arrive as string or null, exactly as the query builder returned them");

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
  const reader = readFileSync("src/lib/insights-telemetry.server.ts", "utf8");
  check(/\$queryRaw</.test(reader) && !/prisma\.telemetryEvent\.findMany/.test(reader),
    "(h) the window read is a parameterised raw query, not the query builder that cost 6.3 µs a row");
  check(/Prisma\.sql`/.test(reader) && !/queryRawUnsafe/.test(reader),
    "(h) every raw statement is a tagged template — no string-built SQL");
  check((route.match(/countInsightsTelemetry\(/g) ?? []).length >= 2,
    "(h) BOTH windows get their counts from the full-window aggregate");
  const page = readFileSync("src/app/(dashboard)/admin/insights/page.tsx", "utf8");
  check(/telemetry\.truncated/.test(page),
    "(h) the page renders a visible note when the read was truncated");

  // ---- (i) GOLDEN: the whole payload is byte-identical to the recorded base payload ------------
  // Recorded ONCE from GOLDEN_BASE_COMMIT and checked in, because CI clones at depth 1: a script
  // that reads `git show <sha>` on every run fails with `fatal: invalid object name` there, which is
  // how this assertion first shipped. Only the re-record path touches git.
  (globalThis as { __insightsVerifyClerkId?: string }).__insightsVerifyClerkId = "clerk-team";
  const head = await loadSubject("head");
  const ranges = [1, 7, 30];

  if (REGENERATE) {
    const from = REGENERATE === "head" ? "head" : "base";
    const subject = from === "head" ? head : await loadSubject("base", materializeBaseFiles());
    const payloads: Record<string, string> = {};
    for (const days of ranges) payloads[String(days)] = await payload(subject, days);
    writeFileSync(GOLDEN_FILE, `${JSON.stringify({
      README: "Golden /api/admin/insights payloads for scripts/verify-admin-number-telemetry-window.ts."
        + " Recorded from the code at baseCommit against the fixture that script builds, with `now` frozen."
        + " Re-record with C7_REGENERATE_GOLDEN=1 (from baseCommit, needs full git history) or"
        + " C7_REGENERATE_GOLDEN=head (from the working tree — only when the fixture legitimately"
        + " changed and baseCommit is unreachable; read the payload diff before committing it).",
      baseCommit: GOLDEN_BASE_COMMIT,
      recordedFrom: from,
      fixtureRows: rows.length,
      frozenNow: NOW.toISOString(),
      payloads,
    }, null, 2)}\n`);
    console.log(`\n*** re-recorded ${GOLDEN_FILE} from ${from} (${ranges.map((d) => `days=${d}: ${payloads[String(d)].length} bytes`).join(", ")}) ***\n`);
  }

  if (!existsSync(GOLDEN_FILE)) {
    check(false, `(i) ${GOLDEN_FILE} is missing — re-record it with C7_REGENERATE_GOLDEN=1`);
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as {
      baseCommit: string; recordedFrom: string; fixtureRows: number; frozenNow: string;
      payloads: Record<string, string>;
    };
    check(golden.fixtureRows === rows.length && golden.frozenNow === NOW.toISOString(),
      `(i) the golden was recorded against THIS fixture (${golden.fixtureRows} rows at ${golden.frozenNow})`);
    for (const days of ranges) {
      const expected = golden.payloads[String(days)] ?? "";
      const actual = await payload(head, days);
      check(actual === expected,
        `(i) days=${days}: the payload is byte-identical to ${golden.baseCommit} (${actual.length} bytes)`);
      if (actual !== expected) {
        const at = [...expected].findIndex((ch, idx) => ch !== actual[idx]);
        console.error(`     first difference at byte ${at}:\n     golden: ${expected.slice(Math.max(0, at - 160), at + 160)}\n     head:   ${actual.slice(Math.max(0, at - 160), at + 160)}`);
      }
    }
    // The golden is only worth something if the payload really carries the numbers in question.
    const sample = JSON.parse(await payload(head, 30)) as {
      current: { totals: Record<string, unknown>; steps: unknown[]; vitals: unknown[]; playback: Record<string, unknown> };
    };
    check(Number(sample.current.totals.editorOpens) > 0 && sample.current.steps.length > 0
      && sample.current.vitals.length === 3 && Number(sample.current.playback.sessions) > 0,
      "(i) the compared payload actually contains editor, step, vitals and playback numbers");
  }

  // ---- (j) TRANSPORT: the raw read is the query builder's read, for less ----------------------
  // `CONSUMED_TELEMETRY_FILTER` and `INSIGHTS_TELEMETRY_SELECT` are the declared spec of what
  // /admin/insights reads from a telemetry row. Since C7 the read is raw SQL, so this is what keeps
  // the two in step: the same window, through the query builder and through the shipped reader, must
  // return the same rows with the same values and the same types — and the shipped one must be
  // materially cheaper. Edit one without the other and this fails instead of a number moving.
  const builderRead = (range: { gte: Date; lt?: Date }) =>
    prisma.telemetryEvent.findMany({
      where: {
        createdAt: range.lt ? { gte: range.gte, lt: range.lt } : { gte: range.gte },
        ...CONSUMED_TELEMETRY_FILTER,
      },
      select: INSIGHTS_TELEMETRY_SELECT,
      orderBy: { createdAt: "desc" },
      take: TELEMETRY_ROW_CAP,
    });

  for (const [label, range] of [
    ["current", { gte: SINCE }],
    ["previous", { gte: PREV_SINCE, lt: SINCE }],
  ] as const) {
    const builderRows = await builderRead(range);
    const rawRows = (await readInsightsTelemetryRows(range)).rows;
    check(builderRows.length === rawRows.length,
      `(j) ${label}: the raw read returns the query builder's row count (${rawRows.length} vs ${builderRows.length})`);
    const fields = Object.keys(INSIGHTS_TELEMETRY_SELECT) as Array<keyof typeof INSIGHTS_TELEMETRY_SELECT>;
    let firstDiff = -1;
    for (let i = 0; i < Math.min(builderRows.length, rawRows.length) && firstDiff < 0; i += 1) {
      for (const field of fields) {
        const a = builderRows[i][field];
        const b = rawRows[i][field];
        const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
        if (!same) { firstDiff = i; console.error(`     row ${i} field ${String(field)}: builder ${String(a)} vs raw ${String(b)}`); break; }
      }
    }
    check(firstDiff === -1,
      `(j) ${label}: every field of every row is identical, in order and in type`);
  }

  const builderRuns: number[] = [];
  const rawRuns: number[] = [];
  const bothWindows = async (read: (range: { gte: Date; lt?: Date }) => Promise<unknown>) => {
    await read({ gte: SINCE });
    await read({ gte: PREV_SINCE, lt: SINCE });
  };
  await bothWindows(builderRead);                                   // warm both paths
  await bothWindows(readInsightsTelemetryRows);
  for (let i = 0; i < 5; i++) {
    let started = Date.now();
    await bothWindows(builderRead);
    builderRuns.push(Date.now() - started);
    started = Date.now();
    await bothWindows(readInsightsTelemetryRows);
    rawRuns.push(Date.now() - started);
  }
  const median = (runs: number[]) => [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const builderMs = median(builderRuns);
  const rawMs = median(rawRuns);
  const ratio = rawMs / builderMs;
  console.log(`\n(j) both windows of ${rows.length} rows: query builder ${builderMs} ms [${builderRuns.join(",")}] → raw read ${rawMs} ms [${rawRuns.join(",")}] (ratio ${ratio.toFixed(2)})`);
  check(ratio <= TIMING_BUDGET_RATIO,
    `(j) the read costs at most ${TIMING_BUDGET_RATIO} of the query-builder read it replaced (ratio ${ratio.toFixed(2)}: ${rawMs} ms vs ${builderMs} ms)`);

  // Whole-route wall time, for the record only — a millisecond assertion on a shared CI runner
  // would be a flake, and what this change actually moves is measured above.
  for (const days of ranges) {
    const started = Date.now();
    await payload(head, days);
    console.log(`    route days=${days}: ${Date.now() - started} ms`);
  }

  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
