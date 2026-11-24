/**
 * verify-broll-swap-managed-stock — regression suite for HERO-120:
 *   1. `POST /api/videos/broll-window/search` routes stock credentials through
 *      `resolveManagedStockAccess` (ADR 0025):
 *        - no-key accounts search via managed team keys, Pixabay-first (< 3 falls back to Pexels),
 *        - 24h StockSearchCache is honored (0 provider calls, 0 budget/usage spent),
 *        - per-user hourly cap, global provider token buckets, and monthly Pexels ceiling
 *          are enforced cleanly with fail-closed 429 Thai responses and telemetry,
 *        - BYOK always wins when the user has personal Pexels/Pixabay keys,
 *        - fail-closed 400 `missing_key` when `MANAGED_STOCK` is off (or no team keys),
 *          and 403 `account_suspended` when suspended — never falling back to paid AI.
 *   2. `POST /api/videos/broll-window/select` succeeds WITHOUT personal stock keys
 *      (even when `MANAGED_STOCK` is off) while preserving auth, rate-limit, and
 *      URL allow-list / SSRF protections.
 *   3. Client UI (`BrollWindowInspector.tsx`) has no personal-key gate on "เปลี่ยนสต็อก"
 *      and renders customer-friendly Thai copy + Settings link on disabled/throttled errors.
 *
 * Self-contained against a throwaway SQLite DB — ZERO network calls to Pexels/Pixabay.
 * Run:
 *   node --conditions=react-server --experimental-test-module-mocks --import tsx scripts/verify-broll-swap-managed-stock.ts
 */

import * as childProcess from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import type { PexelsVideo, PixabayVideo } from "../src/lib/broll-asset-lib";

const tempDir = fs.mkdtempSync(path.join(tmpdir(), "broll-swap-managed-stock-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
process.env.KEY_ENC_SECRET = "test-only-key-enc-secret-hero-120";
process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT = "1";
process.env.MANAGED_STOCK = "1";
process.env.MANAGED_PEXELS_API_KEY = "managed-pexels-dummy-key";
process.env.MANAGED_PIXABAY_API_KEY = "managed-pixabay-dummy-key";
process.env.MANAGED_STOCK_PEXELS_PER_MONTH = "2";
process.env.MANAGED_STOCK_PEXELS_PER_HOUR = "50";
process.env.MANAGED_STOCK_PIXABAY_PER_MIN = "50";
process.env.MANAGED_STOCK_USER_SEARCHES_PER_HOUR = "30";

childProcess.execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function section(name: string, fn: () => Promise<void>) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

type MockUser = {
  id: string;
  email: string;
  role: string;
  plan: string;
  suspended: boolean;
  pexelsKey: string | null;
  pixabayKey: string | null;
};

function makePixabayVideos(count: number, prefix = "pb"): PixabayVideo[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: 1000 + idx,
    duration: 8,
    videoUrl: `https://cdn.pixabay.com/video/${prefix}-${idx}.mp4`,
    width: 1080,
    height: 1920,
    tags: `${prefix} vertical clip ${idx}`,
    thumb: `https://cdn.pixabay.com/thumb/${prefix}-${idx}.jpg`,
  }));
}

function makePexelsVideos(count: number, prefix = "px"): PexelsVideo[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: 2000 + idx,
    duration: 7,
    width: 1080,
    height: 1920,
    url: `https://www.pexels.com/video/${prefix}-scene-${idx}-200${idx}/`,
    image: `https://images.pexels.com/videos/${prefix}-${idx}.jpeg`,
    video_files: [
      {
        quality: "hd",
        file_type: "video/mp4",
        width: 1080,
        height: 1920,
        link: `https://videos.pexels.com/video-files/${prefix}-${idx}.mp4`,
      },
    ],
  }));
}

function searchRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/videos/broll-window/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function selectRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/videos/broll-window/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { encryptKey } = await import("../src/lib/key-crypto");
  const {
    __resetManagedStockBucketsForTests,
    __resetManagedStockMonthlyCacheForTests,
    readManagedStockMonthlyStatus,
  } = await import("../src/lib/managed-stock.server");
  const { isAllowedStockUrl } = await import("../src/lib/broll-window-search");

  let activeUser: MockUser | null = null;
  const pixabayCalls: Array<{ query: string; apiKey: string; minDuration: number; perPage: number }> = [];
  const pexelsCalls: Array<{ query: string; apiKey: string; minDuration: number; perPage: number }> = [];
  const downloadCalls: Array<{ url: string; outPath: string }> = [];
  const downloadedPaths = new Set<string>();

  let pixabayResponder: (query: string, apiKey: string) => Promise<PixabayVideo[]> = async () => makePixabayVideos(4);
  let pexelsResponder: (query: string, apiKey: string) => Promise<PexelsVideo[]> = async () => makePexelsVideos(3);

  const authMock = mock.module("@/lib/clerk-auth", {
    namedExports: {
      getCurrentUser: async () => activeUser,
    },
  });

  const assetMock = mock.module("@/lib/broll-asset-lib", {
    namedExports: {
      searchPixabay: async (query: string, apiKey: string, minDuration = 5, perPage = 15) => {
        pixabayCalls.push({ query, apiKey, minDuration, perPage });
        return pixabayResponder(query, apiKey);
      },
      searchPexels: async (query: string, apiKey: string, minDuration = 3, perPage = 15) => {
        pexelsCalls.push({ query, apiKey, minDuration, perPage });
        return pexelsResponder(query, apiKey);
      },
      downloadAndCrop: async (url: string, outPath: string) => {
        downloadCalls.push({ url, outPath });
        downloadedPaths.add(outPath);
      },
      isValidMp4Path: (filePath: string) => downloadedPaths.has(filePath),
      normalizeForRemotion: async () => ({ status: "normalized" as const, durationMs: 12 }),
      normalizedMarkerPath: (filePath: string) => `${filePath}.normalized`,
      safeUnlink: (filePath: string) => {
        downloadedPaths.delete(filePath);
      },
    },
  });

  const childProcessMock = mock.module("child_process", {
    namedExports: {
      ...childProcess,
      execFileSync: () => "6.5\n",
    },
  });

  const stocksDir = path.join(process.cwd(), "stocks");
  const stocksExistedBefore = fs.existsSync(stocksDir);

  try {
    const { POST: searchPOST } = await import("../src/app/api/videos/broll-window/search/route");
    const { POST: selectPOST } = await import("../src/app/api/videos/broll-window/select/route");

    const keylessUserA: MockUser = {
      id: "u-hero120-keyless-a",
      email: "keyless-a@example.com",
      role: "USER",
      plan: "PRO",
      suspended: false,
      pexelsKey: null,
      pixabayKey: null,
    };
    const keylessUserB: MockUser = {
      id: "u-hero120-keyless-b",
      email: "keyless-b@example.com",
      role: "USER",
      plan: "FREE",
      suspended: false,
      pexelsKey: null,
      pixabayKey: null,
    };
    const byokPexelsUser: MockUser = {
      id: "u-hero120-byok-pexels",
      email: "byok-px@example.com",
      role: "USER",
      plan: "BUSINESS",
      suspended: false,
      pexelsKey: encryptKey("user-own-pexels-key-123"),
      pixabayKey: null,
    };
    const byokPixabayUser: MockUser = {
      id: "u-hero120-byok-pixabay",
      email: "byok-pb@example.com",
      role: "USER",
      plan: "PRO",
      suspended: false,
      pexelsKey: null,
      pixabayKey: encryptKey("user-own-pixabay-key-456"),
    };
    const suspendedKeylessUser: MockUser = {
      id: "u-hero120-suspended",
      email: "suspended@example.com",
      role: "USER",
      plan: "PRO",
      suspended: true,
      pexelsKey: null,
      pixabayKey: null,
    };

    // Create DB users so telemetry foreign keys succeed cleanly.
    for (const u of [keylessUserA, keylessUserB, byokPexelsUser, byokPixabayUser, suspendedKeylessUser]) {
      await prisma.user.create({
        data: { id: u.id, email: u.email, name: u.id, plan: u.plan, role: u.role, suspended: u.suspended },
      });
    }

    const resetState = async () => {
      pixabayCalls.length = 0;
      pexelsCalls.length = 0;
      downloadCalls.length = 0;
      await prisma.stockSearchCache.deleteMany({});
      await prisma.managedStockUsage.deleteMany({});
      await prisma.telemetryEvent.deleteMany({});
      __resetManagedStockMonthlyCacheForTests();
      __resetManagedStockBucketsForTests();
      process.env.MANAGED_STOCK = "1";
      process.env.MANAGED_PEXELS_API_KEY = "managed-pexels-dummy-key";
      process.env.MANAGED_PIXABAY_API_KEY = "managed-pixabay-dummy-key";
      process.env.MANAGED_STOCK_PEXELS_PER_MONTH = "2";
      process.env.MANAGED_STOCK_PEXELS_PER_HOUR = "50";
      process.env.MANAGED_STOCK_PIXABAY_PER_MIN = "50";
      process.env.MANAGED_STOCK_USER_SEARCHES_PER_HOUR = "30";
      process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT = "1";
    };

    // ── 1. No-key managed-stock search: Pixabay-first + 24h cache ────────────
    await section("1. No-key managed-stock search (Pixabay-first + 24h cache)", async () => {
      await resetState();
      activeUser = keylessUserA;
      pixabayResponder = async () => makePixabayVideos(4, "coffee");
      pexelsResponder = async () => makePexelsVideos(4, "coffee");

      const res1 = await searchPOST(searchRequest({ keyword: "coffee shop" }));
      const data1 = await res1.json();
      check("keyless search succeeds with 200", res1.status === 200, JSON.stringify(data1));
      check("returns 4 Pixabay candidates", Array.isArray(data1.candidates) && data1.candidates.length === 4 && data1.candidates.every((c: { provider: string }) => c.provider === "pixabay"));
      check("Pixabay was called once with managed team key", pixabayCalls.length === 1 && pixabayCalls[0]?.apiKey === "managed-pixabay-dummy-key");
      check("Pixabay-first: Pexels was NOT called when Pixabay returned >= 3 clips", pexelsCalls.length === 0);

      const usageAfter1 = await readManagedStockMonthlyStatus();
      const pbUsage1 = usageAfter1.find((r) => r.provider === "pixabay")?.used ?? 0;
      const pxUsage1 = usageAfter1.find((r) => r.provider === "pexels")?.used ?? 0;
      check("ManagedStockUsage counted Pixabay=1 and Pexels=0", pbUsage1 === 1 && pxUsage1 === 0, JSON.stringify(usageAfter1));

      // Second search for the same keyword from another keyless user hits the 24h cache.
      activeUser = keylessUserB;
      const res2 = await searchPOST(searchRequest({ keyword: "  Coffee   Shop " }));
      const data2 = await res2.json();
      check("second search returns 200 with identical cached candidates", res2.status === 200 && data2.candidates?.length === 4);
      check("24h cache hit makes ZERO live Pixabay or Pexels calls", pixabayCalls.length === 1 && pexelsCalls.length === 0);

      const usageAfter2 = await readManagedStockMonthlyStatus();
      const pbUsage2 = usageAfter2.find((r) => r.provider === "pixabay")?.used ?? 0;
      check("24h cache hit does NOT increment ManagedStockUsage", pbUsage2 === 1);

      const telemetry = await prisma.telemetryEvent.findMany({ where: { name: "managed_stock_used" }, orderBy: { createdAt: "asc" } });
      const cacheHitEvent = telemetry.find((t) => {
        const props = t.properties ? JSON.parse(t.properties) : {};
        return props.provider === "pixabay" && props.cacheHits === 1 && props.queriesUsed === 0;
      });
      check("telemetry records managed_stock_used with cacheHits=1 on cache hit", Boolean(cacheHitEvent));
    });

    // ── 2. Pixabay thin (< 3) fallback to Pexels + monthly ceiling ──────────
    await section("2. Thin Pixabay falls back to Pexels & honors monthly Pexels ceiling", async () => {
      await resetState();
      activeUser = keylessUserA;
      pixabayResponder = async () => makePixabayVideos(1, "thin");
      pexelsResponder = async () => makePexelsVideos(2, "thin");

      const res1 = await searchPOST(searchRequest({ keyword: "rare sunrise" }));
      const data1 = await res1.json();
      check("thin Pixabay search returns 200 with Pixabay + Pexels candidates", res1.status === 200 && data1.candidates?.length === 3);
      check("Pixabay candidates come first, followed by Pexels", data1.candidates?.[0]?.provider === "pixabay" && data1.candidates?.[1]?.provider === "pexels");
      check("Pexels was called with managed team key when Pixabay had < 3 hits", pexelsCalls.length === 1 && pexelsCalls[0]?.apiKey === "managed-pexels-dummy-key");

      // Second thin query exhausts MANAGED_STOCK_PEXELS_PER_MONTH = 2.
      const res2 = await searchPOST(searchRequest({ keyword: "rare mountain" }));
      check("second Pexels fallback succeeds right up to monthly ceiling (2/2)", res2.status === 200 && pexelsCalls.length === 2);

      // Third thin query: Pexels monthly budget is now exhausted -> skip Pexels, keep Pixabay hit!
      const res3 = await searchPOST(searchRequest({ keyword: "rare desert" }));
      const data3 = await res3.json();
      check("once Pexels monthly cap is reached, Pexels is skipped (not called)", pexelsCalls.length === 2);
      check("search still returns the 1 Pixabay candidate (200)", res3.status === 200 && data3.candidates?.length === 1 && data3.candidates[0]?.provider === "pixabay");

      const throttles = await prisma.telemetryEvent.findMany({ where: { name: "managed_stock_throttled" } });
      const monthThrottle = throttles.find((t) => {
        const props = t.properties ? JSON.parse(t.properties) : {};
        return props.provider === "pexels" && props.scope === "month";
      });
      check("monthly exhaustion emits managed_stock_throttled with scope=month", Boolean(monthThrottle));

      // When ONLY managed Pexels is configured and monthly cap is exhausted -> fail closed 429.
      process.env.MANAGED_PIXABAY_API_KEY = "";
      const pexelsCallsBefore = pexelsCalls.length;
      const res4 = await searchPOST(searchRequest({ keyword: "office team", brollRegionPreference: "thai" }));
      const data4 = await res4.json();
      check("Pexels-only monthly cap exhaustion fails closed with 429 managed_stock_budget_exceeded", res4.status === 429 && data4.error === "managed_stock_budget_exceeded", JSON.stringify(data4));
      check("429 monthly cap copy is Thai and customer-friendly", typeof data4.message === "string" && /ประจำเดือน/.test(data4.message));
      check("monthly cap exhaustion makes zero live provider calls (no degrade retry)", pexelsCalls.length === pexelsCallsBefore);
    });

    // ── 3. Per-user hourly cap & global token bucket throttling ─────────────
    await section("3. Per-user hourly cap & global token buckets fail closed cleanly", async () => {
      await resetState();
      process.env.MANAGED_STOCK_USER_SEARCHES_PER_HOUR = "2";
      __resetManagedStockBucketsForTests();

      activeUser = keylessUserA;
      pixabayResponder = async () => makePixabayVideos(4, "rate");

      const r1 = await searchPOST(searchRequest({ keyword: "topic one" }));
      const r2 = await searchPOST(searchRequest({ keyword: "topic two" }));
      check("first 2 uncached searches within per-user cap succeed", r1.status === 200 && r2.status === 200);

      const callsBefore3 = pixabayCalls.length + pexelsCalls.length;
      const r3 = await searchPOST(searchRequest({ keyword: "office workers", brollRegionPreference: "thai" }));
      const d3 = await r3.json();
      check("3rd uncached search exceeds per-user cap -> 429 managed_stock_rate_limited", r3.status === 429 && d3.error === "managed_stock_rate_limited", JSON.stringify(d3));
      check("rate-limited copy is clear Thai", typeof d3.message === "string" && /โควต้าชั่วคราว|รอสักครู่/.test(d3.message));
      check("per-user throttle makes ZERO provider calls and does not widen", pixabayCalls.length + pexelsCalls.length === callsBefore3);

      // Same rate-limited user searching an already-cached query STILL succeeds!
      const rCached = await searchPOST(searchRequest({ keyword: "topic one" }));
      check("cached query still succeeds (200) even when user's live search budget is spent", rCached.status === 200 && pixabayCalls.length + pexelsCalls.length === callsBefore3);

      // A different keyless user has their own per-user budget and succeeds!
      activeUser = keylessUserB;
      const rOther = await searchPOST(searchRequest({ keyword: "topic three" }));
      check("another keyless user is unaffected by user A's per-user limit", rOther.status === 200);

      // Now verify global provider token buckets fail closed when both are empty.
      await resetState();
      process.env.MANAGED_STOCK_PIXABAY_PER_MIN = "1";
      process.env.MANAGED_STOCK_PEXELS_PER_HOUR = "1";
      __resetManagedStockBucketsForTests();
      activeUser = keylessUserA;
      pixabayResponder = async () => makePixabayVideos(1, "global");
      pexelsResponder = async () => makePexelsVideos(1, "global");

      const g1 = await searchPOST(searchRequest({ keyword: "alpha query" }));
      check("consumes the 1 Pixabay + 1 Pexels global token", g1.status === 200 && pixabayCalls.length === 1 && pexelsCalls.length === 1);

      const g2 = await searchPOST(searchRequest({ keyword: "beta workers", brollRegionPreference: "thai" }));
      const g2Body = await g2.json();
      check("empty global provider buckets fail closed with 429 managed_stock_rate_limited", g2.status === 429 && g2Body.error === "managed_stock_rate_limited", JSON.stringify(g2Body));
      check("empty global buckets make ZERO extra provider calls (no degrade retry)", pixabayCalls.length === 1 && pexelsCalls.length === 1);
    });

    // ── 4. BYOK always wins when personal keys exist ────────────────────────
    await section("4. BYOK always wins over managed stock", async () => {
      await resetState();
      // Even with managed buckets & monthly cap completely exhausted, BYOK must work untouched!
      process.env.MANAGED_STOCK_PEXELS_PER_MONTH = "1";
      process.env.MANAGED_STOCK_USER_SEARCHES_PER_HOUR = "1";
      __resetManagedStockBucketsForTests();

      activeUser = byokPexelsUser;
      pexelsResponder = async () => makePexelsVideos(3, "byok-px");
      pixabayResponder = async () => makePixabayVideos(3, "should-not-call");

      const resPx = await searchPOST(searchRequest({ keyword: "city skyline" }));
      const dataPx = await resPx.json();
      check("BYOK Pexels user succeeds (200)", resPx.status === 200 && dataPx.candidates?.length === 3);
      check("uses user's OWN Pexels key, never the managed key", pexelsCalls.length === 1 && pexelsCalls[0]?.apiKey === "user-own-pexels-key-123");
      check("does NOT spend managed Pixabay key when user brought own Pexels key", pixabayCalls.length === 0);

      activeUser = byokPixabayUser;
      pixabayResponder = async () => makePixabayVideos(2, "byok-pb");
      const resPb = await searchPOST(searchRequest({ keyword: "ocean waves" }));
      const dataPb = await resPb.json();
      check("BYOK Pixabay user succeeds (200)", resPb.status === 200 && dataPb.candidates?.length === 2);
      check("uses user's OWN Pixabay key, never the managed key", pixabayCalls.length === 1 && pixabayCalls[0]?.apiKey === "user-own-pixabay-key-456");
      check("does NOT spend managed Pexels key even when own Pixabay returned < 3 hits", pexelsCalls.length === 1);

      const usage = await readManagedStockMonthlyStatus();
      check("BYOK searches record ZERO ManagedStockUsage", usage.every((r) => r.used === 0));
      const telemetryCount = await prisma.telemetryEvent.count({ where: { name: "managed_stock_used" } });
      check("BYOK searches emit ZERO managed_stock_used telemetry", telemetryCount === 0);
    });

    // ── 5. Fail-closed when MANAGED_STOCK is off / no keys / suspended ──────
    await section("5. Fail-closed when MANAGED_STOCK is off, unconfigured, or suspended", async () => {
      await resetState();
      activeUser = keylessUserA;

      process.env.MANAGED_STOCK = "0";
      const resOff = await searchPOST(searchRequest({ keyword: "sunset" }));
      const dataOff = await resOff.json();
      check("MANAGED_STOCK=0 + keyless user -> 400 missing_key (broll)", resOff.status === 400 && dataOff.error === "missing_key" && dataOff.missingKey === "broll", JSON.stringify(dataOff));
      check("flag-off copy is clear Thai", typeof dataOff.message === "string" && /คลังสต็อก|Settings/.test(dataOff.message));
      check("flag-off makes zero provider calls", pixabayCalls.length === 0 && pexelsCalls.length === 0);

      process.env.MANAGED_STOCK = "1";
      process.env.MANAGED_PEXELS_API_KEY = "";
      process.env.MANAGED_PIXABAY_API_KEY = "";
      const resNoServerKey = await searchPOST(searchRequest({ keyword: "sunset" }));
      const dataNoServerKey = await resNoServerKey.json();
      check("MANAGED_STOCK=1 with no server keys -> 400 missing_key", resNoServerKey.status === 400 && dataNoServerKey.error === "missing_key", JSON.stringify(dataNoServerKey));

      process.env.MANAGED_PEXELS_API_KEY = "managed-pexels-dummy-key";
      process.env.MANAGED_PIXABAY_API_KEY = "managed-pixabay-dummy-key";
      activeUser = suspendedKeylessUser;
      const resSusp = await searchPOST(searchRequest({ keyword: "sunset" }));
      const dataSusp = await resSusp.json();
      check("suspended keyless user -> 403 account_suspended", resSusp.status === 403 && dataSusp.error === "account_suspended", JSON.stringify(dataSusp));
      check("suspended user makes zero provider calls", pixabayCalls.length === 0 && pexelsCalls.length === 0);

      activeUser = null;
      const resUnauth = await searchPOST(searchRequest({ keyword: "sunset" }));
      check("unauthenticated search is rejected (401)", resUnauth.status === 401);
    });

    // ── 6. broll-window/select succeeds without stock keys & preserves SSRF ──
    await section("6. broll-window/select requires no stock keys & preserves auth + SSRF guards", async () => {
      await resetState();
      // Even with MANAGED_STOCK off, select never calls provider APIs and needs no stock key.
      process.env.MANAGED_STOCK = "0";
      activeUser = keylessUserA;

      const resPixabay = await selectPOST(selectRequest({
        videoUrl: "https://cdn.pixabay.com/video/2025/coffee-vertical.mp4",
        provider: "pixabay",
        keyword: "coffee",
      }));
      const dataPixabay = await resPixabay.json();
      check("keyless user selects Pixabay CDN clip -> 200 with local src + clipDuration", resPixabay.status === 200 && typeof dataPixabay.src === "string" && dataPixabay.src.startsWith(`/api/stocks/stock-${keylessUserA.id}-window-pixabay-`) && dataPixabay.clipDuration === 6.5, JSON.stringify(dataPixabay));

      const resPexels = await selectPOST(selectRequest({
        videoUrl: "https://videos.pexels.com/video-files/12345/hd-portrait.mp4",
        provider: "pexels",
        keyword: "city",
      }));
      const dataPexels = await resPexels.json();
      check("keyless user selects Pexels CDN clip -> 200", resPexels.status === 200 && typeof dataPexels.src === "string" && dataPexels.src.startsWith(`/api/stocks/stock-${keylessUserA.id}-window-pexels-`), JSON.stringify(dataPexels));

      const downloadsBeforeBadUrls = downloadCalls.length;
      const disallowedUrls = [
        "http://videos.pexels.com/video-files/12345/insecure.mp4",
        "https://evil.example.com/clip.mp4",
        "https://evilpexels.com/clip.mp4",
        "https://pexels.com.evil.com/clip.mp4",
        "https://127.0.0.1/clip.mp4",
        "https://169.254.169.254/latest/meta-data",
        "https://user:pass@videos.pexels.com/clip.mp4",
        "https://videos.pexels.com:8443/clip.mp4",
        "file:///etc/passwd",
        "not-a-url",
      ];
      let allDisallowedRejected = true;
      for (const badUrl of disallowedUrls) {
        if (isAllowedStockUrl(badUrl)) allDisallowedRejected = false;
        const badRes = await selectPOST(selectRequest({ videoUrl: badUrl, provider: "pexels" }));
        const badBody = await badRes.json();
        if (badRes.status !== 400 || badBody.error !== "invalid_url") {
          allDisallowedRejected = false;
          console.error(`        unexpected response for ${badUrl}: ${badRes.status} ${JSON.stringify(badBody)}`);
        }
      }
      check("all disallowed / SSRF / non-HTTPS / credentialed URLs are rejected with 400 invalid_url", allDisallowedRejected);
      check("no disallowed URL ever reached downloadAndCrop", downloadCalls.length === downloadsBeforeBadUrls);

      // Auth check preserved on select
      activeUser = null;
      const unauthSelect = await selectPOST(selectRequest({
        videoUrl: "https://videos.pexels.com/video-files/12345/hd-portrait.mp4",
        provider: "pexels",
      }));
      check("unauthenticated select is still rejected (401)", unauthSelect.status === 401);
    });

    // ── 7. Static wiring & guardrails ───────────────────────────────────────
    await section("7. Static wiring & no paid-AI fallback guardrails", async () => {
      const searchRoute = fs.readFileSync("src/app/api/videos/broll-window/search/route.ts", "utf8");
      const selectRoute = fs.readFileSync("src/app/api/videos/broll-window/select/route.ts", "utf8");
      const inspector = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx", "utf8");

      check("select route no longer checks user.pexelsKey or user.pixabayKey", !/pexelsKey|pixabayKey|missing_key/.test(selectRoute));
      check("select route still enforces isAllowedStockUrl and tryConsumeSelectRate", selectRoute.includes("isAllowedStockUrl(videoUrl)") && selectRoute.includes("tryConsumeSelectRate(user.id)"));
      check("search route resolves credentials via resolveManagedStockAccess", searchRoute.includes("resolveManagedStockAccess("));
      check("search route never imports or invokes paid AI providers", !/generateHeroImageForVideo|kieCreateTask|runpod|geminiGenerate/.test(searchRoute));
      check("BrollWindowInspector has no personal-key gate on เปลี่ยนสต็อก", !/pexelsKey|pixabayKey/.test(inspector));
      check("BrollWindowInspector links to Settings API Keys on managed-stock errors", inspector.includes("MANAGED_STOCK_BROLL_HINT_HREF") && inspector.includes("brollWindowSearchErrorNeedsApiKeys"));
    });
  } finally {
    authMock.restore();
    assetMock.restore();
    childProcessMock.restore();
    await prisma.$disconnect();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (!stocksExistedBefore && fs.existsSync(stocksDir)) {
      try {
        if (fs.readdirSync(stocksDir).length === 0) fs.rmdirSync(stocksDir);
      } catch {
        /* ignore */
      }
    }
  }

  console.log(`\nverify-broll-swap-managed-stock: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
