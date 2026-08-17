import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "scene-reroll-apply-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const {
    commitAppliedSceneRerollAssetsInTransaction,
    prepareAppliedSceneRerollAssets,
  } = await import("../src/lib/scene-reroll-apply.server");
  const { finishJobWithTransition } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");

  const deps = {
    findDerivativeBySrc: async (input: { src: string }) => {
      if (input.src === "/api/stocks/broll-ai-candidate.mp4") {
        return {
            id: "derivative-1",
            userId: "user-1",
            imageJobId: "cm1234567890scenejob",
            sourceVideoJobId: "video-source-1",
            sceneIndex: 2,
            src: "/api/stocks/broll-ai-candidate.mp4",
            status: "ready",
            appliedVideoJobId: null,
        };
      }
      if (input.src === "/api/stocks/broll-ai-already-applied.mp4") {
        return {
          id: "derivative-applied",
          userId: "user-1",
          imageJobId: "cm1234567890scenejob",
          sourceVideoJobId: "video-source-1",
          sceneIndex: 2,
          src: "/api/stocks/broll-ai-already-applied.mp4",
          status: "applied",
          appliedVideoJobId: "video-applied-1",
        };
      }
      return null;
    },
    findCandidate: async () => ({
      id: "cm1234567890scenejob",
      userId: "user-1",
      kind: "image",
      status: "completed",
      chargeState: "settled",
      productSurface: "scene_reroll",
      outputUrl: "/api/renders/scene-reroll.webp",
      inputJson: JSON.stringify({ videoJobId: "video-source-1", sceneIndex: 2 }),
    }),
    resolveVisualPrompt: async () => ({
      projectId: "project-1",
      visualBeatId: "beat-2",
      identityKey: "identity-v1",
    }),
  };

  const prepared = await prepareAppliedSceneRerollAssets({
    userId: "user-1",
    sourceVideoJobId: "video-source-1",
    edits: [{
      index: 2,
      src: "/api/stocks/broll-ai-candidate.mp4",
      replacementKind: "ai",
      imageJobId: "cm1234567890scenejob",
    }],
  }, deps);
  assert.deepEqual(prepared, [{
    derivativeId: "derivative-1",
    userId: "user-1",
    sourceVideoJobId: "video-source-1",
    sceneIndex: 2,
    src: "/api/stocks/broll-ai-candidate.mp4",
    beatId: "beat-2",
    outputUrl: "/api/renders/scene-reroll.webp",
    imageJobId: "cm1234567890scenejob",
    identityKey: "identity-v1",
  }]);

  assert.deepEqual(await prepareAppliedSceneRerollAssets({
    userId: "user-1",
    sourceVideoJobId: "video-source-1",
    edits: [{ index: 2, src: "/api/stocks/stock.mp4", replacementKind: "stock" }],
  }, deps), []);

  await assert.rejects(
    prepareAppliedSceneRerollAssets({
      userId: "user-1",
      sourceVideoJobId: "video-source-1",
      edits: [{
        index: 2,
        src: "/api/stocks/broll-ai-candidate.mp4",
        replacementKind: "ai",
      }],
    }, deps),
    /missing its exact image job binding/,
    "a server-owned paid derivative must never be silently applied without promotion metadata",
  );

  await assert.rejects(
    prepareAppliedSceneRerollAssets({
      userId: "user-1",
      sourceVideoJobId: "video-source-1",
      edits: [{
        index: 2,
        src: "/api/stocks/broll-ai-candidate.mp4",
        replacementKind: "stock",
      }],
    }, deps),
    /missing its exact image job binding/,
    "changing the client-declared kind cannot bypass paid derivative promotion",
  );

  assert.deepEqual(await prepareAppliedSceneRerollAssets({
    userId: "user-1",
    sourceVideoJobId: "video-after-apply",
    edits: [{
      index: 0,
      src: "/api/stocks/broll-ai-already-applied.mp4",
      replacementKind: "ai",
    }],
  }, deps), [], "an already-applied same-owner image can be moved without re-promoting it");
  await assert.rejects(
    prepareAppliedSceneRerollAssets({
      userId: "user-2",
      sourceVideoJobId: "video-after-apply",
      edits: [{
        index: 0,
        src: "/api/stocks/broll-ai-already-applied.mp4",
        replacementKind: "ai",
      }],
    }, deps),
    /does not belong to this user/,
    "an applied derivative remains owner-scoped when reused",
  );

  await assert.rejects(
    prepareAppliedSceneRerollAssets({
      userId: "user-1",
      sourceVideoJobId: "another-video",
      edits: [{
        index: 2,
        src: "/api/stocks/broll-ai-candidate.mp4",
        replacementKind: "ai",
        imageJobId: "cm1234567890scenejob",
      }],
    }, deps),
    /derivative does not belong to this video scene/,
  );
  await assert.rejects(
    prepareAppliedSceneRerollAssets({
      userId: "user-1",
      sourceVideoJobId: "video-source-1",
      edits: [{
        index: 2,
        src: "/api/stocks/another-internal-file.mp4",
        replacementKind: "ai",
        imageJobId: "cm1234567890scenejob",
      }],
    }, deps),
    /derivative does not belong to this video scene/,
    "Apply must bind the exact server-created derivative src to its image job",
  );

  const routeSource = readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
  assert.ok(
    !routeSource.includes("recordVisualBeatAsset"),
    "generation may stage a paid candidate but must not promote it before Apply",
  );
  assert.match(
    routeSource,
    /sceneRerollDerivative\.create/,
    "the generate route durably binds each ready MP4 derivative to its image job and source scene",
  );
  const orchestratorSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  const completedAt = orchestratorSource.indexOf("finishJobWithTransition(jobId");
  const promotedAt = orchestratorSource.indexOf("commitAppliedSceneRerollAssetsInTransaction(");
  assert.ok(
    completedAt >= 0
      && promotedAt > completedAt
      && orchestratorSource.slice(completedAt, promotedAt).includes("onTransition"),
    "Scene Reroll promotion and child completion share one durable transaction",
  );
  const inspectorSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx",
    "utf8",
  );
  assert.match(
    inspectorSource,
    /currentAsset\.imageJobId\s*\|\|\s*targetAsset\.imageJobId/u,
    "the editor must block moving a paid candidate until its deliberate Apply completes",
  );

  const owner = await prisma.user.create({
    data: { name: "Scene owner", email: "scene-reroll-apply@example.test" },
  });
  const project = await prisma.editorProject.create({ data: { userId: owner.id, title: "Scene apply" } });
  const preflight = await prisma.contentPreflight.create({
    data: {
      userId: owner.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "scene-reroll-apply-source",
      analyzerVersion: "brand-content-preflight-v3-treatment-plan",
      contentDomain: "creator education",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: "{}",
    },
  });
  const beat = await prisma.projectVisualBeat.create({
    data: {
      userId: owner.id,
      projectId: project.id,
      preflightId: preflight.id,
      beatKey: "window-2",
      sequence: 2,
      sourceExcerptHash: "scene-2",
      beatJson: "{}",
      generationIdentityKey: "identity-v1",
    },
  });
  const imageJob = await prisma.aiGenerationJob.create({
    data: {
      userId: owner.id,
      kind: "image",
      provider: "runpod",
      model: "z-image-turbo",
      status: "completed",
      chargeState: "settled",
      productSurface: "scene_reroll",
      outputUrl: "/api/renders/atomic-scene.webp",
      inputJson: JSON.stringify({ videoJobId: "source-job", sceneIndex: 2 }),
    },
  });
  const derivative = await prisma.sceneRerollDerivative.create({
    data: {
      userId: owner.id,
      imageJobId: imageJob.id,
      sourceVideoJobId: "source-job",
      sceneIndex: 2,
      src: "/api/stocks/atomic-scene.mp4",
    },
  });
  const child = await prisma.videoJob.create({
    data: { userId: owner.id, projectId: project.id, status: "processing", inputJson: "{}" },
  });
  await finishJobWithTransition(child.id, { videoUrl: "/api/renders/applied.mp4" }, {
    onTransition: ({ tx, job }) => commitAppliedSceneRerollAssetsInTransaction(tx, {
      appliedVideoJobId: job.id,
      promotions: [{
        derivativeId: derivative.id,
        userId: owner.id,
        sourceVideoJobId: "source-job",
        sceneIndex: 2,
        src: derivative.src,
        beatId: beat.id,
        outputUrl: imageJob.outputUrl!,
        imageJobId: imageJob.id,
        identityKey: "identity-v1",
      }],
    }),
  });
  assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: child.id } })).status, "done");
  assert.equal(
    (await prisma.sceneRerollDerivative.findUniqueOrThrow({ where: { id: derivative.id } })).appliedVideoJobId,
    child.id,
  );
  assert.equal(
    (await prisma.projectVisualBeat.findUniqueOrThrow({ where: { id: beat.id } })).existingImageJobId,
    imageJob.id,
  );

  const staleDerivative = await prisma.sceneRerollDerivative.create({
    data: {
      userId: owner.id,
      imageJobId: imageJob.id,
      sourceVideoJobId: "source-job",
      sceneIndex: 2,
      src: "/api/stocks/stale-scene.mp4",
    },
  });
  const losingChild = await prisma.videoJob.create({
    data: { userId: owner.id, projectId: project.id, status: "processing", inputJson: "{}" },
  });
  await assert.rejects(
    finishJobWithTransition(losingChild.id, { videoUrl: "/api/renders/must-rollback.mp4" }, {
      onTransition: ({ tx, job }) => commitAppliedSceneRerollAssetsInTransaction(tx, {
        appliedVideoJobId: job.id,
        promotions: [{
          derivativeId: staleDerivative.id,
          userId: owner.id,
          sourceVideoJobId: "source-job",
          sceneIndex: 2,
          src: staleDerivative.src,
          beatId: beat.id,
          outputUrl: imageJob.outputUrl!,
          imageJobId: imageJob.id,
          identityKey: "stale-identity",
        }],
      }),
    }),
    /identity changed/,
  );
  assert.equal(
    (await prisma.videoJob.findUniqueOrThrow({ where: { id: losingChild.id } })).status,
    "processing",
    "a failed promotion rolls back child completion",
  );
  assert.equal(
    (await prisma.sceneRerollDerivative.findUniqueOrThrow({ where: { id: staleDerivative.id } })).status,
    "ready",
    "a failed completion keeps its exact derivative recoverable",
  );

  console.log("verify-scene-reroll-apply: PASS deliberate Apply promotion, source binding, no eager route link");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
