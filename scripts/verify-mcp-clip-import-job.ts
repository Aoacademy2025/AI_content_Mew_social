// verify-mcp-clip-import-job.ts — Task 14 (PR-B, plan docs/plans/2026-10-03-mcp-edit-before-export.md,
// G2/G5/G14/G22/G28, A10, AC4/AC6/AC8): `create_video_job({clipUrl | clipUploadId, cutawayLayout})`.
//
// Every MCP call goes through the REAL route handler (only Clerk + the network key preflight are
// stubbed, same harness shape as verify-mcp-broll-window-edits.ts). Presenter imports run through
// the REAL import lane and T9's REAL presenter checks (real ffmpeg/ffprobe) with a fake fetch for
// url rows; the upload path goes through the REAL `PUT /api/mcp-uploads/<token>` route. The
// pipeline routes are a stub caller that charges the base render like /api/videos/render does,
// so any reservation shows up as money moving.
//
// Covers:
//   A. schema: clipUrl / clipUploadId / cutawayLayout in the shared create_video_job schema,
//      agent-neutral, script no longer required by the schema; non-beta → feature_not_enabled.
//   B. validation: script-less only with a clip, exactly one clip source, https only,
//      cutawayLayout only with a clip, no avatar with a clip, G27 ownership of clipUploadId.
//   C. URL path end to end: waiting_import (no clipUrl, no reservation, no worker slot) → lane →
//      ready → settle (watchdog sweep) → queued upload-mode job with the allowlisted clipUrl (G28)
//      → preview from the clip's own audio → chained export → done.
//   D. upload path + fillYourself + hold: every window goes to the presenter; held; window 0 editable.
//   E. import failure → the job fails with the import's code, zero net charge (landscape,
//      over-duration, fetch failure); a reservation, if one ever existed, is refunded.
//   F. a waiting job holds no worker slot; it still counts toward the in-flight cap.
//   G. cancel while waiting: the job never runs after its import is ready.
//   K. PR-B fix round 1 SEC-B1: free-disk floor on the lane (fetch temp/staging + the output disk),
//      fail closed storage_busy, nothing written, the clip job fails with zero net charge.
//   L. SEC-A6 / T14-A3: cancel (MCP or web core) fails the job's url import; a claimed fetch is
//      aborted at its next checkpoint; an upload import is the agent's own and survives.
//   M. T14-A2: a duplicate idempotencyKey returns the existing job before any import starts.
//   N. T14-A4: input.clipUrl only ever takes the lane's exact presenter output name.
//   O. SEC-A5: waiting_import jobs whose import can no longer finish do not hold the deploy drain.
//   H. audit: clipUrl redacted; no agent url in any reply, log or audit row.
//   I. create_video_job without the new fields is unchanged (regression).
//   J. wiring (package.json + CI after ffmpeg is installed), G14 envelopes.
//
// Self-contained: its own throwaway SQLite and a private TMPDIR. Needs real ffmpeg + ffprobe.
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-clip-import-job.ts

import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-clip-import-job-")));
const privateTmp = path.join(tmp, "tmpdir");
fs.mkdirSync(privateTmp, { mode: 0o700 });
process.env.TMPDIR = privateTmp; // staging (T11) + fetch temp (T10) live under os.tmpdir()
process.env.DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.RENDER_VIA_QUEUE = "1";
process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
for (const key of [
  "MCP_EDITOR_PROJECT_PUBLIC",
  "NEXT_PUBLIC_BROLL_WINDOW_EDIT",
  "INTERNAL_AI_ALLOWED_EMAILS",
  "INTERNAL_AI_ALLOWED_DOMAINS",
  "MINUTE_QUOTA",
  "CREDITS_LIVE",
  "RENDER_DEPLOY_DRAIN",
  "MANAGED_GEMINI",
  "GEMINI_SERVER_KEY",
]) delete process.env[key];
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

// Presenter outputs always land in <cwd>/public/renders (upload-avatar's dir); remove ours on exit.
const rendersDir = path.join(ROOT, "public", "renders");
const listPresenterOutputs = () => (fs.existsSync(rendersDir) ? fs.readdirSync(rendersDir).filter((n) => n.startsWith("presenter-import-")) : []);
const presenterOutputsBefore = new Set(listPresenterOutputs());
process.on("exit", () => {
  for (const name of listPresenterOutputs()) if (!presenterOutputsBefore.has(name)) fs.rmSync(path.join(rendersDir, name), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
async function section(name: string, body: () => Promise<void>) {
  console.log(`\n${name}`);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 60_000, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}

const TOOL = "create_video_job";
const NEW_FIELDS = ["clipUrl", "clipUploadId", "cutawayLayout"] as const;
const URL_HOST = "media.example.test";
const SECRET = "SECRET-TOKEN";
const clipLink = (name: string) => `https://${URL_HOST}/${name}.mp4?sig=${SECRET}`;
// The clip's own audio, as /api/videos/transcribe would return it: 16 s, four ~4 s cards.
const CARDS = ["สวัสดีครับ วันนี้", "เรามาดูกันว่า", "ทำอาหารง่ายๆ", "ที่บ้านได้ยังไง"];
const CLIP_MS = 16_000;
const SCRIPT = "อยาก กินข้าวเย็นนี้ ที่ร้านโปรด ของฉัน";
const VOICE_FILE = "/api/renders/cij-voice.wav";
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: "/api/stocks/cij-a.mp4", start: 0, end: 2, sourceIndex: 0, clipDuration: 4, provider: "pexels" },
    { src: "/api/stocks/cij-b.mp4", start: 2, end: 4, sourceIndex: 1, clipDuration: 4, provider: "pexels" },
  ],
};

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const realRequire = createRequire(path.join(ROOT, "scripts/verify-mcp-clip-import-job.ts"));
  const fromSrc = (p: string) => realRequire(path.join(ROOT, "src", p));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const videoJob = fromSrc("lib/mcp/video-job") as typeof import("../src/lib/mcp/video-job");
  const { parseVideoJobOutput, claimNextRunnableJob, createVideoJob } = videoJob;
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { isBurnAlreadyPaid, recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");
  const lane = fromSrc("lib/media-import/lane") as typeof import("../src/lib/media-import/lane");
  const fetchMod = fromSrc("lib/media-import/fetch") as typeof import("../src/lib/media-import/fetch");
  const { getFfmpegPath } = fromSrc("lib/ffmpeg-path") as typeof import("../src/lib/ffmpeg-path");
  const { durationCapSecFor } = fromSrc("lib/plan-limits") as typeof import("../src/lib/plan-limits");
  const { sweepStalledVideoJobs } = fromSrc("lib/mcp/video-job-watchdog") as typeof import("../src/lib/mcp/video-job-watchdog");
  const uploadRoute = fromSrc("app/api/mcp-uploads/[token]/route") as typeof import("../src/app/api/mcp-uploads/[token]/route");
  const { mcpChainExportKey } = fromSrc("lib/mcp/chain-key") as typeof import("../src/lib/mcp/chain-key");
  const { VIDEO_JOB_INFLIGHT_STATUSES, toPublicVideoJobStatus } = fromSrc("lib/mcp/video-job-status") as typeof import("../src/lib/mcp/video-job-status");

  check("os.tmpdir() is the private test dir", os.tmpdir() === privateTmp, os.tmpdir());

  // ── REAL MCP route, compiled; only Clerk + the network key preflight are stubbed ──
  const routeRequire = (specifier: string): unknown => {
    if (specifier === "@clerk/nextjs/server") return { auth: async () => { throw new Error("no Clerk in this test"); } };
    if (specifier === "@clerk/mcp-tools/next") return { verifyClerkToken: async () => undefined };
    if (specifier === "@/lib/key-preflight") {
      return {
        ...keyPreflight,
        preflightElevenLabs: async () => null,
        preflightStockProviders: async () => ({ block: null, providers: [] }),
      };
    }
    if (specifier.startsWith("@/")) return fromSrc(specifier.slice(2));
    return realRequire(specifier);
  };
  const routePath = "src/app/api/[transport]/route.ts";
  const routeModule = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", compile(fs.readFileSync(routePath, "utf8"), routePath))(
    routeRequire, routeModule, routeModule.exports,
  );
  const ROUTE_POST = routeModule.exports.POST as (request: Request) => Promise<Response>;

  let rpcSeq = 0;
  async function rpc(token: string, method: string, params: unknown): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "verify-mcp-clip-import-job/1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq, method, params }),
    }));
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    try {
      return JSON.parse(dataLine ? dataLine.slice(6) : body) as Json;
    } catch {
      throw new Error(`route ${method} → ${response.status}: ${body.slice(0, 300)}`);
    }
  }
  async function listTools(token: string) {
    const message = await rpc(token, "tools/list", {});
    return ((message.result as Json | undefined)?.tools ?? []) as Array<{ name: string; inputSchema?: Json; description?: string }>;
  }
  const failures: Array<{ tool: string; reply: Json }> = [];
  const replies: Array<{ tool: string; text: string }> = [];
  async function callTool(token: string, name: string, args: Json): Promise<Json> {
    const message = await rpc(token, "tools/call", { name, arguments: args });
    const result = message.result as { content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tools/call ${name}: ${JSON.stringify(message).slice(0, 400)}`);
    replies.push({ tool: name, text });
    let reply: Json;
    try {
      reply = JSON.parse(text) as Json;
    } catch {
      throw new Error(`tools/call ${name} returned non-JSON: ${text.slice(0, 300)}`);
    }
    if (reply.error != null && name === TOOL && typeof reply.code === "string") failures.push({ tool: name, reply });
    return reply;
  }

  // ── fixtures: users ──
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
      data: { userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900, status: "PAID", periodDays: 30, paidAt: now },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    const { token } = await createMcpToken(id, "verify-mcp-clip-import-job");
    return { user, token };
  }
  // Internal-tester emails pass the MCP Editor Project gate.
  const tester = await makeUser("u-cij", "qa-cij@aoacademy.co");
  const second = await makeUser("u-cij-2", "qa-cij-2@aoacademy.co");
  const third = await makeUser("u-cij-3", "qa-cij-3@aoacademy.co");
  const capper = await makeUser("u-cij-cap", "qa-cij-cap@aoacademy.co");
  const outsider = await makeUser("u-cij-outsider", "cij-outsider@example.com");

  // ── fixtures: real media (tiny) ──
  const ff = (args: string[]) => execFileSync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const fixture = (name: string) => path.join(tmp, name);
  ff([
    "-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture("portrait.mp4"),
  ]);
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("landscape.mp4")]);
  const longSec = durationCapSecFor("PRO") + 10;
  ff(["-f", "lavfi", "-i", `testsrc=size=90x160:rate=1:duration=${longSec}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", fixture("long.mp4")]);
  const portrait = fs.readFileSync(fixture("portrait.mp4"));
  const landscape = fs.readFileSync(fixture("landscape.mp4"));
  const longClip = fs.readFileSync(fixture("long.mp4"));

  // ── fake fetch (T10 contract: a 0600 file in mediaImportTempDir(), caller owns it) ──
  const tempDir = fetchMod.mediaImportTempDir();
  const ensurePrivateDir = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  };
  const served = new Map<string, Buffer | Error>();
  const fetchCalls: Array<{ url: string; accept: Json }> = [];
  /** Runs while the url is "downloading" (e.g. the disk fills up meanwhile). */
  const duringFetch = new Map<string, () => void>();
  /** Urls that stream until the caller aborts (or 15 s pass): the lane's cancel checkpoint. */
  const slowUrls = new Set<string>();
  const slowState: { startedAt: number; abortedAt: number } = { startedAt: 0, abortedAt: 0 };
  const fakeFetch = async (url: string, options: { accept: Partial<Record<"image" | "video", number>>; signal?: AbortSignal }) => {
    fetchCalls.push({ url, accept: { ...options.accept } });
    const behavior = served.get(url);
    if (!behavior) throw new fetchMod.MediaFetchError("fetch_failed");
    if (behavior instanceof Error) throw behavior;
    if (options.accept.video === undefined) throw new fetchMod.MediaFetchError("unsupported_media");
    duringFetch.get(url)?.();
    ensurePrivateDir(tempDir);
    if (slowUrls.has(url)) {
      // Like T10: a .part grows in the temp dir until the body ends or the request is destroyed.
      const part = path.join(tempDir, `media-import-${randomUUID()}.part`);
      fs.writeFileSync(part, behavior.subarray(0, 64), { mode: 0o600 });
      slowState.startedAt = Date.now();
      const aborted = await new Promise<boolean>((resolve) => {
        if (options.signal?.aborted) return resolve(true);
        const timer = setTimeout(() => resolve(false), 15_000);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(true); }, { once: true });
      });
      fs.rmSync(part, { force: true }); // T10 deletes its .part on abort (verify-media-import-fetch §16)
      if (aborted) {
        slowState.abortedAt = Date.now();
        throw new fetchMod.MediaFetchError("fetch_timeout");
      }
    }
    const file = path.join(tempDir, `media-import-${randomUUID()}.mp4`);
    fs.writeFileSync(file, behavior, { mode: 0o600 });
    return { path: file, kind: "video" as const, ext: "mp4" as const, mime: "application/octet-stream", bytes: behavior.length };
  };
  const stocksDir = path.join(tmp, "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  // SEC-B1: statfs is real unless a section reports one directory's disk as full (or statfs broken).
  const realStatfs = fs.statfsSync;
  const diskFake: { fullDir: string | null; broken: boolean; asked: string[] } = { fullDir: null, broken: false, asked: [] };
  (fs as { statfsSync: unknown }).statfsSync = (target: fs.PathLike, ...rest: unknown[]) => {
    diskFake.asked.push(path.resolve(String(target)));
    if (diskFake.broken) throw Object.assign(new Error("EIO"), { code: "EIO" });
    const real = (realStatfs as (...args: unknown[]) => fs.StatsFs)(target, ...rest);
    return diskFake.fullDir && path.resolve(String(target)) === diskFake.fullDir ? { ...real, bavail: 0 } : real;
  };
  const laneLog: string[] = [];
  type LaneExtra = Partial<Parameters<typeof lane.createMediaImportLane>[0]>;
  const newLane = (extra: LaneExtra = {}) => lane.createMediaImportLane({
    pollMs: 20, watchdogMs: 60 * 60_000, stocksDir, fetchMedia: fakeFetch,
    log: { info: (line) => { laneLog.push(line); }, error: (line) => { laneLog.push(line); } },
    ...extra,
  });
  /** Run the REAL import lane (real presenter checks, fake fetch) until every live import has settled. */
  async function runLane(extra: LaneExtra = {}) {
    const l = newLane(extra);
    l.start();
    const settled = await waitFor(async () => (await prisma.mediaImport.count({
      where: { status: "pending" },
    })) === 0 && l.inFlight === 0, 120_000);
    await l.stop();
    return settled;
  }
  async function putUpload(uploadUrl: string, bytes: Buffer) {
    const token = decodeURIComponent(new URL(uploadUrl).pathname.split("/").pop() ?? "");
    return uploadRoute.PUT(new Request(`https://studio.test/api/mcp-uploads/${token}`, {
      method: "PUT",
      body: new Uint8Array(bytes),
      headers: { "content-length": String(bytes.length) },
      // @ts-expect-error -- Node's fetch Request needs duplex for a streamed body
      duplex: "half",
    }), { params: Promise.resolve({ token }) });
  }

  // ── stub caller: the pipeline routes; charges the base render like /api/videos/render ──
  let renderSeq = 0;
  let gallerySeq = 0;
  const callerLog: Array<{ method: string; path: string; body?: Json }> = [];
  function makeCaller(userId: string) {
    return {
      async post<T>(p: string, body?: unknown): Promise<T> {
        callerLog.push({ method: "POST", path: p, body: structuredClone((body ?? {}) as Json) });
        if (p === "/api/videos/tts-gemini" || p === "/api/videos/tts") {
          return { voiceUrl: VOICE_FILE, audioDurationMs: 4_000, timing: { provider: "gemini", segments: [{ text: SCRIPT, startMs: 0, durationMs: 4_000 }] } } as T;
        }
        if (p === "/api/videos/split-script") return { cards: null } as T;
        if (p === "/api/videos/transcribe") {
          const audioUrl = String(((body ?? {}) as Json).audioUrl ?? "");
          if (audioUrl === VOICE_FILE) {
            return {
              captions: [{ text: SCRIPT, startMs: 0, endMs: 4_000, tag: "hook" }],
              words: [{ word: SCRIPT, startMs: 0, endMs: 4_000 }],
              fullText: SCRIPT, audioDurationMs: 4_000,
              speechCoverage: { source: "silence_analysis", spokenEndMs: 4_000 },
            } as T;
          }
          const step = CLIP_MS / CARDS.length;
          return {
            captions: CARDS.map((text, index) => ({ text, startMs: index * step, endMs: (index + 1) * step, tag: index === 0 ? "hook" : "body" })),
            words: CARDS.map((text, index) => ({ word: text, startMs: index * step, endMs: (index + 1) * step })),
            fullText: CARDS.join(" "),
            audioDurationMs: CLIP_MS,
            speechCoverage: { source: "silence_analysis", spokenEndMs: CLIP_MS },
          } as T;
        }
        if (p === "/api/videos/extract-keywords") {
          return { keywords: ["food", "home"], keywordsPerScene: 5, sceneClipCounts: [1, 1], sceneDurations: [4, 4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (p === "/api/videos/fetch-stock") {
          return { results: [{ videoUrl: "/api/stocks/cij-stock-1.mp4", keyword: "food" }, { videoUrl: "/api/stocks/cij-stock-2.mp4", keyword: "home" }] } as T;
        }
        if (p === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (p === "/api/heygen/composite") {
          renderSeq += 1;
          const videoUrl = `/api/renders/cij-composite-${renderSeq}.mp4`;
          await recordChargedClip(userId, videoUrl); // the real composite route records its output
          return { videoUrl } as T;
        }
        if (p === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-cij-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          const free = isBurn ? await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl) : false;
          await prisma.renderJob.create({
            data: {
              id, userId, parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER", status: "DONE",
              payload: "{}", videoUrl,
              reservedQuota: !free, reservedMinutes: free ? null : 1,
            },
          });
          if (!free) {
            await prisma.user.update({ where: { id: userId }, data: { minutesUsed: { increment: 1 } } });
            await recordChargedClip(userId, videoUrl, 1);
          }
          return { jobId: id } as T;
        }
        if (p.startsWith("/api/videos/render-cancel")) return {} as T;
        if (p === "/api/videos") { gallerySeq += 1; return { id: `gallery-cij-${gallerySeq}` } as T; }
        throw new Error(`stub caller: unexpected POST ${p}`);
      },
      async patch<T>(p: string): Promise<T> { callerLog.push({ method: "PATCH", path: p }); return {} as T; },
      async get<T>(p: string): Promise<T> {
        callerLog.push({ method: "GET", path: p });
        if (p.startsWith("/api/videos/render-progress")) {
          const id = decodeURIComponent(/jobId=([^&]+)/.exec(p)?.[1] ?? "");
          const rj = await prisma.renderJob.findUnique({ where: { id } });
          return { progress: 100, videoUrl: rj?.videoUrl ?? null, error: null, stage: "done" } as T;
        }
        if (p === "/api/music") return { tracks: [], userTracks: [] } as T;
        throw new Error(`stub caller: unexpected GET ${p}`);
      },
    };
  }
  async function runJob(jobId: string, userId: string) {
    await prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ["queued", "waiting_provider"] } },
      data: { status: "processing", startedAt: new Date(), providerNextPollAt: null },
    });
    await runOrchestrator(jobId, userId, { caller: makeCaller(userId) as never, sleep: async () => {} });
    return prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } });
  }
  const inputOf = (row: { inputJson: string }) => JSON.parse(row.inputJson) as Json;
  async function money(userId: string) {
    const [paidClips, reservedRenders, renderJobs, user, ledger] = await Promise.all([
      prisma.chargedClip.count({ where: { userId } }),
      prisma.renderJob.count({ where: { userId, reservedQuota: true } }),
      prisma.renderJob.count({ where: { userId } }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { minutesUsed: true, usageCount: true } }),
      prisma.creditLedger.count({ where: { userId } }),
    ]);
    return JSON.stringify({ paidClips, reservedRenders, renderJobs, minutesUsed: user.minutesUsed, usageCount: user.usageCount, creditLedger: ledger });
  }
  const jobRow = (id: unknown) => prisma.videoJob.findUniqueOrThrow({ where: { id: String(id) } });
  const counts = async (userId: string) => ({
    jobs: await prisma.videoJob.count({ where: { userId } }),
    imports: await prisma.mediaImport.count({ where: { userId } }),
  });
  const status = async (who: { token: string }, jobId: string) => callTool(who.token, "get_video_status", { id: jobId });
  const calls = (p: string) => callerLog.filter((entry) => entry.path === p);
  /** Leave the user with no in-flight job, so the next section starts below the cap of 3. */
  async function clearInflight(userId: string) {
    await prisma.videoJob.updateMany({
      where: { userId, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES, "waiting_import"] } },
      data: { status: "canceled", finishedAt: new Date() },
    });
  }

  // ── A ──
  await section("A) schema: the new fields sit in the shared, agent-neutral schema; non-beta is refused", async () => {
    for (const who of [tester, outsider]) {
      const tools = await listTools(who.token);
      const create = tools.find((tool) => tool.name === TOOL);
      const schema = (create?.inputSchema ?? {}) as Json;
      const props = (schema.properties ?? {}) as Record<string, Json>;
      const label = who === tester ? "beta" : "non-beta";
      check(`${label}: create_video_job lists clipUrl, clipUploadId, cutawayLayout`, NEW_FIELDS.every((field) => field in props), Object.keys(props).join(","));
      check(`${label}: script is no longer schema-required (validated server-side)`, !((schema.required as string[] | undefined) ?? []).includes("script"), JSON.stringify(schema.required));
      const problems = verifyAgentNeutralSchemas(tools, [TOOL]);
      check(`${label}: create_video_job's schema is agent-neutral (no oneOf/anyOf/allOf)`, problems.length === 0, problems.join("; "));
    }
    const props = (((await listTools(tester.token)).find((tool) => tool.name === TOOL)?.inputSchema ?? {}) as Json).properties as Record<string, Json>;
    check("cutawayLayout is the string enum auto | fillYourself", JSON.stringify(props.cutawayLayout?.enum) === JSON.stringify(["auto", "fillYourself"]), JSON.stringify(props.cutawayLayout));
    check("clipUrl / clipUploadId descriptions state the mutual exclusion",
      /clipUploadId/.test(String(props.clipUrl?.description)) && /clipUrl/.test(String(props.clipUploadId?.description)),
      `${props.clipUrl?.description} | ${props.clipUploadId?.description}`);
    const descriptions = [props.clipUrl, props.clipUploadId, props.cutawayLayout].map((p) => String(p?.description ?? "")).join(" ");
    check("field text never promises a 10-minute total", !/10\s*นาที/.test(descriptions), descriptions);

    const before = await counts(outsider.user.id);
    for (const args of [
      { clipUrl: clipLink("outsider") },
      { clipUploadId: randomUUID() },
      { script: SCRIPT, cutawayLayout: "fillYourself" },
      { clipUrl: clipLink("outsider-2"), cutawayLayout: "auto" },
    ] as Json[]) {
      const reply = await callTool(outsider.token, TOOL, args);
      check(`non-beta ${Object.keys(args).filter((k) => k !== "script").join("+")} → feature_not_enabled`,
        reply.error === "feature_not_enabled" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    }
    check("non-beta refusals created no job and no import", JSON.stringify(await counts(outsider.user.id)) === JSON.stringify(before));
    check("non-beta: no url was ever fetched", fetchCalls.length === 0);
  });

  // ── B ──
  await section("B) validation: script-less only with a clip; exactly one clip source; https; G27 ownership", async () => {
    const foreignPresenter = await prisma.mediaImport.create({
      data: { userId: second.user.id, purpose: "presenter", source: "upload", status: "ready", resultSrc: "/api/renders/presenter-import-foreign.mp4", durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000) },
    });
    const ownBroll = await prisma.mediaImport.create({
      data: { userId: tester.user.id, purpose: "broll_video", source: "upload", status: "ready", resultSrc: "/api/stocks/broll-upload-own.mp4", durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000) },
    });
    const before = await counts(tester.user.id);
    const cases: Array<[string, Json, string]> = [
      ["no script, no clip", {}, "invalid_input"],
      ["title only", { title: "x" }, "invalid_input"],
      ["clipUrl + clipUploadId", { clipUrl: clipLink("both"), clipUploadId: ownBroll.id }, "invalid_input"],
      ["cutawayLayout without a clip", { script: SCRIPT, cutawayLayout: "fillYourself" }, "invalid_input"],
      ["http clipUrl", { clipUrl: `http://${URL_HOST}/a.mp4` }, "url_not_https"],
      ["file clipUrl", { clipUrl: "file:///etc/passwd" }, "url_not_https"],
      ["not a url", { clipUrl: "not a url" }, "invalid_input"],
      ["credentials in the url", { clipUrl: `https://user:pw@${URL_HOST}/a.mp4` }, "invalid_input"],
      ["overlong url", { clipUrl: `https://${URL_HOST}/${"a".repeat(2100)}.mp4` }, "invalid_input"],
      ["avatar with a clip", { clipUrl: clipLink("avatar"), avatarMode: "full" }, "invalid_input"],
      ["random clipUploadId", { clipUploadId: randomUUID() }, "invalid_input"],
      ["another user's presenter upload", { clipUploadId: foreignPresenter.id }, "invalid_input"],
      ["own B-roll upload as a clip", { clipUploadId: ownBroll.id }, "invalid_input"],
    ];
    const notFound: string[] = [];
    for (const [label, args, code] of cases) {
      const reply = await callTool(tester.token, TOOL, args);
      check(`${label} → ${code}`, reply.error === code && reply.code === code && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
      if (label.includes("clipUploadId") || label.includes("upload")) notFound.push(String(reply.message));
    }
    check("G27: missing, foreign and wrong-kind ids read identically", new Set(notFound.slice(-3)).size === 1, notFound.join(" | "));
    check("no refusal created a job or an import", JSON.stringify(await counts(tester.user.id)) === JSON.stringify(before));
    check("no refusal fetched anything", fetchCalls.length === 0);

    const failedUpload = await prisma.mediaImport.create({
      data: { userId: tester.user.id, purpose: "presenter", source: "upload", status: "failed", errorCode: "not_portrait", deadlineAt: new Date(Date.now() + 60_000) },
    });
    const refused = await callTool(tester.token, TOOL, { clipUploadId: failedUpload.id });
    check("an already-failed clip upload → import_failed naming its code, no job",
      refused.error === "import_failed" && refused.importError === "not_portrait" && checkFailureEnvelope(refused).length === 0
        && (await prisma.videoJob.count({ where: { userId: tester.user.id } })) === before.jobs,
      JSON.stringify(refused));
  });

  // ── C ──
  let autoRootId = "";
  await section("C) URL path end to end: waiting_import → lane → settle → upload-mode job → preview → chained export → done", async () => {
    const url = clipLink("presenter-auto");
    served.set(url, portrait);
    const moneyBefore = await money(tester.user.id);
    const reply = await callTool(tester.token, TOOL, { clipUrl: url, cutawayLayout: "auto", bgmFile: undefined, idempotencyKey: "cij-auto-1" });
    check("create accepted: jobId, public status queued", typeof reply.jobId === "string" && reply.status === "queued", JSON.stringify(reply));
    autoRootId = String(reply.jobId);
    const waiting = await jobRow(reply.jobId);
    const input = inputOf(waiting);
    check("the job waits in waiting_import (currentStep import)", waiting.status === "waiting_import" && waiting.currentStep === "import", `${waiting.status} ${waiting.currentStep}`);
    check("input: upload mode, empty script, clipImportId, layout auto, chained export", input.mode === "upload" && input.script === ""
      && typeof input.clipImportId === "string" && input.cutawayLayout === "auto" && input.mcpChainExport === true && input.previewMode === true, JSON.stringify(input));
    check("G28: the agent's url never reaches input.clipUrl", !("clipUrl" in input) && !waiting.inputJson.includes(URL_HOST));
    const imp = await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(input.clipImportId) } });
    check("a presenter url import was queued", imp.purpose === "presenter" && imp.source === "url" && imp.status === "pending" && imp.userId === tester.user.id, JSON.stringify(imp));
    check("G5: nothing reserved while waiting", waiting.fundingState === "none" && (await money(tester.user.id)) === moneyBefore);
    check("A10: the waiting job holds no worker slot (nothing claimable)", (await claimNextRunnableJob()) === null);
    check("…and it is still waiting", (await jobRow(reply.jobId)).status === "waiting_import");
    const early = await status(tester, autoRootId);
    check("get_video_status while importing → queued / import", early.status === "queued" && early.currentStep === "import" && early.error == null, JSON.stringify(early));

    check("the lane settles the presenter import", await runLane());
    const ready = await prisma.mediaImport.findUniqueOrThrow({ where: { id: imp.id } });
    check("import ready under /api/renders/presenter-import-…", ready.status === "ready" && /^\/api\/renders\/presenter-import-[\w-]+\.mp4$/.test(ready.resultSrc ?? ""), JSON.stringify(ready));
    check("the presenter fetch asked for video only (≤ 500 MB)", fetchCalls.some((c) => c.url === url && c.accept.video === 500 * 1024 * 1024 && c.accept.image === undefined), JSON.stringify(fetchCalls));

    const sweep = await sweepStalledVideoJobs(new Date()) as Json;
    const queued = await jobRow(reply.jobId);
    const queuedInput = inputOf(queued);
    check("the watchdog sweep promotes it to queued", queued.status === "queued" && queued.currentStep !== "import", `${queued.status} ${queued.currentStep}`);
    check("…and reports it", Array.isArray(sweep.settledImportJobs) && (sweep.settledImportJobs as string[]).includes(autoRootId), JSON.stringify(sweep));
    check("G28: input.clipUrl = the import's own stored result (allowlisted)", queuedInput.clipUrl === ready.resultSrc && queuedInput.mode === "upload", JSON.stringify(queuedInput));
    check("still nothing reserved before the run", queued.fundingState === "none" && (await money(tester.user.id)) === moneyBefore);
    const second = await sweepStalledVideoJobs(new Date()) as Json;
    check("a repeat sweep is a no-op", !((second.settledImportJobs as string[] | undefined) ?? []).includes(autoRootId));

    callerLog.length = 0;
    const done = await runJob(autoRootId, tester.user.id);
    check("the upload-mode preview runs to done", done.status === "done", String(done.errorMessage));
    const transcribe = calls("/api/videos/transcribe");
    check("subtitles come from the clip's own audio (transcribe audioUrl = clipUrl, no TTS)",
      transcribe.length === 1 && transcribe[0].body?.audioUrl === ready.resultSrc && calls("/api/videos/tts-gemini").length === 0 && calls("/api/videos/tts").length === 0,
      JSON.stringify(transcribe));
    const composite = calls("/api/heygen/composite")[0]?.body as Json | undefined;
    check("composite mode cutaway over the clip", composite?.mode === "cutaway" && composite?.avatarVideoUrl === ready.resultSrc, JSON.stringify(composite));
    const output = parseVideoJobOutput(done.outputJson);
    check("preview avatarModel upload-cutaway, captions from the clip", output?.preview?.avatarModel === "upload-cutaway" && output?.preview?.captions?.[0]?.text === CARDS[0], JSON.stringify(output?.preview?.avatarModel));
    const personRanges = (composite?.personRanges ?? []) as Array<{ start: number; end: number }>;
    const personSec = personRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
    check("auto layout: B-roll takes some windows (presenter < whole clip)", personRanges.length > 0 && personSec < CLIP_MS / 1000 - 0.5 && calls("/api/videos/fetch-stock").length === 1,
      JSON.stringify(personRanges));
    const exportRow = await prisma.videoJob.findFirst({ where: { userId: tester.user.id, idempotencyKey: mcpChainExportKey(autoRootId) } });
    check("the chained export was enqueued at the preview's finish", !!exportRow && exportRow.status === "queued", String(exportRow?.status));
    const exDone = await runJob(exportRow!.id, tester.user.id);
    check("the export runs to done", exDone.status === "done", String(exDone.errorMessage));
    const final = await status(tester, autoRootId);
    check("get_video_status → done with videoUrl + editorUrl", final.status === "done" && typeof final.videoUrl === "string" && typeof final.editorUrl === "string", JSON.stringify(final));
    const renders = await prisma.renderJob.findMany({ where: { userId: tester.user.id, parentJobId: { in: [autoRootId, exportRow!.id] } } });
    check("the existing funding path charged once, after the import was ready (base render only; burn free)",
      renders.filter((r) => r.reservedQuota).length === 1 && renders.every((r) => r.createdAt.getTime() >= ready.updatedAt.getTime()), JSON.stringify(renders.map((r) => [r.type, r.reservedQuota])));
  });

  // ── D ──
  await section("D) upload path + fillYourself + hold: every window goes to the presenter; held; window 0 editable", async () => {
    const link = await callTool(tester.token, "create_upload_url", { kind: "presenter" });
    check("create_upload_url(presenter) issued a link", typeof link.uploadId === "string" && typeof link.uploadUrl === "string", JSON.stringify(link));
    const early = await callTool(tester.token, TOOL, { clipUploadId: link.uploadId, cutawayLayout: "fillYourself", exportMode: "hold" });
    check("clipUploadId before its PUT → invalid_input (no job)", early.error === "invalid_input" && checkFailureEnvelope(early).length === 0, JSON.stringify(early));
    const put = await putUpload(String(link.uploadUrl), portrait);
    check("PUT accepted (202)", put.status === 202, `${put.status} ${await put.clone().text()}`);
    check("the lane settles the upload", await runLane());
    const ready = await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(link.uploadId) } });
    check("presenter upload ready", ready.status === "ready" && ready.purpose === "presenter" && /^\/api\/renders\/presenter-import-/.test(ready.resultSrc ?? ""), JSON.stringify(ready));

    const reply = await callTool(tester.token, TOOL, { clipUploadId: link.uploadId, cutawayLayout: "fillYourself", exportMode: "hold", idempotencyKey: "cij-fill-1" });
    check("create accepted (hold)", typeof reply.jobId === "string" && reply.status === "queued" && reply.exportMode === "hold", JSON.stringify(reply));
    const row = await jobRow(reply.jobId);
    const input = inputOf(row);
    check("a ready upload is promoted at once: queued with clipUrl", row.status === "queued" && input.clipUrl === ready.resultSrc && input.clipImportId === ready.id, `${row.status} ${JSON.stringify(input)}`);
    check("fillYourself = auto B-roll off (stockSource none), held root", input.cutawayLayout === "fillYourself" && input.stockSource === "none" && input.mcpHold === true && input.mcpChainExport !== true, JSON.stringify(input));

    callerLog.length = 0;
    const done = await runJob(row.id, tester.user.id);
    check("the preview runs to done", done.status === "done", String(done.errorMessage));
    const composite = calls("/api/heygen/composite")[0]?.body as Json | undefined;
    const personRanges = (composite?.personRanges ?? []) as Array<{ start: number; end: number }>;
    const covered = personRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
    check("fillYourself: the presenter covers every window (whole clip)", personRanges.length > 0 && personRanges[0].start === 0
      && Math.abs(covered - CLIP_MS / 1000) < 0.01, JSON.stringify(personRanges));
    check("fillYourself: no stock or keyword spend", calls("/api/videos/fetch-stock").length === 0 && calls("/api/videos/extract-keywords").length === 0,
      callerLog.map((c) => c.path).join(","));
    const output = parseVideoJobOutput(done.outputJson);
    const previewRanges = (output?.preview?.cutawayPersonRanges ?? []) as Array<{ start: number; end: number }>;
    check("the preview records presenter-only windows", previewRanges.reduce((s, r) => s + (r.end - r.start), 0) > CLIP_MS / 1000 - 0.01, JSON.stringify(previewRanges));
    check("hold: no export was chained", (await prisma.videoJob.count({ where: { userId: tester.user.id, type: "export", inputJson: { contains: row.id } } })) === 0);
    const st = await status(tester, row.id);
    check("get_video_status → held with previewUrl + editorUrl", st.status === "held" && typeof st.previewUrl === "string" && typeof st.editorUrl === "string", JSON.stringify(st));
    const window0 = await callTool(tester.token, "replace_broll_window", { jobId: row.id, windowIndex: 0, source: "original" });
    check("fillYourself: window 0 is not locked to the presenter hook", window0.error !== "window_locked_presenter_hook", JSON.stringify(window0));
    await clearInflight(tester.user.id);
  });

  // ── E ──
  await section("E) import failure → the job fails with the import's code; zero net charge", async () => {
    // (1) landscape clip by url, settled by the watchdog sweep
    const landscapeUrl = clipLink("landscape");
    served.set(landscapeUrl, landscape);
    const before1 = await money(second.user.id);
    const r1 = await callTool(second.token, TOOL, { clipUrl: landscapeUrl, idempotencyKey: "cij-landscape" });
    check("landscape create accepted (waits)", typeof r1.jobId === "string" && (await jobRow(r1.jobId)).status === "waiting_import", JSON.stringify(r1));
    check("lane settles it", await runLane());
    await sweepStalledVideoJobs(new Date());
    const f1 = await jobRow(r1.jobId);
    check("landscape → job failed with errorCode not_portrait", f1.status === "failed" && f1.errorCode === "not_portrait" && /not_portrait/.test(f1.errorMessage ?? ""), `${f1.status} ${f1.errorCode} ${f1.errorMessage}`);
    check("…its project is back to draft", !!f1.projectId && (await prisma.editorProject.findUniqueOrThrow({ where: { id: f1.projectId } })).status === "draft");
    const s1 = await status(second, String(r1.jobId));
    check("get_video_status: failed, errorCode not_portrait, refunded, nothing pending", s1.status === "failed" && s1.errorCode === "not_portrait"
      && s1.refunded === true && s1.refundPending === false && typeof s1.userAction === "string", JSON.stringify(s1));
    check("zero net charge (no render, no minutes, no credits)", (await money(second.user.id)) === before1 && f1.fundingState === "none");

    // (2) over-duration clip by upload link, settled on read (get_video_status)
    const link = await callTool(second.token, "create_upload_url", { kind: "presenter" });
    const put = await putUpload(String(link.uploadUrl), longClip);
    check("long clip PUT accepted", put.status === 202, String(put.status));
    const before2 = await money(second.user.id);
    const r2 = await callTool(second.token, TOOL, { clipUploadId: link.uploadId, cutawayLayout: "fillYourself" });
    check("a pending upload → the job waits", typeof r2.jobId === "string" && (await jobRow(r2.jobId)).status === "waiting_import", JSON.stringify(r2));
    check("lane settles it", await runLane());
    const imp2 = await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(link.uploadId) } });
    check(`a ${longSec}s clip on PRO → import duration_exceeded`, imp2.status === "failed" && imp2.errorCode === "duration_exceeded", JSON.stringify(imp2));
    const s2 = await status(second, String(r2.jobId));
    check("settled on read: failed, errorCode duration_exceeded, refunded", s2.status === "failed" && s2.errorCode === "duration_exceeded" && s2.refunded === true, JSON.stringify(s2));
    check("zero net charge", (await money(second.user.id)) === before2);

    // (3) a download failure
    const brokenUrl = clipLink("broken");
    served.set(brokenUrl, new fetchMod.MediaFetchError("fetch_failed"));
    const r3 = await callTool(second.token, TOOL, { clipUrl: brokenUrl });
    check("lane settles it", await runLane());
    await sweepStalledVideoJobs(new Date());
    const f3 = await jobRow(r3.jobId);
    check("fetch failure → job failed with fetch_failed, nothing charged", f3.status === "failed" && f3.errorCode === "fetch_failed" && (await money(second.user.id)) === before2, `${f3.status} ${f3.errorCode}`);
    check("no failed job was ever claimable", (await claimNextRunnableJob()) === null);

    // (4) defence in depth: a waiting job that somehow holds a reservation gets it back.
    const failedImport = await prisma.mediaImport.create({
      data: { userId: third.user.id, purpose: "presenter", source: "upload", status: "failed", errorCode: "probe_failed", deadlineAt: new Date(Date.now() + 60_000) },
    });
    const usedBefore = (await prisma.user.findUniqueOrThrow({ where: { id: third.user.id } })).minutesUsed;
    const funded = await createVideoJob(third.user.id, { script: "", mode: "upload", clipImportId: failedImport.id, previewMode: true }, "cij-funded", {
      initialStatus: "waiting_import",
      funding: { meteredMinutes: 2, creditsLive: false },
    } as never);
    const usedReserved = (await prisma.user.findUniqueOrThrow({ where: { id: third.user.id } })).minutesUsed;
    check("fixture: the waiting row holds a 2-minute reservation", funded.status === "waiting_import" && funded.fundingState === "reserved" && usedReserved === usedBefore + 2,
      `${funded.status} ${funded.fundingState} ${usedBefore}→${usedReserved}`);
    await sweepStalledVideoJobs(new Date());
    const refundedRow = await jobRow(funded.id);
    const usedAfter = (await prisma.user.findUniqueOrThrow({ where: { id: third.user.id } })).minutesUsed;
    check("import failed → job failed probe_failed and the reservation is refunded", refundedRow.status === "failed" && refundedRow.errorCode === "probe_failed"
      && refundedRow.fundingState === "refunded" && usedAfter === usedBefore, `${refundedRow.status} ${refundedRow.errorCode} ${refundedRow.fundingState} minutes ${usedAfter}`);
  });

  // ── F ──
  await section("F) A10: a waiting job holds no worker slot, but counts toward the in-flight cap of 3", async () => {
    const url = clipLink("slot");
    served.set(url, portrait);
    const waiting = await callTool(capper.token, TOOL, { clipUrl: url, idempotencyKey: "cij-slot-1" });
    check("waiting job created", typeof waiting.jobId === "string" && (await jobRow(waiting.jobId)).status === "waiting_import");
    const plain = await createVideoJob(capper.user.id, { script: SCRIPT }, "cij-slot-plain");
    const claimed = await claimNextRunnableJob();
    check("the worker claims the later plain job, never the waiting one", claimed?.id === plain.id, String(claimed?.id));
    check("the waiting job is untouched", (await jobRow(waiting.jobId)).status === "waiting_import");
    await prisma.videoJob.update({ where: { id: plain.id }, data: { status: "canceled" } });
    check("toPublicVideoJobStatus(waiting_import) = queued", toPublicVideoJobStatus("waiting_import") === "queued");
    check("waiting_import is an in-flight status", (VIDEO_JOB_INFLIGHT_STATUSES as readonly string[]).includes("waiting_import"));
    for (const n of [2, 3]) {
      const extra = clipLink(`slot-${n}`);
      served.set(extra, portrait);
      const r = await callTool(capper.token, TOOL, { clipUrl: extra, idempotencyKey: `cij-slot-${n}` });
      check(`waiting job ${n} accepted`, typeof r.jobId === "string", JSON.stringify(r));
    }
    const importsBefore = await prisma.mediaImport.count({ where: { userId: capper.user.id } });
    const capped = await callTool(capper.token, TOOL, { clipUrl: clipLink("slot-4"), idempotencyKey: "cij-slot-4" });
    check("a 4th in-flight job → too_many_jobs, and no import was queued", capped.error === "too_many_jobs"
      && (await prisma.mediaImport.count({ where: { userId: capper.user.id } })) === importsBefore, JSON.stringify(capped));
  });

  // ── G ──
  await section("G) cancel while waiting: the job never runs after its import is ready", async () => {
    const waiting = await prisma.videoJob.findFirstOrThrow({ where: { userId: capper.user.id, status: "waiting_import" }, orderBy: { createdAt: "asc" } });
    const cancel = await callTool(capper.token, "cancel_video_job", { id: waiting.id });
    check("cancel_video_job on a waiting job → canceled", (await jobRow(waiting.id)).status === "canceled", JSON.stringify(cancel));
    const canceledImport = await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(inputOf(waiting).clipImportId) } });
    check("SEC-A6: its url import is canceled with the job (failed canceled, link cleared)",
      canceledImport.status === "failed" && canceledImport.errorCode === "canceled" && canceledImport.sourceUrl === null, JSON.stringify(canceledImport));
    check("the lane settles the remaining imports", await runLane());
    await sweepStalledVideoJobs(new Date());
    const after = await jobRow(waiting.id);
    check("the canceled job stays canceled and never gets a clipUrl", after.status === "canceled" && !("clipUrl" in inputOf(after)), `${after.status} ${after.inputJson}`);
    const others = await prisma.videoJob.findMany({ where: { userId: capper.user.id, status: "queued" } });
    check("the other waiting jobs were promoted", others.length === 2 && others.every((row) => typeof inputOf(row).clipUrl === "string"), String(others.length));
    await clearInflight(capper.user.id);
  });

  // ── shared by K–O ──
  const freshJobsOff = async () => {
    await prisma.videoJob.updateMany({ where: { status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } }, data: { status: "canceled", finishedAt: new Date() } });
  };
  const newPresenterOutputs = () => listPresenterOutputs().filter((name) => !presenterOutputsBefore.has(name));
  const tempLeft = () => (fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : []);
  const stagingDir = path.join(os.tmpdir(), "heroai-media-import");
  const stagingLeft = () => (fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []);
  const importOf = async (jobId: unknown) => prisma.mediaImport.findUniqueOrThrow({ where: { id: String(inputOf(await jobRow(jobId)).clipImportId) } });

  // ── K ──
  await section("K) SEC-B1: the lane keeps the free-disk floor on every disk it writes to; fails closed storage_busy, zero net charge", async () => {
    const disk = await makeUser("u-cij-disk", "qa-cij-disk@aoacademy.co");
    const rendersAbs = path.resolve(rendersDir);
    const outputsBefore = newPresenterOutputs().length;

    // (1) the presenter output disk (public/renders) is full before the fetch: nothing is downloaded.
    const url1 = clipLink("disk-full-before");
    served.set(url1, portrait);
    const money1 = await money(disk.user.id);
    const r1 = await callTool(disk.token, TOOL, { clipUrl: url1, idempotencyKey: "cij-disk-1" });
    check("create accepted (waits)", typeof r1.jobId === "string" && (await jobRow(r1.jobId)).status === "waiting_import", JSON.stringify(r1));
    diskFake.fullDir = rendersAbs;
    diskFake.asked.length = 0;
    const fetchesBefore = fetchCalls.length;
    check("the lane settles it", await runLane());
    diskFake.fullDir = null;
    const imp1 = await importOf(r1.jobId);
    check("output disk below the floor → import failed storage_busy", imp1.status === "failed" && imp1.errorCode === "storage_busy" && imp1.resultSrc === null, JSON.stringify(imp1));
    check("the floor was measured on the disk the output is written to (public/renders)", diskFake.asked.includes(rendersAbs), JSON.stringify([...new Set(diskFake.asked)]));
    check("…and on the fetch/staging disk", diskFake.asked.some((dir) => dir.startsWith(privateTmp)), JSON.stringify([...new Set(diskFake.asked)]));
    check("checked before fetching: the url was never downloaded", fetchCalls.length === fetchesBefore && !fetchCalls.some((c) => c.url === url1));
    check("no file written (no presenter output, no temp, no staged file)",
      newPresenterOutputs().length === outputsBefore && tempLeft().length === 0 && stagingLeft().length === 0,
      JSON.stringify({ outputs: newPresenterOutputs(), temp: tempLeft(), staging: stagingLeft() }));
    await sweepStalledVideoJobs(new Date());
    const f1 = await jobRow(r1.jobId);
    check("the clip job fails with errorCode storage_busy (Thai hint, nothing started)", f1.status === "failed" && f1.errorCode === "storage_busy"
      && /storage_busy/.test(f1.errorMessage ?? "") && /พื้นที่/.test(f1.errorMessage ?? ""), `${f1.status} ${f1.errorCode} ${f1.errorMessage}`);
    const s1 = await status(disk, String(r1.jobId));
    check("get_video_status: failed storage_busy, refunded, nothing pending", s1.status === "failed" && s1.errorCode === "storage_busy" && s1.refunded === true && s1.refundPending === false, JSON.stringify(s1));
    check("net charge 0", (await money(disk.user.id)) === money1 && f1.fundingState === "none");

    // (2) room at fetch time, the output disk fills while downloading: refused before persisting.
    const url2 = clipLink("disk-full-after");
    served.set(url2, portrait);
    duringFetch.set(url2, () => { diskFake.fullDir = rendersAbs; });
    const money2 = await money(disk.user.id);
    const r2 = await callTool(disk.token, TOOL, { clipUrl: url2, idempotencyKey: "cij-disk-2" });
    check("the lane settles it", await runLane());
    diskFake.fullDir = null;
    duringFetch.delete(url2);
    const imp2 = await importOf(r2.jobId);
    check("floor breached after the download → storage_busy before persisting", imp2.status === "failed" && imp2.errorCode === "storage_busy", JSON.stringify(imp2));
    check("…the download did run", fetchCalls.some((c) => c.url === url2));
    check("…and nothing persisted: no presenter output, the downloaded and staged files deleted",
      newPresenterOutputs().length === outputsBefore && tempLeft().length === 0 && stagingLeft().length === 0,
      JSON.stringify({ outputs: newPresenterOutputs(), temp: tempLeft(), staging: stagingLeft() }));
    await sweepStalledVideoJobs(new Date());
    const f2 = await jobRow(r2.jobId);
    check("the clip job fails storage_busy with net charge 0", f2.status === "failed" && f2.errorCode === "storage_busy" && (await money(disk.user.id)) === money2, `${f2.status} ${f2.errorCode}`);

    // (3) statfs cannot answer: fail closed.
    const url3 = clipLink("disk-unknown");
    served.set(url3, portrait);
    const r3 = await callTool(disk.token, TOOL, { clipUrl: url3, idempotencyKey: "cij-disk-3" });
    diskFake.broken = true;
    check("the lane settles it", await runLane());
    diskFake.broken = false;
    const imp3 = await importOf(r3.jobId);
    check("statfs failing → storage_busy (fail closed), never fetched", imp3.status === "failed" && imp3.errorCode === "storage_busy" && !fetchCalls.some((c) => c.url === url3), JSON.stringify(imp3));

    // (4) with room, the same clip imports normally (the floor is not a blanket refusal).
    const url4 = clipLink("disk-ok");
    served.set(url4, portrait);
    const r4 = await callTool(disk.token, TOOL, { clipUrl: url4, idempotencyKey: "cij-disk-4" });
    check("the lane settles it", await runLane());
    check("with room on every disk → ready", (await importOf(r4.jobId)).status === "ready");
    check("storage_busy is in the lane's fixed code vocabulary", (lane.MEDIA_IMPORT_LANE_ERROR_CODES as readonly string[]).includes("storage_busy"));
    await clearInflight(disk.user.id);
  });

  // ── L ──
  await section("L) SEC-A6 / T14-A3: canceling (or abandoning) a waiting clip job cancels its url import", async () => {
    const canceler = await makeUser("u-cij-cancel", "qa-cij-cancel@aoacademy.co");
    const outputsBefore = newPresenterOutputs().length;

    // (1) import still queued: canceled at once, never fetched.
    const url1 = clipLink("cancel-queued");
    served.set(url1, portrait);
    const money1 = await money(canceler.user.id);
    const r1 = await callTool(canceler.token, TOOL, { clipUrl: url1, idempotencyKey: "cij-cancel-1" });
    const cancel1 = await callTool(canceler.token, "cancel_video_job", { id: r1.jobId });
    const imp1 = await importOf(r1.jobId);
    check("cancel_video_job → job canceled", (await jobRow(r1.jobId)).status === "canceled", JSON.stringify(cancel1));
    check("…its queued url import is failed canceled at once, link cleared", imp1.status === "failed" && imp1.errorCode === "canceled" && imp1.sourceUrl === null, JSON.stringify(imp1));
    check("the lane settles", await runLane());
    check("…and never fetches it", !fetchCalls.some((c) => c.url === url1));
    check("net charge 0", (await money(canceler.user.id)) === money1);

    // (2) import claimed and downloading: the fetch is aborted at the lane's next checkpoint.
    const url2 = clipLink("cancel-downloading");
    served.set(url2, portrait);
    slowUrls.add(url2);
    slowState.startedAt = 0; slowState.abortedAt = 0;
    const r2 = await callTool(canceler.token, TOOL, { clipUrl: url2, idempotencyKey: "cij-cancel-2" });
    const l2 = newLane({ cancelCheckMs: 25 });
    l2.start();
    check("the lane claims it and starts downloading", await waitFor(() => slowState.startedAt > 0, 10_000));
    const canceledAt = Date.now();
    await callTool(canceler.token, "cancel_video_job", { id: r2.jobId });
    const stopped = await waitFor(async () => l2.inFlight === 0 && slowState.abortedAt > 0, 20_000);
    await l2.stop();
    slowUrls.delete(url2);
    check("the in-flight download was aborted promptly (≤ 3 s after the cancel)", stopped && slowState.abortedAt - canceledAt <= 3_000,
      `aborted=${slowState.abortedAt ? slowState.abortedAt - canceledAt : "never"} ms`);
    const imp2 = await importOf(r2.jobId);
    check("…the import stays failed canceled", imp2.status === "failed" && imp2.errorCode === "canceled" && imp2.resultSrc === null, JSON.stringify(imp2));
    check("…no partial, staged or output file is left",
      tempLeft().length === 0 && stagingLeft().length === 0 && newPresenterOutputs().length === outputsBefore,
      JSON.stringify({ temp: tempLeft(), staging: stagingLeft(), outputs: newPresenterOutputs() }));

    // (3) cancel lands while the downloaded clip is being processed: its output is deleted, never published.
    const url3 = clipLink("cancel-processing");
    served.set(url3, portrait);
    const r3 = await callTool(canceler.token, TOOL, { clipUrl: url3, idempotencyKey: "cij-cancel-3" });
    const stagingMod = fromSrc("lib/media-import/upload-staging") as typeof import("../src/lib/media-import/upload-staging");
    let canceledMidProcess = false;
    check("the lane settles it", await runLane({
      processStaged: async (params) => {
        await callTool(canceler.token, "cancel_video_job", { id: r3.jobId });
        canceledMidProcess = true;
        return stagingMod.processStagedUpload(params);
      },
    }));
    const imp3 = await importOf(r3.jobId);
    check("canceled mid-processing → import failed canceled, no resultSrc", canceledMidProcess && imp3.status === "failed" && imp3.errorCode === "canceled" && imp3.resultSrc === null, JSON.stringify(imp3));
    check("…its presenter output was deleted, not published", newPresenterOutputs().length === outputsBefore && stagingLeft().length === 0, JSON.stringify(newPresenterOutputs()));
    check("…and the job stays canceled", (await jobRow(r3.jobId)).status === "canceled");

    // (4) the web DELETE path shares the same core.
    const { cancelVideoJobCore } = fromSrc("lib/mcp/video-job-cancel-core") as typeof import("../src/lib/mcp/video-job-cancel-core");
    const url4 = clipLink("cancel-web");
    served.set(url4, portrait);
    const r4 = await callTool(canceler.token, TOOL, { clipUrl: url4, idempotencyKey: "cij-cancel-4" });
    const webCancel = await cancelVideoJobCore(canceler.user.id, String(r4.jobId), "[api/videos/jobs/:id]");
    const imp4 = await importOf(r4.jobId);
    check("web cancel core → job canceled and its url import failed canceled", webCancel.kind === "canceled" && imp4.status === "failed" && imp4.errorCode === "canceled", JSON.stringify(imp4));

    // (5) someone else cannot cancel it, and a cancel never reaches another user's import.
    const url5 = clipLink("cancel-foreign");
    served.set(url5, portrait);
    const r5 = await callTool(canceler.token, TOOL, { clipUrl: url5, idempotencyKey: "cij-cancel-5" });
    const foreign = await callTool(third.token, "cancel_video_job", { id: r5.jobId });
    const imp5 = await importOf(r5.jobId);
    check("another user's cancel → refused; the job and its import are untouched",
      (await jobRow(r5.jobId)).status === "waiting_import" && imp5.status === "pending", `${JSON.stringify(foreign)} ${imp5.status}`);
    const forged = await createVideoJob(third.user.id, { script: "", mode: "upload", clipImportId: imp5.id, previewMode: true }, "cij-cancel-forged", { initialStatus: "waiting_import" } as never);
    await callTool(third.token, "cancel_video_job", { id: forged.id });
    check("a job naming another user's import id cannot cancel that import", (await prisma.mediaImport.findUniqueOrThrow({ where: { id: imp5.id } })).status === "pending");
    await callTool(canceler.token, "cancel_video_job", { id: r5.jobId });

    // (6) an upload is the agent's own file: canceling the job leaves it to finish and be reused.
    const link = await callTool(canceler.token, "create_upload_url", { kind: "presenter" });
    const put = await putUpload(String(link.uploadUrl), portrait);
    check("presenter PUT accepted", put.status === 202, String(put.status));
    const r6 = await callTool(canceler.token, TOOL, { clipUploadId: link.uploadId, idempotencyKey: "cij-cancel-6" });
    check("a pending upload → the job waits", (await jobRow(r6.jobId)).status === "waiting_import", JSON.stringify(r6));
    await callTool(canceler.token, "cancel_video_job", { id: r6.jobId });
    check("canceling it leaves the upload import pending", (await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(link.uploadId) } })).status === "pending");
    check("the lane settles it", await runLane());
    check("…and it becomes ready for reuse", (await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(link.uploadId) } })).status === "ready");

    // (7) abandon (the job was never created): a url import this call queued is canceled; an upload is not.
    const clipMod = fromSrc("lib/mcp/clip-video-job") as typeof import("../src/lib/mcp/clip-video-job");
    const abandoned = await clipMod.startClipImport(canceler.user.id, { kind: "url", url: clipLink("abandon") });
    if (!abandoned.ok) throw new Error(`fixture: ${JSON.stringify(abandoned.failure)}`);
    await clipMod.abandonClipImport(abandoned.started);
    const imp7 = await prisma.mediaImport.findUniqueOrThrow({ where: { id: abandoned.started.importId } });
    check("abandonClipImport → the url import it queued is failed canceled", imp7.status === "failed" && imp7.errorCode === "canceled", JSON.stringify(imp7));
    await clipMod.abandonClipImport({ importId: String(link.uploadId), createdHere: false });
    check("abandonClipImport never touches the agent's upload", (await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(link.uploadId) } })).status === "ready");
    await clearInflight(canceler.user.id);
  });

  // ── M ──
  await section("M) T14-A2: a duplicate idempotencyKey returns the existing job before any import starts", async () => {
    const duper = await makeUser("u-cij-dup", "qa-cij-dup@aoacademy.co");
    const url = clipLink("dup");
    served.set(url, portrait);
    const first = await callTool(duper.token, TOOL, { clipUrl: url, idempotencyKey: "cij-dup-1" });
    check("first create accepted", typeof first.jobId === "string", JSON.stringify(first));
    const imports0 = await prisma.mediaImport.count({ where: { userId: duper.user.id } });
    const jobs0 = await prisma.videoJob.count({ where: { userId: duper.user.id } });
    const retry = await callTool(duper.token, TOOL, { clipUrl: url, idempotencyKey: "cij-dup-1" });
    check("retry with the same key → duplicate, naming the existing job", retry.error === "duplicate" && retry.jobId === first.jobId && retry.status === "queued"
      && checkFailureEnvelope(retry).length === 0, JSON.stringify(retry));
    check("…no second import, no second job", (await prisma.mediaImport.count({ where: { userId: duper.user.id } })) === imports0
      && (await prisma.videoJob.count({ where: { userId: duper.user.id } })) === jobs0);

    // At the active-import cap, a retry still answers duplicate (never too_many_active_imports).
    const importsMod = fromSrc("lib/media-import/imports") as typeof import("../src/lib/media-import/imports");
    for (let i = 0; i < importsMod.MAX_ACTIVE_IMPORTS; i += 1) {
      const filler = await importsMod.createUrlImport(duper.user.id, clipLink(`dup-filler-${i}`), new Date(), "broll_video");
      if (!filler.ok && filler.code !== "too_many_active_imports") throw new Error(`fixture: ${filler.code}`);
    }
    const capped = await callTool(duper.token, TOOL, { clipUrl: clipLink("dup-new"), idempotencyKey: "cij-dup-2" });
    check("fixture: a new clip is refused at the active-import cap", capped.error === "too_many_active_imports", JSON.stringify(capped));
    const imports1 = await prisma.mediaImport.count({ where: { userId: duper.user.id } });
    const retryAtCap = await callTool(duper.token, TOOL, { clipUrl: url, idempotencyKey: "cij-dup-1" });
    check("retry at the active-import cap → duplicate with the existing job, not too_many_active_imports",
      retryAtCap.error === "duplicate" && retryAtCap.jobId === first.jobId, JSON.stringify(retryAtCap));
    check("…and no import row was created or canceled", (await prisma.mediaImport.count({ where: { userId: duper.user.id } })) === imports1
      && (await prisma.mediaImport.count({ where: { userId: duper.user.id, errorCode: "canceled" } })) === 0);

    // At the in-flight job cap, too.
    for (const n of [2, 3]) await createVideoJob(duper.user.id, { script: SCRIPT }, `cij-dup-plain-${n}`);
    const retryAtJobCap = await callTool(duper.token, TOOL, { clipUrl: url, idempotencyKey: "cij-dup-1" });
    check("retry at the in-flight job cap → duplicate, not too_many_jobs", retryAtJobCap.error === "duplicate" && retryAtJobCap.jobId === first.jobId, JSON.stringify(retryAtJobCap));
    await clearInflight(duper.user.id);
    await prisma.mediaImport.updateMany({ where: { userId: duper.user.id, status: { in: ["pending", "processing"] } }, data: { status: "failed", errorCode: "canceled", sourceUrl: null } });

    // A server-reserved key never starts an import either.
    const importsBefore = await prisma.mediaImport.count({ where: { userId: duper.user.id } });
    const reserved = await callTool(duper.token, TOOL, { clipUrl: clipLink("dup-reserved"), idempotencyKey: `${mcpChainExportKey("x")}` });
    check("a reserved mcp-chain: key → duplicate envelope, no import", reserved.error === "duplicate" && checkFailureEnvelope(reserved).length === 0
      && (await prisma.mediaImport.count({ where: { userId: duper.user.id } })) === importsBefore, JSON.stringify(reserved));

    // Keys are per user: another user's identical key is a fresh create, and never sees the first job.
    const other = await callTool(third.token, TOOL, { clipUrl: clipLink("dup-other-user"), idempotencyKey: "cij-dup-1" });
    check("same key, another user → a new job of its own", typeof other.jobId === "string" && other.jobId !== first.jobId && other.error === undefined, JSON.stringify(other));
    await clearInflight(third.user.id);
  });

  // ── N ──
  await section("N) T14-A4: input.clipUrl only ever takes the lane's exact presenter output name", async () => {
    const { allowlistedClipSrc } = fromSrc("lib/mcp/clip-video-job") as typeof import("../src/lib/mcp/clip-video-job");
    const presenterChecks = fromSrc("lib/media-import/presenter-checks") as typeof import("../src/lib/media-import/presenter-checks");
    const real = [`/api/renders/${presenterChecks.presenterOutputFilename("mp4")}`, `/api/renders/${presenterChecks.presenterOutputFilename("webm")}`];
    for (const src of real) check(`the lane's own output name is allowed: ${src.replace(/\d{6,}-[0-9a-f-]+/, "<ts>-<uuid>")}`, allowlistedClipSrc(src) === src);
    const id = "1696300000000-123e4567-e89b-42d3-a456-426614174000";
    const refused = [
      `/api/renders/presenter-import-${id}.mov`,
      `/api/renders/presenter-import-${id}.mp4.html`,
      `/api/renders/presenter-import-${id}.mp4?x=1`,
      `/api/renders/presenter-import-${id}.mp4#x`,
      `/api/renders/../stocks/presenter-import-${id}.mp4`,
      `/api/renders/./presenter-import-${id}.mp4`,
      `/api/renders/sub/presenter-import-${id}.mp4`,
      `/api/renders//presenter-import-${id}.mp4`,
      `/api/renders/presenter-import-${id}.mp4/..`,
      `/api/renders/presenter-import-..%2f${id}.mp4`,
      `/api/renders/presenter-import-%2e%2e.mp4`,
      `/api/renders\\presenter-import-${id}.mp4`,
      `/api/renders/presenter-import-${id}.mp4\n`,
      `/api/renders/presenter-import-${id.toUpperCase()}.mp4`,
      `/api/renders/presenter-import-foreign.mp4`,
      "/api/renders/presenter-import-.mp4",
      "/api/renders/rj-123-base.mp4",
      `/api/stocks/presenter-import-${id}.mp4`,
      `/renders/presenter-import-${id}.mp4`,
      `/uploads/presenter-import-${id}.mp4`,
      `//evil.example/api/renders/presenter-import-${id}.mp4`,
      `https://evil.example/api/renders/presenter-import-${id}.mp4`,
      `api/renders/presenter-import-${id}.mp4`,
      "",
    ];
    const leaked = refused.filter((src) => allowlistedClipSrc(src) !== null);
    check(`${refused.length} near-miss / path-trick sources are all refused`, leaked.length === 0, JSON.stringify(leaked));
    check("non-strings are refused", allowlistedClipSrc(null) === null && allowlistedClipSrc(undefined) === null);

    // A ready import whose stored result sits outside the presenter prefix never becomes input.clipUrl.
    const nUser = await makeUser("u-cij-allow", "qa-cij-allow@aoacademy.co");
    const odd = await prisma.mediaImport.create({
      data: { userId: nUser.user.id, purpose: "presenter", source: "upload", status: "ready", resultSrc: "/api/stocks/broll-upload-own.mp4", durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000) },
    });
    const reply = await callTool(nUser.token, TOOL, { clipUploadId: odd.id, idempotencyKey: "cij-allow-1" });
    const row = await jobRow(reply.jobId);
    check("a ready import outside /api/renders/presenter-import-… → the job fails import_failed, no clipUrl",
      row.status === "failed" && row.errorCode === "import_failed" && !("clipUrl" in inputOf(row)), `${row.status} ${row.errorCode} ${row.inputJson}`);
  });

  // ── O ──
  await section("O) SEC-A5: a waiting_import job whose import can no longer finish does not hold the deploy drain", async () => {
    const { readRenderQueueCounts } = fromSrc("lib/render-deploy-drain") as typeof import("../src/lib/render-deploy-drain");
    const drainer = await makeUser("u-cij-drain", "qa-cij-drain@aoacademy.co");
    await freshJobsOff();
    await prisma.renderJob.updateMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "DONE" } });
    check("fixture: both queues start empty", (await readRenderQueueCounts()).empty === true, JSON.stringify(await readRenderQueueCounts()));
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 10 * 60_000);
    const imp = (status: string, deadlineAt: Date, userId = drainer.user.id) => prisma.mediaImport.create({
      data: { userId, purpose: "presenter", source: "url", status, deadlineAt, sourceUrl: status === "pending" || status === "processing" ? "https://media.example.test/x.mp4" : null,
        ...(status === "ready" ? { resultSrc: "/api/renders/presenter-import-1-123e4567-e89b-42d3-a456-426614174000.mp4", durationMs: 2_000 } : {}) },
    });
    let seq = 0;
    const park = async (clipImportId: string) => {
      seq += 1;
      return createVideoJob(drainer.user.id, { script: "", mode: "upload", clipImportId, previewMode: true }, `cij-drain-${seq}`, { initialStatus: "waiting_import" } as never);
    };
    const counted = async () => (await readRenderQueueCounts()).videoJobs;

    // The lane is down: nothing claims, nothing settles, no watchdog runs.
    await park((await imp("pending", future)).id);
    check("waiting on a live pending import → counted (it can still render)", (await counted()) === 1);
    await park((await imp("processing", future)).id);
    check("waiting on a live processing import → counted", (await counted()) === 2);
    await park((await imp("ready", past)).id);
    check("waiting on a ready import (not yet settled) → counted", (await counted()) === 3);
    await park((await imp("pending", past)).id);
    check("waiting on a pending import past its deadline (lane down) → not counted", (await counted()) === 3);
    await park((await imp("processing", past)).id);
    check("waiting on a processing import past its deadline → not counted", (await counted()) === 3);
    await park((await imp("failed", future)).id);
    check("waiting on a failed import → not counted", (await counted()) === 3);
    await park(randomUUID());
    check("waiting on a missing import → not counted", (await counted()) === 3);
    await park((await imp("pending", future, third.user.id)).id);
    check("waiting on another user's live import id → not counted", (await counted()) === 3);
    await createVideoJob(drainer.user.id, { script: SCRIPT }, "cij-drain-plain");
    check("a queued job still counts as before", (await counted()) === 4);
    await freshJobsOff();
    check("drained: empty", (await readRenderQueueCounts()).empty === true);

    // End to end: an MCP clip job whose import's deadline passed while the lane was down.
    const url = clipLink("drain-lane-down");
    served.set(url, portrait);
    const r = await callTool(drainer.token, TOOL, { clipUrl: url, idempotencyKey: "cij-drain-e2e" });
    check("a fresh clip job holds the drain", (await readRenderQueueCounts()).empty === false);
    await prisma.mediaImport.update({ where: { id: (await importOf(r.jobId)).id }, data: { deadlineAt: past } });
    const counts = await readRenderQueueCounts();
    check("once its import is past the deadline, the drain sees empty queues", counts.empty === true && counts.videoJobs === 0, JSON.stringify(counts));
    check("…the job itself is unchanged: still waiting_import, still in-flight for the user's cap", (await jobRow(r.jobId)).status === "waiting_import"
      && (await prisma.videoJob.count({ where: { userId: drainer.user.id, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } } })) === 1);
    const cancel = await callTool(drainer.token, "cancel_video_job", { id: r.jobId });
    check("…and still cancelable", (await jobRow(r.jobId)).status === "canceled", JSON.stringify(cancel));
    await prisma.mediaImport.updateMany({ where: { userId: { in: [drainer.user.id, third.user.id] }, status: { in: ["pending", "processing"] } }, data: { status: "failed", errorCode: "canceled", sourceUrl: null } });
  });

  // ── H ──
  await section("H) audit: clipUrl redacted; no agent url in replies, logs or audit rows", async () => {
    const audits = await prisma.toolCallAudit.findMany({ where: { toolName: TOOL }, select: { requestJson: true, status: true } });
    check("create_video_job calls are audited", audits.length > 0, String(audits.length));
    check("no audit row stores an agent url or its query secret",
      !audits.some((row) => (row.requestJson ?? "").includes(URL_HOST) || (row.requestJson ?? "").includes(SECRET)),
      audits.map((row) => row.requestJson).filter((json) => (json ?? "").includes(URL_HOST)).slice(0, 2).join(" | "));
    check("a clipUrl audit row keeps the redaction marker", audits.some((row) => /"clipUrl":"\[redacted \d+ chars\]"/.test(row.requestJson ?? "")));
    check("in-band refusals are audited as error/denied", audits.some((row) => row.status === "error") && audits.some((row) => row.status === "denied"));
    check("no reply ever carried an agent url or its query secret",
      !replies.some((r) => r.text.includes(URL_HOST) || r.text.includes(SECRET)), replies.filter((r) => r.text.includes(URL_HOST)).map((r) => r.tool).join(","));
    check("no lane log line carried an agent url", !laneLog.some((line) => line.includes(URL_HOST)));
    const jobs = await prisma.videoJob.findMany({ select: { inputJson: true, errorMessage: true } });
    check("no job row stores an agent url", !jobs.some((row) => row.inputJson.includes(URL_HOST) || (row.errorMessage ?? "").includes(URL_HOST)));
    const finished = await prisma.mediaImport.findMany({ where: { status: { in: ["ready", "failed"] }, source: "url" }, select: { sourceUrl: true } });
    check("finished url imports keep no copy of the link", finished.length > 0 && finished.every((row) => row.sourceUrl === null));
  });

  // ── I ──
  await section("I) create_video_job without the new fields is unchanged (regression)", async () => {
    const plain = await callTool(tester.token, TOOL, { script: SCRIPT, voiceProvider: "gemini", idempotencyKey: "cij-plain-1" });
    check("plain create accepted (queued)", typeof plain.jobId === "string" && plain.status === "queued", JSON.stringify(plain));
    const row = await jobRow(plain.jobId);
    const input = inputOf(row);
    check("plain job is queued (never waiting_import)", row.status === "queued");
    check("no T14 field leaks into a plain create input", !["mode", "clipImportId", "clipUrl", "cutawayLayout"].some((key) => key in input) && input.script === SCRIPT, JSON.stringify(Object.keys(input)));
    callerLog.length = 0;
    const done = await runJob(row.id, tester.user.id);
    check("the plain create still runs to done (TTS path)", done.status === "done" && calls("/api/videos/tts-gemini").length === 1, String(done.errorMessage));
    const outsiderCreate = await callTool(outsider.token, TOOL, { script: SCRIPT, voiceProvider: "gemini", idempotencyKey: "cij-plain-2" });
    check("non-beta plain create still accepted", typeof outsiderCreate.jobId === "string" && (await jobRow(outsiderCreate.jobId)).status === "queued", JSON.stringify(outsiderCreate));
    const hold = await callTool(outsider.token, TOOL, { script: SCRIPT, exportMode: "hold" });
    check("non-beta exportMode still → feature_not_enabled", hold.error === "feature_not_enabled", JSON.stringify(hold));
    const noScript = await callTool(outsider.token, TOOL, {});
    check("non-beta, no script → invalid_input envelope (script still required without a clip)", noScript.error === "invalid_input" && checkFailureEnvelope(noScript).length === 0, JSON.stringify(noScript));
  });

  // ── J ──
  await section("J) wiring + G14 envelopes", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    check("package.json: verify:mcp-clip-import-job", (pkg.scripts["verify:mcp-clip-import-job"] ?? "").includes("scripts/verify-mcp-clip-import-job.ts"));
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const install = ci.indexOf("sudo apt-get install -y --no-install-recommends ffmpeg");
    const run = ci.indexOf("npm run verify:mcp-clip-import-job");
    check("ci.yml runs it after ffmpeg is installed (G24 step)", install > 0 && run > install, `install=${install} run=${run}`);
    check("failures were exercised", failures.length >= 10, String(failures.length));
    for (const failure of failures) {
      const problems = checkFailureEnvelope(failure.reply);
      check(`${failure.tool} ${String(failure.reply.error)}: envelope`, problems.length === 0, `${problems.join("; ")} ${JSON.stringify(failure.reply)}`);
    }
    const worker = fs.readFileSync(path.join(ROOT, "scripts/mcp-video-worker.ts"), "utf8");
    check("the worker's claim loop is unchanged (no clip/import code in it)", !/clipImport|waiting_import/.test(worker));
  });

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error("FAIL: threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("MCP clip import job verification FAILED");
      process.exit(1);
    }
    console.log("MCP clip import job: all checks passed");
    process.exit(0);
  });
