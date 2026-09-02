import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-profile-library-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { CONTENT_PREFLIGHT_ANALYZER_VERSION } = await import("../src/lib/content-preflight.server");
  const { checkBrandProfileFieldLimits } = await import("../src/lib/brand-profile-limits");
  const {
    archiveBrandProfile,
    applyProjectBrandRevision,
    applyBrandRevisionDefaultsToProjectDraft,
    brandProfilePayloadSchema,
    createBrandProfileFromPayload,
    getBrandProfileAvailabilityState,
    legacyBrandProfileMutableWhere,
    pinProjectBrandRevision,
    promoteCompletedVideoJobToBrandProfile,
    promoteProjectLookToBrandProfile,
    resolveBrandProfileRevisionForNewProjectInTransaction,
    isVersionedBrandProfile,
    publishBrandProfileDraft,
    reconcileBrandProfileAvailability,
    saveBrandProfileDraft,
    storedBrandProfilePayloadSchema,
  } = await import("../src/lib/brand-profile-library.server");
  const user = await prisma.user.create({
    data: { name: "Brand owner", email: "brand-owner@example.test", plan: "PRO" },
  });
  const profile = await prisma.brandProfile.create({
    data: {
      userId: user.id,
      name: "Mewsocial",
      niche: "creator education",
      audience: "Thai creators",
      tone: "direct and energetic",
    },
  });
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Pinned launch video" },
  });

  const basePayload = {
    schemaVersion: 1 as const,
    name: "Mewsocial",
    niche: "creator education",
    audience: "Thai creators",
    script: {
      styleId: null,
      tone: "direct and energetic",
      bannedWords: [],
      ctaStyle: "follow",
      language: "th",
      analysisNotes: "Short hook, direct explanation, one concrete CTA",
      sampleText: "Creator writing sample retained for the next script",
    },
    voice: { provider: "elevenlabs", voiceId: "voice-main" },
    subtitle: {
      presetId: null,
      config: { fontFamily: "Kanit", preset: "stroke", effect: "karaoke", accentColor: "#38BDF8" },
    },
    brandMark: { assetId: null, enabled: true, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "simple-editorial-story" as const,
      palette: ["#111111", "#F8F5EE", "#38BDF8"],
      personality: "bold raw energetic",
      peopleAndSetting: "Thai creator contexts",
      memorableCues: ["blue marker circle", "blue marker arrow"],
      visualNotes: "thick imperfect marker lines",
      defaultTreatment: "clear and energetic",
    },
  };

  const descriptivePalettePayload = {
    ...basePayload,
    visual: {
      ...basePayload.visual,
      palette: [
        "high-contrast carbon black",
        "warm paper white",
        "vivid sky blue #38BDF8 used only as a sharp accent",
      ],
    },
  };
  assert.equal(
    brandProfilePayloadSchema.safeParse(descriptivePalettePayload).success,
    false,
    "creator writes must reject descriptive palette prose before it reaches a Draft or Revision",
  );
  const canonicalPalettePayload = brandProfilePayloadSchema.parse({
    ...basePayload,
    visual: { ...basePayload.visual, palette: ["#abc", "38bdf8"] },
  });
  assert.deepEqual(
    canonicalPalettePayload.visual.palette,
    ["#AABBCC", "#38BDF8"],
    "creator writes canonicalize accepted short/lowercase HEX values",
  );
  assert.deepEqual(
    storedBrandProfilePayloadSchema.parse(descriptivePalettePayload).visual.palette,
    descriptivePalettePayload.visual.palette,
    "immutable historical Revisions with descriptive palettes remain readable byte-for-byte",
  );

  const legacyFormatUser = await prisma.user.create({
    data: { name: "Legacy format owner", email: "legacy-format@example.test", plan: "BUSINESS" },
  });
  const legacyFormatPayload = {
    ...basePayload,
    name: "Historical stick format",
    visual: {
      ...basePayload.visual,
      primaryVisualFormatId: "stick-figure-story" as const,
    },
  };
  const legacyFormatProfile = await prisma.brandProfile.create({
    data: {
      userId: legacyFormatUser.id,
      name: legacyFormatPayload.name,
      niche: legacyFormatPayload.niche,
      audience: legacyFormatPayload.audience,
      tone: legacyFormatPayload.script.tone,
      activeRevisionNumber: 1,
      revisions: {
        create: {
          version: 1,
          payloadJson: JSON.stringify(legacyFormatPayload),
          visualRecipeJson: JSON.stringify({
            visualFormatId: "stick-figure-story",
            recipeVersion: "stick-figure-story-v6",
            brandVisualLanguage: legacyFormatPayload.visual,
            defaultTreatment: legacyFormatPayload.visual.defaultTreatment,
            treatmentPolicy: "adaptive",
            lockedTreatmentPin: null,
          }),
        },
      },
    },
    include: { revisions: true },
  });
  const legacyFormatRevision = legacyFormatProfile.revisions[0]!;
  const historicallyPinnedProject = await prisma.editorProject.create({
    data: {
      userId: legacyFormatUser.id,
      title: "Historical stick project",
      brandProfileRevisionId: legacyFormatRevision.id,
    },
  });
  const replayedLegacyPin = await pinProjectBrandRevision({
    userId: legacyFormatUser.id,
    projectId: historicallyPinnedProject.id,
    profileId: legacyFormatProfile.id,
    revisionId: legacyFormatRevision.id,
  });
  assert.equal(
    replayedLegacyPin.revision.id,
    legacyFormatRevision.id,
    "an exact historical stick-format pin remains readable and replayable",
  );
  const unpinnedLegacyFormatProject = await prisma.editorProject.create({
    data: { userId: legacyFormatUser.id, title: "New project cannot adopt retired format" },
  });
  await assert.rejects(
    pinProjectBrandRevision({
      userId: legacyFormatUser.id,
      projectId: unpinnedLegacyFormatProject.id,
      profileId: legacyFormatProfile.id,
      revisionId: legacyFormatRevision.id,
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "FROZEN"
    ),
    "a retired stick-format Revision cannot be newly pinned to another project",
  );
  await assert.rejects(
    prisma.$transaction((tx) => resolveBrandProfileRevisionForNewProjectInTransaction(tx, {
      userId: legacyFormatUser.id,
      profileId: legacyFormatProfile.id,
    })),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "FROZEN"
    ),
    "new-project handoff cannot silently adopt a retired format from an old Brand Profile",
  );

  const legacyCapUser = await prisma.user.create({
    data: { name: "Legacy cap owner", email: "legacy-cap@example.test", plan: "FREE" },
  });
  await prisma.brandProfile.create({
    data: {
      userId: legacyCapUser.id,
      name: "Legacy Hero Script only",
      niche: "creator education",
      audience: "Thai creators",
      tone: "direct",
      activeRevisionNumber: 0,
    },
  });
  const firstConfirmedLibraryProfile = await createBrandProfileFromPayload({
    userId: legacyCapUser.id,
    payload: { ...basePayload, name: "Explicitly confirmed Brand Library profile" },
  });
  assert.equal(firstConfirmedLibraryProfile.profile.activeRevisionNumber, 1);
  assert.equal(
    await prisma.brandProfile.count({
      where: { userId: legacyCapUser.id, activeRevisionNumber: { gt: 0 } },
    }),
    1,
    "legacy revision-0 Hero Script rows do not consume the explicit Brand Library cap",
  );
  await reconcileBrandProfileAvailability({
    userId: legacyCapUser.id,
    preferredProfileId: firstConfirmedLibraryProfile.profile.id,
  });
  assert.equal(
    (await prisma.brandProfile.findFirstOrThrow({
      where: { userId: legacyCapUser.id, activeRevisionNumber: 0 },
    })).frozenAt,
    null,
    "explicit cap reconciliation must ignore unimported legacy Hero Script rows",
  );
  const resolvedDefaults = applyBrandRevisionDefaultsToProjectDraft({
    draft: {
      script: "keep this authored script",
      voiceEngine: "gemini",
      geminiVoiceName: "Aoede",
      logoOverlay: { enabled: true, assetId: "old-logo", position: "top-left", sizePct: 12, opacity: 0.8 },
    },
    payload: {
      ...basePayload,
      subtitle: {
        presetId: "subtitle-brand",
        config: {
          preset: "stroke",
          effect: "karaoke",
          cardLen: "sentence",
          fontFamily: "Kanit",
          bold: true,
          fontWeight: 900,
          fontSize: 72,
          textColor: "#FFFFFF",
          accentColor: "#38BDF8",
          shadow: true,
          outline: true,
          outlineSize: 3,
          verticalPos: 78,
        },
      },
      brandMark: { assetId: "brand-logo", enabled: true, position: "top-right", sizePct: 18, opacity: 0.9 },
    },
  });
  assert.equal(resolvedDefaults.script, "keep this authored script", "pinning defaults never replaces clip content");
  assert.equal(resolvedDefaults.voiceEngine, "elevenlabs");
  assert.equal(resolvedDefaults.voiceId, "voice-main");
  assert.equal((resolvedDefaults.brandSubtitleDefault as { fontFamily?: string }).fontFamily, "Kanit");
  assert.equal((resolvedDefaults.logoOverlay as { assetId?: string }).assetId, "brand-logo");
  const accountVoiceDefaults = applyBrandRevisionDefaultsToProjectDraft({
    draft: {
      voiceEngine: "elevenlabs",
      voiceId: "prior-brand-voice",
      geminiVoiceName: "Aoede",
      omniVoiceId: "prior-omni-voice",
    },
    payload: { ...basePayload, voice: { provider: "elevenlabs", voiceId: null } },
  });
  assert.equal(accountVoiceDefaults.voiceEngine, "elevenlabs");
  assert.equal("voiceId" in accountVoiceDefaults, false,
    "a null Revision voice explicitly returns the selected provider to the account default");
  assert.equal("geminiVoiceName" in accountVoiceDefaults, false);
  assert.equal("omniVoiceId" in accountVoiceDefaults, false);

  const promotionUser = await prisma.user.create({
    data: { name: "Promotion owner", email: "brand-promotion@example.test", plan: "BUSINESS" },
  });
  const promotionProject = await prisma.editorProject.create({
    data: { userId: promotionUser.id, title: "Completed clip promotion" },
  });
  const promotionPreflight = await prisma.contentPreflight.create({
    data: {
      userId: promotionUser.id,
      projectId: promotionProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "promotion-source-v1",
      analyzerVersion: "brand-content-preflight-v2-windowed",
      contentDomain: "creator education",
      suggestedVisualFormatId: "simple-editorial-story",
      suggestedTreatmentJson: JSON.stringify({ label: "energetic", mood: "direct" }),
      visualBeats: {
        create: {
          userId: promotionUser.id,
          projectId: promotionProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "promotion-window-0",
          beatJson: JSON.stringify({ sourceExcerpt: "promotion hook", subject: "creator" }),
        },
      },
    },
  });
  const promotionJob = await prisma.videoJob.create({
    data: {
      userId: promotionUser.id,
      projectId: promotionProject.id,
      contentPreflightId: promotionPreflight.id,
      projectVisualContextJson: JSON.stringify({
        source: "suggested",
        visualFormatId: "simple-editorial-story",
        recipeVersion: "simple-editorial-story-v7",
        treatment: "energetic and direct",
        brandVisualLanguage: null,
      }),
      status: "done",
      inputJson: "{}",
      outputJson: "{}",
    },
  });
  await assert.rejects(
    promoteCompletedVideoJobToBrandProfile({
      userId: promotionUser.id,
      projectId: promotionProject.id,
      videoJobId: promotionJob.id,
      payload: basePayload,
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "REVISION_CONFLICT",
    ),
    "post-result promotion must reject visual fields that differ from the completed job snapshot",
  );
  const promotionPayload = {
    ...basePayload,
    visual: {
      ...basePayload.visual,
      languageMode: "none" as const,
      defaultTreatment: "energetic and direct",
    },
  };
  const promoted = await promoteCompletedVideoJobToBrandProfile({
    userId: promotionUser.id,
    projectId: promotionProject.id,
    videoJobId: promotionJob.id,
    payload: promotionPayload,
  });
  assert.equal(promoted.replayed, false);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: promotionProject.id } })).brandProfileRevisionId,
    promoted.revision.id,
    "completed-clip promotion creates the immutable Revision and project pin in one transaction",
  );
  const promotedAgain = await promoteCompletedVideoJobToBrandProfile({
    userId: promotionUser.id,
    projectId: promotionProject.id,
    videoJobId: promotionJob.id,
    payload: promotionPayload,
  });
  assert.equal(promotedAgain.replayed, true);
  assert.equal(promotedAgain.profile.id, promoted.profile.id);
  assert.equal(
    await prisma.brandProfile.count({ where: { userId: promotionUser.id } }),
    1,
    "retrying an ambiguous promotion response must not consume another Brand Profile slot",
  );
  const incompleteJob = await prisma.videoJob.create({
    data: {
      userId: promotionUser.id,
      projectId: promotionProject.id,
      contentPreflightId: promotionPreflight.id,
      status: "processing",
      inputJson: "{}",
    },
  });
  await assert.rejects(
    promoteCompletedVideoJobToBrandProfile({
      userId: promotionUser.id,
      projectId: promotionProject.id,
      videoJobId: incompleteJob.id,
      payload: { ...basePayload, name: "Must roll back" },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND",
    ),
  );
  assert.equal(
    await prisma.brandProfile.count({ where: { userId: promotionUser.id } }),
    1,
    "an invalid source job cannot leave a quota-consuming profile behind",
  );
  const starterPromotionUser = await prisma.user.create({
    data: {
      name: "Starter promotion", email: "starter-promotion@example.test", plan: "FREE",
      trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  const starterPromotionProject = await prisma.editorProject.create({
    data: { userId: starterPromotionUser.id, title: "Starter must see a real AI result" },
  });
  const starterPromotionPreflight = await prisma.contentPreflight.create({
    data: {
      userId: starterPromotionUser.id,
      projectId: starterPromotionProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "starter-promotion-source-v1",
      analyzerVersion: "brand-content-preflight-v3-stable-windows",
      contentDomain: "creator education",
      suggestedVisualFormatId: "simple-editorial-story",
      suggestedTreatmentJson: JSON.stringify({ label: "energetic", mood: "direct" }),
      visualBeats: {
        create: {
          userId: starterPromotionUser.id,
          projectId: starterPromotionProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "starter-promotion-window-0",
          beatJson: JSON.stringify({ sourceExcerpt: "starter result", subject: "creator" }),
        },
      },
    },
  });
  const starterPromotionJob = await prisma.videoJob.create({
    data: {
      userId: starterPromotionUser.id,
      projectId: starterPromotionProject.id,
      contentPreflightId: starterPromotionPreflight.id,
      projectVisualContextJson: JSON.stringify({
        source: "suggested",
        visualFormatId: "simple-editorial-story",
        recipeVersion: "simple-editorial-story-v7",
        treatment: "energetic and direct",
        brandVisualLanguage: null,
      }),
      status: "done",
      inputJson: "{}",
      outputJson: "{}",
    },
  });
  const starterPromotionPayload = {
    ...promotionPayload,
    name: "Starter result brand",
  };
  await assert.rejects(
    promoteCompletedVideoJobToBrandProfile({
      userId: starterPromotionUser.id,
      projectId: starterPromotionProject.id,
      videoJobId: starterPromotionJob.id,
      preflightId: starterPromotionPreflight.id,
      payload: starterPromotionPayload,
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "RESULT_REQUIRED",
    ),
    "a done AutoMix clip with no delivered AI image cannot unlock deep Brand setup for Starter",
  );
  await prisma.aiGenerationJob.create({
    data: {
      userId: starterPromotionUser.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/starter-delivered.webp",
      idempotencyKey: `video:${starterPromotionJob.id}:scene:0`,
      fundingSource: "starter_allowance",
      allowanceUnits: 1,
      chargeState: "settled",
      creditCost: 0,
    },
  });
  const starterPromoted = await promoteCompletedVideoJobToBrandProfile({
    userId: starterPromotionUser.id,
    projectId: starterPromotionProject.id,
    videoJobId: starterPromotionJob.id,
    preflightId: starterPromotionPreflight.id,
    payload: starterPromotionPayload,
  });
  assert.equal(starterPromoted.profile.activeRevisionNumber, 1,
    "one actually delivered AI image unlocks the post-result Brand confirmation");
  const preRenderProject = await prisma.editorProject.create({
    data: { userId: promotionUser.id, title: "Pre-render Project Look promotion" },
  });
  const preRenderPreflight = await prisma.contentPreflight.create({
    data: {
      userId: promotionUser.id,
      projectId: preRenderProject.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "pre-render-promotion-v1",
      analyzerVersion: "brand-content-preflight-v2-windowed",
      contentDomain: "creator education",
      suggestedVisualFormatId: "simple-editorial-story",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "direct" }),
      visualBeats: {
        create: {
          userId: promotionUser.id,
          projectId: preRenderProject.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "pre-render-window-0",
          beatJson: JSON.stringify({ sourceExcerpt: "pre-render hook", subject: "creator" }),
        },
      },
    },
  });
  await assert.rejects(
    promoteProjectLookToBrandProfile({
      userId: promotionUser.id,
      projectId: preRenderProject.id,
      preflightId: preRenderPreflight.id,
      payload: { ...basePayload, name: "Edited pre-render brand" },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "REVISION_CONFLICT",
    ),
    "Step-2 promotion cannot silently relabel existing scenes with an edited visual identity",
  );
  const preRenderPayload = {
    ...basePayload,
    name: "Pre-render brand",
    visual: {
      ...basePayload.visual,
      languageMode: "none" as const,
      defaultTreatment: "clear, direct",
    },
  };
  const promotedBeforeRender = await promoteProjectLookToBrandProfile({
    userId: promotionUser.id,
    projectId: preRenderProject.id,
    preflightId: preRenderPreflight.id,
    payload: preRenderPayload,
  });
  const promotedBeforeRenderAgain = await promoteProjectLookToBrandProfile({
    userId: promotionUser.id,
    projectId: preRenderProject.id,
    preflightId: preRenderPreflight.id,
    payload: preRenderPayload,
  });
  assert.equal(promotedBeforeRenderAgain.replayed, true);
  assert.equal(promotedBeforeRenderAgain.profile.id, promotedBeforeRender.profile.id);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: preRenderProject.id } })).brandProfileRevisionId,
    promotedBeforeRender.revision.id,
    "pre-render Project Look promotion is also one atomic create-and-pin operation",
  );

  await saveBrandProfileDraft({ userId: user.id, profileId: profile.id, payload: basePayload });
  const revisionOne = await publishBrandProfileDraft({ userId: user.id, profileId: profile.id });
  assert.equal(revisionOne.version, 1);
  const publishedProfile = await prisma.brandProfile.findUniqueOrThrow({ where: { id: profile.id } });
  assert.equal(publishedProfile.analysisNotes, basePayload.script.analysisNotes);
  assert.equal(publishedProfile.sampleText, basePayload.script.sampleText);

  // F16: the /brands library write path (Zod caps in brand-profile-library.server.ts)
  // and the legacy /api/brand-profiles write path (checkBrandProfileFieldLimits in
  // brand-profile-limits.ts) inject the same columns into the Hero Script prompt, so
  // an overflow must be rejected with the exact same Thai message on both paths.
  const overLongAnalysisNotes = "x".repeat(4_001);
  const expectedCapMessage = checkBrandProfileFieldLimits({ analysisNotes: overLongAnalysisNotes }).ok === false
    ? checkBrandProfileFieldLimits({ analysisNotes: overLongAnalysisNotes }).message
    : null;
  assert.ok(expectedCapMessage, "checkBrandProfileFieldLimits must itself reject a 4,001-char analysisNotes");
  await assert.rejects(
    saveBrandProfileDraft({
      userId: user.id,
      profileId: profile.id,
      payload: {
        ...basePayload,
        script: { ...basePayload.script, analysisNotes: overLongAnalysisNotes },
      },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "message" in error && error.message === expectedCapMessage
    ),
    "the /brands library write path must reject an over-cap analysisNotes with the legacy route's exact message",
  );

  // F16 fix-round-1 (Critical): the stored/persisted-read boundary must keep
  // accepting the WIDEST caps either write path has ever enforced (this
  // library's own pre-shared-cap literals, or the legacy /api/brand-profiles
  // route's checkBrandProfileFieldLimits caps) — only NEW creator writes are
  // bounded by the tighter shared caps above. Seed a published revision the
  // way a pre-existing row looks (a 500-char audience, 100 banned words, one
  // 80-char banned word) by writing straight into the DB, bypassing the
  // write schema entirely.
  const wideCapsUser = await prisma.user.create({
    data: { name: "Historical wide-caps owner", email: "wide-caps@example.test", plan: "BUSINESS" },
  });
  const wideAudience = "a".repeat(500);
  const wideBannedWords = Array.from({ length: 100 }, (_, index) => index === 0 ? "a".repeat(80) : `banned-${index}`);
  const wideCapsPayload = {
    ...basePayload,
    name: "Historical wide caps profile",
    audience: wideAudience,
    script: { ...basePayload.script, bannedWords: wideBannedWords },
  };
  const wideCapsProfile = await prisma.brandProfile.create({
    data: {
      userId: wideCapsUser.id,
      name: wideCapsPayload.name,
      niche: wideCapsPayload.niche,
      audience: wideCapsPayload.audience,
      tone: wideCapsPayload.script.tone,
      bannedWords: JSON.stringify(wideCapsPayload.script.bannedWords),
      activeRevisionNumber: 1,
      revisions: {
        create: {
          version: 1,
          payloadJson: JSON.stringify(wideCapsPayload),
          visualRecipeJson: JSON.stringify({
            visualFormatId: wideCapsPayload.visual.primaryVisualFormatId,
            recipeVersion: "simple-editorial-story-v7",
            brandVisualLanguage: wideCapsPayload.visual,
            defaultTreatment: wideCapsPayload.visual.defaultTreatment,
            treatmentPolicy: "adaptive",
            lockedTreatmentPin: null,
          }),
        },
      },
    },
    include: { revisions: true },
  });
  const wideCapsRevision = wideCapsProfile.revisions[0]!;
  const wideCapsProject = await prisma.editorProject.create({
    data: { userId: wideCapsUser.id, title: "Historical wide-caps project" },
  });
  const wideCapsPin = await pinProjectBrandRevision({
    userId: wideCapsUser.id,
    projectId: wideCapsProject.id,
    profileId: wideCapsProfile.id,
    revisionId: wideCapsRevision.id,
  });
  assert.equal(
    wideCapsPin.revision.id,
    wideCapsRevision.id,
    "a pre-existing revision with a 500-char audience and 100 banned words (one 80 chars) must still parse and pin",
  );
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: wideCapsProject.id } })).brandProfileRevisionId,
    wideCapsRevision.id,
    "the stored-read boundary must accept the widest historical caps, not just the new shared creator-write caps",
  );

  // audience has its own wider 500-char cap (BRAND_PROFILE_CAPS.audienceChars)
  // — production rows reach 411 chars — while every other short field (name,
  // niche, tone) keeps the 300-char shortFieldChars bound. A 500-char audience
  // must be ACCEPTED by a NEW creator-write draft save on the same profile.
  const acceptedAudienceDraft = await saveBrandProfileDraft({
    userId: wideCapsUser.id,
    profileId: wideCapsProfile.id,
    payload: { ...basePayload, audience: "a".repeat(500) },
  });
  assert.equal(
    (JSON.parse(acceptedAudienceDraft.payloadJson) as { audience: string }).audience.length,
    500,
    "a 500-char audience is accepted by the creator-write caps, not just the stored-read boundary",
  );

  // A 501-char audience must still be rejected, with the exact legacy message.
  const overCapAudienceMessage = checkBrandProfileFieldLimits({ audience: "a".repeat(501) }).ok === false
    ? checkBrandProfileFieldLimits({ audience: "a".repeat(501) }).message
    : null;
  assert.ok(overCapAudienceMessage, "checkBrandProfileFieldLimits must itself reject a 501-char audience");
  await assert.rejects(
    saveBrandProfileDraft({
      userId: wideCapsUser.id,
      profileId: wideCapsProfile.id,
      payload: { ...basePayload, audience: "a".repeat(501) },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "message" in error && error.message === overCapAudienceMessage
    ),
    "a NEW draft save on the same profile still rejects an audience over the wider 500-char cap",
  );

  // The other short fields (proven here via tone) keep the 300-char bound —
  // audience's wider cap must not have leaked onto them.
  const overCapToneMessage = checkBrandProfileFieldLimits({ tone: "a".repeat(301) }).ok === false
    ? checkBrandProfileFieldLimits({ tone: "a".repeat(301) }).message
    : null;
  assert.ok(overCapToneMessage, "checkBrandProfileFieldLimits must itself reject a 301-char tone");
  await assert.rejects(
    saveBrandProfileDraft({
      userId: wideCapsUser.id,
      profileId: wideCapsProfile.id,
      payload: { ...basePayload, script: { ...basePayload.script, tone: "a".repeat(301) } },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "message" in error && error.message === overCapToneMessage
    ),
    "a NEW draft save on the same profile is still bounded by the 300-char cap for tone",
  );

  await prisma.editorProject.update({
    where: { id: project.id },
    data: {
      draftJson: JSON.stringify({ script: "existing clip", voiceEngine: "gemini", geminiVoiceName: "Aoede" }),
      draftRevision: 4,
    },
  });
  await pinProjectBrandRevision({
    userId: user.id,
    projectId: project.id,
    profileId: profile.id,
  });
  const projectAfterInitialPin = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  const draftAfterInitialPin = JSON.parse(projectAfterInitialPin.draftJson ?? "{}") as Record<string, unknown>;
  assert.equal(draftAfterInitialPin.script, "existing clip");
  assert.equal(draftAfterInitialPin.voiceEngine, "elevenlabs");
  assert.equal(draftAfterInitialPin.voiceId, "voice-main");
  assert.equal(projectAfterInitialPin.draftRevision, 5,
    "Revision pin and project defaults advance one authoritative draft revision atomically");

  await saveBrandProfileDraft({
    userId: user.id,
    profileId: profile.id,
    payload: {
      ...basePayload,
      visual: { ...basePayload.visual, palette: ["#111111", "#F8F5EE", "#FF5C35"] },
    },
  });
  const revisionTwo = await publishBrandProfileDraft({ userId: user.id, profileId: profile.id });
  assert.equal(revisionTwo.version, 2);

  const pinnedProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(
    pinnedProject.brandProfileRevisionId,
    revisionOne.id,
    "publishing a new profile revision must not silently move an existing project",
  );
  const storedRevisionOne = await prisma.brandProfileRevision.findUniqueOrThrow({ where: { id: revisionOne.id } });
  assert.deepEqual(JSON.parse(storedRevisionOne.payloadJson).visual.palette, ["#111111", "#F8F5EE", "#38BDF8"]);

  const applyImageJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "https://cdn.example/brand-revision-old.png",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  const applyPreflight = await prisma.contentPreflight.create({
    data: {
      userId: user.id,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: "brand-revision-apply-v1",
      analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
      contentDomain: "creator education",
      dominantNarrativeMode: "continuous practical explanation",
      suggestedVisualFormatId: "clear-infographic",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "calm" }),
      suggestedTreatmentPresetId: "expert-clarity",
      suggestedTreatmentPresetVersion: "v1.0.0",
      rankedTreatmentPresetIdsJson: JSON.stringify([
        "expert-clarity", "practical-documentary", "modern-business-technology",
      ]),
      treatmentRecommendationRationale: "The whole source is a practical explanation.",
      storyEntitiesJson: "[]",
      visualBeats: {
        create: {
          userId: user.id,
          projectId: project.id,
          beatKey: "window-0",
          sequence: 0,
          sourceExcerptHash: "brand-revision-window-0",
          beatJson: JSON.stringify({ subject: "creator", action: "teaches", setting: "studio", emotion: "clear", emphasis: "lesson" }),
          existingAssetUrl: applyImageJob.outputUrl,
          existingImageJobId: applyImageJob.id,
          status: "current",
        },
      },
    },
  });
  await assert.rejects(
    applyProjectBrandRevision({
      userId: user.id,
      projectId: project.id,
      profileId: profile.id,
      revisionId: revisionTwo.id,
      preflightId: applyPreflight.id,
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED",
    ),
  );
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: project.id } })).brandProfileRevisionId,
    revisionOne.id,
    "a rejected Brand Revision change cannot partially move the immutable project pin",
  );
  await assert.rejects(
    applyProjectBrandRevision({
      userId: user.id,
      projectId: project.id,
      profileId: profile.id,
      revisionId: revisionTwo.id,
      preflightId: applyPreflight.id,
      applyMode: "new-only" as never,
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED"
    ),
    "a Brand revision cannot apply only to future images",
  );
  await applyProjectBrandRevision({
    userId: user.id,
    projectId: project.id,
    profileId: profile.id,
    revisionId: revisionTwo.id,
    preflightId: applyPreflight.id,
    applyMode: "regenerate-all",
  });
  assert.equal(
    (await prisma.projectVisualBeat.findFirstOrThrow({ where: { preflightId: applyPreflight.id } })).status,
    "outdated",
    "Brand Revision selection and regenerate-all invalidation commit together",
  );

  const overflowProfile = await prisma.brandProfile.create({
    data: {
      userId: user.id,
      name: "Second channel",
      niche: "finance",
      audience: "first-jobbers",
      tone: "friendly",
    },
  });
  await saveBrandProfileDraft({
    userId: user.id,
    profileId: overflowProfile.id,
    payload: { ...basePayload, name: "Second channel" },
  });
  const overflowRevision = await publishBrandProfileDraft({ userId: user.id, profileId: overflowProfile.id });
  await saveBrandProfileDraft({
    userId: user.id,
    profileId: overflowProfile.id,
    payload: {
      ...basePayload,
      name: "Second channel",
      visual: { ...basePayload.visual, defaultTreatment: "calm finance revision two" },
    },
  });
  const overflowRevisionTwo = await publishBrandProfileDraft({ userId: user.id, profileId: overflowProfile.id });
  const legacyProject = await prisma.editorProject.create({
    data: {
      userId: user.id,
      title: "Legacy client work",
      brandProfileRevisionId: overflowRevision.id,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { plan: "FREE" } });
  const unresolvedDowngrade = await getBrandProfileAvailabilityState({ userId: user.id });
  assert.equal(unresolvedDowngrade.selectionRequired, true);
  await assert.rejects(
    saveBrandProfileDraft({
      userId: user.id,
      profileId: profile.id,
      payload: { ...basePayload, visual: { ...basePayload.visual, defaultTreatment: "must stay locked" } },
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "PREFERRED_REQUIRED"),
    "downgrade locks every profile mutation until the creator chooses the profiles allowed by the new cap",
  );
  await reconcileBrandProfileAvailability({ userId: user.id, preferredProfileId: profile.id });

  const availability = await prisma.brandProfile.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
  });
  assert.equal(availability.find((item) => item.id === profile.id)?.frozenAt, null);
  assert.ok(availability.find((item) => item.id === overflowProfile.id)?.frozenAt);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: legacyProject.id } })).brandProfileRevisionId,
    overflowRevision.id,
    "downgrade must preserve old project revision pins",
  );

  const newProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "New free project" },
  });
  await assert.rejects(
    pinProjectBrandRevision({
      userId: user.id,
      projectId: newProject.id,
      profileId: overflowProfile.id,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "FROZEN"),
  );
  await assert.rejects(
    pinProjectBrandRevision({
      userId: user.id,
      projectId: legacyProject.id,
      profileId: overflowProfile.id,
      revisionId: overflowRevisionTwo.id,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "FROZEN"),
    "a frozen existing project cannot adopt another revision from the same profile",
  );
  const frozenNoop = await pinProjectBrandRevision({
    userId: user.id,
    projectId: legacyProject.id,
    profileId: overflowProfile.id,
    revisionId: overflowRevision.id,
  });
  assert.equal(frozenNoop.project.brandProfileRevisionId, overflowRevision.id);

  await prisma.brandProfile.createMany({
    data: Array.from({ length: 4 }, (_, index) => ({
      userId: user.id,
      name: `Frozen upgrade brand ${index + 1}`,
      niche: "creator education",
      audience: "Thai creators",
      tone: "direct",
      activeRevisionNumber: 1,
      frozenAt: new Date(),
    })),
  });
  await prisma.user.update({ where: { id: user.id }, data: { plan: "PRO" } });
  const upgradedToPro = await getBrandProfileAvailabilityState({ userId: user.id });
  assert.equal(upgradedToPro.selectionRequired, false);
  assert.equal(upgradedToPro.activeProfileIds.length, 5);
  assert.equal(upgradedToPro.frozenProfileIds.length, 1);
  await prisma.user.update({ where: { id: user.id }, data: { plan: "BUSINESS" } });
  const upgradedToBusiness = await getBrandProfileAvailabilityState({ userId: user.id });
  assert.equal(upgradedToBusiness.activeProfileIds.length, 6);
  assert.equal(upgradedToBusiness.frozenProfileIds.length, 0);
  assert.equal(
    await prisma.brandProfile.count({ where: { userId: user.id, frozenAt: { not: null } } }),
    0,
    "upgrade restores available profiles server-side without requiring a visit to /brands",
  );

  const raceUser = await prisma.user.create({
    data: { name: "Race owner", email: "brand-race@example.test", plan: "BUSINESS" },
  });
  const legacyRaceProfile = await prisma.brandProfile.create({
    data: {
      userId: raceUser.id,
      name: "Legacy publish race",
      niche: "creator education",
      audience: "Thai creators",
      tone: "direct",
    },
  });
  const legacyRaceProject = await prisma.editorProject.create({
    data: { userId: raceUser.id, title: "Legacy publish race project" },
  });
  const legacySnapshot = await prisma.brandProfile.findUniqueOrThrow({
    where: { id: legacyRaceProfile.id },
    include: { _count: { select: { revisions: true } } },
  });
  assert.equal(isVersionedBrandProfile({
    activeRevisionNumber: legacySnapshot.activeRevisionNumber,
    frozenAt: legacySnapshot.frozenAt,
    revisionCount: legacySnapshot._count.revisions,
  }), false, "legacy endpoint first observes a mutable row");
  await saveBrandProfileDraft({
    userId: raceUser.id,
    profileId: legacyRaceProfile.id,
    payload: { ...basePayload, name: "Published during legacy request" },
  });
  const raceRevision = await publishBrandProfileDraft({
    userId: raceUser.id,
    profileId: legacyRaceProfile.id,
  });
  await pinProjectBrandRevision({
    userId: raceUser.id,
    projectId: legacyRaceProject.id,
    profileId: legacyRaceProfile.id,
    revisionId: raceRevision.id,
  });
  const lostUpdate = await prisma.brandProfile.updateMany({
    where: legacyBrandProfileMutableWhere(raceUser.id, legacyRaceProfile.id),
    data: { name: "stale legacy overwrite" },
  });
  const lostDelete = await prisma.brandProfile.deleteMany({
    where: legacyBrandProfileMutableWhere(raceUser.id, legacyRaceProfile.id),
  });
  assert.equal(lostUpdate.count, 0, "legacy PUT CAS must lose to concurrent publish");
  assert.equal(lostDelete.count, 0, "legacy DELETE CAS must lose to concurrent publish");
  assert.equal(
    (await prisma.brandProfileRevision.findUnique({ where: { id: raceRevision.id } }))?.id,
    raceRevision.id,
    "a lost legacy delete cannot cascade immutable history",
  );
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: legacyRaceProject.id } })).brandProfileRevisionId,
    raceRevision.id,
    "a lost legacy delete cannot clear a project Revision pin",
  );

  assert.equal(isVersionedBrandProfile({ activeRevisionNumber: 0, revisionCount: 0 }), false);
  assert.equal(isVersionedBrandProfile({ activeRevisionNumber: 1, revisionCount: 1 }), true);
  const legacyRouteSource = readFileSync("src/app/api/brand-profiles/[id]/route.ts", "utf8");
  assert.ok(
    legacyRouteSource.match(/export async function PUT[\s\S]*isVersionedBrandProfile/)
      && legacyRouteSource.match(/export async function DELETE[\s\S]*archiveBrandProfile/)
      && !legacyRouteSource.match(/export async function DELETE[\s\S]*prisma\.brandProfile\.deleteMany/)
      && legacyRouteSource.includes("VERSIONED_PROFILE_READ_ONLY"),
    "legacy edits stay read-only while deletes archive without destroying Revision history or project pins",
  );
  const libraryRouteSource = readFileSync("src/app/api/brand-library/route.ts", "utf8");
  assert.ok(
    libraryRouteSource.includes("getBrandProfileAvailabilityState")
      && libraryRouteSource.indexOf("getBrandProfileAvailabilityState")
        < libraryRouteSource.indexOf("prisma.brandProfile.findMany"),
    "every Brand Library read, including Editor, must reconcile immediate upgrade thaw before returning profiles",
  );
  assert.match(
    libraryRouteSource,
    /activeRevisionNumber:\s*\{\s*gt:\s*0\s*\}/,
    "Brand Library and Editor must not present legacy revision-0 Hero Script rows as pinnable profiles",
  );
  // ADR 0059 replaces the starter-allowance creation block: creating a Brand
  // Profile now needs only the library guard, and plan limits are the only cap.
  assert.ok(
    libraryRouteSource.includes("requireBrandLibraryUser")
      && !libraryRouteSource.includes("getStarterAiImageAllowanceStatus")
      && !libraryRouteSource.includes('code: "RESULT_REQUIRED"'),
    "creating a Brand Profile is open to every plan; only the master switch, suspension and plan limits apply",
  );
  // ── Relaxed publish gate: a name is the only answer a creator must give ──
  const minimalUser = await prisma.user.create({
    data: { name: "Minimal brand owner", email: "brand-minimal@example.test", plan: "PRO" },
  });
  // Every optional field the /brands form exposes cleared to empty: niche,
  // audience, script.tone AND the two ตั้งค่าเพิ่มเติม > โทนภาพของแบรนด์ text
  // fields (visual.personality, visual.defaultTreatment) that carried the
  // same server-required-but-not-gated trap as niche/audience/tone.
  const minimalPayload = {
    ...basePayload,
    name: "ชื่อเดียวก็พอ",
    niche: "",
    audience: "",
    script: { ...basePayload.script, tone: "", analysisNotes: null, sampleText: null },
    voice: { ...basePayload.voice, voiceId: null },
    visual: { ...basePayload.visual, personality: "", defaultTreatment: "", visualNotes: "" },
  };
  const minimalProfile = await createBrandProfileFromPayload({
    userId: minimalUser.id,
    payload: minimalPayload,
  });
  assert.equal(
    minimalProfile.profile.activeRevisionNumber,
    1,
    "a Brand Profile with only a name publishes its first immutable Revision, "
      + "even with every optional field (including visual.personality and "
      + "visual.defaultTreatment) cleared",
  );
  const storedMinimal = await prisma.brandProfile.findUniqueOrThrow({
    where: { id: minimalProfile.profile.id },
  });
  assert.equal(storedMinimal.niche, "", "an unanswered niche is stored empty, not rejected");
  assert.equal(storedMinimal.audience, "", "an unanswered audience is stored empty, not rejected");
  assert.equal(storedMinimal.tone, "", "an unanswered tone is stored empty, not rejected");
  const storedMinimalRevision = await prisma.brandProfileRevision.findUniqueOrThrow({
    where: { brandProfileId_version: { brandProfileId: minimalProfile.profile.id, version: 1 } },
  });
  const storedMinimalPayload = JSON.parse(storedMinimalRevision.payloadJson) as { visual: { personality: string; defaultTreatment: string } };
  assert.equal(
    storedMinimalPayload.visual.personality,
    "",
    "an unanswered visual.personality is stored empty, not rejected — dropped `.min(1)` fixes the "
      + "generic 'ข้อมูลแบรนด์ไม่ครบ' 400 a creator hit when clearing this field",
  );
  assert.equal(
    storedMinimalPayload.visual.defaultTreatment,
    "",
    "an unanswered visual.defaultTreatment is stored empty, not rejected — same trap as personality, found in the sweep",
  );
  assert.equal(
    brandProfilePayloadSchema.safeParse({ ...minimalPayload, name: "   " }).success,
    false,
    "the name is still the one required field",
  );

  // ── The two retired scene fields stay deserializable with empty defaults ──
  const retiredFieldsOmitted = brandProfilePayloadSchema.parse({
    ...minimalPayload,
    visual: {
      primaryVisualFormatId: "clear-infographic",
      languageMode: "defined",
      palette: ["#2B2926", "#F5F1E8", "#A8A29E"],
      personality: "สมดุล ชัดเจน และปรับให้เข้ากับแบรนด์ได้",
      visualNotes: "",
      defaultTreatment: "ชัดเจน สมดุล และอ่านเรื่องได้ทันที",
    },
  });
  assert.equal(
    retiredFieldsOmitted.visual.peopleAndSetting,
    "",
    "a payload authored after ADR 0006 still yields the retired scene field as an empty default",
  );
  assert.deepEqual(
    retiredFieldsOmitted.visual.memorableCues,
    [],
    "a payload authored after ADR 0006 still yields the retired cue field as an empty default",
  );
  const pinnedLegacyRevision = brandProfilePayloadSchema.parse(
    JSON.parse(JSON.stringify(basePayload)),
  );
  assert.equal(
    pinnedLegacyRevision.visual.peopleAndSetting,
    "Thai creator contexts",
    "a pinned pre-ADR-0006 revision keeps deserializing with its stored scene field intact",
  );
  assert.deepEqual(
    pinnedLegacyRevision.visual.memorableCues,
    ["blue marker circle", "blue marker arrow"],
    "a pinned pre-ADR-0006 revision keeps deserializing with its stored cues intact",
  );

  // Support feature #47l593 — archive removes a Brand from new work without
  // cascading into immutable revisions already pinned by historical projects.
  const archiveUser = await prisma.user.create({
    data: { name: "Archive owner", email: "brand-archive@example.test", plan: "BUSINESS" },
  });
  const archiveCreated = await createBrandProfileFromPayload({
    userId: archiveUser.id,
    payload: { ...basePayload, name: "Archive without history loss" },
  });
  const archiveProject = await prisma.editorProject.create({
    data: { userId: archiveUser.id, title: "Pinned before archive" },
  });
  const pinnedBeforeArchive = await pinProjectBrandRevision({
    userId: archiveUser.id,
    projectId: archiveProject.id,
    profileId: archiveCreated.profile.id,
  });
  const archived = await archiveBrandProfile({
    userId: archiveUser.id,
    profileId: archiveCreated.profile.id,
  });
  assert.equal(archived.replayed, false);
  assert.ok(archived.archivedAt instanceof Date);
  assert.equal(
    (await prisma.editorProject.findUniqueOrThrow({ where: { id: archiveProject.id } })).brandProfileRevisionId,
    pinnedBeforeArchive.revision.id,
    "archiving preserves the immutable Revision pinned by an existing project",
  );
  assert.deepEqual(
    (await getBrandProfileAvailabilityState({ userId: archiveUser.id })).activeProfileIds,
    [],
    "archived Brands no longer consume an active Brand Library slot",
  );
  await assert.rejects(
    saveBrandProfileDraft({
      userId: archiveUser.id,
      profileId: archiveCreated.profile.id,
      payload: basePayload,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND"),
    "an archived Brand cannot be edited through a stale tab",
  );
  assert.equal(
    (await archiveBrandProfile({ userId: archiveUser.id, profileId: archiveCreated.profile.id })).replayed,
    true,
    "an ambiguous archive response is safe to retry",
  );

  // A Draft persisted BEFORE the creator-write caps landed (audience 301-500,
  // more than 20 banned words) is stored data, not creator input: publishing it
  // and quoting a preview for it must read it through the historical caps.
  // Re-validating a stored row against CREATOR_WRITE_TEXT_CAPS locked the owner
  // out of their own draft (INVALID_DRAFT on publish, a 500 on preview-quote).
  const legacyDraftUser = await prisma.user.create({
    data: { name: "Legacy draft owner", email: "brand-legacy-draft@example.test", plan: "BUSINESS" },
  });
  const legacyDraftCreated = await createBrandProfileFromPayload({
    userId: legacyDraftUser.id,
    payload: { ...basePayload, name: "Legacy wide draft" },
  });
  const legacyWideAudience = "ก".repeat(500);
  const legacyWideBannedWords = Array.from({ length: 100 }, (_, index) => `คำต้องห้าม-${index}`);
  const legacyWideDraftPayload = {
    ...basePayload,
    name: "Legacy wide draft",
    audience: legacyWideAudience,
    script: { ...basePayload.script, bannedWords: legacyWideBannedWords },
  };
  assert.equal(
    brandProfilePayloadSchema.safeParse(legacyWideDraftPayload).success,
    false,
    "the tightened creator-write caps still reject this shape for a NEW write",
  );
  assert.equal(
    storedBrandProfilePayloadSchema.safeParse(legacyWideDraftPayload).success,
    true,
    "the historical caps still read this shape once it is a stored row",
  );
  await prisma.brandProfileDraft.update({
    where: { brandProfileId: legacyDraftCreated.profile.id },
    data: { payloadJson: JSON.stringify(legacyWideDraftPayload) },
  });
  const { brandLookPreviewGenerationCount } = await import("../src/lib/brand-look-preview.server");
  const legacyDraftQuote = await brandLookPreviewGenerationCount({
    userId: legacyDraftUser.id,
    profileId: legacyDraftCreated.profile.id,
    useDraft: true,
  });
  assert.ok(
    Number.isInteger(legacyDraftQuote) && legacyDraftQuote >= 0 && legacyDraftQuote <= 3,
    "quoting a pre-cap draft answers with a count instead of throwing",
  );
  const { prepareBrandLookPreview } = await import("../src/lib/brand-look-preview.server");
  const legacyDraftPrepared = await prepareBrandLookPreview({
    userId: legacyDraftUser.id,
    requestId: "legacy-wide-draft-request",
    profileId: legacyDraftCreated.profile.id,
    useDraft: true,
  });
  assert.ok(
    Number.isInteger(legacyDraftPrepared.generationCount),
    "preparing a preview for a pre-cap draft reads the stored row instead of throwing a 500",
  );
  const legacyDraftRevision = await publishBrandProfileDraft({
    userId: legacyDraftUser.id,
    profileId: legacyDraftCreated.profile.id,
  });
  assert.equal(
    legacyDraftRevision.version,
    legacyDraftCreated.revision.version + 1,
    "a pre-cap draft still publishes the next immutable Revision",
  );
  assert.equal(
    (JSON.parse(legacyDraftRevision.payloadJson) as { audience: string }).audience,
    legacyWideAudience,
    "publishing a pre-cap draft preserves the stored value byte-for-byte",
  );

  // The /brands route is a server shell plus client islands; every source-level
  // contract below holds across the whole route, not one file.
  const brandsComponentsDirectory = "src/app/(dashboard)/brands/_components";
  const brandLibraryPageSource = [
    readFileSync("src/app/(dashboard)/brands/page.tsx", "utf8"),
    ...readdirSync(brandsComponentsDirectory)
      .sort()
      .map((file) => readFileSync(join(brandsComponentsDirectory, file), "utf8")),
  ].join("\n");
  const savePromptSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/SaveProjectLookPrompt.tsx",
    "utf8",
  );
  const videoJobRouteSource = readFileSync("src/app/api/videos/jobs/[id]/route.ts", "utf8");
  const brandRevisionRouteSource = readFileSync(
    "src/app/api/editor-projects/[id]/brand-revision/route.ts",
    "utf8",
  );
  const brandSelectorSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx",
    "utf8",
  );
  assert.match(brandLibraryPageSource, /\/api\/brand-library\/from-project-look/,
    "Project Look confirmation uses the atomic create-and-pin endpoint");
  assert.doesNotMatch(brandLibraryPageSource, /\/brand-revision/,
    "the Brand Library page cannot create a profile and pin it in a second request");
  assert.match(savePromptSource, /videoJobId/,
    "the post-result save prompt carries the completed VideoJob identity");
  assert.match(videoJobRouteSource, /contentPreflightId:\s*true/,
    "the owner-only job poll exposes exact completed Content Preflight lineage");
  assert.match(videoJobRouteSource, /projectVisualContextJson:\s*true[\s\S]+projectVisualContext(?:,|:)/,
    "the owner-only job poll exposes the completed clip's immutable visual snapshot");
  assert.match(videoJobRouteSource, /sceneRerollCapability:\s*resolveSceneRerollCapability/,
    "the same immutable snapshot drives the job-specific Scene Reroll capability");
  assert.match(brandLibraryPageSource, /sourceJob\.projectVisualContext/,
    "post-result Brand promotion seeds from the completed job snapshot, not mutable project state");
  assert.ok(
    brandLibraryPageSource.includes('type="file"')
      && brandLibraryPageSource.includes('/api/user/brand-assets'),
    "Brand Library lets an eligible Free creator upload the Brand Mark instead of only selecting an old asset",
  );
  // ADR 0059: no creator is redirected out of the library any more. The paid /
  // rollout gate is disclosed on the button that spends an AI image instead.
  assert.ok(
    !brandLibraryPageSource.includes("library.creationRequiresResult")
      && !brandLibraryPageSource.includes("สร้างคลิปแรก แล้วบันทึกแนวภาพจากผลงานจริง")
      && brandLibraryPageSource.includes("imageAccess={library.imageAccess}")
      && brandLibraryPageSource.includes('data-testid="preview-disabled-reason"'),
    "the Brand Library stays open to every plan and discloses the image gate on the image action",
  );
  assert.match(brandRevisionRouteSource, /editorProjectResponse\(pinned\.project\)/,
    "Brand Revision pin returns the authoritative draft revision committed with its defaults");
  assert.match(brandSelectorSource, /acceptAuthoritativeProjectSnapshot/,
    "the Editor rebases autosave lineage onto the atomic Brand Revision draft response");
  const pinProfileSource = brandSelectorSource.slice(
    brandSelectorSource.indexOf("async function pinProfile"),
    brandSelectorSource.indexOf("if (!canRenderPersistedVisual)"),
  );
  assert.ok(
    pinProfileSource.indexOf("await p.flushPendingProjectDraft()") >= 0
      && pinProfileSource.indexOf("await p.flushPendingProjectDraft()")
        < pinProfileSource.indexOf("/brand-revision")
      && pinProfileSource.indexOf("/brand-revision")
        < pinProfileSource.indexOf("acceptAuthoritativeProjectSnapshot"),
    "Brand Revision pin durably flushes the latest Editor draft before accepting its authoritative snapshot",
  );
  assert.match(
    libraryRouteSource,
    /activeRevisionId:\s*profile\.revisions\[0\]\?\.id\s*\?\?\s*null/,
    "the Editor library response exposes the exact latest immutable Revision id",
  );
  assert.ok(
    libraryRouteSource.includes("legacyVisualFormat")
      && brandSelectorSource.includes("profile.legacyVisualFormat")
      && brandSelectorSource.includes("รุ่นเดิม · เลือกใช้กับงานใหม่ไม่ได้"),
    "the Editor marks retired-format profiles as historical and disables new selection",
  );
  assert.ok(
    brandSelectorSource.includes("ใช้รุ่นล่าสุดกับคลิปนี้")
      && brandSelectorSource.includes("revisionId")
      && brandSelectorSource.includes("activeRevisionId"),
    "an already-pinned project can explicitly adopt the latest Revision through the normal confirmation flow",
  );

  await prisma.$disconnect();
  console.log("verify-brand-profile-library: PASS revision pinning + downgrade freeze");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
