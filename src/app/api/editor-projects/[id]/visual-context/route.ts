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
  ProjectLookError,
  applyProjectLook,
  projectHasPersistedVisualPin,
  projectLookInputSchema,
  reusableProjectVisualBeatSceneIndices,
  resolveProjectVisualContext,
} from "@/lib/project-look.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { brandLookIdentityKey, brandVisualIdentityKey, type VisualFormatId } from "@/lib/brand-visual-system";

async function currentVisualState(userId: string, projectId: string, preflightId?: string) {
  const preflight = await prisma.contentPreflight.findFirst({
    where: { userId, projectId, ...(preflightId ? { id: preflightId } : {}) },
    orderBy: preflightId ? undefined : { createdAt: "desc" },
    include: { visualBeats: { orderBy: { sequence: "asc" } } },
  });
  if (preflightId && !preflight) {
    throw new ProjectLookError("NOT_FOUND", "ไม่พบข้อมูลฉากชุดนี้");
  }
  const treatment = preflight
    ? JSON.parse(preflight.suggestedTreatmentJson) as { label?: string; mood?: string }
    : null;
  return {
    preflight,
    suggested: {
      visualFormatId: (preflight?.suggestedVisualFormatId ?? "clear-infographic") as VisualFormatId,
      treatment: [treatment?.label, treatment?.mood].filter(Boolean).join(", ") || "clear",
    },
    existingImageCount: preflight?.visualBeats.filter((beat) => Boolean(beat.existingAssetUrl)).length ?? 0,
  };
}

function confirmation(existingImageCount: number) {
  return {
    code: "LOOK_CHANGE_CONFIRMATION_REQUIRED",
    existingImageCount,
    quotedCredits: existingImageCount * HERO_AI_IMAGE_CREDITS,
    options: [
      { id: "regenerate-all", label: "สร้างทุกภาพใหม่ให้เป็นแนวเดียวกัน" },
      { id: "new-only", label: "ใช้แนวใหม่เฉพาะภาพที่สร้างต่อจากนี้", warning: "คลิปจะมีมากกว่าหนึ่งแนวภาพ" },
    ],
  };
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
    if (!auth.access.canUse && !hasPersistedVisualPin) return brandVisualLockedResponse();
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
    const parsed = projectLookInputSchema.safeParse(body?.look ?? body);
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_LOOK", error: parsed.error.issues[0]?.message }, { status: 400 });
    }
    const { id } = await params;
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
    if (state.existingImageCount > 0 && applyMode !== "new-only" && applyMode !== "regenerate-all") {
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
      mixedLookWarning: applyMode === "new-only" && state.existingImageCount > 0,
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
