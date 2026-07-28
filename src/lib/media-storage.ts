import {
  constants as fsConstants,
  createReadStream,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import {
  checkedMediaRange,
  mediaContentType,
  mediaWebStream,
  safeMediaFileStat,
  safeMediaIdentity,
  sha256MediaBytes,
  sha256MediaFile,
} from "@/lib/media-storage-support";

export const MEDIA_AREAS = ["renders", "stocks"] as const;

export type MediaArea = (typeof MEDIA_AREAS)[number];

export type MediaIdentity = {
  area: MediaArea;
  filename: string;
};

export type MediaDescriptor = {
  identity: MediaIdentity;
  objectKey: string;
  canonicalUrl: string;
  contentType: string;
  sizeBytes: number;
  lastModified: Date;
};

export type MediaCommitReceipt = MediaDescriptor & {
  sha256: string;
};

export type MediaByteRange = {
  start: number;
  end?: number;
};

export type MediaRead = {
  descriptor: MediaDescriptor;
  start: number;
  end: number;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
};

export type MaterializedMedia = {
  descriptor: MediaDescriptor;
  absolutePath: string;
  release: () => Promise<void>;
};

export type MediaRemoveResult =
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "checksum_mismatch"; actualSha256: string };

/**
 * The storage seam for customer media.
 *
 * Invariants:
 * - identities are flat filenames inside a known media area;
 * - commits are immutable and idempotent for identical bytes;
 * - a different payload can never overwrite an existing identity;
 * - removal always requires the caller's reviewed SHA-256;
 * - byte-range ends are inclusive.
 */
export interface MediaStorage {
  commit(input: {
    identity: MediaIdentity;
    sourcePath: string;
    expectedSha256?: string;
  }): Promise<MediaCommitReceipt>;
  stat(identity: MediaIdentity): Promise<MediaDescriptor | null>;
  open(identity: MediaIdentity, range?: MediaByteRange): Promise<MediaRead | null>;
  materialize(identity: MediaIdentity): Promise<MaterializedMedia | null>;
  remove(input: {
    identity: MediaIdentity;
    expectedSha256: string;
  }): Promise<MediaRemoveResult>;
}

export class InvalidMediaIdentityError extends Error {
  constructor() {
    super("invalid media identity");
    this.name = "InvalidMediaIdentityError";
  }
}

export class UnsafeMediaFileError extends Error {
  constructor() {
    super("media file is not a non-empty regular file");
    this.name = "UnsafeMediaFileError";
  }
}

export class MediaCollisionError extends Error {
  constructor() {
    super("media identity already contains different bytes");
    this.name = "MediaCollisionError";
  }
}

export class MediaChecksumError extends Error {
  constructor() {
    super("media checksum does not match");
    this.name = "MediaChecksumError";
  }
}

export class MediaRangeError extends Error {
  readonly totalSize: number;

  constructor(totalSize: number) {
    super("invalid media byte range");
    this.name = "MediaRangeError";
    this.totalSize = totalSize;
  }
}

function safeIdentity(identity: MediaIdentity): MediaIdentity {
  try {
    return safeMediaIdentity(identity);
  } catch {
    throw new InvalidMediaIdentityError();
  }
}

export function mediaObjectKey(identity: MediaIdentity): string {
  const safe = safeIdentity(identity);
  return `media/v1/${safe.area}/${safe.filename}`;
}

export function canonicalMediaUrl(identity: MediaIdentity): string {
  const safe = safeIdentity(identity);
  return `/api/${safe.area}/${encodeURIComponent(safe.filename)}`;
}

async function safeRegularFile(filePath: string) {
  try {
    return await safeMediaFileStat(filePath);
  } catch {
    throw new UnsafeMediaFileError();
  }
}

function checkedRange(totalSize: number, range?: MediaByteRange): { start: number; end: number } {
  try {
    return checkedMediaRange(totalSize, range);
  } catch {
    throw new MediaRangeError(totalSize);
  }
}

function webStream(stream: Readable): ReadableStream<Uint8Array> {
  return mediaWebStream(stream);
}

type LocalMediaRoots = Record<MediaArea, string>;

export function defaultLocalMediaRoots(cwd = process.cwd()): LocalMediaRoots {
  return {
    renders: path.join(cwd, "public", "renders"),
    stocks: path.join(cwd, "stocks"),
  };
}

export class LocalMediaStorageAdapter implements MediaStorage {
  private readonly roots: LocalMediaRoots;

  constructor(roots: LocalMediaRoots = defaultLocalMediaRoots()) {
    this.roots = {
      renders: path.resolve(roots.renders),
      stocks: path.resolve(roots.stocks),
    };
  }

  private async safeRoot(area: MediaArea): Promise<string> {
    const root = this.roots[area];
    await mkdir(root, { recursive: true });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UnsafeMediaFileError();
    return root;
  }

  private async destination(identity: MediaIdentity): Promise<string> {
    const safe = safeIdentity(identity);
    const root = await this.safeRoot(safe.area);
    const destination = path.resolve(root, safe.filename);
    if (path.dirname(destination) !== root) throw new InvalidMediaIdentityError();
    return destination;
  }

  private descriptor(
    identity: MediaIdentity,
    sizeBytes: number,
    lastModified: Date,
  ): MediaDescriptor {
    return {
      identity: safeIdentity(identity),
      objectKey: mediaObjectKey(identity),
      canonicalUrl: canonicalMediaUrl(identity),
      contentType: mediaContentType(identity.filename),
      sizeBytes,
      lastModified,
    };
  }

  async commit(input: {
    identity: MediaIdentity;
    sourcePath: string;
    expectedSha256?: string;
  }): Promise<MediaCommitReceipt> {
    const identity = safeIdentity(input.identity);
    const sourcePath = path.resolve(input.sourcePath);
    const destination = await this.destination(identity);
    await safeRegularFile(sourcePath);

    const sourceSha256 = await sha256MediaFile(sourcePath);
    if (input.expectedSha256 && input.expectedSha256 !== sourceSha256) {
      throw new MediaChecksumError();
    }

    if (sourcePath !== destination) {
      let copied = false;
      try {
        await copyFile(sourcePath, destination, fsConstants.COPYFILE_EXCL);
        copied = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      try {
        await safeRegularFile(destination);
        const destinationSha256 = await sha256MediaFile(destination);
        if (destinationSha256 !== sourceSha256) throw new MediaCollisionError();
      } catch (error) {
        if (copied) await rm(destination, { force: true }).catch(() => {});
        throw error;
      }
    }

    const stat = await safeRegularFile(destination);
    const sha256 = sourcePath === destination ? sourceSha256 : await sha256MediaFile(destination);
    if (sha256 !== sourceSha256) throw new MediaChecksumError();

    return {
      ...this.descriptor(identity, stat.size, stat.mtime),
      sha256,
    };
  }

  async stat(identity: MediaIdentity): Promise<MediaDescriptor | null> {
    const safe = safeIdentity(identity);
    const filePath = await this.destination(safe);
    const stat = await lstat(filePath).catch(() => null);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
      throw new UnsafeMediaFileError();
    }
    return this.descriptor(safe, stat.size, stat.mtime);
  }

  async open(identity: MediaIdentity, range?: MediaByteRange): Promise<MediaRead | null> {
    const safe = safeIdentity(identity);
    const filePath = await this.destination(safe);
    const stat = await lstat(filePath).catch(() => null);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new UnsafeMediaFileError();

    const { start, end } = checkedRange(stat.size, range);
    return {
      descriptor: this.descriptor(safe, stat.size, stat.mtime),
      start,
      end,
      contentLength: end - start + 1,
      body: webStream(createReadStream(filePath, { start, end })),
    };
  }

  async materialize(identity: MediaIdentity): Promise<MaterializedMedia | null> {
    const safe = safeIdentity(identity);
    const absolutePath = await this.destination(safe);
    const stat = await lstat(absolutePath).catch(() => null);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new UnsafeMediaFileError();

    return {
      descriptor: this.descriptor(safe, stat.size, stat.mtime),
      absolutePath,
      release: async () => {},
    };
  }

  async remove(input: {
    identity: MediaIdentity;
    expectedSha256: string;
  }): Promise<MediaRemoveResult> {
    const safe = safeIdentity(input.identity);
    const filePath = await this.destination(safe);
    const stat = await lstat(filePath).catch(() => null);
    if (!stat) return { status: "missing" };
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new UnsafeMediaFileError();

    const actualSha256 = await sha256MediaFile(filePath);
    if (actualSha256 !== input.expectedSha256) {
      return { status: "checksum_mismatch", actualSha256 };
    }
    await rm(filePath);
    return { status: "deleted" };
  }
}

type MemoryRecord = {
  bytes: Uint8Array;
  lastModified: Date;
};

/**
 * Test adapter at the same seam as local/R2 storage. It intentionally exposes no
 * test-only mutation methods; callers exercise the same interface production uses.
 */
export class InMemoryMediaStorageAdapter implements MediaStorage {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly materializeRoot: string;

  constructor(materializeRoot: string) {
    this.materializeRoot = path.resolve(materializeRoot);
  }

  private descriptor(identity: MediaIdentity, record: MemoryRecord): MediaDescriptor {
    return {
      identity: safeIdentity(identity),
      objectKey: mediaObjectKey(identity),
      canonicalUrl: canonicalMediaUrl(identity),
      contentType: mediaContentType(identity.filename),
      sizeBytes: record.bytes.byteLength,
      lastModified: record.lastModified,
    };
  }

  async commit(input: {
    identity: MediaIdentity;
    sourcePath: string;
    expectedSha256?: string;
  }): Promise<MediaCommitReceipt> {
    const identity = safeIdentity(input.identity);
    await safeRegularFile(input.sourcePath);
    const bytes = new Uint8Array(await readFile(input.sourcePath));
    const sha256 = sha256MediaBytes(bytes);
    if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new MediaChecksumError();

    const key = mediaObjectKey(identity);
    const existing = this.records.get(key);
    if (existing && sha256MediaBytes(existing.bytes) !== sha256) throw new MediaCollisionError();

    const record = existing ?? { bytes, lastModified: new Date() };
    this.records.set(key, record);
    return { ...this.descriptor(identity, record), sha256 };
  }

  async stat(identity: MediaIdentity): Promise<MediaDescriptor | null> {
    const safe = safeIdentity(identity);
    const record = this.records.get(mediaObjectKey(safe));
    return record ? this.descriptor(safe, record) : null;
  }

  async open(identity: MediaIdentity, range?: MediaByteRange): Promise<MediaRead | null> {
    const safe = safeIdentity(identity);
    const record = this.records.get(mediaObjectKey(safe));
    if (!record) return null;

    const { start, end } = checkedRange(record.bytes.byteLength, range);
    const bytes = record.bytes.slice(start, end + 1);
    return {
      descriptor: this.descriptor(safe, record),
      start,
      end,
      contentLength: bytes.byteLength,
      body: webStream(Readable.from([bytes])),
    };
  }

  async materialize(identity: MediaIdentity): Promise<MaterializedMedia | null> {
    const safe = safeIdentity(identity);
    const record = this.records.get(mediaObjectKey(safe));
    if (!record) return null;

    const areaRoot = path.join(this.materializeRoot, safe.area);
    await mkdir(areaRoot, { recursive: true });
    const absolutePath = path.resolve(areaRoot, safe.filename);
    if (path.dirname(absolutePath) !== areaRoot) throw new InvalidMediaIdentityError();

    await writeFile(absolutePath, record.bytes);
    return {
      descriptor: this.descriptor(safe, record),
      absolutePath,
      release: async () => {
        await rm(absolutePath, { force: true });
      },
    };
  }

  async remove(input: {
    identity: MediaIdentity;
    expectedSha256: string;
  }): Promise<MediaRemoveResult> {
    const identity = safeIdentity(input.identity);
    const key = mediaObjectKey(identity);
    const record = this.records.get(key);
    if (!record) return { status: "missing" };

    const actualSha256 = sha256MediaBytes(record.bytes);
    if (actualSha256 !== input.expectedSha256) {
      return { status: "checksum_mismatch", actualSha256 };
    }
    this.records.delete(key);
    return { status: "deleted" };
  }
}
