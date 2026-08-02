// MCP read-only tool functions: ownership scoping + complete output metadata.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mcp-tools-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    getCurrentUserTool, listMyVideosTool, getVideoStatusTool, getVideoJobStatusTool, getVideoTool, downloadVideoTool,
  } = await import("../src/lib/mcp/tools");
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.example.test";
  await prisma.video.deleteMany();
  await prisma.content.deleteMany();
  await prisma.user.deleteMany();

  const alice = await prisma.user.create({ data: { name: "alice", email: "alice@t.test", plan: "PRO", geminiKey: "g" } });
  const bob = await prisma.user.create({ data: { name: "bob", email: "bob@t.test", plan: "BUSINESS" } });

  const content = await prisma.content.create({ data: { userId: alice.id, headline: "My Headline", videoDuration: 60 } });
  const done = await prisma.video.create({ data: { userId: alice.id, contentId: content.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 3, status: "COMPLETED", videoUrl: "https://x/v.mp4" } });
  const pending = await prisma.video.create({ data: { userId: alice.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 2, status: "PROCESSING", script: "raw script text used as fallback title" } });
  const relativeDone = await prisma.video.create({
    data: {
      userId: alice.id,
      avatarModel: "none",
      voiceModel: "elevenlabs",
      sceneCount: 2,
      status: "COMPLETED",
      script: "relative output",
      videoUrl: "/api/renders/relative.mp4",
      renderConfig: JSON.stringify({ durationInFrames: 158 }),
    },
  });
  const bobVideo = await prisma.video.create({ data: { userId: bob.id, avatarModel: "none", voiceModel: "gemini", sceneCount: 1, status: "COMPLETED", videoUrl: "https://x/bob.mp4" } });

  // get_current_user
  const me = await getCurrentUserTool(alice);
  assert(me.plan === "PRO" && me.effectivePlan === "PRO", "get_current_user returns plan");
  assert(me.keysConfigured.gemini === true && me.keysConfigured.heygen === false, "keysConfigured reflects set keys");

  // list_my_videos — scoped + title/duration derivation
  const list = await listMyVideosTool(alice.id);
  assert(list.length === 3, "list_my_videos returns only the caller's videos");
  assert(list.every((v) => v.id !== bobVideo.id), "list_my_videos never leaks another user's video");
  const doneItem = list.find((v) => v.id === done.id)!;
  assert(doneItem.title === "My Headline", "title comes from content.headline");
  assert(doneItem.durationSec === 60, "durationSec comes from content.videoDuration");
  assert(doneItem.hasDownload === true, "hasDownload true when videoUrl present");
  const pendingItem = list.find((v) => v.id === pending.id)!;
  assert(pendingItem.title.startsWith("raw script"), "title falls back to script when no headline");
  const relativeItem = list.find((v) => v.id === relativeDone.id)!;
  assert(relativeItem.durationSec === 5.27, "durationSec falls back to renderConfig when Content duration is absent");

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
      && completedJobStatus.billingReceipt.funding === "credits"
      && completedJobStatus.videoUrl === "https://studio.example.test/api/renders/final.mp4",
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
  const relativeDl = await downloadVideoTool(alice.id, relativeDone.id);
  assert(
    relativeDl.found
      && relativeDl.ready
      && relativeDl.url === "https://studio.example.test/api/renders/relative.mp4"
      && relativeDl.durationSec === 5.27,
    "download_video returns an absolute URL and derived duration for MCP clients",
  );
  const dlPending = await downloadVideoTool(alice.id, pending.id);
  assert(dlPending.found && dlPending.ready === false, "download_video not-ready for processing video");
  assert((await downloadVideoTool(alice.id, bobVideo.id)).found === false, "download_video denies cross-user");

  await prisma.video.deleteMany();
  await prisma.content.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MCP TOOLS CHECKS PASSED`);
}
main().catch((e) => { console.error(e); process.exit(1); });
