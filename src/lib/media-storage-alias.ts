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

export class MediaAliasMutationBlockedError extends Error {
  constructor() {
    super("media alias adapter is read-only");
    this.name = "MediaAliasMutationBlockedError";
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
