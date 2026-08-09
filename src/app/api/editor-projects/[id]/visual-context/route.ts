import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { prisma } from "@/lib/prisma";
import {
  ProjectLookError,
  projectLookInputSchema,
  resolveProjectVisualContext,
  saveProjectLook,
} from "@/lib/project-look.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { brandVisualIdentityKey, type VisualFormatId } from "@/lib/brand-visual-system";

async function currentVisualState(userId: string, projectId: string) {
  const preflight = await prisma.contentPreflight.findFirst({
    where: { userId, projectId },
    orderBy: { createdAt: "desc" },
    include: { visualBeats: { orderBy: { sequence: "asc" } } },
  });
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const state = await currentVisualState(auth.user.id, id);
    const context = await resolveProjectVisualContext({ userId: auth.user.id, projectId: id, suggested: state.suggested });
    return NextResponse.json({
      context,
      suggested: state.preflight ? state.suggested : null,
      contentDomain: state.preflight?.contentDomain ?? null,
      existingImageCount: state.existingImageCount,
      outdatedImageCount: state.preflight?.visualBeats.filter((beat) => beat.status === "outdated").length ?? 0,
      quotedCreditsPerImage: HERO_AI_IMAGE_CREDITS,
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
    const state = await currentVisualState(auth.user.id, id);
    const applyMode = body?.applyMode;
    if (state.existingImageCount > 0 && applyMode !== "new-only" && applyMode !== "regenerate-all") {
      return NextResponse.json(confirmation(state.existingImageCount), { status: 409 });
    }
    const look = await saveProjectLook({ userId: auth.user.id, projectId: id, look: parsed.data });
    if (applyMode === "regenerate-all" && state.preflight) {
      await prisma.projectVisualBeat.updateMany({
        where: { preflightId: state.preflight.id, existingAssetUrl: { not: null } },
        data: { status: "outdated", outdatedAt: new Date() },
      });
    }
    await recordTelemetryEvent(auth.user.id, {
      name: "project_look_changed",
      source: "server",
      step: "editor.step2",
      status: applyMode || "no-existing-images",
      properties: {
        projectId: id,
        visualFormatId: look.visualFormatId,
        brandVisualIdentityKey: brandVisualIdentityKey(look),
        existingImageCount: state.existingImageCount,
        cohort: auth.access.cohort,
      },
    }).catch(() => {});
    return NextResponse.json({
      look,
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
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    }
    return apiError({ route: "PUT /api/editor-projects/[id]/visual-context", error });
  }
}
