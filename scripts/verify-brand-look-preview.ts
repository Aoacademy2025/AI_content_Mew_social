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
  const { admitBrandLookGeneration } = await import("../src/lib/brand-look-preview-admission.server");
  const { brandVisualIdentityKey, VISUAL_FORMATS } = await import("../src/lib/brand-visual-system");
  const { completeImageJob, createReservedImageJob, failAndRefundAiJob } = await import("../src/lib/ai-generation-jobs.server");
  const user = await prisma.user.create({ data: { name: "Preview owner", email: "preview@example.test" } });
  await prisma.creditBalance.create({ data: { userId: user.id, granted: 40, purchased: 0 } });
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
  const previewIdentityKey = brandVisualIdentityKey({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion: VISUAL_FORMATS.find((format) => format.id === payload.visual.primaryVisualFormatId)!.recipeVersion,
    treatment: payload.visual.defaultTreatment,
    brandVisualLanguage: {
      palette: payload.visual.palette,
      personality: payload.visual.personality,
      peopleAndSetting: payload.visual.peopleAndSetting,
      memorableCues: payload.visual.memorableCues,
      visualNotes: payload.visual.visualNotes,
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
    const imageJob = await prisma.aiGenerationJob.create({
      data: {
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        outputUrl: `/generated/existing-${index}.webp`,
        inputJson: JSON.stringify({ brandVisualIdentityKey: previewIdentityKey }),
        chargeState: "settled",
      },
    });
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
        existingImageJobId: imageJob.id,
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
  assert.equal(await prisma.aiGenerationJob.count(), 3, "reused previews create no additional image entitlement");

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
  assert.equal(await prisma.aiGenerationJob.count(), 3, "Editor preview reuses Hook/Explain/Close without another charge");

  const firstExistingBeat = await prisma.projectVisualBeat.findFirstOrThrow({
    where: { preflightId: preflight.id },
    orderBy: { sequence: "asc" },
  });
  await prisma.aiGenerationJob.update({
    where: { id: firstExistingBeat.existingImageJobId! },
    data: { inputJson: JSON.stringify({ brandVisualIdentityKey: "bv1-mismatched-draft" }) },
  });
  let mismatchGenerated = 0;
  const mismatchPreview = await createUnsavedBrandLookPreview({
    userId: user.id,
    projectId: project.id,
    payload,
    generator: async ({ phase }) => {
      mismatchGenerated += 1;
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/mismatch-${phase}.webp`,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(mismatchGenerated, 3, "assets from another visual identity must not represent the current draft");
  assert.equal(mismatchPreview.items.filter((item) => item.sourceType === "reused").length, 0);

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

  const standardCompiled: string[] = [];
  const unsaved = await createUnsavedBrandLookPreview({
    userId: user.id,
    payload,
    generator: async ({ phase, compiled }) => {
      standardCompiled.push(compiled.positive);
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
  assert.ok(standardCompiled.every((prompt) => prompt.includes(payload.niche) && prompt.includes(payload.audience)));
  assert.ok(
    standardCompiled.every((prompt) => !/archaeologist|physician|kraft parcel/i.test(prompt)),
    "pre-save previews must represent this brand niche rather than the fixed Quality Gate subjects",
  );

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

  const shortProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Only two rendered beats" },
  });
  const shortPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: shortProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "short-preview-source",
      analyzerVersion: "brand-content-preflight-v1",
      contentDomain: payload.niche,
      suggestedVisualFormatId: payload.visual.primaryVisualFormatId,
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "bold" }),
    },
  });
  for (let index = 0; index < 2; index += 1) {
    const job = await prisma.aiGenerationJob.create({
      data: {
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        outputUrl: `/generated/short-${index}.webp`,
        inputJson: JSON.stringify({ brandVisualIdentityKey: previewIdentityKey }),
        chargeState: "settled",
      },
    });
    await prisma.projectVisualBeat.create({
      data: {
        userId: user.id,
        projectId: shortProject.id,
        preflightId: shortPreflight.id,
        beatKey: `short-window-${index}`,
        sequence: index,
        sourceExcerptHash: `short-hash-${index}`,
        beatJson: JSON.stringify({
          subject: `short subject ${index}`,
          action: "acts",
          setting: "studio",
          emotion: "focused",
          emphasis: "one beat",
        }),
        existingAssetUrl: job.outputUrl,
        existingImageJobId: job.id,
      },
    });
  }
  let shortGenerated = 0;
  const shortPreview = await createUnsavedBrandLookPreview({
    userId: user.id,
    projectId: shortProject.id,
    payload,
    generator: async ({ phase }) => {
      shortGenerated += 1;
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/short-generated-${phase}.webp`,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(shortGenerated, 3, "one/two-beat projects must not duplicate assets into a misleading three-scene preview");
  assert.equal(shortPreview.items.filter((item) => item.sourceType === "reused").length, 0);

  const recoveryBatch = await prisma.brandLookPreviewBatch.create({
    data: {
      userId: user.id,
      status: "in_progress",
      sourceSnapshotJson: JSON.stringify({ payload, previewScenes: [] }),
      items: { create: { phase: "hook", sourceType: "generated", status: "queued" } },
    },
    include: { items: true },
  });
  const recoveryItem = recoveryBatch.items[0];
  const reserveRecovery = (key: string, expectedImageJobId: string | null) => createReservedImageJob({
    userId: user.id,
    model: "z-image-turbo",
    inputPreview: "durable preview link",
    inputJson: JSON.stringify({ brandVisualIdentityKey: previewIdentityKey }),
    creditCost: 2,
    quoteVersion: "verify-v1",
    costBudgetUsdMicros: 10_000,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "verify-endpoint",
    estimatedCostUsdMicros: 1_000,
    idempotencyKey: key,
    mediaExpiresAt: new Date(Date.now() + 60_000),
    fundingPolicy: "credits-only" as const,
    reservationLink: {
      brandLookPreviewItemId: recoveryItem.id,
      expectedImageJobId,
    },
  });
  const recoveryReservation = await reserveRecovery("brand-preview:recoverable:first", null);
  assert.equal(recoveryReservation.ok, true);
  if (!recoveryReservation.ok) throw new Error("recovery reservation failed");
  const linkedBeforeProvider = await prisma.brandLookPreviewItem.findUniqueOrThrow({ where: { id: recoveryItem.id } });
  assert.equal(linkedBeforeProvider.aiGenerationJobId, recoveryReservation.job.id, "preview item must link in the same transaction as its credit reservation");
  assert.equal(linkedBeforeProvider.status, "in_progress");
  await completeImageJob({
    userId: user.id,
    jobId: recoveryReservation.job.id,
    outputUrl: "/generated/recovered-by-sweeper.webp",
  });
  let recoveredItem = await prisma.brandLookPreviewItem.findUniqueOrThrow({ where: { id: recoveryItem.id } });
  assert.equal(recoveredItem.status, "completed");
  assert.equal(recoveredItem.outputUrl, "/generated/recovered-by-sweeper.webp");
  assert.equal((await prisma.brandLookPreviewBatch.findUniqueOrThrow({ where: { id: recoveryBatch.id } })).status, "completed");

  const rerollReservation = await reserveRecovery(
    "brand-preview:recoverable:reroll",
    recoveryReservation.job.id,
  );
  assert.equal(rerollReservation.ok, true);
  if (!rerollReservation.ok) throw new Error("reroll recovery reservation failed");
  recoveredItem = await prisma.brandLookPreviewItem.findUniqueOrThrow({ where: { id: recoveryItem.id } });
  assert.equal(recoveredItem.aiGenerationJobId, rerollReservation.job.id);
  assert.equal(recoveredItem.status, "in_progress");
  assert.equal(recoveredItem.outputUrl, "/generated/recovered-by-sweeper.webp", "reroll keeps the prior deliverable until replacement succeeds");
  await failAndRefundAiJob(user.id, rerollReservation.job.id, "VERIFY_REROLL_FAIL", "provider failed");
  recoveredItem = await prisma.brandLookPreviewItem.findUniqueOrThrow({ where: { id: recoveryItem.id } });
  assert.equal(recoveredItem.status, "completed", "failed reroll restores the still-deliverable prior preview");
  assert.equal(recoveredItem.outputUrl, "/generated/recovered-by-sweeper.webp");
  assert.equal(recoveredItem.errorCode, "VERIFY_REROLL_FAIL");

  const admissionDependencies = {
    checkFunding: async () => ({ ok: true as const, fundingSource: "starter_allowance" as const }),
    checkRate: async () => ({ ok: true as const }),
    describeOffer: () => ({ available: true, providerRoute: "runpod-custom" as const, providerEndpoint: "verified-endpoint" }),
    getCost: async () => ({ admitted: true }),
  };
  assert.deepEqual(
    await admitBrandLookGeneration({ userId: user.id, imageCount: 3, purpose: "preview" }, admissionDependencies),
    { ok: true },
    "one admission seam approves a fully funded, rate-safe, configured request",
  );
  const exhausted = await admitBrandLookGeneration(
    { userId: user.id, imageCount: 3, purpose: "preview" },
    {
      ...admissionDependencies,
      checkFunding: async () => ({ ok: false as const, code: "ALLOWANCE_EXHAUSTED" as const, remainingImages: 2 }),
    },
  );
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) {
    assert.equal(exhausted.status, 402);
    assert.equal(exhausted.body.remainingImages, 2);
    assert.equal(exhausted.body.stockAction, "use-stock");
  }
  const rateLimited = await admitBrandLookGeneration(
    { userId: user.id, imageCount: 1, purpose: "reroll" },
    {
      ...admissionDependencies,
      checkRate: async () => ({ ok: false as const, scope: "hour" as const, usedHour: 20, usedDay: 20, retryAfterSec: 42 }),
    },
  );
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) assert.equal(rateLimited.headers?.["Retry-After"], "42");
  const costBlocked = await admitBrandLookGeneration(
    { userId: user.id, role: "ADMIN", imageCount: 1, purpose: "reroll" },
    { ...admissionDependencies, getCost: async () => ({ admitted: false }) },
  );
  assert.equal(costBlocked.ok, false);
  if (!costBlocked.ok) assert.equal(costBlocked.body.error, "runpod_cost_guard");

  await prisma.$disconnect();
  console.log("verify-brand-look-preview: PASS real-scene reuse + generation + durable partial batch");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
