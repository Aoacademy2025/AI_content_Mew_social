import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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

  const { ensureUploadContentPreflight } = await import("../src/lib/upload-content-preflight.server");
  const priorRollout = {
    BRAND_VISUAL_SYSTEM_ENABLED: process.env.BRAND_VISUAL_SYSTEM_ENABLED,
    BRAND_VISUAL_ROLLOUT_PERCENT: process.env.BRAND_VISUAL_ROLLOUT_PERCENT,
    BRAND_VISUAL_ROLLOUT_STARTED_AT: process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT,
  };
  process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
  process.env.BRAND_VISUAL_ROLLOUT_PERCENT = "100";
  process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT = "2026-08-01T00:00:00.000Z";
  try {
    const calls: Array<{ kind: string; text: string; projectId: string }> = [];
    const result = await ensureUploadContentPreflight({
      actor: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      projectId: project.id,
      transcriptText: "เสียงจากคลิปอัปโหลดที่ถอดแล้ว",
    }, {
      resolve: async (input) => {
        calls.push({
          kind: input.narrativeSource.kind,
          text: input.narrativeSource.text,
          projectId: input.projectId,
        });
        return first;
      },
      createAnalyzer: () => analyzer,
    });
    assert.equal(result.kind, "resolved");
    assert.deepEqual(calls, [{
      kind: "upload-transcript",
      text: "เสียงจากคลิปอัปโหลดที่ถอดแล้ว",
      projectId: project.id,
    }]);

    const control = await ensureUploadContentPreflight({
      actor: {
        id: "pre-rollout-user",
        email: "pre-rollout@example.test",
        role: "USER",
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
      },
      projectId: project.id,
      transcriptText: "ไม่ควรวิเคราะห์ใน control",
    }, {
      resolve: async () => { throw new Error("control must not call analyzer"); },
      createAnalyzer: () => analyzer,
    });
    assert.deepEqual(control, { kind: "skipped", reason: "not-in-treatment" });
  } finally {
    for (const [name, value] of Object.entries(priorRollout)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const orchestratorSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  const uploadBranch = orchestratorSource.slice(orchestratorSource.indexOf('if (input.mode === "upload")'));
  assert.ok(
    uploadBranch.indexOf("await ensureUploadContentPreflight({") >= 0
      && uploadBranch.indexOf("await ensureUploadContentPreflight({") < uploadBranch.indexOf('await step("keywords", 40)'),
    "upload transcript preflight must resolve before keyword/image generation",
  );

  const selectorSource = readFileSync("src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx", "utf8");
  assert.ok(
    selectorSource.includes('const canLoadWithoutNarrative = p.mode === "upload";')
      && selectorSource.includes("if (!narrative && !canLoadWithoutNarrative)"),
    "upload mode must expose Brand Profile/Project Look before a transcript exists",
  );

  await prisma.$disconnect();
  console.log("verify-content-preflight: PASS lazy cache + selective staleness + upload transcript integration");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
