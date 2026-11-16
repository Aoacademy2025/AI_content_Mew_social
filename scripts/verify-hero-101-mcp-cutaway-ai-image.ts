import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cutawayTimelineSourceFromJob,
  sceneRerollBeatTarget,
} from "../src/lib/cutaway-plan";
import {
  authorExternalMediaPlan,
  firstUnlockedCutawayWindowIndex,
  isPresenterHookWindow,
} from "../src/lib/external-media";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-hero-101-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  // 1. Cutaway beat target mapping:
  //    - Auto cutaway: odd windows -> broll beat floor(i/2), even windows -> presenter
  //    - fillYourself / stockSource:"none": all windows -> broll 1:1
  const autoSource = cutawayTimelineSourceFromJob({
    inputJson: JSON.stringify({ mode: "upload", cutawayLayout: "auto" }),
  });
  assert.deepEqual(sceneRerollBeatTarget(0, autoSource), { kind: "presenter" });
  assert.deepEqual(sceneRerollBeatTarget(1, autoSource), { kind: "broll", visualBeatSequence: 0 });
  assert.deepEqual(sceneRerollBeatTarget(2, autoSource), { kind: "presenter" });
  assert.deepEqual(sceneRerollBeatTarget(3, autoSource), { kind: "broll", visualBeatSequence: 1 });

  const fillYourselfSource = cutawayTimelineSourceFromJob({
    inputJson: JSON.stringify({ mode: "upload", cutawayLayout: "fillYourself", stockSource: "none" }),
  });
  assert.deepEqual(sceneRerollBeatTarget(0, fillYourselfSource), { kind: "broll", visualBeatSequence: 0 });
  assert.deepEqual(sceneRerollBeatTarget(2, fillYourselfSource), { kind: "broll", visualBeatSequence: 2 });
  assert.deepEqual(sceneRerollBeatTarget(4, fillYourselfSource), { kind: "broll", visualBeatSequence: 4 });

  // 2. firstUnlockedCutawayWindowIndex when opening presenter span covers windows 0 and 1
  const multiSpanConfig = authorExternalMediaPlan(
    {
      bgVideos: [
        { src: "/api/renders/presenter.mp4", start: 0, end: 3, brollEnabled: false },
        { src: "/api/renders/presenter.mp4", start: 3, end: 6, brollEnabled: false },
        { src: "/api/stocks/s1.mp4", start: 6, end: 10, brollEnabled: true },
        { src: "/api/renders/presenter.mp4", start: 10, end: 14, brollEnabled: false },
      ],
    },
    [{ startMs: 0, endMs: 6000 }, { startMs: 10000, endMs: 14000 }],
  );
  const multiSpanPreview = {
    avatarModel: "upload-cutaway",
    config: multiSpanConfig,
    cutawayPersonRanges: [{ start: 0, end: 6 }, { start: 10, end: 14 }],
  };
  assert.equal(isPresenterHookWindow(multiSpanPreview, "auto", 0), true);
  assert.equal(isPresenterHookWindow(multiSpanPreview, "auto", 1), true);
  assert.equal(isPresenterHookWindow(multiSpanPreview, "auto", 2), false);
  assert.equal(isPresenterHookWindow(multiSpanPreview, "auto", 3), false);
  assert.equal(firstUnlockedCutawayWindowIndex(multiSpanPreview, "auto"), 2);
  assert.equal(firstUnlockedCutawayWindowIndex(multiSpanPreview, "fillYourself"), 0);

  // 3. Database-backed verification for replaceBrollWindowTool & prepareAppliedSceneRerollAssets
  const { prisma } = await import("../src/lib/prisma");
  const { prepareAppliedSceneRerollAssets } = await import("../src/lib/scene-reroll-apply.server");
  const { replaceBrollWindowTool } = await import("../src/lib/mcp/edit-tools");

  const user = await prisma.user.create({
    data: {
      email: "hero101-test@aoacademy.co",
      name: "HERO-101 Tester",
      plan: "PRO",
      role: "ADMIN",
    },
  });
  const project = await prisma.editorProject.create({
    data: {
      userId: user.id,
      title: "HERO-101 Cutaway Project",
    },
  });
  const preflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "upload-transcript",
      sourceHash: "hero-101-hash",
      analyzerVersion: "brand-content-preflight-v3-treatment-plan",
      contentDomain: "coffee",
      suggestedVisualFormatId: "cinematic-realism",
      suggestedTreatmentJson: "{}",
    },
  });
  // Only odd window (window 1 -> sequence 0) has a pre-planned Visual Beat in auto-cutaway mode
  await prisma.projectVisualBeat.create({
    data: {
      userId: user.id,
      projectId: project.id,
      preflightId: preflight.id,
      beatKey: "beat-0",
      sequence: 0,
      sourceExcerptHash: "excerpt-0",
      beatJson: JSON.stringify({
        subject: "barista",
        action: "pouring coffee",
        setting: "cafe",
        emotion: "warm",
        emphasis: "steam",
      }),
      generationIdentityKey: "id-key-0",
    },
  });

  const cutawayJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      type: "create",
      status: "done",
      contentPreflightId: preflight.id,
      projectVisualContextJson: JSON.stringify({
        schemaVersion: 2,
        source: "suggested",
        visualFormatId: "cinematic-realism",
        recipeVersion: "cinematic-realism-v2",
        treatment: "สารคดีใช้งานจริง",
        treatmentPin: {
          presetId: "practical-documentary",
          version: "v1",
          source: "adaptive",
        },
        brandVisualLanguage: null,
      }),
      inputJson: JSON.stringify({
        mode: "upload",
        cutawayLayout: "auto",
        mcpHold: true,
      }),
      outputJson: JSON.stringify({
        version: 2,
        videoUrl: "/api/renders/hero101-base.mp4",
        preview: {
          avatarModel: "upload-cutaway",
          voiceUrl: "/api/renders/hero101-voice.wav",
          audioDurationMs: 14000,
          fullText: "สวัสดีครับ วันนี้มาดูวิธีชงกาแฟ เริ่มจากบดเมล็ด เทน้ำร้อนช้าๆ",
          words: [
            { word: "สวัสดีครับ", startMs: 0, endMs: 3000 },
            { word: "วันนี้มาดูวิธีชงกาแฟ", startMs: 3000, endMs: 6000 },
            { word: "เริ่มจากบดเมล็ด", startMs: 6000, endMs: 10000 },
            { word: "เทน้ำร้อนช้าๆ", startMs: 10000, endMs: 14000 },
          ],
          cutawayPersonRanges: [{ start: 0, end: 6 }, { start: 10, end: 14 }],
          captions: [
            { text: "สวัสดีครับ", startMs: 0, endMs: 3000 },
            { text: "วันนี้มาดูวิธีชงกาแฟ", startMs: 3000, endMs: 6000 },
            { text: "เริ่มจากบดเมล็ด", startMs: 6000, endMs: 10000 },
            { text: "เทน้ำร้อนช้าๆ", startMs: 10000, endMs: 14000 },
          ],
          config: multiSpanConfig,
        },
      }),
    },
  });
  await prisma.editorProject.update({
    where: { id: project.id },
    data: { activeJobId: cutawayJob.id },
  });

  // 3a. Calling replaceBrollWindowTool on locked windowIndex 0 or 1 returns dynamic firstUnlocked = 2
  const locked0 = await replaceBrollWindowTool(user, {
    jobId: cutawayJob.id,
    windowIndex: 0,
    source: "hero-ai-image",
    prompt: "coffee beans",
  } as never) as Record<string, unknown>;
  assert.equal(locked0.error, "window_locked_presenter_hook");
  assert.match(String(locked0.next), /windowIndex ตั้งแต่ 2/, `Expected windowIndex >= 2 hint, got: ${locked0.next}`);

  const locked1 = await replaceBrollWindowTool(user, {
    jobId: cutawayJob.id,
    windowIndex: 1,
    source: "hero-ai-image",
    prompt: "coffee beans",
  } as never) as Record<string, unknown>;
  assert.equal(locked1.error, "window_locked_presenter_hook");
  assert.match(String(locked1.next), /windowIndex ตั้งแต่ 2/);

  // 3b. Calling prepareAppliedSceneRerollAssets for even non-hook presenter window (windowIndex: 2)
  const imageJob2 = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      status: "completed",
      chargeState: "settled",
      productSurface: "scene_reroll",
      outputUrl: "/api/renders/hero101-win2.webp",
      inputJson: JSON.stringify({ videoJobId: cutawayJob.id, sceneIndex: 2 }),
    },
  });
  const deriv2 = await prisma.sceneRerollDerivative.create({
    data: {
      userId: user.id,
      imageJobId: imageJob2.id,
      sourceVideoJobId: cutawayJob.id,
      sceneIndex: 2,
      src: "/api/stocks/broll-ai-hero101-win2.mp4",
    },
  });

  const promotions = await prepareAppliedSceneRerollAssets({
    userId: user.id,
    sourceVideoJobId: cutawayJob.id,
    edits: [
      {
        index: 2,
        src: deriv2.src,
        replacementKind: "ai",
        imageJobId: imageJob2.id,
      },
    ],
  });
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.derivativeId, deriv2.id);
  assert.equal(promotions[0]?.beatId, null, "Even cutaway presenter window converted to AI B-roll has no pre-planned Visual Beat");

  await prisma.$disconnect();
  console.log("verify-hero-101-mcp-cutaway-ai-image: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
