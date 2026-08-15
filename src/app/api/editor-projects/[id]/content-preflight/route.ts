import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  brandVisualLockedResponse,
  requireBrandVisualRecoveryUser,
} from "@/lib/brand-visual-access.server";
import {
  ContentPreflightError,
  createGeminiContentPreflightAnalyzer,
  resolveContentPreflight,
  type NarrativeSourceKind,
} from "@/lib/content-preflight.server";
import { projectHasPersistedVisualPin } from "@/lib/project-look.server";
import {
  sceneContentPolicyFromPreference,
  sceneContentPolicyIdentity,
} from "@/lib/scene-content-policy";
import { recordTelemetryEvent } from "@/lib/telemetry";

const SOURCE_KINDS = new Set<NarrativeSourceKind>([
  "ai-script",
  "creator-script",
  "upload-transcript",
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  try {
    const auth = await requireBrandVisualRecoveryUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const kind = body?.narrativeSource?.kind;
    const text = body?.narrativeSource?.text;
    if (!SOURCE_KINDS.has(kind) || typeof text !== "string") {
      return NextResponse.json({ code: "INVALID_SOURCE", error: "Narrative Source ไม่ถูกต้อง" }, { status: 400 });
    }
    const { id } = await params;
    const hasPersistedVisualPin = await projectHasPersistedVisualPin({
      userId: auth.user.id,
      projectId: id,
    });
    if (!auth.access.canUse && !hasPersistedVisualPin) return brandVisualLockedResponse(auth.access);
    const rawWindowCount = body?.narrativeSource?.windowCount;
    const windowCount = Number.isFinite(rawWindowCount) && rawWindowCount > 0
      ? Math.min(60, Math.floor(rawWindowCount))
      : undefined;
    const previousPreflightId = typeof body?.previousPreflightId === "string"
      && body.previousPreflightId.trim()
      ? body.previousPreflightId.trim()
      : undefined;
    const sceneContentPolicy = sceneContentPolicyFromPreference(
      body?.narrativeSource?.sceneContentPolicy ?? body?.brollRegionPreference,
    );
    const preflight = await resolveContentPreflight({
      userId: auth.user.id,
      projectId: id,
      previousPreflightId,
      narrativeSource: {
        kind,
        text,
        ...(windowCount ? { windowCount } : {}),
        sceneContentPolicy,
      },
      // Rollback keeps exact cached analyses readable for already-pinned
      // projects but never launches new Gemini work after admission closes.
      analyzer: auth.access.canUse
        ? createGeminiContentPreflightAnalyzer(auth.user.id)
        : undefined,
    });
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_visual_preflight_resolved",
      category: "performance",
      source: "server",
      step: "editor.step2",
      status: preflight.cached ? "cached" : "analyzed",
      durationMs: Date.now() - startedAt,
      properties: {
        projectId: id,
        preflightId: preflight.id,
        sourceKind: kind,
        visualFormatId: preflight.suggestedVisualFormatId,
        beatCount: preflight.visualBeats.length,
        sceneContentPolicy: sceneContentPolicyIdentity(sceneContentPolicy),
        policyWarningCount: preflight.policyWarnings.length,
        cohort: auth.access.cohort,
      },
    }).catch(() => {});
    return NextResponse.json({ preflight });
  } catch (error) {
    if (error instanceof ContentPreflightError) {
      const status = error.code === "NOT_FOUND" ? 404
        : error.code === "KEY_REQUIRED" || error.code === "ANALYZER_UNAVAILABLE" ? 409
          : error.code === "TEXT_QUOTA" ? 429
            : error.code === "INVALID_ANALYSIS" ? 502 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return apiError({ route: "POST /api/editor-projects/[id]/content-preflight", error });
  }
}
