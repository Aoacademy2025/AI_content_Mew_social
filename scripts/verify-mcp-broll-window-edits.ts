// verify-mcp-broll-window-edits.ts — Task 13 (PR-B, plan docs/plans/2026-10-03-mcp-edit-before-export.md,
// G19/G21/G27, ADR 0064/0065): `replace_broll_window` and `export_video` applying window edits.
//
// Every MCP call goes through the REAL route handler (only Clerk + the network key preflight are
// stubbed, same harness shape as verify-mcp-edit-tools.ts). Media Imports run through the REAL
// import lane and T9's REAL pipeline (real ffmpeg/ffprobe) with a fake fetch for url rows; the
// upload path goes through the REAL `PUT /api/mcp-uploads/<token>` route. The render routes are
// a stub that mirrors /api/videos/render's free paths (burn of a paid base; `rerenderOf` skip =
// paid source + rerenderSkipEligible + the 10/hour budget) and CHARGES anything else, so a
// regression that leaves the free path shows up as money moving. The real render route's
// refusal of a flagged job is proven by verify-mcp-chain-linkage.ts §S6/S7.
//
// Covers:
//   A. tools/list gating + agent-neutral schema; non-beta direct call → feature_not_enabled.
//   B. replace_broll_window validation (exactly one source, https only, window bounds, G27).
//   C. URL path end to end: import → imports_pending → lane (real pipeline, audio stripped) →
//      export_video → free rerender (window src set, brollEnabled, same voice) → the draft
//      rebased onto the rerender (G21: the web sees it) → chained export → done; no charge.
//   D. Upload-link path end to end (create_upload_url → PUT → lane → replace → export).
//   E. import_failed names the window; nothing is enqueued or charged.
//   F. export_not_free (unpaid base, rerender budget spent) before any write.
//   G. window 0 of an auto Cutaway Mode clip → window_locked_presenter_hook.
//   H. source:"original" — before export (drops the pending edit) and after a rerender
//      (re-renders the Base Render's own media back into the window).
//   I. restart: a lost rerender → export hop is recovered by the watchdog sweep and on read.
//   J. create_video_job without the new fields is unchanged (regression).
//   K. muting: the composition mutes every B-roll clip; the import output has no audio track.
//   L. wiring (package.json + CI after ffmpeg is installed), G14 envelopes, no url in replies/logs/audit.
//
// Self-contained: its own throwaway SQLite and a private TMPDIR. Needs real ffmpeg + ffprobe.
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-broll-window-edits.ts

import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { checkFailureEnvelope, verifyAgentNeutralSchemas } from "./mcp-agent-neutral-checks";

const ROOT = process.cwd();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-broll-window-edits-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
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

const NEW_TOOL = "replace_broll_window";
const CARD0_TEXT = "อยาก กินข้าวเย็นนี้";
const CARD1_TEXT = "ที่ร้านโปรด ของฉัน";
const SCRIPT = `${CARD0_TEXT} ${CARD1_TEXT}`;
const TIMING = {
  provider: "gemini",
  segments: [
    { text: CARD0_TEXT, startMs: 0, durationMs: 2_000 },
    { text: CARD1_TEXT, startMs: 2_000, durationMs: 2_000 },
  ],
};
const VOICE_FILE = "/api/renders/bwe-voice.wav";
const ORIGINAL_SRC = ["/api/stocks/bwe-original-a.mp4", "/api/stocks/bwe-original-b.mp4"];
const BASE_CONFIG = {
  durationInFrames: 120,
  voiceFile: VOICE_FILE,
  bgVideos: [
    { src: ORIGINAL_SRC[0], start: 0, end: 2, sourceIndex: 0, clipDuration: 4, provider: "pexels" },
    { src: ORIGINAL_SRC[1], start: 2, end: 4, sourceIndex: 1, clipDuration: 4, provider: "pexels" },
  ],
};
const PROVIDER_PATH = /tts|transcribe|split-script|extract-keywords|fetch-stock|generate-config|heygen|gemini|elevenlabs/i;

type Json = Record<string, unknown>;

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName,
  }).outputText;
}

async function main() {
  const realRequire = createRequire(path.join(ROOT, "scripts/verify-mcp-broll-window-edits.ts"));
  const fromSrc = (p: string) => realRequire(path.join(ROOT, "src", p));
  const { prisma } = fromSrc("lib/prisma") as typeof import("../src/lib/prisma");
  const { runOrchestrator } = fromSrc("lib/mcp/orchestrator") as typeof import("../src/lib/mcp/orchestrator");
  const { parseVideoJobOutput } = fromSrc("lib/mcp/video-job") as typeof import("../src/lib/mcp/video-job");
  const { createMcpToken } = fromSrc("lib/mcp/token") as typeof import("../src/lib/mcp/token");
  const { isBurnAlreadyPaid, recordChargedClip } = fromSrc("lib/clip-charge") as typeof import("../src/lib/clip-charge");
  const { rerenderSkipEligible } = fromSrc("lib/broll-rerender") as typeof import("../src/lib/broll-rerender");
  const budget = fromSrc("lib/rerender-skip-budget") as typeof import("../src/lib/rerender-skip-budget");
  const draftLib = fromSrc("lib/mcp/pending-edit-draft") as typeof import("../src/lib/mcp/pending-edit-draft");
  const keyPreflight = fromSrc("lib/key-preflight") as typeof import("../src/lib/key-preflight");
  const lane = fromSrc("lib/media-import/lane") as typeof import("../src/lib/media-import/lane");
  const imports = fromSrc("lib/media-import/imports") as typeof import("../src/lib/media-import/imports");
  const fetchMod = fromSrc("lib/media-import/fetch") as typeof import("../src/lib/media-import/fetch");
  const { getFfmpegPath } = fromSrc("lib/ffmpeg-path") as typeof import("../src/lib/ffmpeg-path");
  const { getFfprobePath } = fromSrc("lib/upload-media-probe") as typeof import("../src/lib/upload-media-probe");
  const { sweepStalledVideoJobs } = fromSrc("lib/mcp/video-job-watchdog") as typeof import("../src/lib/mcp/video-job-watchdog");
  const uploadRoute = fromSrc("app/api/mcp-uploads/[token]/route") as typeof import("../src/app/api/mcp-uploads/[token]/route");
  const { RENDER_DEPLOY_DRAIN_KEY } = fromSrc("lib/render-deploy-drain") as typeof import("../src/lib/render-deploy-drain");

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

  const fetchLog: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchLog.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  }) as typeof fetch;

  let rpcSeq = 0;
  async function rpc(token: string, method: string, params: unknown): Promise<Json> {
    rpcSeq += 1;
    const response = await ROUTE_POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "verify-mcp-broll-window-edits/1.0",
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
    if (reply.error != null && (name === NEW_TOOL || name === "export_video")) failures.push({ tool: name, reply });
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
    const { token } = await createMcpToken(id, "verify-mcp-broll-window-edits");
    return { user, token };
  }
  // Internal-tester emails pass the MCP Editor Project gate (and the B-roll window-edit beta).
  const tester = await makeUser("u-bwe", "qa-bwe@aoacademy.co");
  const second = await makeUser("u-bwe-2", "qa-bwe-2@aoacademy.co");
  const outsider = await makeUser("u-bwe-outsider", "bwe-outsider@example.com");

  // ── fixtures: real media (tiny) ──
  const ff = (args: string[]) => execFileSync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const fixture = (name: string) => path.join(tmp, name);
  ff([
    "-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture("with-audio.mp4"),
  ]);
  ff(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", fixture("still.png")]);
  const withAudio = fs.readFileSync(fixture("with-audio.mp4"));
  const stillPng = fs.readFileSync(fixture("still.png"));
  function streamTypes(file: string): string[] {
    return execFileSync(getFfprobePath(), ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { encoding: "utf8" })
      .split("\n").map((line) => line.trim()).filter(Boolean);
  }
  check("fixture: the source clip HAS an audio track", streamTypes(fixture("with-audio.mp4")).includes("audio"));

  // ── fake fetch (T10 contract: a 0600 file in mediaImportTempDir(), caller owns it) ──
  const tempDir = fetchMod.mediaImportTempDir();
  const ensurePrivateDir = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  };
  type Served = { bytes: Buffer; kind: "image" | "video"; ext: "png" | "mp4" };
  const served = new Map<string, Served | Error>();
  const fetchCalls: Array<{ url: string; accept: Json }> = [];
  const fakeFetch = async (url: string, options: { accept: Partial<Record<"image" | "video", number>> }) => {
    fetchCalls.push({ url, accept: { ...options.accept } });
    const behavior = served.get(url);
    if (!behavior) throw new fetchMod.MediaFetchError("fetch_failed");
    if (behavior instanceof Error) throw behavior;
    if (options.accept[behavior.kind] === undefined) throw new fetchMod.MediaFetchError("unsupported_media");
    ensurePrivateDir(tempDir);
    const file = path.join(tempDir, `media-import-${randomUUID()}.${behavior.ext}`);
    fs.writeFileSync(file, behavior.bytes, { mode: 0o600 });
    return { path: file, kind: behavior.kind, ext: behavior.ext, mime: "application/octet-stream", bytes: behavior.bytes.length };
  };
  const stocksDir = path.join(tmp, "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  const laneLog: string[] = [];
  /** Run the REAL import lane (real pipeline, fake fetch) until every live import has settled. */
  async function runLane() {
    const l = lane.createMediaImportLane({
      pollMs: 20, watchdogMs: 60 * 60_000, stocksDir, fetchMedia: fakeFetch,
      log: { info: (line) => { laneLog.push(line); }, error: (line) => { laneLog.push(line); } },
    });
    l.start();
    const settled = await waitFor(async () => (await prisma.mediaImport.count({
      where: { status: { in: ["pending", "processing"] }, source: { in: ["url", "upload"] }, claimedAt: null, OR: [{ source: "url" }, { status: "pending" }] },
    })) === 0 && l.inFlight === 0, 120_000);
    await l.stop();
    return settled;
  }
  const stockFileFor = (resultSrc: string) => path.join(stocksDir, path.basename(resultSrc));

  // ── stub caller: mirrors /api/videos/render's free paths and charges anything else ──
  let renderSeq = 0;
  let gallerySeq = 0;
  const callerLog: string[] = [];
  const renderCalls: Array<{ jobId: string; rerenderOf?: { sourceJobId?: string }; config?: Json; burnOf?: string; free: boolean }> = [];
  function makeCaller(userId: string) {
    return {
      async post<T>(p: string, body?: unknown): Promise<T> {
        callerLog.push(`POST ${p}`);
        if (p === "/api/videos/tts-gemini" || p === "/api/videos/tts") {
          return { voiceUrl: VOICE_FILE, audioDurationMs: 4_000, timing: TIMING } as T;
        }
        if (p === "/api/videos/split-script") return { cards: null } as T;
        if (p === "/api/videos/transcribe") {
          return {
            captions: [
              { text: CARD0_TEXT, startMs: 0, endMs: 2_000, tag: "hook" },
              { text: CARD1_TEXT, startMs: 2_000, endMs: 4_000, tag: "body" },
            ],
            words: [{ word: CARD0_TEXT, startMs: 0, endMs: 2_000 }, { word: CARD1_TEXT, startMs: 2_000, endMs: 4_000 }],
            fullText: SCRIPT,
            audioDurationMs: 4_000,
            speechCoverage: { source: "silence_analysis", spokenEndMs: 4_000 },
          } as T;
        }
        if (p === "/api/videos/extract-keywords") {
          return { keywords: ["food"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [4], visualDirection: "", keywordAlternatives: [] } as T;
        }
        if (p === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "food" }] } as T;
        if (p === "/api/videos/generate-config") return { config: structuredClone(BASE_CONFIG) } as T;
        if (p === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as {
            subtitleOverlayConfig?: { videoUrl?: string };
            shortVideoConfig?: Json;
            parentJobId?: string;
            rerenderOf?: { sourceJobId?: string };
          };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-bwe-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          let free = false;
          if (isBurn) {
            free = await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
          } else if (request.rerenderOf?.sourceJobId) {
            const source = await prisma.videoJob.findFirst({ where: { id: request.rerenderOf.sourceJobId, userId } });
            const output = parseVideoJobOutput(source?.outputJson ?? null);
            free = !!source
              && await isBurnAlreadyPaid(userId, output?.videoUrl)
              && rerenderSkipEligible({ sourceConfig: output?.preview?.config as Json, incomingConfig: request.shortVideoConfig })
              && budget.tryConsumeRerenderRate(userId);
          }
          renderCalls.push({
            jobId: request.parentJobId ?? "",
            ...(request.rerenderOf ? { rerenderOf: request.rerenderOf } : {}),
            ...(request.shortVideoConfig ? { config: structuredClone(request.shortVideoConfig) } : {}),
            ...(isBurn ? { burnOf: request.subtitleOverlayConfig?.videoUrl } : {}),
            free,
          });
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
          } else if (!isBurn) {
            await recordChargedClip(userId, videoUrl, 0); // the route records a free rerender's new base
          }
          return { jobId: id } as T;
        }
        if (p.startsWith("/api/videos/render-cancel")) return {} as T;
        if (p === "/api/videos") { gallerySeq += 1; return { id: `gallery-bwe-${gallerySeq}` } as T; }
        throw new Error(`stub caller: unexpected POST ${p}`);
      },
      async patch<T>(p: string): Promise<T> { callerLog.push(`PATCH ${p}`); return {} as T; },
      async get<T>(p: string): Promise<T> {
        callerLog.push(`GET ${p}`);
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
    const [paidClips, zeroClips, reservedRenders, user, ledger] = await Promise.all([
      prisma.chargedClip.count({ where: { userId, OR: [{ chargedMinutes: null }, { chargedMinutes: { gt: 0 } }, { creditsSpent: { gt: 0 } }] } }),
      prisma.chargedClip.count({ where: { userId, chargedMinutes: 0 } }),
      prisma.renderJob.count({ where: { userId, reservedQuota: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { minutesUsed: true, usageCount: true } }),
      prisma.creditLedger.count({ where: { userId } }),
    ]);
    return { paidClips, zeroClips, reservedRenders, minutesUsed: user.minutesUsed, usageCount: user.usageCount, creditLedger: ledger };
  }
  const moneyKey = (m: Awaited<ReturnType<typeof money>>) =>
    JSON.stringify({ paidClips: m.paidClips, reservedRenders: m.reservedRenders, minutesUsed: m.minutesUsed, usageCount: m.usageCount, creditLedger: m.creditLedger });
  async function projectRow(projectId: string) {
    return prisma.editorProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { pendingEditJson: true, pendingEditRevision: true, activeJobId: true, status: true },
    });
  }
  async function storedDraft(projectId: string) {
    return draftLib.parsePendingEditDraft((await projectRow(projectId)).pendingEditJson);
  }
  const jobCount = (userId: string) => prisma.videoJob.count({ where: { userId } });
  const status = async (who: { token: string }, jobId: string) => callTool(who.token, "get_video_status", { id: jobId });

  /** create_video_job(exportMode:"hold") through the route, then run the root to its Base Render. */
  let heldSeq = 0;
  async function heldRootVia(who: { user: { id: string }; token: string }) {
    heldSeq += 1;
    const reply = await callTool(who.token, "create_video_job", {
      script: SCRIPT, voiceProvider: "gemini", exportMode: "hold", idempotencyKey: `bwe-held-${heldSeq}`,
    });
    if (typeof reply.jobId !== "string") throw new Error(`fixture: hold create failed: ${JSON.stringify(reply)}`);
    const root = await runJob(reply.jobId, who.user.id);
    if (root.status !== "done" || !root.projectId) throw new Error(`fixture: held root ended ${root.status}: ${root.errorMessage}`);
    return { root, projectId: root.projectId };
  }
  /** A ready url import attached to `windowIndex` of `rootId` (lane run included). */
  async function replaceFromUrl(who: { token: string }, rootId: string, windowIndex: number, url: string, serve: Served | Error) {
    served.set(url, serve);
    const reply = await callTool(who.token, NEW_TOOL, { jobId: rootId, windowIndex, url });
    return reply;
  }

  // ── A ──
  await section("A) tools/list: beta sees replace_broll_window (agent-neutral schema), non-beta does not and is refused", async () => {
    const betaTools = await listTools(tester.token);
    check("beta tools/list includes replace_broll_window", betaTools.some((tool) => tool.name === NEW_TOOL), betaTools.map((t) => t.name).join(","));
    const problems = verifyAgentNeutralSchemas(betaTools, [NEW_TOOL]);
    check("G13: replace_broll_window's emitted schema is agent-neutral", problems.length === 0, problems.join("; "));
    const props = Object.keys(((betaTools.find((tool) => tool.name === NEW_TOOL)?.inputSchema ?? {}) as Json).properties as Json ?? {});
    check("inputs are jobId, windowIndex, url, uploadId, source", ["jobId", "windowIndex", "url", "uploadId", "source"].every((key) => props.includes(key)), props.join(","));
    const description = betaTools.find((tool) => tool.name === NEW_TOOL)?.description ?? "";
    check("tool text never promises a 10-minute total", !/10\s*นาที/.test(description), description);
    const outsiderNames = (await listTools(outsider.token)).map((tool) => tool.name);
    check("non-beta tools/list hides replace_broll_window", !outsiderNames.includes(NEW_TOOL));
    const reply = await callTool(outsider.token, NEW_TOOL, { jobId: "any", windowIndex: 1, source: "original" });
    check("non-beta direct call → feature_not_enabled envelope", reply.error === "feature_not_enabled" && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
  });

  // ── B ──
  let rootB: Awaited<ReturnType<typeof heldRootVia>> | null = null;
  await section("B) replace_broll_window validation: exactly one source, https only, window bounds, G27 ownership", async () => {
    rootB = await heldRootVia(tester);
    const { root } = rootB;
    const importsBefore = await prisma.mediaImport.count();
    fetchLog.length = 0;
    const cases: Array<[string, Json, string]> = [
      ["no source", { jobId: root.id, windowIndex: 1 }, "invalid_input"],
      ["url + uploadId", { jobId: root.id, windowIndex: 1, url: "https://media.example/a.mp4", uploadId: "abc" }, "invalid_input"],
      ["url + original", { jobId: root.id, windowIndex: 1, url: "https://media.example/a.mp4", source: "original" }, "invalid_input"],
      ["http url", { jobId: root.id, windowIndex: 1, url: "http://media.example/a.mp4" }, "url_not_https"],
      ["file url", { jobId: root.id, windowIndex: 1, url: "file:///etc/passwd" }, "url_not_https"],
      ["not a url", { jobId: root.id, windowIndex: 1, url: "not a url" }, "invalid_input"],
      ["overlong url", { jobId: root.id, windowIndex: 1, url: `https://media.example/${"a".repeat(2100)}.mp4` }, "invalid_input"],
      ["window out of range", { jobId: root.id, windowIndex: 99, source: "original" }, "invalid_input"],
      ["negative window", { jobId: root.id, windowIndex: -1, source: "original" }, "invalid_input"],
      ["unknown job", { jobId: "no-such-job", windowIndex: 1, source: "original" }, "invalid_input"],
      ["random uploadId", { jobId: root.id, windowIndex: 1, uploadId: randomUUID() }, "invalid_input"],
    ];
    for (const [label, args, code] of cases) {
      const reply = await callTool(tester.token, NEW_TOOL, args);
      check(`${label} → ${code}`, reply.error === code, JSON.stringify(reply));
    }
    const otherRoot = await heldRootVia(second);
    const foreignJob = await callTool(tester.token, NEW_TOOL, { jobId: otherRoot.root.id, windowIndex: 1, source: "original" });
    check("another user's job (another project) → invalid_input, same copy as unknown",
      foreignJob.error === "invalid_input" && foreignJob.message === (await callTool(tester.token, NEW_TOOL, { jobId: "zzz", windowIndex: 1, source: "original" })).message,
      JSON.stringify(foreignJob));
    // G27: a real, READY import of another user is indistinguishable from a missing id.
    const foreign = await prisma.mediaImport.create({
      data: {
        userId: second.user.id, purpose: "broll_video", source: "upload", status: "ready",
        resultSrc: "/api/stocks/broll-upload-foreign.mp4", durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000),
      },
    });
    const foreignReply = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, uploadId: foreign.id });
    const missingReply = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, uploadId: randomUUID() });
    check("G27: another user's uploadId → invalid_input with exactly the missing-id reply",
      foreignReply.error === "invalid_input" && JSON.stringify(foreignReply) === JSON.stringify(missingReply), `${JSON.stringify(foreignReply)} vs ${JSON.stringify(missingReply)}`);
    const presenter = await prisma.mediaImport.create({
      data: {
        userId: tester.user.id, purpose: "presenter", source: "upload", status: "ready",
        resultSrc: "/api/renders/presenter-import-x.mp4", durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000),
      },
    });
    const wrongKind = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, uploadId: presenter.id });
    check("G27: the caller's own presenter import is refused like a missing id",
      wrongKind.error === "invalid_input" && JSON.stringify(wrongKind) === JSON.stringify(missingReply), JSON.stringify(wrongKind));
    check("no refusal created a MediaImport row", (await prisma.mediaImport.count()) === importsBefore + 2);
    check("no refusal touched the network (the tool never fetches a url itself)", fetchLog.length === 0, fetchLog.join(","));
    const draft = await storedDraft(rootB.projectId);
    check("no refusal wrote a window edit", !draft || draft.windowEdits.length === 0, JSON.stringify(draft?.windowEdits));
  });

  // ── C ──
  const URL_C = "https://media.example.test/clip-with-audio.mp4?sig=SECRET-TOKEN-123";
  let rootC: Awaited<ReturnType<typeof heldRootVia>> | null = null;
  let rerenderC = "";
  let importC = "";
  let resultSrcC = "";
  await section("C) URL path end to end: import → pending refusal → lane → free rerender → rebased draft (G21) → chained export → done", async () => {
    rootC = await heldRootVia(tester);
    const { root, projectId } = rootC;
    const caption = await callTool(tester.token, "set_caption_text", { jobId: root.id, index: 0, text: "พาดหัวที่เอเจนต์แก้" });
    check("fixture: a caption edit is in the draft too", caption.ok === true, JSON.stringify(caption));
    const moneyBefore = await money(tester.user.id);

    const reply = await replaceFromUrl(tester, root.id, 1, URL_C, { bytes: withAudio, kind: "video", ext: "mp4" });
    check("replace_broll_window(url) accepted", reply.ok === true && reply.windowIndex === 1 && reply.source === "url"
      && typeof reply.importId === "string" && reply.importStatus === "pending" && typeof reply.draftRevision === "number"
      && typeof reply.next === "string", JSON.stringify(reply));
    check("the reply never echoes the agent's url", !JSON.stringify(reply).includes("media.example.test") && !JSON.stringify(reply).includes("SECRET-TOKEN"));
    check("the reply never promises a 10-minute total", !/10\s*นาที/.test(JSON.stringify(reply)));
    importC = String(reply.importId);
    const row = await prisma.mediaImport.findUniqueOrThrow({ where: { id: importC } });
    check("MediaImport: url source, B-roll purpose, pending, owned, deadline set", row.source === "url" && row.purpose === "broll_video"
      && row.status === "pending" && row.userId === tester.user.id && row.sourceUrl === URL_C && row.deadlineAt.getTime() > Date.now(), JSON.stringify(row));
    const draft = await storedDraft(projectId);
    check("draft records {index, src:null, importId, replacementKind:upload}",
      JSON.stringify(draft?.windowEdits) === JSON.stringify([{ index: 1, src: null, importId: importC, replacementKind: "upload" }]), JSON.stringify(draft?.windowEdits));

    let state = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    let windows = state.windows as Json[];
    check("get_edit_state: window 1 replaced, importStatus pending; window 0 untouched",
      windows[1]?.replaced === true && windows[1]?.importStatus === "pending" && windows[0]?.replaced === false && windows[0]?.importStatus === null,
      JSON.stringify(windows));
    check("get_edit_state never echoes the url", !JSON.stringify(state).includes("media.example.test"));

    const jobsBefore = await jobCount(tester.user.id);
    const pending = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video while the import is pending → imports_pending (window named)", pending.error === "imports_pending"
      && Array.isArray(pending.windowIndexes) && (pending.windowIndexes as number[]).includes(1) && checkFailureEnvelope(pending).length === 0, JSON.stringify(pending));
    check("imports_pending enqueued nothing", (await jobCount(tester.user.id)) === jobsBefore);

    check("the lane settles the import", await runLane());
    const ready = await prisma.mediaImport.findUniqueOrThrow({ where: { id: importC } });
    resultSrcC = ready.resultSrc ?? "";
    check("import ready: server-named /api/stocks/broll-upload-*.mp4, url cleared", ready.status === "ready"
      && /^\/api\/stocks\/broll-upload-[\w.-]+\.mp4$/.test(resultSrcC) && ready.sourceUrl === null && (ready.durationMs ?? 0) > 0, JSON.stringify(ready));
    check("the lane fetched the url once, accepting image or video (the bytes decide)", fetchCalls.filter((c) => c.url === URL_C).length === 1
      && typeof fetchCalls.find((c) => c.url === URL_C)?.accept.video === "number" && typeof fetchCalls.find((c) => c.url === URL_C)?.accept.image === "number",
      JSON.stringify(fetchCalls));
    const types = fs.existsSync(stockFileFor(resultSrcC)) ? streamTypes(stockFileFor(resultSrcC)) : [];
    check("K: the imported window media has a video track and NO audio track (narration only)", types.includes("video") && !types.includes("audio"), types.join(","));

    state = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    windows = state.windows as Json[];
    check("get_edit_state: importStatus ready", windows[1]?.importStatus === "ready", JSON.stringify(windows[1]));

    fetchLog.length = 0;
    callerLog.length = 0;
    renderCalls.length = 0;
    const exported = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video → rerendering with a rerender job", exported.status === "rerendering" && typeof exported.rerenderJobId === "string"
      && exported.jobId === root.id && typeof exported.next === "string", JSON.stringify(exported));
    rerenderC = String(exported.rerenderJobId);
    const rr = await prisma.videoJob.findUniqueOrThrow({ where: { id: rerenderC } });
    const rrInput = inputOf(rr);
    const revision = Number(draft ? (await projectRow(projectId)).pendingEditRevision : 0);
    check("rerender row: broll-rerender of the current base, keyed mcp-rerender:<root>:<rev>, linked + must-be-free",
      rr.type === "create" && rrInput.mode === "broll-rerender" && rrInput.sourceJobId === root.id
      && rr.idempotencyKey === `mcp-rerender:${root.id}:${revision}` && rrInput.mcpRootJobId === root.id && rrInput.mcpMustBeFree === true
      && rrInput.mcpExportAfterRerender === true && rr.projectId === projectId, JSON.stringify({ key: rr.idempotencyKey, rrInput }));
    const edits = rrInput.windowEdits as Json[];
    check("rerender windowEdits: the import's src, shown, upload kind, its duration",
      Array.isArray(edits) && edits.length === 1 && edits[0].index === 1 && edits[0].src === resultSrcC && edits[0].enabled === true
      && edits[0].replacementKind === "upload" && typeof edits[0].clipDuration === "number", JSON.stringify(edits));
    const again = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video again replays the same rerender (no second job)", again.status === "rerendering" && again.rerenderJobId === rerenderC, JSON.stringify(again));
    check("…and enqueued nothing new", (await prisma.videoJob.count({ where: { userId: tester.user.id, idempotencyKey: { startsWith: `mcp-rerender:${root.id}:` } } })) === 1);
    check("get_video_status reads rerendering", (await status(tester, root.id)).status === "rerendering");

    const rrDone = await runJob(rerenderC, tester.user.id);
    check("rerender done", rrDone.status === "done", String(rrDone.errorMessage));
    const rrCall = renderCalls.find((call) => call.rerenderOf);
    const rendered = (rrCall?.config?.bgVideos ?? []) as Json[];
    check("the render carried rerenderOf the base and was FREE (paid source + eligible + budget)", rrCall?.rerenderOf?.sourceJobId === root.id && rrCall?.free === true, JSON.stringify(rrCall));
    check("rendered window 1 src = the import's output, shown, clipOffset 0", rendered[1]?.src === resultSrcC && rendered[1]?.brollEnabled === true && rendered[1]?.clipOffset === 0, JSON.stringify(rendered[1]));
    check("rendered window 0 untouched", rendered[0]?.src === ORIGINAL_SRC[0], JSON.stringify(rendered[0]));
    check("rendered audio = the same narration (voiceFile + duration unchanged)", rrCall?.config?.voiceFile === VOICE_FILE && rrCall?.config?.durationInFrames === 120);

    const project = await projectRow(projectId);
    const rebased = draftLib.parsePendingEditDraft(project.pendingEditJson);
    check("project.activeJobId moved to the rerender", project.activeJobId === rerenderC, String(project.activeJobId));
    check("G21: the draft was rebased onto the rerender (baseJobId = activeJobId), window edit applied + removed, caption edit kept",
      rebased?.baseJobId === rerenderC && rebased.windowEdits.length === 0 && rebased.captions[0].text === "พาดหัวที่เอเจนต์แก้", JSON.stringify({ base: rebased?.baseJobId, edits: rebased?.windowEdits }));
    const forWeb = draftLib.pendingEditForWeb(project);
    check("G21: the web Post phase now loads the agent's draft after the rerender", forWeb !== null && forWeb.revision === project.pendingEditRevision
      && forWeb.draft.captions[0].text === "พาดหัวที่เอเจนต์แก้", JSON.stringify(forWeb?.revision));

    const ex = await prisma.videoJob.findFirst({ where: { userId: tester.user.id, type: "export", inputJson: { contains: `"sourceJobId":"${rerenderC}"` } } });
    const exInput = ex ? inputOf(ex) : {};
    check("the chained export was enqueued from the rerender (the new activeJobId)", !!ex && ex.status === "queued"
      && ex.idempotencyKey === `mcp-export:${root.id}:${project.pendingEditRevision}` && exInput.mcpRootJobId === root.id
      && exInput.mcpMustBeFree === true && exInput.mcpPendingEditRevision === project.pendingEditRevision, JSON.stringify({ key: ex?.idempotencyKey, exInput }));
    check("get_video_status reads exporting", (await status(tester, root.id)).status === "exporting");
    const replay = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video during the chained export replays it", replay.status === "exporting" && replay.exportJobId === ex?.id, JSON.stringify(replay));

    const exDone = await runJob(ex!.id, tester.user.id);
    check("chained export done", exDone.status === "done", String(exDone.errorMessage));
    const burn = renderCalls.find((call) => call.burnOf);
    check("the burn used the rerender's output as its base and was free", burn?.burnOf === parseVideoJobOutput(rrDone.outputJson)?.videoUrl && burn?.free === true, JSON.stringify(burn));
    const finalStatus = await status(tester, root.id);
    check("get_video_status(root) → done with the export's videoUrl", finalStatus.status === "done" && typeof finalStatus.videoUrl === "string", JSON.stringify(finalStatus));
    check("G12: the draft was cleared (revision matched)", (await projectRow(projectId)).pendingEditJson === null);
    const moneyAfter = await money(tester.user.id);
    check("no charge: no reservation, minutes, usage, credit ledger or paid clip", moneyKey(moneyAfter) === moneyKey(moneyBefore), `${moneyKey(moneyBefore)} → ${moneyKey(moneyAfter)}`);
    check("the only new ChargedClip is the rerender's 0-minute base", moneyAfter.zeroClips === moneyBefore.zeroClips + 1, JSON.stringify(moneyAfter));
    check("no provider call during rerender + export", !callerLog.some((line) => PROVIDER_PATH.test(line)), callerLog.join(","));
    check("no network call during rerender + export", fetchLog.length === 0, fetchLog.join(","));
  });

  // ── D ──
  await section("D) upload-link path end to end: create_upload_url → (refused before PUT) → PUT → lane → replace → export", async () => {
    const { root, projectId } = await heldRootVia(tester);
    const moneyBefore = await money(tester.user.id);
    const link = await callTool(tester.token, "create_upload_url", { kind: "video" });
    check("create_upload_url issued a link", typeof link.uploadId === "string" && typeof link.uploadUrl === "string", JSON.stringify(link));
    const early = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 0, uploadId: link.uploadId });
    check("uploadId before its PUT → invalid_input (no row yet, never 'exists')", early.error === "invalid_input", JSON.stringify(early));
    const token = decodeURIComponent(new URL(String(link.uploadUrl)).pathname.split("/").pop() ?? "");
    const putResponse = await uploadRoute.PUT(new Request(`https://studio.test/api/mcp-uploads/${token}`, {
      method: "PUT",
      body: new Uint8Array(withAudio),
      headers: { "content-length": String(withAudio.length) },
      // @ts-expect-error -- Node's fetch Request needs duplex for a streamed body
      duplex: "half",
    }), { params: Promise.resolve({ token }) });
    check("PUT accepted (202, pending)", putResponse.status === 202, `${putResponse.status} ${await putResponse.clone().text()}`);
    const attach = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 0, uploadId: link.uploadId });
    check("replace_broll_window(uploadId) accepted", attach.ok === true && attach.source === "upload" && attach.importId === link.uploadId
      && (attach.importStatus === "pending" || attach.importStatus === "processing"), JSON.stringify(attach));
    check("the lane settles the upload", await runLane());
    const ready = await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(link.uploadId) } });
    check("upload import ready", ready.status === "ready" && /^\/api\/stocks\/broll-upload-/.test(ready.resultSrc ?? ""), JSON.stringify(ready));
    const types = ready.resultSrc && fs.existsSync(stockFileFor(ready.resultSrc)) ? streamTypes(stockFileFor(ready.resultSrc)) : [];
    check("K: the uploaded window media has no audio track", types.includes("video") && !types.includes("audio"), types.join(","));

    renderCalls.length = 0;
    const exported = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video → rerendering", exported.status === "rerendering" && typeof exported.rerenderJobId === "string", JSON.stringify(exported));
    const rrDone = await runJob(String(exported.rerenderJobId), tester.user.id);
    check("rerender done", rrDone.status === "done", String(rrDone.errorMessage));
    const rendered = (renderCalls.find((call) => call.rerenderOf)?.config?.bgVideos ?? []) as Json[];
    check("rendered window 0 src = the upload's output, shown", rendered[0]?.src === ready.resultSrc && rendered[0]?.brollEnabled === true, JSON.stringify(rendered[0]));
    const project = await projectRow(projectId);
    check("G21: draft rebased onto the rerender", (await storedDraft(projectId))?.baseJobId === rrDone.id && project.activeJobId === rrDone.id);
    const ex = await prisma.videoJob.findFirst({ where: { userId: tester.user.id, type: "export", inputJson: { contains: `"sourceJobId":"${rrDone.id}"` } } });
    check("chained export enqueued", !!ex && ex.status === "queued");
    const exDone = await runJob(ex!.id, tester.user.id);
    check("export done", exDone.status === "done", String(exDone.errorMessage));
    check("get_video_status(root) → done", (await status(tester, root.id)).status === "done");
    check("no charge on the upload path", moneyKey(await money(tester.user.id)) === moneyKey(moneyBefore));
  });

  // ── E ──
  await section("E) import_failed names the window; nothing enqueued, nothing charged", async () => {
    const { root } = await heldRootVia(tester);
    const url = "https://media.example.test/broken.mp4";
    const reply = await replaceFromUrl(tester, root.id, 1, url, new fetchMod.MediaFetchError("unsupported_media"));
    check("fixture: replace accepted", reply.ok === true, JSON.stringify(reply));
    check("the lane settles it", await runLane());
    const row = await prisma.mediaImport.findUniqueOrThrow({ where: { id: String(reply.importId) } });
    check("import failed with a fixed code", row.status === "failed" && row.errorCode === "unsupported_media", JSON.stringify(row));
    const state = await callTool(tester.token, "get_edit_state", { jobId: root.id });
    const windows = state.windows as Json[];
    check("get_edit_state: importStatus failed + importError code", windows[1]?.importStatus === "failed" && windows[1]?.importError === "unsupported_media", JSON.stringify(windows[1]));
    const before = await money(tester.user.id);
    const jobsBefore = await jobCount(tester.user.id);
    const refused = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video → import_failed naming window 1", refused.error === "import_failed" && refused.windowIndex === 1
      && /1/.test(String(refused.message)) && checkFailureEnvelope(refused).length === 0, JSON.stringify(refused));
    check("nothing enqueued, nothing charged", (await jobCount(tester.user.id)) === jobsBefore && moneyKey(await money(tester.user.id)) === moneyKey(before));
    // A failed uploadId is refused at attach time already.
    const failedUpload = await prisma.mediaImport.create({
      data: { userId: tester.user.id, purpose: "broll_image", source: "upload", status: "failed", errorCode: "unsupported_media", deadlineAt: new Date(Date.now() + 60_000) },
    });
    const attach = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 0, uploadId: failedUpload.id });
    check("attaching a failed upload → import_failed", attach.error === "import_failed" && checkFailureEnvelope(attach).length === 0, JSON.stringify(attach));
  });

  // ── F ──
  await section("F) export_not_free before any write: unpaid base; rerender budget spent", async () => {
    const { root } = await heldRootVia(second);
    const ready = await prisma.mediaImport.create({
      data: {
        userId: second.user.id, purpose: "broll_video", source: "upload", status: "ready",
        resultSrc: "/api/stocks/broll-upload-f.mp4", durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000),
      },
    });
    const attach = await callTool(second.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, uploadId: ready.id });
    check("fixture: a ready upload attached", attach.ok === true && attach.importStatus === "ready", JSON.stringify(attach));

    const savedClips = await prisma.chargedClip.findMany({ where: { userId: second.user.id } });
    await prisma.chargedClip.deleteMany({ where: { userId: second.user.id } });
    let before = await money(second.user.id);
    let jobsBefore = await jobCount(second.user.id);
    const unpaid = await callTool(second.token, "export_video", { jobId: root.id });
    check("unpaid base → export_not_free", unpaid.error === "export_not_free" && checkFailureEnvelope(unpaid).length === 0, JSON.stringify(unpaid));
    check("…no job, no charge", (await jobCount(second.user.id)) === jobsBefore && moneyKey(await money(second.user.id)) === moneyKey(before));
    for (const clip of savedClips) await recordChargedClip(second.user.id, clip.outputUrl, clip.chargedMinutes ?? 1);

    while (budget.tryConsumeRerenderRate(second.user.id)) { /* spend the hour's free rerenders */ }
    before = await money(second.user.id);
    jobsBefore = await jobCount(second.user.id);
    const spent = await callTool(second.token, "export_video", { jobId: root.id });
    check("rerender budget spent → export_not_free", spent.error === "export_not_free" && checkFailureEnvelope(spent).length === 0, JSON.stringify(spent));
    check("…no job, no charge", (await jobCount(second.user.id)) === jobsBefore && moneyKey(await money(second.user.id)) === moneyKey(before));
  });

  // ── G ──
  await section("G) window 0 of an auto Cutaway Mode clip → window_locked_presenter_hook", async () => {
    const { root } = await heldRootVia(tester);
    const output = parseVideoJobOutput(root.outputJson)!;
    const cutaway = {
      ...output,
      preview: { ...output.preview!, avatarModel: "upload-cutaway", cutawayPersonRanges: [{ start: 0, end: 2 }] },
    };
    await prisma.videoJob.update({ where: { id: root.id }, data: { outputJson: JSON.stringify(cutaway) } });
    const importsBefore = await prisma.mediaImport.count();
    for (const args of [
      { url: "https://media.example.test/hook.mp4" },
      { source: "original" },
    ] as Json[]) {
      const reply = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 0, ...args });
      check(`window 0 (${Object.keys(args)[0]}) → window_locked_presenter_hook`, reply.error === "window_locked_presenter_hook"
        && checkFailureEnvelope(reply).length === 0, JSON.stringify(reply));
    }
    check("the refusal created no import", (await prisma.mediaImport.count()) === importsBefore);
    const window1 = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, source: "original" });
    check("window 1 of the same clip is editable", window1.ok === true, JSON.stringify(window1));
    await prisma.videoJob.update({
      where: { id: root.id },
      data: { inputJson: JSON.stringify({ ...inputOf(root), cutawayLayout: "fillYourself" }) },
    });
    const filled = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 0, source: "original" });
    check("with cutawayLayout fillYourself, window 0 is editable", filled.ok === true, JSON.stringify(filled));
  });

  // ── H ──
  await section("H) source:\"original\": drops a pending edit; after a rerender, re-renders the Base Render's own media", async () => {
    // (a) before any export
    const fresh = await heldRootVia(tester);
    const readyImport = await prisma.mediaImport.create({
      data: {
        userId: tester.user.id, purpose: "broll_video", source: "upload", status: "ready",
        resultSrc: "/api/stocks/broll-upload-h.mp4", durationMs: 3_000, deadlineAt: new Date(Date.now() + 60_000),
      },
    });
    await callTool(tester.token, NEW_TOOL, { jobId: fresh.root.id, windowIndex: 1, uploadId: readyImport.id });
    check("fixture: window 1 has a pending replacement", (await storedDraft(fresh.projectId))?.windowEdits.length === 1);
    const restore = await callTool(tester.token, NEW_TOOL, { jobId: fresh.root.id, windowIndex: 1, source: "original" });
    check("original before export → accepted", restore.ok === true && restore.source === "original", JSON.stringify(restore));
    check("…the pending edit is gone (window back to the base's own media)", (await storedDraft(fresh.projectId))?.windowEdits.length === 0);
    const state = await callTool(tester.token, "get_edit_state", { jobId: fresh.root.id });
    check("…get_edit_state shows window 1 not replaced", (state.windows as Json[])[1]?.replaced === false);

    // (b) after the C rerender: the base now shows the import in window 1.
    if (!rootC) throw new Error("C fixture missing");
    const { root, projectId } = rootC;
    const moneyBefore = await money(tester.user.id);
    const back = await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, source: "original" });
    check("original after a rerender → accepted", back.ok === true, JSON.stringify(back));
    const draft = await storedDraft(projectId);
    check("draft records a restore to the Base Render's own src",
      JSON.stringify(draft?.windowEdits) === JSON.stringify([{ index: 1, src: ORIGINAL_SRC[1], replacementKind: "original" }]), JSON.stringify(draft?.windowEdits));
    renderCalls.length = 0;
    const exported = await callTool(tester.token, "export_video", { jobId: root.id });
    check("export_video → rerendering", exported.status === "rerendering", JSON.stringify(exported));
    const rr = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(exported.rerenderJobId) } });
    check("the restore re-renders from the CURRENT base (the C rerender)", inputOf(rr).sourceJobId === rerenderC, String(inputOf(rr).sourceJobId));
    const rrDone = await runJob(rr.id, tester.user.id);
    check("rerender done", rrDone.status === "done", String(rrDone.errorMessage));
    const rendered = (renderCalls.find((call) => call.rerenderOf)?.config?.bgVideos ?? []) as Json[];
    check("rendered window 1 is the original media again, shown, with its clip duration",
      rendered[1]?.src === ORIGINAL_SRC[1] && rendered[1]?.brollEnabled === true && rendered[1]?.clipDuration === 4, JSON.stringify(rendered[1]));
    const ex = await prisma.videoJob.findFirst({ where: { userId: tester.user.id, type: "export", inputJson: { contains: `"sourceJobId":"${rrDone.id}"` } } });
    const exDone = ex ? await runJob(ex.id, tester.user.id) : null;
    check("chained export done", exDone?.status === "done", String(exDone?.errorMessage));
    check("no charge on restore", moneyKey(await money(tester.user.id)) === moneyKey(moneyBefore));
  });

  // ── I ──
  await section("I) restart: a lost rerender → export hop is recovered by the watchdog sweep and on read", async () => {
    for (const via of ["watchdog", "status"] as const) {
      const { root, projectId } = await heldRootVia(tester);
      const ready = await prisma.mediaImport.create({
        data: {
          userId: tester.user.id, purpose: "broll_video", source: "upload", status: "ready",
          resultSrc: `/api/stocks/broll-upload-i-${via}.mp4`, durationMs: 2_000, deadlineAt: new Date(Date.now() + 60_000),
        },
      });
      await callTool(tester.token, NEW_TOOL, { jobId: root.id, windowIndex: 1, uploadId: ready.id });
      const exported = await callTool(tester.token, "export_video", { jobId: root.id });
      const rrId = String(exported.rerenderJobId);
      // Maintenance starts while the rerender runs: its export hop cannot enqueue (as if the
      // worker died between the rerender's finish and the hop).
      await prisma.siteConfig.upsert({ where: { key: RENDER_DEPLOY_DRAIN_KEY }, create: { key: RENDER_DEPLOY_DRAIN_KEY, value: "1" }, update: { value: "1" } });
      const rrDone = await runJob(rrId, tester.user.id);
      check(`${via}: rerender done`, rrDone.status === "done", String(rrDone.errorMessage));
      const exportsOf = () => prisma.videoJob.count({ where: { userId: tester.user.id, type: "export", inputJson: { contains: `"sourceJobId":"${rrId}"` } } });
      check(`${via}: no export yet (hop deferred)`, (await exportsOf()) === 0);
      check(`${via}: the draft is already rebased onto the rerender`, (await storedDraft(projectId))?.baseJobId === rrId);
      const owed = await status(tester, root.id);
      check(`${via}: get_video_status reads exporting while the export is owed`, owed.status === "exporting", JSON.stringify(owed));
      await prisma.siteConfig.update({ where: { key: RENDER_DEPLOY_DRAIN_KEY }, data: { value: "0" } });
      if (via === "watchdog") {
        const sweep = await sweepStalledVideoJobs(new Date());
        check("watchdog: the sweep recovered the hop", sweep.recoveredChainExports.includes(rrId), JSON.stringify(sweep.recoveredChainExports));
      } else {
        const reply = await status(tester, root.id);
        check("status: the read recovered the hop → exporting", reply.status === "exporting", JSON.stringify(reply));
      }
      check(`${via}: exactly one export from the rerender`, (await exportsOf()) === 1);
      const again = await sweepStalledVideoJobs(new Date());
      check(`${via}: a second sweep is a no-op`, !again.recoveredChainExports.includes(rrId) && (await exportsOf()) === 1);
      const ex = await prisma.videoJob.findFirstOrThrow({ where: { userId: tester.user.id, type: "export", inputJson: { contains: `"sourceJobId":"${rrId}"` } } });
      const exDone = await runJob(ex.id, tester.user.id);
      check(`${via}: export done → root done`, exDone.status === "done" && (await status(tester, root.id)).status === "done");
    }
  });

  // ── J ──
  await section("J) create_video_job without the new fields is unchanged (regression)", async () => {
    const plain = await callTool(tester.token, "create_video_job", { script: SCRIPT, voiceProvider: "gemini", idempotencyKey: "bwe-plain-1" });
    check("plain create accepted", typeof plain.jobId === "string", JSON.stringify(plain));
    const row = await prisma.videoJob.findUniqueOrThrow({ where: { id: String(plain.jobId) } });
    const input = inputOf(row);
    check("no T13 field leaks into a create input", !("mcpExportAfterRerender" in input) && !("mcpAppliedDraftWindowEdits" in input)
      && !("mcpHold" in input), JSON.stringify(Object.keys(input)));
    const done = await runJob(row.id, tester.user.id);
    check("the plain create still runs to done (chain export enqueued as before)", done.status === "done", String(done.errorMessage));
    const outsiderCreate = await callTool(outsider.token, "create_video_job", { script: SCRIPT, voiceProvider: "gemini", idempotencyKey: "bwe-plain-2" });
    check("non-beta plain create still accepted", typeof outsiderCreate.jobId === "string", JSON.stringify(outsiderCreate));
  });

  // ── K ──
  await section("K) muting: every B-roll clip in the composition is muted; normalize strips audio", async () => {
    const composition = fs.readFileSync(path.join(ROOT, "src/remotion/ShortVideoComposition.tsx"), "utf8");
    const clip = composition.slice(composition.indexOf("function VideoClip("), composition.indexOf("function VideoClip(") + 4_000);
    check("VideoClip renders <OffthreadVideo … muted>", /<OffthreadVideo[\s\S]*?\bmuted\b[\s\S]*?\/>/.test(clip));
    check("the B-roll layer renders VideoClip", composition.includes("<VideoClip"));
    const assetLib = fs.readFileSync(path.join(ROOT, "src/lib/broll-asset-lib.ts"), "utf8");
    check("broll-asset-lib normalize + Ken Burns pass -an", (assetLib.match(/"-an"/g) ?? []).length >= 2);
  });

  // ── L ──
  await section("L) wiring + G14 envelopes", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    check("package.json: verify:mcp-broll-window-edits", (pkg.scripts["verify:mcp-broll-window-edits"] ?? "").includes("scripts/verify-mcp-broll-window-edits.ts"));
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const install = ci.indexOf("sudo apt-get install -y --no-install-recommends ffmpeg");
    const run = ci.indexOf("npm run verify:mcp-broll-window-edits");
    check("ci.yml runs it after ffmpeg is installed (G24 step)", install > 0 && run > install, `install=${install} run=${run}`);
    check("at least one failure was exercised for each tool", [NEW_TOOL, "export_video"].every((tool) => failures.some((f) => f.tool === tool)));
    for (const failure of failures) {
      const problems = checkFailureEnvelope(failure.reply);
      check(`${failure.tool} ${String(failure.reply.error)}: envelope`, problems.length === 0, `${problems.join("; ")} ${JSON.stringify(failure.reply)}`);
    }
    check("no reply ever carried an agent url or its query secret",
      !replies.some((r) => r.text.includes("media.example.test") || r.text.includes("SECRET-TOKEN")), replies.filter((r) => r.text.includes("media.example.test")).map((r) => r.tool).join(","));
    check("no lane log line carried an agent url", !laneLog.some((line) => line.includes("media.example.test")));
    // The audit row stores the tool's arguments: the agent's url (it may carry a signed token)
    // must be redacted there too, while the call itself stays audited.
    const audits = await prisma.toolCallAudit.findMany({ where: { toolName: NEW_TOOL }, select: { requestJson: true } });
    check("replace_broll_window calls are audited", audits.length > 0, String(audits.length));
    check("no audit row stores an agent url or its query secret",
      !audits.some((row) => (row.requestJson ?? "").includes("media.example") || (row.requestJson ?? "").includes("SECRET-TOKEN")),
      audits.map((row) => row.requestJson).filter((json) => (json ?? "").includes("media.example")).slice(0, 2).join(" | "));
  });

  globalThis.fetch = realFetch;
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
      console.error("MCP B-roll window edits verification FAILED");
      process.exit(1);
    }
    console.log("MCP B-roll window edits: all checks passed");
    process.exit(0);
  });
