import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireHeroScriptUser, sendScriptToEditor } from "@/lib/hero-script.server";

// POST /api/scripts/[id]/send-to-editor — the Hero Script step-5 handoff.
//
// Paid plans: creates an EditorProject seeded with the assembled script (blank
// lines stripped — the editor treats 1 line = 1 Segment), marks the Script
// "sent" and returns { projectId } for /video-editor?projectId=…
// FREE (allowVideoEditor: false): 403 EDITOR_LOCKED + the Thai upsell copy.
//
// All the logic lives in sendScriptToEditor (service layer, ownership-scoped);
// this handler only maps its result codes onto HTTP statuses.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;
    const { id } = await params;

    const result = await sendScriptToEditor(authUser.id, id);
    if (result.ok) return NextResponse.json({ projectId: result.projectId });

    const status = result.code === "NOT_FOUND" ? 404 : result.code === "EDITOR_LOCKED" ? 403 : 400;
    return NextResponse.json({ code: result.code, error: result.message }, { status });
  } catch (error) {
    return apiError({ route: "POST /api/scripts/[id]/send-to-editor", error });
  }
}
