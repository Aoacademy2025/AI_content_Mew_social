import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  brandVisualLockedResponse,
  requireBrandVisualRecoveryUser,
  requireBrandVisualUser,
} from "@/lib/brand-visual-access.server";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { prisma } from "@/lib/prisma";
import {
  TREATMENT_PRESETS,
  TREATMENT_PRESET_IDS,
  createCatalogTreatmentPin,
  treatmentPresetThaiLabel,
  type TreatmentPresetId,
} from "@/lib/brand-treatment-catalog";
import { lookChangeConfirmation } from "@/lib/brand-treatment-presentation";
import {
  ProjectLookError,
  applyProjectLook,
  projectHasPersistedVisualPin,
  projectLookInputSchema,
  reusableProjectVisualBeatSceneIndices,
  resolveProjectVisualContext,
  saveUploadProjectVisualFormatAwaitingPreflight,
} from "@/lib/project-look.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { VISUAL_FORMAT_IDS, brandLookIdentityKey, brandVisualIdentityKey, type VisualFormatId } from "@/lib/brand-visual-system";

function parseOptionalJson(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function currentVisualState(userId: string, projectId: string, preflightId?: string) {
  const preflight = await prisma.contentPreflight.findFirst({
    where: { userId, projectId, ...(preflightId ? { id: preflightId } : {}) },
    orderBy: preflightId ? undefined : { createdAt: "desc" },
    include: { visualBeats: { orderBy: { sequence: "asc" } } },
  });
  if (preflightId && !preflight) {
    throw new ProjectLookError("NOT_FOUND", "ไม่พบข้อมูลฉากชุดนี้");
  }
  const suggestedPresetId = preflight?.suggestedTreatmentPresetId as TreatmentPresetId | null;
  const suggestedPin = suggestedPresetId && TREATMENT_PRESET_IDS.includes(suggestedPresetId)
    ? createCatalogTreatmentPin(suggestedPresetId, "adaptive")
    : null;
  const rankedTreatmentPresetIds = (() => {
    try {
      const parsed = JSON.parse(preflight?.rankedTreatmentPresetIdsJson ?? "[]") as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((id): id is TreatmentPresetId => typeof id === "string" && TREATMENT_PRESET_IDS.includes(id as TreatmentPresetId))
        : [];
    } catch {
      return [];
    }
  })();
  const legacyTreatment = parseOptionalJson(preflight?.suggestedTreatmentJson) as { label?: string; mood?: string } | null;
  return {
    preflight,
    suggested: {
      visualFormatId: (preflight?.suggestedVisualFormatId ?? "clear-infographic") as VisualFormatId,
      treatment: suggestedPin
        ? treatmentPresetThaiLabel(suggestedPin)
        : [legacyTreatment?.label, legacyTreatment?.mood].filter(Boolean).join(", ") || "clear",
      ...(suggestedPin && suggestedPin.version === preflight?.suggestedTreatmentPresetVersion
        ? { treatmentPin: suggestedPin }
        : {}),
    },
    suggestedTreatment: suggestedPin ? {
      ...suggestedPin,
      label: treatmentPresetThaiLabel(suggestedPin),
      rationale: preflight?.treatmentRecommendationRationale ?? "",
    } : null,
    rankedTreatmentPresetIds,
    existingImageCount: preflight?.visualBeats.filter((beat) => Boolean(beat.existingAssetUrl)).length ?? 0,
  };
}

function confirmation(existingImageCount: number) {
  return lookChangeConfirmation(existingImageCount, HERO_AI_IMAGE_CREDITS);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandVisualRecoveryUser();
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const hasPersistedVisualPin = await projectHasPersistedVisualPin({
      userId: auth.user.id,
      projectId: id,
    });
    if (!auth.access.canUse && !hasPersistedVisualPin) return brandVisualLockedResponse(auth.access);
    const requestedPreflightId = new URL(req.url).searchParams.get("preflightId")?.trim() || undefined;
    const state = await currentVisualState(auth.user.id, id, requestedPreflightId);
    const context = await resolveProjectVisualContext({ userId: auth.user.id, projectId: id, suggested: state.suggested });
    const projectSelection = await prisma.editorProject.findFirst({
      where: { id, userId: auth.user.id },
      select: {
        brandProfileRevision: {
          select: {
            id: true,
            version: true,
            brandProfile: { select: { id: true, name: true } },
          },
        },
      },
    });
    const reusableAiSceneIndices = state.preflight
      ? await reusableProjectVisualBeatSceneIndices({
          userId: auth.user.id,
          projectId: id,
          preflightId: state.preflight.id,
        })
      : [];
    const outdatedImageCount = state.preflight?.visualBeats.filter(
      (beat) => beat.status === "outdated" && Boolean(beat.existingAssetUrl),
    ).length ?? 0;
    return NextResponse.json({
      context,
      suggested: state.preflight ? state.suggested : null,
      suggestedTreatment: state.suggestedTreatment,
      rankedTreatmentPresetIds: state.rankedTreatmentPresetIds,
      treatmentPresets: TREATMENT_PRESETS.map((preset) => ({ id: preset.id, label: preset.thaiLabel })),
      formatRecommendation: parseOptionalJson(state.preflight?.formatRecommendationJson),
      contentDomain: state.preflight?.contentDomain ?? null,
      preflightId: state.preflight?.id ?? null,
      sourceHash: state.preflight?.sourceHash ?? null,
      existingImageCount: state.existingImageCount,
      outdatedImageCount,
      reusableAiSceneIndices,
      preserveEstablishedAiDensity: reusableAiSceneIndices.length > 0 && outdatedImageCount === 0,
      quotedCreditsPerImage: HERO_AI_IMAGE_CREDITS,
      hasPersistedVisualPin,
      // A per-video Project Look can override format/treatment while still
      // inheriting the immutable Brand Revision's visual language. Keep the
      // durable profile pin visible instead of making the creator think the
      // project silently detached from its brand.
      selectedBrandProfile: projectSelection?.brandProfileRevision
        ? {
            profileId: projectSelection.brandProfileRevision.brandProfile.id,
            name: projectSelection.brandProfileRevision.brandProfile.name,
            revisionId: projectSelection.brandProfileRevision.id,
            revisionNumber: projectSelection.brandProfileRevision.version,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof ProjectLookError) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    }
    return apiError({ route: "GET /api/editor-projects/[id]/visual-context", error });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const { id } = await params;
    if (body?.deferTreatmentUntilPreflight === true) {
      const visualFormatId = VISUAL_FORMAT_IDS.find((candidate) => candidate === body?.look?.visualFormatId);
      if (!visualFormatId) {
        return NextResponse.json({ code: "INVALID_LOOK", error: "แนวภาพนี้ไม่อยู่ใน V1" }, { status: 400 });
      }
      const latest = await currentVisualState(auth.user.id, id);
      if (latest.preflight) {
        return NextResponse.json({
          code: "PREFLIGHT_ID_REQUIRED",
          error: "กรุณาโหลดผลวิเคราะห์เนื้อหาเวอร์ชันปัจจุบันก่อนเปลี่ยนแนวภาพ",
          currentPreflightId: latest.preflight.id,
        }, { status: 409 });
      }
      const look = await saveUploadProjectVisualFormatAwaitingPreflight({
        userId: auth.user.id,
        projectId: id,
        visualFormatId,
      });
      await recordTelemetryEvent(auth.user.id, {
        name: "project_look_changed",
        source: "server",
        step: "editor.step2",
        status: "awaiting-upload-transcript",
        properties: {
          projectId: id,
          preflightId: null,
          visualFormatId: look.visualFormatId,
          existingImageCount: 0,
          cohort: auth.access.cohort,
        },
      }).catch(() => {});
      return NextResponse.json({
        look,
        preflightId: null,
        applyMode: null,
        regenerationPlan: null,
      });
    }
    const parsed = projectLookInputSchema.safeParse(body?.look ?? body);
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_LOOK", error: parsed.error.issues[0]?.message }, { status: 400 });
    }
    const requestedPreflightId = typeof body?.preflightId === "string" && body.preflightId.trim()
      ? body.preflightId.trim()
      : undefined;
    if (!requestedPreflightId) {
      const latest = await currentVisualState(auth.user.id, id);
      if (latest.preflight) {
        return NextResponse.json({
          code: "PREFLIGHT_ID_REQUIRED",
          error: "กรุณาโหลดผลวิเคราะห์เนื้อหาเวอร์ชันปัจจุบันก่อนเปลี่ยนแนวภาพ",
          currentPreflightId: latest.preflight.id,
        }, { status: 409 });
      }
    }
    const state = await currentVisualState(auth.user.id, id, requestedPreflightId);
    const applyMode = body?.applyMode;
    if (state.existingImageCount > 0 && applyMode !== "regenerate-all") {
      return NextResponse.json(confirmation(state.existingImageCount), { status: 409 });
    }
    const applied = await applyProjectLook({
      userId: auth.user.id,
      projectId: id,
      preflightId: requestedPreflightId,
      applyMode,
      look: parsed.data,
    });
    const look = applied.look;
    await recordTelemetryEvent(auth.user.id, {
      name: "project_look_changed",
      source: "server",
      step: "editor.step2",
      status: applyMode || "no-existing-images",
      properties: {
        projectId: id,
        preflightId: state.preflight?.id ?? null,
        visualFormatId: look.visualFormatId,
        brandVisualIdentityKey: brandVisualIdentityKey(look),
        brandLookIdentityKey: brandLookIdentityKey(look),
        existingImageCount: state.existingImageCount,
        cohort: auth.access.cohort,
      },
    }).catch(() => {});
    return NextResponse.json({
      look,
      preflightId: state.preflight?.id ?? null,
      applyMode: applyMode ?? null,
      regenerationPlan: applyMode === "regenerate-all" ? {
        imageCount: state.existingImageCount,
        quotedCredits: state.existingImageCount * HERO_AI_IMAGE_CREDITS,
        automatic: false,
      } : null,
    });
  } catch (error) {
    if (error instanceof ProjectLookError) {
      if (error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
        return NextResponse.json(
          confirmation(error.details?.existingImageCount ?? 0),
          { status: 409 },
        );
      }
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "PREFLIGHT_REQUIRED" ? 409 : 400;
      return NextResponse.json({
        code: error.code,
        error: error.message,
        currentPreflightId: error.details?.currentPreflightId,
      }, { status });
    }
    return apiError({ route: "PUT /api/editor-projects/[id]/visual-context", error });
  }
}
