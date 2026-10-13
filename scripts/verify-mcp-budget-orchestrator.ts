import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "mcp-budget-orchestrator-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.MINUTE_QUOTA = "1";
process.env.CREDITS_LIVE = "1";
process.env.HERO_AI_IMAGE_PUBLIC = "1";
process.env.MCP_EDITOR_PROJECT_PUBLIC = "1";
process.env.RENDER_VIA_QUEUE = "1";
globalThis.fetch = async () => { throw new Error("External network forbidden"); };
execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { stdio: "pipe", env: process.env });
const rendersRoot = join(dir, "renders");
mkdirSync(rendersRoot);
const SCRIPT = "สวัสดีค่ะ วันนี้มาดูรีวิวครีมกันแดดกัน เนื้อบางเบามาก ซึมไวสุดๆ".repeat(8);
const TIMING = { provider: "gemini", segments: [{ text: SCRIPT, startMs: 0, durationMs: 5000 }], chars: null };
type StubOptions = { failBaseRender?: boolean; failBurn?: boolean };
let renderSeq = 0, gallerySeq = 0, stockCalls = 0;
async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { isBurnAlreadyPaid, recordChargedClip } = await import("../src/lib/clip-charge");
  const { transferVideoJobFundingToRender } = await import("../src/lib/mcp/video-job-funding");
  const { prepareVideoQuote, decideVideoQuote } = await import("../src/lib/mcp/video-quote.server");
  const { consumeVideoQuote } = await import("../src/lib/mcp/video-budget.server");
  const owner = await prisma.user.create({ data: { name: "Ordinary user", email: "budget-orchestrator@example.test", role: "USER", plan: "PRO", minutesLimit: 100, usagePeriodStartedAt: new Date(), planExpiresAt: new Date(Date.now() + 86400000), geminiKey: "fixture", pexelsKey: "fixture" } });
  await prisma.payment.create({ data: { userId: owner.id, stripeSessionId: "ordinary-paid", plan: "PRO", amount: 100, status: "PAID", paidAt: new Date() } });
  await prisma.creditBalance.create({ data: { userId: owner.id, purchased: 100 } });
  const quote = await prepareVideoQuote(owner, { script: SCRIPT, brollSource: "automix", exportMode: "hold" });
  assert.ok("quoteId" in quote && quote.imageCountCeiling > 0);
  await decideVideoQuote(owner.id, quote.quoteId, "approve");
  const created = await consumeVideoQuote(owner.id, quote.quoteId);
  assert.ok(created.jobId);
  function makeCaller(userId: string, opts: StubOptions = {}) {
    const log: Array<{ method: string; path: string; body?: unknown }> = [];
    const caller = {
      async post<T>(path: string, body?: unknown): Promise<T> {
        log.push({ method: "POST", path, body });
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          return { voiceUrl: "/api/renders/chain-voice.wav", audioDurationMs: 5000, timing: TIMING } as T;
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
        if (path === "/api/videos/fetch-stock") {
          const request = body as { maxAiImages?: number; stockSource?: string };
          assert.equal(request.stockSource, "auto-mix");
          assert.equal(typeof request.maxAiImages, "number", "ordinary USER reaches actual receipt guard with numeric approved cap");
          assert.equal(request.maxAiImages, quote.imageCountCeiling);
          stockCalls++;
          return { results: [{ videoUrl: "stock1.mp4", keyword: "sunscreen" }] } as T;
        }
        if (path === "/api/videos/generate-config") {
          return { config: { durationInFrames: 150, voiceFile: "/api/renders/chain-voice.wav", bgVideos: [] } } as T;
        }
        if (path === "/api/videos/render") {
          renderSeq += 1;
          const request = (body ?? {}) as { subtitleOverlayConfig?: { videoUrl?: string }; parentJobId?: string };
          const isBurn = !!request.subtitleOverlayConfig;
          const id = `rj-${renderSeq}`;
          const videoUrl = isBurn ? `/api/renders/${id}-burned.mp4` : `/api/renders/${id}-base.mp4`;
          // Mirrors /api/videos/render: a burn is free IFF it references a base this user paid for.
          const paid = isBurn && await isBurnAlreadyPaid(userId, request.subtitleOverlayConfig?.videoUrl);
          const reserve = !paid;
          const transfer = reserve && request.parentJobId ? await transferVideoJobFundingToRender(request.parentJobId, userId, 1) : { transferred: false as const };
          const failing = isBurn ? !!opts.failBurn : !!opts.failBaseRender;
          await prisma.renderJob.create({
            data: {
              id, userId, parentJobId: request.parentJobId ?? null,
              type: isBurn ? "BURN" : "RENDER",
              status: failing ? "FAILED" : "DONE",
              payload: "{}", videoUrl: failing ? null : videoUrl,
              reservedQuota: reserve, reservedMinutes: reserve ? 1 : null,
            },
          });
          if (reserve) {
            assert.equal(transfer.transferred, true, "base uses original reservation exactly once");
            if (!failing) await recordChargedClip(userId, videoUrl, 1);
          }
          if (!failing) writeFileSync(join(rendersRoot, `${id}-${isBurn ? "burned" : "base"}.mp4`), "x");
          return { jobId: id } as T;
        }
        if (path.startsWith("/api/videos/render-cancel")) return {} as T;
        if (path === "/api/videos") { gallerySeq += 1; return { id: `gallery-${gallerySeq}` } as T; }
        if (path === "/api/videos/trim-audio") return { audioUrl: "/api/renders/chain-intro.wav" } as T;
        if (path === "/api/heygen/generate-with-bg") return { videoId: "qa-heygen-video" } as T;
        if (path === "/api/videos/poll-avatar") {
          return { status: "completed", videoUrl: "https://avatar.example/qa.mp4", thumbnailUrl: null, errorMsg: null } as T;
        }
        if (path === "/api/heygen/composite") {
          renderSeq += 1;
          const compositeUrl = `/api/renders/composite-${renderSeq}.mp4`;
          // Mirrors /api/heygen/composite:795 — the composite output is a paid clip.
          await recordChargedClip(userId, compositeUrl);
          writeFileSync(join(rendersRoot, `composite-${renderSeq}.mp4`), "x");
          return { videoUrl: compositeUrl, usedMode: "chromakey" } as T;
        }
        throw new Error(`stub caller: unexpected POST ${path}`);
      },
      async patch<T>(path: string, body?: unknown): Promise<T> {
        log.push({ method: "PATCH", path, body });
        return {} as T;
      },
      async get<T>(path: string): Promise<T> {
        log.push({ method: "GET", path });
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
    return { caller, log };
  }

  async function runJob(jobId: string, userId: string, opts: StubOptions = {}) {
    await prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ["queued", "waiting_provider"] } },
      data: { status: "processing", startedAt: new Date(), providerNextPollAt: null },
    });
    const { caller, log } = makeCaller(userId, opts);
    await runOrchestrator(jobId, userId, { caller: caller as never, sleep: async () => {} });
    return log;
  }

  try {
    await runJob(created.jobId, owner.id);
    const job = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } });
    assert.equal(job.status, "done", job.errorMessage ?? "USER AutoMix must reach held preview");
    assert.equal(stockCalls, 1);
    assert.equal(job.fundingState, "settled");
    assert.ok(JSON.parse(job.outputJson!).preview);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).minutesUsed, 1);
    console.log("PASS ordinary USER approved AutoMix through real orchestrator to held preview; numeric cap propagated; authoritative funding transferred once (media/render providers stubbed)");
  } finally { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
