import { lstat } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import {
  getRecoverableBrandAssetFence,
  getRecoverableBrandAssetPath,
} from "@/lib/brand-assets.server";
import { normalizeLogoOverlayConfig } from "@/lib/logo-overlay";

export type EditorProjectBrandAssetFence = {
  assetId: string;
  lifecycleRevision: number;
};

type EditorProjectBrandAssetErrorCode =
  | "brand_asset_unavailable"
  | "brand_asset_lifecycle_conflict";

export class EditorProjectBrandAssetError extends Error {
  code: EditorProjectBrandAssetErrorCode;

  constructor(code: EditorProjectBrandAssetErrorCode) {
    super(code);
    this.name = "EditorProjectBrandAssetError";
    this.code = code;
  }
}

function draftLogoAssetId(draftJson: string | null | undefined): string | null {
  if (!draftJson) return null;
  let draft: unknown;
  try {
    draft = JSON.parse(draftJson) as unknown;
  } catch {
    return null;
  }
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;
  const logoOverlay = (draft as Record<string, unknown>).logoOverlay;
  const normalized = normalizeLogoOverlayConfig(logoOverlay);
  if (!normalized) return null;
  const rawAssetId = logoOverlay && typeof logoOverlay === "object" && !Array.isArray(logoOverlay)
    ? (logoOverlay as Record<string, unknown>).assetId
    : undefined;
  if (rawAssetId !== normalized.assetId) {
    throw new EditorProjectBrandAssetError("brand_asset_unavailable");
  }
  return normalized.assetId;
}

async function recoverableBrandAssetFileExists(
  userId: string,
  assetId: string,
): Promise<boolean> {
  const filePath = await getRecoverableBrandAssetPath(userId, assetId);
  if (!filePath) return false;
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function prepareEditorProjectBrandAsset(
  userId: string,
  draftJson: string | null | undefined,
): Promise<EditorProjectBrandAssetFence | null> {
  const assetId = draftLogoAssetId(draftJson);
  if (!assetId) return null;
  const asset = await getRecoverableBrandAssetFence(userId, assetId);
  if (!asset || !await recoverableBrandAssetFileExists(userId, assetId)) {
    throw new EditorProjectBrandAssetError("brand_asset_unavailable");
  }
  return { assetId, lifecycleRevision: asset.lifecycleRevision };
}

export async function advanceEditorProjectBrandAsset(
  tx: Prisma.TransactionClient,
  userId: string,
  fence: EditorProjectBrandAssetFence | null,
): Promise<void> {
  if (!fence) return;
  const advanced = await tx.brandAsset.updateMany({
    where: {
      id: fence.assetId,
      userId,
      lifecycleRevision: fence.lifecycleRevision,
    },
    data: {
      retiredAt: null,
      lifecycleRevision: { increment: 1 },
    },
  });
  if (advanced.count !== 1) {
    throw new EditorProjectBrandAssetError("brand_asset_lifecycle_conflict");
  }
}
