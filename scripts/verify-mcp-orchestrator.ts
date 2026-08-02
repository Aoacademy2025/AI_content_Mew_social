//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-orchestrator.ts
import { prisma } from "../src/lib/prisma";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";
import { claimNextRunnableJob, parseVideoJobOutput } from "../src/lib/mcp/video-job";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

function mockCaller(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const handle = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return (responses[path.split("?")[0]] ?? {}) as never;
  };
  return { calls, caller: { post: handle("POST"), patch: handle("PATCH"), get: handle("GET") } };
}

async function main() {
  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  const u = await prisma.user.create({ data: { name: "u", email: "u@t.test", plan: "PRO", geminiKey: "g", pexelsKey: "p", usageCount: 2 } });
  const job = await prisma.videoJob.create({ data: { userId: u.id, status: "processing", inputJson: JSON.stringify({ script: "สวัสดีโลก", voiceProvider: "gemini" }) } });

  const { calls, caller } = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/api/renders/v.wav", audioDurationMs: 2000, timing: { provider: "gemini", segments: [{ text: "สวัสดีโลก", startMs: 0, durationMs: 2000 }], chars: null } },
    "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
    "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
    "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/v.wav", bgVideos: [] } },
    "/api/videos/render": { jobId: "job-1" },
    "/api/videos/render-progress": { progress: 100, stage: "done", videoUrl: "/api/renders/out.mp4", error: null },
    "/api/videos": { id: "vid_1" },
    "/api/videos/vid_1": { ok: true },
  });

  let refunded = 0;
  await runOrchestrator(job.id, u.id, {
    caller: caller as never,
    refundOneClip: async () => { refunded++; },
    sleep: async () => {},
  });

  const paths = calls.map((c) => c.path.split("?")[0]);
  assert(paths.includes("/api/videos/tts-gemini"), "calls tts-gemini for gemini provider");
  assert(paths.indexOf("/api/videos/extract-keywords") < paths.indexOf("/api/videos/fetch-stock"), "keywords before stock");
  assert(paths.indexOf("/api/videos/generate-config") < paths.indexOf("/api/videos/render"), "config before render");
  assert(paths.filter((p) => p === "/api/videos/render").length === 2, "two render calls (base + burn)");
  assert(calls.some((c) => c.method === "PATCH" && c.path === "/api/videos/vid_1"), "PATCHes the video row to COMPLETED");
  // NON-AVATAR (MON-2): finalBase == baseUrl, so the burn's isBurnAlreadyPaid() matches the
  // base's ChargedClip and the burn is FREE — the base's single charge IS the net-1. The
  // orchestrator must NOT refund here (refunding would net 0 = full quota bypass).
  assert(refunded === 0, "non-avatar: NO refund — base's single ChargedClip is the net-1 charge");

  const done = await prisma.videoJob.findUnique({ where: { id: job.id } });
  assert(done?.status === "done" && done?.videoId === "vid_1", "job → done with videoId");

  // failure path: render returns error stage
  const job2 = await prisma.videoJob.create({ data: { userId: u.id, status: "processing", inputJson: JSON.stringify({ script: "x", voiceProvider: "gemini" }) } });
  const m2 = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/v", audioDurationMs: 1000, timing: { provider: "gemini", segments: [{ text: "x", startMs: 0, durationMs: 1000 }], chars: null } },
    "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [1] },
    "/api/videos/fetch-stock": { results: [] },
    "/api/videos/generate-config": { config: {} },
    "/api/videos/render": { jobId: "j2" },
    "/api/videos/render-progress": { progress: -1, stage: "error", videoUrl: null, error: "render boom" },
  });
  await runOrchestrator(job2.id, u.id, { caller: m2.caller as never, refundOneClip: async () => {}, sleep: async () => {} });
  const failed = await prisma.videoJob.findUnique({ where: { id: job2.id } });
  assert(failed?.status === "failed" && (failed?.errorMessage ?? "").includes("render"), "render error → job failed");

  // Missing provider timing must recover through audio transcription/forced alignment.
  // A single-segment character clock can preserve text, but cannot prove that captions
  // appear with the spoken words, so it is not an acceptable final-output fallback.
  const fallbackScript = "ประหยัดเงิน 500 บาท";
  const jobTimingFallback = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      inputJson: JSON.stringify({ script: fallbackScript, voiceProvider: "gemini" }),
    },
  });
  const timingFallback = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/api/renders/fallback.wav", audioDurationMs: 2000 },
    "/api/videos/transcribe": {
      captions: [{ text: fallbackScript, startMs: 120, endMs: 1900, tag: "hook" }],
      words: [
        { word: "ประหยัดเงิน", startMs: 120, endMs: 900 },
        { word: "500", startMs: 920, endMs: 1300 },
        { word: "บาท", startMs: 1320, endMs: 1900 },
      ],
      audioDurationMs: 2000,
    },
    "/api/videos/extract-keywords": { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
    "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
    "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/fallback.wav", bgVideos: [] } },
    "/api/videos/render": { jobId: "fallback-render" },
    "/api/videos/render-progress": { progress: 100, stage: "done", videoUrl: "/api/renders/fallback-out.mp4", error: null },
    "/api/videos": { id: "vid_fallback" },
    "/api/videos/vid_fallback": { ok: true },
  });
  await runOrchestrator(jobTimingFallback.id, u.id, {
    caller: timingFallback.caller as never,
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  assert(
    timingFallback.calls.some((call) => call.path === "/api/videos/transcribe"),
    "missing TTS timing: recovers through audio transcription instead of a degraded character clock",
  );

  const jobBadAlignment = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      inputJson: JSON.stringify({ script: fallbackScript, voiceProvider: "gemini" }),
    },
  });
  const badAlignment = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/api/renders/bad-alignment.wav", audioDurationMs: 2000 },
    "/api/videos/transcribe": {
      captions: [{ text: "ประหยัดเงิน 5,000 บาท", startMs: 100, endMs: 1900, tag: "hook" }],
      words: [],
      audioDurationMs: 2000,
    },
    "/api/videos/extract-keywords": { keywords: ["saving"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
    "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
    "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/bad-alignment.wav", bgVideos: [] } },
    "/api/videos/render": { jobId: "bad-alignment-render" },
    "/api/videos/render-progress": { progress: 100, stage: "done", videoUrl: "/api/renders/bad-alignment-out.mp4", error: null },
    "/api/videos": { id: "vid_bad_alignment" },
    "/api/videos/vid_bad_alignment": { ok: true },
  });
  await runOrchestrator(jobBadAlignment.id, u.id, {
    caller: badAlignment.caller as never,
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const rejectedAlignment = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobBadAlignment.id } });
  assert(
    rejectedAlignment.status === "failed"
      && !badAlignment.calls.some((call) => call.path === "/api/videos/render"),
    "subtitle quality gate: rejects changed words/numbers before rendering",
  );

  const wordModeScript = "เก็บเงิน 500 บาท ทุกเดือน";
  const jobForcedWordMode = await prisma.videoJob.create({
    data: {
      userId: u.id,
      status: "processing",
      inputJson: JSON.stringify({ script: wordModeScript, voiceProvider: "gemini", subtitleMode: "2" }),
    },
  });
  const forcedWordMode = mockCaller({
    "/api/videos/tts-gemini": { voiceUrl: "/api/renders/word-mode.wav", audioDurationMs: 2400 },
    "/api/videos/transcribe": {
      captions: [{ text: wordModeScript, startMs: 100, endMs: 2300, tag: "hook" }],
      words: [
        { word: "เก็บเงิน", startMs: 100, endMs: 650 },
        { word: "500", startMs: 700, endMs: 1050 },
        { word: "บาท", startMs: 1100, endMs: 1500 },
        { word: "ทุกเดือน", startMs: 1550, endMs: 2300 },
      ],
      audioDurationMs: 2400,
    },
    "/api/videos/extract-keywords": { keywords: ["saving", "monthly"], keywordsPerScene: 5, sceneClipCounts: [1, 1], sceneDurations: [1.2, 1.2] },
    "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
    "/api/videos/generate-config": { config: { durationInFrames: 72, voiceFile: "/api/renders/word-mode.wav", bgVideos: [] } },
    "/api/videos/render": { jobId: "word-mode-render" },
    "/api/videos/render-progress": { progress: 100, stage: "done", videoUrl: "/api/renders/word-mode-out.mp4", error: null },
    "/api/videos": { id: "vid_word_mode" },
    "/api/videos/vid_word_mode": { ok: true },
  });
  await runOrchestrator(jobForcedWordMode.id, u.id, {
    caller: forcedWordMode.caller as never,
    refundOneClip: async () => {},
    sleep: async () => {},
  });
  const forcedWordModeResult = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobForcedWordMode.id } });
  assert(
    forcedWordModeResult.status === "done",
    "forced alignment: word-count subtitle modes retain exact text and complete",
  );

  // -------------------------------------------------------------------------
  // Avatar case: avatarMode:"full" + avatarId:"av1"
  // -------------------------------------------------------------------------
  const jobAv = await prisma.videoJob.create({
    data: {
      userId: u.id, status: "processing",
      inputJson: JSON.stringify({ script: "สวัสดีโลก", voiceProvider: "gemini", avatarMode: "full", avatarId: "av1", avatarScale: 1.3 }),
    },
  });

  // Capture POST bodies keyed by path so we can assert them later.
  const avPostBodies: Record<string, unknown[]> = {};
  const avCalls: { method: string; path: string; body?: unknown }[] = [];
  let avRenderCount = 0;
  const avCaller = {
    post: async (path: string, body?: unknown) => {
      const key = path.split("?")[0];
      avPostBodies[key] = [...(avPostBodies[key] ?? []), body];
      avCalls.push({ method: "POST", path: key, body });
      // Render calls: first → base render job, second → burn render job
      if (key === "/api/videos/render") {
        avRenderCount++;
        return { jobId: `av-render-${avRenderCount}` } as never;
      }
      const responses: Record<string, unknown> = {
        "/api/videos/tts-gemini": { voiceUrl: "/api/renders/av.wav", audioDurationMs: 2000, timing: { provider: "gemini", segments: [{ text: "สวัสดีโลก", startMs: 0, durationMs: 2000 }], chars: null } },
        "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
        "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
        "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/av.wav", bgVideos: [] } },
        "/api/videos/trim-audio": { audioUrl: "trim" },
        "/api/heygen/generate-with-bg": { videoId: "hg1" },
        "/api/videos/poll-avatar": { status: "completed", videoUrl: "AVATAR", thumbnailUrl: null, errorMsg: null },
        "/api/heygen/composite": { videoUrl: "COMPOSITE", usedMode: "chromakey" },
        "/api/videos": { id: "vid_av" },
      };
      return (responses[key] ?? {}) as never;
    },
    patch: async (path: string, body?: unknown) => {
      avCalls.push({ method: "PATCH", path: path.split("?")[0], body });
      return {} as never;
    },
    get: async (path: string) => {
      const key = path.split("?")[0];
      avCalls.push({ method: "GET", path: key });
      // render-progress always returns done
      if (key === "/api/videos/render-progress") return { progress: 100, stage: "done", videoUrl: "/api/renders/av-out.mp4", error: null } as never;
      return {} as never;
    },
  };

  let avRefunded = 0;
  await runOrchestrator(jobAv.id, u.id, {
    caller: avCaller as never,
    refundOneClip: async () => { avRefunded++; },
    sleep: async () => {},
  });

  const jobAvWaiting = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobAv.id } });
  assert(jobAvWaiting.status === "waiting_provider" && !!jobAvWaiting.providerCheckpointJson, "avatar case: first run parks with durable provider checkpoint");
  assert((avPostBodies["/api/heygen/generate-with-bg"] ?? []).length === 1, "avatar case: first run generates exactly once");
  assert((avPostBodies["/api/videos/tts-gemini"] ?? []).length === 1 && avRenderCount === 1, "avatar case: first run performs TTS/base render once");
  assert((await claimNextRunnableJob(new Date(Date.now() + 3 * 60 * 60_000)))?.id === jobAv.id, "avatar case: due provider wait is reclaimed");
  await runOrchestrator(jobAv.id, u.id, {
    caller: avCaller as never,
    refundOneClip: async () => { avRefunded++; },
    sleep: async () => {},
  });
  assert((avPostBodies["/api/heygen/generate-with-bg"] ?? []).length === 1, "avatar case: resume never generates again");
  assert((avPostBodies["/api/videos/tts-gemini"] ?? []).length === 1, "avatar case: resume skips TTS");

  // AVATAR: the base's single reservation remains the charge for the delivered video.
  // Composite publishes a paid marker for its derived output, so the burn stays free.
  // Refunding the base here would make the successful avatar video net-zero billed.
  assert(avRefunded === 0, "avatar success: keeps the base reservation as the single net charge");

  // Assert POST /api/videos body has avatarModel === "av1" (not "none")
  const createVideoBody = (avPostBodies["/api/videos"] ?? [])[0] as Record<string, unknown> | undefined;
  assert(createVideoBody != null, "avatar case: POST /api/videos was called");
  assert(createVideoBody?.avatarModel === "av1", `avatar case: avatarModel is "av1" (got ${String(createVideoBody?.avatarModel)})`);

  // Assert the burn render's subtitleOverlayConfig references "COMPOSITE" (not the base URL)
  const renderBodies = avPostBodies["/api/videos/render"] ?? [];
  assert(renderBodies.length === 2, `avatar case: two render calls (got ${renderBodies.length})`);
  const burnBody = renderBodies[1] as Record<string, unknown> | undefined;
  const subCfg = burnBody?.subtitleOverlayConfig as Record<string, unknown> | undefined;
  const subSrc = subCfg?.videoUrl ?? subCfg?.src ?? JSON.stringify(subCfg);
  assert(String(subSrc).includes("COMPOSITE"), `avatar case: burn subtitleOverlayConfig references COMPOSITE (got ${String(subSrc)})`);

  const compositeBody = (avPostBodies["/api/heygen/composite"] ?? [])[0] as Record<string, unknown> | undefined;
  assert(compositeBody != null, "avatar case: POST /api/heygen/composite was called");
  assert((compositeBody?.avatarLayout as Record<string, unknown> | undefined)?.scale === 1.3, "orchestrator forwards avatarScale to composite layout");

  const jobAvDone = await prisma.videoJob.findUnique({ where: { id: jobAv.id } });
  assert(jobAvDone?.status === "done" && jobAvDone?.videoId === "vid_av", "avatar case: job → done with videoId vid_av");
  const avatarOutput = parseVideoJobOutput(jobAvDone?.outputJson);
  assert(
    avatarOutput.subtitleQa?.status === "passed" && avatarOutput.subtitleQa.timingSource === "tts_segment_timing",
    "avatar case: resumed output carries the passed subtitle QA receipt",
  );

  // -------------------------------------------------------------------------
  // Avatar + previewMode (MON-2 4th combination): composite runs, NO burn, NO refund.
  // Net = 1 — the base's ChargedClip stands as the single charge; the later web burn of
  // the composite re-reserves its own clip, keeping the delivered video at exactly 1.
  // -------------------------------------------------------------------------
  const jobAvPrev = await prisma.videoJob.create({
    data: {
      userId: u.id, status: "processing",
      inputJson: JSON.stringify({ script: "สวัสดีโลก", voiceProvider: "gemini", avatarMode: "full", avatarId: "av1", previewMode: true }),
    },
  });
  const avPrevPaths: string[] = [];
  let avPrevRenderCount = 0;
  let avPrevRefunded = 0;
  const avPrevCaller = {
    post: async (path: string) => {
      const key = path.split("?")[0];
      avPrevPaths.push(key);
      if (key === "/api/videos/render") { avPrevRenderCount++; return { jobId: `avp-render-${avPrevRenderCount}` } as never; }
      const responses: Record<string, unknown> = {
        "/api/videos/tts-gemini": { voiceUrl: "/api/renders/avp.wav", audioDurationMs: 2000, timing: { provider: "gemini", segments: [{ text: "สวัสดีโลก", startMs: 0, durationMs: 2000 }], chars: null } },
        "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
        "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
        "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/avp.wav", bgVideos: [] } },
        "/api/videos/trim-audio": { audioUrl: "trim" },
        "/api/heygen/generate-with-bg": { videoId: "hg1" },
        "/api/videos/poll-avatar": { status: "completed", videoUrl: "AVATAR", thumbnailUrl: null, errorMsg: null },
        "/api/heygen/composite": { videoUrl: "COMPOSITE", usedMode: "chromakey" },
      };
      return (responses[key] ?? {}) as never;
    },
    patch: async () => ({} as never),
    get: async (path: string) => {
      const key = path.split("?")[0];
      if (key === "/api/videos/render-progress") return { progress: 100, stage: "done", videoUrl: "/api/renders/avp-out.mp4", error: null } as never;
      return {} as never;
    },
  };
  await runOrchestrator(jobAvPrev.id, u.id, { caller: avPrevCaller as never, refundOneClip: async () => { avPrevRefunded++; }, sleep: async () => {} });
  const avPrevWaiting = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobAvPrev.id } });
  assert(avPrevWaiting.status === "waiting_provider", "avatar+preview: first run parks instead of occupying a worker slot");
  assert((await claimNextRunnableJob(new Date(Date.now() + 3 * 60 * 60_000)))?.id === jobAvPrev.id, "avatar+preview: due wait is reclaimed");
  await runOrchestrator(jobAvPrev.id, u.id, { caller: avPrevCaller as never, refundOneClip: async () => { avPrevRefunded++; }, sleep: async () => {} });
  assert(avPrevPaths.filter((p) => p === "/api/heygen/generate-with-bg").length === 1, "avatar+preview: resume does not generate twice");
  assert(avPrevPaths.filter((p) => p === "/api/videos/tts-gemini").length === 1, "avatar+preview: resume skips TTS");
  assert(avPrevPaths.filter((p) => p === "/api/videos/render").length === 1, "avatar+preview: ONE render (base only, no burn)");
  assert(!avPrevPaths.includes("/api/videos"), "avatar+preview: NO gallery row (web burn creates it)");
  assert(avPrevRefunded === 0, "avatar+preview: NO refund — base charge stands (net 1)");
  const jobAvPrevDone = await prisma.videoJob.findUnique({ where: { id: jobAvPrev.id } });
  assert(jobAvPrevDone?.status === "done", "avatar+preview: job → done");

  // -------------------------------------------------------------------------
  // BGM case: bgmFile + bgmVolume injected into base render config
  // -------------------------------------------------------------------------
  const jobBgm = await prisma.videoJob.create({
    data: {
      userId: u.id, status: "processing",
      inputJson: JSON.stringify({ script: "สวัสดีโลก", voiceProvider: "gemini", bgmFile: "/music/x.mp3", bgmVolume: 0.3 }),
    },
  });

  const bgmPostBodies: Record<string, unknown[]> = {};
  let bgmRenderCount = 0;
  const bgmCaller = {
    post: async (path: string, body?: unknown) => {
      const key = path.split("?")[0];
      bgmPostBodies[key] = [...(bgmPostBodies[key] ?? []), body];
      if (key === "/api/videos/render") {
        bgmRenderCount++;
        return { jobId: `bgm-render-${bgmRenderCount}` } as never;
      }
      const responses: Record<string, unknown> = {
        "/api/videos/tts-gemini": { voiceUrl: "/api/renders/bgm.wav", audioDurationMs: 2000, timing: { provider: "gemini", segments: [{ text: "สวัสดีโลก", startMs: 0, durationMs: 2000 }], chars: null } },
        "/api/videos/extract-keywords": { keywords: ["a"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [2] },
        "/api/videos/fetch-stock": { results: [{ src: "clip.mp4" }] },
        "/api/videos/generate-config": { config: { durationInFrames: 60, voiceFile: "/api/renders/bgm.wav", bgVideos: [] } },
        "/api/videos": { id: "vid_bgm" },
      };
      return (responses[key] ?? {}) as never;
    },
    patch: async () => ({} as never),
    get: async (path: string) => {
      const key = path.split("?")[0];
      if (key === "/api/videos/render-progress") return { progress: 100, stage: "done", videoUrl: "/api/renders/bgm-out.mp4", error: null } as never;
      return {} as never;
    },
  };

  await runOrchestrator(jobBgm.id, u.id, {
    caller: bgmCaller as never,
    refundOneClip: async () => {},
    sleep: async () => {},
  });

  const bgmRenderBodies = bgmPostBodies["/api/videos/render"] ?? [];
  assert(bgmRenderBodies.length >= 1, `bgm case: at least one render call (got ${bgmRenderBodies.length})`);
  const bgmBaseBody = bgmRenderBodies[0] as Record<string, unknown> | undefined;
  const bgmShortCfg = bgmBaseBody?.shortVideoConfig as Record<string, unknown> | undefined;
  assert(bgmShortCfg?.bgmFile === "/music/x.mp3" && bgmShortCfg?.bgmVolume === 0.3, "bgmFile/Volume injected into base render config");

  const jobBgmDone = await prisma.videoJob.findUnique({ where: { id: jobBgm.id } });
  assert(jobBgmDone?.status === "done" && jobBgmDone?.videoId === "vid_bgm", "bgm case: job → done with videoId vid_bgm");

  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} ORCHESTRATOR CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
