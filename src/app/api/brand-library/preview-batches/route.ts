import { NextResponse } from "next/server";
import { requireBrandVisualRecoveryUser } from "@/lib/brand-visual-access.server";
import {
  getBrandLookPreviewByRequestId,
  parseBrandLookPreviewRequestId,
  resumeBrandLookPreviewByRequestId,
} from "@/lib/brand-look-preview.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth.response;
  const requestId = parseBrandLookPreviewRequestId(new URL(req.url).searchParams.get("requestId"));
  if (!requestId) {
    return NextResponse.json({ code: "INVALID_REQUEST_ID", error: "requestId is required" }, { status: 400 });
  }
  const batch = await getBrandLookPreviewByRequestId({ userId: auth.user.id, requestId });
  return batch
    ? NextResponse.json({ batch })
    : NextResponse.json({ code: "PREVIEW_NOT_FOUND", error: "Preview batch not found" }, { status: 404 });
}

/** Re-dispatch missing durable children from the batch's frozen snapshot.
 * This is recovery, not new admission: ownership and request identity are the
 * only inputs, so a rollout flag change cannot strand already-admitted work. */
export async function POST(req: Request) {
  const auth = await requireBrandVisualRecoveryUser();
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  const requestId = parseBrandLookPreviewRequestId(body?.requestId);
  if (!requestId) {
    return NextResponse.json({ code: "INVALID_REQUEST_ID", error: "requestId is required" }, { status: 400 });
  }
  const batch = await resumeBrandLookPreviewByRequestId({ userId: auth.user.id, requestId });
  return batch
    ? NextResponse.json({ batch, replayed: true })
    : NextResponse.json({ code: "PREVIEW_NOT_FOUND", error: "Preview batch not found" }, { status: 404 });
}
