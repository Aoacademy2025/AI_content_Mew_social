import {
  removeBrandAssetDirectoryForUser,
} from "@/lib/brand-assets.server";
import { prisma } from "@/lib/prisma";

export async function deleteUserAndBrandAssetDirectory(
  userId: string,
  dependencies: {
    deleteUser: (userId: string) => Promise<boolean>;
    removeUserDirectory: (userId: string) => Promise<void>;
    reportCleanupFailure: () => void;
  },
): Promise<boolean> {
  const deleted = await dependencies.deleteUser(userId);
  try {
    await dependencies.removeUserDirectory(userId);
  } catch {
    try {
      dependencies.reportCleanupFailure();
    } catch {
      // Reporting cannot change the public database-deletion result.
    }
  }
  return deleted;
}

export async function hardDeleteUserWithBrandAssets(
  userId: string,
): Promise<boolean> {
  return deleteUserAndBrandAssetDirectory(userId, {
    deleteUser: async (id) => {
      const deleted = await prisma.user.deleteMany({ where: { id } });
      return deleted.count === 1;
    },
    removeUserDirectory: removeBrandAssetDirectoryForUser,
    reportCleanupFailure: () => {
      console.error("[account-hard-delete] brand asset cleanup failed");
    },
  });
}
