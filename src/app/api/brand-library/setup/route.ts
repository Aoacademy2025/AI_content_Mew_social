import { NextResponse } from "next/server";
import { requireBrandLibraryUser } from "@/lib/brand-visual-access.server";
import { pinAdmissionFromDecision } from "@/lib/brand-visual-pin-admission";
import { brandSetupRequestSchema, completeBrandSetup } from "@/lib/brand-setup.server";
import { BrandProfileLibraryError } from "@/lib/brand-profile-library.server";
import { prisma } from "@/lib/prisma";
import { emitStylePackSelectedFromRevision } from "@/lib/style-pack-selected-telemetry";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { limitsForPlan } from "@/lib/plan-limits";
import { apiError } from "@/lib/api-error";

export async function POST(req: Request) {
  try {
    const auth = await requireBrandLibraryUser();
    if (!auth.ok) return auth.response;
    const parsed = brandSetupRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "ข้อมูลแบรนด์ไม่ครบ" }, { status: 400 });
    if (parsed.data.action !== "save" && !limitsForPlan(auth.user.plan).allowVideoEditor) return NextResponse.json({ error: "แผนนี้ยังไม่เปิดการสร้างคลิป" }, { status: 403 });
    const imageAccess = auth.access;
    const result = await completeBrandSetup(auth.user.id, parsed.data, pinAdmissionFromDecision(imageAccess));
    if (!result.replayed) {
      if (parsed.data.action !== "use-brand") {
        await recordTelemetryEvent(auth.user.id, { name: parsed.data.profileId ? "brand_profile_revision_published" : "brand_profile_saved", source: "server", status: parsed.data.profileId ? "published" : "created", value: result.revision, properties: { profileId: result.profileId, revisionId: result.revisionId, cohort: imageAccess.cohort } }).catch(() => {});
        await prisma.brandProfileRevision.findUnique({ where: { id: result.revisionId } }).then((revision) => revision && emitStylePackSelectedFromRevision(auth.user.id, revision, "brands.publish")).catch(() => {});
      }
      await recordTelemetryEvent(auth.user.id, {
        name: result.projectId ? "brand_setup_editor_created" : "brand_setup_saved", source: "server", path: "/brands", status: "completed",
        properties: { ...result, action: parsed.data.action, packId: parsed.data.payload?.visual.stylePackId ?? null, cohort: imageAccess.cohort },
      }).catch(() => {});
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) return NextResponse.json({ code: error.code, error: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
    const code = (error as { code?: string })?.code;
    if (code === "brand_asset_unavailable" || code === "brand_asset_lifecycle_conflict") return NextResponse.json({ code, error: "ไฟล์โลโก้นี้ใช้ไม่ได้แล้ว กรุณาเลือกใหม่หรือปิดโลโก้ ร่างของคุณยังอยู่" }, { status: 422 });
    if (code === "draft_too_large") return NextResponse.json({ code, error: "ข้อมูลแบรนด์ใหญ่เกินไป กรุณาลดรายละเอียดแล้วลองอีกครั้ง" }, { status: 422 });
    return apiError({ route: "POST /api/brand-library/setup", error });
  }
}
