import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandLibraryUser } from "@/lib/brand-visual-access.server";
import { BrandProfileLibraryError, publishBrandProfileDraft } from "@/lib/brand-profile-library.server";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { emitStylePackSelectedFromRevision } from "@/lib/style-pack-selected-telemetry";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandLibraryUser();
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const revision = await publishBrandProfileDraft({ userId: auth.user.id, profileId: id });
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_profile_revision_published",
      source: "server",
      status: "published",
      value: revision.version,
      properties: { profileId: id, revisionId: revision.id, cohort: auth.access.cohort },
    }).catch(() => {});
    // Task 9 (Telemetry) — fix-up (review finding 1, 2026-09-03): style_pack_selected
    // (surface: "brand") fires ONCE per publish, next to the persisted revision
    // — not on every draft autosave — when the published payload carries a
    // non-null pack. The parse + property read + telemetry write are ENTIRELY
    // inside this fail-open helper: a malformed/legacy payloadJson can never
    // throw into this route's outer catch and turn an already-successful
    // publish into a reported failure.
    await emitStylePackSelectedFromRevision(auth.user.id, revision, "brands.publish");
    return NextResponse.json({ profileId: id, revisionId: revision.id, revision: revision.version });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "REVISION_CONFLICT" ? 409 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return apiError({ route: "POST /api/brand-library/[id]/publish", error });
  }
}
