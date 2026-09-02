import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { brandLookPreviewGenerationCount } from "@/lib/brand-look-preview.server";
import { brandProfilePayloadSchema } from "@/lib/brand-profile-library.server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** Read-only quote for the current draft. The generation endpoint prepares
 * and admits its own exact snapshot again; this endpoint exists only so the UI
 * can disclose and gate the actual 0–3 missing images instead of guessing. */
export async function POST(req: Request) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const payload = brandProfilePayloadSchema.safeParse(body?.payload);
    if (!payload.success) {
      return NextResponse.json({
        code: "INVALID_DRAFT",
        error: payload.error.issues[0]?.message || "ข้อมูลแบรนด์ไม่ครบ",
      }, { status: 400 });
    }
    const projectId = typeof body?.projectId === "string" && body.projectId.trim()
      ? body.projectId.trim()
      : undefined;
    const preflightId = typeof body?.preflightId === "string" && body.preflightId.trim()
      ? body.preflightId.trim()
      : undefined;
    const profileId = typeof body?.profileId === "string" && body.profileId.trim()
      ? body.profileId.trim()
      : undefined;
    const useDraft = body?.useDraft === true;
    if (profileId) {
      // brandLookPreviewGenerationCount answers the safe worst case for a
      // profile it cannot resolve, so this endpoint owns the ownership check.
      // Missing, archived and someone else's all answer with the same code, so
      // a quote can never confirm that another creator's library exists.
      const profile = await prisma.brandProfile.findFirst({
        where: { id: profileId, userId: auth.user.id, archivedAt: null },
        select: { id: true },
      });
      if (!profile) {
        return NextResponse.json({
          code: "PROFILE_NOT_FOUND",
          error: "ไม่พบชุดแบรนด์นี้",
        }, { status: 404 });
      }
    }
    const generationCount = await brandLookPreviewGenerationCount({
      userId: auth.user.id,
      projectId,
      preflightId,
      payload: payload.data,
      profileId,
      useDraft,
    });
    return NextResponse.json({
      generationCount,
      reusedCount: 3 - generationCount,
      credits: generationCount * 2,
    });
  } catch (error) {
    return apiError({ route: "POST /api/brand-library/preview-quote", error });
  }
}
