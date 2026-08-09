import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { BrandProfileLibraryError, pinProjectBrandRevision } from "@/lib/brand-profile-library.server";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { prisma } from "@/lib/prisma";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { brandVisualIdentityKey, type BrandVisualLanguage, type VisualFormatId } from "@/lib/brand-visual-system";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    if (typeof body?.profileId !== "string") {
      return NextResponse.json({ code: "INVALID_PROFILE", error: "กรุณาเลือกแบรนด์" }, { status: 400 });
    }
    const { id } = await params;
    const preflight = await prisma.contentPreflight.findFirst({
      where: { projectId: id, userId: auth.user.id },
      orderBy: { createdAt: "desc" },
      include: { visualBeats: true },
    });
    const existingImageCount = preflight?.visualBeats.filter((beat) => Boolean(beat.existingAssetUrl)).length ?? 0;
    const applyMode = body?.applyMode;
    if (existingImageCount > 0 && applyMode !== "new-only" && applyMode !== "regenerate-all") {
      return NextResponse.json({
        code: "LOOK_CHANGE_CONFIRMATION_REQUIRED",
        existingImageCount,
        quotedCredits: existingImageCount * HERO_AI_IMAGE_CREDITS,
      }, { status: 409 });
    }
    const pinned = await pinProjectBrandRevision({
      userId: auth.user.id,
      projectId: id,
      profileId: body.profileId,
      revisionId: typeof body.revisionId === "string" ? body.revisionId : undefined,
    });
    if (applyMode === "regenerate-all" && preflight) {
      await prisma.projectVisualBeat.updateMany({
        where: { preflightId: preflight.id, existingAssetUrl: { not: null } },
        data: { status: "outdated", outdatedAt: new Date() },
      });
    }
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
        profileId: body.profileId,
        revisionId: pinned.project.brandProfileRevisionId,
        visualFormatId: visualRecipe.visualFormatId,
        brandVisualIdentityKey: brandVisualIdentityKey({
          visualFormatId: visualRecipe.visualFormatId,
          recipeVersion: visualRecipe.recipeVersion,
          treatment: visualRecipe.defaultTreatment,
          brandVisualLanguage: visualRecipe.brandVisualLanguage ?? null,
        }),
        cohort: auth.access.cohort,
      },
    }).catch(() => {});
    return NextResponse.json({
      projectId: pinned.project.id,
      revisionId: pinned.project.brandProfileRevisionId,
      revisionDefaults: JSON.parse(pinned.revision.payloadJson) as unknown,
      applyMode: applyMode ?? null,
      regenerationPlan: applyMode === "regenerate-all" ? {
        imageCount: existingImageCount,
        quotedCredits: existingImageCount * HERO_AI_IMAGE_CREDITS,
        automatic: false,
      } : null,
      mixedLookWarning: applyMode === "new-only" && existingImageCount > 0,
    });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      const status = error.code === "NOT_FOUND" || error.code === "NO_REVISION" ? 404 : error.code === "FROZEN" ? 403 : 409;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return apiError({ route: "PUT /api/editor-projects/[id]/brand-revision", error });
  }
}
