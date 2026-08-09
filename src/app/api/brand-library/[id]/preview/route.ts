import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  brandLookPreviewRequiresGeneration,
  createBrandLookPreview,
} from "@/lib/brand-look-preview.server";
import { admitBrandLookGeneration } from "@/lib/brand-look-preview-admission.server";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { HeroImageGenerationError } from "@/lib/video-hero-image.server";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => ({}));
    const projectId = typeof body?.projectId === "string" ? body.projectId : undefined;
    const { id } = await params;
    const generating = await brandLookPreviewRequiresGeneration({
      userId: auth.user.id,
      projectId,
      profileId: id,
      useDraft: body?.useDraft === true,
    });
    if (generating) {
      const admission = await admitBrandLookGeneration({
        userId: auth.user.id,
        role: auth.user.role,
        imageCount: 3,
        purpose: "preview",
      });
      if (!admission.ok) {
        return NextResponse.json(admission.body, {
          status: admission.status,
          headers: admission.headers,
        });
      }
    }
    const batch = await createBrandLookPreview({
      userId: auth.user.id,
      profileId: id,
      projectId,
      useDraft: body?.useDraft === true,
    });
    const generatedCount = batch.items.filter((item) => item.sourceType === "generated" && item.status === "completed").length;
    const reusedCount = batch.items.filter((item) => item.sourceType === "reused").length;
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_look_preview_finished",
      category: "performance",
      source: "server",
      status: batch.status,
      durationMs: Date.now() - startedAt,
      properties: { batchId: batch.id, profileId: id, generatedCount, reusedCount, cohort: auth.access.cohort },
    }).catch(() => {});
    return NextResponse.json({ batch, generatedCount, reusedCount });
  } catch (error) {
    if (error instanceof HeroImageGenerationError && error.status === 402) {
      return NextResponse.json({
        error: error.code === "ALLOWANCE_EXHAUSTED" ? "allowance_exhausted" : "INSUFFICIENT_CREDITS",
        code: error.code,
        message: error.message,
        upgradeUrl: "/pricing",
        stockAction: "use-stock",
      }, { status: 402 });
    }
    return apiError({ route: "POST /api/brand-library/[id]/preview", error });
  }
}
