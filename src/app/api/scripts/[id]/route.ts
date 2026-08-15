import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { isValidHookFormulaKey, isValidStoryStructureKey } from "@/lib/viral-frameworks";
import {
  assembleScript,
  deleteScript,
  getScript,
  isValidDurationSec,
  ownsBrandProfile,
  requireHeroScriptUser,
  updateScript,
  validateTopic,
  type ScriptPatch,
} from "@/lib/hero-script.server";

// GET /api/scripts/[id] — load one script (restore into the step-4 editor).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;
    const { id } = await params;

    const script = await getScript(authUser.id, id);
    if (!script) return NextResponse.json({ error: "ไม่พบสคริปต์" }, { status: 404 });

    return NextResponse.json(script);
  } catch (error) {
    return apiError({ route: "GET /api/scripts/[id]", error });
  }
}

// PUT /api/scripts/[id] — update sections (the step-4 editor's debounced
// autosave). PARTIAL patch: a field absent from the body is left untouched
// rather than reset (see the Task 2 ctaStyle regression). `status` and
// `editorProjectId` are not patchable from here — only the send-to-editor
// path (Task 4) may mark a script "sent".
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;
    const { id } = await params;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    }

    const patch: ScriptPatch = {};

    if (body.topic !== undefined) {
      const topicCheck = validateTopic(body.topic);
      if (!topicCheck.ok) return NextResponse.json({ error: topicCheck.message }, { status: 400 });
      patch.topic = topicCheck.topic;
    }

    if (body.durationSec !== undefined) {
      if (!isValidDurationSec(body.durationSec)) {
        return NextResponse.json({ error: "กรุณาระบุความยาววิดีโอ (30, 60 หรือ 90 วินาที)" }, { status: 400 });
      }
      patch.durationSec = body.durationSec;
    }

    if (body.hookText !== undefined) {
      const hookText = typeof body.hookText === "string" ? body.hookText.trim() : "";
      if (!hookText) return NextResponse.json({ error: "hook ต้องไม่ว่าง" }, { status: 400 });
      patch.hookText = hookText;
    }
    if (body.bodyText !== undefined) {
      if (typeof body.bodyText !== "string") {
        return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
      }
      patch.bodyText = body.bodyText;
    }
    if (body.ctaText !== undefined) {
      if (typeof body.ctaText !== "string") {
        return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
      }
      patch.ctaText = body.ctaText;
    }

    if (body.hookFormula !== undefined) {
      const hookFormula = typeof body.hookFormula === "string" ? body.hookFormula.trim() : "";
      if (hookFormula && !isValidHookFormulaKey(hookFormula)) {
        return NextResponse.json({ error: "สูตร hook ไม่ถูกต้อง" }, { status: 400 });
      }
      patch.hookFormula = hookFormula || null;
    }
    if (body.structure !== undefined) {
      const structure = typeof body.structure === "string" ? body.structure.trim() : "";
      if (structure && !isValidStoryStructureKey(structure)) {
        return NextResponse.json({ error: "โครงเรื่องไม่ถูกต้อง" }, { status: 400 });
      }
      patch.structure = structure || null;
    }
    if (body.brandProfileId !== undefined) {
      const brandProfileId =
        typeof body.brandProfileId === "string" && body.brandProfileId.trim()
          ? body.brandProfileId.trim()
          : null;
      if (brandProfileId && !(await ownsBrandProfile(authUser.id, brandProfileId))) {
        return NextResponse.json({ error: "ไม่พบโปรไฟล์แบรนด์" }, { status: 404 });
      }
      patch.brandProfileId = brandProfileId;
    }

    // Bound the stored script size with the same sanity cap the AI routes use.
    // The cap applies to the MERGED row this patch produces, not just to the
    // fields in this request — otherwise repeated single-field PUTs could grow
    // a row well past the cap one section at a time. The load is
    // ownership-scoped, so a foreign id 404s here too.
    const existing = await getScript(authUser.id, id);
    if (!existing) return NextResponse.json({ error: "ไม่พบสคริปต์" }, { status: 404 });
    const sizeCheck = checkAiInputCaps({
      script: assembleScript({
        hookText: patch.hookText ?? existing.hookText,
        bodyText: patch.bodyText ?? existing.bodyText,
        ctaText: patch.ctaText ?? existing.ctaText,
      }),
    });
    if (!sizeCheck.ok) return NextResponse.json({ error: sizeCheck.message }, { status: 400 });

    const updated = await updateScript(authUser.id, id, patch);
    if (!updated) return NextResponse.json({ error: "ไม่พบสคริปต์" }, { status: 404 });

    return NextResponse.json(updated);
  } catch (error) {
    return apiError({ route: "PUT /api/scripts/[id]", error });
  }
}

// DELETE /api/scripts/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;
    const { id } = await params;

    const deleted = await deleteScript(authUser.id, id);
    if (!deleted) return NextResponse.json({ error: "ไม่พบสคริปต์" }, { status: 404 });

    return NextResponse.json({ message: "ลบสคริปต์แล้ว" });
  } catch (error) {
    return apiError({ route: "DELETE /api/scripts/[id]", error });
  }
}
