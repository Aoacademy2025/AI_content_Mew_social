import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  brandAssetActorForUser,
  deleteBrandAssetItem,
  getBrandAssetItem,
  patchBrandAssetItem,
} from "@/lib/brand-asset-api.server";
import { getCurrentUser } from "@/lib/clerk-auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    return await getBrandAssetItem(await brandAssetActorForUser(user), id);
  } catch {
    return apiError({
      route: "user/brand-assets/[id]",
      error: "Brand asset request failed",
    });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    return await patchBrandAssetItem(await brandAssetActorForUser(user), id, request);
  } catch {
    return apiError({
      route: "user/brand-assets/[id]",
      error: "Brand asset request failed",
    });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    return await deleteBrandAssetItem(await brandAssetActorForUser(user), id);
  } catch {
    return apiError({
      route: "user/brand-assets/[id]",
      error: "Brand asset request failed",
    });
  }
}
