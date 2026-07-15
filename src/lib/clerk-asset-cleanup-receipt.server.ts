import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  BRAND_ASSET_ACCOUNT_DELETE_QUARANTINE_DIRECTORY,
  BRAND_ASSET_ACCOUNT_DELETE_RECEIPTS_DIRECTORY,
  isSafeBrandAssetUserId,
} from "@/lib/brand-assets.server";

export const MAX_RECEIPT_BYTES = 1024;

const CLERK_ID_MAX_LENGTH = 512;
const RECEIPT_BINDING_DOMAIN = "heroai-clerk-brand-cleanup-v2";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_VERSION = 2;
const MAX_STALE_TEMPORARIES_PER_CALL = 32;
const QUARANTINE_TERMINAL_MARKER = ".directory-cleaned-v1";

export type ClerkAssetCleanupPhase =
  | "prepared"
  | "quarantined"
  | "directory-cleaned";

export type ClerkAssetCleanupReceipt = Readonly<{
  version: 2;
  clerkIdHash: string;
  userId: string;
  bindingHash: string;
  phase: ClerkAssetCleanupPhase;
}>;

export type ClerkAssetCleanupStore = {
  identifier(clerkId: string): string;
  read(clerkId: string): Promise<ClerkAssetCleanupReceipt | null>;
  write(clerkId: string, userId: string, phase: ClerkAssetCleanupPhase): Promise<void>;
  remove(clerkId: string): Promise<void>;
  quarantineUserDirectory(input: {
    clerkId: string;
    userId: string;
  }): Promise<"moved" | "already-quarantined" | "absent">;
  quarantineState(clerkId: string): Promise<"absent" | "active" | "cleaned">;
  quarantineExists(clerkId: string): Promise<boolean>;
  removeQuarantine(clerkId: string): Promise<void>;
};

type StoreOptions = {
  assetRoot?: string;
  observeDurabilityStep?: (step: string) => void;
};

function invalidReceipt(): Error {
  return new Error("invalid_clerk_cleanup_receipt");
}

function invalidTrustBoundary(): Error {
  return new Error("invalid_clerk_cleanup_trust_boundary");
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function processMayOwnTemporary(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function isSafeClerkId(clerkId: unknown): clerkId is string {
  return typeof clerkId === "string"
    && clerkId.length > 0
    && clerkId.length <= CLERK_ID_MAX_LENGTH
    && clerkId.trim() === clerkId
    && clerkId.normalize("NFC") === clerkId
    && !/[\u0000-\u001f\u007f]/u.test(clerkId);
}

function isCleanupPhase(value: unknown): value is ClerkAssetCleanupPhase {
  return value === "prepared"
    || value === "quarantined"
    || value === "directory-cleaned";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertCurrentOwner(metadata: Stats, error: Error): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw error;
  }
}

function assertTrustedDirectory(metadata: Stats): void {
  const error = invalidTrustBoundary();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o022) !== 0
  ) {
    throw error;
  }
  assertCurrentOwner(metadata, error);
}

function assertTrustedReceiptFile(metadata: Stats): void {
  const error = invalidReceipt();
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
  ) {
    throw error;
  }
  assertCurrentOwner(metadata, error);
}

function assertTrustedQuarantineTarget(metadata: Stats): void {
  const error = invalidTrustBoundary();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o022) !== 0
  ) {
    throw error;
  }
  assertCurrentOwner(metadata, error);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.isFile() === right.isFile()
    && left.uid === right.uid
    && (left.mode & 0o777) === (right.mode & 0o777)
    && left.size === right.size;
}

export function createClerkAssetCleanupStore(
  options: StoreOptions = {},
): ClerkAssetCleanupStore {
  const configuredRoot = options.assetRoot
    ?? process.env.BRAND_ASSET_ROOT
    ?? path.join(process.cwd(), "data", "brand-assets");
  if (configuredRoot.length === 0) {
    throw invalidTrustBoundary();
  }
  const assetRoot = path.resolve(configuredRoot);
  const receiptsDirectory = path.join(
    assetRoot,
    BRAND_ASSET_ACCOUNT_DELETE_RECEIPTS_DIRECTORY,
  );
  const quarantineDirectory = path.join(
    assetRoot,
    BRAND_ASSET_ACCOUNT_DELETE_QUARANTINE_DIRECTORY,
  );
  const observe = options.observeDurabilityStep;

  if (
    path.dirname(receiptsDirectory) !== assetRoot
    || path.dirname(quarantineDirectory) !== assetRoot
  ) {
    throw invalidTrustBoundary();
  }

  async function syncDirectory(directory: string, step?: string): Promise<void> {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try {
      await handle.sync();
      if (step) observe?.(step);
    } finally {
      await handle.close();
    }
  }

  async function metadataOrNull(target: string): Promise<Stats | null> {
    try {
      return await lstat(target);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async function canCreateChildIn(directory: string): Promise<boolean> {
    try {
      await access(directory, fsConstants.W_OK | fsConstants.X_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") return false;
      throw error;
    }
  }

  async function ensureDirectory(
    directory: string,
    createdStep?: string,
    parentSyncedStep?: string,
  ): Promise<boolean> {
    if (await metadataOrNull(directory)) return false;

    const parent = path.dirname(directory);
    if (parent === directory) throw invalidTrustBoundary();
    await ensureDirectory(parent);

    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      if (createdStep) observe?.(createdStep);
      await syncDirectory(parent, parentSyncedStep);
    }
    return created;
  }

  async function ensureTrustedRoot(): Promise<void> {
    await ensureDirectory(
      assetRoot,
      "asset-root-created",
    );
    const metadata = await lstat(assetRoot);
    assertTrustedDirectory(metadata);

    if (await metadataOrNull(receiptsDirectory)) {
      await syncDirectory(path.dirname(assetRoot), "asset-root-parent-synced");
      return;
    }

    // Receipt-directory creation happens only after this initial chain is durable.
    // Its absence may mean any visible configured-root component needs repair.
    for (let current = path.dirname(assetRoot);;) {
      await syncDirectory(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      if (!await canCreateChildIn(parent)) break;
      current = parent;
    }
    observe?.("asset-root-parent-synced");
  }

  async function trustedRootOrNull(): Promise<string | null> {
    const metadata = await metadataOrNull(assetRoot);
    if (!metadata) return null;
    assertTrustedDirectory(metadata);
    return assetRoot;
  }

  async function ensureTrustedReservedDirectory(
    directory: string,
    createdStep: string,
    parentSyncedStep: string,
  ): Promise<void> {
    const created = await ensureDirectory(directory, createdStep, parentSyncedStep);
    assertTrustedDirectory(await lstat(directory));
    if (!created) {
      await syncDirectory(path.dirname(directory), parentSyncedStep);
    }
  }

  async function trustedReservedDirectoryOrNull(
    directory: string,
  ): Promise<string | null> {
    if (!await trustedRootOrNull()) return null;
    const metadata = await metadataOrNull(directory);
    if (!metadata) return null;
    assertTrustedDirectory(metadata);
    return directory;
  }

  function identifier(clerkId: string): string {
    if (!isSafeClerkId(clerkId)) {
      throw new Error("invalid_clerk_cleanup_identifier");
    }
    return sha256(clerkId);
  }

  function bindingHash(clerkId: string, userId: string): string {
    return sha256(`${RECEIPT_BINDING_DOMAIN}\u0000${clerkId}\u0000${userId}`);
  }

  function materializeReceipt(
    clerkId: string,
    userId: string,
    phase: ClerkAssetCleanupPhase,
  ): ClerkAssetCleanupReceipt {
    const clerkIdHash = identifier(clerkId);
    if (!isSafeBrandAssetUserId(userId) || !isCleanupPhase(phase)) {
      throw invalidReceipt();
    }
    return {
      version: RECEIPT_VERSION,
      clerkIdHash,
      userId,
      bindingHash: bindingHash(clerkId, userId),
      phase,
    };
  }

  function receiptPath(receiptId: string): string {
    const target = path.join(receiptsDirectory, `${receiptId}.json`);
    if (path.dirname(target) !== receiptsDirectory) throw invalidReceipt();
    return target;
  }

  function quarantinePath(receiptId: string): string {
    const target = path.join(quarantineDirectory, receiptId);
    if (path.dirname(target) !== quarantineDirectory) throw invalidTrustBoundary();
    return target;
  }

  function quarantineTerminalMarker(receiptId: string): string {
    const target = path.join(quarantinePath(receiptId), QUARANTINE_TERMINAL_MARKER);
    if (path.dirname(target) !== quarantinePath(receiptId)) {
      throw invalidTrustBoundary();
    }
    return target;
  }

  async function hasCanonicalQuarantineTerminalMarker(
    receiptId: string,
  ): Promise<boolean> {
    const target = quarantineTerminalMarker(receiptId);
    const pathnameMetadata = await metadataOrNull(target);
    if (!pathnameMetadata) return false;
    try {
      assertTrustedReceiptFile(pathnameMetadata);
    } catch {
      return false;
    }
    if (pathnameMetadata.size !== Buffer.byteLength(receiptId, "utf8")) {
      return false;
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if (isMissingFileError(error) || (error as NodeJS.ErrnoException).code === "ELOOP") {
        return false;
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      try {
        assertTrustedReceiptFile(before);
      } catch {
        return false;
      }
      if (!sameFileIdentity(pathnameMetadata, before)) return false;
      const buffer = Buffer.alloc(Buffer.byteLength(receiptId, "utf8") + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      const currentPathnameMetadata = await metadataOrNull(target);
      if (!currentPathnameMetadata) return false;
      try {
        assertTrustedReceiptFile(after);
        assertTrustedReceiptFile(currentPathnameMetadata);
      } catch {
        return false;
      }
      return bytesRead === Buffer.byteLength(receiptId, "utf8")
        && sameFileIdentity(before, after)
        && sameFileIdentity(before, currentPathnameMetadata)
        && buffer.subarray(0, bytesRead).toString("utf8") === receiptId;
    } finally {
      await handle.close();
    }
  }

  function userDirectory(userId: string): string {
    if (!isSafeBrandAssetUserId(userId)) throw invalidTrustBoundary();
    const target = path.resolve(assetRoot, userId);
    const relative = path.relative(assetRoot, target);
    if (
      target === assetRoot
      || path.dirname(target) !== assetRoot
      || relative !== userId
      || path.isAbsolute(relative)
      || relative.startsWith(`..${path.sep}`)
    ) {
      throw invalidTrustBoundary();
    }
    return target;
  }

  async function validateExistingQuarantineDirectory(): Promise<void> {
    const metadata = await metadataOrNull(quarantineDirectory);
    if (metadata) assertTrustedDirectory(metadata);
  }

  async function scavengeReceiptTemporaries(
    directory: string,
    receiptId: string,
  ): Promise<void> {
    const ownedTemporaryPattern = new RegExp(
      `^\\.${receiptId}\\.([1-9][0-9]*)\\.[0-9a-f-]{36}\\.tmp$`,
      "u",
    );
    let removed = 0;
    for (const entry of await readdir(directory)) {
      if (removed >= MAX_STALE_TEMPORARIES_PER_CALL) break;
      const ownedMatch = ownedTemporaryPattern.exec(entry);
      if (!ownedMatch) continue;
      const ownerPid = Number(ownedMatch[1]);
      if (!Number.isSafeInteger(ownerPid) || processMayOwnTemporary(ownerPid)) {
        continue;
      }
      const candidate = path.join(directory, entry);
      const metadata = await metadataOrNull(candidate);
      if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) continue;
      try {
        assertTrustedReceiptFile(metadata);
      } catch {
        continue;
      }
      try {
        await unlink(candidate);
        removed += 1;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
  }

  async function read(clerkId: string): Promise<ClerkAssetCleanupReceipt | null> {
    const receiptId = identifier(clerkId);
    const directory = await trustedReservedDirectoryOrNull(receiptsDirectory);
    if (!directory) return null;
    const target = receiptPath(receiptId);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw invalidReceipt();
    }

    try {
      const before = await handle.stat();
      assertTrustedReceiptFile(before);
      if (before.size <= 0 || before.size > MAX_RECEIPT_BYTES) {
        throw invalidReceipt();
      }
      observe?.("receipt-read-metadata");

      const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_RECEIPT_BYTES) throw invalidReceipt();

      const after = await handle.stat();
      let pathnameMetadata: Stats;
      try {
        pathnameMetadata = await lstat(target);
      } catch {
        throw invalidReceipt();
      }
      assertTrustedReceiptFile(after);
      assertTrustedReceiptFile(pathnameMetadata);
      if (
        bytesRead !== before.size
        || !sameFileIdentity(before, after)
        || !sameFileIdentity(before, pathnameMetadata)
      ) {
        throw invalidReceipt();
      }

      const contents = buffer.subarray(0, bytesRead).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents) as unknown;
      } catch {
        throw invalidReceipt();
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw invalidReceipt();
      }
      const candidate = parsed as Record<string, unknown>;
      if (
        candidate.version !== RECEIPT_VERSION
        || typeof candidate.clerkIdHash !== "string"
        || !SHA256_HEX_PATTERN.test(candidate.clerkIdHash)
        || typeof candidate.userId !== "string"
        || typeof candidate.bindingHash !== "string"
        || !SHA256_HEX_PATTERN.test(candidate.bindingHash)
        || !isCleanupPhase(candidate.phase)
      ) {
        throw invalidReceipt();
      }
      const canonical = materializeReceipt(clerkId, candidate.userId, candidate.phase);
      if (contents !== JSON.stringify(canonical)) throw invalidReceipt();
      return canonical;
    } finally {
      await handle.close();
    }
  }

  async function write(
    clerkId: string,
    userId: string,
    phase: ClerkAssetCleanupPhase,
  ): Promise<void> {
    const receipt = materializeReceipt(clerkId, userId, phase);
    const contents = JSON.stringify(receipt);
    if (Buffer.byteLength(contents, "utf8") > MAX_RECEIPT_BYTES) {
      throw invalidReceipt();
    }

    await ensureTrustedRoot();
    await ensureTrustedReservedDirectory(
      receiptsDirectory,
      "receipt-directory-created",
      "asset-root-synced",
    );
    await validateExistingQuarantineDirectory();
    await scavengeReceiptTemporaries(receiptsDirectory, receipt.clerkIdHash);

    const finalPath = receiptPath(receipt.clerkIdHash);
    const existingReceipt = await metadataOrNull(finalPath);
    if (existingReceipt) assertTrustedReceiptFile(existingReceipt);
    const temporaryPath = path.join(
      receiptsDirectory,
      `.${receipt.clerkIdHash}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      observe?.("receipt-file-synced");
      await handle.close();
      handle = null;
      await rename(temporaryPath, finalPath);
      await syncDirectory(receiptsDirectory, "receipt-directory-synced");
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error) => {
        if (!isMissingFileError(error)) throw error;
      });
    }

    await ensureTrustedReservedDirectory(
      quarantineDirectory,
      "quarantine-directory-created",
      "asset-root-synced",
    );
  }

  async function remove(clerkId: string): Promise<void> {
    const receiptId = identifier(clerkId);
    const directory = await trustedReservedDirectoryOrNull(receiptsDirectory);
    if (!directory) return;
    const target = receiptPath(receiptId);
    const metadata = await metadataOrNull(target);
    if (!metadata) return;
    assertTrustedReceiptFile(metadata);
    try {
      await unlink(target);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await syncDirectory(directory);
  }

  async function quarantineUserDirectory(input: {
    clerkId: string;
    userId: string;
  }): Promise<"moved" | "already-quarantined" | "absent"> {
    const receiptId = identifier(input.clerkId);
    const source = userDirectory(input.userId);
    await ensureTrustedRoot();
    const existingReceiptsDirectory = await metadataOrNull(receiptsDirectory);
    if (existingReceiptsDirectory) assertTrustedDirectory(existingReceiptsDirectory);
    await ensureTrustedReservedDirectory(
      quarantineDirectory,
      "quarantine-directory-created",
      "asset-root-synced",
    );
    const destination = quarantinePath(receiptId);
    const destinationMetadata = await metadataOrNull(destination);
    if (destinationMetadata) {
      assertTrustedQuarantineTarget(destinationMetadata);
      return "already-quarantined";
    }

    const sourceMetadata = await metadataOrNull(source);
    if (!sourceMetadata) return "absent";
    assertTrustedQuarantineTarget(sourceMetadata);

    try {
      await rename(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
        const racedDestination = await metadataOrNull(destination);
        if (racedDestination) {
          assertTrustedQuarantineTarget(racedDestination);
          return "already-quarantined";
        }
        if (code === "ENOENT") return "absent";
      }
      throw error;
    }
    await syncDirectory(assetRoot);
    await syncDirectory(quarantineDirectory);
    return "moved";
  }

  async function quarantineState(
    clerkId: string,
  ): Promise<"absent" | "active" | "cleaned"> {
    const receiptId = identifier(clerkId);
    const directory = await trustedReservedDirectoryOrNull(quarantineDirectory);
    if (!directory) return "absent";
    const metadata = await metadataOrNull(quarantinePath(receiptId));
    if (!metadata) return "absent";
    assertTrustedQuarantineTarget(metadata);
    return await hasCanonicalQuarantineTerminalMarker(receiptId)
      ? "cleaned"
      : "active";
  }

  async function quarantineExists(clerkId: string): Promise<boolean> {
    return await quarantineState(clerkId) !== "absent";
  }

  async function removeQuarantine(clerkId: string): Promise<void> {
    const receiptId = identifier(clerkId);
    const directory = await trustedReservedDirectoryOrNull(quarantineDirectory);
    if (!directory) return;
    const target = quarantinePath(receiptId);
    const metadata = await metadataOrNull(target);
    if (!metadata) return;
    assertTrustedQuarantineTarget(metadata);
    const terminalMarker = quarantineTerminalMarker(receiptId);
    const preserveTerminalMarker = await hasCanonicalQuarantineTerminalMarker(receiptId);
    const directoryHandle = await opendir(target);
    for await (const entry of directoryHandle) {
      const child = path.join(target, entry.name);
      if (preserveTerminalMarker && child === terminalMarker) continue;
      await rm(child, { recursive: true, force: true });
    }
    await syncDirectory(target);

    let markerHandle: Awaited<ReturnType<typeof open>> | null = null;
    let createdMarker = false;
    try {
      if (await hasCanonicalQuarantineTerminalMarker(receiptId)) {
        markerHandle = await open(
          terminalMarker,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
        );
      } else {
        await rm(terminalMarker, { recursive: true, force: true });
        try {
          markerHandle = await open(
            terminalMarker,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
            0o600,
          );
          createdMarker = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!await hasCanonicalQuarantineTerminalMarker(receiptId)) {
            throw invalidTrustBoundary();
          }
          markerHandle = await open(
            terminalMarker,
            fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
          );
        }
      }
      assertTrustedReceiptFile(await markerHandle.stat());
      if (createdMarker) {
        await markerHandle.writeFile(receiptId, "utf8");
      }
      await markerHandle.sync();
      observe?.("quarantine-terminal-file-synced");
    } finally {
      await markerHandle?.close().catch(() => undefined);
    }
    await syncDirectory(target, "quarantine-terminal-directory-synced");
    await syncDirectory(directory);
  }

  return {
    identifier,
    read,
    write,
    remove,
    quarantineUserDirectory,
    quarantineState,
    quarantineExists,
    removeQuarantine,
  };
}
