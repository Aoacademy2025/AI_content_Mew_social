import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import {
  decideStoryFilm,
  StoryFilmError,
  type StoryFilmDecisionKind,
  type StoryFilmStage,
} from "@/lib/story-film.server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const project = await decideStoryFilm(user.id, {
      projectId: id,
      expectedStage: body?.expectedStage as StoryFilmStage,
      expectedRevision: Number(body?.expectedRevision),
      decision: body?.decision as StoryFilmDecisionKind,
      instruction: typeof body?.instruction === "string" ? body.instruction : null,
      target: body?.target && typeof body.target === "object" && !Array.isArray(body.target)
        ? body.target as Record<string, unknown>
        : null,
      idempotencyKey: typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null,
    });
    return NextResponse.json({ project });
  } catch (error) {
    if (error instanceof StoryFilmError) {
      const status = error.code === "not_found" ? 404
        : error.code === "stale_revision" ? 409
          : error.code === "gate_not_ready" || error.code === "decision_not_allowed" ? 422
            : 400;
      return NextResponse.json({ error: error.code, message: error.message, current: error.current }, { status });
    }
    return apiError({ route: "ai-studio/story-films/[id]/decisions", error });
  }
}
