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
  body: unknown,
): Promise<NextResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  const fields = body as Record<string, unknown>;
  try {
    const project = await updateEditorProject(userId, id, {
      ...(Object.prototype.hasOwnProperty.call(fields, "title") ? { title: fields.title } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "draft") ? { draft: fields.draft } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "draftJson") ? { draft: fields.draftJson } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "draftRevision")
        ? { draftRevision: fields.draftRevision }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "expectedDraftRevision")
        ? { expectedDraftRevision: fields.expectedDraftRevision }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "status") ? { status: fields.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "activeJobId")
        ? { activeJobId: fields.activeJobId }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "activeExportJobId")
        ? { activeExportJobId: fields.activeExportJobId }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "latestVideoId")
        ? { latestVideoId: fields.latestVideoId }
        : {}),
      ...(fields.touchLastOpened === true ? { touchLastOpened: true } : {}),
    });
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    const handled = projectError(error);
    if (handled) return handled;
    throw error;
  }
}
