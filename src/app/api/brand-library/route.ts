import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandLibraryUser } from "@/lib/brand-visual-access.server";
import {
  BrandProfileLibraryError,
  brandProfilePayloadSchema,
  createBrandProfileFromPayload,
  getBrandProfileAvailabilityState,
} from "@/lib/brand-profile-library.server";
import {
  VISUAL_FORMATS,
  brandLookIdentityKey,
  brandVisualIdentityKey,
  isActiveVisualFormatId,
  type BrandVisualLanguage,
  type VisualFormatId,
} from "@/lib/brand-visual-system";
import { currentBrandVoiceDefaults } from "@/lib/brand-profile-seed";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { TREATMENT_PRESETS } from "@/lib/brand-treatment-catalog";
import { visualFormatPreviewUrl } from "@/lib/brand-visual-format-preview";

function json(value: string | null | undefined) {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function stringList(value: string | null | undefined): string[] {
  const parsed = json(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function revisionHasActiveVisualFormat(value: string | null | undefined): boolean {
  const parsed = json(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const visualFormatId = (parsed as Record<string, unknown>).visualFormatId;
  return typeof visualFormatId === "string" && isActiveVisualFormatId(visualFormatId);
}

function profileError(error: unknown) {
  if (!(error instanceof BrandProfileLibraryError)) return null;
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "PREFERRED_REQUIRED" ? 403
      : error.code === "REVISION_CONFLICT" ? 409 : 400;
  return NextResponse.json({ code: error.code, error: error.message }, { status });
}

export async function GET() {
  try {
    const auth = await requireBrandLibraryUser();
    if (!auth.ok) return auth.response;
    const availability = await getBrandProfileAvailabilityState({ userId: auth.user.id });
    const [profiles, brandPreference, subtitlePresets, writingStyle, brandAssets] = await Promise.all([
      prisma.brandProfile.findMany({
        where: { userId: auth.user.id, activeRevisionNumber: { gt: 0 }, archivedAt: null },
        orderBy: [{ frozenAt: "asc" }, { lastUsedAt: "desc" }, { updatedAt: "desc" }],
        include: {
          draft: true,
          revisions: { orderBy: { version: "desc" } },
        },
      }),
      prisma.brandPreference.findUnique({
        where: { userId: auth.user.id },
        include: { defaultAsset: { select: { id: true, originalName: true } } },
      }),
      prisma.editorStylePreset.findMany({
        where: { userId: auth.user.id, kind: "subtitle" },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.style.findFirst({
        where: { userId: auth.user.id },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.brandAsset.findMany({
        where: { userId: auth.user.id, retiredAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, originalName: true },
      }),
    ]);
    const subtitlePreset = subtitlePresets[0];
    const cap = availability.cap;
    const availabilitySelectionRequired = availability.selectionRequired;
    return NextResponse.json({
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        niche: profile.niche,
        audience: profile.audience,
        tone: profile.tone,
        bannedWords: stringList(profile.bannedWords),
        ctaStyle: profile.ctaStyle,
        language: profile.language,
        analysisNotes: profile.analysisNotes,
        sampleText: profile.sampleText,
        activeRevisionNumber: profile.activeRevisionNumber,
        activeRevisionId: profile.revisions[0]?.id ?? null,
        legacyVisualFormat: !revisionHasActiveVisualFormat(profile.revisions[0]?.visualRecipeJson),
        frozen: availabilitySelectionRequired || availability.frozenProfileIds.includes(profile.id),
        frozenAt: profile.frozenAt,
        lastUsedAt: profile.lastUsedAt,
        updatedAt: profile.updatedAt,
        draft: profile.draft ? {
          baseRevisionNumber: profile.draft.baseRevisionNumber,
          payload: json(profile.draft.payloadJson),
          updatedAt: profile.draft.updatedAt,
        } : null,
        revisions: profile.revisions.map((revision) => ({
          id: revision.id,
          version: revision.version,
          source: revision.source,
          payload: json(revision.payloadJson),
          visualRecipe: json(revision.visualRecipeJson),
          createdAt: revision.createdAt,
        })),
      })),
      cap: Number.isFinite(cap) ? cap : null,
      canCreate: !Number.isFinite(cap) || profiles.length < cap,
      // ADR 0059: the page never closes on entitlement — the image buttons do.
      imageAccess: { canUse: auth.access.canUse, reason: auth.access.reason, upgradeUrl: "/pricing" },
      availabilitySelectionRequired,
      visualFormats: VISUAL_FORMATS.map((format) => ({
        ...format,
        previewUrl: visualFormatPreviewUrl(format.id),
      })),
      treatmentPresets: TREATMENT_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.thaiLabel,
      })),
      subtitlePresets: subtitlePresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        config: json(preset.configJson) ?? {},
      })),
      brandAssets: brandAssets.map((asset) => ({ id: asset.id, name: asset.originalName })),
      defaults: {
        script: {
          styleId: writingStyle?.id ?? null,
          tone: writingStyle?.instructionPrompt.slice(0, 500) || "ชัดเจน เป็นกันเอง และมีพลัง",
          analysisNotes: writingStyle?.instructionPrompt.slice(0, 4_000) ?? null,
          sampleText: writingStyle?.sampleText?.slice(0, 4_000) ?? null,
        },
        voice: currentBrandVoiceDefaults(auth.user),
        subtitle: {
          presetId: subtitlePreset?.id ?? null,
          config: json(subtitlePreset?.configJson) ?? {},
        },
        brandMark: {
          assetId: brandPreference?.defaultAssetId ?? null,
          assetName: brandPreference?.defaultAsset.originalName ?? null,
          enabled: brandPreference?.enabled ?? false,
          position: brandPreference?.position ?? "top-right",
          sizePct: brandPreference?.sizePct ?? 18,
          opacity: brandPreference?.opacity ?? 0.9,
        },
      },
      cohort: auth.access.cohort,
    });
  } catch (error) {
    return apiError({ route: "GET /api/brand-library", error });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireBrandLibraryUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const parsed = brandProfilePayloadSchema.safeParse(body?.payload ?? body);
    if (!parsed.success) {
      return NextResponse.json(
        { code: "INVALID_DRAFT", error: parsed.error.issues[0]?.message || "ข้อมูลแบรนด์ไม่ครบ" },
        { status: 400 },
      );
    }
    const created = await createBrandProfileFromPayload({
      userId: auth.user.id,
      payload: parsed.data,
      source: body?.source === "project-look" ? "project-look" : "manual",
    });
    const visualRecipe = JSON.parse(created.revision.visualRecipeJson) as {
      visualFormatId: VisualFormatId;
      recipeVersion: string;
      defaultTreatment: string;
      brandVisualLanguage?: BrandVisualLanguage | null;
    };
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_profile_saved",
      source: "server",
      status: "created",
      properties: {
        profileId: created.profile.id,
        revision: created.revision.version,
        source: created.revision.source,
        cohort: auth.access.cohort,
        visualFormatId: parsed.data.visual.primaryVisualFormatId,
        brandVisualIdentityKey: brandVisualIdentityKey({
          visualFormatId: visualRecipe.visualFormatId,
          recipeVersion: visualRecipe.recipeVersion,
          treatment: visualRecipe.defaultTreatment,
          brandVisualLanguage: visualRecipe.brandVisualLanguage ?? null,
        }),
        brandLookIdentityKey: brandLookIdentityKey({
          visualFormatId: visualRecipe.visualFormatId,
          recipeVersion: visualRecipe.recipeVersion,
          treatment: visualRecipe.defaultTreatment,
          brandVisualLanguage: visualRecipe.brandVisualLanguage ?? null,
        }),
      },
    }).catch(() => {});
    return NextResponse.json({
      profileId: created.profile.id,
      revisionId: created.revision.id,
      revision: created.revision.version,
    }, { status: 201 });
  } catch (error) {
    const handled = profileError(error);
    if (handled) return handled;
    return apiError({ route: "POST /api/brand-library", error });
  }
}
