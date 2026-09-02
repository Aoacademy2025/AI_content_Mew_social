import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandLibraryUser } from "@/lib/brand-visual-access.server";
import {
  BrandProfileLibraryError,
  publishBrandProfileDraft,
  type BrandProfilePayload,
} from "@/lib/brand-profile-library.server";
import { recordTelemetryEvent } from "@/lib/telemetry";

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
    // Task 9 (Telemetry): style_pack_selected (surface: "brand") fires ONCE
    // per publish, next to the persisted revision — not on every draft
    // autosave — when the published payload carries a non-null pack.
    const publishedPayload = JSON.parse(revision.payloadJson) as BrandProfilePayload;
    const stylePackId = publishedPayload.visual.stylePackId;
    if (stylePackId) {
      await recordTelemetryEvent(auth.user.id, {
        name: "style_pack_selected",
        source: "server",
        step: "brands.publish",
        properties: {
          packId: stylePackId,
          surface: "brand",
          version: publishedPayload.visual.stylePackVersion,
        },
      }).catch(() => {});
    }
    return NextResponse.json({ profileId: id, revisionId: revision.id, revision: revision.version });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "REVISION_CONFLICT" ? 409 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return apiError({ route: "POST /api/brand-library/[id]/publish", error });
  }
}
