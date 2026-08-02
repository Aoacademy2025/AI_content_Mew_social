// 5 read-only tool functions: scoping, cross-user denial, title/duration derivation.
//   ROOT="$(pwd)"
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="file:$ROOT/prisma/test-mcp.db?connection_limit=1" npx tsx scripts/verify-mcp-tools.ts
import { prisma } from "../src/lib/prisma";
import {
  getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoJobStatusTool, getVideoTool, downloadVideoTool,
} from "../src/lib/mcp/tools";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

async function main() {
  await prisma.video.deleteMany();
  await prisma.content.deleteMany();
  await prisma.user.deleteMany();

  const alice = await prisma.user.create({ data: { name: "alice", email: "alice@t.test", plan: "PRO", geminiKey: "g" } });
  const bob = await prisma.user.create({ data: { name: "bob", email: "bob@t.test", plan: "BUSINESS" } });

  const content = await prisma.content.create({ data: { userId: alice.id, headline: "My Headline", videoDuration: 60 } });
  const done = await prisma.video.create({ data: { userId: alice.id, contentId: content.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 3, status: "COMPLETED", videoUrl: "https://x/v.mp4" } });
  const pending = await prisma.video.create({ data: { userId: alice.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 2, status: "PROCESSING", script: "raw script text used as fallback title" } });
  const bobVideo = await prisma.video.create({ data: { userId: bob.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 1, status: "COMPLETED", videoUrl: "https://x/bob.mp4" } });

  // get_current_user
  const me = await getCurrentUserTool(alice);
  assert(me.plan === "PRO" && me.effectivePlan === "PRO", "get_current_user returns plan");
  assert(me.keysConfigured.gemini === true && me.keysConfigured.heygen === false, "keysConfigured reflects set keys");

  // list_my_videos — scoped + title/duration derivation
  const list = await listMyVideosTool(alice.id);
  assert(list.length === 2, "list_my_videos returns only the caller's videos");
  assert(list.every((v) => v.id !== bobVideo.id), "list_my_videos never leaks another user's video");
  const doneItem = list.find((v) => v.id === done.id)!;
  assert(doneItem.title === "My Headline", "title comes from content.headline");
  assert(doneItem.durationSec === 60, "durationSec comes from content.videoDuration");
  assert(doneItem.hasDownload === true, "hasDownload true when videoUrl present");
  const pendingItem = list.find((v) => v.id === pending.id)!;
  assert(pendingItem.title.startsWith("raw script"), "title falls back to script when no headline");

  // get_video_status — cross-user denial
  const st = await getVideoStatusTool(alice.id, done.id);
  assert(st.found && st.status === "COMPLETED" && st.hasDownload === true, "get_video_status: owner sees COMPLETED");
  assert((await getVideoStatusTool(alice.id, bobVideo.id)).found === false, "get_video_status denies cross-user");

  const completedJob = await prisma.videoJob.create({
    data: {
      userId: alice.id,
      status: "done",
      progress: 100,
      inputJson: JSON.stringify({ script: "พร้อมใช้" }),
      outputJson: JSON.stringify({
        videoUrl: "/api/renders/final.mp4",
        subtitleQa: {
          status: "passed",
          timingSource: "provider_alignment",
          textExact: true,
          captionCount: 2,
          audioDurationMs: 3000,
        },
        billingReceipt: {
          status: "settled",
          funding: "credits",
          renderMinutes: 1,
          chargedMinutes: 0,
          chargedCredits: 2,
        },
      }),
    },
  });
  const completedJobStatus = await getVideoJobStatusTool(alice.id, completedJob.id);
  assert(
    completedJobStatus?.subtitleQa?.status === "passed"
      && completedJobStatus.billingReceipt?.status === "settled"
      && completedJobStatus.billingReceipt.funding === "credits",
    "get_video_status exposes final subtitle QA and billing receipt",
  );
  assert(
    (await getVideoJobStatusTool(bob.id, completedJob.id)) === null,
    "get_video_status never exposes another user's job receipt",
  );

  // get_video
  const gv = await getVideoTool(alice.id, pending.id);
  assert(gv.found && gv.status === "PROCESSING" && gv.hasDownload === false, "get_video returns detail for owner");
  assert((await getVideoTool(alice.id, bobVideo.id)).found === false, "get_video denies cross-user");

  // download_video
  const dl = await downloadVideoTool(alice.id, done.id);
  assert(dl.found && dl.ready && dl.url === "https://x/v.mp4", "download_video returns url when COMPLETED");
  const dlPending = await downloadVideoTool(alice.id, pending.id);
  assert(dlPending.found && dlPending.ready === false, "download_video not-ready for processing video");
  assert((await downloadVideoTool(alice.id, bobVideo.id)).found === false, "download_video denies cross-user");

  await prisma.video.deleteMany();
  await prisma.content.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MCP TOOLS CHECKS PASSED`);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
