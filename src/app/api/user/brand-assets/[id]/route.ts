import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  BrandAssetError,
  canUseLogoOverlay,
  deleteBrandAssetIfUnreferenced,
  getDefaultBrandPreference,
  getOwnedBrandAsset,
  setDefaultBrandPreference,
} from "@/lib/brand-assets.server";
import { getCurrentUser } from "@/lib/clerk-auth";
import {
  normalizeLogoOverlayConfig,
  type BrandAssetView,
} from "@/lib/logo-overlay";
import {
  mapBrandAssetError,
  type BrandAssetActor,
} from "../route";

const PATCH_KEYS = new Set([
  "setAsDefault",
  "enabled",
  "position",
  "sizePct",
  "opacity",
]);

function mappedErrorResponse(error: unknown): NextResponse | null {
  const mapped = mapBrandAssetError(error);
  return mapped ? NextResponse.json(mapped.body, { status: mapped.status }) : null;
}

function publicAsset(asset: BrandAssetView): BrandAssetView {
  return {
    ...asset,
    imageUrl: `/api/user/brand-assets/${encodeURIComponent(asset.id)}/image`,
  };
}

function invalidBodyResponse(): NextResponse {
  return NextResponse.json(
    { error: "invalid_body", message: "ข้อมูลคำขอไม่ถูกต้อง" },
    { status: 400 },
  );
}

function invalidConfigResponse(): NextResponse {
  return mappedErrorResponse(new BrandAssetError("invalid_config", 400))!;
}

export async function getBrandAssetItem(
  user: BrandAssetActor,
  assetId: string,
): Promise<NextResponse> {
  if (!assetId.trim()) return invalidConfigResponse();
  const asset = await getOwnedBrandAsset(user.id, assetId);
  if (!asset) {
    return mappedErrorResponse(new BrandAssetError("asset_not_found", 404))!;
  }
  return NextResponse.json({ asset: publicAsset(asset) });
}

export async function patchBrandAssetItem(
  user: BrandAssetActor,
  assetId: string,
  request: Request,
): Promise<NextResponse> {
  if (!canUseLogoOverlay(user.plan)) {
    return mappedErrorResponse(new BrandAssetError("plan_required", 403))!;
  }
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) return invalidConfigResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidBodyResponse();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidBodyResponse();
  }

  const candidate = body as Record<string, unknown>;
  if (
    candidate.setAsDefault !== true
    || Object.keys(candidate).some((key) => !PATCH_KEYS.has(key))
  ) {
    return invalidConfigResponse();
  }

  const config = normalizeLogoOverlayConfig({
    assetId: normalizedAssetId,
    enabled: candidate.enabled,
    position: candidate.position,
    sizePct: candidate.sizePct,
    opacity: candidate.opacity,
  });
  if (!config) return invalidConfigResponse();

  try {
    await setDefaultBrandPreference({
      userId: user.id,
      plan: user.plan,
      assetId: normalizedAssetId,
      config,
    });
    const defaultLogo = await getDefaultBrandPreference(user.id);
    return NextResponse.json({
      ok: true,
      defaultLogo: defaultLogo
        ? { ...defaultLogo, asset: publicAsset(defaultLogo.asset) }
        : null,
    });
  } catch (error) {
    const response = mappedErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function deleteBrandAssetItem(
  user: BrandAssetActor,
  assetId: string,
): Promise<NextResponse> {
  if (!canUseLogoOverlay(user.plan)) {
    return mappedErrorResponse(new BrandAssetError("plan_required", 403))!;
  }
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) return invalidConfigResponse();

  try {
    const deleted = await deleteBrandAssetIfUnreferenced(user.id, normalizedAssetId);
    if (!deleted) {
      return mappedErrorResponse(new BrandAssetError("asset_not_found", 404))!;
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const response = mappedErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

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
    return await getBrandAssetItem(user, id);
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
    return await patchBrandAssetItem(user, id, request);
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
    return await deleteBrandAssetItem(user, id);
  } catch {
    return apiError({
      route: "user/brand-assets/[id]",
      error: "Brand asset request failed",
    });
  }
}
