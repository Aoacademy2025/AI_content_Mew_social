import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import {
  archiveBrandProfile,
  BrandProfileLibraryError,
} from "@/lib/brand-profile-library.server";
import { recordTelemetryEvent } from "@/lib/telemetry";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const archived = await archiveBrandProfile({ userId: auth.user.id, profileId: id });
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_profile_archived",
      source: "server",
      status: archived.replayed ? "replayed" : "archived",
      properties: { profileId: id, cohort: auth.access.cohort },
    }).catch(() => {});
    return NextResponse.json({
      profileId: archived.profileId,
      archivedAt: archived.archivedAt,
      replayed: archived.replayed,
    });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      return NextResponse.json({ code: error.code, error: error.message }, {
        status: error.code === "NOT_FOUND" ? 404 : 409,
      });
    }
    return apiError({ route: "DELETE /api/brand-library/[id]", error });
  }
}
