import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireBrandLibraryUser } from "@/lib/brand-visual-access.server";
import {
  BrandProfileLibraryError,
  brandProfilePayloadSchema,
  saveBrandProfileDraft,
} from "@/lib/brand-profile-library.server";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireBrandLibraryUser();
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => null);
    const parsed = brandProfilePayloadSchema.safeParse(body?.payload ?? body);
    if (!parsed.success) {
      return NextResponse.json({ code: "INVALID_DRAFT", error: parsed.error.issues[0]?.message }, { status: 400 });
    }
    const { id } = await params;
    const draft = await saveBrandProfileDraft({ userId: auth.user.id, profileId: id, payload: parsed.data });
    return NextResponse.json({ profileId: id, baseRevisionNumber: draft.baseRevisionNumber, updatedAt: draft.updatedAt });
  } catch (error) {
    if (error instanceof BrandProfileLibraryError) {
      return NextResponse.json({ code: error.code, error: error.message }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
    }
    return apiError({ route: "PUT /api/brand-library/[id]/draft", error });
  }
}
