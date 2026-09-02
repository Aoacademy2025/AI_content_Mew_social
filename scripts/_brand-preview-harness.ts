/** Shared temp-database and seed helpers for the Brand Look Preview verify
 * scripts. Every export here is deliberately side-effect free at import time:
 * `createTempDatabase` must run at module scope BEFORE any server module that
 * reads `DATABASE_URL` is imported, so the seeds below import Prisma lazily. */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrandProfilePayload } from "../src/lib/brand-profile-library.server";

/** Points this process at a throwaway SQLite file and pushes the schema into
 * it. Returns the temp directory so a caller can inspect files it writes. */
export function createTempDatabase(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  return directory;
}

const LEGACY_VISUAL_RECIPE_JSON = JSON.stringify({
  visualFormatId: "simple-editorial-story",
  recipeVersion: "simple-editorial-story-v7",
});

/** The canonical preview payload fixture. `tag` only varies the display name so
 * two profiles can coexist in one database without changing the visual identity
 * key that drives image reuse. Schema-defaulted fields (languageMode,
 * treatmentPolicy) are filled in when the payload is parsed, so the literal is
 * asserted rather than spelled out. */
export function blankPayload(tag = ""): BrandProfilePayload {
  return {
    schemaVersion: 1 as const,
    name: tag ? `Preview brand ${tag}` : "Preview brand",
    niche: "creator education",
    audience: "Thai creators",
    script: { styleId: null, tone: "direct", bannedWords: [], ctaStyle: "follow", language: "th" },
    voice: { provider: "elevenlabs", voiceId: null },
    subtitle: { presetId: null, config: {} },
    brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "simple-editorial-story" as const,
      palette: ["#111111", "#F8F5EE", "#38BDF8"],
      personality: "bold handmade",
      peopleAndSetting: "Thai creator contexts",
      memorableCues: ["blue marker arrow"],
      visualNotes: "rough lines",
      defaultTreatment: "energetic",
    },
  } as BrandProfilePayload;
}

/** The identity key a preview of the *draft* generates under. Images seeded
 * with this key are the ones a `useDraft` preview is allowed to reuse. */
export async function draftPreviewIdentityKey(payload: BrandProfilePayload): Promise<string> {
  const { brandLookPreviewTreatment } = await import("../src/lib/brand-look-preview.server");
  const { brandVisualIdentityKey, VISUAL_FORMATS } = await import("../src/lib/brand-visual-system");
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === payload.visual.primaryVisualFormatId);
  if (!format) throw new Error("Unsupported Visual Format");
  const previewTreatment = brandLookPreviewTreatment(payload);
  return brandVisualIdentityKey({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion: format.recipeVersion,
    treatment: previewTreatment.treatment,
    ...(previewTreatment.treatmentPin ? { treatmentPin: previewTreatment.treatmentPin } : {}),
    brandVisualLanguage: {
      palette: payload.visual.palette,
      personality: payload.visual.personality,
      peopleAndSetting: payload.visual.peopleAndSetting,
      memorableCues: payload.visual.memorableCues,
      visualNotes: payload.visual.visualNotes,
    },
  });
}

export async function seedUser(tag = "") {
  const { prisma } = await import("../src/lib/prisma");
  const user = await prisma.user.create({
    data: { name: "Preview owner", email: `preview${tag}@example.test` },
  });
  await prisma.creditBalance.create({ data: { userId: user.id, granted: 40, purchased: 0 } });
  return user;
}

/** A saved Brand Profile with one published revision and an editable draft.
 * No clip lineage, so a preview of it can never reuse project images. */
export async function seedPublishedProfile(userId: string, tag = "") {
  const { prisma } = await import("../src/lib/prisma");
  const payload = blankPayload(tag);
  const profile = await prisma.brandProfile.create({
    data: {
      userId,
      name: payload.name,
      niche: payload.niche,
      audience: payload.audience,
      tone: payload.script.tone,
      activeRevisionNumber: 1,
    },
  });
  const revision = await prisma.brandProfileRevision.create({
    data: {
      brandProfileId: profile.id,
      version: 1,
      payloadJson: JSON.stringify(payload),
      visualRecipeJson: LEGACY_VISUAL_RECIPE_JSON,
    },
  });
  const draft = await prisma.brandProfileDraft.create({
    data: { brandProfileId: profile.id, baseRevisionNumber: 1, payloadJson: JSON.stringify(payload) },
  });
  return { payload, profile, revision, draft };
}

/** A Brand Profile promoted from a completed clip: its revision keeps the
 * source preflight identity, and the project carries reusable Visual Beat
 * images whose settled jobs share the revision's preview identity key. This is
 * the exact shape that lets a later preview reuse Hook/Explain/Close, so the
 * quote for it must be lower than three. */
export async function seedProfilePromotedFromClip(
  userId: string,
  tag = "",
  options: {
    reusableImages?: number;
    /** Identity key the reusable images were generated under. Defaults to the
     * published revision's replay identity; pass `draftPreviewIdentityKey` to
     * seed images a draft preview can reuse instead. */
    identityKey?: string;
    /** Adds the editable draft row a `useDraft` preview needs. */
    withDraft?: boolean;
  } = {},
) {
  const { prisma } = await import("../src/lib/prisma");
  const { brandVisualIdentityKey } = await import("../src/lib/brand-visual-system");
  const reusableImages = options.reusableImages ?? 3;
  const { payload, profile, revision } = await seedProfileWithLegacyRevision(userId, tag);
  if (options.withDraft) {
    await prisma.brandProfileDraft.create({
      data: { brandProfileId: profile.id, baseRevisionNumber: 1, payloadJson: JSON.stringify(payload) },
    });
  }
  const previewIdentityKey = options.identityKey ?? brandVisualIdentityKey({
    visualFormatId: payload.visual.primaryVisualFormatId,
    recipeVersion: "simple-editorial-story-v7",
    treatment: payload.visual.defaultTreatment,
    brandVisualLanguage: {
      palette: payload.visual.palette,
      personality: payload.visual.personality,
      peopleAndSetting: payload.visual.peopleAndSetting,
      memorableCues: payload.visual.memorableCues,
      visualNotes: payload.visual.visualNotes,
    },
  });
  const project = await prisma.editorProject.create({
    data: { userId, title: "Existing video", brandProfileRevisionId: revision.id },
  });
  const preflight = await prisma.contentPreflight.create({
    data: {
      userId,
      projectId: project.id,
      narrativeSourceKind: "creator-script",
      sourceHash: `preview-source${tag}`,
      analyzerVersion: "brand-content-preflight-v1",
      contentDomain: payload.niche,
      suggestedVisualFormatId: "simple-editorial-story",
      suggestedTreatmentJson: JSON.stringify({ label: "clear", mood: "bold" }),
    },
  });
  await prisma.brandProfileRevision.update({
    where: { id: revision.id },
    data: { sourcePreflightId: preflight.id },
  });
  for (let index = 0; index < reusableImages; index += 1) {
    const imageJob = await prisma.aiGenerationJob.create({
      data: {
        userId,
        kind: "image",
        provider: "runpod",
        model: "z-image-turbo",
        status: "completed",
        outputUrl: `/generated/existing${tag}-${index}.webp`,
        inputJson: JSON.stringify({ brandVisualIdentityKey: previewIdentityKey }),
        chargeState: "settled",
      },
    });
    await prisma.projectVisualBeat.create({
      data: {
        userId,
        projectId: project.id,
        preflightId: preflight.id,
        beatKey: `window-${index}`,
        sequence: index,
        sourceExcerptHash: `hash${tag}-${index}`,
        beatJson: JSON.stringify({ subject: "creator", action: "explains", setting: "studio", emotion: "focused", emphasis: "one idea" }),
        existingAssetUrl: `/generated/existing${tag}-${index}.webp`,
        existingImageJobId: imageJob.id,
      },
    });
  }
  return { payload, profile, revision, previewIdentityKey, project, preflight };
}

/** Profile + published revision only, without the draft row: the shape a
 * promoted-from-clip profile has before anyone edits it in the library. */
async function seedProfileWithLegacyRevision(userId: string, tag: string) {
  const { prisma } = await import("../src/lib/prisma");
  const payload = blankPayload(tag);
  const profile = await prisma.brandProfile.create({
    data: {
      userId,
      name: payload.name,
      niche: payload.niche,
      audience: payload.audience,
      tone: payload.script.tone,
      activeRevisionNumber: 1,
    },
  });
  const revision = await prisma.brandProfileRevision.create({
    data: {
      brandProfileId: profile.id,
      version: 1,
      payloadJson: JSON.stringify(payload),
      visualRecipeJson: LEGACY_VISUAL_RECIPE_JSON,
    },
  });
  return { payload, profile, revision };
}
