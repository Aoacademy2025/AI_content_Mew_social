import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import {
  createStoryFilmCharacterProfile,
  listStoryFilmCharacterProfiles,
} from "@/lib/story-film-character.server";
import { StoryFilmError } from "@/lib/story-film.server";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ characters: await listStoryFilmCharacterProfiles(user.id) });
  } catch (error) {
    return apiError({ route: "ai-studio/story-film-characters", error });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const character = await createStoryFilmCharacterProfile(user.id, {
      name: typeof body?.name === "string" ? body.name : "",
      identityNotes: typeof body?.identityNotes === "string" ? body.identityNotes : null,
    });
    return NextResponse.json({ character }, { status: 201 });
  } catch (error) {
    if (error instanceof StoryFilmError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    }
    return apiError({ route: "ai-studio/story-film-characters", error });
  }
}
