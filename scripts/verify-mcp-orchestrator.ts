//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-orchestrator.ts
import { prisma } from "../src/lib/prisma";
import { runOrchestrator } from "../src/lib/mcp/orchestrator";

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
  assert(refunded === 1, "refunds exactly one clip (net 1/video)");

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

  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} ORCHESTRATOR CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
