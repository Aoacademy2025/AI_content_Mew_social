import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandVisualUser } from "@/lib/brand-visual-access.server";
import { BrandProfileLibraryError, reconcileBrandProfileAvailability } from "@/lib/brand-profile-library.server";
import { recordTelemetryEvent } from "@/lib/telemetry";

export async function POST(req: Request) {
  try {
    const auth = await requireBrandVisualUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const preferredProfileIds = Array.isArray(body?.preferredProfileIds)
      ? body.preferredProfileIds.filter((id: unknown): id is string => typeof id === "string")
      : undefined;
    const result = await reconcileBrandProfileAvailability({
      userId: auth.user.id,
      preferredProfileIds,
      preferredProfileId: typeof body?.preferredProfileId === "string" ? body.preferredProfileId : undefined,
    });
    await recordTelemetryEvent(auth.user.id, {
      name: "brand_profile_availability_reconciled",
      source: "server",
      status: "selected",
      properties: {
        activeCount: result.activeProfileIds.length,
        frozenCount: result.frozenProfileIds.length,
        cohort: auth.access.cohort,
      },
    }).catch(() => {});
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "PREFERRED_REQUIRED" ? 409 : 400;
      return NextResponse.json({ code: error.code, error: error.message }, { status });
    }
    return apiError({ route: "POST /api/brand-library/availability", error });
  }
}
