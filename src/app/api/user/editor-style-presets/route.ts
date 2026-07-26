import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  EditorStylePresetError,
  isEditorStylePresetKind,
  listEditorStylePresets,
  saveEditorStylePreset,
} from "@/lib/editor-style-presets.server";

export const runtime = "nodejs";

const ERROR_MESSAGES: Record<EditorStylePresetError["code"], string> = {
  invalid_kind: "ประเภทพรีเซ็ตไม่ถูกต้อง",
  invalid_name: "กรุณาตั้งชื่อพรีเซ็ตไม่เกิน 40 ตัวอักษร",
  invalid_config: "ค่าพรีเซ็ตไม่ถูกต้อง",
  plan_required: "พรีเซ็ตโลโก้ใช้ได้สำหรับ Pro และ Business",
  asset_not_found: "ไม่พบไฟล์โลโก้ หรือไฟล์นี้ไม่พร้อมใช้งานแล้ว",
  limit_reached: "บันทึกได้สูงสุด 20 พรีเซ็ตต่อประเภท",
};

function presetErrorResponse(error: EditorStylePresetError): NextResponse {
  return NextResponse.json(
    { error: error.code, message: ERROR_MESSAGES[error.code] },
    { status: error.status },
  );
}

export async function GET(): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({
      presets: await listEditorStylePresets(user.id),
    });
  } catch (error) {
    return apiError({
      route: "GET /api/user/editor-style-presets",
      error,
    });
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null) as {
      kind?: unknown;
      name?: unknown;
      config?: unknown;
    } | null;
    if (!body || !isEditorStylePresetKind(body.kind)) {
      return presetErrorResponse(new EditorStylePresetError("invalid_kind", 400));
    }

    const preset = body.kind === "subtitle"
      ? await saveEditorStylePreset({
          userId: user.id,
          plan: user.plan,
          kind: "subtitle",
          name: body.name,
          config: body.config,
        })
      : await saveEditorStylePreset({
          userId: user.id,
          plan: user.plan,
          kind: "logo",
          name: body.name,
          config: body.config,
        });
    return NextResponse.json({ preset });
  } catch (error) {
    if (error instanceof EditorStylePresetError) {
      return presetErrorResponse(error);
    }
    return apiError({
      route: "PUT /api/user/editor-style-presets",
      error,
    });
  }
}
