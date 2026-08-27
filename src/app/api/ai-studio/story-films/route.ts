import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import {
  listStoryFilms,
  startStoryFilm,
  StoryFilmError,
} from "@/lib/story-film.server";

export const runtime = "nodejs";

function storyFilmError(error: unknown) {
  if (!(error instanceof StoryFilmError)) return null;
  const status = error.code === "not_found" ? 404
    : error.code === "stale_revision" ? 409
      : error.code === "gate_not_ready" || error.code === "decision_not_allowed" ? 422
        : 400;
  return NextResponse.json({ error: error.code, message: error.message, current: error.current }, { status });
}

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 20);
    return NextResponse.json({ projects: await listStoryFilms(user.id, limit) });
  } catch (error) {
    return apiError({ route: "ai-studio/story-films", error });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const result = await startStoryFilm(user.id, {
      title: typeof body?.title === "string" ? body.title : "",
      idempotencyKey: typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "",
      presentationMode: body?.presentationMode === "presenter_led" ? "presenter_led" : body?.presentationMode === "faceless" ? "faceless" : body?.presentationMode as never,
      sourcePackage: typeof body?.sourcePackage === "string" ? body.sourcePackage : null,
      narrativeSource: typeof body?.narrativeSource === "string" ? body.narrativeSource : "",
      presenterAssetId: typeof body?.presenterAssetId === "string" ? body.presenterAssetId : null,
      narrationProvider: body?.narrationProvider === "elevenlabs" ? "elevenlabs" : "hero_voice",
      narrationVoiceId: typeof body?.narrationVoiceId === "string" ? body.narrationVoiceId : null,
      narrationVoiceSpeed: typeof body?.narrationVoiceSpeed === "number" ? body.narrationVoiceSpeed : null,
      characterProfileId: typeof body?.characterProfileId === "string" ? body.characterProfileId : null,
      characterLookBrief: typeof body?.characterLookBrief === "string" ? body.characterLookBrief : null,
      aspectRatio: typeof body?.aspectRatio === "string" ? body.aspectRatio : undefined,
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    const handled = storyFilmError(error);
    return handled ?? apiError({ route: "ai-studio/story-films", error });
  }
}
