import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandLibraryUser } from "@/lib/brand-visual-access.server";
import { pinAdmissionFromDecision } from "@/lib/brand-visual-pin-admission";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { BrandProfileLibraryError, applyProjectBrandRevision } from "@/lib/brand-profile-library.server";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { brandLookIdentityKey, brandVisualIdentityKey, type BrandVisualLanguage, type VisualFormatId } from "@/lib/brand-visual-system";
import { editorProjectResponse } from "@/lib/editor-projects";
import { lookChangeConfirmation } from "@/lib/brand-treatment-presentation";

/** Pinning a Brand Revision to a project is a LIBRARY action for every plan
 * (ADR 0059 + its 2026-09-02 amendment, wave 1b D1): the pin styles free stock
 * B-roll, subtitles, voice, logo and pacing at zero marginal cost. What it must
 * not hand out is the AI-image grandfather clause, and it cannot: the pin
 * carries the IMAGE decision resolved here, and only an ADMITTED stamp
 * grandfathers anything (#430). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandLibraryUser();
    if (!auth.ok) return auth.response;
    // The guard above authorises the LIBRARY. The stamp must be the IMAGE
    // decision, resolved separately — stamping the guard's own decision would
    // admit every plan and reopen #430.
    const imageAccess = await resolveBrandVisualAccess(auth.user);
    const body = await req.json().catch(() => null);
    if (typeof body?.profileId !== "string") {
      return NextResponse.json({ code: "INVALID_PROFILE", error: "กรุณาเลือกแบรนด์" }, { status: 400 });
    }
    const { id } = await params;
    const requestedPreflightId = typeof body?.preflightId === "string" && body.preflightId.trim()
      ? body.preflightId.trim()
      : undefined;
    const preflight = await prisma.contentPreflight.findFirst({
      where: {
        projectId: id,
        userId: auth.user.id,
        ...(requestedPreflightId ? { id: requestedPreflightId } : {}),
      },
      orderBy: requestedPreflightId ? undefined : { createdAt: "desc" },
      include: { visualBeats: true },
    });
    if (requestedPreflightId && !preflight) {
      return NextResponse.json({ code: "PREFLIGHT_NOT_FOUND", error: "ไม่พบข้อมูลฉากชุดนี้" }, { status: 404 });
    }
    if (!requestedPreflightId && preflight) {
      return NextResponse.json({
        code: "PREFLIGHT_ID_REQUIRED",
        error: "กรุณาโหลดผลวิเคราะห์เนื้อหาเวอร์ชันปัจจุบันก่อนเลือกแบรนด์",
        currentPreflightId: preflight.id,
      }, { status: 409 });
    }
    const existingImageCount = preflight?.visualBeats.filter((beat) => Boolean(beat.existingAssetUrl)).length ?? 0;
    const applyMode = body?.applyMode;
    if (existingImageCount > 0 && applyMode !== "regenerate-all") {
      return NextResponse.json(
        lookChangeConfirmation(existingImageCount, HERO_AI_IMAGE_CREDITS),
        { status: 409 },
      );
    }
    const pinned = await applyProjectBrandRevision({
      userId: auth.user.id,
      projectId: id,
      profileId: body.profileId,
      revisionId: typeof body.revisionId === "string" ? body.revisionId : undefined,
      preflightId: requestedPreflightId,
      applyMode,
      // The IMAGE decision resolved above is recorded ON the pin, so the
      // render-time grandfather clause can only honour an admitted one.
      admission: pinAdmissionFromDecision(imageAccess),
    });
    const visualRecipe = JSON.parse(pinned.revision.visualRecipeJson) as {
      visualFormatId: VisualFormatId;
      recipeVersion: string;
      defaultTreatment: string;
      brandVisualLanguage?: BrandVisualLanguage | null;
    };
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_profile_pinned",
      source: "server",
      step: "editor.step2",
      status: applyMode || "no-existing-images",
      properties: {
        projectId: id,
        preflightId: preflight?.id ?? null,
        profileId: body.profileId,
        revisionId: pinned.project.brandProfileRevisionId,
        visualFormatId: visualRecipe.visualFormatId,
        brandVisualIdentityKey: pinned.generationIdentityKey ?? brandVisualIdentityKey({
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
        cohort: imageAccess.cohort,
      },
    }).catch(() => {});
    return NextResponse.json({
      projectId: pinned.project.id,
      project: editorProjectResponse(pinned.project),
      preflightId: preflight?.id ?? null,
      revisionId: pinned.project.brandProfileRevisionId,
      revisionDefaults: JSON.parse(pinned.revision.payloadJson) as unknown,
      applyMode: applyMode ?? null,
      regenerationPlan: applyMode === "regenerate-all" ? {
        imageCount: existingImageCount,
        quotedCredits: existingImageCount * HERO_AI_IMAGE_CREDITS,
        automatic: false,
      } : null,
    });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      if (error.code === "LOOK_CHANGE_CONFIRMATION_REQUIRED") {
        const existingImageCount = error.details?.existingImageCount ?? 0;
        return NextResponse.json(
          lookChangeConfirmation(existingImageCount, HERO_AI_IMAGE_CREDITS),
          { status: 409 },
        );
      }
      const status = error.code === "NOT_FOUND" || error.code === "NO_REVISION"
        ? 404
        : error.code === "FROZEN" ? 403 : 409;
      return NextResponse.json({
        code: error.code,
        error: error.message,
        currentPreflightId: error.details?.currentPreflightId,
      }, { status });
    }
    return apiError({ route: "PUT /api/editor-projects/[id]/brand-revision", error });
  }
}
