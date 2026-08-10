import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  getBrandLookPreviewByRequestId,
  parseBrandLookPreviewRequestId,
  prepareBrandLookPreview,
  resumeBrandLookPreviewByRequestId,
} from "@/lib/brand-look-preview.server";
import { admitBrandLookGeneration } from "@/lib/brand-look-preview-admission.server";
import {
  brandVisualLockedResponse,
  requireBrandVisualRecoveryUser,
} from "@/lib/brand-visual-access.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { HeroImageGenerationError } from "@/lib/video-hero-image.server";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualRecoveryUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => ({}));
    const requestId = parseBrandLookPreviewRequestId(body?.requestId);
    if (!requestId) {
      return NextResponse.json({ code: "INVALID_REQUEST_ID", error: "requestId is required" }, { status: 400 });
    }
    const replay = await getBrandLookPreviewByRequestId({ userId: auth.user.id, requestId });
    if (replay) {
      const batch = ["completed", "partial", "failed"].includes(replay.status)
        ? replay
        : await resumeBrandLookPreviewByRequestId({ userId: auth.user.id, requestId }) ?? replay;
      const generatedCount = batch.items.filter((item) => item.sourceType === "generated" && item.status === "completed").length;
      const reusedCount = batch.items.filter((item) => item.sourceType === "reused").length;
      return NextResponse.json({ batch, generatedCount, reusedCount, replayed: true });
    }
    if (!auth.access.canUse) return brandVisualLockedResponse();
    const projectId = typeof body?.projectId === "string" ? body.projectId : undefined;
    const preflightId = typeof body?.preflightId === "string" && body.preflightId.trim()
      ? body.preflightId.trim()
      : undefined;
    const { id } = await params;
    const prepared = await prepareBrandLookPreview({
      userId: auth.user.id,
      requestId,
      projectId,
      preflightId,
      profileId: id,
      useDraft: body?.useDraft === true,
    });
    const generationCount = prepared.generationCount;
    if (generationCount > 0) {
      const admission = await admitBrandLookGeneration({
        userId: auth.user.id,
        role: auth.user.role,
        imageCount: generationCount,
        purpose: "preview",
      });
      if (!admission.ok) {
        return NextResponse.json(admission.body, {
          status: admission.status,
          headers: admission.headers,
        });
      }
    }
    const batch = await prepared.materialize();
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
