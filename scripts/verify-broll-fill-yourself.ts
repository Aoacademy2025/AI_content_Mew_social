// HERO-44 "ใส่ B-roll เอง": the customer fills B-roll windows themselves, so a run must
// plan the windows yet contact no keyword, stock or AI provider.
//
// Runs the real orchestrator against a throwaway SQLite (see `verify:broll-fill-yourself`).
// The composite stage needs real media and is outside this check; every assertion is on
// calls made before it.
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
  const u = await prisma.user.create({ data: { name: "u", email: "fill@t.test", plan: "PRO", usageCount: 0 } });

  // === upload-clip path ===
  const captions = Array.from({ length: 6 }, (_, i) => ({
    text: `ประโยคที่ ${i + 1}`, startMs: i * 4000, endMs: (i + 1) * 4000,
  }));
  const job = await prisma.videoJob.create({ data: { userId: u.id, status: "processing", inputJson: JSON.stringify({
    mode: "upload", clipUrl: "/api/renders/presenter.mp4", stockSource: "none", preview: true,
  }) } });
  const { calls, caller } = mockCaller({
    "/api/videos/transcribe": { captions, fullText: captions.map((c) => c.text).join(" "), audioDurationMs: 24000 },
    "/api/videos/generate-config": { config: { durationInFrames: 720, voiceFile: "/api/renders/presenter.mp4", bgVideos: [] } },
    "/api/videos/render": { jobId: "job-fill" },
    "/api/videos/render-progress": { progress: 100, stage: "done", videoUrl: "/api/renders/fill.mp4", error: null },
  });
  await runOrchestrator(job.id, u.id, { caller: caller as never, refundOneClip: async () => {}, sleep: async () => {} });

  const paths = calls.map((c) => c.path.split("?")[0]);
  assert(!paths.includes("/api/videos/extract-keywords"), "upload: no keyword extraction");
  assert(!paths.includes("/api/videos/fetch-stock"), "upload: no stock/AI provider call");
  const configBody = calls.find((c) => c.path === "/api/videos/generate-config")?.body as
    { brollWindows?: unknown[]; stockVideos?: Array<{ videoUrl?: string }> } | undefined;
  const windowCount = configBody?.brollWindows?.length ?? 0;
  assert(windowCount >= 2, `upload: the planned windows still reach generate-config (got ${windowCount})`);
  assert(
    (configBody?.stockVideos?.length ?? 0) === windowCount
      && (configBody?.stockVideos ?? []).every((v) => v.videoUrl === "/api/renders/presenter.mp4"),
    "upload: every window is backed by the presenter clip, none by fetched media",
  );
  assert(paths.includes("/api/videos/render"), "upload: the base render is requested");

  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} FILL-YOURSELF CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
