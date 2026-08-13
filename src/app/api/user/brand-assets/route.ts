import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  brandAssetActorForUser,
  getBrandAssetCollection,
  postBrandAsset,
} from "@/lib/brand-asset-api.server";
import { getCurrentUser } from "@/lib/clerk-auth";

export async function GET(): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return getBrandAssetCollection(await brandAssetActorForUser(user));
  } catch {
    return apiError({
      route: "user/brand-assets",
      error: "Brand asset request failed",
    });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return await postBrandAsset(await brandAssetActorForUser(user), request);
  } catch {
    return apiError({
      route: "user/brand-assets",
      error: "Brand asset request failed",
    });
  }
}
