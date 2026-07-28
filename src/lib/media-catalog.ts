import type { PrismaClient } from "@prisma/client";
import {
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
  objectKey: string;
  version: number;
  attempts: number;
  sizeBytes: number;
  localMtimeMs: number;
};

export type MediaCatalogClaimResult =
  | { status: "claimed"; claim: MediaCatalogClaim }
  | { status: "verified" | "deferred" | "conflict" | "busy" };

type LocalMediaObservation = {
  descriptor: MediaDescriptor;
  localMtimeMs: number;
};

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
        sizeBytes: true,
        localMtimeMs: true,
        nextRetryAt: true,
        lastErrorCode: true,
      },
    });
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
    if (descriptor.objectKey !== objectKey) throw new Error("media catalog key mismatch");
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

    const unchanged =
      row.sizeBytes === BigInt(descriptor.sizeBytes) &&
      row.localMtimeMs === BigInt(localMtimeMs);
    if (row.remoteState === "verified" && unchanged) return { status: "verified" };
    if (row.remoteState === "conflict") return { status: "conflict" };
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
      receipt.objectKey !== claim.objectKey ||
      receipt.identity.area !== claim.identity.area ||
      receipt.identity.filename !== claim.identity.filename ||
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
        remoteState: "verified",
        lastVerifiedAt: now,
        nextRetryAt: null,
        lastErrorCode: null,
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
