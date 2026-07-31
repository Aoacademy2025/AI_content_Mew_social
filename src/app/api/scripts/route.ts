import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { checkAiInputCaps } from "@/lib/ai-input-caps";
import { isValidHookFormulaKey, isValidStoryStructureKey } from "@/lib/viral-frameworks";
import {
  assembleScript,
  createScriptWithinCap,
  isValidDurationSec,
  listScripts,
  ownsBrandProfile,
  requireHeroScriptUser,
  validateTopic,
} from "@/lib/hero-script.server";

// GET /api/scripts — list the current user's scripts (newest first, take 50).
export async function GET() {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    return NextResponse.json(await listScripts(authUser.id));
  } catch (error) {
    return apiError({ route: "GET /api/scripts", error });
  }
}

// POST /api/scripts — save a script (the step-4 editor's first autosave).
//
// Enforces the `scripts` plan cap (FREE 3 / 30 days) → 403 SCRIPT_LIMIT. Only
// CREATE is capped: editing (PUT) an existing script is always free, so a FREE
// user at the cap keeps full control of the 3 scripts they already have.
export async function POST(req: Request) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;
    const authUser = access.user;

    const body = await req.json().catch(() => null);

    const topicCheck = validateTopic(body?.topic);
    if (!topicCheck.ok) return NextResponse.json({ error: topicCheck.message }, { status: 400 });

    if (!isValidDurationSec(body?.durationSec)) {
      return NextResponse.json({ error: "กรุณาระบุความยาววิดีโอ (30, 60 หรือ 90 วินาที)" }, { status: 400 });
    }
    const durationSec = body.durationSec as 30 | 60 | 90;

    const hookText = typeof body?.hookText === "string" ? body.hookText.trim() : "";
    if (!hookText) return NextResponse.json({ error: "กรุณาเลือก hook ก่อนบันทึกสคริปต์" }, { status: 400 });
    const bodyText = typeof body?.bodyText === "string" ? body.bodyText : "";
    const ctaText = typeof body?.ctaText === "string" ? body.ctaText : "";

    // Bound the stored script size with the same sanity cap the AI routes use.
    const sizeCheck = checkAiInputCaps({ script: assembleScript({ hookText, bodyText, ctaText }) });
    if (!sizeCheck.ok) return NextResponse.json({ error: sizeCheck.message }, { status: 400 });

    const hookFormula = typeof body?.hookFormula === "string" ? body.hookFormula.trim() : "";
    if (hookFormula && !isValidHookFormulaKey(hookFormula)) {
      return NextResponse.json({ error: "สูตร hook ไม่ถูกต้อง" }, { status: 400 });
    }
    const structure = typeof body?.structure === "string" ? body.structure.trim() : "";
    if (structure && !isValidStoryStructureKey(structure)) {
      return NextResponse.json({ error: "โครงเรื่องไม่ถูกต้อง" }, { status: 400 });
    }

    const brandProfileId =
      typeof body?.brandProfileId === "string" && body.brandProfileId.trim()
        ? body.brandProfileId.trim()
        : null;
    // Ownership check, not just existence — the FK alone would happily attach
    // someone else's BrandProfile to this user's Script.
    if (brandProfileId && !(await ownsBrandProfile(authUser.id, brandProfileId))) {
      return NextResponse.json({ error: "ไม่พบโปรไฟล์แบรนด์" }, { status: 404 });
    }

    // Plan cap: FREE 3 scripts per rolling 30 days. The count, the cap check and
    // the insert run in ONE transaction inside createScriptWithinCap — counting
    // out here let two concurrent POSTs at the boundary both pass (TOCTOU).
    const user = await prisma.user.findUnique({ where: { id: authUser.id }, select: { plan: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const created = await createScriptWithinCap(authUser.id, user.plan, {
      topic: topicCheck.topic,
      durationSec,
      hookFormula: hookFormula || null,
      structure: structure || null,
      hookText,
      bodyText,
      ctaText,
      brandProfileId,
    });
    if (!created.ok) {
      return NextResponse.json({ code: "SCRIPT_LIMIT", error: created.capCheck.message }, { status: 403 });
    }

    return NextResponse.json(created.script, { status: 201 });
  } catch (error) {
    return apiError({ route: "POST /api/scripts", error });
  }
}
