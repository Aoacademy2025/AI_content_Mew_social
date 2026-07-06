import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { createEditorProject, listEditorProjects } from "@/lib/editor-projects";

function projectError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === "draft_too_large") {
    return NextResponse.json({ error: "draft_too_large", message: "project draft ใหญ่เกิน 2 MB" }, { status: 413 });
  }
  return null;
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const includeArchived = searchParams.get("includeArchived") === "1";
    const projects = await listEditorProjects(user.id, { includeArchived });
    return NextResponse.json({ projects });
  } catch (error) {
    console.error("[api/editor-projects] list error:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const project = await createEditorProject(user.id, {
      title: body?.title,
      draft: body?.draft ?? body?.draftJson,
      status: body?.status,
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    const handled = projectError(error);
    if (handled) return handled;
    console.error("[api/editor-projects] create error:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
