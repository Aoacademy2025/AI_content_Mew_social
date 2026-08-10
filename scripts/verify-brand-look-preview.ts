import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-look-preview-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const recoveryRouteSources = [
    "src/app/api/brand-library/preview-batches/route.ts",
    "src/app/api/brand-library/preview-batches/[batchId]/route.ts",
    "src/app/api/brand-library/preview-items/[itemId]/reroll/route.ts",
  ].map((file) => readFileSync(file, "utf8"));
  for (const source of recoveryRouteSources) {
    assert.match(
      source,
      /requireBrandVisualRecoveryUser/,
      "durable preview/reroll recovery must remain owner-readable after rollout admission closes",
    );
  }
  for (const file of [
    "src/app/api/brand-library/preview/route.ts",
    "src/app/api/brand-library/[id]/preview/route.ts",
    "src/app/api/brand-library/preview-items/[itemId]/reroll/route.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.indexOf("replay") < source.indexOf("if (!auth.access.canUse)"),
      `${file} must replay durable work before applying the live rollout gate`,
    );
  }
  const {
    brandPreviewSurfaceKey,
    clearPendingBrandPreviewOperation,
    readPendingBrandPreviewOperation,
    writePendingBrandPreviewOperation,
  } = await import("../src/lib/brand-preview-client-state");
  const storageValues = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { storageValues.set(key, value); },
    removeItem: (key: string) => { storageValues.delete(key); },
  };
  const pendingCreatedAt = new Date();
  const pendingRecoveryAt = new Date(pendingCreatedAt.getTime() + 60 * 60 * 1_000);
  const pendingOperation = {
    version: 1 as const,
    kind: "reroll" as const,
    userId: "preview-client-user",
    requestId: "reroll-request-123",
    batchId: "batch-1",
    itemId: "item-1",
    createdAt: pendingCreatedAt.toISOString(),
  };
  writePendingBrandPreviewOperation(storage, pendingOperation);
  assert.deepEqual(
    readPendingBrandPreviewOperation(storage, pendingOperation.userId, pendingRecoveryAt),
    pendingOperation,
    "reload recovers the same logical reroll request identity",
  );
  clearPendingBrandPreviewOperation(storage, pendingOperation.userId, "another-request");
  assert.ok(readPendingBrandPreviewOperation(storage, pendingOperation.userId, pendingRecoveryAt));
  clearPendingBrandPreviewOperation(storage, pendingOperation.userId, pendingOperation.requestId);
  assert.equal(readPendingBrandPreviewOperation(storage, pendingOperation.userId), null);
  const previewSurface = {
    profileId: "profile-a",
    payloadJson: JSON.stringify({ name: "Brand A", visual: { palette: ["#111111"] } }),
    projectId: "project-a",
    preflightId: "preflight-a",
    videoJobId: null,
  };
  const pendingPreview = {
    version: 2 as const,
    kind: "preview" as const,
    userId: pendingOperation.userId,
    requestId: "preview-request-123",
    surface: previewSurface,
    createdAt: pendingCreatedAt.toISOString(),
  };
  writePendingBrandPreviewOperation(storage, pendingPreview);
  assert.deepEqual(
    readPendingBrandPreviewOperation(storage, pendingPreview.userId, pendingRecoveryAt),
    pendingPreview,
  );
  assert.notEqual(
    brandPreviewSurfaceKey(previewSurface),
    brandPreviewSurfaceKey({ ...previewSurface, profileId: "profile-b" }),
    "one Brand Draft can never inherit another surface's durable request id",
  );

  const { prisma } = await import("../src/lib/prisma");
  const {
    brandLookPreviewGenerationCount,
    createBrandLookPreview,
    createUnsavedBrandLookPreview,
    prepareUnsavedBrandLookPreview,
    rerollBrandLookPreviewItem,
  } = await import("../src/lib/brand-look-preview.server");
  const { sweepStaleUnlinkedBrandLookPreviewItems } = await import("../src/lib/brand-look-preview-job-link.server");
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
      visualRecipeJson: JSON.stringify({ visualFormatId: "stick-figure-story", recipeVersion: "stick-figure-story-v2" }),
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
  await prisma.brandProfileRevision.update({
    where: { id: revision.id },
    data: { sourcePreflightId: preflight.id },
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
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    profileId: profile.id,
  }), 0, "a saved-from-clip Revision recovers its persisted source lineage after navigation");
  const reused = await createBrandLookPreview({
    userId: user.id,
    requestId: "saved-reuse-request",
    profileId: profile.id,
    generator: async () => {
      generated += 1;
      throw new Error("must not generate");
    },
  });
  assert.equal(generated, 0);
  assert.equal(reused.status, "completed");
  assert.equal(reused.items.filter((item) => item.sourceType === "reused").length, 3);
  assert.equal(await prisma.aiGenerationJob.count(), 3, "reused previews create no additional image entitlement");
  await prisma.brandProfileRevision.update({
    where: { id: revision.id },
    data: { sourcePreflightId: null },
  });

  const profileCountBefore = await prisma.brandProfile.count({ where: { userId: user.id } });
  const unsavedReused = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "unsaved-reuse-request",
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

  const reusePolicyBeat = await prisma.projectVisualBeat.findFirstOrThrow({
    where: { preflightId: preflight.id },
    orderBy: { sequence: "asc" },
  });
  const reusePolicyJob = await prisma.aiGenerationJob.findUniqueOrThrow({
    where: { id: reusePolicyBeat.existingImageJobId! },
  });
  await prisma.projectVisualBeat.update({
    where: { id: reusePolicyBeat.id },
    data: { status: "outdated", outdatedAt: new Date() },
  });
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    projectId: project.id,
    payload,
  }), 1, "an outdated representative beat cannot suppress preview generation");
  await prisma.projectVisualBeat.update({
    where: { id: reusePolicyBeat.id },
    data: { status: "current", outdatedAt: null },
  });
  await prisma.aiGenerationJob.update({
    where: { id: reusePolicyJob.id },
    data: { chargeState: "refunded" },
  });
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    projectId: project.id,
    payload,
  }), 1, "a refunded representative image cannot be reused by Brand Look Preview");
  await prisma.aiGenerationJob.update({
    where: { id: reusePolicyJob.id },
    data: { chargeState: "settled" },
  });
  await prisma.projectVisualBeat.update({
    where: { id: reusePolicyBeat.id },
    data: { existingAssetUrl: "/generated/mismatched-beat-url.webp" },
  });
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    projectId: project.id,
    payload,
  }), 1, "a beat URL that differs from the settled job output cannot be reused");
  await prisma.projectVisualBeat.update({
    where: { id: reusePolicyBeat.id },
    data: { existingAssetUrl: reusePolicyJob.outputUrl },
  });

  // Admission and materialization must consume the same immutable plan. Without
  // this seam, a concurrent Look/apply mutation can make the route admit 0 images
  // and then recompute/launch 3 images after the COGS guard has already passed.
  const preparedReuse = await prepareUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "prepared-reuse-race-request",
    projectId: project.id,
    payload,
    generator: async () => {
      throw new Error("a zero-generation admitted plan must never recompute into generation");
    },
  });
  assert.equal(preparedReuse.generationCount, 0);
  await prisma.projectVisualBeat.updateMany({
    where: { preflightId: preflight.id },
    data: { status: "outdated", outdatedAt: new Date() },
  });
  const preparedReuseResult = await preparedReuse.materialize();
  assert.equal(preparedReuseResult.status, "completed");
  assert.equal(preparedReuseResult.items.filter((item) => item.sourceType === "reused").length, 3);
  assert.equal(
    preparedReuseResult.items.filter((item) => item.sourceType === "generated").length,
    preparedReuse.generationCount,
    "materialization cannot exceed the exact generation count admitted for this request snapshot",
  );
  await prisma.projectVisualBeat.updateMany({
    where: { preflightId: preflight.id },
    data: { status: "current", outdatedAt: null },
  });

  const unbrandedProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Unbranded clip becoming a brand" },
  });
  const unbrandedPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: unbrandedProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "unbranded-source",
      analyzerVersion: "brand-content-preflight-v1",
      contentDomain: payload.niche,
      suggestedVisualFormatId: payload.visual.primaryVisualFormatId,
      suggestedTreatmentJson: JSON.stringify({ label: payload.visual.defaultTreatment, mood: "" }),
    },
  });
  const neutralProjectIdentity = brandVisualIdentityKey({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion: VISUAL_FORMATS.find((format) => format.id === payload.visual.primaryVisualFormatId)!.recipeVersion,
    treatment: payload.visual.defaultTreatment,
    brandVisualLanguage: null,
  });
  for (let index = 0; index < 3; index += 1) {
    const job = await prisma.aiGenerationJob.create({
      data: {
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        outputUrl: `/generated/unbranded-${index}.webp`,
        inputJson: JSON.stringify({ brandVisualIdentityKey: neutralProjectIdentity }),
        chargeState: "settled",
      },
    });
    await prisma.projectVisualBeat.create({
      data: {
        userId: user.id,
        projectId: unbrandedProject.id,
        preflightId: unbrandedPreflight.id,
        beatKey: `unbranded-window-${index}`,
        sequence: index,
        sourceExcerptHash: `unbranded-${index}`,
        beatJson: JSON.stringify({ subject: "creator", action: "explains", setting: "studio", emotion: "focused", emphasis: "one idea" }),
        existingAssetUrl: job.outputUrl,
        existingImageJobId: job.id,
      },
    });
  }
  const sourceLookPayload = {
    ...payload,
    visual: { ...payload.visual, languageMode: "none" as const },
  };
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    projectId: unbrandedProject.id,
    preflightId: unbrandedPreflight.id,
    payload: sourceLookPayload,
  }), 0, "an unchanged neutral Project Look reuses the exact three rendered images");
  const sourceLookPreview = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "adopt-exact-neutral-clip",
    projectId: unbrandedProject.id,
    preflightId: unbrandedPreflight.id,
    payload: sourceLookPayload,
    generator: async () => {
      throw new Error("the exact rendered Project Look must not call RunPod again");
    },
  });
  assert.equal(sourceLookPreview.items.filter((item) => item.sourceType === "reused").length, 3);
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    projectId: unbrandedProject.id,
    preflightId: unbrandedPreflight.id,
    payload,
  }), 3, "a proposed Brand Visual Language cannot masquerade as neutral images from the source clip");
  let changedBrandImages = 0;
  const adoptedFromClip = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "adopt-unbranded-clip",
    projectId: unbrandedProject.id,
    preflightId: unbrandedPreflight.id,
    payload,
    generator: async ({ phase }) => {
      changedBrandImages += 1;
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/adopted-${phase}.webp`,
          inputJson: JSON.stringify({ brandVisualIdentityKey: previewIdentityKey }),
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(changedBrandImages, 3);
  assert.equal(adoptedFromClip.items.filter((item) => item.sourceType === "reused").length, 0);
  assert.equal(
    await prisma.aiGenerationJob.count({ where: { userId: user.id } }),
    9,
    "changing the proposed BVL generates exactly the three preview images it changes",
  );

  const firstExistingBeat = await prisma.projectVisualBeat.findFirstOrThrow({
    where: { preflightId: preflight.id },
    orderBy: { sequence: "asc" },
  });
  await prisma.aiGenerationJob.update({
    where: { id: firstExistingBeat.existingImageJobId! },
    data: { inputJson: JSON.stringify({ brandVisualIdentityKey: "bv1-mismatched-draft" }) },
  });
  assert.equal(await brandLookPreviewGenerationCount({
    userId: user.id,
    projectId: project.id,
    payload,
  }), 1, "preview admission charges only the one representative scene that cannot be reused");
  let mismatchGenerated = 0;
  const mismatchPreview = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "mismatched-look-request",
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
  assert.equal(mismatchGenerated, 1, "only the representative asset from another visual identity is regenerated");
  assert.equal(mismatchPreview.items.filter((item) => item.sourceType === "reused").length, 2);

  const partial = await createBrandLookPreview({
    userId: user.id,
    requestId: "saved-partial-request",
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
  const durableReservations: string[] = [];
  const unsaved = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "unsaved-generated-request",
    payload,
    reservation: async ({ phase }) => {
      durableReservations.push(phase);
    },
    generator: async ({ phase, compiled }) => {
      assert.equal(
        durableReservations.length,
        3,
        "all three durable image reservations exist before the first provider generator starts",
      );
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
  assert.deepEqual(durableReservations.sort(), ["close", "explain", "hook"]);
  assert.equal(await prisma.brandProfile.count({ where: { userId: user.id } }), profileCountBefore, "previewing an unsaved Project Look cannot consume a Brand Profile slot");
  assert.ok(standardCompiled.every((prompt) => prompt.includes(payload.niche) && prompt.includes(payload.audience)));
  assert.ok(
    standardCompiled.every((prompt) => !/archaeologist|physician|kraft parcel/i.test(prompt)),
    "pre-save previews must represent this brand niche rather than the fixed Quality Gate subjects",
  );
  const commitCrashBatch = await prisma.brandLookPreviewBatch.create({
    data: {
      userId: user.id,
      requestId: "batch-commit-crash-request",
      status: "in_progress",
      sourceSnapshotJson: unsaved.sourceSnapshotJson,
      items: {
        create: ["hook", "explain", "close"].map((phase) => ({
          phase,
          sourceType: "generated",
          status: "queued",
        })),
      },
    },
  });
  const resumedReservations: string[] = [];
  const resumedAfterCommitCrash = await prepareUnsavedBrandLookPreview({
    userId: user.id,
    requestId: commitCrashBatch.requestId,
    payload,
    reservation: async ({ phase }) => { resumedReservations.push(phase); },
    generator: async ({ phase }) => {
      assert.equal(resumedReservations.length, 3,
        "replay restores every missing durable child before provider work resumes");
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/resumed-${phase}.webp`,
          fundingSource: "starter_allowance",
          allowanceUnits: 1,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  assert.equal(resumedAfterCommitCrash.generationCount, 0,
    "durable replay bypasses fresh admission for the already-frozen batch");
  const commitCrashResult = await resumedAfterCommitCrash.materialize();
  assert.equal(commitCrashResult.status, "completed");
  assert.equal(commitCrashResult.items.every((item) => Boolean(item.aiGenerationJobId)), true);
  let replayGeneratorCalls = 0;
  const replayedUnsaved = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "unsaved-generated-request",
    payload: { ...payload, name: "A conflicting retry body must not create a second batch" },
    generator: async () => {
      replayGeneratorCalls += 1;
      throw new Error("an idempotent replay must not generate or charge again");
    },
  });
  assert.equal(replayedUnsaved.id, unsaved.id, "the same user/request identity replays its durable batch");
  assert.equal(replayGeneratorCalls, 0);
  assert.equal(
    await prisma.brandLookPreviewBatch.count({
      where: { userId: user.id, requestId: "unsaved-generated-request" },
    }),
    1,
  );
  let concurrentGeneratorCalls = 0;
  const concurrentPreview = () => createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "concurrent-preview-request",
    payload,
    generator: async ({ phase }) => {
      concurrentGeneratorCalls += 1;
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: `/generated/concurrent-${phase}.webp`,
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    concurrentPreview(),
    concurrentPreview(),
  ]);
  assert.equal(concurrentFirst.id, concurrentSecond.id);
  assert.equal(concurrentGeneratorCalls, 3, "concurrent retries claim one durable three-image batch");
  assert.equal(
    await prisma.brandLookPreviewBatch.count({
      where: { userId: user.id, requestId: "concurrent-preview-request" },
    }),
    1,
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
    requestId: "real-scenes-request",
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

  const concurrentItem = realPreview.items.find((item) => item.phase === "explain")!;
  let releaseDelayedClaim!: () => void;
  let delayedReached!: () => void;
  const delayedGate = new Promise<void>((resolve) => { releaseDelayedClaim = resolve; });
  const delayedReady = new Promise<void>((resolve) => { delayedReached = resolve; });
  const delayedReroll = rerollBrandLookPreviewItem({
    userId: user.id,
    itemId: concurrentItem.id,
    requestId: "different-reroll-b",
    beforeClaim: async () => {
      delayedReached();
      await delayedGate;
    },
    generator: async () => { throw new Error("a lost claim must not reach generation"); },
  });
  await delayedReady;
  const winningReroll = await rerollBrandLookPreviewItem({
    userId: user.id,
    itemId: concurrentItem.id,
    requestId: "different-reroll-a",
    generator: async () => {
      const job = await prisma.aiGenerationJob.create({
        data: {
          userId: user.id,
          kind: "image",
          provider: "runpod",
          model: "z-image-turbo",
          status: "completed",
          outputUrl: "/generated/concurrent-winner.webp",
          chargeState: "settled",
        },
      });
      return { jobId: job.id, outputUrl: job.outputUrl! };
    },
  });
  releaseDelayedClaim();
  await assert.rejects(delayedReroll, /changed concurrently/);
  const afterLostClaim = await prisma.brandLookPreviewItem.findUniqueOrThrow({ where: { id: concurrentItem.id } });
  assert.equal(afterLostClaim.status, "completed");
  assert.equal(afterLostClaim.aiGenerationJobId, winningReroll.aiGenerationJobId);
  assert.equal(afterLostClaim.outputUrl, "/generated/concurrent-winner.webp");
  assert.equal(
    (await prisma.brandLookPreviewBatch.findUniqueOrThrow({ where: { id: realPreview.id } })).status,
    "completed",
    "a delayed losing request cannot reopen a completed winner",
  );

  // Simulate a future code release changing the format's current recipe. A
  // published immutable revision must still preview and reroll with the recipe
  // version stored in visualRecipeJson, not whatever VISUAL_FORMATS says now.
  const mutableFormat = VISUAL_FORMATS.find((format) => format.id === payload.visual.primaryVisualFormatId) as {
    recipeVersion: string;
  };
  const currentRecipeVersion = mutableFormat.recipeVersion;
  const pinnedRecipeVersions: string[] = [];
  try {
    mutableFormat.recipeVersion = "stick-figure-story-future";
    const pinnedPreview = await createBrandLookPreview({
      userId: user.id,
      requestId: "saved-pinned-recipe",
      profileId: profile.id,
      generator: async ({ phase, compiled }) => {
        pinnedRecipeVersions.push(compiled.recipeVersion);
        const job = await prisma.aiGenerationJob.create({
          data: {
            userId: user.id,
            kind: "image",
            provider: "runpod",
            model: "z-image-turbo",
            status: "completed",
            outputUrl: `/generated/pinned-${phase}.webp`,
            chargeState: "settled",
          },
        });
        return { jobId: job.id, outputUrl: job.outputUrl! };
      },
    });
    assert.deepEqual(pinnedRecipeVersions, [
      "stick-figure-story-v2",
      "stick-figure-story-v2",
      "stick-figure-story-v2",
    ]);
    await rerollBrandLookPreviewItem({
      userId: user.id,
      itemId: pinnedPreview.items[0].id,
      requestId: "reroll-pinned-recipe",
      generator: async ({ compiled }) => {
        pinnedRecipeVersions.push(compiled.recipeVersion);
        const job = await prisma.aiGenerationJob.create({
          data: {
            userId: user.id,
            kind: "image",
            provider: "runpod",
            model: "z-image-turbo",
            status: "completed",
            outputUrl: "/generated/pinned-reroll.webp",
            chargeState: "settled",
          },
        });
        return { jobId: job.id, outputUrl: job.outputUrl! };
      },
    });
    assert.equal(pinnedRecipeVersions.at(-1), "stick-figure-story-v2");
  } finally {
    mutableFormat.recipeVersion = currentRecipeVersion;
  }

  const unsupportedProfile = await prisma.brandProfile.create({
    data: {
      userId: user.id,
      name: "Unsupported historical recipe",
      niche: payload.niche,
      audience: payload.audience,
      tone: payload.script.tone,
      activeRevisionNumber: 1,
    },
  });
  await prisma.brandProfileRevision.create({
    data: {
      brandProfileId: unsupportedProfile.id,
      version: 1,
      payloadJson: JSON.stringify(payload),
      visualRecipeJson: JSON.stringify({
        visualFormatId: payload.visual.primaryVisualFormatId,
        recipeVersion: "stick-figure-story-removed",
      }),
    },
  });
  const unsupportedPreview = await createBrandLookPreview({
    userId: user.id,
    requestId: "unsupported-pinned-recipe",
    profileId: unsupportedProfile.id,
    generator: async () => {
      throw new Error("unsupported recipes must fail before reaching the provider");
    },
  });
  assert.equal(unsupportedPreview.status, "failed");
  assert.equal(
    unsupportedPreview.items.filter((item) => item.status === "failed").length,
    3,
    "a removed historical compiler recipe must close the durable batch instead of leaving it in_progress",
  );

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
    requestId: "short-scenes-request",
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
      requestId: "recovery-request",
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

  const ambiguousJobIds: string[] = [];
  const ambiguousPreview = await createUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "ambiguous-provider-request",
    payload,
    generator: async ({ itemId, batchId, phase }) => {
      const reservation = await createReservedImageJob({
        userId: user.id,
        model: "z-image-turbo",
        inputPreview: `ambiguous ${phase}`,
        inputJson: JSON.stringify({ brandVisualIdentityKey: previewIdentityKey }),
        creditCost: 2,
        quoteVersion: "verify-v1",
        costBudgetUsdMicros: 10_000,
        provider: "runpod",
        providerModel: "z-image-turbo",
        providerRoute: "runpod-custom",
        providerEndpoint: "verify-endpoint",
        estimatedCostUsdMicros: 1_000,
        idempotencyKey: `brand-preview:${batchId}:${phase}:ambiguous`,
        mediaExpiresAt: new Date(Date.now() + 60_000),
        fundingPolicy: "credits-only",
        reservationLink: {
          brandLookPreviewItemId: itemId,
          expectedImageJobId: null,
        },
      });
      assert.equal(reservation.ok, true);
      if (!reservation.ok) throw new Error("ambiguous reservation failed");
      ambiguousJobIds.push(reservation.job.id);
      throw Object.assign(new Error("provider poll result is ambiguous"), {
        code: "PROVIDER_POLL_FAILED",
      });
    },
  });
  assert.equal(ambiguousPreview.status, "in_progress");
  assert.equal(
    ambiguousPreview.items.every((item) => item.status === "in_progress" && Boolean(item.aiGenerationJobId)),
    true,
    "a linked reserved provider job stays recoverable after an ambiguous response",
  );
  await assert.rejects(
    rerollBrandLookPreviewItem({
      userId: user.id,
      itemId: ambiguousPreview.items[0].id,
      requestId: "ambiguous-reroll-must-wait",
      generator: async () => { throw new Error("must not run"); },
    }),
    /already in progress/,
    "reroll cannot detach a still-live ambiguous reservation",
  );
  for (const jobId of ambiguousJobIds) {
    await failAndRefundAiJob(user.id, jobId, "VERIFY_AMBIGUOUS_CLEANUP", "test cleanup");
  }

  // Crash window: reroll claim marks the item in_progress while it still points
  // at the terminal prior job, then the process dies before reservation linkage.
  // The stale preview sweep must restore the prior deliverable instead of leaving
  // the item/batch permanently in_progress.
  const claimCrashNow = new Date("2026-08-10T11:00:00.000Z");
  await prisma.brandLookPreviewItem.update({
    where: { id: recoveryItem.id },
    data: {
      status: "in_progress",
      updatedAt: new Date(claimCrashNow.getTime() - 31 * 60_000),
    },
  });
  await prisma.brandLookPreviewBatch.update({
    where: { id: recoveryBatch.id },
    data: { status: "in_progress", finishedAt: null },
  });
  const claimCrashRecovery = await sweepStaleUnlinkedBrandLookPreviewItems({
    now: claimCrashNow,
    olderThanMinutes: 30,
  });
  assert.deepEqual(
    claimCrashRecovery,
    { dryRun: false, scanned: 1, failed: 0, resumable: 0, batchIds: [recoveryBatch.id] },
    "a stale reroll claim pointing at its terminal prior job is recoverable",
  );
  recoveredItem = await prisma.brandLookPreviewItem.findUniqueOrThrow({ where: { id: recoveryItem.id } });
  assert.equal(recoveredItem.status, "completed");
  assert.equal(recoveredItem.outputUrl, "/generated/recovered-by-sweeper.webp");
  assert.equal((await prisma.brandLookPreviewBatch.findUniqueOrThrow({ where: { id: recoveryBatch.id } })).status, "completed");

  const interruptedBatch = await prisma.brandLookPreviewBatch.create({
    data: {
      userId: user.id,
      requestId: "interrupted-preview-request",
      status: "in_progress",
      sourceSnapshotJson: unsaved.sourceSnapshotJson,
      items: {
        create: [
          { phase: "hook", sourceType: "generated", status: "completed", outputUrl: "/generated/survived.webp" },
          { phase: "explain", sourceType: "generated", status: "in_progress" },
          { phase: "close", sourceType: "generated", status: "queued" },
        ],
      },
    },
    include: { items: true },
  });
  const reconcileNow = new Date("2026-08-10T12:00:00.000Z");
  await prisma.brandLookPreviewItem.updateMany({
    where: { batchId: interruptedBatch.id, status: { in: ["queued", "in_progress"] } },
    data: { updatedAt: new Date(reconcileNow.getTime() - 31 * 60_000) },
  });
  const interruptedDryRun = await sweepStaleUnlinkedBrandLookPreviewItems({
    now: reconcileNow,
    olderThanMinutes: 30,
    dryRun: true,
  });
  assert.deepEqual(interruptedDryRun, { dryRun: true, scanned: 2, failed: 0, resumable: 2, batchIds: [interruptedBatch.id] });
  const interruptedLive = await sweepStaleUnlinkedBrandLookPreviewItems({
    now: reconcileNow,
    olderThanMinutes: 30,
  });
  assert.deepEqual(interruptedLive, { dryRun: false, scanned: 2, failed: 0, resumable: 2, batchIds: [interruptedBatch.id] });
  const interruptedAfter = await prisma.brandLookPreviewBatch.findUniqueOrThrow({
    where: { id: interruptedBatch.id },
    include: { items: true },
  });
  assert.equal(interruptedAfter.status, "in_progress");
  assert.equal(interruptedAfter.finishedAt, null);
  assert.equal(interruptedAfter.items.filter((item) => item.status === "failed").length, 0,
    "an interrupted admitted Preview stays dispatchable instead of becoming a paid partial result");

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
  if (!costBlocked.ok) assert.equal(costBlocked.body.error, "hero_image_cost_guard");

  const rerollRoute = readFileSync(
    "src/app/api/brand-library/preview-items/[itemId]/reroll/route.ts",
    "utf8",
  );
  assert.ok(
    rerollRoute.includes('error.status === 429')
      && rerollRoute.includes('code: "RATE_LIMITED"')
      && rerollRoute.includes('{ status: 429'),
    "an atomic daily-cap race during reroll must stay a recoverable HTTP 429",
  );
  assert.ok(
    rerollRoute.indexOf("getBrandLookPreviewRerollReplay({") >= 0
      && rerollRoute.indexOf("getBrandLookPreviewRerollReplay({") < rerollRoute.indexOf("admitBrandLookGeneration({"),
    "an idempotent reroll replay must bypass changed funding/rate admission",
  );
  for (const previewRoutePath of [
    "src/app/api/brand-library/preview/route.ts",
    "src/app/api/brand-library/[id]/preview/route.ts",
  ]) {
    const previewRoute = readFileSync(previewRoutePath, "utf8");
    const prepareAt = previewRoute.indexOf("prepare");
    const admitAt = previewRoute.indexOf("admitBrandLookGeneration({");
    const materializeAt = previewRoute.indexOf(".materialize()");
    assert.ok(
      !previewRoute.includes("brandLookPreviewGenerationCount")
        && prepareAt >= 0
        && prepareAt < admitAt
        && admitAt < materializeAt,
      `${previewRoutePath} must admit and materialize one prepared preview snapshot`,
    );
  }
  const brandsPage = readFileSync("src/app/(dashboard)/brands/page.tsx", "utf8");
  assert.ok(
    brandsPage.includes("readPendingBrandPreviewOperation")
      && brandsPage.includes("writePendingBrandPreviewOperation")
      && brandsPage.includes("postRerollWithRecovery"),
    "preview and reroll request identities must survive reload and ambiguous responses",
  );
  const previewQuoteRoute = readFileSync(
    "src/app/api/brand-library/preview-quote/route.ts",
    "utf8",
  );
  assert.ok(
    previewQuoteRoute.includes("brandLookPreviewGenerationCount")
      && brandsPage.includes("previewGenerationCount")
      && brandsPage.includes("/api/brand-library/preview-quote")
      && !brandsPage.includes("sourcePreviewReusesAll"),
    "Brand Library quotes and gates only the exact missing Preview images instead of guessing zero-or-three",
  );
  const imageReconcileRoute = readFileSync("src/app/api/cron/reconcile-ai-images/route.ts", "utf8");
  assert.ok(
    imageReconcileRoute.includes("sweepStaleUnlinkedBrandLookPreviewItems")
      && imageReconcileRoute.includes("resumeBrandLookPreviewBatch")
      && imageReconcileRoute.includes("previewResumed")
      && imageReconcileRoute.includes("previewSummary"),
    "the existing image reconciliation schedule must redispatch interrupted durable Preview children",
  );

  // Production Preview reserves and links all three jobs before it submits the
  // first provider request. The generation replay must claim that pre-created
  // `planned` attempt; treating any existing attempt as a concurrent submitter
  // leaves the reservation waiting forever without a providerJobId.
  const runtimeWorkflowDir = mkdtempSync(join(tmpdir(), "brand-preview-runtime-workflow-"));
  const runtimeWorkflowPath = join(runtimeWorkflowDir, "z-image-turbo.json");
  writeFileSync(runtimeWorkflowPath, JSON.stringify({
    input: {
      prompt: "{{PROMPT}}",
      negative_prompt: "{{NEGATIVE_PROMPT}}",
      width: "{{WIDTH}}",
      height: "{{HEIGHT}}",
      seed: "{{SEED}}",
    },
  }));
  process.env.AI_STUDIO_IMAGE_ENABLED = "1";
  process.env.CREDITS_LIVE = "1";
  process.env.RUNPOD_API_KEY = "verify-brand-preview-runtime-key";
  process.env.AI_STUDIO_Z_IMAGE_ROUTE = "custom";
  process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID = "verify-brand-preview-runtime-endpoint";
  process.env.RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH = runtimeWorkflowPath;
  process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
  process.env.BRAND_VISUAL_ROLLOUT_PERCENT = "0";

  const runtimeUser = await prisma.user.create({
    data: {
      name: "Brand Preview Runtime",
      email: "duckyhero@gmail.com",
      role: "ADMIN",
      plan: "PRO",
      subStatus: "active",
    },
  });
  await prisma.creditBalance.create({
    data: { userId: runtimeUser.id, granted: 10, purchased: 0 },
  });
  const runtimeBatch = await prisma.brandLookPreviewBatch.create({
    data: {
      userId: runtimeUser.id,
      requestId: "runtime-pre-reservation-request",
      status: "in_progress",
      sourceSnapshotJson: "{}",
    },
  });
  const runtimeItem = await prisma.brandLookPreviewItem.create({
    data: {
      batchId: runtimeBatch.id,
      phase: "hook",
      sourceType: "generated",
      status: "queued",
    },
  });
  const runtimeInput = {
    userId: runtimeUser.id,
    plan: "PRO",
    prompt: "Thai creator explains one useful AI lesson",
    idempotencyKey: `brand-preview:${runtimeBatch.id}:hook`,
    videoJobId: `brand-preview-${runtimeBatch.id}`,
    sceneIndex: 0,
    sceneTitle: "Preview brand · hook",
    timeoutMs: 30_000,
    brandVisualPrompt: {
      source: "brand-revision" as const,
      compiled: {
        visualFormatId: "stick-figure-story" as const,
        recipeVersion: "stick-figure-story-v2",
        positive: "A text-free energetic stick-figure scene",
        negative: "text, logo, watermark",
      },
      identityKey: "verify-runtime-identity",
    },
    brandLookPreviewReservation: {
      itemId: runtimeItem.id,
      expectedImageJobId: null,
    },
  };
  const {
    generateHeroImageForVideo,
    HeroImageGenerationError,
    reserveHeroImageForVideo,
  } = await import("../src/lib/video-hero-image.server");
  const runtimeReservation = await reserveHeroImageForVideo(runtimeInput);
  const plannedAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({
    where: { jobId: runtimeReservation.id, sequence: 1 },
  });
  assert.equal(plannedAttempt.status, "planned");

  const realFetch = globalThis.fetch;
  let runtimeSubmissions = 0;
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = typeof request === "string"
      ? request
      : request instanceof URL
        ? request.toString()
        : request.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    if (url.endsWith("/run")) {
      runtimeSubmissions += 1;
      return json({ id: "runtime-provider-job", status: "IN_QUEUE" });
    }
    if (url.includes("/status/runtime-provider-job")) {
      return json({ status: "FAILED", error: "injected terminal failure after successful submit" });
    }
    throw new Error(`unexpected outbound request in Preview runtime regression: ${url}`);
  }) as typeof fetch;
  let runtimeGenerationError: unknown = null;
  const runtimeGeneration = generateHeroImageForVideo(runtimeInput).catch((error) => {
    runtimeGenerationError = error;
  });
  await Promise.race([
    (async () => {
      while (runtimeSubmissions === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    })(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("a pre-reserved Preview attempt never reached provider submission")),
      1_000,
    )),
  ]);
  await runtimeGeneration;
  globalThis.fetch = realFetch;
  assert.equal(runtimeSubmissions, 1, "the exact pre-reserved attempt submits once");
  assert.ok(
    runtimeGenerationError instanceof HeroImageGenerationError
      && runtimeGenerationError.code === "PROVIDER_FAILED",
    "the injected provider failure proves submission occurred and retains normal compensation",
  );
  const runtimeJob = await prisma.aiGenerationJob.findUniqueOrThrow({
    where: { id: runtimeReservation.id },
  });
  assert.equal(runtimeJob.chargeState, "refunded");
  assert.equal(runtimeJob.providerJobId, "runtime-provider-job");

  await prisma.$disconnect();
  console.log("verify-brand-look-preview: PASS real-scene reuse + generation + durable partial batch");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
