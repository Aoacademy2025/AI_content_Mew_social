import { NextResponse } from "next/server";
import { requireBrandVisualRecoveryUser } from "@/lib/brand-visual-access.server";
import { getBrandLookPreviewBatch } from "@/lib/brand-look-preview.server";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth.response;
  const { batchId } = await params;
  const batch = await getBrandLookPreviewBatch({ userId: auth.user.id, batchId });
  return batch
    ? NextResponse.json({ batch })
    : NextResponse.json({ code: "PREVIEW_NOT_FOUND", error: "Preview batch not found" }, { status: 404 });
}
