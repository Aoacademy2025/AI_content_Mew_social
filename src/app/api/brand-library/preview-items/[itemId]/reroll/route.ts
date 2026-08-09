import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { rerollBrandLookPreviewItem } from "@/lib/brand-look-preview.server";
import { admitBrandLookGeneration } from "@/lib/brand-look-preview-admission.server";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { HeroImageGenerationError } from "@/lib/video-hero-image.server";
import { recordTelemetryEvent } from "@/lib/telemetry";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    if (typeof body?.requestId !== "string" || !body.requestId.trim()) {
      return NextResponse.json({ error: "requestId is required" }, { status: 400 });
    }
    const admission = await admitBrandLookGeneration({
      userId: auth.user.id,
      role: auth.user.role,
      imageCount: 1,
      purpose: "reroll",
    });
    if (!admission.ok) {
      return NextResponse.json(admission.body, {
        status: admission.status,
        headers: admission.headers,
      });
    }
    const { itemId } = await params;
    const item = await rerollBrandLookPreviewItem({
      userId: auth.user.id,
      itemId,
      requestId: body.requestId,
    });
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_look_scene_rerolled",
      category: item.status === "completed" ? "performance" : "error",
      source: "server",
      status: item.status,
      durationMs: Date.now() - startedAt,
      properties: { itemId, phase: item.phase, cohort: auth.access.cohort },
    }).catch(() => {});
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof HeroImageGenerationError && error.status === 402) {
      return NextResponse.json({
        error: error.code === "ALLOWANCE_EXHAUSTED" ? "allowance_exhausted" : "INSUFFICIENT_CREDITS",
        code: error.code,
        message: error.message,
        upgradeUrl: "/pricing",
      }, { status: 402 });
    }
    return apiError({ route: "POST /api/brand-library/preview-items/[itemId]/reroll", error });
  }
}
