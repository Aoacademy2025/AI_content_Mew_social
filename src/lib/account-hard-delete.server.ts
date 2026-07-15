import {
  isSafeBrandAssetUserId,
  removeBrandAssetDirectoryForUser,
} from "@/lib/brand-assets.server";
import { createClerkAssetCleanupStore } from "@/lib/clerk-asset-cleanup-receipt.server";
import { prisma } from "@/lib/prisma";

type ClerkUserTarget = {
  id: string;
  clerkId: string | null;
};

export type ClerkBrandAssetDeleteDependencies = {
  findUserByClerkId: (clerkId: string) => Promise<ClerkUserTarget | null>;
  findUserById: (userId: string) => Promise<ClerkUserTarget | null>;
  writeReceipt: (clerkId: string, userId: string) => Promise<void>;
  readReceipt: (clerkId: string) => Promise<string | null>;
  deleteUser: (userId: string, clerkId: string) => Promise<boolean>;
  removeUserDirectory: (userId: string) => Promise<void>;
  removeReceipt: (clerkId: string) => Promise<void>;
};

export class ClerkBrandAssetCleanupRetryError extends Error {
  readonly receiptIdentifier: string;

  constructor(receiptIdentifier: string) {
    super("clerk_brand_asset_cleanup_retry_required");
    this.name = "ClerkBrandAssetCleanupRetryError";
    this.receiptIdentifier = receiptIdentifier;
  }
}

const clerkAssetCleanupStore = createClerkAssetCleanupStore();

export function getClerkBrandAssetCleanupReceiptIdentifier(clerkId: string): string {
  return clerkAssetCleanupStore.identifier(clerkId);
}

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

export async function deleteClerkUserAndBrandAssetDirectory(
  clerkId: string,
  dependencies: ClerkBrandAssetDeleteDependencies,
): Promise<boolean> {
  const currentUser = await dependencies.findUserByClerkId(clerkId);
  const existingReceiptUserId = await dependencies.readReceipt(clerkId);
  let userId: string;

  if (currentUser) {
    if (!isSafeBrandAssetUserId(currentUser.id)) {
      throw new Error("invalid_clerk_cleanup_target");
    }
    if (existingReceiptUserId !== null && existingReceiptUserId !== currentUser.id) {
      throw new Error("invalid_clerk_cleanup_receipt_target");
    }
    userId = currentUser.id;
    if (existingReceiptUserId === null) {
      await dependencies.writeReceipt(clerkId, userId);
    }
  } else {
    if (existingReceiptUserId === null) return false;
    userId = existingReceiptUserId;
    const liveTarget = await dependencies.findUserById(userId);
    if (liveTarget && liveTarget.clerkId !== clerkId) {
      throw new Error("invalid_clerk_cleanup_live_target");
    }
  }

  const deleted = await dependencies.deleteUser(userId, clerkId);
  if (!deleted) {
    const remainingTarget = await dependencies.findUserById(userId);
    if (remainingTarget) {
      throw new Error("invalid_clerk_cleanup_remaining_target");
    }
  }
  await dependencies.removeUserDirectory(userId);
  await dependencies.removeReceipt(clerkId);
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

export async function hardDeleteClerkUserWithBrandAssets(
  clerkId: string,
): Promise<boolean> {
  const receiptIdentifier = getClerkBrandAssetCleanupReceiptIdentifier(clerkId);
  try {
    return await deleteClerkUserAndBrandAssetDirectory(clerkId, {
      findUserByClerkId: (id) => prisma.user.findUnique({
        where: { clerkId: id },
        select: { id: true, clerkId: true },
      }),
      findUserById: (id) => prisma.user.findUnique({
        where: { id },
        select: { id: true, clerkId: true },
      }),
      writeReceipt: (id, userId) => clerkAssetCleanupStore.write(id, userId, "prepared"),
      readReceipt: async (id) => (await clerkAssetCleanupStore.read(id))?.userId ?? null,
      deleteUser: async (id, expectedClerkId) => {
        const deleted = await prisma.user.deleteMany({
          where: { id, clerkId: expectedClerkId },
        });
        return deleted.count === 1;
      },
      removeUserDirectory: removeBrandAssetDirectoryForUser,
      removeReceipt: (id) => clerkAssetCleanupStore.remove(id),
    });
  } catch {
    console.error(
      `[account-hard-delete] clerk asset cleanup retry required receipt=${receiptIdentifier}`,
    );
    throw new ClerkBrandAssetCleanupRetryError(receiptIdentifier);
  }
}
