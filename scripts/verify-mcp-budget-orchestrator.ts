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
const SOURCE = process.env.BUDGET_FIXTURE_SOURCE === "hero-ai-image" ? "hero-ai-image" : "automix";
const TIMING = { provider: "gemini", segments: [{ text: SCRIPT, startMs: 0, durationMs: 5000 }], chars: null };
type StubOptions = { failBaseRender?: boolean; failBurn?: boolean; budgetCap?: boolean; unknownImage?: boolean };
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
  const quote = await prepareVideoQuote(owner, { script: SCRIPT, brollSource: SOURCE, exportMode: "hold" });
  assert.ok("quoteId" in quote && quote.imageCountCeiling > 0);
  await decideVideoQuote(owner.id, quote.quoteId, "approve");
  const created = await consumeVideoQuote(owner.id, quote.quoteId);
  assert.ok(created.jobId);
  const { createReservedImageJob, completeImageJob, failAndRefundAiJob } = await import("../src/lib/ai-generation-jobs.server");
  const { currentQuotePricing } = await import("../src/lib/mcp/video-quote");
  const { decodePipelineResponse } = await import("../src/lib/mcp/pipeline-client");
  let imageJobId = "";
  let ttsCalls = 0;
  function makeCaller(userId: string, opts: StubOptions = {}, activeJobId = created.jobId) {
    const log: Array<{ method: string; path: string; body?: unknown }> = [];
    const caller = {
      async post<T>(path: string, body?: unknown): Promise<T> {
        log.push({ method: "POST", path, body });
        if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
          ttsCalls++;
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
          assert.equal(request.stockSource, SOURCE === "hero-ai-image" ? "kie-image" : "auto-mix");
          assert.equal(typeof request.maxAiImages, "number", "ordinary USER reaches actual receipt guard with numeric approved cap");
          const active = await prisma.videoJob.findUniqueOrThrow({ where: { id: activeJobId } });
          const approved = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: active.budgetQuoteId! } });
          assert.equal(request.maxAiImages, approved.imageCountCeiling);
          if (opts.budgetCap) return decodePipelineResponse<T>("POST", path, 409, JSON.stringify({ error: "confirmation_required", code: "confirmation_required", reason: "image_ceiling", additional: { images: 1, imageCredits: 2 } }));
          if (activeJobId === created.jobId || opts.unknownImage) {
            const imageInput = { userId, model: "z-image-turbo", inputPreview: "retained fixture scene", inputJson: JSON.stringify({ videoJobId: activeJobId, sceneIndex: 0 }), creditCost: currentQuotePricing().perImageCredits, quoteVersion: "fixture", costBudgetUsdMicros: 100, provider: "runpod", providerModel: "fixture", providerRoute: "fixture", providerEndpoint: "fixture", estimatedCostUsdMicros: 1, idempotencyKey: `video:${activeJobId}:scene:0:provider-attempt:0:scene-retry:1`, mediaExpiresAt: new Date(Date.now() + 86400000), productSurface: SOURCE === "hero-ai-image" ? "hero_video" as const : "automix" as const };
            if (activeJobId === created.jobId) {
              const retired = await createReservedImageJob({ ...imageInput, idempotencyKey: `video:${activeJobId}:scene:0:provider-attempt:0` });
              assert.ok(retired.ok);
              if (retired.created) await failAndRefundAiJob(userId, retired.job.id, "RUNPOD_FAILED", "confirmed retired attempt", true);
            }
            const image = await createReservedImageJob(imageInput);
            assert.ok(image.ok);
            if (activeJobId === created.jobId) {
              if (imageJobId) assert.equal(image.job.id, imageJobId, "resume retains image identity");
              imageJobId = image.job.id;
            }
            if (image.job.status !== "completed") {
              await prisma.aiGenerationAttempt.updateMany({ where: { jobId: image.job.id }, data: { status: opts.unknownImage ? "submitting" : "submitted", providerJobId: opts.unknownImage ? null : "known-fixture-provider-id" } });
              return decodePipelineResponse<T>("POST", path, 409, JSON.stringify({ error: "confirmation_required", code: "confirmation_required", reason: opts.unknownImage ? "image_submission_unknown" : "image_poll_unknown", additional: {} }));
            }
          }
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
    const { caller, log } = makeCaller(userId, opts, jobId);
    await runOrchestrator(jobId, userId, { caller: caller as never, sleep: async () => {}, rendersRoot });
    return log;
  }

  try {
    await runJob(created.jobId, owner.id);
    const held = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } });
    assert.equal(held.status, "confirmation_required", held.errorMessage ?? "HTTP uncertainty must hold");
    assert.equal(JSON.parse(held.budgetCheckpointJson!).hold.reason, "image_poll_unknown");
    assert.equal(held.fundingState, "reserved");
    assert.equal(held.reservationRefundPending, false);
    assert.equal((await prepareVideoQuote(owner, { resumeJobId: created.jobId })).code, "resume_unavailable");
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } })).status, "confirmation_required", "unresolved provider exposure must remain held");
    const walletAfterImage = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } });
    await prisma.aiGenerationAttempt.updateMany({ where: { jobId: imageJobId }, data: { status: "submitted", providerJobId: "known-fixture-provider-id" } });
    await completeImageJob({ userId: owner.id, jobId: imageJobId, outputUrl: "/api/ai-images/fixture.png" });
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } })).status, "queued");
    await runJob(created.jobId, owner.id);
    assert.equal(ttsCalls, 1, "HTTP hold continuation must not repeat narration");
    assert.equal(await prisma.aiGenerationJob.count({ where: { budgetQuoteId: quote.quoteId, chargeState: "settled" } }), 1);
    assert.equal(await prisma.aiGenerationJob.count({ where: { budgetQuoteId: quote.quoteId, status: "failed", chargeState: "refunded" } }), 1);
    assert.deepEqual(await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } }), walletAfterImage);
    console.log("PASS HTTP uncertainty → retained hold → known image settlement → same-root continuation without repeated TTS/image charge");
    const job = await prisma.videoJob.findUniqueOrThrow({ where: { id: created.jobId } });
    assert.equal(job.status, "done", job.errorMessage ?? "USER AutoMix must reach held preview");
    assert.equal(stockCalls, 1);
    assert.equal(job.fundingState, "settled");
    assert.ok(JSON.parse(job.outputJson!).preview);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).minutesUsed, 1);
    // Actual shared route: trusted service context survives omitted/forged body IDs.
    const Module = (await import("node:module")).default as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
    const oldLoad = Module._load;
    let serviceJobId: string | null = created.jobId;
    Module._load = function(request, ...args) {
      if (request.includes("clerk-auth")) return { getCurrentUser: async () => owner };
      if (request.includes("mcp/service-actor")) return { resolveServiceVideoJobId: async () => serviceJobId };
      if (request.includes("remotion-public-dir")) return { prepareRemotionBundlePublicDir: () => rendersRoot };
      return oldLoad.call(this, request, ...args);
    };
    process.env.RENDER_TMP_ROOT = join(dir, "render-tmp");
    const { POST } = await import("../src/app/api/videos/render/route");
    const beforeWallet = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } });
    const beforeRenderCount = await prisma.renderJob.count();
    for (const identity of [{ parentJobId: created.jobId }, {}, { parentJobId: "forged" }]) {
      const response = await POST(new Request("http://localhost/api/videos/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, scenes: [{ text: "fixture" }], videoDuration: 60 }) }));
      assert.equal(response.status, 409, `bound service render must refuse new spend: ${JSON.stringify(identity)}`);
    }
    serviceJobId = null;
    for (const identity of [{ rerenderOf: { sourceJobId: created.jobId } }, { projectId: created.projectId }]) {
      const response = await POST(new Request("http://localhost/api/videos/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, scenes: [{ text: "fixture" }], videoDuration: 60 }) }));
      assert.equal(response.status, 409, "web derivative cannot charge outside inherited approval");
    }
    assert.equal(await prisma.renderJob.count(), beforeRenderCount);
    assert.deepEqual(await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } }), beforeWallet);
    const pendingQuote = await prepareVideoQuote(owner, { script: "Immutable approved work waiting for its worker.", brollSource: "stock" });
    await decideVideoQuote(owner.id, pendingQuote.quoteId, "approve");
    const pendingRoot = await consumeVideoQuote(owner.id, pendingQuote.quoteId);
    assert.ok(pendingRoot.jobId);
    const pendingBefore = await prisma.videoJob.findUniqueOrThrow({ where: { id: pendingRoot.jobId } });
    const arbitraryBrowser = await POST(new Request("http://localhost/api/videos/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentJobId: pendingRoot.jobId, scenes: [{ text: "Entirely different unapproved scene" }], videoDuration: 60 }) }));
    assert.equal(arbitraryBrowser.status, 409, "browser hint cannot consume queued quote funding for changed work");
    assert.equal(await prisma.renderJob.count({ where: { parentJobId: pendingRoot.jobId } }), 0);
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: pendingRoot.jobId } })).fundingState, pendingBefore.fundingState);
    const originalCwd = process.cwd();
    mkdirSync(join(dir, "public", "renders"), { recursive: true });
    writeFileSync(join(dir, "public", "renders", "chain-voice.wav"), Buffer.alloc(2000));
    process.chdir(dir);
    const freeResponse = await POST(new Request("http://localhost/api/videos/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rerenderOf: { sourceJobId: created.jobId }, shortVideoConfig: { ...JSON.parse(job.outputJson!).preview.config, backgroundColors: ["#000000"] } }) }));
    assert.equal(freeResponse.status, 200, await freeResponse.clone().text());
    const freeRender = await prisma.renderJob.findUniqueOrThrow({ where: { id: (await freeResponse.json()).jobId } });
    assert.equal(freeRender.parentJobId, created.jobId);
    assert.equal(freeRender.reservedQuota, false);
    assert.deepEqual(await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } }), beforeWallet);
    const paidBaseUrl = JSON.parse(job.outputJson!).videoUrl;
    writeFileSync(join(dir, "public", "renders", paidBaseUrl.split("/").at(-1)), Buffer.alloc(2000));
    for (const boundService of [false, true]) {
      serviceJobId = boundService ? created.jobId : null;
      const burnResponse = await POST(new Request("http://localhost/api/videos/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: created.projectId, subtitleOverlayConfig: { videoUrl: paidBaseUrl, durationInFrames: 150, captions: [] } }) }));
      assert.equal(burnResponse.status, 200, await burnResponse.clone().text());
      const burnRender = await prisma.renderJob.findUniqueOrThrow({ where: { id: (await burnResponse.json()).jobId } });
      assert.equal(burnRender.reservedQuota, false, "already-paid web and service exports stay free");
      assert.equal(burnRender.parentJobId, created.jobId);
    }
    assert.deepEqual(await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } }), beforeWallet);
    process.chdir(originalCwd);
    Module._load = oldLoad;
    console.log("PASS actual render POST service omission/mismatch and owned web derivative ceiling enforcement");
    // Crash after durable base completion, before the worker publishes preview.
    await prisma.videoJob.update({ where: { id: job.id }, data: { status: "processing", currentStep: "render", outputJson: null } });
    const { recoverProcessingJobsAfterWorkerRestart } = await import("../src/lib/mcp/video-job");
    await recoverProcessingJobsAfterWorkerRestart();
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, "queued", "known completed base must resume without new approval");
    await prisma.videoJob.update({ where: { id: job.id }, data: { status: "confirmation_required", currentStep: "render" } });
    const resumedReceipt = await prepareVideoQuote(owner, { resumeJobId: job.id });
    assert.equal(resumedReceipt.quoteId, quote.quoteId, "explicit resume adopts known durable result under original approval");
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, "queued");
    const beforeResumeRenders = renderSeq;
    const resumedCalls = await runJob(job.id, owner.id);
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } })).status, "done");
    assert.equal(renderSeq, beforeResumeRenders, "resume reuses durable base rather than resubmitting render");
    assert.equal(resumedCalls.filter(call => /tts|fetch-stock/.test(call.path)).length, 0, "resume reuses completed narration/media");
    console.log("PASS known-completed base restart resumes retained work without new render or narration");
    const { exportVideoTool } = await import("../src/lib/mcp/edit-tools");
    const beforeExportWallet = await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } });
    const beforeExportMinutes = (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).minutesUsed;
    const exported = await exportVideoTool(owner, created.jobId) as { exportJobId?: string; error?: string };
    assert.ok(exported.exportJobId, JSON.stringify(exported));
    // Export submission crosses a worker restart before its durable BURN appears.
    await prisma.videoJob.update({ where: { id: exported.exportJobId }, data: { status: "processing", currentStep: "burn", budgetCheckpointJson: JSON.stringify({ version: 1, calls: { interrupted: { path: "/api/videos/render", state: "running" } } }) } });
    await recoverProcessingJobsAfterWorkerRestart();
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: exported.exportJobId } })).status, "confirmation_required");
    const lateUrl = "/api/renders/late-budget-export.mp4";
    await prisma.renderJob.create({ data: { userId: owner.id, parentJobId: exported.exportJobId, type: "BURN", status: "DONE", payload: "{}", videoUrl: lateUrl, reservedQuota: false } });
    writeFileSync(join(rendersRoot, "late-budget-export.mp4"), "fixture render output");
    const quoteCount = await prisma.mcpVideoQuote.count();
    const renderCount = await prisma.renderJob.count();
    const paidAttempts = renderSeq;
    const narrationCalls = ttsCalls;
    const resumedExport = await prepareVideoQuote(owner, { resumeJobId: exported.exportJobId });
    assert.equal(resumedExport.quoteId, quote.quoteId);
    await runJob(exported.exportJobId, owner.id);
    assert.equal(await prisma.mcpVideoQuote.count(), quoteCount);
    assert.equal(await prisma.renderJob.count(), renderCount);
    assert.equal(renderSeq, paidAttempts); assert.equal(ttsCalls, narrationCalls);

    const final = await prisma.videoJob.findUniqueOrThrow({ where: { id: exported.exportJobId } });
    assert.equal(final.status, "done", final.errorMessage ?? "approved image source must reach FINAL export");
    assert.ok(JSON.parse(final.outputJson!).videoUrl);
    assert.equal(final.budgetQuoteId, quote.quoteId);
    assert.deepEqual(await prisma.creditBalance.findUniqueOrThrow({ where: { userId: owner.id } }), beforeExportWallet);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).minutesUsed, beforeExportMinutes);
    console.log(`PASS ordinary USER ${SOURCE} FINAL export preserves quote and adds no charge`);

    const capQuote = await prepareVideoQuote(owner, { script: SCRIPT + " additional", brollSource: SOURCE, exportMode: "hold" });
    await decideVideoQuote(owner.id, capQuote.quoteId, "approve");
    const capRoot = await consumeVideoQuote(owner.id, capQuote.quoteId);
    assert.ok(capRoot.jobId);
    await runJob(capRoot.jobId, owner.id, { budgetCap: true });
    const capHeld = await prisma.videoJob.findUniqueOrThrow({ where: { id: capRoot.jobId } });
    assert.equal(capHeld.status, "confirmation_required");
    const capCheckpoint = JSON.parse(capHeld.budgetCheckpointJson!);
    assert.equal(capCheckpoint.hold.reason, "image_ceiling");
    assert.ok(capCheckpoint.hold.quoteId);
    const capIncrement = await prisma.mcpVideoQuote.findUniqueOrThrow({ where: { id: capCheckpoint.hold.quoteId } });
    assert.equal(capIncrement.imageCountCeiling, 1);
    assert.equal(capIncrement.imageCreditCeiling, 2);
    assert.equal(capHeld.fundingState, "reserved");
    assert.equal(capHeld.reservationRefundPending, false);
    const unknownQuote = await prepareVideoQuote(owner, { script: SCRIPT, brollSource: SOURCE, exportMode: "hold" });
    await decideVideoQuote(owner.id, unknownQuote.quoteId, "approve");
    const unknownRoot = await consumeVideoQuote(owner.id, unknownQuote.quoteId);
    assert.ok(unknownRoot.jobId);
    await runJob(unknownRoot.jobId, owner.id, { unknownImage: true });
    const unknownHeld = await prisma.videoJob.findUniqueOrThrow({ where: { id: unknownRoot.jobId } });
    assert.equal(unknownHeld.status, "confirmation_required");
    assert.equal(JSON.parse(unknownHeld.budgetCheckpointJson!).hold.reason, "image_submission_unknown");
    assert.equal((await prepareVideoQuote(owner, { resumeJobId: unknownRoot.jobId })).code, "resume_unavailable");
    const unknownImage = await prisma.aiGenerationJob.findFirstOrThrow({ where: { budgetQuoteId: unknownQuote.quoteId } });
    assert.equal(unknownImage.chargeState, "reserved");
    assert.equal((await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: unknownImage.id } })).providerJobId, null);
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: unknownRoot.jobId } })).status, "confirmation_required");
    console.log("PASS actual HTTP no-ID submission uncertainty retains exposure and cannot resume through approval");
    console.log("PASS ordinary image cap HTTP response creates exact linked incremental approval without terminal refund");
    console.log(`PASS ordinary USER approved ${SOURCE} through real orchestrator to held preview; numeric cap propagated; authoritative funding transferred once (media/render providers stubbed)`);
  } finally { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
