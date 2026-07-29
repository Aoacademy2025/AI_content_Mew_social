import {
  canonicalMediaUrl,
  type MaterializedMedia,
  type MediaByteRange,
  type MediaCommitReceipt,
  type MediaDescriptor,
  type MediaIdentity,
  type MediaRead,
  type MediaRemoveResult,
  type MediaStorage,
} from "@/lib/media-storage";

export interface MediaAliasResolver {
  resolveRemoteIdentity(identity: MediaIdentity): Promise<MediaIdentity | null>;
}

export interface MediaAliasCatalogInspection {
  inspect(identity: MediaIdentity): Promise<{
    remoteState: string;
    sizeBytes: bigint;
    remoteFilename: string | null;
    localMtimeMs: bigint | null;
  } | null>;
}

export class MediaAliasMutationBlockedError extends Error {
  constructor() {
    super("media alias adapter is read-only");
    this.name = "MediaAliasMutationBlockedError";
  }
}

/**
 * Publishes a remote alias only while it still describes the current local
 * observation. Direct-to-local producers can create or replace a logical file
 * before the reconciliation worker updates its catalog row; returning null in
 * that window makes r2-local reads fall back to the newer local bytes.
 *
 * Once a local copy is evicted, the last verified remote alias remains readable.
 */
export class LocalFreshnessMediaAliasResolver implements MediaAliasResolver {
  private readonly aliases: MediaAliasCatalogInspection;
  private readonly local: Pick<MediaStorage, "stat">;

  constructor(
    aliases: MediaAliasCatalogInspection,
    local: Pick<MediaStorage, "stat">,
  ) {
    this.aliases = aliases;
    this.local = local;
  }

  async resolveRemoteIdentity(identity: MediaIdentity): Promise<MediaIdentity | null> {
    const [row, descriptor] = await Promise.all([
      this.aliases.inspect(identity),
      this.local.stat(identity),
    ]);
    if (!row || row.remoteState !== "verified") return null;
    if (
      descriptor &&
      (
        row.sizeBytes !== BigInt(descriptor.sizeBytes) ||
        row.localMtimeMs !== BigInt(Math.trunc(descriptor.lastModified.getTime()))
      )
    ) {
      return null;
    }
    return {
      area: identity.area,
      filename: row.remoteFilename ?? identity.filename,
    };
  }
}

function logicalDescriptor(
  descriptor: MediaDescriptor,
  logicalIdentity: MediaIdentity,
): MediaDescriptor {
  return {
    ...descriptor,
    identity: logicalIdentity,
    canonicalUrl: canonicalMediaUrl(logicalIdentity),
  };
}

/**
 * Read adapter that resolves a stable logical URL through the catalog before
 * touching an immutable physical object.
 *
 * Alias mutation stays in the verified backfill/write transaction; exposing it
 * here would let a reader accidentally publish an unverified blob.
 */
export class AliasResolvingMediaStorage implements MediaStorage {
  private readonly physical: MediaStorage;
  private readonly aliases: MediaAliasResolver;

  constructor(physical: MediaStorage, aliases: MediaAliasResolver) {
    this.physical = physical;
    this.aliases = aliases;
  }

  private resolve(identity: MediaIdentity): Promise<MediaIdentity | null> {
    return this.aliases.resolveRemoteIdentity(identity);
  }

  async stat(identity: MediaIdentity): Promise<MediaDescriptor | null> {
    const physicalIdentity = await this.resolve(identity);
    if (!physicalIdentity) return null;
    const descriptor = await this.physical.stat(physicalIdentity);
    return descriptor ? logicalDescriptor(descriptor, identity) : null;
  }

  async open(identity: MediaIdentity, range?: MediaByteRange): Promise<MediaRead | null> {
    const physicalIdentity = await this.resolve(identity);
    if (!physicalIdentity) return null;
    const read = await this.physical.open(physicalIdentity, range);
    return read
      ? {
          ...read,
          descriptor: logicalDescriptor(read.descriptor, identity),
        }
      : null;
  }

  async materialize(identity: MediaIdentity): Promise<MaterializedMedia | null> {
    const physicalIdentity = await this.resolve(identity);
    if (!physicalIdentity) return null;
    const materialized = await this.physical.materialize(physicalIdentity);
    return materialized
      ? {
          ...materialized,
          descriptor: logicalDescriptor(materialized.descriptor, identity),
        }
      : null;
  }

  commit(_input: {
    identity: MediaIdentity;
    sourcePath: string;
    expectedSha256?: string;
  }): Promise<MediaCommitReceipt> {
    return Promise.reject(new MediaAliasMutationBlockedError());
  }

  remove(_input: {
    identity: MediaIdentity;
    expectedSha256: string;
  }): Promise<MediaRemoveResult> {
    return Promise.reject(new MediaAliasMutationBlockedError());
  }
}
