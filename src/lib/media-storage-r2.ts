import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MediaChecksumError,
  MediaCollisionError,
  InvalidMediaIdentityError,
  MediaRangeError,
  UnsafeMediaFileError,
  canonicalMediaUrl,
  mediaObjectKey,
  type MaterializedMedia,
  type MediaByteRange,
  type MediaCommitReceipt,
  type MediaDescriptor,
  type MediaIdentity,
  type MediaRead,
  type MediaRemoveResult,
  type MediaStorage,
} from "@/lib/media-storage";
import {
  checkedMediaRange,
  mediaFileDigests,
  mediaContentType,
  mediaWebStream,
  safeMediaFileStat,
  safeMediaIdentity,
} from "@/lib/media-storage-support";

const R2_SINGLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type R2CredentialRole = "read" | "write";

export type R2StorageConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxAttempts: number;
  requestTimeoutMs: number;
  materializeRoot: string;
};

export type R2ObjectHead = {
  sizeBytes: number;
  contentType: string;
  lastModified: Date;
  sha256: string | null;
  etag: string | null;
};

export type R2PutResult = "created" | "precondition_failed";

export type R2ListedObject = {
  key: string;
  sizeBytes: number;
  lastModified: Date;
};

export type R2ObjectPage = {
  objects: R2ListedObject[];
  continuationToken: string | null;
};

export interface RemoteMediaReplicaVerifier {
  verifyReplica(input: {
    identity: MediaIdentity;
    expectedSizeBytes: number;
    expectedSha256: string;
  }): Promise<boolean>;
}

/**
 * Internal seam around the true external S3 dependency. Production uses the
 * AWS SDK adapter below; verification uses an in-memory mock.
 */
export interface R2ObjectClientPort {
  head(key: string): Promise<R2ObjectHead | null>;
  put(input: {
    key: string;
    sourcePath: string;
    sizeBytes: number;
    contentType: string;
    sha256: string;
    contentMd5Base64: string;
  }): Promise<R2PutResult>;
  get(input: {
    key: string;
    start: number;
    end: number;
  }): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number }>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectInventoryPort {
  list(prefix: string, continuationToken?: string): Promise<R2ObjectPage>;
}

export class R2ConfigurationError extends Error {
  constructor() {
    super("R2 storage is not safely configured");
    this.name = "R2ConfigurationError";
  }
}

export class R2VerificationError extends Error {
  constructor() {
    super("R2 object verification failed");
    this.name = "R2VerificationError";
  }
}

export class R2WriteConflictError extends Error {
  constructor() {
    super("R2 conditional write could not be resolved");
    this.name = "R2WriteConflictError";
  }
}

export class R2ObjectTooLargeError extends Error {
  constructor() {
    super("R2 object exceeds the safe single-upload limit");
    this.name = "R2ObjectTooLargeError";
  }
}

type R2Environment = Record<string, string | undefined>;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function credential(
  env: R2Environment,
  role: R2CredentialRole,
  suffix: "ACCESS_KEY_ID" | "SECRET_ACCESS_KEY",
): string {
  return (env[`R2_${role.toUpperCase()}_${suffix}`] ?? "").trim();
}

export function r2StorageConfigFromEnv(
  env: R2Environment = process.env,
  role: R2CredentialRole = "write",
): R2StorageConfig {
  const bucket = (env.R2_BUCKET ?? "").trim();
  const accessKeyId = credential(env, role, "ACCESS_KEY_ID");
  const secretAccessKey = credential(env, role, "SECRET_ACCESS_KEY");
  const accountId = (env.R2_ACCOUNT_ID ?? "").trim();
  const configuredEndpoint = (env.R2_ENDPOINT ?? "").trim();

  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !accessKeyId ||
    secretAccessKey.length < 16 ||
    !/^[a-f0-9]{32}$/.test(accountId)
  ) {
    throw new R2ConfigurationError();
  }

  let endpoint: URL;
  try {
    endpoint = configuredEndpoint
      ? new URL(configuredEndpoint)
      : new URL(`https://${accountId}.r2.cloudflarestorage.com`);
  } catch {
    throw new R2ConfigurationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    endpoint.pathname !== "/" ||
    !new RegExp(
      `^${accountId}(?:\\.(?:eu|fedramp))?\\.r2\\.cloudflarestorage\\.com$`,
    ).test(endpoint.hostname)
  ) {
    throw new R2ConfigurationError();
  }

  const materializeRoot = path.resolve(
    env.R2_MATERIALIZE_ROOT?.trim() ||
      path.join(process.cwd(), ".tmp", "media-r2-materialized"),
  );

  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
    maxAttempts: boundedInteger(env.R2_MAX_ATTEMPTS, 3, 1, 5),
    requestTimeoutMs: boundedInteger(env.R2_REQUEST_TIMEOUT_MS, 120_000, 5_000, 1_800_000),
    materializeRoot,
  };
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return httpStatus(error) === 404 || name === "NotFound" || name === "NoSuchKey";
}

function isPreconditionFailure(error: unknown): boolean {
  return httpStatus(error) === 409 || httpStatus(error) === 412;
}

function bodyAsWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (
    body &&
    typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function"
  ) {
    return (body as { transformToWebStream: () => ReadableStream<Uint8Array> })
      .transformToWebStream();
  }
  if (body instanceof Readable) return mediaWebStream(body);
  throw new R2VerificationError();
}

export class AwsR2ObjectClient implements R2ObjectClientPort {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: R2StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      maxAttempts: config.maxAttempts,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        requestTimeout: config.requestTimeoutMs,
        throwOnRequestTimeout: true,
      }),
    });
  }

  async head(key: string): Promise<R2ObjectHead | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      const sizeBytes = result.ContentLength;
      if (
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes === undefined ||
        sizeBytes <= 0 ||
        !result.LastModified
      ) {
        throw new R2VerificationError();
      }
      const metadataSha256 =
        result.Metadata?.sha256 ??
        result.Metadata?.["heroai-sha256"] ??
        null;
      return {
        sizeBytes,
        contentType: result.ContentType || "application/octet-stream",
        lastModified: result.LastModified,
        sha256: metadataSha256,
        etag: result.ETag ?? null,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(prefix: string, continuationToken?: string): Promise<R2ObjectPage> {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects: R2ListedObject[] = [];
    for (const item of result.Contents ?? []) {
      if (
        !item.Key ||
        !Number.isSafeInteger(item.Size) ||
        item.Size === undefined ||
        item.Size < 0 ||
        !item.LastModified
      ) {
        throw new R2VerificationError();
      }
      objects.push({
        key: item.Key,
        sizeBytes: item.Size,
        lastModified: item.LastModified,
      });
    }
    if (result.IsTruncated && !result.NextContinuationToken) {
      throw new R2VerificationError();
    }
    return {
      objects,
      continuationToken: result.IsTruncated
        ? result.NextContinuationToken!
        : null,
    };
  }

  async put(input: {
    key: string;
    sourcePath: string;
    sizeBytes: number;
    contentType: string;
    sha256: string;
    contentMd5Base64: string;
  }): Promise<R2PutResult> {
    if (input.sizeBytes > R2_SINGLE_UPLOAD_MAX_BYTES) throw new R2ObjectTooLargeError();
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: createReadStream(input.sourcePath),
        ContentLength: input.sizeBytes,
        ContentType: input.contentType,
        ContentMD5: input.contentMd5Base64,
        CacheControl: "private, max-age=86400",
        IfNoneMatch: "*",
        Metadata: {
          "heroai-sha256": input.sha256,
        },
        StorageClass: "STANDARD",
      }));
      return "created";
    } catch (error) {
      if (isPreconditionFailure(error)) return "precondition_failed";
      throw error;
    }
  }

  async get(input: {
    key: string;
    start: number;
    end: number;
  }): Promise<{ body: ReadableStream<Uint8Array>; contentLength: number }> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Range: `bytes=${input.start}-${input.end}`,
    }));
    if (!result.Body || !Number.isSafeInteger(result.ContentLength)) {
      throw new R2VerificationError();
    }
    return {
      body: bodyAsWebStream(result.Body),
      contentLength: result.ContentLength!,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }
}

function verifiedHead(head: R2ObjectHead | null): R2ObjectHead {
  if (
    !head ||
    !Number.isSafeInteger(head.sizeBytes) ||
    head.sizeBytes <= 0 ||
    !head.sha256 ||
    !SHA256_PATTERN.test(head.sha256)
  ) {
    throw new R2VerificationError();
  }
  return head;
}

function validatedIdentity(identity: MediaIdentity): MediaIdentity {
  try {
    return safeMediaIdentity(identity);
  } catch {
    throw new InvalidMediaIdentityError();
  }
}

function sameFileSnapshot(
  before: Awaited<ReturnType<typeof safeMediaFileStat>>,
  after: Awaited<ReturnType<typeof safeMediaFileStat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

export class R2MediaStorageAdapter implements MediaStorage, RemoteMediaReplicaVerifier {
  private readonly client: R2ObjectClientPort;
  private readonly materializeRoot: string;

  constructor(client: R2ObjectClientPort, options: { materializeRoot: string }) {
    this.client = client;
    this.materializeRoot = path.resolve(options.materializeRoot);
  }

  private descriptor(identity: MediaIdentity, head: R2ObjectHead): MediaDescriptor {
    const safe = validatedIdentity(identity);
    return {
      identity: safe,
      objectKey: mediaObjectKey(safe),
      canonicalUrl: canonicalMediaUrl(safe),
      contentType: head.contentType || mediaContentType(safe.filename),
      sizeBytes: head.sizeBytes,
      lastModified: head.lastModified,
    };
  }

  private matchingRemote(
    head: R2ObjectHead | null,
    sizeBytes: number,
    sha256: string,
  ): R2ObjectHead {
    const verified = verifiedHead(head);
    if (verified.sizeBytes !== sizeBytes || verified.sha256 !== sha256) {
      throw new MediaCollisionError();
    }
    return verified;
  }

  async commit(input: {
    identity: MediaIdentity;
    sourcePath: string;
    expectedSha256?: string;
  }): Promise<MediaCommitReceipt> {
    const identity = validatedIdentity(input.identity);
    let before: Awaited<ReturnType<typeof safeMediaFileStat>>;
    try {
      before = await safeMediaFileStat(path.resolve(input.sourcePath));
    } catch {
      throw new UnsafeMediaFileError();
    }

    const sourcePath = path.resolve(input.sourcePath);
    const { sha256, contentMd5Base64 } = await mediaFileDigests(sourcePath);
    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      throw new MediaChecksumError();
    }
    const afterHash = await safeMediaFileStat(sourcePath).catch(() => null);
    if (!afterHash || !sameFileSnapshot(before, afterHash)) throw new UnsafeMediaFileError();

    const key = mediaObjectKey(identity);
    const existing = await this.client.head(key);
    if (existing) {
      const remote = this.matchingRemote(existing, before.size, sha256);
      return { ...this.descriptor(identity, remote), sha256 };
    }

    const result = await this.client.put({
      key,
      sourcePath,
      sizeBytes: before.size,
      contentType: mediaContentType(identity.filename),
      sha256,
      contentMd5Base64,
    });
    const remote = await this.client.head(key);
    if (result === "precondition_failed" && !remote) throw new R2WriteConflictError();
    const verified = this.matchingRemote(remote, before.size, sha256);

    const afterUpload = await safeMediaFileStat(sourcePath).catch(() => null);
    if (!afterUpload || !sameFileSnapshot(before, afterUpload)) {
      throw new UnsafeMediaFileError();
    }
    return { ...this.descriptor(identity, verified), sha256 };
  }

  async stat(identity: MediaIdentity): Promise<MediaDescriptor | null> {
    const safe = validatedIdentity(identity);
    const head = await this.client.head(mediaObjectKey(safe));
    return head ? this.descriptor(safe, verifiedHead(head)) : null;
  }

  async verifyReplica(input: {
    identity: MediaIdentity;
    expectedSizeBytes: number;
    expectedSha256: string;
  }): Promise<boolean> {
    const safe = validatedIdentity(input.identity);
    const head = await this.client.head(mediaObjectKey(safe));
    if (!head) return false;
    this.matchingRemote(head, input.expectedSizeBytes, input.expectedSha256);
    return true;
  }

  async open(identity: MediaIdentity, range?: MediaByteRange): Promise<MediaRead | null> {
    const safe = validatedIdentity(identity);
    const head = await this.client.head(mediaObjectKey(safe));
    if (!head) return null;
    const verified = verifiedHead(head);

    let selected: { start: number; end: number };
    try {
      selected = checkedMediaRange(verified.sizeBytes, range);
    } catch {
      throw new MediaRangeError(verified.sizeBytes);
    }
    const result = await this.client.get({
      key: mediaObjectKey(safe),
      start: selected.start,
      end: selected.end,
    });
    const expectedLength = selected.end - selected.start + 1;
    if (result.contentLength !== expectedLength) throw new R2VerificationError();

    return {
      descriptor: this.descriptor(safe, verified),
      start: selected.start,
      end: selected.end,
      contentLength: expectedLength,
      body: result.body,
    };
  }

  async materialize(identity: MediaIdentity): Promise<MaterializedMedia | null> {
    const safe = validatedIdentity(identity);
    const key = mediaObjectKey(safe);
    const head = await this.client.head(key);
    if (!head) return null;
    const verified = verifiedHead(head);

    await mkdir(this.materializeRoot, { recursive: true });
    const rootStat = await lstat(this.materializeRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new UnsafeMediaFileError();

    const absolutePath = path.join(
      this.materializeRoot,
      `${randomUUID()}-${safe.filename}`,
    );
    const result = await this.client.get({
      key,
      start: 0,
      end: verified.sizeBytes - 1,
    });
    if (result.contentLength !== verified.sizeBytes) throw new R2VerificationError();

    const hash = createHash("sha256");
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(
          result.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        hashStream,
        createWriteStream(absolutePath, { flags: "wx" }),
      );
      const stat = await safeMediaFileStat(absolutePath);
      if (stat.size !== verified.sizeBytes || hash.digest("hex") !== verified.sha256) {
        throw new R2VerificationError();
      }
    } catch (error) {
      await rm(absolutePath, { force: true }).catch(() => {});
      throw error;
    }

    return {
      descriptor: this.descriptor(safe, verified),
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
    const safe = validatedIdentity(input.identity);
    const key = mediaObjectKey(safe);
    const head = await this.client.head(key);
    if (!head) return { status: "missing" };
    const verified = verifiedHead(head);
    if (verified.sha256 !== input.expectedSha256) {
      return { status: "checksum_mismatch", actualSha256: verified.sha256! };
    }

    await this.client.delete(key);
    if (await this.client.head(key)) throw new R2VerificationError();
    return { status: "deleted" };
  }
}

export function createR2MediaStorageFromEnv(
  env: R2Environment = process.env,
  role: R2CredentialRole = "write",
): R2MediaStorageAdapter {
  const config = r2StorageConfigFromEnv(env, role);
  return new R2MediaStorageAdapter(
    new AwsR2ObjectClient(config),
    { materializeRoot: config.materializeRoot },
  );
}
