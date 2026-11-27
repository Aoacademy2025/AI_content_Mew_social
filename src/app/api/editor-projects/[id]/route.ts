import { externalMediaContext } from "@/lib/external-media.server";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  archiveEditorProject,
  getEditorProjectWithMediaState,
} from "@/lib/editor-projects";
import { patchEditorProjectForUser } from "@/lib/editor-project-patch";
import { prisma } from "@/lib/prisma";
import { pendingEditForWebResolved } from "@/lib/mcp/pending-edit-draft";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const project = await getEditorProjectWithMediaState(user.id, id);
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // T8 (ADR 0064, G21): surface the agent's unexported draft, scoped to this project's
    // CURRENT base job — skip the extra query in Step 1/2 draft state when activeJobId is null.
    const pendingEditRow = project.activeJobId
      ? await prisma.editorProject.findFirst({
          where: { id, userId: user.id },
          select: { activeJobId: true, pendingEditJson: true, pendingEditRevision: true },
        })
      : null;
    const pendingEdit = pendingEditRow ? await pendingEditForWebResolved(user.id, pendingEditRow) : null;

    const external = project.activeJobId ? await externalMediaContext(user.id, project.activeJobId) : null;
    const sourceDraft = external ? { ...(project.draft ?? {}), brollSource: "external", stockSource: "none" } : project.draft;
    return NextResponse.json({ project: { ...project, draft: sourceDraft, pendingEdit } });
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
    const body: unknown = await req.json().catch(() => ({}));
    return await patchEditorProjectForUser(user.id, id, body);
  } catch (error) {
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
