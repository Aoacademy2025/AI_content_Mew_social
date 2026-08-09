import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "content-preflight-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    recordVisualBeatAsset,
    resolveContentPreflight,
    reusableVisualBeatAssetsForVideoJob,
  } = await import("../src/lib/content-preflight.server");

  const user = await prisma.user.create({
    data: { name: "Preflight owner", email: "preflight@example.test" },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Creator script" },
  });
  let analysisCalls = 0;
  let edited = false;
  const analyzer = {
    async analyze() {
      analysisCalls += 1;
      return {
        contentDomain: "personal finance",
        suggestedVisualFormatId: "clear-infographic" as const,
        suggestedTreatment: { label: "ชัด กระชับ น่าเชื่อถือ", mood: "professional" },
        beats: [
          {
            beatKey: "window-0",
            sourceExcerpt: edited
              ? "เก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ"
              : "เก็บเงินก้อนแรกให้ได้ด้วยวิธีนี้",
            subject: "a first-jobber and a savings jar",
            action: edited ? "sets one automatic transfer on a phone" : "places one coin into the jar",
            setting: "a small apartment desk",
            emotion: "hopeful focus",
            emphasis: "the first repeatable saving action",
          },
          {
            beatKey: "window-1",
            sourceExcerpt: "เริ่มวันนี้แล้วทำต่อทุกเดือน",
            subject: "the same first-jobber and a calendar rhythm",
            action: "repeats the saving habit",
            setting: "the same apartment desk",
            emotion: "confident momentum",
            emphasis: "consistent monthly action",
          },
        ],
      };
    },
  };

  const request = {
    userId: user.id,
    projectId: project.id,
    narrativeSource: {
      kind: "creator-script" as const,
      text: "เก็บเงินก้อนแรกให้ได้ด้วยวิธีนี้\nเริ่มวันนี้แล้วทำต่อทุกเดือน",
    },
    analyzer,
  };
  const first = await resolveContentPreflight(request);
  const cached = await resolveContentPreflight(request);

  assert.equal(analysisCalls, 1, "opening multiple AI visual surfaces must reuse one lazy analysis");
  assert.equal(cached.id, first.id);
  assert.equal(first.visualBeats.length, 2);
  assert.equal(await prisma.contentPreflight.count(), 1);

  await recordVisualBeatAsset({
    userId: user.id,
    beatId: first.visualBeats[0].id,
    outputUrl: "/api/generated/old-hook.webp",
  });
  await recordVisualBeatAsset({
    userId: user.id,
    beatId: first.visualBeats[1].id,
    outputUrl: "/api/generated/unchanged-close.webp",
  });
  edited = true;
  const afterEdit = await resolveContentPreflight({
    ...request,
    narrativeSource: {
      ...request.narrativeSource,
      text: "เก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ\nเริ่มวันนี้แล้วทำต่อทุกเดือน",
    },
  });
  assert.equal(afterEdit.visualBeats.filter((beat) => beat.status === "outdated").length, 1);
  assert.equal(afterEdit.visualBeats[0].existingAssetUrl, "/api/generated/old-hook.webp");
  assert.equal(afterEdit.visualBeats[1].status, "current");
  assert.equal(afterEdit.visualBeats[1].existingAssetUrl, "/api/generated/unchanged-close.webp");

  const videoJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      inputJson: "{}",
    },
  });
  const reusable = await reusableVisualBeatAssetsForVideoJob({
    userId: user.id,
    videoJobId: videoJob.id,
  });
  assert.deepEqual(
    reusable.map(({ sceneIndex, outputUrl }) => ({ sceneIndex, outputUrl })),
    [{ sceneIndex: 1, outputUrl: "/api/generated/unchanged-close.webp" }],
    "the next confirmed render must reuse only unchanged current beats",
  );

  await prisma.$disconnect();
  console.log("verify-content-preflight: PASS lazy cache + selective staleness + unchanged asset reuse");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
