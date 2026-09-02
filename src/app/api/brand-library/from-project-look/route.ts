import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import {
  BrandProfileLibraryError,
  brandProfilePayloadSchema,
  promoteCompletedVideoJobToBrandProfile,
  promoteProjectLookToBrandProfile,
} from "@/lib/brand-profile-library.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { getStarterAiImageAllowanceStatus } from "@/lib/starter-ai-image-allowance.server";
import {
  brandLookIdentityKey,
  brandVisualIdentityKey,
  type BrandVisualLanguage,
  type VisualFormatId,
} from "@/lib/brand-visual-system";

function libraryError(error: unknown) {
  if (!(error instanceof BrandProfileLibraryError)) return null;
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "PREFERRED_REQUIRED" || error.code === "FROZEN" ? 403
      : error.code === "REVISION_CONFLICT" || error.code === "RESULT_REQUIRED" ? 409 : 400;
  return NextResponse.json({ code: error.code, error: error.message }, { status });
}

/** Atomic Project Look -> Brand Revision promotion. It also writes the project
 * pin, so it keeps the IMAGE guard for the same reason as `brand-revision`
 * (ADR 0059 amendment). The exact immutable
 * preflight is always required; a completed VideoJob additionally proves which
 * rendered clip the post-result CTA came from. Both identities are durable
 * replay keys in BrandProfileRevision. */
export async function POST(req: Request) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
    const preflightId = typeof body?.preflightId === "string" ? body.preflightId.trim() : "";
    const videoJobId = typeof body?.videoJobId === "string" ? body.videoJobId.trim() : "";
    const payload = brandProfilePayloadSchema.safeParse(body?.payload);
    if (!projectId || !preflightId || !payload.success) {
      return NextResponse.json({
        code: "INVALID_PROMOTION",
        error: payload.success
          ? "ไม่พบโปรเจกต์หรือข้อมูลฉากที่ต้องการบันทึก"
          : payload.error.issues[0]?.message || "ข้อมูลแบรนด์ไม่ครบ",
      }, { status: 400 });
    }
    if (!videoJobId) {
      const starter = await getStarterAiImageAllowanceStatus(auth.user.id);
      if (starter.eligible) {
        return NextResponse.json({
          code: "RESULT_REQUIRED",
          error: "สร้างคลิปให้เสร็จก่อน แล้วจึงบันทึกแนวภาพนี้เป็นแบรนด์ได้",
        }, { status: 409 });
      }
    }

    const promoted = videoJobId
      ? await promoteCompletedVideoJobToBrandProfile({
          userId: auth.user.id,
          projectId,
          preflightId,
          videoJobId,
          payload: payload.data,
        })
      : await promoteProjectLookToBrandProfile({
          userId: auth.user.id,
          projectId,
          preflightId,
          payload: payload.data,
        });
    const visualRecipe = JSON.parse(promoted.revision.visualRecipeJson) as {
      visualFormatId: VisualFormatId;
      recipeVersion: string;
      defaultTreatment: string;
      brandVisualLanguage?: BrandVisualLanguage | null;
    };

    await recordTelemetryEvent(auth.user.id, {
      name: "brand_profile_saved",
      source: "server",
      status: promoted.replayed ? "replayed" : "created-and-pinned",
      properties: {
        profileId: promoted.profile.id,
        revisionId: promoted.revision.id,
        revision: promoted.revision.version,
        projectId,
        preflightId,
        videoJobId: videoJobId || null,
        cohort: auth.access.cohort,
        visualFormatId: visualRecipe.visualFormatId,
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
      profileId: promoted.profile.id,
      revisionId: promoted.revision.id,
      revision: promoted.revision.version,
      projectId,
      preflightId,
      replayed: promoted.replayed,
    }, { status: promoted.replayed ? 200 : 201 });
  } catch (error) {
    const handled = libraryError(error);
    if (handled) return handled;
    return apiError({ route: "POST /api/brand-library/from-project-look", error });
  }
}
