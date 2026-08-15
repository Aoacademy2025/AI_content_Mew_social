import type { PrismaClient } from "@prisma/client";
import {
  contentAddressedMediaIdentity,
  MediaCollisionError,
  mediaObjectKey,
  type MediaCommitReceipt,
  type MediaDescriptor,
  type MediaIdentity,
} from "@/lib/media-storage";
import { prisma } from "@/lib/prisma";

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

export type MediaCatalogClaim = {
  id: string;
  identity: MediaIdentity;
  remoteIdentity: MediaIdentity;
  objectKey: string;
  version: number;
  attempts: number;
  sizeBytes: number;
  localMtimeMs: number;
};

export type MediaCatalogClaimResult =
  | { status: "claimed"; claim: MediaCatalogClaim }
  | { status: "verified" | "deferred" | "conflict" | "busy" };

export type MediaCatalogRemoteGcRow = {
  id: string;
  area: string;
  filename: string;
  objectKey: string;
  sizeBytes: bigint;
  sha256: string | null;
  remoteFilename: string | null;
  remoteState: string;
  localState: string;
  localMtimeMs: bigint | null;
  producedAt: Date;
  nextRetryAt: Date | null;
  lastErrorCode: string | null;
  version: number;
};

export type MediaCatalogRemoteGcClaim = {
  id: string;
  version: number;
};

export type MediaCatalogRemoteIdentityRow = {
  area: string;
  filename: string;
  remoteFilename: string | null;
  remoteState: string;
};

export type MediaCatalogFailedLocalRow = {
  id: string;
  area: string;
  filename: string;
  objectKey: string;
  sizeBytes: bigint;
  sha256: string | null;
  remoteFilename: string | null;
  r2Etag: string | null;
  remoteState: string;
  localState: string;
  lastVerifiedAt: Date | null;
  nextRetryAt: Date | null;
  lastErrorCode: string | null;
  updatedAt: Date;
  version: number;
};

export type MediaCatalogFailedLocalClaim = {
  id: string;
  version: number;
};

type LocalMediaObservation = {
  descriptor: MediaDescriptor;
  localMtimeMs: number;
  remoteIdentity?: MediaIdentity;
};

class MediaCatalogCompareAndSetError extends Error {}

function safeInteger(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("media catalog integer is unsafe");
  return number;
}

function safeErrorCode(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : "UnknownError";
}

function retryAt(now: Date, attempts: number): Date {
  const delay = Math.min(
    MAX_RETRY_MS,
    30_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
  );
  return new Date(now.getTime() + delay);
}

export class MediaCatalog {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = prisma) {
    this.db = db;
  }

  async inspect(identity: MediaIdentity) {
    const objectKey = mediaObjectKey(identity);
    return this.db.mediaObject.findUnique({
      where: { objectKey },
      select: {
        remoteState: true,
        localState: true,
        sizeBytes: true,
        sha256: true,
        remoteFilename: true,
        localMtimeMs: true,
        lastVerifiedAt: true,
        nextRetryAt: true,
        lastErrorCode: true,
      },
    });
  }

  async inspectVerifiedRemoteOnly(
    identity: MediaIdentity,
  ): Promise<{ localMtimeMs: number } | null> {
    const row = await this.inspect(identity);
    if (
      !row ||
      !["verified", "delete_pending", "deleted"].includes(row.remoteState) ||
      row.localState !== "evicted" ||
      !row.lastVerifiedAt ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      row.sizeBytes <= BigInt(0) ||
      row.localMtimeMs === null
    ) {
      return null;
    }

    if (row.remoteFilename) {
      const expected = contentAddressedMediaIdentity(identity, row.sha256);
      if (row.remoteFilename !== expected.filename) return null;
    } else if (identity.area !== "renders") {
      // Legacy render aliases were immutable and SHA-verified before eviction.
      // Mutable legacy stock aliases are never valid remote-only replicas.
      return null;
    }

    return { localMtimeMs: safeInteger(row.localMtimeMs) };
  }

  /**
   * Remote GC groups these logical catalog rows by their physical R2 object.
   * A published remote filename remains relevant while replacement bytes are
   * uploading, so those rows are included even when they are not verified.
   */
  async remoteGcInventory(): Promise<MediaCatalogRemoteGcRow[]> {
    return this.db.mediaObject.findMany({
      where: {
        sha256: { not: null },
        OR: [
          { remoteFilename: { not: null } },
          { remoteState: { in: ["verified", "delete_pending"] } },
        ],
      },
      select: {
        id: true,
        area: true,
        filename: true,
        objectKey: true,
        sizeBytes: true,
        sha256: true,
        remoteFilename: true,
        remoteState: true,
        localState: true,
        localMtimeMs: true,
        producedAt: true,
        nextRetryAt: true,
        lastErrorCode: true,
        version: true,
      },
      orderBy: { objectKey: "asc" },
    });
  }

  /**
   * Broader than remoteGcInventory by design: orphan protection must retain
   * every published remote identity even when its checksum catalog fields are
   * incomplete. A malformed active identity makes orphan GC fail closed.
   */
  async r2OrphanProtectionInventory(): Promise<MediaCatalogRemoteIdentityRow[]> {
    return this.db.mediaObject.findMany({
      where: {
        remoteState: { not: "deleted" },
        OR: [
          { remoteFilename: { not: null } },
          { remoteState: { in: ["verified", "delete_pending"] } },
        ],
      },
      select: {
        area: true,
        filename: true,
        remoteFilename: true,
        remoteState: true,
      },
      orderBy: { objectKey: "asc" },
    });
  }

  async stageRemoteDelete(
    rows: readonly MediaCatalogRemoteGcClaim[],
    eligibleAt: Date,
  ): Promise<MediaCatalogRemoteGcClaim[] | null> {
    if (rows.length === 0 || !Number.isFinite(eligibleAt.getTime())) return null;
    try {
      return await this.db.$transaction(async (tx) => {
        const claims: MediaCatalogRemoteGcClaim[] = [];
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "verified",
              localState: "evicted",
            },
            data: {
              remoteState: "delete_pending",
              nextRetryAt: eligibleAt,
              lastErrorCode: "RemoteGcPending",
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
          claims.push({ id: row.id, version: row.version + 1 });
        }
        return claims;
      });
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return null;
      throw error;
    }
  }

  /**
   * Corrects a policy-derived recovery deadline without bypassing an
   * operational retry or an in-progress delete lease.
   */
  async rebaseRemoteDeletePending(
    rows: readonly MediaCatalogRemoteGcClaim[],
    eligibleAt: Date,
  ): Promise<MediaCatalogRemoteGcClaim[] | null> {
    if (rows.length === 0 || !Number.isFinite(eligibleAt.getTime())) return null;
    try {
      return await this.db.$transaction(async (tx) => {
        const claims: MediaCatalogRemoteGcClaim[] = [];
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "delete_pending",
              localState: "evicted",
              OR: [
                { lastErrorCode: null },
                { lastErrorCode: { in: ["RemoteGcPending", "RemoteGcPending7d"] } },
              ],
            },
            data: {
              nextRetryAt: eligibleAt,
              lastErrorCode: "RemoteGcPending",
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
          claims.push({ id: row.id, version: row.version + 1 });
        }
        return claims;
      });
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return null;
      throw error;
    }
  }

  async claimRemoteDelete(
    rows: readonly MediaCatalogRemoteGcClaim[],
    now: Date,
    leaseUntil: Date,
  ): Promise<MediaCatalogRemoteGcClaim[] | null> {
    if (
      rows.length === 0 ||
      !Number.isFinite(now.getTime()) ||
      !Number.isFinite(leaseUntil.getTime()) ||
      leaseUntil.getTime() <= now.getTime()
    ) {
      return null;
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const claims: MediaCatalogRemoteGcClaim[] = [];
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "delete_pending",
              localState: "evicted",
              nextRetryAt: { lte: now },
            },
            data: {
              nextRetryAt: leaseUntil,
              lastErrorCode: "RemoteGcDeleting",
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
          claims.push({ id: row.id, version: row.version + 1 });
        }
        return claims;
      });
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return null;
      throw error;
    }
  }

  async markRemoteDeleted(
    rows: readonly MediaCatalogRemoteGcClaim[],
    now: Date,
  ): Promise<boolean> {
    if (rows.length === 0 || !Number.isFinite(now.getTime())) return false;
    try {
      await this.db.$transaction(async (tx) => {
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "delete_pending",
              localState: "evicted",
              lastErrorCode: "RemoteGcDeleting",
            },
            data: {
              remoteState: "deleted",
              nextRetryAt: null,
              lastErrorCode: "RemoteGcDeleted",
              version: { increment: 1 },
              updatedAt: now,
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return false;
      throw error;
    }
  }

  async deferRemoteDelete(
    rows: readonly MediaCatalogRemoteGcClaim[],
    retryAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    if (rows.length === 0 || !Number.isFinite(retryAt.getTime())) return false;
    const code = safeErrorCode(errorCode);
    try {
      await this.db.$transaction(async (tx) => {
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "delete_pending",
              localState: "evicted",
              lastErrorCode: "RemoteGcDeleting",
            },
            data: {
              nextRetryAt: retryAt,
              lastErrorCode: code,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return false;
      throw error;
    }
  }

  async restoreRemoteDeletePending(
    rows: readonly MediaCatalogRemoteGcClaim[],
  ): Promise<boolean> {
    if (rows.length === 0) return false;
    try {
      await this.db.$transaction(async (tx) => {
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "delete_pending",
              localState: "evicted",
            },
            data: {
              remoteState: "verified",
              nextRetryAt: null,
              lastErrorCode: null,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return false;
      throw error;
    }
  }

  /**
   * Failed local observations are not remote-GC candidates. A bounded
   * reconciler may classify one as abandoned only after independently proving
   * that the local path is missing and the reference graph has no owners.
   */
  async failedLocalInventory(): Promise<MediaCatalogFailedLocalRow[]> {
    return this.db.mediaObject.findMany({
      where: {
        remoteState: "failed",
        localState: "present",
      },
      select: {
        id: true,
        area: true,
        filename: true,
        objectKey: true,
        sizeBytes: true,
        sha256: true,
        remoteFilename: true,
        r2Etag: true,
        remoteState: true,
        localState: true,
        lastVerifiedAt: true,
        nextRetryAt: true,
        lastErrorCode: true,
        updatedAt: true,
        version: true,
      },
      orderBy: { objectKey: "asc" },
    });
  }

  async abandonMissingFailed(
    rows: readonly MediaCatalogFailedLocalClaim[],
  ): Promise<boolean> {
    if (rows.length === 0) return false;
    try {
      await this.db.$transaction(async (tx) => {
        for (const row of rows) {
          const updated = await tx.mediaObject.updateMany({
            where: {
              id: row.id,
              version: row.version,
              remoteState: "failed",
              localState: "present",
              sha256: null,
              remoteFilename: null,
              r2Etag: null,
              lastVerifiedAt: null,
            },
            data: {
              remoteState: "abandoned",
              localState: "missing",
              nextRetryAt: null,
              lastErrorCode: "LocalMediaMissingUnreferenced",
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new MediaCatalogCompareAndSetError();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof MediaCatalogCompareAndSetError) return false;
      throw error;
    }
  }

  async claim(
    observation: LocalMediaObservation,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<MediaCatalogClaimResult> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 60 * 60 * 1000) {
      throw new Error("invalid media catalog lease");
    }

    const { descriptor } = observation;
    const objectKey = mediaObjectKey(descriptor.identity);
    const remoteIdentity = observation.remoteIdentity ?? descriptor.identity;
    if (descriptor.objectKey !== objectKey) throw new Error("media catalog key mismatch");
    if (remoteIdentity.area !== descriptor.identity.area) {
      throw new Error("media catalog remote area mismatch");
    }
    mediaObjectKey(remoteIdentity);
    const localMtimeMs = Math.trunc(observation.localMtimeMs);
    if (
      !Number.isSafeInteger(descriptor.sizeBytes) ||
      descriptor.sizeBytes <= 0 ||
      !Number.isSafeInteger(localMtimeMs) ||
      localMtimeMs < 0
    ) {
      throw new Error("invalid local media observation");
    }

    const row = await this.db.mediaObject.upsert({
      where: { objectKey },
      create: {
        area: descriptor.identity.area,
        filename: descriptor.identity.filename,
        objectKey,
        contentType: descriptor.contentType,
        sizeBytes: BigInt(descriptor.sizeBytes),
        localMtimeMs: BigInt(localMtimeMs),
        localState: "present",
        producedAt: descriptor.lastModified,
      },
      update: {
        localState: "present",
      },
    });

    const storedRemoteFilename = row.remoteFilename ?? row.filename;
    const remoteTargetChanged = storedRemoteFilename !== remoteIdentity.filename;
    const unchanged =
      row.sizeBytes === BigInt(descriptor.sizeBytes) &&
      row.localMtimeMs === BigInt(localMtimeMs) &&
      !remoteTargetChanged;
    if (row.remoteState === "verified" && unchanged) return { status: "verified" };
    if (row.remoteState === "conflict" && !remoteTargetChanged) {
      return { status: "conflict" };
    }
    if (
      (row.remoteState === "uploading" || row.remoteState === "failed") &&
      row.nextRetryAt &&
      row.nextRetryAt.getTime() > now.getTime()
    ) {
      return { status: "deferred" };
    }

    const updated = await this.db.mediaObject.updateMany({
      where: {
        id: row.id,
        version: row.version,
      },
      data: {
        contentType: descriptor.contentType,
        sizeBytes: BigInt(descriptor.sizeBytes),
        localMtimeMs: BigInt(localMtimeMs),
        remoteState: "uploading",
        localState: "present",
        nextRetryAt: new Date(now.getTime() + leaseMs),
        lastErrorCode: null,
        attempts: { increment: 1 },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) return { status: "busy" };

    return {
      status: "claimed",
      claim: {
        id: row.id,
        identity: {
          area: descriptor.identity.area,
          filename: descriptor.identity.filename,
        },
        remoteIdentity: {
          area: remoteIdentity.area,
          filename: remoteIdentity.filename,
        },
        objectKey,
        version: row.version + 1,
        attempts: row.attempts + 1,
        sizeBytes: descriptor.sizeBytes,
        localMtimeMs,
      },
    };
  }

  async markVerified(
    claim: MediaCatalogClaim,
    receipt: MediaCommitReceipt,
    now = new Date(),
  ): Promise<boolean> {
    if (
      receipt.objectKey !== mediaObjectKey(claim.remoteIdentity) ||
      receipt.identity.area !== claim.remoteIdentity.area ||
      receipt.identity.filename !== claim.remoteIdentity.filename ||
      receipt.sizeBytes !== claim.sizeBytes
    ) {
      throw new Error("media catalog receipt mismatch");
    }

    const updated = await this.db.mediaObject.updateMany({
      where: {
        id: claim.id,
        version: claim.version,
        remoteState: "uploading",
      },
      data: {
        sha256: receipt.sha256,
        remoteFilename: receipt.identity.filename,
        remoteState: "verified",
        lastVerifiedAt: now,
        nextRetryAt: null,
        lastErrorCode: null,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async resolveRemoteIdentity(identity: MediaIdentity): Promise<MediaIdentity | null> {
    const objectKey = mediaObjectKey(identity);
    const row = await this.db.mediaObject.findUnique({
      where: { objectKey },
      select: {
        area: true,
        filename: true,
        remoteFilename: true,
        remoteState: true,
      },
    });
    if (!row || (!row.remoteFilename && row.remoteState !== "verified")) return null;
    if (row.area !== identity.area || row.filename !== identity.filename) {
      throw new Error("media catalog identity mismatch");
    }
    return {
      area: identity.area,
      filename: row.remoteFilename ?? row.filename,
    };
  }

  async markLocalEvicted(input: {
    identity: MediaIdentity;
    sizeBytes: number;
    localMtimeMs: number;
    sha256: string;
    remoteFilename: string | null;
  }): Promise<boolean> {
    const updated = await this.db.mediaObject.updateMany({
      where: {
        objectKey: mediaObjectKey(input.identity),
        remoteState: "verified",
        localState: "present",
        sizeBytes: BigInt(input.sizeBytes),
        localMtimeMs: BigInt(Math.round(input.localMtimeMs)),
        sha256: input.sha256,
        remoteFilename: input.remoteFilename,
      },
      data: {
        localState: "evicted",
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async markLocalPresent(input: {
    identity: MediaIdentity;
    sizeBytes: number;
    localMtimeMs: number;
    sha256: string;
    remoteFilename: string | null;
  }): Promise<boolean> {
    const updated = await this.db.mediaObject.updateMany({
      where: {
        objectKey: mediaObjectKey(input.identity),
        remoteState: "verified",
        localState: "evicted",
        sizeBytes: BigInt(input.sizeBytes),
        localMtimeMs: BigInt(Math.round(input.localMtimeMs)),
        sha256: input.sha256,
        remoteFilename: input.remoteFilename,
      },
      data: {
        localState: "present",
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async markFailed(
    claim: MediaCatalogClaim,
    error: unknown,
    now = new Date(),
  ): Promise<boolean> {
    const collision = error instanceof MediaCollisionError;
    const code = safeErrorCode(error instanceof Error ? error.name : "UnknownError");
    const updated = await this.db.mediaObject.updateMany({
      where: {
        id: claim.id,
        version: claim.version,
        remoteState: "uploading",
      },
      data: {
        remoteState: collision ? "conflict" : "failed",
        nextRetryAt: collision ? null : retryAt(now, claim.attempts),
        lastErrorCode: code,
        version: { increment: 1 },
      },
    });
    return updated.count === 1;
  }
}
