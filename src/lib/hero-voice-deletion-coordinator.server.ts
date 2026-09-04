import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  artifactQuarantinePath,
  artifactSourcePath,
  type DeletionArtifactRootKind,
  fsyncDirectory,
  HERO_VOICE_CANARY_DATABASE_MARKER_KEY,
  HERO_VOICE_CANARY_DATABASE_MARKER_VALUE,
  heroVoiceCanaryDeletionConfigured,
  heroVoiceCanaryStorageContext,
  heroVoiceCanaryUploadPaths,
  listCloneGeneratedStorageKeys,
  privateFileExists,
  removeEmptyUploadStagingDirectory,
  removeEmptyQuarantineDirectory,
  renamePrivateFileNoFollow,
  sha256File,
  unlinkPrivateFileNoFollow,
} from "@/lib/hero-voice-canary-storage.server";

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const NONTERMINAL = ["planned", "db_committed"] as const;
const ROOT_SALT_LABEL = "hero-voice-canary/v1/root-salt";
const OWNER_KEY_INFO = "hero-voice-canary/v1/owner-hmac";
export const HERO_VOICE_CANARY_STORAGE_BINDING_KEY = "hero_voice_canary_storage_binding_v1";
const HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY = "hero_voice_canary_ledger_mutation_guard_v1";

type OperationKind = "single_voice_delete" | "owner_review_close" | "account_hard_delete";
type CoordinatorOperationKind = OperationKind | "voice_upload" | "review_artifact_create";
type PlannedArtifact = Readonly<{
  id: string;
  rootKind: DeletionArtifactRootKind;
  storageKey: string;
  expectedSha256: string;
}>;

export type HeroVoiceDeletionCrashStep =
  | "before-transaction-a" | "after-transaction-a"
  | "before-move" | "after-move"
  | "before-progress-commit" | "after-progress-commit"
  | "before-transaction-b" | "after-transaction-b"
  | "before-unlink" | "after-unlink"
  | "before-transaction-c" | "after-transaction-c"
  | "after-upload-intent" | "after-upload-raw"
  | "before-upload-conversion" | "after-upload-normalized"
  | "after-upload-final-rename"
  | "after-upload-row-commit"
  | "after-review-preparation-commit"
  | "after-review-remote-push-before-local-commit"
  | "after-review-cas-before-intent-commit";


type CrashObserver = (step: HeroVoiceDeletionCrashStep, opaqueId: string) => void;
let crashObserver: CrashObserver | undefined;

export class HeroVoiceDeletionSimulatedCrash extends Error {
  constructor(readonly step: HeroVoiceDeletionCrashStep) {
    super(`simulated_deletion_crash:${step}`);
    this.name = "HeroVoiceDeletionSimulatedCrash";
  }
}

export class HeroVoiceDeletionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HeroVoiceDeletionError";
  }
}

export class HeroVoiceCanaryReadOnlyError extends HeroVoiceDeletionError {
  constructor() {
    super("Hero Voice canary mutations are temporarily unavailable", "HERO_VOICE_CANARY_READ_ONLY", 503);
    this.name = "HeroVoiceCanaryReadOnlyError";
  }
}

function observe(step: HeroVoiceDeletionCrashStep, opaqueId: string): void {
  crashObserver?.(step, opaqueId);
}

export function observeHeroVoiceCanaryCrashForTests(
  step: HeroVoiceDeletionCrashStep,
  opaqueId: string,
): void {
  if (!OPAQUE_ID.test(opaqueId)) throw new HeroVoiceCanaryReadOnlyError();
  observe(step, opaqueId);
}

export function setHeroVoiceDeletionCrashObserverForTests(observer?: CrashObserver): void {
  if (process.env.NODE_ENV === "production") throw new Error("test crash injection is disabled");
  crashObserver = observer;
}

function canonicalOwnerClaims(input: { authIssuer: string; authSubject: string }): Buffer {
  if (!input.authIssuer || !input.authSubject) {
    throw new HeroVoiceDeletionError("Verified authentication claims are required", "CANARY_AUTH_CLAIMS_INVALID", 400);
  }
  // RFC 8785 ordering for these three keys is authIssuer, authSubject, version.
  return Buffer.from(JSON.stringify({
    authIssuer: input.authIssuer,
    authSubject: input.authSubject,
    version: 1,
  }), "utf8");
}

function reviewRootKey(): Buffer {
  const encoded = process.env.HERO_VOICE_CANARY_REVIEW_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/u.test(encoded) || encoded.includes("=")) {
    throw new HeroVoiceDeletionError("Canary review key is unavailable", "CANARY_REVIEW_KEY_INVALID", 503);
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
    throw new HeroVoiceDeletionError("Canary review key is unavailable", "CANARY_REVIEW_KEY_INVALID", 503);
  }
  return decoded;
}

function reviewConfigurationHmac(): string {
  const context = heroVoiceCanaryStorageContext();
  return createHmac("sha256", reviewRootKey())
    .update("hero-voice-canary/v1/deletion-storage-roots\0", "utf8")
    .update(JSON.stringify({
      canaryRoot: context.canaryRoot,
      databasePath: context.databasePath,
      reviewRoot: context.reviewRoot,
      userVoiceRoot: context.userVoiceRoot,
    }), "utf8")
    .digest("hex");
}

function storageConfigurationFingerprint(): string {
  const context = heroVoiceCanaryStorageContext();
  return createHash("sha256").update(JSON.stringify({
    canaryRoot: context.canaryRoot,
    databasePath: context.databasePath,
    reviewRoot: context.reviewRoot,
    userVoiceRoot: context.userVoiceRoot,
  }), "utf8").digest("hex");
}

async function requireDurableStorageBinding(): Promise<void> {
  const expected = reviewConfigurationHmac();
  const existing = await prisma.siteConfig.findUnique({
    where: { key: HERO_VOICE_CANARY_STORAGE_BINDING_KEY },
    select: { value: true },
  });
  if (existing) {
    if (!ownerHmacMatches(existing.value, expected)) {
      throw new HeroVoiceDeletionError(
        "Canary storage binding is unavailable",
        "CANARY_STORAGE_BINDING_INVALID",
        503,
      );
    }
    return;
  }

  // A missing binding may be initialized only before any private lifecycle has
  // begun. This prevents a changed root/key from being blessed immediately
  // before deletion merely because the newly selected directories are empty.
  const context = heroVoiceCanaryStorageContext();
  const [voices, reviewRuns, deletionTransactions] = await Promise.all([
    prisma.userVoice.count(),
    prisma.reviewRun.count(),
    prisma.deletionTransaction.count(),
  ]);
  let storesArePristine = false;
  try {
    const referenceEntries = fs.readdirSync(context.userVoiceRoot)
      .filter((entry) => entry !== path.basename(context.generatedRoot));
    storesArePristine = referenceEntries.length === 0
      && fs.readdirSync(context.generatedRoot).length === 0
      && fs.readdirSync(context.reviewRoot).length === 0
      && fs.readdirSync(context.quarantineRoot).length === 0
      && fs.readdirSync(context.uploadStagingRoot).length === 0;
  } catch {
    throw new HeroVoiceDeletionError(
      "Canary storage binding is unavailable",
      "CANARY_STORAGE_BINDING_INVALID",
      503,
    );
  }
  if (voices !== 0 || reviewRuns !== 0 || deletionTransactions !== 0 || !storesArePristine) {
    throw new HeroVoiceDeletionError(
      "Canary storage binding is unavailable",
      "CANARY_STORAGE_BINDING_INVALID",
      503,
    );
  }
  try {
    await prisma.siteConfig.create({
      data: { key: HERO_VOICE_CANARY_STORAGE_BINDING_KEY, value: expected },
    });
  } catch {
    const raced = await prisma.siteConfig.findUnique({
      where: { key: HERO_VOICE_CANARY_STORAGE_BINDING_KEY },
      select: { value: true },
    });
    if (!raced || !ownerHmacMatches(raced.value, expected)) {
      throw new HeroVoiceDeletionError(
        "Canary storage binding is unavailable",
        "CANARY_STORAGE_BINDING_INVALID",
        503,
      );
    }
  }
}

export function computeHeroVoiceCanaryOwnerHmac(input: {
  authIssuer: string;
  authSubject: string;
}): string {
  const salt = createHash("sha256").update(ROOT_SALT_LABEL, "utf8").digest();
  const ownerKey = Buffer.from(hkdfSync("sha256", reviewRootKey(), salt, Buffer.from(OWNER_KEY_INFO), 32));
  return createHmac("sha256", ownerKey).update(canonicalOwnerClaims(input)).digest("hex");
}

export function ownerHmacMatches(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

type StartupState = Readonly<{ mode: "inactive" | "ready" | "read_only" }>;
let startupState: StartupState | undefined;
let startupPromise: Promise<StartupState> | undefined;
let coordinatorTail: Promise<void> = Promise.resolve();

async function withCoordinatorLock<T>(operation: () => Promise<T>): Promise<T> {
  const predecessor = coordinatorTail;
  let release!: () => void;
  coordinatorTail = new Promise<void>((resolve) => { release = resolve; });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

function pragmaScalar(row: Record<string, unknown> | undefined): string {
  if (!row) return "";
  const value = Object.values(row)[0];
  return typeof value === "bigint" ? value.toString() : String(value ?? "").toLowerCase();
}

async function configureAndVerifySqliteDurability(): Promise<void> {
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$queryRawUnsafe("PRAGMA synchronous = FULL");
  const [foreignKeys, journalMode, synchronous] = await Promise.all([
    prisma.$queryRawUnsafe<Record<string, unknown>[]>("PRAGMA foreign_keys"),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>("PRAGMA journal_mode"),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>("PRAGMA synchronous"),
  ]);
  if (pragmaScalar(foreignKeys[0]) !== "1"
    || pragmaScalar(journalMode[0]) !== "wal"
    || pragmaScalar(synchronous[0]) !== "2") {
    throw new Error("canary_sqlite_durability_readback_failed");
  }
}

async function requireMarkedCanaryDatabase(): Promise<void> {
  heroVoiceCanaryStorageContext();
  await configureAndVerifySqliteDurability();
  // WAL/SHM may be created by the pragma transition; validate their ownership,
  // type, containment, and 0600 mode before querying application data.
  heroVoiceCanaryStorageContext();
  const marker = await prisma.siteConfig.findUnique({
    where: { key: HERO_VOICE_CANARY_DATABASE_MARKER_KEY },
    select: { value: true },
  });
  if (marker?.value !== HERO_VOICE_CANARY_DATABASE_MARKER_VALUE) {
    throw new Error("canary_database_marker_invalid");
  }
  await requireDurableStorageBinding();
}

export async function initializeHeroVoiceDeletionCoordinator(): Promise<StartupState> {
  if (!heroVoiceCanaryDeletionConfigured()) return { mode: "inactive" };
  if (startupState) return startupState;
  if (!startupPromise) {
    startupPromise = withCoordinatorLock(async () => {
      try {
        await requireMarkedCanaryDatabase();
        await reconcileNonterminalTransactionsUnlocked();
        const unresolved = await prisma.deletionTransaction.count({ where: { status: { in: [...NONTERMINAL] } } });
        if (unresolved !== 0) throw new Error("unresolved_deletion_transaction");
        startupState = Object.freeze({ mode: "ready" });
      } catch {
        startupState = Object.freeze({ mode: "read_only" });
      }
      return startupState;
    });
  }
  return startupPromise;
}

/** Reads stay available after a failed startup reconciliation, but callers must
 * await this boundary so no canary read/auth path races startup recovery. */
export async function ensureHeroVoiceCanaryReadReady(): Promise<StartupState> {
  return initializeHeroVoiceDeletionCoordinator();
}

export async function assertHeroVoiceCanaryMutationReady(): Promise<void> {
  const state = await initializeHeroVoiceDeletionCoordinator();
  if (state.mode === "read_only") throw new HeroVoiceCanaryReadOnlyError();
}

/** Serialize every canary mutation that can create or change private owner
 * state with deletion A/B/C. This process is intentionally one local canary;
 * SQLite transactions remain the durable authority across crashes/restarts. */
export async function runHeroVoiceCanarySerializedMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const state = await initializeHeroVoiceDeletionCoordinator();
  if (state.mode === "inactive") return operation();
  if (state.mode === "read_only") throw new HeroVoiceCanaryReadOnlyError();
  return withCoordinatorLock(async () => {
    await requireMarkedCanaryDatabase();
    await reconcileNonterminalTransactionsUnlocked();
    return operation();
  });
}

export function heroVoiceCanaryStartupState(): StartupState | undefined {
  return startupState;
}

export function resetHeroVoiceDeletionCoordinatorForTests(): void {
  if (process.env.NODE_ENV === "production") throw new Error("test reset is disabled");
  startupState = undefined;
  startupPromise = undefined;
  coordinatorTail = Promise.resolve();
  crashObserver = undefined;
}

function parseReviewArtifacts(value: string | null): Array<{ storageKey: string; sha256: string }> {
  if (value === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid_review_artifact_manifest"); }
  if (!Array.isArray(parsed) || parsed.length > 256) throw new Error("invalid_review_artifact_manifest");
  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid_review_artifact_manifest");
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "sha256" || keys[1] !== "storageKey") {
      throw new Error("invalid_review_artifact_manifest");
    }
    const storageKey = (entry as { storageKey?: unknown }).storageKey;
    const sha256 = (entry as { sha256?: unknown }).sha256;
    if (typeof storageKey !== "string" || typeof sha256 !== "string" || !SHA256_HEX.test(sha256) || seen.has(storageKey)) {
      throw new Error("invalid_review_artifact_manifest");
    }
    seen.add(storageKey);
    return { storageKey, sha256 };
  });
}

type HeroVoiceCanarySanitizedReviewAggregatesTask4V1 = Readonly<{
  candidateCerPasses: number;
  candidateCriticalFlagCount: number;
  candidateLosses: number;
  candidateWins: number;
  completePairs: 18;
  ties: number;
  version: 1;
}>;

type HeroVoiceCanarySanitizedReviewAggregatesTask5V1 = Readonly<{
  acceptablePairs: number;
  allFinalOutputsValid: boolean;
  candidateCerPasses: number;
  candidateCriticalFlagCount: number;
  candidateImprovementWins: number;
  candidateLosses: number;
  candidateWins: number;
  completePairs: 18;
  mewPhraseApproved: false;
  postReviewPass: boolean;
  ties: number;
  version: 1;
}>;

/** Task 5 is additive: existing Task 4 close/recovery rows keep their exact
 * seven-field aggregate schema, while newly revealed Task 5 runs use the
 * independently validated post-review decision extension. */
export type HeroVoiceCanarySanitizedReviewAggregatesV1 =
  | HeroVoiceCanarySanitizedReviewAggregatesTask4V1
  | HeroVoiceCanarySanitizedReviewAggregatesTask5V1;

function parseSanitizedReviewAggregates(
  value: string | null,
): HeroVoiceCanarySanitizedReviewAggregatesV1 {
  let parsed: unknown;
  try { parsed = value === null ? null : JSON.parse(value); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HeroVoiceDeletionError("Review run cannot be closed", "REVIEW_AGGREGATES_INVALID", 409);
  }
  const legacyKeys = [
    "candidateCerPasses",
    "candidateCriticalFlagCount",
    "candidateLosses",
    "candidateWins",
    "completePairs",
    "ties",
    "version",
  ];
  const task5Keys = [
    "acceptablePairs",
    "allFinalOutputsValid",
    "candidateCerPasses",
    "candidateCriticalFlagCount",
    "candidateImprovementWins",
    "candidateLosses",
    "candidateWins",
    "completePairs",
    "mewPhraseApproved",
    "postReviewPass",
    "ties",
    "version",
  ];
  const actualKeys = JSON.stringify(Object.keys(parsed).sort());
  const legacy = actualKeys === JSON.stringify(legacyKeys);
  if (!legacy && actualKeys !== JSON.stringify(task5Keys)) {
    throw new HeroVoiceDeletionError("Review run cannot be closed", "REVIEW_AGGREGATES_INVALID", 409);
  }
  const record = parsed as Record<string, unknown>;
  const integerInRange = (key: string, maximum: number): number => {
    const item = record[key];
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > maximum) {
      throw new HeroVoiceDeletionError("Review run cannot be closed", "REVIEW_AGGREGATES_INVALID", 409);
    }
    return item as number;
  };
  const candidateCerPasses = integerInRange("candidateCerPasses", 18);
  const candidateCriticalFlagCount = integerInRange("candidateCriticalFlagCount", 72);
  const candidateLosses = integerInRange("candidateLosses", 18);
  const candidateWins = integerInRange("candidateWins", 18);
  const completePairs = integerInRange("completePairs", 18);
  const ties = integerInRange("ties", 18);
  if (record.version !== 1 || completePairs !== 18
    || candidateWins + ties + candidateLosses !== completePairs) {
    throw new HeroVoiceDeletionError("Review run cannot be closed", "REVIEW_AGGREGATES_INVALID", 409);
  }
  if (legacy) return Object.freeze({
    candidateCerPasses,
    candidateCriticalFlagCount,
    candidateLosses,
    candidateWins,
    completePairs: 18,
    ties,
    version: 1,
  });
  const acceptablePairs = integerInRange("acceptablePairs", 18);
  const candidateImprovementWins = integerInRange("candidateImprovementWins", 18);
  if (acceptablePairs !== candidateWins + ties || candidateImprovementWins !== candidateWins
    || typeof record.allFinalOutputsValid !== "boolean" || typeof record.postReviewPass !== "boolean"
    || record.mewPhraseApproved !== false
    || record.postReviewPass !== (acceptablePairs >= 15 && candidateCerPasses >= 17
      && record.allFinalOutputsValid === true && candidateCriticalFlagCount === 0)) {
    throw new HeroVoiceDeletionError("Review run cannot be closed", "REVIEW_AGGREGATES_INVALID", 409);
  }
  return Object.freeze({
    acceptablePairs,
    allFinalOutputsValid: record.allFinalOutputsValid,
    candidateCerPasses,
    candidateCriticalFlagCount,
    candidateImprovementWins,
    candidateLosses,
    candidateWins,
    completePairs: 18,
    mewPhraseApproved: false,
    postReviewPass: record.postReviewPass,
    ties,
    version: 1,
  });
}

export function serializeHeroVoiceCanarySanitizedReviewAggregates(
  input: HeroVoiceCanarySanitizedReviewAggregatesV1,
): string {
  return JSON.stringify(parseSanitizedReviewAggregates(JSON.stringify(input)));
}

export function serializeHeroVoiceCanaryReviewArtifactManifest(
  artifacts: readonly { storageKey: string; sha256: string }[],
): string {
  if (artifacts.length > 256) throw new Error("invalid_review_artifact_manifest");
  const context = heroVoiceCanaryStorageContext();
  const normalized = artifacts.map(({ storageKey, sha256 }) => {
    artifactSourcePath(context, "review_private", storageKey);
    if (!SHA256_HEX.test(sha256)) throw new Error("invalid_review_artifact_manifest");
    return { storageKey, sha256 };
  }).sort((left, right) => left.storageKey.localeCompare(right.storageKey));
  if (new Set(normalized.map((item) => item.storageKey)).size !== normalized.length) {
    throw new Error("invalid_review_artifact_manifest");
  }
  return JSON.stringify(normalized);
}

function plannedArtifact(
  rootKind: DeletionArtifactRootKind,
  storageKey: string,
  expectedSha256?: string,
): PlannedArtifact | null {
  const context = heroVoiceCanaryStorageContext();
  const source = artifactSourcePath(context, rootKind, storageKey);
  if (!privateFileExists(source)) return null;
  const actualSha256 = sha256File(source);
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error("private_artifact_hash_mismatch");
  return Object.freeze({ id: randomUUID(), rootKind, storageKey, expectedSha256: actualSha256 });
}

function reviewPlannedArtifacts(manifestJson: string | null): PlannedArtifact[] {
  return parseReviewArtifacts(manifestJson).map(({ storageKey, sha256 }) => {
    const artifact = plannedArtifact("review_private", storageKey, sha256);
    if (!artifact) throw new Error("private_review_artifact_missing");
    return artifact;
  });
}

function sanitizedReceipt(input: {
  transactionId: string;
  receiptId: string;
  outcome: string;
  artifactHashes: readonly string[];
  plannedAt: Date;
  dbCommittedAt: Date;
  doneAt?: Date;
}): string {
  return JSON.stringify({
    version: 1,
    transactionId: input.transactionId,
    receiptId: input.receiptId,
    outcome: input.outcome,
    artifactSha256: [...input.artifactHashes].sort(),
    plannedAt: input.plannedAt.toISOString(),
    dbCommittedAt: input.dbCommittedAt.toISOString(),
    ...(input.doneAt ? { doneAt: input.doneAt.toISOString() } : {}),
  });
}

async function moveArtifactsToQuarantine(transactionId: string): Promise<void> {
  const context = heroVoiceCanaryStorageContext();
  const artifacts = await prisma.deletionArtifact.findMany({
    where: { deletionTransactionId: transactionId },
    orderBy: { id: "asc" },
  });
  for (const artifact of artifacts) {
    if (artifact.status === "quarantined" || artifact.status === "absent") continue;
    const rootKind = artifact.rootKind as DeletionArtifactRootKind;
    const source = artifactSourcePath(context, rootKind, artifact.storageKey);
    const quarantine = artifactQuarantinePath(context, transactionId, artifact.id);
    const sourceExists = privateFileExists(source);
    const quarantineExists = privateFileExists(quarantine);
    if (sourceExists && quarantineExists) throw new Error("ambiguous_private_artifact_state");
    observe("before-move", artifact.id);
    let nextStatus = "absent";
    if (sourceExists) {
      renamePrivateFileNoFollow(source, quarantine, artifact.expectedSha256);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(path.dirname(quarantine));
      nextStatus = "quarantined";
    } else if (quarantineExists) {
      if (sha256File(quarantine) !== artifact.expectedSha256) throw new Error("private_artifact_hash_mismatch");
      nextStatus = "quarantined";
    }
    observe("after-move", artifact.id);
    observe("before-progress-commit", artifact.id);
    await prisma.deletionArtifact.update({
      where: { id: artifact.id },
      data: { status: nextStatus, quarantinedAt: new Date() },
    });
    observe("after-progress-commit", artifact.id);
  }
  const finalArtifacts = await prisma.deletionArtifact.findMany({ where: { deletionTransactionId: transactionId } });
  if (finalArtifacts.some((artifact) => !["quarantined", "absent"].includes(artifact.status))) {
    throw new Error("deletion_artifact_quarantine_incomplete");
  }
  for (const directory of new Set(finalArtifacts.map((artifact) => path.dirname(
    artifactQuarantinePath(context, transactionId, artifact.id),
  )))) fsyncDirectory(directory);
}

async function restoreArtifactsAfterDatabaseRollback(transactionId: string): Promise<void> {
  const context = heroVoiceCanaryStorageContext();
  const artifacts = await prisma.deletionArtifact.findMany({
    where: { deletionTransactionId: transactionId },
    orderBy: { id: "desc" },
  });
  for (const artifact of artifacts) {
    const source = artifactSourcePath(context, artifact.rootKind as DeletionArtifactRootKind, artifact.storageKey);
    const quarantine = artifactQuarantinePath(context, transactionId, artifact.id);
    if (privateFileExists(quarantine)) {
      if (privateFileExists(source)) {
        throw new Error("private_artifact_restore_failed");
      }
      renamePrivateFileNoFollow(quarantine, source, artifact.expectedSha256);
      fsyncDirectory(path.dirname(quarantine));
      fsyncDirectory(path.dirname(source));
    }
    await prisma.deletionArtifact.update({
      where: { id: artifact.id },
      data: { status: "restored", restoredAt: new Date() },
    });
  }
  removeEmptyQuarantineDirectory(context, transactionId);
  const transaction = await prisma.deletionTransaction.findUniqueOrThrow({ where: { id: transactionId } });
  await prisma.$transaction(async (tx) => {
    if (transaction.operationKind === "single_voice_delete" && transaction.scopeVoiceId) {
      await tx.userVoice.updateMany({
        where: { id: transaction.scopeVoiceId, deletionTransactionId: transaction.id },
        data: { deletionTransactionId: null, deletionClaimedAt: null },
      });
    } else if (transaction.operationKind === "account_hard_delete") {
      await tx.userVoice.updateMany({
        where: { deletionTransactionId: transaction.id },
        data: { deletionTransactionId: null, deletionClaimedAt: null },
      });
    }
    await tx.deletionTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "rolled_back",
        rolledBackAt: new Date(),
        scopeUserId: null,
        scopeVoiceId: null,
        scopeReviewRunId: null,
        scopeOwnerHmac: null,
      },
    });
  });
}

async function databaseAuthorityCommitted(transaction: {
  id: string;
  operationKind: string;
  scopeUserId: string | null;
  scopeVoiceId: string | null;
  scopeReviewRunId: string | null;
  receiptId: string;
}): Promise<boolean> {
  if (transaction.operationKind === "single_voice_delete") {
    if (!transaction.scopeVoiceId) throw new Error("voice_delete_scope_missing");
    return (await prisma.userVoice.count({ where: { id: transaction.scopeVoiceId } })) === 0;
  }
  if (transaction.operationKind === "owner_review_close") {
    if (!transaction.scopeReviewRunId) throw new Error("review_close_scope_missing");
    const run = await prisma.reviewRun.findUnique({
      where: { id: transaction.scopeReviewRunId },
      select: { state: true, receiptId: true },
    });
    return run?.state === "closed" && run.receiptId === transaction.receiptId;
  }
  if (transaction.operationKind === "account_hard_delete") {
    if (!transaction.scopeUserId) throw new Error("account_delete_scope_missing");
    return (await prisma.user.count({ where: { id: transaction.scopeUserId } })) === 0;
  }
  throw new Error("unknown_deletion_operation");
}

async function commitTransactionB(transactionId: string): Promise<void> {
  const transaction = await prisma.deletionTransaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { artifacts: true },
  });
  if (transaction.status === "db_committed") return;
  const now = new Date();
  const receiptJson = sanitizedReceipt({
    transactionId: transaction.id,
    receiptId: transaction.receiptId,
    outcome: transaction.intendedOutcome,
    artifactHashes: transaction.artifacts.map((artifact) => artifact.expectedSha256),
    plannedAt: transaction.plannedAt,
    dbCommittedAt: now,
  });

  await prisma.$transaction(async (tx) => {
    if (transaction.operationKind === "single_voice_delete") {
      if (!transaction.scopeVoiceId || !transaction.scopeUserId) throw new Error("voice_delete_scope_missing");
      const activeJob = await tx.aiGenerationJob.findFirst({
        where: {
          userId: transaction.scopeUserId,
          kind: "voice",
          model: `user_${transaction.scopeVoiceId}`,
          status: { in: ["queued", "in_progress"] },
        },
        select: { id: true },
      });
      if (activeJob) throw new HeroVoiceDeletionError(
        "Voice is currently in use", "USER_VOICE_IN_USE", 409,
      );
      const deleted = await tx.userVoice.deleteMany({
        where: { id: transaction.scopeVoiceId, userId: transaction.scopeUserId, deletionTransactionId: transaction.id },
      });
      if (deleted.count !== 1) throw new Error("voice_delete_authority_changed");
    } else if (transaction.operationKind === "owner_review_close") {
      if (!transaction.scopeReviewRunId || !transaction.scopeOwnerHmac) throw new Error("review_close_scope_missing");
      const currentRun = await tx.reviewRun.findFirst({
        where: {
          id: transaction.scopeReviewRunId,
          ownerHmac: transaction.scopeOwnerHmac,
          state: "revealed",
        },
        select: { sanitizedAggregatesJson: true },
      });
      if (!currentRun) throw new Error("review_close_authority_changed");
      const sanitizedAggregatesJson = JSON.stringify(
        parseSanitizedReviewAggregates(currentRun.sanitizedAggregatesJson),
      );
      await tx.siteConfig.upsert({
        where: { key: HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY },
        create: { key: HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY, value: transaction.scopeReviewRunId },
        update: { value: transaction.scopeReviewRunId },
      });
      await tx.canarySubmitNonce.deleteMany({ where: { runId: transaction.scopeReviewRunId } });
      await tx.canaryObjectiveObservation.deleteMany({ where: { runId: transaction.scopeReviewRunId } });
      await tx.canaryLedgerRecord.deleteMany({ where: { runId: transaction.scopeReviewRunId } });
      const closed = await tx.reviewRun.updateMany({
        where: {
          id: transaction.scopeReviewRunId,
          ownerHmac: transaction.scopeOwnerHmac,
          state: "revealed",
        },
        data: {
          state: "closed",
          revision: { increment: 1 },
          experimentId: null,
          slotManifestSha256: null,
          slotManifestJson: null,
          referenceVoiceId: null,
          inFlightSlotId: null,
          reviewPreparationJson: null,
          publicReviewJson: null,
          privateArtifactManifestJson: null,
          rawScoresJson: null,
          revealCiphertextJson: null,
          revealCiphertextSha256: null,
          scoreSheetHmac: null,
          gitRepositoryNodeId: null,
          gitCanonicalUrl: null,
          gitRef: null,
          gitCommitSha: null,
          gitBlobOid: null,
          gitCommitmentPath: null,
          gitBlobSha256: null,
          evaluatorEvidenceJson: null,
          costEvidenceJson: null,
          ledgerSequence: 0,
          ledgerHeadHmac: null,
          sanitizedAggregatesJson,
          receiptId: transaction.receiptId,
          closedAt: now,
        },
      });
      if (closed.count !== 1) throw new Error("review_close_authority_changed");
      await tx.siteConfig.delete({ where: { key: HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY } });
    } else if (transaction.operationKind === "account_hard_delete") {
      if (!transaction.scopeUserId || !transaction.scopeOwnerHmac) throw new Error("account_delete_scope_missing");
      await tx.creditLedger.deleteMany({ where: { userId: transaction.scopeUserId } });
      await tx.creditBalance.deleteMany({ where: { userId: transaction.scopeUserId } });
      await tx.siteConfig.upsert({
        where: { key: HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY },
        create: { key: HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY, value: "*" },
        update: { value: "*" },
      });
      await tx.canarySubmitNonce.deleteMany({ where: { ownerHmac: transaction.scopeOwnerHmac } });
      await tx.canaryObjectiveObservation.deleteMany({ where: { ownerHmac: transaction.scopeOwnerHmac } });
      await tx.canaryLedgerRecord.deleteMany({ where: { ownerHmac: transaction.scopeOwnerHmac } });
      await tx.reviewRun.deleteMany({ where: { ownerHmac: transaction.scopeOwnerHmac } });
      await tx.siteConfig.delete({ where: { key: HERO_VOICE_CANARY_LEDGER_MUTATION_GUARD_KEY } });
      const deleted = await tx.user.deleteMany({ where: { id: transaction.scopeUserId } });
      if (deleted.count !== 1) throw new Error("account_delete_authority_changed");
    } else {
      throw new Error("unknown_deletion_operation");
    }

    await tx.deletionTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "db_committed",
        dbCommittedAt: now,
        receiptJson,
        scopeUserId: null,
        scopeVoiceId: null,
        scopeReviewRunId: null,
        scopeOwnerHmac: null,
      },
    });
  });
}

async function unlinkQuarantineArtifacts(transactionId: string): Promise<void> {
  const context = heroVoiceCanaryStorageContext();
  const artifacts = await prisma.deletionArtifact.findMany({
    where: { deletionTransactionId: transactionId },
    orderBy: { id: "asc" },
  });
  for (const artifact of artifacts) {
    if (artifact.status === "unlinked") continue;
    const source = artifactSourcePath(context, artifact.rootKind as DeletionArtifactRootKind, artifact.storageKey);
    const quarantine = artifactQuarantinePath(context, transactionId, artifact.id);
    if (privateFileExists(source)) throw new Error("source_reappeared_after_database_commit");
    observe("before-unlink", artifact.id);
    if (privateFileExists(quarantine)) {
      unlinkPrivateFileNoFollow(quarantine, artifact.expectedSha256);
    }
    observe("after-unlink", artifact.id);
    await prisma.deletionArtifact.update({
      where: { id: artifact.id },
      data: { status: "unlinked", unlinkedAt: new Date() },
    });
  }
  removeEmptyQuarantineDirectory(context, transactionId);
}

async function commitTransactionC(transactionId: string): Promise<void> {
  const transaction = await prisma.deletionTransaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { artifacts: true },
  });
  if (transaction.status === "done") return;
  if (transaction.status !== "db_committed" || transaction.artifacts.some((artifact) => artifact.status !== "unlinked")) {
    throw new Error("deletion_readback_incomplete");
  }
  const context = heroVoiceCanaryStorageContext();
  for (const artifact of transaction.artifacts) {
    const source = artifactSourcePath(
      context,
      artifact.rootKind as DeletionArtifactRootKind,
      artifact.storageKey,
    );
    const quarantine = artifactQuarantinePath(context, transaction.id, artifact.id, false);
    if (privateFileExists(source) || privateFileExists(quarantine)) {
      throw new Error("deletion_absence_readback_failed");
    }
  }
  const now = new Date();
  const receiptJson = sanitizedReceipt({
    transactionId: transaction.id,
    receiptId: transaction.receiptId,
    outcome: transaction.intendedOutcome,
    artifactHashes: transaction.artifacts.map((artifact) => artifact.expectedSha256),
    plannedAt: transaction.plannedAt,
    dbCommittedAt: transaction.dbCommittedAt ?? now,
    doneAt: now,
  });
  await prisma.deletionTransaction.update({
    where: { id: transaction.id },
    data: { status: "done", doneAt: now, receiptJson },
  });
}

async function removeUploadFiles(transactionId: string, keepFinalReference: boolean): Promise<void> {
  const context = heroVoiceCanaryStorageContext();
  const upload = heroVoiceCanaryUploadPaths(context, transactionId, false);
  unlinkPrivateFileNoFollow(upload.rawSource);
  unlinkPrivateFileNoFollow(upload.normalizedWav);
  if (!keepFinalReference) unlinkPrivateFileNoFollow(upload.finalReference);
  removeEmptyUploadStagingDirectory(context, transactionId);
}

async function finishVoiceUploadTransaction(transactionId: string): Promise<void> {
  const transaction = await prisma.deletionTransaction.findUniqueOrThrow({ where: { id: transactionId } });
  if (transaction.operationKind !== "voice_upload") throw new Error("upload_intent_kind_invalid");
  if (transaction.status === "done" || transaction.status === "rolled_back") return;
  if (!transaction.configurationHmac
    || !ownerHmacMatches(transaction.configurationHmac, reviewConfigurationHmac())) {
    throw new Error("upload_configuration_changed");
  }

  if (transaction.status === "planned") {
    if (!transaction.scopeUserId || transaction.scopeVoiceId !== transaction.id) {
      throw new Error("upload_scope_missing");
    }
    const committedVoice = await prisma.userVoice.findFirst({
      where: {
        id: transaction.id,
        userId: transaction.scopeUserId,
        filename: `${transaction.id}.wav`,
      },
      select: { id: true },
    });
    if (!committedVoice) {
      await removeUploadFiles(transaction.id, false);
      await prisma.deletionTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "rolled_back",
          rolledBackAt: new Date(),
          scopeUserId: null,
          scopeVoiceId: null,
        },
      });
      return;
    }
    await prisma.deletionTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "db_committed",
        dbCommittedAt: transaction.dbCommittedAt ?? new Date(),
        scopeUserId: null,
        scopeVoiceId: null,
      },
    });
  }

  const committed = await prisma.deletionTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
  if (committed.status !== "db_committed") throw new Error("upload_intent_state_invalid");
  const voice = await prisma.userVoice.findUnique({
    where: { id: committed.id },
    select: { filename: true },
  });
  const upload = heroVoiceCanaryUploadPaths(heroVoiceCanaryStorageContext(), committed.id, false);
  if (voice?.filename !== upload.filename || !privateFileExists(upload.finalReference)) {
    throw new Error("upload_authority_invalid");
  }
  await removeUploadFiles(committed.id, true);
  const doneAt = new Date();
  const dbCommittedAt = committed.dbCommittedAt ?? doneAt;
  await prisma.deletionTransaction.update({
    where: { id: committed.id },
    data: {
      status: "done",
      doneAt,
      receiptJson: sanitizedReceipt({
        transactionId: committed.id,
        receiptId: committed.receiptId,
        outcome: committed.intendedOutcome,
        artifactHashes: [],
        plannedAt: committed.plannedAt,
        dbCommittedAt,
        doneAt,
      }),
    },
  });
}

async function removePlannedReviewCreationFiles(transactionId: string): Promise<void> {
  const context = heroVoiceCanaryStorageContext();
  const artifacts = await prisma.deletionArtifact.findMany({ where: { deletionTransactionId: transactionId } });
  for (const artifact of artifacts) {
    const source = artifactSourcePath(context, "review_private", artifact.storageKey);
    // A process death while writing a declared staging file may leave a
    // partial hash. Planned creation owns the pathname, so containment and
    // no-follow checks—not a completed-content hash—authorize rollback.
    if (privateFileExists(source)) unlinkPrivateFileNoFollow(source);
  }
  const runId = artifacts[0]?.storageKey.split("/")[0];
  if (runId && OPAQUE_ID.test(runId)) {
    const runDirectory = path.join(context.reviewRoot, runId);
    const stagingDirectory = path.join(runDirectory, "staging");
    try { if (fs.readdirSync(stagingDirectory).length === 0) fs.rmdirSync(stagingDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { if (fs.readdirSync(runDirectory).length === 0) fs.rmdirSync(runDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsyncDirectory(context.reviewRoot);
  }
}

async function finishReviewArtifactCreation(transactionId: string): Promise<void> {
  const transaction = await prisma.deletionTransaction.findUniqueOrThrow({
    where: { id: transactionId }, include: { artifacts: true },
  });
  if (transaction.operationKind !== "review_artifact_create") throw new Error("review_artifact_intent_kind_invalid");
  if (transaction.status === "done" || transaction.status === "rolled_back") return;
  if (!transaction.configurationHmac
    || !ownerHmacMatches(transaction.configurationHmac, reviewConfigurationHmac())) {
    throw new Error("review_artifact_configuration_changed");
  }
  if (transaction.status === "planned") {
    const run = transaction.scopeReviewRunId ? await prisma.reviewRun.findFirst({
      where: { id: transaction.scopeReviewRunId, ownerHmac: transaction.scopeOwnerHmac ?? undefined },
      select: { state: true, privateArtifactManifestJson: true },
    }) : null;
    const finalArtifacts = transaction.artifacts.filter((artifact) => !artifact.storageKey.includes("/staging/"));
    const expectedManifest = serializeHeroVoiceCanaryReviewArtifactManifest(
      finalArtifacts.map((artifact) => ({ storageKey: artifact.storageKey, sha256: artifact.expectedSha256 })),
    );
    if (!run || run.state === "collecting" || run.privateArtifactManifestJson !== expectedManifest) {
      await removePlannedReviewCreationFiles(transaction.id);
      await prisma.deletionTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "rolled_back", rolledBackAt: new Date(),
          scopeReviewRunId: null, scopeOwnerHmac: null,
        },
      });
      return;
    }
    await prisma.deletionTransaction.update({
      where: { id: transaction.id },
      data: { status: "db_committed", dbCommittedAt: new Date(), scopeReviewRunId: null, scopeOwnerHmac: null },
    });
  }
  const committed = await prisma.deletionTransaction.findUniqueOrThrow({
    where: { id: transaction.id }, include: { artifacts: true },
  });
  if (committed.status !== "db_committed") throw new Error("review_artifact_intent_state_invalid");
  const context = heroVoiceCanaryStorageContext();
  for (const artifact of committed.artifacts) {
    const source = artifactSourcePath(context, "review_private", artifact.storageKey);
    const isStaging = artifact.storageKey.includes("/staging/");
    if ((isStaging && privateFileExists(source))
      || (!isStaging && (!privateFileExists(source) || sha256File(source) !== artifact.expectedSha256))) {
      throw new Error("review_artifact_readback_invalid");
    }
  }
  const runId = committed.artifacts[0]?.storageKey.split("/")[0];
  if (runId && OPAQUE_ID.test(runId)) {
    const stagingDirectory = path.join(context.reviewRoot, runId, "staging");
    try { if (fs.readdirSync(stagingDirectory).length === 0) fs.rmdirSync(stagingDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsyncDirectory(path.join(context.reviewRoot, runId));
  }
  await prisma.deletionArtifact.updateMany({
    where: { deletionTransactionId: committed.id },
    data: { status: "committed" },
  });
  await prisma.deletionTransaction.update({
    where: { id: committed.id }, data: { status: "done", doneAt: new Date() },
  });
}

async function finishTransaction(transactionId: string): Promise<void> {
  const initial = await prisma.deletionTransaction.findUniqueOrThrow({ where: { id: transactionId } });
  if (initial.status === "done" || initial.status === "rolled_back") return;
  if (initial.operationKind === "voice_upload") {
    await finishVoiceUploadTransaction(transactionId);
    return;
  }
  if (initial.operationKind === "review_artifact_create") {
    await finishReviewArtifactCreation(transactionId);
    return;
  }
  const currentConfigurationHmac = initial.operationKind === "single_voice_delete"
    ? storageConfigurationFingerprint()
    : reviewConfigurationHmac();
  if (!initial.configurationHmac
    || !ownerHmacMatches(initial.configurationHmac, currentConfigurationHmac)) {
    throw new Error("deletion_configuration_changed");
  }
  if (initial.status === "planned") {
    if (await databaseAuthorityCommitted(initial)) {
      await prisma.deletionTransaction.update({
        where: { id: initial.id },
        data: {
          status: "db_committed",
          dbCommittedAt: initial.dbCommittedAt ?? new Date(),
          scopeUserId: null,
          scopeVoiceId: null,
          scopeReviewRunId: null,
          scopeOwnerHmac: null,
        },
      });
    } else {
      await moveArtifactsToQuarantine(transactionId);
      observe("before-transaction-b", transactionId);
      try {
        await commitTransactionB(transactionId);
      } catch (error) {
        if (error instanceof HeroVoiceDeletionSimulatedCrash) throw error;
        await restoreArtifactsAfterDatabaseRollback(transactionId);
        throw error;
      }
      observe("after-transaction-b", transactionId);
    }
  }
  await unlinkQuarantineArtifacts(transactionId);
  observe("before-transaction-c", transactionId);
  await commitTransactionC(transactionId);
  observe("after-transaction-c", transactionId);
}

async function reconcileNonterminalTransactionsUnlocked(): Promise<void> {
  const pending = await prisma.deletionTransaction.findMany({
    where: { status: { in: [...NONTERMINAL] } },
    orderBy: [{ plannedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  for (const transaction of pending) await finishTransaction(transaction.id);
}

export async function reconcileHeroVoiceDeletionTransactions(): Promise<void> {
  await assertHeroVoiceCanaryMutationReady();
  await withCoordinatorLock(async () => {
    await requireMarkedCanaryDatabase();
    await reconcileNonterminalTransactionsUnlocked();
  });
}

async function assertNoUnresolvedIntent(): Promise<void> {
  const unresolved = await prisma.deletionTransaction.count({ where: { status: { in: [...NONTERMINAL] } } });
  if (unresolved !== 0) throw new Error("unresolved_deletion_transaction");
}

export async function beginHeroVoiceCanaryUploadIntent(userId: string): Promise<string> {
  const transactionId = randomUUID();
  const receiptId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await assertNoCanaryAccountDeletionInTransaction(tx, userId);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new HeroVoiceDeletionError("User not found", "USER_NOT_FOUND", 404);
    const [voiceCount, pendingUploads] = await Promise.all([
      tx.userVoice.count({ where: { userId, deletionTransactionId: null } }),
      tx.deletionTransaction.count({
        where: {
          operationKind: "voice_upload",
          status: { in: [...NONTERMINAL] },
          scopeUserId: userId,
        },
      }),
    ]);
    if (voiceCount + pendingUploads >= 10) {
      throw new HeroVoiceDeletionError("Voice limit reached", "USER_VOICE_LIMIT_REACHED", 409);
    }
    await tx.deletionTransaction.create({
      data: {
        id: transactionId,
        operationKind: "voice_upload" satisfies CoordinatorOperationKind,
        intendedOutcome: "voice_upload_committed",
        scopeUserId: userId,
        scopeVoiceId: transactionId,
        configurationHmac: reviewConfigurationHmac(),
        receiptId,
      },
    });
  });
  observe("after-upload-intent", transactionId);
  return transactionId;
}

export async function commitHeroVoiceCanaryUploadRow(input: {
  transactionId: string;
  userId: string;
  name: string;
  refText: string;
  durationMs: number;
  consentVersion: string;
}): Promise<void> {
  const upload = heroVoiceCanaryUploadPaths(heroVoiceCanaryStorageContext(), input.transactionId, false);
  if (!privateFileExists(upload.finalReference)) throw new Error("upload_final_reference_missing");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const intent = await tx.deletionTransaction.findFirst({
      where: {
        id: input.transactionId,
        operationKind: "voice_upload",
        status: "planned",
        scopeUserId: input.userId,
        scopeVoiceId: input.transactionId,
      },
    });
    if (!intent) throw new Error("upload_intent_authority_changed");
    await assertNoCanaryAccountDeletionInTransaction(tx, input.userId);
    await tx.userVoice.create({
      data: {
        id: input.transactionId,
        userId: input.userId,
        name: input.name,
        refText: input.refText,
        filename: upload.filename,
        durationMs: input.durationMs,
        consentVersion: input.consentVersion,
      },
    });
    await tx.deletionTransaction.update({
      where: { id: intent.id },
      data: {
        status: "db_committed",
        dbCommittedAt: now,
        receiptJson: sanitizedReceipt({
          transactionId: intent.id,
          receiptId: intent.receiptId,
          outcome: intent.intendedOutcome,
          artifactHashes: [],
          plannedAt: intent.plannedAt,
          dbCommittedAt: now,
        }),
        scopeUserId: null,
        scopeVoiceId: null,
      },
    });
  });
  observe("after-upload-row-commit", input.transactionId);
}

export async function finishHeroVoiceCanaryUpload(transactionId: string): Promise<void> {
  await finishVoiceUploadTransaction(transactionId);
  await assertNoUnresolvedIntent();
}

/** Transaction A for blind-review creation. All final storage keys and hashes
 * become discoverable in the same SQLite deletion authority before byte one is
 * written. Callers are already under the serialized canary coordinator. */
export async function beginHeroVoiceCanaryReviewArtifactIntent(input: {
  runId: string;
  ownerHmac: string;
  artifacts: readonly { storageKey: string; sha256: string }[];
}): Promise<string> {
  if (!OPAQUE_ID.test(input.runId) || !SHA256_HEX.test(input.ownerHmac)
    || input.artifacts.length !== 74) throw new Error("review_artifact_intent_invalid");
  const finalKeys = input.artifacts.filter((artifact) => !artifact.storageKey.includes("/staging/"));
  const stagingKeys = input.artifacts.filter((artifact) => artifact.storageKey.includes("/staging/"));
  if (finalKeys.length !== 37 || stagingKeys.length !== 37
    || finalKeys.some((artifact) => !stagingKeys.some((staging) => (
      staging.storageKey === `${input.runId}/staging/${artifact.storageKey.slice(input.runId.length + 1)}`
      && staging.sha256 === artifact.sha256
    )))) throw new Error("review_artifact_intent_invalid");
  // Directory creation carries no private bytes. Establishing the trusted 0700
  // parent first lets crash reconciliation resolve every predeclared key even
  // when the process died immediately after Transaction A.
  const context = heroVoiceCanaryStorageContext();
  const runDirectory = path.join(context.reviewRoot, input.runId);
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const stagingDirectory = path.join(runDirectory, "staging");
  fs.mkdirSync(stagingDirectory, { mode: 0o700 });
  const runDirectoryMetadata = fs.lstatSync(runDirectory);
  if (!runDirectoryMetadata.isDirectory() || runDirectoryMetadata.isSymbolicLink()) {
    throw new Error("review_artifact_directory_invalid");
  }
  fs.chmodSync(runDirectory, 0o700);
  fs.chmodSync(stagingDirectory, 0o700);
  fsyncDirectory(runDirectory);
  fsyncDirectory(context.reviewRoot);
  const transactionId = randomUUID();
  observe("before-transaction-a", transactionId);
  await prisma.$transaction(async (tx) => {
    const run = await tx.reviewRun.findFirst({
      where: { id: input.runId, ownerHmac: input.ownerHmac, state: "preparing", revision: 1 },
      select: { id: true },
    });
    if (!run) throw new Error("review_artifact_authority_changed");
    await tx.deletionTransaction.create({
      data: {
        id: transactionId,
        operationKind: "review_artifact_create" satisfies CoordinatorOperationKind,
        intendedOutcome: "review_artifacts_created",
        scopeReviewRunId: input.runId,
        scopeOwnerHmac: input.ownerHmac,
        configurationHmac: reviewConfigurationHmac(),
        receiptId: randomUUID(),
        artifacts: {
          create: input.artifacts.map((artifact) => ({
            id: randomUUID(), rootKind: "review_private", storageKey: artifact.storageKey,
            expectedSha256: artifact.sha256,
          })),
        },
      },
    });
  });
  observe("after-transaction-a", transactionId);
  return transactionId;
}

export async function commitHeroVoiceCanaryReviewArtifactIntentInTransaction(
  tx: Prisma.TransactionClient,
  transactionId: string,
): Promise<void> {
  const transaction = await tx.deletionTransaction.findFirst({
    where: { id: transactionId, operationKind: "review_artifact_create", status: "planned" },
  });
  if (!transaction) throw new Error("review_artifact_intent_authority_changed");
  await tx.deletionTransaction.update({
    where: { id: transaction.id },
    data: {
      status: "db_committed", dbCommittedAt: new Date(),
      scopeReviewRunId: null, scopeOwnerHmac: null,
    },
  });
}

export async function finishHeroVoiceCanaryReviewArtifactIntent(transactionId: string): Promise<void> {
  await finishReviewArtifactCreation(transactionId);
}

export async function rollBackHeroVoiceCanaryReviewArtifactIntent(transactionId: string): Promise<void> {
  const transaction = await prisma.deletionTransaction.findUnique({ where: { id: transactionId } });
  if (!transaction || transaction.operationKind !== "review_artifact_create" || transaction.status !== "planned") return;
  await removePlannedReviewCreationFiles(transaction.id);
  await prisma.deletionTransaction.update({
    where: { id: transaction.id },
    data: { status: "rolled_back", rolledBackAt: new Date(), scopeReviewRunId: null, scopeOwnerHmac: null },
  });
}

export async function rollBackHeroVoiceCanaryUpload(transactionId: string): Promise<void> {
  const transaction = await prisma.deletionTransaction.findUnique({ where: { id: transactionId } });
  if (!transaction || transaction.operationKind !== "voice_upload") return;
  if (transaction.status !== "planned") {
    if (transaction.status === "db_committed") await finishVoiceUploadTransaction(transaction.id);
    return;
  }
  await removeUploadFiles(transaction.id, false);
  await prisma.deletionTransaction.update({
    where: { id: transaction.id },
    data: {
      status: "rolled_back",
      rolledBackAt: new Date(),
      scopeUserId: null,
      scopeVoiceId: null,
    },
  });
}

export async function deleteHeroVoiceCanaryVoice(userId: string, voiceId: string): Promise<boolean> {
  await assertHeroVoiceCanaryMutationReady();
  return withCoordinatorLock(async () => {
    await requireMarkedCanaryDatabase();
    await reconcileNonterminalTransactionsUnlocked();
    const voice = await prisma.userVoice.findFirst({ where: { id: voiceId, userId, deletionTransactionId: null } });
    if (!voice) return false;
    const artifact = plannedArtifact("user_voice_reference", voice.filename);
    const transactionId = randomUUID();
    const receiptId = randomUUID();
    observe("before-transaction-a", transactionId);
    await prisma.$transaction(async (tx) => {
      const activeJob = await tx.aiGenerationJob.findFirst({
        where: { userId, kind: "voice", model: `user_${voiceId}`, status: { in: ["queued", "in_progress"] } },
        select: { id: true },
      });
      if (activeJob) throw new HeroVoiceDeletionError(
        "Voice is currently in use", "USER_VOICE_IN_USE", 409,
      );
      const claimed = await tx.userVoice.updateMany({
        where: { id: voiceId, userId, deletionTransactionId: null },
        data: { deletionTransactionId: transactionId, deletionClaimedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Error("voice_delete_claim_conflict");
      await tx.deletionTransaction.create({
        data: {
          id: transactionId,
          operationKind: "single_voice_delete",
          intendedOutcome: "voice_deleted_reference_removed",
          scopeUserId: userId,
          scopeVoiceId: voiceId,
          configurationHmac: storageConfigurationFingerprint(),
          receiptId,
          artifacts: artifact ? { create: artifact } : undefined,
        },
      });
    });
    observe("after-transaction-a", transactionId);
    await finishTransaction(transactionId);
    await assertNoUnresolvedIntent();
    const context = heroVoiceCanaryStorageContext();
    if (await prisma.userVoice.count({ where: { id: voiceId } }) !== 0
      || privateFileExists(artifactSourcePath(context, "user_voice_reference", voice.filename))) {
      throw new Error("voice_delete_invariant_failed");
    }
    return true;
  });
}

export async function closeHeroVoiceCanaryReviewRun(input: {
  runId: string;
  ownerHmac: string;
  expectedRevision: number;
}): Promise<{ revision: number; receiptId: string }> {
  await assertHeroVoiceCanaryMutationReady();
  if (!OPAQUE_ID.test(input.runId) || !SHA256_HEX.test(input.ownerHmac)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new HeroVoiceDeletionError("Review run not found", "REVIEW_RUN_NOT_FOUND", 404);
  }
  return withCoordinatorLock(async () => {
    await requireMarkedCanaryDatabase();
    await reconcileNonterminalTransactionsUnlocked();
    const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
    if (!run) throw new HeroVoiceDeletionError("Review run not found", "REVIEW_RUN_NOT_FOUND", 404);
    if (run.state !== "revealed" || run.revision !== input.expectedRevision) {
      throw new HeroVoiceDeletionError("Review revision conflict", "REVIEW_RUN_REVISION_CONFLICT", 409);
    }
    const sanitizedAggregatesJson = JSON.stringify(
      parseSanitizedReviewAggregates(run.sanitizedAggregatesJson),
    );
    const reviewArtifacts = reviewPlannedArtifacts(run.privateArtifactManifestJson);
    const runJobs = await prisma.aiGenerationJob.findMany({
      where: { canaryRunId: run.id },
      select: { id: true },
    });
    const generatedArtifacts = listCloneGeneratedStorageKeys(runJobs.map((job) => job.id))
      .map((storageKey) => plannedArtifact("clone_generated", storageKey))
      .filter((artifact): artifact is PlannedArtifact => artifact !== null);
    const artifacts = [...reviewArtifacts, ...generatedArtifacts];
    const transactionId = randomUUID();
    const receiptId = randomUUID();
    observe("before-transaction-a", transactionId);
    await prisma.$transaction(async (tx) => {
      const current = await tx.reviewRun.findFirst({
        where: { id: run.id, ownerHmac: input.ownerHmac, state: "revealed", revision: input.expectedRevision },
        select: { id: true },
      });
      if (!current) throw new HeroVoiceDeletionError("Review revision conflict", "REVIEW_RUN_REVISION_CONFLICT", 409);
      await tx.deletionTransaction.create({
        data: {
          id: transactionId,
          operationKind: "owner_review_close",
          intendedOutcome: "review_closed_sanitized_run_retained",
          scopeReviewRunId: run.id,
          scopeOwnerHmac: input.ownerHmac,
          configurationHmac: reviewConfigurationHmac(),
          receiptId,
          artifacts: artifacts.length ? { create: artifacts } : undefined,
        },
      });
    });
    observe("after-transaction-a", transactionId);
    await finishTransaction(transactionId);
    await assertNoUnresolvedIntent();
    const closed = await prisma.reviewRun.findUniqueOrThrow({ where: { id: run.id } });
    const [remainingLedger, remainingNonces, remainingObservations] = await Promise.all([
      prisma.canaryLedgerRecord.count({ where: { runId: run.id } }),
      prisma.canarySubmitNonce.count({ where: { runId: run.id } }),
      prisma.canaryObjectiveObservation.count({ where: { runId: run.id } }),
    ]);
    if (closed.state !== "closed" || closed.receiptId !== receiptId
      || closed.privateArtifactManifestJson !== null || closed.rawScoresJson !== null
      || closed.revealCiphertextJson !== null || closed.ledgerSequence !== 0
      || closed.revealCiphertextSha256 !== null || closed.scoreSheetHmac !== null
      || closed.slotManifestJson !== null || closed.referenceVoiceId !== null
      || closed.reviewPreparationJson !== null
      || closed.publicReviewJson !== null || closed.gitCommitSha !== null
      || closed.ledgerHeadHmac !== null || closed.sanitizedAggregatesJson !== sanitizedAggregatesJson
      || remainingLedger !== 0 || remainingNonces !== 0 || remainingObservations !== 0) {
      throw new Error("review_close_invariant_failed");
    }
    return { revision: closed.revision, receiptId };
  });
}

export async function hardDeleteHeroVoiceCanaryAccount(input: {
  userId: string;
  authIssuer: string;
  authSubject: string;
}): Promise<boolean> {
  await assertHeroVoiceCanaryMutationReady();
  const configuredIssuer = process.env.HERO_VOICE_CANARY_AUTH_ISSUER;
  if (!configuredIssuer || configuredIssuer !== input.authIssuer) {
    throw new HeroVoiceDeletionError("Verified authentication claims are required", "CANARY_AUTH_CLAIMS_INVALID", 400);
  }
  const ownerHmac = computeHeroVoiceCanaryOwnerHmac(input);
  return withCoordinatorLock(async () => {
    await requireMarkedCanaryDatabase();
    await reconcileNonterminalTransactionsUnlocked();
    const user = await prisma.user.findFirst({ where: { id: input.userId, clerkId: input.authSubject } });
    if (!user) return false;
    const unrelatedBrandAssets = await prisma.brandAsset.count({ where: { userId: user.id } });
    if (unrelatedBrandAssets !== 0) {
      throw new HeroVoiceDeletionError(
        "Canary account contains out-of-scope brand assets",
        "CANARY_ACCOUNT_SCOPE_INVALID",
        409,
      );
    }
    const [voices, jobs, reviewRuns] = await Promise.all([
      prisma.userVoice.findMany({ where: { userId: user.id, deletionTransactionId: null } }),
      prisma.aiGenerationJob.findMany({
        where: { userId: user.id },
        select: { id: true },
      }),
      prisma.reviewRun.findMany({ where: { ownerHmac } }),
    ]);
    const artifacts: PlannedArtifact[] = [];
    for (const voice of voices) {
      const artifact = plannedArtifact("user_voice_reference", voice.filename);
      if (artifact) artifacts.push(artifact);
    }
    for (const storageKey of listCloneGeneratedStorageKeys(jobs.map((job) => job.id))) {
      const artifact = plannedArtifact("clone_generated", storageKey);
      if (artifact) artifacts.push(artifact);
    }
    for (const run of reviewRuns) artifacts.push(...reviewPlannedArtifacts(run.privateArtifactManifestJson));
    const uniqueArtifacts = [...new Map(
      artifacts.map((artifact) => [`${artifact.rootKind}:${artifact.storageKey}`, artifact]),
    ).values()];
    if (uniqueArtifacts.length !== artifacts.length) throw new Error("duplicate_account_deletion_artifact");

    const transactionId = randomUUID();
    const receiptId = randomUUID();
    observe("before-transaction-a", transactionId);
    await prisma.$transaction(async (tx) => {
      const current = await tx.user.findFirst({ where: { id: user.id, clerkId: input.authSubject }, select: { id: true } });
      if (!current) throw new Error("account_delete_authority_changed");
      const currentVoices = await tx.userVoice.findMany({
        where: { userId: user.id, deletionTransactionId: null }, select: { id: true }, orderBy: { id: "asc" },
      });
      if (currentVoices.map((voice) => voice.id).join("\0") !== voices.map((voice) => voice.id).sort().join("\0")) {
        throw new Error("account_voice_scope_changed");
      }
      const currentJobs = await tx.aiGenerationJob.findMany({
        where: { userId: user.id },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      if (currentJobs.map((job) => job.id).join("\0") !== jobs.map((job) => job.id).sort().join("\0")) {
        throw new Error("account_job_scope_changed");
      }
      const currentReviewRuns = await tx.reviewRun.findMany({
        where: { ownerHmac }, select: { id: true }, orderBy: { id: "asc" },
      });
      if (currentReviewRuns.map((run) => run.id).join("\0") !== reviewRuns.map((run) => run.id).sort().join("\0")) {
        throw new Error("account_review_scope_changed");
      }
      await tx.userVoice.updateMany({
        where: { userId: user.id, deletionTransactionId: null },
        data: { deletionTransactionId: transactionId, deletionClaimedAt: new Date() },
      });
      await tx.deletionTransaction.create({
        data: {
          id: transactionId,
          operationKind: "account_hard_delete",
          intendedOutcome: "account_rows_and_private_artifacts_deleted",
          scopeUserId: user.id,
          scopeOwnerHmac: ownerHmac,
          configurationHmac: reviewConfigurationHmac(),
          receiptId,
          artifacts: uniqueArtifacts.length ? { create: uniqueArtifacts } : undefined,
        },
      });
    });
    observe("after-transaction-a", transactionId);
    await finishTransaction(transactionId);
    await assertNoUnresolvedIntent();
    const [
      remainingUser,
      remainingVoices,
      remainingJobs,
      remainingAttempts,
      remainingBalance,
      remainingLedger,
      remainingRuns,
    ] = await Promise.all([
      prisma.user.count({ where: { id: user.id } }),
      prisma.userVoice.count({ where: { userId: user.id } }),
      prisma.aiGenerationJob.count({ where: { userId: user.id } }),
      prisma.aiGenerationAttempt.count({ where: { job: { userId: user.id } } }),
      prisma.creditBalance.count({ where: { userId: user.id } }),
      prisma.creditLedger.count({ where: { userId: user.id } }),
      prisma.reviewRun.count({ where: { ownerHmac } }),
    ]);
    if (remainingUser + remainingVoices + remainingJobs + remainingAttempts
      + remainingBalance + remainingLedger + remainingRuns !== 0) {
      throw new Error("account_delete_invariant_failed");
    }
    return true;
  });
}

/** Every canary mutation that can create owner data uses this read inside its
 * own SQLite transaction. It closes the account-delete/create race without a
 * filesystem lock or second authority. */
export async function assertNoCanaryAccountDeletionInTransaction(
  tx: { deletionTransaction: { count(args: unknown): Promise<number> } },
  userId: string,
): Promise<void> {
  if (!heroVoiceCanaryDeletionConfigured()) return;
  const pending = await tx.deletionTransaction.count({
    where: { operationKind: "account_hard_delete", status: { in: [...NONTERMINAL] }, scopeUserId: userId },
  });
  if (pending !== 0) throw new HeroVoiceCanaryReadOnlyError();
}

export const HERO_VOICE_DELETION_OPERATION_KINDS: readonly OperationKind[] = Object.freeze([
  "single_voice_delete", "owner_review_close", "account_hard_delete",
]);
