import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  BRAND_ASSET_ACCOUNT_DELETE_RECEIPTS_DIRECTORY,
  isSafeBrandAssetUserId,
  removeBrandAssetDirectoryForUser,
} from "@/lib/brand-assets.server";
import { prisma } from "@/lib/prisma";

const CLERK_RECEIPT_VERSION = 1;
const CLERK_RECEIPT_MAX_BYTES = 1024;
const CLERK_ID_MAX_LENGTH = 512;
const CLERK_RECEIPT_BINDING_DOMAIN = "heroai-clerk-brand-cleanup-v1";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

type ClerkCleanupReceipt = {
  version: 1;
  clerkIdHash: string;
  userId: string;
  bindingHash: string;
};

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

function brandAssetRoot(): string {
  return path.resolve(process.env.BRAND_ASSET_ROOT || path.join(process.cwd(), "data", "brand-assets"));
}

function isSafeClerkId(clerkId: unknown): clerkId is string {
  return typeof clerkId === "string"
    && clerkId.length > 0
    && clerkId.length <= CLERK_ID_MAX_LENGTH
    && clerkId.trim() === clerkId
    && clerkId.normalize("NFC") === clerkId
    && !/[\u0000-\u001f\u007f]/u.test(clerkId);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function getClerkBrandAssetCleanupReceiptIdentifier(clerkId: string): string {
  if (!isSafeClerkId(clerkId)) {
    throw new Error("invalid_clerk_cleanup_identifier");
  }
  return sha256(clerkId);
}

function receiptBindingHash(clerkId: string, userId: string): string {
  return sha256(`${CLERK_RECEIPT_BINDING_DOMAIN}\u0000${clerkId}\u0000${userId}`);
}

function materializeReceipt(clerkId: string, userId: string): ClerkCleanupReceipt {
  const clerkIdHash = getClerkBrandAssetCleanupReceiptIdentifier(clerkId);
  if (!isSafeBrandAssetUserId(userId)) {
    throw new Error("invalid_clerk_cleanup_receipt");
  }
  return {
    version: CLERK_RECEIPT_VERSION,
    clerkIdHash,
    userId,
    bindingHash: receiptBindingHash(clerkId, userId),
  };
}

function serializeReceipt(clerkId: string, userId: string): string {
  return JSON.stringify(materializeReceipt(clerkId, userId));
}

function receiptsDirectory(): string {
  const root = brandAssetRoot();
  const directory = path.resolve(root, BRAND_ASSET_ACCOUNT_DELETE_RECEIPTS_DIRECTORY);
  if (directory === root || path.dirname(directory) !== root) {
    throw new Error("invalid_clerk_cleanup_receipt_directory");
  }
  return directory;
}

function receiptPath(clerkId: string): string {
  const directory = receiptsDirectory();
  const identifier = getClerkBrandAssetCleanupReceiptIdentifier(clerkId);
  const filePath = path.resolve(directory, `${identifier}.json`);
  if (path.dirname(filePath) !== directory) {
    throw new Error("invalid_clerk_cleanup_receipt_path");
  }
  return filePath;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function assertPrivateOwnerMode(mode: number): void {
  if ((mode & 0o077) !== 0) {
    throw new Error("invalid_clerk_cleanup_receipt_mode");
  }
}

function assertCurrentProcessOwner(uid: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error("invalid_clerk_cleanup_receipt_owner");
  }
}

async function validateReceiptsDirectory(create: boolean): Promise<string | null> {
  const root = brandAssetRoot();
  const directory = receiptsDirectory();
  if (create) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }

  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (!create && isMissingFileError(error)) return null;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("invalid_clerk_cleanup_receipt_directory");
  }
  assertPrivateOwnerMode(metadata.mode);
  assertCurrentProcessOwner(metadata.uid);
  return directory;
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function writeClerkCleanupReceipt(clerkId: string, userId: string): Promise<void> {
  const contents = serializeReceipt(clerkId, userId);
  const directory = await validateReceiptsDirectory(true);
  if (!directory) throw new Error("invalid_clerk_cleanup_receipt_directory");
  const finalPath = receiptPath(clerkId);
  const identifier = getClerkBrandAssetCleanupReceiptIdentifier(clerkId);
  const temporaryPath = path.join(directory, `.${identifier}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, finalPath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error) => {
      if (!isMissingFileError(error)) throw error;
    });
  }
}

async function readClerkCleanupReceipt(clerkId: string): Promise<string | null> {
  const directory = await validateReceiptsDirectory(false);
  if (!directory) return null;
  const filePath = receiptPath(clerkId);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > CLERK_RECEIPT_MAX_BYTES) {
      throw new Error("invalid_clerk_cleanup_receipt");
    }
    assertPrivateOwnerMode(metadata.mode);
    assertCurrentProcessOwner(metadata.uid);
    const contents = await handle.readFile("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new Error("invalid_clerk_cleanup_receipt");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_clerk_cleanup_receipt");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== CLERK_RECEIPT_VERSION
      || typeof candidate.clerkIdHash !== "string"
      || !SHA256_HEX_PATTERN.test(candidate.clerkIdHash)
      || typeof candidate.userId !== "string"
      || !isSafeBrandAssetUserId(candidate.userId)
      || typeof candidate.bindingHash !== "string"
      || !SHA256_HEX_PATTERN.test(candidate.bindingHash)
    ) {
      throw new Error("invalid_clerk_cleanup_receipt");
    }
    const canonical = serializeReceipt(clerkId, candidate.userId);
    if (contents !== canonical) {
      throw new Error("invalid_clerk_cleanup_receipt");
    }
    return candidate.userId;
  } finally {
    await handle.close();
  }
}

async function removeClerkCleanupReceipt(clerkId: string): Promise<void> {
  const directory = await validateReceiptsDirectory(false);
  if (!directory) return;
  try {
    await unlink(receiptPath(clerkId));
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  await syncDirectory(directory);
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
      writeReceipt: writeClerkCleanupReceipt,
      readReceipt: readClerkCleanupReceipt,
      deleteUser: async (id, expectedClerkId) => {
        const deleted = await prisma.user.deleteMany({
          where: { id, clerkId: expectedClerkId },
        });
        return deleted.count === 1;
      },
      removeUserDirectory: removeBrandAssetDirectoryForUser,
      removeReceipt: removeClerkCleanupReceipt,
    });
  } catch {
    console.error(
      `[account-hard-delete] clerk asset cleanup retry required receipt=${receiptIdentifier}`,
    );
    throw new ClerkBrandAssetCleanupRetryError(receiptIdentifier);
  }
}
