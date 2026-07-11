import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  archiveEditorProject,
  getEditorProjectWithMediaState,
  updateEditorProject,
} from "@/lib/editor-projects";

function projectError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === "draft_too_large") {
    return NextResponse.json({ error: "draft_too_large", message: "project draft ใหญ่เกิน 2 MB" }, { status: 413 });
  }
  if (code === "invalid_status") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (code === "no_fields") {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const project = await getEditorProjectWithMediaState(user.id, id);
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    console.error("[api/editor-projects/:id] get error:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const project = await updateEditorProject(user.id, id, {
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "title") ? { title: body.title } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "draft") ? { draft: body.draft } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "draftJson") ? { draft: body.draftJson } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "status") ? { status: body.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "activeJobId") ? { activeJobId: body.activeJobId } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "activeExportJobId") ? { activeExportJobId: body.activeExportJobId } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, "latestVideoId") ? { latestVideoId: body.latestVideoId } : {}),
      ...(body?.touchLastOpened === true ? { touchLastOpened: true } : {}),
    });
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    const handled = projectError(error);
    if (handled) return handled;
    console.error("[api/editor-projects/:id] patch error:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const ok = await archiveEditorProject(user.id, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/editor-projects/:id] delete error:", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
