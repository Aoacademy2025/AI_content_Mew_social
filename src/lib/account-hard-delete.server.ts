import {
  listBrandAssetPathsForUser,
  removeBrandAssetFiles,
} from "@/lib/brand-assets.server";
import { prisma } from "@/lib/prisma";

export async function hardDeleteUserWithBrandAssets(
  userId: string,
): Promise<boolean> {
  const brandAssetPaths = await listBrandAssetPathsForUser(userId);
  const deleted = await prisma.user.deleteMany({ where: { id: userId } });
  if (deleted.count === 0) return false;

  await removeBrandAssetFiles(brandAssetPaths).catch(() => {
    console.error("[account-hard-delete] brand asset cleanup failed");
  });
  return true;
}
