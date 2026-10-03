// verify-mcp-chain-linkage.ts — T5 (PR-A, plan docs/plans/2026-10-03-mcp-edit-before-export.md):
// the chain-linkage prefactor that the MCP edit tools build on.
//
//  G6  a Held Preview (`inputJson.mcpHold`) is skipped by every chain trigger: the orchestrator's
//      finish hook, get_video_status's lost-enqueue recovery and the watchdog sweep.
//  G7  every job spawned after the root preview carries `mcpRootJobId`; keys are
//      `mcp-export:<root>:<rev>` / `mcp-rerender:<root>:<rev>`; `mcp-chain:<preview>` unchanged.
//  G8  get_video_status(root) reports root → newest descendant: held → rerendering → exporting →
//      done / failed / canceled, with previewUrl + editorUrl once the root has finished.
//  G4  assertMcpRenderFree refuses `export_not_free` (missing ChargedClip, 11th rerender in an
//      hour, ineligible config) writing nothing; the REAL render route fails an `mcpMustBeFree`
//      job instead of charging it (no ChargedClip, no reservation, no RenderJob).
//
// Self-contained: always builds its own throwaway SQLite. Providers are stubbed; the stub
// /api/videos/render mirrors the real route's charge rule, except where a section routes the
// render through the REAL route (compiled with stubbed heavy dependencies, real DB modules).
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-chain-linkage.ts

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import nodeCrypto from "node:crypto";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "mcp-chain-linkage-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
  "NEXT_PUBLIC_BROLL_WINDOW_EDIT",
]) delete process.env[key];
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const rendersRoot = join(dir, "renders");
mkdirSync(rendersRoot, { recursive: true });

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(name);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const SCRIPT = "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน เนื้อบางเบามาก ซึมไวสุดๆ";
const TIMING = {
  provider: "gemini",
  segments: [
    { text: "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน ", startMs: 0, durationMs: 2600 },
    { text: "เนื้อบางเบามาก ซึมไวสุดๆ", startMs: 2600, durationMs: 2400 },
  ],
};
const VOICE_FILE = "/api/renders/linkage-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 150,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/linkage-a.mp4", start: 0, end: 2.5, sourceIndex: 0, clipDuration: 5 },
    { src: "/api/stocks/linkage-b.mp4", start: 2.5, end: 5, sourceIndex: 1, clipDuration: 5 },
  ],
};

type StubOptions = { failBurn?: boolean; realRender?: boolean };
let renderSeq = 0;
let gallerySeq = 0;

// ── REAL /api/videos/render, compiled with stubbed heavy dependencies ─────────────────────
// DB-facing modules (prisma, clip-charge, broll-rerender, video-job, the rerender budget and
// render-free) are the REAL ones, so the flag check, the free paths and the budget run for
// real; every charge entry point is a spy that must stay untouched on a refusal.
const chargeCalls: string[] = [];
let routeUserId = "";
let serviceJobId: string | null = null;
let remotionSetupHits = 0;
const REMOTION_SENTINEL = "linkage-test: reached render setup (free path passed the charge gate)";

function compileRoute(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const videoJobModule = await import("../src/lib/mcp/video-job");
  const { parseVideoJobOutput } = videoJobModule;
  const { getVideoJobStatusTool, mcpEditorUrl } = await import("../src/lib/mcp/tools");
  const clipCharge = await import("../src/lib/clip-charge");
  const { isBurnAlreadyPaid, recordChargedClip } = clipCharge;
  const brollRerender = await import("../src/lib/broll-rerender");
  const { sweepStalledVideoJobs } = await import("../src/lib/mcp/video-job-watchdog");
  const { cancelMcpVideoJob } = await import("../src/lib/mcp/video-job-cancel");
  const { decodePipelineResponse } = await import("../src/lib/mcp/pipeline-client");
  const { DEFAULT_V2_SUB } = await import("../src/app/(dashboard)/video-editor/_v2/subtitle-style");
  const { buildBurnConfig, v2SubConfigToHeroDesign, RENDER_FPS } = await import("../src/lib/mcp/orchestrator-steps");
  const chain = await import("../src/lib/mcp/chain-export");
  const chainKey = await import("../src/lib/mcp/chain-key");
  const enqueue = await import("../src/lib/editor-export-enqueue");
  const renderFree = await import("../src/lib/mcp/render-free");
  const budget = await import("../src/lib/rerender-skip-budget");
  const brollCoverage = await import("../src/lib/broll-coverage");
  const brollPlaceholders = await import("../src/lib/broll-placeholders");
  const headlineHook = await import("../src/lib/headline-hook");
  const { resolveMediaBaseUrl } = await import("../src/lib/render/media-base-url");

  // ── render route harness ──
  class UnsafeUrlError extends Error {}
  class SupersededError extends Error {}
  class VideoJobFundingConfirmationRequiredError extends Error {}
  class RenderDeployDrainError extends Error {}
  const fsMock = {
    mkdirSync: () => undefined,
    existsSync: () => false,
    statSync: () => ({ size: 0, isFile: () => false }),
    readFileSync: () => { throw new Error("not found"); },
    writeFileSync: () => undefined,
    readdirSync: () => [] as string[],
    copyFileSync: () => undefined,
  };
  const cancelRegistry = {
    activeRenderCancel: new Map(),
    cancelByJobId: new Map(),
    renderJobDoneByUser: new Map(),
    getActiveRenderCount: () => 0,
    incrementActiveRenderCount: () => undefined,
    decrementActiveRenderCount: () => undefined,
    getRenderSlotQueueLength: () => 0,
    activeRemotionBundleNames: () => [] as string[],
  };
  const spy = (name: string, value: unknown) => async () => { chargeCalls.push(name); return value; };
  const requireMock = (specifier: string): unknown => {
    if (specifier === "next/server") {
      return {
        NextResponse: {
          json: (body: unknown, init: { status?: number } = {}) => new Response(
            JSON.stringify(body),
            { status: init.status ?? 200, headers: { "Content-Type": "application/json" } },
          ),
        },
      };
    }
    if (specifier === "@/lib/clerk-auth") return { getCurrentUser: async () => ({ id: routeUserId }) };
    if (specifier === "@/lib/notifications") return { createNotification: async () => undefined };
    if (specifier === "@/lib/plan-limits") {
      return { limitsForPlan: () => ({ durationSec: 600 }), nextPlanFor: () => null, PLAN_LABEL: {} };
    }
    if (specifier === "@/lib/prisma") return { prisma };
    if (specifier === "@/lib/usage-limits") {
      return {
        checkClipQuota: spy("checkClipQuota", { allowed: false, message: "stub quota wall" }),
        reserveClipUsage: spy("reserveClipUsage", { allowed: false, message: "stub quota wall" }),
      };
    }
    if (specifier === "@/lib/minute-limits") {
      return { checkMinuteQuota: spy("checkMinuteQuota", { allowed: false }), minutesFromSeconds: () => 1 };
    }
    if (specifier === "@/lib/minute-credits") {
      return {
        reserveMinutesOrCredits: spy("reserveMinutesOrCredits", { allowed: false }),
        refundReservation: spy("refundReservation", undefined),
      };
    }
    if (specifier === "@/lib/credits") return { serializeCreditFunding: () => null };
    if (specifier === "@/lib/quota-error") {
      return { QUOTA_EXCEEDED_CODE: "QUOTA_EXCEEDED", quotaUpgradeUserAction: () => null };
    }
    if (specifier === "@/lib/clip-charge") return clipCharge;
    if (specifier === "@/lib/broll-rerender") return brollRerender;
    if (specifier === "@/lib/mcp/video-job") return videoJobModule;
    if (specifier === "@/lib/mcp/video-job-funding") {
      return {
        markTransferredVideoJobFundingRefunded: spy("markTransferredVideoJobFundingRefunded", undefined),
        transferVideoJobFundingToRender: spy("transferVideoJobFundingToRender", { transferred: false }),
        VideoJobFundingConfirmationRequiredError,
      };
    }
    if (specifier === "@/lib/mcp/service-actor") {
      return { resolveServiceVideoJobId: async (userId: string) => (userId === routeUserId ? serviceJobId : null) };
    }
    if (specifier === "@/lib/rerender-skip-budget") return budget;
    if (specifier === "@/lib/mcp/render-free") return renderFree;
    if (specifier === "path") return nodePath;
    if (specifier === "fs") return fsMock;
    if (specifier === "crypto") return nodeCrypto;
    if (specifier === "@/lib/safe-fetch") {
      return { isSafeFetchUrl: async () => false, assertSafeFetchUrl: async () => undefined, UnsafeUrlError };
    }
    if (specifier === "@/lib/sanitize-caption-style") return { stripDangerousCss: (value: unknown) => value };
    if (specifier === "child_process") return { execFileSync: () => undefined, spawn: () => { throw new Error("no spawn"); } };
    if (specifier === "@/lib/ffmpeg-path") return { getFfmpegPath: () => "ffmpeg" };
    // PR-0b media guard. Every path here stops at the @remotion/renderer sentinel, which the
    // route loads before it resolves any media, so none of these may be reached. They throw
    // (not refuse) so a reordered route fails loudly instead of answering a quiet 422.
    if (specifier === "@/lib/render-input-guard") {
      const unreachable = (name: string) => async () => { throw new Error(`linkage-test: ${name} must not be reached`); };
      return {
        cacheImageLocally: unreachable("cacheImageLocally"),
        cacheRemoteMediaLocally: unreachable("cacheRemoteMediaLocally"),
        probeVideoDurationSec: unreachable("probeVideoDurationSec"),
        RenderMediaRefusedError: class RenderMediaRefusedError extends Error {
          readonly code = "render_media_unusable";
          constructor(public readonly field: string) { super(field); }
        },
      };
    }
    if (specifier === "@/lib/telemetry") return { recordTelemetryEvent: async () => undefined };
    if (specifier === "@/lib/broll-coverage") return brollCoverage;
    if (specifier === "@/lib/broll-placeholders") return brollPlaceholders;
    if (specifier === "@/lib/headline-hook") return headlineHook;
    if (specifier === "@/lib/render/run-render") return { runRender: async () => { throw new Error("must not render"); }, SupersededError };
    if (specifier === "@/lib/render/remotion-public-dir") return { prepareRemotionBundlePublicDir: () => "/tmp/public" };
    if (specifier === "@/lib/render/media-base-url") return { resolveMediaBaseUrl };
    if (specifier === "@/lib/render/job-store") {
      return { enqueueRenderJob: spy("enqueueRenderJob", { id: "unexpected" }), supersedeScope: async () => 0 };
    }
    if (specifier === "@/lib/logo-export.server") return { normalizeTrustedLogoRenderInput: () => null };
    if (specifier === "@/lib/render-deploy-drain") {
      return {
        assertRenderEnqueueOpen: async () => undefined,
        RenderDeployDrainError,
        RENDER_MAINTENANCE_CUSTOMER_MESSAGE: "maintenance",
      };
    }
    if (specifier === "./cancel-registry") return cancelRegistry;
    if (specifier === "@remotion/renderer") {
      remotionSetupHits += 1;
      throw new Error(REMOTION_SENTINEL);
    }
    throw new Error(`unhandled render route import: ${specifier}`);
  };
  const routeSource = readFileSync("src/app/api/videos/render/route.ts", "utf8");
  const routeModule = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", compileRoute(routeSource, "src/app/api/videos/render/route.ts"))(
    requireMock, routeModule, routeModule.exports,
  );
  const RENDER_POST = routeModule.exports.POST as (request: Request) => Promise<Response>;

  /** One request through the real render route, as the worker's service actor for `jobId`. */
  async function callRealRender(userId: string, jobId: string, body: unknown) {
    routeUserId = userId;
    serviceJobId = jobId;
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const originalError = console.error;
    console.error = () => {}; // the free-path sentinel is logged by the route's outer catch
    try {
      const response = await RENDER_POST(new Request("https://example.test/api/videos/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      return { status: response.status, text: await response.text() };
    } finally {
      console.error = originalError;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const now = new Date();
  async function makeUser(id: string, email: string) {
    await prisma.user.create({
      data: {
        id, name: id, email,
        plan: "PRO", minutesLimit: 80, minutesUsed: 0,
        usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
        geminiVoiceName: "Aoede", geminiKey: "g", pexelsKey: "p",
        subStatus: "active",
        stripeSubscriptionId: `sub_${id}`,
        planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      },
    });
    await prisma.payment.create({
      data: {
        userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900,
        status: "PAID", periodDays: 30, paidAt: now,
      },
    });
    return prisma.user.findUniqueOrThrow({ where: { id } });
  }
  // Internal-tester emails: the MCP Editor Project flag and the B-roll window-edit beta are on.
  const tester = await makeUser("u-linkage", "qa-linkage@aoacademy.co");
  const freeUser = await makeUser("u-linkage-free", "qa-linkage-free@aoacademy.co");
  const other = await makeUser("u-linkage-other", "linkage-other@example.com");

  function makeCaller(userId: string, jobId: string, opts: StubOptions = {}) {
    const caller = {
      async post<T>(path: string, body?: unknown): Promise<T> {
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          return { voiceUrl: VOICE_FILE, audioDurationMs: 5000, timing: TIMING } as T;
        }
        if (path === "/api/videos/split-script") return { cards: null } as T;
        if (path === "/api/videos/transcribe") {
          const requested = typeof (body as { script?: unknown })?.script === "string"
            ? String((body as { script: string }).script).trim()
            : SCRIPT;
          return {
            captions: [{ text: requested, startMs: 100, endMs: 4_800, tag: "hook" }],
            words: [{ word: requested, startMs: 100, endMs: 4_800 }],
            fullText: requested,
            audioDurationMs: 5_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_800 },
          } as T;
        }
        if (path === "/api/videos/extract-keywords") {
          return { keywords: ["sunscreen"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [5], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "sunscreen" }] } as T;
        if (path === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (path === "/api/videos/render") {
          if (opts.realRender) {
            const real = await callRealRender(userId, jobId, body);
            return decodePipelineResponse<T>("POST", path, real.status, real.text);
          }
          renderSeq += 1;
          const request = (body ?? {}) as {
            subtitleOverlayConfig?: { videoUrl?: string };
            parentJobId?: string;
            rerenderOf?: { sourceJobId?: string };
          };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          // Mirrors /api/videos/render: a burn of a paid base is free; a `rerenderOf` render of
          // a paid source is free and records its new base as a 0-minute ChargedClip.
          let free = false;
          if (isBurn) {
            free = await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
          } else if (request.rerenderOf?.sourceJobId) {
            const source = await prisma.videoJob.findUnique({ where: { id: request.rerenderOf.sourceJobId } });
            free = !!source && await isBurnAlreadyPaid(userId, parseVideoJobOutput(source.outputJson)?.videoUrl);
          }
          const failing = isBurn && !!opts.failBurn;
          await prisma.renderJob.create({
            data: {
              id, userId, parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER",
              status: failing ? "FAILED" : "DONE",
              payload: "{}", videoUrl: failing ? null : videoUrl,
              reservedQuota: !free, reservedMinutes: free ? null : 1,
            },
          });
          if (!free) {
            await prisma.user.update({ where: { id: userId }, data: { minutesUsed: { increment: 1 } } });
            if (!failing) await recordChargedClip(userId, videoUrl, 1);
          } else if (!isBurn) {
            await recordChargedClip(userId, videoUrl, 0);
          }
          if (!failing) writeFileSync(join(rendersRoot, `${id}-${isBurn ? "burned" : "base"}.mp4`), "x");
          return { jobId: id } as T;
        }
        if (path.startsWith("/api/videos/render-cancel")) return {} as T;
        if (path === "/api/videos") { gallerySeq += 1; return { id: `gallery-linkage-${gallerySeq}` } as T; }
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(): Promise<T> { return {} as T; },
      async get<T>(path: string): Promise<T> {
        if (path.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(path)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          if (!rj || rj.status === "FAILED") {
            return { progress: -1, videoUrl: null, error: "stub render failed", stage: "error" } as T;
          }
          return { progress: 100, videoUrl: rj.videoUrl, error: null, stage: "done" } as T;
        }
        if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
        throw new Error(`stub caller: unexpected GET ${path}`);
      },
    };
    return caller;
  }

  async function runJob(jobId: string, userId: string, opts: StubOptions = {}) {
    await prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ["queued", "waiting_provider"] } },
      data: { status: "processing", startedAt: new Date(), providerNextPollAt: null },
    });
    await runOrchestrator(jobId, userId, { caller: makeCaller(userId, jobId, opts) as never, sleep: async () => {} });
    return prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  const baseInput = (extra: Record<string, unknown> = {}) => ({
    script: SCRIPT,
    title: "คลิปจากเอเจนต์",
    voiceProvider: "gemini",
    subtitleDesign: DEFAULT_V2_SUB,
    subtitleCardLen: "sentence",
    ...extra,
  });
  const inputOf = (row: { inputJson: string }) => JSON.parse(row.inputJson) as Record<string, unknown>;
  type StatusReply = Record<string, unknown> & { status?: string; jobId?: string };
  const status = async (userId: string, id: string) => (await getVideoJobStatusTool(userId, id)) as StatusReply | null;
  const exportRowCount = (userId: string) => prisma.videoJob.count({ where: { userId, type: "export" } });

  /** Overlay the way the MCP chain builds it: preview captions on the given paid base. */
  function overlayFor(row: { outputJson: string | null }) {
    const output = parseVideoJobOutput(row.outputJson);
    if (!output?.preview || !output.videoUrl) throw new Error("fixture: source has no preview output");
    return buildBurnConfig(
      output.videoUrl,
      output.preview.captions.map((caption, index) => ({ ...caption, tag: index === 0 ? "hook" as const : "body" as const })),
      output.preview.audioDurationMs,
      v2SubConfigToHeroDesign(DEFAULT_V2_SUB),
      RENDER_FPS,
    );
  }

  async function heldRoot(user: { id: string; email: string | null }, key: string) {
    const created = await chain.createMcpVideoJob(user, baseInput(), key, { title: "พักไว้ที่ preview", hold: true });
    if (created.kind !== "created" || !created.projectId) throw new Error(`fixture: held create returned ${created.kind}`);
    const done = await runJob(created.job.id, user.id);
    if (done.status !== "done") throw new Error(`fixture: held root ended ${done.status}: ${done.errorMessage}`);
    return { root: done, projectId: created.projectId };
  }

  // ── S1 ──
  await section("S1 keys: mcp-export / mcp-rerender per draft revision; mcp-chain unchanged; all reserved", async () => {
    check("mcpExportKey shape", chainKey.mcpExportKey("root-1", 1) === "mcp-export:root-1:1");
    check("mcpRerenderKey shape", chainKey.mcpRerenderKey("root-1", 2) === "mcp-rerender:root-1:2");
    check("mcp-chain key unchanged", chainKey.mcpChainExportKey("preview-1") === "mcp-chain:preview-1");
    check("a new draft revision is a new export key", chainKey.mcpExportKey("root-1", 1) !== chainKey.mcpExportKey("root-1", 2));
    for (const bad of [-1, 1.5, Number.NaN]) {
      let threw = false;
      try { chainKey.mcpExportKey("root-1", bad); } catch { threw = true; }
      check(`draftRevision ${bad} is refused`, threw);
    }
    for (const key of ["mcp-chain:x", "mcp-export:x:1", "mcp-rerender:x:1"]) {
      check(`${key.split(":")[0]}: keys are a reserved server namespace`, chainKey.isReservedMcpChainIdempotencyKey(key));
    }
    check("an ordinary client key is not reserved", !chainKey.isReservedMcpChainIdempotencyKey("web-key-1"));
  });

  // ── S2 ──
  let held: { root: Awaited<ReturnType<typeof runJob>>; projectId: string } | null = null;
  await section("S2 G6: a Held Preview survives a get_video_status poll and a watchdog sweep without exporting", async () => {
    held = await heldRoot(tester, "linkage-held-1");
    const { root, projectId } = held;
    const input = inputOf(root);
    check("held root input carries mcpHold and previewMode, never mcpChainExport",
      input.mcpHold === true && input.previewMode === true && input.mcpChainExport === undefined, JSON.stringify(input));
    check("a held root is not an auto-chain preview", chain.isMcpChainPreview(root) === false);
    check("held root finished with no export enqueued by the finish hook", await exportRowCount(tester.id) === 0);

    const reply = await status(tester.id, root.id);
    check("get_video_status(root) reports held", reply?.status === "held", JSON.stringify(reply));
    check("held reply keeps the root id", reply?.jobId === root.id);
    check("held reply carries an absolute previewUrl of the base",
      typeof reply?.previewUrl === "string" && String(reply.previewUrl).startsWith("https://studio.example.test/api/renders/"),
      String(reply?.previewUrl));
    check("held reply carries the project's editorUrl", reply?.editorUrl === mcpEditorUrl(projectId));
    check("held reply has no final videoUrl", reply?.videoUrl === null);
    check("the poll enqueued nothing", await exportRowCount(tester.id) === 0);

    const sweep = await sweepStalledVideoJobs(new Date());
    check("watchdog sweep recovered no chain export", sweep.recoveredChainExports.length === 0);
    check("recoverLostMcpChainExports ignores the held root", (await chain.recoverLostMcpChainExports(new Date())).length === 0);
    const direct = await chain.enqueueMcpChainExport({ previewJobId: root.id, userId: tester.id });
    check("a direct chain enqueue refuses a held root (not_chain)", direct.kind === "not_chain", JSON.stringify(direct));
    check("still no export row after sweep + direct enqueue", await exportRowCount(tester.id) === 0);
    check("another user's id never resolves the held chain", await chain.resolveMcpChain(other.id, root.id) === null);
  });

  await section("S2b G6: mcpHold wins even when a job also carries mcpChainExport", async () => {
    const project = await prisma.editorProject.create({
      data: { userId: tester.id, title: "both flags", status: "rendering", draftJson: JSON.stringify({ createdVia: "mcp" }) },
    });
    const job = await videoJobModule.createVideoJob(
      tester.id,
      { ...baseInput(), previewMode: true, mcpChainExport: true, mcpHold: true },
      "linkage-both-flags",
      { projectId: project.id },
    );
    check("isMcpChainPreview is false for a held job carrying both flags", chain.isMcpChainPreview(job) === false);
    const done = await runJob(job.id, tester.id);
    check("both-flags job finished", done.status === "done", String(done.errorMessage));
    check("the orchestrator finish hook skipped it (no mcp-chain row)", await prisma.videoJob.count({
      where: { userId: tester.id, idempotencyKey: chainKey.mcpChainExportKey(job.id) },
    }) === 0);
    const reply = await status(tester.id, job.id);
    check("get_video_status reports it held and enqueues nothing", reply?.status === "held" && await prisma.videoJob.count({
      where: { userId: tester.id, idempotencyKey: chainKey.mcpChainExportKey(job.id) },
    }) === 0, JSON.stringify(reply));
    const sweep = await sweepStalledVideoJobs(new Date());
    check("the watchdog skips it", !sweep.recoveredChainExports.includes(job.id));
    check("still no chain export row", await prisma.videoJob.count({
      where: { userId: tester.id, idempotencyKey: chainKey.mcpChainExportKey(job.id) },
    }) === 0);
  });

  // ── S3 ──
  await section("S3 the existing auto chain is unchanged", async () => {
    const created = await chain.createMcpVideoJob(tester, baseInput(), "linkage-auto-1", { title: "auto" });
    if (created.kind !== "created") throw new Error(created.kind);
    const input = inputOf(created.job);
    check("auto preview carries mcpChainExport and no mcpHold", input.mcpChainExport === true && input.mcpHold === undefined);
    const preview = await runJob(created.job.id, tester.id);
    check("auto preview done", preview.status === "done", String(preview.errorMessage));
    const exportRow = await prisma.videoJob.findUnique({
      where: { userId_idempotencyKey: { userId: tester.id, idempotencyKey: chainKey.mcpChainExportKey(preview.id) } },
    });
    check("finish hook enqueued the export under mcp-chain:<preview>", exportRow?.type === "export" && exportRow.status === "queued");
    const exportInput = exportRow ? inputOf(exportRow) : {};
    check("auto export input: mcpChainExport true, no mcpRootJobId / mcpMustBeFree",
      exportInput.mcpChainExport === true && exportInput.mcpRootJobId === undefined && exportInput.mcpMustBeFree === undefined,
      JSON.stringify(Object.keys(exportInput)));
    check("auto export overlay comes from the preview's base", (exportInput.subtitleOverlayConfig as { videoUrl?: string })?.videoUrl
      === parseVideoJobOutput(preview.outputJson)?.videoUrl);
    const mid = await status(tester.id, preview.id);
    check("auto chain mid-export reads processing at 85 under the preview id",
      mid?.status === "processing" && mid.progress === 85 && mid.jobId === preview.id, JSON.stringify(mid));
    check("auto chain reply has no previewUrl key", mid !== null && !("previewUrl" in mid));
    const exported = await runJob(exportRow!.id, tester.id);
    check("auto export done", exported.status === "done", String(exported.errorMessage));
    const end = await status(tester.id, preview.id);
    check("auto chain done with videoUrl + editorUrl, still no previewUrl",
      end?.status === "done" && typeof end.videoUrl === "string" && end.editorUrl === mcpEditorUrl(created.projectId!)
      && !("previewUrl" in end), JSON.stringify(end));
  });

  // ── S4 ──
  await section("S4 G7 + G8: held → rerendering → held → exporting → done → re-export → failed → canceled", async () => {
    if (!held) throw new Error("S2 fixture missing");
    const { root, projectId } = held;
    const editorUrl = mcpEditorUrl(projectId);

    const rr = await enqueue.enqueueBrollRerender({
      user: tester,
      sourceJobId: root.id,
      windowEdits: [{ index: 0, enabled: false }],
      idempotencyKey: chainKey.mcpRerenderKey(root.id, 1),
      rootJobId: root.id,
    });
    check("rerender enqueued", rr.ok === true, JSON.stringify(rr));
    if (!rr.ok) return;
    const rrInput = inputOf(rr.job);
    check("rerender carries mcpRootJobId + mcpMustBeFree", rrInput.mcpRootJobId === root.id && rrInput.mcpMustBeFree === true,
      JSON.stringify(rrInput));
    check("rerender is keyed mcp-rerender:<root>:1 and linked to the root's project",
      rr.job.idempotencyKey === `mcp-rerender:${root.id}:1` && rr.job.projectId === projectId);

    let reply = await status(tester.id, root.id);
    check("root reads rerendering while the rerender is queued", reply?.status === "rerendering", JSON.stringify(reply));
    check("rerendering keeps previewUrl + editorUrl", typeof reply?.previewUrl === "string" && reply?.editorUrl === editorUrl);
    const byDescendant = await status(tester.id, rr.job.id);
    check("the descendant id reads the same chain under the root id",
      byDescendant?.jobId === root.id && byDescendant?.status === "rerendering", JSON.stringify(byDescendant));

    const rrDone = await runJob(rr.job.id, tester.id);
    check("rerender done (free via rerenderOf)", rrDone.status === "done", String(rrDone.errorMessage));
    reply = await status(tester.id, root.id);
    const rrUrl = parseVideoJobOutput(rrDone.outputJson)?.videoUrl ?? "";
    check("after the rerender the root reads held again", reply?.status === "held", JSON.stringify(reply));
    check("previewUrl now points at the rerendered base", String(reply?.previewUrl).endsWith(rrUrl), String(reply?.previewUrl));

    const ex1 = await enqueue.enqueueEditorExport({
      user: tester,
      brandVisualAccess: { canUse: false },
      sourceJobId: rrDone.id,
      subtitleOverlayConfig: overlayFor(rrDone),
      idempotencyKey: chainKey.mcpExportKey(root.id, 1),
      rootJobId: root.id,
    });
    check("export 1 enqueued", ex1.ok === true, JSON.stringify(ex1));
    if (!ex1.ok) return;
    const ex1Input = inputOf(ex1.job);
    check("export carries mcpRootJobId + mcpMustBeFree, not mcpChainExport",
      ex1Input.mcpRootJobId === root.id && ex1Input.mcpMustBeFree === true && ex1Input.mcpChainExport === undefined);
    check("export keyed mcp-export:<root>:1, type export", ex1.job.idempotencyKey === `mcp-export:${root.id}:1` && ex1.job.type === "export");
    reply = await status(tester.id, root.id);
    check("root reads exporting", reply?.status === "exporting", JSON.stringify(reply));

    const ex1Done = await runJob(ex1.job.id, tester.id);
    check("export 1 done", ex1Done.status === "done", String(ex1Done.errorMessage));
    reply = await status(tester.id, root.id);
    const ex1Url = parseVideoJobOutput(ex1Done.outputJson)?.videoUrl ?? "";
    check("root reads done with the newest export's videoUrl",
      reply?.status === "done" && String(reply.videoUrl).endsWith(ex1Url) && ex1Url.length > 0, JSON.stringify(reply));
    check("done keeps previewUrl + editorUrl", typeof reply?.previewUrl === "string" && reply?.editorUrl === editorUrl);

    const ex2 = await enqueue.enqueueEditorExport({
      user: tester,
      brandVisualAccess: { canUse: false },
      sourceJobId: rrDone.id,
      subtitleOverlayConfig: overlayFor(rrDone),
      idempotencyKey: chainKey.mcpExportKey(root.id, 2),
      rootJobId: root.id,
    });
    check("a second export of the same root (next revision) is a new row", ex2.ok === true && ex2.job.id !== ex1.job.id);
    if (!ex2.ok) return;
    check("second export has its own key", ex2.job.idempotencyKey === `mcp-export:${root.id}:2`);
    let reused = "";
    try {
      await enqueue.enqueueEditorExport({
        user: tester,
        brandVisualAccess: { canUse: false },
        sourceJobId: rrDone.id,
        subtitleOverlayConfig: overlayFor(rrDone),
        idempotencyKey: chainKey.mcpExportKey(root.id, 2),
        rootJobId: root.id,
      });
    } catch (error) {
      reused = String((error as { code?: unknown }).code);
    }
    check("re-using a revision's key is a unique-key conflict (P2002) for the caller to replay", reused === "P2002", reused);
    reply = await status(tester.id, root.id);
    check("the newest descendant wins: exporting again", reply?.status === "exporting", JSON.stringify(reply));

    const ex2Failed = await runJob(ex2.job.id, tester.id, { failBurn: true });
    check("export 2 failed (stub burn failure)", ex2Failed.status === "failed");
    reply = await status(tester.id, root.id);
    check("root reads failed with failure fields", reply?.status === "failed"
      && typeof reply.errorCode === "string" && typeof reply.message === "string" && typeof reply.userAction === "string"
      && reply.refunded === false && typeof reply.refundPending === "boolean", JSON.stringify(reply));
    check("failed keeps previewUrl + editorUrl", typeof reply?.previewUrl === "string" && reply?.editorUrl === editorUrl);

    const ex3 = await enqueue.enqueueEditorExport({
      user: tester,
      brandVisualAccess: { canUse: false },
      sourceJobId: rrDone.id,
      subtitleOverlayConfig: overlayFor(rrDone),
      idempotencyKey: chainKey.mcpExportKey(root.id, 3),
      rootJobId: root.id,
    });
    if (!ex3.ok) throw new Error(JSON.stringify(ex3));
    const canceled = await cancelMcpVideoJob(tester.id, root.id);
    check("cancel by the root id cancels the newest in-flight descendant", canceled.kind === "canceled", JSON.stringify(canceled));
    const ex3Row = await prisma.videoJob.findUniqueOrThrow({ where: { id: ex3.job.id } });
    check("export 3 row is canceled", ex3Row.status === "canceled");
    reply = await status(tester.id, root.id);
    check("root reads canceled with settlement fields", reply?.status === "canceled"
      && reply.refunded === false && typeof reply.refundPending === "boolean", JSON.stringify(reply));
    const again = await cancelMcpVideoJob(tester.id, root.id);
    check("a second cancel finds nothing in flight", again.kind === "not_cancelable");
  });

  // ── S5 ──
  let freeFixture: { root: Awaited<ReturnType<typeof runJob>>; projectId: string; baseUrl: string } | null = null;
  async function counts(userId: string) {
    const [chargedClips, renderJobs, videoJobs, user] = await Promise.all([
      prisma.chargedClip.count({ where: { userId } }),
      prisma.renderJob.count({ where: { userId } }),
      prisma.videoJob.count({ where: { userId } }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { minutesUsed: true, usageCount: true } }),
    ]);
    return JSON.stringify({ chargedClips, renderJobs, videoJobs, ...user });
  }
  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
      return null;
    } catch (error) {
      return error as { code?: unknown; reason?: unknown; message?: unknown; next?: unknown };
    }
  }
  await section("S5 G4: assertMcpRenderFree refuses export_not_free and writes nothing", async () => {
    const fixture = await heldRoot(freeUser, "linkage-free-1");
    const baseUrl = parseVideoJobOutput(fixture.root.outputJson)?.videoUrl ?? "";
    freeFixture = { ...fixture, baseUrl };
    const sourceConfig = parseVideoJobOutput(fixture.root.outputJson)?.preview?.config as Record<string, unknown>;

    check("paid base: a burn pre-check passes",
      await refusal(renderFree.assertMcpRenderFree({ userId: freeUser.id, baseVideoUrl: baseUrl })) === null);
    for (let index = 0; index < budget.RERENDER_SKIP_RATE_PER_HOUR - 1; index += 1) budget.tryConsumeRerenderRate(freeUser.id);
    const before = await counts(freeUser.id);
    check("10th rerender in the hour passes the pre-check",
      await refusal(renderFree.assertMcpRenderFree({ userId: freeUser.id, baseVideoUrl: baseUrl, rerender: { sourceConfig } })) === null);
    check("the pre-check never consumes a budget slot", budget.rerenderSkipBudgetAvailable(freeUser.id));
    budget.tryConsumeRerenderRate(freeUser.id); // the 10th accepted free rerender
    const eleventh = await refusal(renderFree.assertMcpRenderFree({
      userId: freeUser.id, baseVideoUrl: baseUrl, rerender: { sourceConfig },
    }));
    check("11th rerender in an hour refuses export_not_free", eleventh?.code === "export_not_free"
      && eleventh.reason === "rerender_budget_exhausted", JSON.stringify(eleventh));
    check("the refusal carries Thai copy and a next step",
      typeof eleventh?.message === "string" && /[฀-๿]/.test(String(eleventh.message))
      && typeof eleventh?.next === "string" && String(eleventh.next).length > 0);
    check("a burn-only pre-check is unaffected by the rerender budget",
      await refusal(renderFree.assertMcpRenderFree({ userId: freeUser.id, baseVideoUrl: baseUrl })) === null);

    const ineligible = await refusal(renderFree.assertMcpRenderFree({
      userId: freeUser.id, baseVideoUrl: baseUrl, rerender: { sourceConfig: { ...sourceConfig, voiceFile: "" } },
    }));
    check("an ineligible rerender config refuses export_not_free", ineligible?.code === "export_not_free"
      && ineligible.reason === "rerender_ineligible", JSON.stringify(ineligible));

    await prisma.chargedClip.deleteMany({ where: { userId: freeUser.id } });
    const beforeMissing = await counts(freeUser.id);
    const missing = await refusal(renderFree.assertMcpRenderFree({ userId: freeUser.id, baseVideoUrl: baseUrl }));
    check("a missing ChargedClip refuses export_not_free", missing?.code === "export_not_free"
      && missing.reason === "base_not_paid", JSON.stringify(missing));
    check("refusals wrote no ChargedClip / RenderJob / VideoJob and charged nothing", await counts(freeUser.id) === beforeMissing);
    check("and nothing changed across the budget refusals either",
      JSON.parse(await counts(freeUser.id)).renderJobs === JSON.parse(before).renderJobs);
  });

  // ── S6 ──
  await section("S6 G4 defence: the REAL render route fails an mcpMustBeFree job instead of charging", async () => {
    if (!freeFixture) throw new Error("S5 fixture missing");
    const { root, baseUrl } = freeFixture;
    const overlay = overlayFor(root);
    // ChargedClip rows were deleted in S5 → this base is unpaid.
    const flagged = await enqueue.enqueueEditorExport({
      user: freeUser,
      brandVisualAccess: { canUse: false },
      sourceJobId: root.id,
      subtitleOverlayConfig: overlay,
      idempotencyKey: chainKey.mcpExportKey(root.id, 1),
      rootJobId: root.id,
    });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged));
    chargeCalls.length = 0;
    let before = await counts(freeUser.id);
    let real = await callRealRender(freeUser.id, flagged.job.id, { subtitleOverlayConfig: overlay, parentJobId: flagged.job.id });
    let body = JSON.parse(real.text) as { error?: { code?: string; message?: string } };
    check("flagged burn of an unpaid base → 409 export_not_free", real.status === 409 && body.error?.code === "export_not_free",
      real.text.slice(0, 300));
    check("the refusal carries Thai copy", /[฀-๿]/.test(String(body.error?.message)));
    check("no quota check, reservation, funding transfer or enqueue was attempted", chargeCalls.length === 0, chargeCalls.join(","));
    check("no ChargedClip / RenderJob / charge written", await counts(freeUser.id) === before);

    const plain = await enqueue.enqueueEditorExport({
      user: freeUser,
      brandVisualAccess: { canUse: false },
      sourceJobId: root.id,
      subtitleOverlayConfig: overlay,
      idempotencyKey: "linkage-plain-export",
    });
    if (!plain.ok) throw new Error(JSON.stringify(plain));
    check("an export without rootJobId is not flagged", inputOf(plain.job).mcpMustBeFree === undefined);
    chargeCalls.length = 0;
    real = await callRealRender(freeUser.id, plain.job.id, { subtitleOverlayConfig: overlay, parentJobId: plain.job.id });
    check("control: the same unpaid burn for an unflagged job reaches normal charging (quota pre-check)",
      chargeCalls[0] === "checkClipQuota" && real.status === 403, `${real.status} ${chargeCalls.join(",")}`);

    // 11th rerender: restore the base's charge so the rerender would otherwise be free.
    await recordChargedClip(freeUser.id, baseUrl, 1);
    check("budget is spent for this user (S5 consumed 10)", !budget.rerenderSkipBudgetAvailable(freeUser.id));
    await prisma.videoJob.updateMany({ where: { id: { in: [flagged.job.id, plain.job.id] } }, data: { status: "canceled" } });
    const rr = await enqueue.enqueueBrollRerender({
      user: freeUser,
      sourceJobId: root.id,
      windowEdits: [{ index: 1, enabled: false }],
      idempotencyKey: chainKey.mcpRerenderKey(root.id, 1),
      rootJobId: root.id,
    });
    if (!rr.ok) throw new Error(JSON.stringify(rr));
    const sourceConfig = parseVideoJobOutput(root.outputJson)?.preview?.config as Record<string, unknown>;
    chargeCalls.length = 0;
    before = await counts(freeUser.id);
    real = await callRealRender(freeUser.id, rr.job.id, {
      shortVideoConfig: { ...sourceConfig, keywordPopups: [] },
      rerenderOf: { sourceJobId: root.id },
      parentJobId: rr.job.id,
    });
    body = JSON.parse(real.text);
    check("flagged 11th rerender → 409 export_not_free", real.status === 409 && body.error?.code === "export_not_free",
      real.text.slice(0, 300));
    check("no charge entry point touched for the 11th rerender", chargeCalls.length === 0, chargeCalls.join(","));
    check("no ChargedClip / RenderJob / charge written for the 11th rerender", await counts(freeUser.id) === before);

    remotionSetupHits = 0;
    chargeCalls.length = 0;
    before = await counts(freeUser.id);
    real = await callRealRender(freeUser.id, flagged.job.id, { subtitleOverlayConfig: overlay, parentJobId: flagged.job.id });
    check("a flagged burn of a PAID base passes the gate without charging (reaches render setup)",
      remotionSetupHits === 1 && chargeCalls.length === 0 && real.status !== 409, `${real.status} ${chargeCalls.join(",")}`);
    check("nothing charged on the free flagged burn", await counts(freeUser.id) === before);
  });

  // ── S7 ──
  await section("S7 G4 end to end: a flagged export of an unpaid base fails export_not_free in the worker", async () => {
    if (!freeFixture) throw new Error("S5 fixture missing");
    const { root } = freeFixture;
    await prisma.chargedClip.deleteMany({ where: { userId: freeUser.id } });
    await prisma.videoJob.updateMany({ where: { userId: freeUser.id, status: { in: ["queued", "processing"] } }, data: { status: "canceled" } });
    const ex = await enqueue.enqueueEditorExport({
      user: freeUser,
      brandVisualAccess: { canUse: false },
      sourceJobId: root.id,
      subtitleOverlayConfig: overlayFor(root),
      idempotencyKey: chainKey.mcpExportKey(root.id, 2),
      rootJobId: root.id,
    });
    if (!ex.ok) throw new Error(JSON.stringify(ex));
    const before = await counts(freeUser.id);
    const minutesBefore = (await prisma.user.findUniqueOrThrow({ where: { id: freeUser.id } })).minutesUsed;
    const done = await runJob(ex.job.id, freeUser.id, { realRender: true });
    check("the export job failed with errorCode export_not_free", done.status === "failed" && done.errorCode === "export_not_free",
      `${done.status} ${done.errorCode} ${done.errorMessage}`);
    check("its message is the Thai refusal copy", /[฀-๿]/.test(String(done.errorMessage)));
    check("no RenderJob was created for it", await prisma.renderJob.count({ where: { parentJobId: ex.job.id } }) === 0);
    check("no ChargedClip, no minutes", JSON.parse(await counts(freeUser.id)).chargedClips === 0
      && (await prisma.user.findUniqueOrThrow({ where: { id: freeUser.id } })).minutesUsed === minutesBefore);
    check("only the failed job row changed", JSON.parse(await counts(freeUser.id)).renderJobs === JSON.parse(before).renderJobs);
    const reply = await status(freeUser.id, root.id);
    check("get_video_status(root) reports failed export_not_free", reply?.status === "failed" && reply.errorCode === "export_not_free",
      JSON.stringify(reply));
  });

  // ── S8 ──
  await section("S8 both callers share the extracted enqueue", async () => {
    const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
    const chainSource = readFileSync("src/lib/mcp/chain-export.ts", "utf8");
    check("jobs route export branch calls enqueueEditorExport", jobsRoute.includes("enqueueEditorExport({"));
    check("jobs route rerender branch calls enqueueBrollRerender", jobsRoute.includes("enqueueBrollRerender({"));
    check("the MCP chain export calls enqueueEditorExport", chainSource.includes("enqueueEditorExport({"));
    check("the jobs route no longer creates export/rerender jobs inline",
      !jobsRoute.includes("createDurableExportWithStagedLogo(") && !jobsRoute.includes("mode: \"broll-rerender\", previewMode: true"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
