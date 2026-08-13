import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-visual-acceptance-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    imageFundingSnapshotFromBrandVisualAcceptance,
    parseBrandVisualJobAcceptance,
    prepareBrandVisualJobAcceptance,
    resolveBrandVisualRenderAccess,
    resolveBrandVisualJobAcceptanceEnvelope,
    validateBrandVisualAcceptedReuse,
  } = await import("../src/lib/brand-visual-job-acceptance.server");
  const { createReservedImageJob } = await import("../src/lib/ai-generation-jobs.server");
  const { createVideoJob } = await import("../src/lib/mcp/video-job");
  const { authorizeHeroVideoMint } = await import("../src/lib/hero-image-namespace");
  const {
    pinProjectVisualContextToVideoJob,
    prepareUploadProjectVisualSnapshot,
  } = await import("../src/lib/project-look.server");

  assert.deepEqual(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasPersistedProjectPin: true,
      liveAccess: { canUse: false, cohort: "off", bucket: null },
    }),
    { canUse: true, cohort: "existing-pin", bucket: null },
    "rollback preserves exact rerender access for a project that already owns an immutable pin",
  );
  assert.equal(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: true,
      hasPersistedProjectPin: false,
      liveAccess: { canUse: false, cohort: "off", bucket: null },
    }),
    null,
    "rollback cannot grant a new Brand Visual adoption when no pin exists",
  );
  assert.equal(
    resolveBrandVisualRenderAccess({
      requestsBrandVisualImage: false,
      hasPersistedProjectPin: true,
      liveAccess: { canUse: false, cohort: "off", bucket: null },
    }),
    null,
    "a Stock render does not mint a Brand Visual acceptance merely because the project is pinned",
  );

  const user = await prisma.user.create({
    data: {
      name: "Accepted Starter",
      email: "accepted-starter@example.test",
      plan: "FREE",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      trialStartedAt: new Date("2026-08-08T00:00:00.000Z"),
      trialEndsAt: new Date("2026-08-15T00:00:00.000Z"),
    },
  });
  await prisma.creditBalance.create({ data: { userId: user.id, granted: 0, purchased: 0 } });
  const project = await prisma.editorProject.create({ data: { userId: user.id, title: "Accepted job" } });
  const image = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/reusable.png",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  const preflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "accepted-source-v1",
      analyzerVersion: "brand-content-preflight-v2-windowed",
      contentDomain: "creator education",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "warm" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: project.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "accepted-window-0",
          beatJson: JSON.stringify({ subject: "creator", action: "teaches", setting: "studio", emotion: "warm", emphasis: "lesson" }),
          existingAssetUrl: image.outputUrl,
          existingImageJobId: image.id,
          status: "current",
        },
      },
    },
  });
  const reusableBeat = await prisma.projectVisualBeat.findFirstOrThrow({
    where: { preflightId: preflight.id, sequence: 0 },
  });
  const liveSourceVideo = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      type: "video",
      status: "processing",
      inputJson: "{}",
    },
  });
  const liveSourceImage = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/not-durable-yet.png",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
      idempotencyKey: `video:${liveSourceVideo.id}:scene:1`,
    },
  });
  await prisma.projectVisualBeat.create({
    data: {
      userId: user.id,
      projectId: project.id,
      preflightId: preflight.id,
      beatKey: "window-1",
      sequence: 1,
      sourceExcerptHash: "accepted-window-1",
      beatJson: JSON.stringify({ subject: "creator", action: "continues", setting: "studio", emotion: "warm", emphasis: "proof" }),
      existingAssetUrl: liveSourceImage.outputUrl,
      existingImageJobId: liveSourceImage.id,
      status: "current",
    },
  });
  const acceptanceJson = await prepareBrandVisualJobAcceptance({
    userId: user.id,
    projectId: project.id,
    projectVisualPin: {
      contentPreflightId: preflight.id,
      projectVisualContextJson: JSON.stringify({
        source: "suggested",
        visualFormatId: "clear-infographic",
        recipeVersion: "clear-infographic-v2",
        treatment: "clear, warm",
        brandVisualLanguage: null,
      }),
    },
    access: { canUse: true, cohort: "treatment-10", bucket: 7 },
    now: new Date("2026-08-10T00:00:00.000Z"),
  });
  const acceptance = parseBrandVisualJobAcceptance(acceptanceJson);
  assert.ok(acceptance);
  assert.equal(acceptance.funding.source, "starter_allowance");
  assert.equal(acceptance.reusableAssets.length, 1);
  assert.equal(
    acceptance.reusableAssets.some((asset) => asset.imageJobId === liveSourceImage.id),
    false,
    "a settled image from a still-live parent VideoJob can still be refunded and is not durably reusable",
  );
  assert.equal(
    acceptance.preserveEstablishedDensity,
    false,
    "a partial clip with Starter allowance remaining must still be allowed to fill missing scenes",
  );
  assert.deepEqual(acceptance.reusableAssets[0], {
    beatId: reusableBeat.id,
    sceneIndex: 0,
    outputUrl: image.outputUrl,
    imageJobId: image.id,
  });
  assert.equal(resolveBrandVisualJobAcceptanceEnvelope(null).state, "legacy");
  assert.equal(resolveBrandVisualJobAcceptanceEnvelope("{broken").state, "invalid");
  assert.equal(resolveBrandVisualJobAcceptanceEnvelope(acceptanceJson).state, "accepted");
  assert.deepEqual(
    await validateBrandVisualAcceptedReuse({
      userId: user.id,
      acceptance,
      requestedSceneIndices: [0],
    }),
    { assets: acceptance.reusableAssets, invalidSceneIndices: [] },
  );
  await prisma.aiGenerationJob.update({
    where: { id: image.id },
    data: { status: "failed", chargeState: "refunded" },
  });
  assert.deepEqual(
    await validateBrandVisualAcceptedReuse({
      userId: user.id,
      acceptance,
      requestedSceneIndices: [0],
    }),
    { assets: [], invalidSceneIndices: [0] },
    "an accepted asset refunded before consumption must fail closed instead of being reused for free",
  );
  await prisma.aiGenerationJob.update({
    where: { id: image.id },
    data: { status: "completed", chargeState: "settled" },
  });
  const fetchStockSource = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
  assert.match(fetchStockSource, /resolveBrandVisualJobAcceptanceEnvelope/);
  assert.match(fetchStockSource, /BRAND_VISUAL_ACCEPTANCE_INVALID/);
  assert.match(fetchStockSource, /validateBrandVisualAcceptedReuse/);
  assert.match(fetchStockSource, /REUSABLE_ASSET_INVALIDATED/);
  assert.doesNotMatch(
    fetchStockSource,
    /if \(!brandVisualAcceptance\) return getStarterAiImageAllowanceStatus/,
    "legacy/non-project image admission cannot advertise Starter funding then reserve credits",
  );

  const allowanceWindow = acceptance.funding.source === "starter_allowance"
    ? new Date(acceptance.funding.windowStartedAt)
    : null;
  assert.ok(allowanceWindow);
  await prisma.conversionTrialAiImageAllowance.update({
    where: { userId: user.id },
    data: { usedImages: 8 },
  });
  const exhaustedAcceptance = parseBrandVisualJobAcceptance(await prepareBrandVisualJobAcceptance({
    userId: user.id,
    projectId: project.id,
    projectVisualPin: {
      contentPreflightId: preflight.id,
      projectVisualContextJson: acceptanceJson,
    },
    access: { canUse: true, cohort: "treatment-10", bucket: 7 },
    now: new Date("2026-08-10T00:00:00.000Z"),
  }));
  assert.equal(
    exhaustedAcceptance?.preserveEstablishedDensity,
    true,
    "an unchanged clip at zero remaining allowance preserves its established reduced density",
  );
  await prisma.conversionTrialAiImageAllowance.update({
    where: { userId: user.id },
    data: { usedImages: 0 },
  });

  const videoJob = await createVideoJob(
    user.id,
    { script: "accepted" },
    "accepted-video-job",
    {
      projectId: project.id,
      projectVisualPin: {
        contentPreflightId: preflight.id,
        projectVisualContextJson: JSON.stringify({
          source: "suggested",
          visualFormatId: "clear-infographic",
          recipeVersion: "clear-infographic-v2",
          treatment: "clear, warm",
          brandVisualLanguage: null,
        }),
      },
      brandVisualAcceptanceJson: acceptanceJson,
    },
  );
  assert.equal(videoJob.brandVisualAcceptanceJson, acceptanceJson);
  const mint = await authorizeHeroVideoMint({
    fromRenderPipeline: true,
    userId: user.id,
    videoJobId: videoJob.id,
  });
  assert.equal(mint.ok, true);
  assert.equal(mint.ok ? mint.brandVisualAcceptanceJson : null, acceptanceJson);

  // A later plan/flag decision must not switch the already accepted Starter job
  // to credits. The exact accepted allowance window remains authoritative.
  await prisma.user.update({ where: { id: user.id }, data: { subStatus: "active" } });
  const reservation = await createReservedImageJob({
    userId: user.id,
    model: "z-image-turbo",
    inputPreview: "accepted funding",
    inputJson: "{}",
    creditCost: 2,
    quoteVersion: "acceptance-v1",
    costBudgetUsdMicros: 20_000,
    provider: "runpod",
    providerModel: "z-image-turbo",
    providerRoute: "runpod-custom",
    providerEndpoint: "acceptance-endpoint",
    estimatedCostUsdMicros: 10_000,
    idempotencyKey: `video:${videoJob.id}:scene:1`,
    mediaExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
    fundingSnapshot: imageFundingSnapshotFromBrandVisualAcceptance(acceptance),
  });
  assert.equal(reservation.ok, true);
  if (!reservation.ok) throw new Error("accepted reservation failed");
  assert.equal(reservation.fundingSource, "starter_allowance");
  assert.equal(reservation.job.allowanceWindowStartedAt?.toISOString(), acceptance.funding.windowStartedAt);

  await prisma.projectVisualBeat.updateMany({
    where: { preflightId: preflight.id },
    data: { status: "outdated", outdatedAt: new Date() },
  });
  assert.equal(
    parseBrandVisualJobAcceptance(videoJob.brandVisualAcceptanceJson)?.reusableAssets.length,
    1,
    "another tab cannot mutate the exact reuse set accepted and receipted by this VideoJob",
  );

  const uploadProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Upload acceptance hydration" },
  });
  const uploadPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: uploadProject.id,
      narrativeSourceKind: "upload-transcript",
      sourceHash: "upload-accepted-source",
      analyzerVersion: "brand-content-preflight-v2-windowed",
      contentDomain: "creator education",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "warm" }),
      visualBeats: {
        create: {
          userId: user.id,
          projectId: uploadProject.id,
          beatKey: "upload-window-0",
          sequence: 0,
          sourceExcerptHash: "upload-window-0",
          beatJson: JSON.stringify({ subject: "creator", action: "teaches", setting: "studio", emotion: "warm", emphasis: "lesson" }),
          existingAssetUrl: image.outputUrl,
          existingImageJobId: image.id,
          status: "current",
        },
      },
    },
  });
  const uploadPin = await prepareUploadProjectVisualSnapshot({
    userId: user.id,
    projectId: uploadProject.id,
  });
  const initialUploadAcceptanceJson = await prepareBrandVisualJobAcceptance({
    userId: user.id,
    projectId: uploadProject.id,
    projectVisualPin: uploadPin,
    access: { canUse: true, cohort: "treatment-10", bucket: 7 },
    now: new Date("2026-08-10T00:05:00.000Z"),
  });
  assert.equal(parseBrandVisualJobAcceptance(initialUploadAcceptanceJson)?.reusableAssets.length, 0);
  const uploadVideoJob = await createVideoJob(
    user.id,
    { clipUrl: "https://cdn.example/upload.mp4" },
    "accepted-upload-video-job",
    {
      projectId: uploadProject.id,
      projectVisualPin: uploadPin,
      brandVisualAcceptanceJson: initialUploadAcceptanceJson,
    },
  );
  await pinProjectVisualContextToVideoJob({
    userId: user.id,
    projectId: uploadProject.id,
    videoJobId: uploadVideoJob.id,
    preflightId: uploadPreflight.id,
  });
  const hydratedUploadJob = await prisma.videoJob.findUniqueOrThrow({
    where: { id: uploadVideoJob.id },
    select: { brandVisualAcceptanceJson: true },
  });
  assert.equal(
    parseBrandVisualJobAcceptance(hydratedUploadJob.brandVisualAcceptanceJson)?.reusableAssets.length,
    1,
    "upload transcript pin must hydrate the accepted reuse set before fetch-stock admission",
  );

  const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
  assert.ok(
    jobsRoute.includes("projectHasPersistedVisualPin")
      && jobsRoute.includes("resolveBrandVisualRenderAccess({")
      && jobsRoute.includes("access: brandVisualRenderAccess"),
    "VideoJob acceptance must preserve existing pins under rollback instead of silently dropping visual identity",
  );
  assert.ok(
    jobsRoute.indexOf("const hasPersistedProjectPin")
      < jobsRoute.indexOf("if (useHeroRunpodImage)")
      && jobsRoute.includes("!heroAiImageAccess.canUse && !brandVisualRenderAccess")
      && jobsRoute.includes("!heroAiImageAccess.canUse && !canUseKieImages && !brandVisualRenderAccess"),
    "an established pin must be resolved before live Hero eligibility so rollback cannot reject its exact rerender",
  );

  const projectModule = readFileSync("src/lib/editor-projects.ts", "utf8");
  const visualContextRoute = readFileSync(
    "src/app/api/editor-projects/[id]/visual-context/route.ts",
    "utf8",
  );
  const contentPreflightRoute = readFileSync(
    "src/app/api/editor-projects/[id]/content-preflight/route.ts",
    "utf8",
  );
  const projectHook = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
    "utf8",
  );
  const receiptDialog = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx",
    "utf8",
  );
  assert.match(projectModule, /hasPersistedVisualPin:\s*Boolean\(project\.projectLookJson\s*\|\|\s*project\.brandProfileRevisionId\)/,
    "project hydration must expose established render capability independently of the live rollout flag");
  assert.match(visualContextRoute, /requireBrandVisualRecoveryUser[\s\S]+projectHasPersistedVisualPin/,
    "an owner must still read exact reuse state for a persisted pin after rollback");
  assert.match(contentPreflightRoute, /requireBrandVisualRecoveryUser[\s\S]+resolveContentPreflight\([\s\S]+analyzer:\s*auth\.access\.canUse/,
    "rollback may replay a cached preflight for an established pin but cannot run a new analyzer");
  assert.match(projectHook, /hasPersistedVisualPin/,
    "the editor must retain established-pin capability from its authoritative project snapshot");
  assert.match(receiptDialog, /p\.brandVisualAllowed\s*\|\|\s*p\.hasPersistedVisualPin/,
    "the receipt must quote exact retained scenes for rollback-safe rerenders");

  await prisma.$disconnect();
  console.log("verify-brand-visual-job-acceptance: PASS access + funding + immutable reuse snapshot");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
