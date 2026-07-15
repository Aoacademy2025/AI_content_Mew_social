import {
  isSafeBrandAssetUserId,
  removeBrandAssetDirectoryForUser,
} from "@/lib/brand-assets.server";
import {
  createClerkAssetCleanupStore,
  type ClerkAssetCleanupStore,
} from "@/lib/clerk-asset-cleanup-receipt.server";
import { prisma } from "@/lib/prisma";

type ClerkUserTarget = {
  id: string;
  clerkId: string | null;
};

export type ClerkBrandAssetDeleteDependencies = {
  findUserByClerkId: (clerkId: string) => Promise<ClerkUserTarget | null>;
  findUserById: (userId: string) => Promise<ClerkUserTarget | null>;
  store: ClerkAssetCleanupStore;
  deleteUser: (userId: string, clerkId: string) => Promise<boolean>;
};

type ClerkBrandAssetCleanupFailurePhase =
  | "receipt-write"
  | "db-delete"
  | "quarantine"
  | "live-target"
  | "quarantine-remove"
  | "receipt-update"
  | "receipt-remove";

export class ClerkBrandAssetCleanupRetryError extends Error {
  readonly receiptIdentifier: string;
  readonly phase: ClerkBrandAssetCleanupFailurePhase;

  constructor(
    receiptIdentifier: string,
    phase: ClerkBrandAssetCleanupFailurePhase,
  ) {
    super("clerk_brand_asset_cleanup_retry_required");
    this.name = "ClerkBrandAssetCleanupRetryError";
    this.receiptIdentifier = receiptIdentifier;
    this.phase = phase;
  }
}

const clerkAssetCleanupStore = createClerkAssetCleanupStore();
const clerkAssetCleanupFinalizers = new Map<string, Promise<void>>();

export function getClerkBrandAssetCleanupReceiptIdentifier(clerkId: string): string {
  return clerkAssetCleanupStore.identifier(clerkId);
}

function requireClerkAssetCleanupRetry(
  receiptId: string,
  phase: ClerkBrandAssetCleanupFailurePhase,
): never {
  console.error(
    `[account-hard-delete] clerk asset cleanup retry required receipt=${receiptId} phase=${phase}`,
  );
  throw new ClerkBrandAssetCleanupRetryError(receiptId, phase);
}

async function runClerkAssetCleanupStep<T>(
  receiptId: string,
  phase: ClerkBrandAssetCleanupFailurePhase,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ClerkBrandAssetCleanupRetryError) throw error;
    return requireClerkAssetCleanupRetry(receiptId, phase);
  }
}

async function runClerkAssetCleanupFinalizer<T>(
  receiptId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = clerkAssetCleanupFinalizers.get(receiptId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  clerkAssetCleanupFinalizers.set(receiptId, current);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (clerkAssetCleanupFinalizers.get(receiptId) === current) {
      clerkAssetCleanupFinalizers.delete(receiptId);
    }
  }
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
  const receiptId = dependencies.store.identifier(clerkId);
  let receipt = await runClerkAssetCleanupStep(
    receiptId,
    "receipt-write",
    () => dependencies.store.read(clerkId),
  );
  let deleted = false;

  if (!receipt) {
    const terminalState = await runClerkAssetCleanupStep(
      receiptId,
      "quarantine-remove",
      () => dependencies.store.quarantineState(clerkId),
    );
    if (terminalState === "cleaned") {
      const reusedClerkTarget = await runClerkAssetCleanupStep(
        receiptId,
        "db-delete",
        () => dependencies.findUserByClerkId(clerkId),
      );
      if (reusedClerkTarget) {
        return requireClerkAssetCleanupRetry(receiptId, "live-target");
      }
      return false;
    }
    if (terminalState === "active") {
      return requireClerkAssetCleanupRetry(receiptId, "receipt-write");
    }
    const currentUser = await runClerkAssetCleanupStep(
      receiptId,
      "db-delete",
      () => dependencies.findUserByClerkId(clerkId),
    );
    if (!currentUser) return false;
    if (!isSafeBrandAssetUserId(currentUser.id)) {
      return requireClerkAssetCleanupRetry(receiptId, "receipt-write");
    }
    await runClerkAssetCleanupStep(
      receiptId,
      "receipt-write",
      () => dependencies.store.write(clerkId, currentUser.id, "prepared"),
    );
    receipt = await runClerkAssetCleanupStep(
      receiptId,
      "receipt-write",
      () => dependencies.store.read(clerkId),
    );
    if (!receipt || receipt.userId !== currentUser.id || receipt.phase !== "prepared") {
      return requireClerkAssetCleanupRetry(receiptId, "receipt-write");
    }
  }

  return runClerkAssetCleanupFinalizer(receiptId, async () => {
    const latestReceipt = await runClerkAssetCleanupStep(
      receiptId,
      "receipt-write",
      () => dependencies.store.read(clerkId),
    );
    if (!latestReceipt) {
      const latestQuarantineState = await runClerkAssetCleanupStep(
        receiptId,
        "quarantine-remove",
        () => dependencies.store.quarantineState(clerkId),
      );
      if (latestQuarantineState === "active") {
        return requireClerkAssetCleanupRetry(receiptId, "receipt-write");
      }
      return deleted;
    }

    const { userId } = latestReceipt;
    if (!isSafeBrandAssetUserId(userId)) {
      return requireClerkAssetCleanupRetry(receiptId, "receipt-write");
    }

    if (latestReceipt.phase === "directory-cleaned") {
      await runClerkAssetCleanupStep(
        receiptId,
        "receipt-remove",
        () => dependencies.store.remove(clerkId),
      );
      return deleted;
    }

    let quarantineState = await runClerkAssetCleanupStep(
      receiptId,
      "quarantine-remove",
      () => dependencies.store.quarantineState(clerkId),
    );
    if (quarantineState === "cleaned") {
      await runClerkAssetCleanupStep(
        receiptId,
        "quarantine-remove",
        () => dependencies.store.removeQuarantine(clerkId),
      );
      await runClerkAssetCleanupStep(
        receiptId,
        "receipt-update",
        () => dependencies.store.write(clerkId, userId, "directory-cleaned"),
      );
      await runClerkAssetCleanupStep(
        receiptId,
        "receipt-remove",
        () => dependencies.store.remove(clerkId),
      );
      return deleted;
    }

    if (latestReceipt.phase === "prepared") {
      const currentUser = await runClerkAssetCleanupStep(
        receiptId,
        "db-delete",
        () => dependencies.findUserByClerkId(clerkId),
      );
      if (currentUser && currentUser.id !== userId) {
        return requireClerkAssetCleanupRetry(receiptId, "live-target");
      }

      const targetBeforeDelete = await runClerkAssetCleanupStep(
        receiptId,
        "db-delete",
        () => dependencies.findUserById(userId),
      );
      if (targetBeforeDelete && targetBeforeDelete.clerkId !== clerkId) {
        return requireClerkAssetCleanupRetry(receiptId, "live-target");
      }

      if (currentUser || targetBeforeDelete) {
        await runClerkAssetCleanupStep(
          receiptId,
          "receipt-write",
          () => dependencies.store.write(clerkId, userId, "prepared"),
        );
        deleted = await runClerkAssetCleanupStep(
          receiptId,
          "db-delete",
          () => dependencies.deleteUser(userId, clerkId),
        );
      }

      const targetBeforeQuarantine = await runClerkAssetCleanupStep(
        receiptId,
        "db-delete",
        () => dependencies.findUserById(userId),
      );
      if (targetBeforeQuarantine) {
        return requireClerkAssetCleanupRetry(
          receiptId,
          targetBeforeQuarantine.clerkId === clerkId ? "db-delete" : "live-target",
        );
      }

      await runClerkAssetCleanupStep(
        receiptId,
        "quarantine",
        () => dependencies.store.quarantineUserDirectory({ clerkId, userId }),
      );
      quarantineState = await runClerkAssetCleanupStep(
        receiptId,
        "quarantine-remove",
        () => dependencies.store.quarantineState(clerkId),
      );
      if (quarantineState === "cleaned") {
        await runClerkAssetCleanupStep(
          receiptId,
          "quarantine-remove",
          () => dependencies.store.removeQuarantine(clerkId),
        );
        await runClerkAssetCleanupStep(
          receiptId,
          "receipt-update",
          () => dependencies.store.write(clerkId, userId, "directory-cleaned"),
        );
        await runClerkAssetCleanupStep(
          receiptId,
          "receipt-remove",
          () => dependencies.store.remove(clerkId),
        );
        return deleted;
      }

      await runClerkAssetCleanupStep(
        receiptId,
        "receipt-update",
        () => dependencies.store.write(clerkId, userId, "quarantined"),
      );
    }

    quarantineState = await runClerkAssetCleanupStep(
      receiptId,
      "quarantine-remove",
      () => dependencies.store.quarantineState(clerkId),
    );
    if (quarantineState === "active") {
      const liveTarget = await runClerkAssetCleanupStep(
        receiptId,
        "db-delete",
        () => dependencies.findUserById(userId),
      );
      if (liveTarget) {
        return requireClerkAssetCleanupRetry(receiptId, "live-target");
      }
      await runClerkAssetCleanupStep(
        receiptId,
        "quarantine-remove",
        () => dependencies.store.removeQuarantine(clerkId),
      );
      quarantineState = await runClerkAssetCleanupStep(
        receiptId,
        "quarantine-remove",
        () => dependencies.store.quarantineState(clerkId),
      );
      if (quarantineState !== "cleaned") {
        return requireClerkAssetCleanupRetry(receiptId, "quarantine-remove");
      }
    }

    await runClerkAssetCleanupStep(
      receiptId,
      "receipt-update",
      () => dependencies.store.write(clerkId, userId, "directory-cleaned"),
    );
    await runClerkAssetCleanupStep(
      receiptId,
      "receipt-remove",
      () => dependencies.store.remove(clerkId),
    );
    return deleted;
  });
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
  return deleteClerkUserAndBrandAssetDirectory(clerkId, {
    findUserByClerkId: (id) => prisma.user.findUnique({
      where: { clerkId: id },
      select: { id: true, clerkId: true },
    }),
    findUserById: (id) => prisma.user.findUnique({
      where: { id },
      select: { id: true, clerkId: true },
    }),
    store: clerkAssetCleanupStore,
    deleteUser: async (id, expectedClerkId) => {
      const deleted = await prisma.user.deleteMany({
        where: { id, clerkId: expectedClerkId },
      });
      return deleted.count === 1;
    },
  });
}
