import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { readStoryFilm } from "@/lib/story-film.server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isInternalAiTester(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { id } = await params;
    const result = await readStoryFilm(user.id, { projectId: id });
    if (result.kind === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "ai-studio/story-films/[id]", error });
  }
}
