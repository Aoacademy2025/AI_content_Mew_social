import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import { deleteEditorStylePreset } from "@/lib/editor-style-presets.server";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const deleted = await deleteEditorStylePreset(user.id, id);
    return deleted
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "preset_not_found" }, { status: 404 });
  } catch (error) {
    return apiError({
      route: "DELETE /api/user/editor-style-presets/[id]",
      error,
    });
  }
}
