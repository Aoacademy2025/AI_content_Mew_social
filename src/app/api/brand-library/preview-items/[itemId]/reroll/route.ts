import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  getBrandLookPreviewRerollReplay,
  parseBrandLookPreviewRequestId,
  rerollBrandLookPreviewItem,
} from "@/lib/brand-look-preview.server";
import { admitBrandLookGeneration } from "@/lib/brand-look-preview-admission.server";
import {
  brandVisualLockedResponse,
  requireBrandVisualRecoveryUser,
} from "@/lib/brand-visual-access.server";
import { HeroImageGenerationError } from "@/lib/video-hero-image.server";
import { recordTelemetryEvent } from "@/lib/telemetry";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function GET(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth.response;
  const requestId = parseBrandLookPreviewRequestId(new URL(req.url).searchParams.get("requestId"));
  if (!requestId) {
    return NextResponse.json({ code: "INVALID_REQUEST_ID", error: "requestId is required" }, { status: 400 });
  }
  const { itemId } = await params;
  const item = await getBrandLookPreviewRerollReplay({ userId: auth.user.id, itemId, requestId });
  return item
    ? NextResponse.json({ item, replayed: true })
    : NextResponse.json({ code: "REROLL_NOT_FOUND", error: "Reroll request not found" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualRecoveryUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const requestId = parseBrandLookPreviewRequestId(body?.requestId);
    if (!requestId) {
      return NextResponse.json({ code: "INVALID_REQUEST_ID", error: "requestId is required" }, { status: 400 });
    }
    const { itemId } = await params;
    const replay = await getBrandLookPreviewRerollReplay({ userId: auth.user.id, itemId, requestId });
    if (replay) {
      return NextResponse.json({ item: replay, replayed: true });
    }
    if (!auth.access.canUse) return brandVisualLockedResponse(auth.access);
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
    const item = await rerollBrandLookPreviewItem({
      userId: auth.user.id,
      itemId,
      requestId,
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
    if (error instanceof HeroImageGenerationError && error.status === 429) {
      return NextResponse.json({
        error: "rate_limited",
        code: "RATE_LIMITED",
        message: error.message,
        retryable: true,
      }, { status: 429 });
    }
    return apiError({ route: "POST /api/brand-library/preview-items/[itemId]/reroll", error });
  }
}
