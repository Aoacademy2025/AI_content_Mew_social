import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HERO_VOICE_CANARY_DATABASE_MARKER_KEY = "hero_voice_canary_database_marker";
export const HERO_VOICE_CANARY_DATABASE_MARKER_VALUE = "hero-voice-canary-v1";

export type DeletionArtifactRootKind = "user_voice_reference" | "clone_generated" | "review_private";

export type HeroVoiceCanaryStorageContext = Readonly<{
  canaryRoot: string;
  databasePath: string;
  userVoiceRoot: string;
  generatedRoot: string;
  reviewRoot: string;
  quarantineRoot: string;
  uploadStagingRoot: string;
}>;

export type HeroVoiceCanaryFileOperationStep =
  | "after-open-before-stability"
  | "after-create"
  | "after-write"
  | "before-fsync"
  | "after-fsync"
  | "before-rename"
  | "after-rename"
  | "before-unlink"
  | "before-rmdir";

type FileOperationObserver = (step: HeroVoiceCanaryFileOperationStep, opaqueBasename: string) => void;
let fileOperationObserver: FileOperationObserver | undefined;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const REFERENCE_KEY = /^[0-9A-Fa-f-]{36}\.wav$/u;
const GENERATED_KEY = /^clone(?:-part)?-[A-Za-z0-9_-]{1,80}(?:-[1-9][0-9]*)?\.wav$/u;
const REVIEW_BASENAME = /^[A-Za-z0-9_-]{1,120}(?:\.(?:wav|json|bin))?$/u;
const MAX_REVIEW_DEPTH = 4;

export class HeroVoiceCanaryStorageError extends Error {
  readonly code = "HERO_VOICE_CANARY_STORAGE_INVALID";

  constructor() {
    super("Hero Voice canary private storage is unavailable");
    this.name = "HeroVoiceCanaryStorageError";
  }
}

function invalidStorage(): never {
  throw new HeroVoiceCanaryStorageError();
}

function opaqueStorageFailure(error: unknown): never {
  if (error instanceof HeroVoiceCanaryStorageError) throw error;
  invalidStorage();
}

function observeFileOperation(step: HeroVoiceCanaryFileOperationStep, filename: string): void {
  fileOperationObserver?.(step, path.basename(filename));
}

export function setHeroVoiceCanaryFileOperationObserverForTests(
  observer?: FileOperationObserver,
): void {
  if (process.env.NODE_ENV === "production") throw new Error("test file-operation injection is disabled");
  fileOperationObserver = observer;
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertOwned(metadata: fs.Stats): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) invalidStorage();
}

function requireTrustedDirectory(directory: string, create: boolean): string {
  if (!path.isAbsolute(directory)) invalidStorage();
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidStorage();
  assertOwned(metadata);
  if ((metadata.mode & 0o777) !== 0o700) invalidStorage();
  const normalized = fs.realpathSync(directory);
  const normalizedMetadata = fs.lstatSync(normalized);
  if (!normalizedMetadata.isDirectory() || normalizedMetadata.isSymbolicLink()) invalidStorage();
  assertOwned(normalizedMetadata);
  if ((normalizedMetadata.mode & 0o777) !== 0o700) invalidStorage();
  return normalized;
}

function databasePathFromUrl(value: string | undefined): string {
  if (!value?.startsWith("file:") || value.includes("%")
    || !/[?&]connection_limit=1(?:&|$)/u.test(value)) invalidStorage();
  const pathname = value.slice("file:".length).split("?", 1)[0];
  if (!path.isAbsolute(pathname)) invalidStorage();
  return path.resolve(pathname);
}

function requireConfiguredDirectory(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value || !path.isAbsolute(value)) invalidStorage();
  return value;
}

export function heroVoiceCanaryDeletionConfigured(): boolean {
  return process.env.HERO_VOICE_CANARY_ROOT !== undefined;
}

/** Resolve all application-controlled canary paths from one root. The database,
 * reference, generated, review, and quarantine stores must be on the same
 * private filesystem tree and outside this checkout/public web roots. */
function heroVoiceCanaryStorageContextUnchecked(): HeroVoiceCanaryStorageContext {
  if (process.env.NODE_ENV === "production" || process.env.HERO_VOICE_CANARY_EXECUTION_MODE !== "1") {
    invalidStorage();
  }
  const configuredRoot = requireConfiguredDirectory("HERO_VOICE_CANARY_ROOT");
  const configuredVoiceRoot = requireConfiguredDirectory("USER_VOICE_STORAGE_DIR");
  const configuredReviewRoot = requireConfiguredDirectory("HERO_VOICE_CANARY_REVIEW_ROOT");
  const checkoutRoot = fs.realpathSync(process.cwd());
  const publicRoot = fs.realpathSync(path.join(process.cwd(), "public"));
  const canaryRoot = requireTrustedDirectory(configuredRoot, true);
  if (isWithin(canaryRoot, checkoutRoot) || isWithin(canaryRoot, publicRoot)) invalidStorage();

  const databasePath = databasePathFromUrl(process.env.DATABASE_URL);
  const databaseMetadata = fs.lstatSync(databasePath);
  if (!databaseMetadata.isFile() || databaseMetadata.isSymbolicLink()) invalidStorage();
  assertOwned(databaseMetadata);
  if ((databaseMetadata.mode & 0o777) !== 0o600) invalidStorage();
  const databaseRealpath = fs.realpathSync(databasePath);
  if (!isWithin(databaseRealpath, canaryRoot)) invalidStorage();
  requireTrustedArtifactParents(canaryRoot, databaseRealpath);
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const sidecar = `${databaseRealpath}${suffix}`;
    try {
      const sidecarMetadata = fs.lstatSync(sidecar);
      if (!sidecarMetadata.isFile() || sidecarMetadata.isSymbolicLink()
        || (sidecarMetadata.mode & 0o777) !== 0o600) invalidStorage();
      assertOwned(sidecarMetadata);
      if (!isWithin(fs.realpathSync(sidecar), canaryRoot)) invalidStorage();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const userVoiceRoot = requireTrustedDirectory(configuredVoiceRoot, true);
  const generatedRoot = requireTrustedDirectory(path.join(userVoiceRoot, "generated"), true);
  const reviewRoot = requireTrustedDirectory(configuredReviewRoot, true);
  const quarantineRoot = requireTrustedDirectory(path.join(canaryRoot, ".deletion-quarantine-v1"), true);
  const uploadStagingRoot = requireTrustedDirectory(path.join(canaryRoot, ".voice-upload-staging-v1"), true);
  fsyncDirectory(userVoiceRoot);
  fsyncDirectory(canaryRoot);
  for (const privateRoot of [userVoiceRoot, generatedRoot, reviewRoot, quarantineRoot, uploadStagingRoot]) {
    if (!isWithin(privateRoot, canaryRoot) || isWithin(privateRoot, checkoutRoot) || isWithin(privateRoot, publicRoot)) {
      invalidStorage();
    }
  }
  if (reviewRoot === userVoiceRoot || isWithin(reviewRoot, userVoiceRoot) || isWithin(userVoiceRoot, reviewRoot)) {
    invalidStorage();
  }

  return Object.freeze({
    canaryRoot,
    databasePath: databaseRealpath,
    userVoiceRoot,
    generatedRoot,
    reviewRoot,
    quarantineRoot,
    uploadStagingRoot,
  });
}

export function heroVoiceCanaryStorageContext(): HeroVoiceCanaryStorageContext {
  try {
    return heroVoiceCanaryStorageContextUnchecked();
  } catch (error) {
    return opaqueStorageFailure(error);
  }
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateRegularFile(metadata: fs.Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) invalidStorage();
  assertOwned(metadata);
}

function assertPrivateDirectory(metadata: fs.Stats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) invalidStorage();
  assertOwned(metadata);
}

function assertCanaryContainedPath(filename: string, allowCanaryRoot = false): void {
  if (!heroVoiceCanaryDeletionConfigured()) return;
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) invalidStorage();
  const canaryRoot = requireTrustedDirectory(requireConfiguredDirectory("HERO_VOICE_CANARY_ROOT"), false);
  if (!isWithin(filename, canaryRoot) || (!allowCanaryRoot && filename === canaryRoot)) invalidStorage();
  if (filename !== canaryRoot) requireTrustedArtifactParents(canaryRoot, filename);
}

function openStablePrivateDirectory(directory: string): { descriptor: number; metadata: fs.Stats } {
  let descriptor: number | undefined;
  try {
    assertCanaryContainedPath(directory, true);
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const metadata = fs.fstatSync(descriptor);
    assertPrivateDirectory(metadata);
    const pathnameMetadata = fs.lstatSync(directory);
    assertPrivateDirectory(pathnameMetadata);
    if (!sameInode(metadata, pathnameMetadata)) invalidStorage();
    return { descriptor, metadata };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    return opaqueStorageFailure(error);
  }
}

function assertStableDirectoryPathname(directory: string, metadata: fs.Stats): void {
  const pathnameMetadata = fs.lstatSync(directory);
  assertPrivateDirectory(pathnameMetadata);
  if (!sameInode(metadata, pathnameMetadata)) invalidStorage();
}

function openStablePrivateFile(filename: string): { descriptor: number; metadata: fs.Stats } {
  let descriptor: number | undefined;
  try {
    assertCanaryContainedPath(filename);
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const metadata = fs.fstatSync(descriptor);
    assertPrivateRegularFile(metadata);
    observeFileOperation("after-open-before-stability", filename);
    const pathnameMetadata = fs.lstatSync(filename);
    assertPrivateRegularFile(pathnameMetadata);
    if (!sameInode(metadata, pathnameMetadata)) invalidStorage();
    return { descriptor, metadata };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    return opaqueStorageFailure(error);
  }
}

function assertStablePathname(filename: string, metadata: fs.Stats): void {
  const pathnameMetadata = fs.lstatSync(filename);
  assertPrivateRegularFile(pathnameMetadata);
  if (!sameInode(metadata, pathnameMetadata)) invalidStorage();
}

function assertDestinationAbsent(filename: string): void {
  try {
    assertCanaryContainedPath(filename);
    fs.lstatSync(filename);
    invalidStorage();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function fsyncDirectory(directory: string): void {
  let opened: { descriptor: number; metadata: fs.Stats } | undefined;
  try {
    opened = openStablePrivateDirectory(directory);
    observeFileOperation("before-fsync", directory);
    assertStableDirectoryPathname(directory, opened.metadata);
    fs.fsyncSync(opened.descriptor);
  } catch (error) {
    opaqueStorageFailure(error);
  } finally {
    if (opened) {
      try { fs.closeSync(opened.descriptor); } catch {}
    }
  }
}

export function renamePrivateFileNoFollow(
  source: string,
  destination: string,
  expectedSha256?: string,
): void {
  const { descriptor, metadata } = openStablePrivateFile(source);
  let sourceParent: { descriptor: number; metadata: fs.Stats } | undefined;
  let destinationParent: { descriptor: number; metadata: fs.Stats } | undefined;
  try {
    sourceParent = openStablePrivateDirectory(path.dirname(source));
    destinationParent = openStablePrivateDirectory(path.dirname(destination));
    assertDestinationAbsent(destination);
    if (expectedSha256) {
      const actual = createHash("sha256").update(fs.readFileSync(descriptor)).digest("hex");
      if (actual !== expectedSha256) invalidStorage();
    }
    fs.fchmodSync(descriptor, 0o600);
    observeFileOperation("before-rename", source);
    assertStablePathname(source, metadata);
    assertStableDirectoryPathname(path.dirname(source), sourceParent.metadata);
    assertStableDirectoryPathname(path.dirname(destination), destinationParent.metadata);
    fs.renameSync(source, destination);
    const destinationMetadata = fs.lstatSync(destination);
    assertPrivateRegularFile(destinationMetadata);
    if (!sameInode(metadata, destinationMetadata)) invalidStorage();
    observeFileOperation("after-rename", destination);
    assertStableDirectoryPathname(path.dirname(destination), destinationParent.metadata);
  } catch (error) {
    opaqueStorageFailure(error);
  } finally {
    if (sourceParent) {
      try { fs.closeSync(sourceParent.descriptor); } catch {}
    }
    if (destinationParent) {
      try { fs.closeSync(destinationParent.descriptor); } catch {}
    }
    try { fs.closeSync(descriptor); } catch {}
  }
}

export function unlinkPrivateFileNoFollow(filename: string, expectedSha256?: string): boolean {
  let opened: { descriptor: number; metadata: fs.Stats };
  let parent: { descriptor: number; metadata: fs.Stats } | undefined;
  try {
    opened = openStablePrivateFile(filename);
  } catch (error) {
    try {
      fs.lstatSync(filename);
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") return false;
    }
    return opaqueStorageFailure(error);
  }
  try {
    parent = openStablePrivateDirectory(path.dirname(filename));
    if (expectedSha256) {
      const actual = createHash("sha256").update(fs.readFileSync(opened.descriptor)).digest("hex");
      if (actual !== expectedSha256) invalidStorage();
    }
    observeFileOperation("before-unlink", filename);
    assertStablePathname(filename, opened.metadata);
    assertStableDirectoryPathname(path.dirname(filename), parent.metadata);
    fs.unlinkSync(filename);
    fsyncDirectory(path.dirname(filename));
    return true;
  } catch (error) {
    return opaqueStorageFailure(error);
  } finally {
    if (parent) {
      try { fs.closeSync(parent.descriptor); } catch {}
    }
    try { fs.closeSync(opened.descriptor); } catch {}
  }
}

export function durableWritePrivateFile(temporary: string, destination: string, bytes: Buffer): void {
  let descriptor: number | undefined;
  try {
    assertCanaryContainedPath(temporary);
    assertCanaryContainedPath(destination);
    const parentMetadata = fs.lstatSync(path.dirname(temporary));
    assertPrivateDirectory(parentMetadata);
    assertDestinationAbsent(temporary);
    assertDestinationAbsent(destination);
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const metadata = fs.fstatSync(descriptor);
    assertPrivateRegularFile(metadata);
    observeFileOperation("after-create", temporary);
    fs.writeFileSync(descriptor, bytes);
    observeFileOperation("after-write", temporary);
    observeFileOperation("before-fsync", temporary);
    fs.fsyncSync(descriptor);
    observeFileOperation("after-fsync", temporary);
    fs.closeSync(descriptor);
    descriptor = undefined;
    renamePrivateFileNoFollow(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    opaqueStorageFailure(error);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

/** Write a new deterministic staging pathname durably. A process death at any
 * instruction leaves either no entry or a discoverable partial entry owned by
 * the already-committed SQLite upload intent. */
export function writeNewPrivateFileNoFollow(destination: string, bytes: Buffer): void {
  let descriptor: number | undefined;
  try {
    assertCanaryContainedPath(destination);
    assertPrivateDirectory(fs.lstatSync(path.dirname(destination)));
    assertDestinationAbsent(destination);
    descriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const metadata = fs.fstatSync(descriptor);
    assertPrivateRegularFile(metadata);
    fs.writeFileSync(descriptor, bytes);
    observeFileOperation("before-fsync", destination);
    fs.fsyncSync(descriptor);
    assertStablePathname(destination, metadata);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    opaqueStorageFailure(error);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

export function fsyncPrivateFile(filename: string): void {
  const { descriptor, metadata } = openStablePrivateFile(filename);
  try {
    observeFileOperation("before-fsync", filename);
    assertStablePathname(filename, metadata);
    fs.fsyncSync(descriptor);
  } catch (error) {
    opaqueStorageFailure(error);
  } finally {
    try { fs.closeSync(descriptor); } catch {}
  }
}

export function readPrivateFileNoFollow(filename: string): Buffer {
  const { descriptor, metadata } = openStablePrivateFile(filename);
  try {
    const bytes = fs.readFileSync(descriptor);
    assertStablePathname(filename, metadata);
    return bytes;
  } catch (error) {
    return opaqueStorageFailure(error);
  } finally {
    try { fs.closeSync(descriptor); } catch {}
  }
}

export function sha256File(filename: string): string {
  return createHash("sha256").update(readPrivateFileNoFollow(filename)).digest("hex");
}

function validateStorageKey(rootKind: DeletionArtifactRootKind, storageKey: string): void {
  if (!storageKey || path.isAbsolute(storageKey) || storageKey.includes("\\")) invalidStorage();
  const parts = storageKey.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) invalidStorage();
  if (rootKind === "user_voice_reference") {
    if (parts.length !== 1 || !REFERENCE_KEY.test(parts[0])) invalidStorage();
    return;
  }
  if (rootKind === "clone_generated") {
    if (parts.length !== 1 || !GENERATED_KEY.test(parts[0])) invalidStorage();
    return;
  }
  if (parts.length > MAX_REVIEW_DEPTH || parts.some((part) => !REVIEW_BASENAME.test(part))) invalidStorage();
}

function requireTrustedArtifactParents(root: string, target: string): void {
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  if (!relativeParent) return;
  for (const component of relativeParent.split(path.sep)) {
    current = path.join(current, component);
    const metadata = fs.lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
      invalidStorage();
    }
    assertOwned(metadata);
  }
}

export function artifactSourcePath(
  context: HeroVoiceCanaryStorageContext,
  rootKind: DeletionArtifactRootKind,
  storageKey: string,
): string {
  try {
    validateStorageKey(rootKind, storageKey);
    const root = rootKind === "user_voice_reference"
      ? context.userVoiceRoot
      : rootKind === "clone_generated"
        ? context.generatedRoot
        : context.reviewRoot;
    const target = path.resolve(root, ...storageKey.split("/"));
    if (!isWithin(target, root) || target === root) invalidStorage();
    requireTrustedArtifactParents(root, target);
    return target;
  } catch (error) {
    return opaqueStorageFailure(error);
  }
}

export function artifactQuarantinePath(
  context: HeroVoiceCanaryStorageContext,
  transactionId: string,
  artifactId: string,
  createDirectory = true,
): string {
  try {
    if (!OPAQUE_ID.test(transactionId) || !OPAQUE_ID.test(artifactId)) invalidStorage();
    const intendedDirectory = path.join(context.quarantineRoot, transactionId);
    const transactionDirectory = createDirectory
      ? requireTrustedDirectory(intendedDirectory, true)
      : intendedDirectory;
    if (!createDirectory) {
      try {
        const metadata = fs.lstatSync(transactionDirectory);
        assertPrivateDirectory(metadata);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (createDirectory) fsyncDirectory(context.quarantineRoot);
    const target = path.join(transactionDirectory, artifactId);
    if (!isWithin(target, transactionDirectory)) invalidStorage();
    return target;
  } catch (error) {
    return opaqueStorageFailure(error);
  }
}

/** Node exposes no unlinkat/rmdir-at API. Hold O_NOFOLLOW descriptors for the
 * empty directory and its parent, revalidate both inode identities at the last
 * possible point, perform the pathname rmdir, then fsync the held parent. Any
 * observed substitution fails closed; the unavoidable final syscall race is
 * documented in the canary operations guide. */
function removeEmptyPrivateDirectory(directory: string, parentDirectory: string): void {
  let directoryOpened: { descriptor: number; metadata: fs.Stats } | undefined;
  let parentOpened: { descriptor: number; metadata: fs.Stats } | undefined;
  try {
    parentOpened = openStablePrivateDirectory(parentDirectory);
    try {
      directoryOpened = openStablePrivateDirectory(directory);
    } catch (error) {
      try {
        fs.lstatSync(directory);
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") return;
      }
      throw error;
    }
    observeFileOperation("before-rmdir", directory);
    assertStableDirectoryPathname(parentDirectory, parentOpened.metadata);
    assertStableDirectoryPathname(directory, directoryOpened.metadata);
    fs.rmdirSync(directory);
    assertStableDirectoryPathname(parentDirectory, parentOpened.metadata);
    fs.fsyncSync(parentOpened.descriptor);
    assertStableDirectoryPathname(parentDirectory, parentOpened.metadata);
  } catch (error) {
    opaqueStorageFailure(error);
  } finally {
    if (directoryOpened) {
      try { fs.closeSync(directoryOpened.descriptor); } catch {}
    }
    if (parentOpened) {
      try { fs.closeSync(parentOpened.descriptor); } catch {}
    }
  }
}

export function removeEmptyQuarantineDirectory(
  context: HeroVoiceCanaryStorageContext,
  transactionId: string,
): void {
  if (!OPAQUE_ID.test(transactionId)) invalidStorage();
  const directory = path.join(context.quarantineRoot, transactionId);
  removeEmptyPrivateDirectory(directory, context.quarantineRoot);
}

export type HeroVoiceCanaryUploadPaths = Readonly<{
  stagingDirectory: string;
  rawSource: string;
  normalizedWav: string;
  finalReference: string;
  filename: string;
}>;

export function heroVoiceCanaryUploadPaths(
  context: HeroVoiceCanaryStorageContext,
  transactionId: string,
  createDirectory: boolean,
): HeroVoiceCanaryUploadPaths {
  try {
    if (!/^[0-9A-Fa-f-]{36}$/u.test(transactionId)) invalidStorage();
    const intendedDirectory = path.join(context.uploadStagingRoot, transactionId);
    const stagingDirectory = createDirectory
      ? requireTrustedDirectory(intendedDirectory, true)
      : intendedDirectory;
    if (createDirectory) {
      fsyncDirectory(context.uploadStagingRoot);
    } else {
      try {
        assertPrivateDirectory(fs.lstatSync(stagingDirectory));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const filename = `${transactionId}.wav`;
    return Object.freeze({
      stagingDirectory,
      rawSource: path.join(stagingDirectory, "source.bin"),
      normalizedWav: path.join(stagingDirectory, "normalized.wav"),
      finalReference: artifactSourcePath(context, "user_voice_reference", filename),
      filename,
    });
  } catch (error) {
    return opaqueStorageFailure(error);
  }
}

export function removeEmptyUploadStagingDirectory(
  context: HeroVoiceCanaryStorageContext,
  transactionId: string,
): void {
  if (!/^[0-9A-Fa-f-]{36}$/u.test(transactionId)) invalidStorage();
  const directory = path.join(context.uploadStagingRoot, transactionId);
  removeEmptyPrivateDirectory(directory, context.uploadStagingRoot);
}

export function listCloneGeneratedStorageKeys(jobIds: readonly string[]): string[] {
  try {
    const allowed = new Set(jobIds.filter((id) => OPAQUE_ID.test(id)));
    if (allowed.size !== jobIds.length) invalidStorage();
    const context = heroVoiceCanaryStorageContext();
    const matched: string[] = [];
    for (const entry of fs.readdirSync(context.generatedRoot, { withFileTypes: true })) {
      const belongsToJob = [...allowed].some((jobId) => {
        if (entry.name === `clone-${jobId}.wav`) return true;
        const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        return new RegExp(`^clone-part-${escapedJobId}-[1-9][0-9]*\\.wav$`, "u").test(entry.name);
      });
      if (!belongsToJob) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !GENERATED_KEY.test(entry.name)) invalidStorage();
      const pathname = path.join(context.generatedRoot, entry.name);
      const { descriptor } = openStablePrivateFile(pathname);
      fs.closeSync(descriptor);
      matched.push(entry.name);
    }
    return matched.sort();
  } catch (error) {
    return opaqueStorageFailure(error);
  }
}

export function privateFileExists(filename: string): boolean {
  try {
    assertCanaryContainedPath(filename);
    const metadata = fs.lstatSync(filename);
    assertPrivateRegularFile(metadata);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return opaqueStorageFailure(error);
  }
}
