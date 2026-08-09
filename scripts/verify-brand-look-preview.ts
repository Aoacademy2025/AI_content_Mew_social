import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-look-preview-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { createBrandLookPreview, createUnsavedBrandLookPreview, rerollBrandLookPreviewItem } = await import("../src/lib/brand-look-preview.server");
  const user = await prisma.user.create({ data: { name: "Preview owner", email: "preview@example.test" } });
  const payload = {
    schemaVersion: 1 as const,
    name: "Preview brand",
    niche: "creator education",
    audience: "Thai creators",
    script: { styleId: null, tone: "direct", bannedWords: [], ctaStyle: "follow", language: "th" },
    voice: { provider: "elevenlabs", voiceId: null },
    subtitle: { presetId: null, config: {} },
    brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "stick-figure-story" as const,
      palette: ["#111111", "#F8F5EE", "#38BDF8"],
      personality: "bold handmade",
      peopleAndSetting: "Thai creator contexts",
      memorableCues: ["blue marker arrow"],
      visualNotes: "rough lines",
      defaultTreatment: "energetic",
    },
  };
  const profile = await prisma.brandProfile.create({
    data: { userId: user.id, name: payload.name, niche: payload.niche, audience: payload.audience, tone: payload.script.tone, activeRevisionNumber: 1 },
  });
  const revision = await prisma.brandProfileRevision.create({
    data: {
      brandProfileId: profile.id,
      version: 1,
      payloadJson: JSON.stringify(payload),
      visualRecipeJson: JSON.stringify({ visualFormatId: "stick-figure-story", recipeVersion: "stick-figure-story-v1" }),
    },
  });
  const project = await prisma.editorProject.create({ data: { userId: user.id, title: "Existing video", brandProfileRevisionId: revision.id } });
  const preflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "preview-source",
      analyzerVersion: "brand-content-preflight-v1",
      contentDomain: payload.niche,
      suggestedVisualFormatId: "stick-figure-story",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "bold" }),
    },
  });
  for (let index = 0; index < 3; index += 1) {
    await prisma.projectVisualBeat.create({
      data: {
        userId: user.id,
        projectId: project.id,
        preflightId: preflight.id,
        beatKey: `window-${index}`,
        sequence: index,
        sourceExcerptHash: `hash-${index}`,
        beatJson: JSON.stringify({ subject: "creator", action: "explains", setting: "studio", emotion: "focused", emphasis: "one idea" }),
        existingAssetUrl: `/generated/existing-${index}.webp`,
      },
    });
  }
  let generated = 0;
  const reused = await createBrandLookPreview({
    userId: user.id,
    profileId: profile.id,
    projectId: project.id,
    generator: async () => {
      generated += 1;
      throw new Error("must not generate");
    },
  });
  assert.equal(generated, 0);
  assert.equal(reused.status, "completed");
  assert.equal(reused.items.filter((item) => item.sourceType === "reused").length, 3);
  assert.equal(await prisma.aiGenerationJob.count(), 0, "reused previews consume no image entitlement");

  const profileCountBefore = await prisma.brandProfile.count({ where: { userId: user.id } });
  const unsavedReused = await createUnsavedBrandLookPreview({
    userId: user.id,
    projectId: project.id,
    payload,
    generator: async () => {
      throw new Error("an unsaved preview sourced from an existing clip must not generate");
    },
  });
  assert.equal(unsavedReused.status, "completed");
  assert.equal(unsavedReused.items.filter((item) => item.sourceType === "reused").length, 3);
  assert.equal(unsavedReused.brandProfileId, null);
  assert.equal(
    await prisma.brandProfile.count({ where: { userId: user.id } }),
    profileCountBefore,
    "previewing an unsaved Project Look cannot consume a Brand Profile slot",
  );
  assert.equal(await prisma.aiGenerationJob.count(), 0, "Editor preview reuses Hook/Explain/Close without another charge");

  const partial = await createBrandLookPreview({
    userId: user.id,
    profileId: profile.id,
    generator: async ({ phase }) => {
      generated += 1;
      if (phase === "explain") throw new Error("verify provider failure");
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/${phase}.webp`,
          fundingSource: "starter_allowance",
          allowanceUnits: 1,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(generated, 3);
  assert.equal(partial.status, "partial");
  assert.equal(partial.items.filter((item) => item.status === "completed").length, 2);
  assert.equal(partial.items.filter((item) => item.status === "failed").length, 1);
  const failedItem = partial.items.find((item) => item.status === "failed")!;
  await rerollBrandLookPreviewItem({
    userId: user.id,
    itemId: failedItem.id,
    requestId: "verify-reroll",
    generator: async ({ phase }) => {
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/reroll-${phase}.webp`,
          fundingSource: "starter_allowance",
          allowanceUnits: 1,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal((await prisma.brandLookPreviewBatch.findUniqueOrThrow({ where: { id: partial.id } })).status, "completed");

  const unsaved = await createUnsavedBrandLookPreview({
    userId: user.id,
    payload,
    generator: async ({ phase }) => {
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/unsaved-${phase}.webp`,
          fundingSource: "starter_allowance",
          allowanceUnits: 1,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(unsaved.status, "completed");
  assert.equal(await prisma.brandProfile.count({ where: { userId: user.id } }), profileCountBefore, "previewing an unsaved Project Look cannot consume a Brand Profile slot");

  const realProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Real Visual Beats without rendered assets" },
  });
  const realPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: realProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "real-preview-source",
      analyzerVersion: "brand-content-preflight-v1",
      contentDomain: "artisan commerce launch",
      suggestedVisualFormatId: "stick-figure-story",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "bold" }),
    },
  });
  const realSubjects = ["rare indigo lantern", "copper astrolabe", "jade parcel"];
  for (let index = 0; index < realSubjects.length; index += 1) {
    await prisma.projectVisualBeat.create({
      data: {
        userId: user.id,
        projectId: realProject.id,
        preflightId: realPreflight.id,
        beatKey: `real-window-${index}`,
        sequence: index,
        sourceExcerptHash: `real-hash-${index}`,
        beatJson: JSON.stringify({
          subject: realSubjects[index],
          action: `performs real action ${index}`,
          setting: "a real riverside workshop",
          emotion: "focused anticipation",
          emphasis: `real focal point ${index}`,
        }),
      },
    });
  }
  const compiledByPhase = new Map<string, string>();
  const realPreview = await createUnsavedBrandLookPreview({
    userId: user.id,
    projectId: realProject.id,
    payload,
    generator: async ({ phase, compiled }) => {
      compiledByPhase.set(phase, compiled.positive);
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/real-${phase}.webp`,
          fundingSource: "starter_allowance",
          allowanceUnits: 1,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(realPreview.status, "completed");
  for (const [index, phase] of (["hook", "explain", "close"] as const).entries()) {
    assert.match(compiledByPhase.get(phase) ?? "", /artisan commerce launch/);
    assert.match(compiledByPhase.get(phase) ?? "", new RegExp(realSubjects[index]));
  }
  let rerolledPrompt = "";
  await rerollBrandLookPreviewItem({
    userId: user.id,
    itemId: realPreview.items.find((item) => item.phase === "hook")!.id,
    requestId: "same-real-scene",
    generator: async ({ compiled }) => {
      rerolledPrompt = compiled.positive;
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: "/generated/real-hook-reroll.webp",
          fundingSource: "starter_allowance",
          allowanceUnits: 1,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.match(rerolledPrompt, /rare indigo lantern/, "reroll must preserve the snapshotted real Visual Beat");

  await prisma.$disconnect();
  console.log("verify-brand-look-preview: PASS real-scene reuse + generation + durable partial batch");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
