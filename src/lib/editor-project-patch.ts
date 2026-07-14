import { NextResponse } from "next/server";
import { updateEditorProject } from "@/lib/editor-projects";

function projectError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === "draft_too_large") {
    return NextResponse.json(
      { error: "draft_too_large", message: "project draft ใหญ่เกิน 2 MB" },
      { status: 413 },
    );
  }
  if (code === "invalid_status") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (code === "no_fields") {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  if (code === "invalid_draft_revision") {
    return NextResponse.json({ error: "invalid_draft_revision" }, { status: 400 });
  }
  if (code === "stale_revision") {
    return NextResponse.json(
      { error: "stale_revision", project: (error as { project?: unknown }).project ?? null },
      { status: 409 },
    );
  }
  return null;
}

export async function patchEditorProjectForUser(
  userId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  try {
    const project = await updateEditorProject(userId, id, {
      ...(Object.prototype.hasOwnProperty.call(body, "title") ? { title: body.title } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "draft") ? { draft: body.draft } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "draftJson") ? { draft: body.draftJson } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "draftRevision")
        ? { draftRevision: body.draftRevision }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "activeJobId")
        ? { activeJobId: body.activeJobId }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "activeExportJobId")
        ? { activeExportJobId: body.activeExportJobId }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "latestVideoId")
        ? { latestVideoId: body.latestVideoId }
        : {}),
      ...(body.touchLastOpened === true ? { touchLastOpened: true } : {}),
    });
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    const handled = projectError(error);
    if (handled) return handled;
    throw error;
  }
}
