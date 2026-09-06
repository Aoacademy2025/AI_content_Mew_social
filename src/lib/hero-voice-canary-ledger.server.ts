import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import {
  decodeHeroVoiceCanaryReviewIkm,
  deriveHeroVoiceCanaryRunKey,
  heroVoiceCanaryHexMatches,
  heroVoiceCanaryHmacHex,
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import {
  computeHeroVoiceCanaryCost,
  parseHeroVoiceCanaryManifest,
  type HeroVoiceCanaryManifest,
  type HeroVoiceCanarySlot,
} from "@/lib/hero-voice-canary-manifest";
import type { PreparedHeroVoiceCanaryWireRequest } from "@/lib/hero-voice-canary-wire";
import { verifyPreparedHeroVoiceCanaryWireRequest } from "@/lib/hero-voice-canary-wire";
import {
  buildHeroVoiceCanaryObjectiveEvidence,
  verifyHeroVoiceCanaryObjectiveEvidence,
  type HeroVoiceCanaryObjectiveEvidenceAuthority,
  type HeroVoiceCanaryObjectiveEvidencePhase,
} from "@/lib/hero-voice-canary-objective-evidence.server";
import {
  assertHeroVoiceCanaryMutationReady,
  runHeroVoiceCanarySerializedMutation,
} from "@/lib/hero-voice-deletion-coordinator.server";
import { prisma } from "@/lib/prisma";

const ZERO_HMAC = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/u;
const SAFE_SLOT_ID = /^[a-z0-9][a-z0-9.-]{3,119}$/u;
const SAFE_STATUS = new Set(["completed", "failed", "cancelled", "timed_out", "unknown"]);
const RUN_STATES = [
  "planned", "running_ablation", "running_baseline", "running_candidate",
  "reviewable", "review_passed_pending_mew_approval", "aborted_no_go", "completed_no_go",
] as const;
const TERMINAL_RUN_STATES = new Set<string>([
  "reviewable", "review_passed_pending_mew_approval", "aborted_no_go", "completed_no_go",
]);
export type HeroVoiceCanaryLedgerCrashStep =
  | "after-record-before-head"
  | "after-state-before-transition-record"
  | "after-inflight-before-intent-record"
  | "after-submission-before-terminal-transition"
  | "after-accepted-ledger-before-provider-binding";
let ledgerCrashObserver: ((step: HeroVoiceCanaryLedgerCrashStep) => void) | undefined;

export function setHeroVoiceCanaryLedgerCrashObserverForTests(
  observer?: (step: HeroVoiceCanaryLedgerCrashStep) => void,
): void {
  if (process.env.NODE_ENV === "production") throw new Error("ledger crash injection unavailable");
  ledgerCrashObserver = observer;
}

function observeLedgerCrash(step: HeroVoiceCanaryLedgerCrashStep): void {
  ledgerCrashObserver?.(step);
}

export type HeroVoiceCanaryRunState = typeof RUN_STATES[number];
export type HeroVoiceCanaryCancelDisposition = "not_requested" | "confirmed" | "rejected_or_unknown";
export type HeroVoiceCanaryParkDisposition = "not_required" | "confirmed" | "unconfirmed";
export type HeroVoiceCanarySubmissionDisposition = "provider_accepted" | "provider_rejected" | "transport_unknown";
export type HeroVoiceCanaryAcceptedOutcome =
  | "valid_completed"
  | "provider_terminal_failed"
  | "accepted_outcome_unknown"
  | "application_validation_failed";

export type HeroVoiceCanaryLedgerPayload =
  | Readonly<{
      type: "run_created";
      manifestSha256: string;
      totalUpperBoundUsdMicros: number;
      maxJobs: 44;
    }>
  | Readonly<{
      type: "run_transition";
      from: HeroVoiceCanaryRunState;
      to: HeroVoiceCanaryRunState;
      reason: string;
    }>
  | Readonly<{
      type: "dispatch_intent";
      slotId: string;
      ordinal: number;
      wireRequestSha256: string;
      descriptorSha256: string;
      descriptor: PreparedHeroVoiceCanaryWireRequest["descriptor"];
      reservedUsdMicros: number;
      preDispatchAtMs: number;
    }>
  | Readonly<{
      type: HeroVoiceCanarySubmissionDisposition;
      slotId: string;
      providerJobId: string | null;
      observedAtMs: number;
    }>
  | Readonly<{
      type: "accepted_outcome";
      slotId: string;
      outcome: HeroVoiceCanaryAcceptedOutcome;
      primaryStatus: string;
      cancelDisposition: HeroVoiceCanaryCancelDisposition;
      audioSha256: string | null;
      durationMs: number | null;
      delayTimeMs: number | null;
      executionTimeMs: number | null;
      observedAtMs: number;
    }>
  | Readonly<{
      type: "cer_result";
      slotId: string;
      batchKind: "ablation-8" | "final-36";
      evaluatorBatchId: string;
      runtimeFingerprintSha256: string;
      evaluatorImageDigest: string;
      modelSha256: string;
      ffmpegBinarySha256: string;
      inputAudioSha256: string;
      expectedTextSha256: string;
      cerNumerator: number;
      cerDenominator: number;
    }>
  | Readonly<{
      type: "park_disposition";
      disposition: HeroVoiceCanaryParkDisposition;
      observedAtMs: number;
    }>
  | Readonly<{
      type: "evaluator_batch";
      batchKind: "ablation-8" | "final-36";
      evaluatorBatchId: string;
      runtimeFingerprintSha256: string;
      evaluatorImageDigest: string;
      modelSha256: string;
      ffmpegBinarySha256: string;
      dependencyLockSha256: string;
      inventorySha256: string;
      fixtureTranscriptCerSha256: string;
      preFixtureProcessHashes: readonly [string, string, string];
      postFixtureProcessHashes: readonly [string, string, string];
    }>
  | Readonly<{
      type: "objective_evidence";
      phase: "ablation-8" | "final-36";
      evidenceSha256: string;
      evidenceHmac: string;
    }>;

export type VerifiedHeroVoiceCanaryLedgerRecord = Readonly<{
  sequence: number;
  previousRecordHmac: string;
  record: HeroVoiceCanaryLedgerPayload;
  recordHmac: string;
}>;

export type HeroVoiceCanaryCounters = Readonly<{
  plannedSlots: 44;
  notStarted: number;
  dispatchIntents: number;
  providerRejected: number;
  transportUnknown: number;
  providerAccepted: number;
  validCompleted: number;
  providerTerminalFailed: number;
  acceptedOutcomeUnknown: number;
  applicationValidationFailed: number;
  possibleProviderReceived: readonly [number, number];
}>;

export class HeroVoiceCanaryLedgerError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super("Hero Voice canary evidence is unavailable");
    this.name = "HeroVoiceCanaryLedgerError";
  }
}

function reviewIkm(): Buffer {
  const encoded = process.env.HERO_VOICE_CANARY_REVIEW_KEY;
  if (!encoded) throw new HeroVoiceCanaryLedgerError("CANARY_REVIEW_KEY_INVALID", 503);
  try { return decodeHeroVoiceCanaryReviewIkm(encoded); } catch {
    throw new HeroVoiceCanaryLedgerError("CANARY_REVIEW_KEY_INVALID", 503);
  }
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isSafeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function isNullableBoundedInteger(value: unknown, maximum: number): value is number | null {
  return value === null || isSafeInteger(value, 0, maximum);
}

function parseLedgerDescriptor(value: unknown): PreparedHeroVoiceCanaryWireRequest["descriptor"] {
  const keys = [
    "arm", "contractVersion", "endpointId", "expectedCatalogVersion", "expectedWorkerVersion", "imageDigest",
    "matchedSettings", "matchedSettingsSha256", "mode", "modelManifestSha256", "normalizerVersion", "policy",
    "refTextSha256", "referenceSha256", "requestCommitmentSha256", "runnerKind", "sourceRevision", "templateId",
    "textSha256", "version",
  ];
  if (!exactKeys(value, keys) || value.version !== 1 || value.mode !== "clone"
    || !["BaselineV13Direct", "CandidateExperimentV3Direct", "CandidateAiStudioV3"].includes(String(value.runnerKind))
    || ![2, 3].includes(Number(value.contractVersion))
    || ![value.endpointId, value.templateId, value.expectedWorkerVersion].every((item) => (
      typeof item === "string" && item.length >= 3 && item.length <= 160
    ))
    || typeof value.sourceRevision !== "string" || value.sourceRevision.length > 160
    || !/^sha256:[0-9a-f]{64}$/u.test(String(value.imageDigest))
    || ![value.modelManifestSha256, value.matchedSettingsSha256, value.refTextSha256,
      value.referenceSha256, value.textSha256].every(isHex64)
    || !(value.expectedCatalogVersion === null || typeof value.expectedCatalogVersion === "string")
    || !(value.normalizerVersion === null || typeof value.normalizerVersion === "string")
    || !(value.requestCommitmentSha256 === null || isHex64(value.requestCommitmentSha256))
    || !exactKeys(value.matchedSettings, ["mixedLanguage", "numStep", "outputChannels", "outputRate", "outputSubtype", "speed"])
    || value.matchedSettings.mixedLanguage !== true || value.matchedSettings.numStep !== 32
    || value.matchedSettings.outputChannels !== 1 || value.matchedSettings.outputRate !== 24_000
    || value.matchedSettings.outputSubtype !== "PCM_16" || value.matchedSettings.speed !== 1
    || !exactKeys(value.policy, ["executionTimeout", "ttl"])
    || value.policy.executionTimeout !== 540_000 || value.policy.ttl !== 900_000
    || !exactKeys(value.arm, [
      "candidateCount", "contractVersion", "guidance", "profile", "ranking", "referenceTreatment",
      "seed", "seedSupport", "temperature", "watermark",
    ])
    || value.arm.contractVersion !== value.contractVersion || value.arm.candidateCount !== 3
    || value.arm.temperature !== 0.8
    || !["baseline-v13", "control-v1", "reference-enhancement-v1", "text-normalization-v1",
      "guidance-ranking-v1", "watermark-v1", "combined-quality-v1",
      "combined-quality-thai-dominant-v1"].includes(String(value.arm.profile))
    || !["speaker-cosine-max", "speaker-cosine-plus-0.15-pitch"].includes(String(value.arm.ranking))
    || !["audited-v13-reference", "demucs-then-peak-0.95"].includes(String(value.arm.referenceTreatment))
    || !["unsupported-v2", "explicit-v3"].includes(String(value.arm.seedSupport))
    || !["none", "audioseal-v1"].includes(String(value.arm.watermark))
    || !(value.arm.seed === null || isSafeInteger(value.arm.seed, 0, 2_147_483_647))
    || !(value.arm.guidance === null || value.arm.guidance === 2 || value.arm.guidance === 2.5)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_RECORD_INVALID");
  }
  return value as PreparedHeroVoiceCanaryWireRequest["descriptor"];
}

/** Exact runtime decoder for every ledger union member. It is deliberately
 * duplicated at append and read boundaries so a typed caller cannot smuggle
 * extras and a mutated SQLite row cannot enter the state machine. */
export function parseHeroVoiceCanaryLedgerPayload(value: unknown): HeroVoiceCanaryLedgerPayload {
  if (!exactKeys(value, Object.keys(value && typeof value === "object" && !Array.isArray(value) ? value : {}))
    || typeof value.type !== "string") throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_RECORD_INVALID");
  const fail = (): never => { throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_RECORD_INVALID"); };
  switch (value.type) {
    case "run_created":
      if (!exactKeys(value, ["manifestSha256", "maxJobs", "totalUpperBoundUsdMicros", "type"])
        || !isHex64(value.manifestSha256) || value.maxJobs !== 44
        || !isSafeInteger(value.totalUpperBoundUsdMicros, 1, 10_000_000)) fail();
      break;
    case "run_transition":
      if (!exactKeys(value, ["from", "reason", "to", "type"])
        || !RUN_STATES.includes(value.from as HeroVoiceCanaryRunState)
        || !RUN_STATES.includes(value.to as HeroVoiceCanaryRunState)
        || typeof value.reason !== "string" || !/^[a-z][a-z0-9_]{2,95}$/u.test(value.reason)) fail();
      break;
    case "dispatch_intent":
      if (!exactKeys(value, ["descriptor", "descriptorSha256", "ordinal", "preDispatchAtMs", "reservedUsdMicros", "slotId", "type", "wireRequestSha256"])
        || typeof value.slotId !== "string" || !SAFE_SLOT_ID.test(value.slotId)
        || !isSafeInteger(value.ordinal, 1, 44) || !isHex64(value.wireRequestSha256)
        || !isHex64(value.descriptorSha256) || !isSafeInteger(value.reservedUsdMicros, 1, 10_000_000)
        || !isSafeInteger(value.preDispatchAtMs, 1, 9_007_199_254_740_991)) fail();
      parseLedgerDescriptor(value.descriptor);
      if (heroVoiceCanarySha256(heroVoiceCanaryJcsBytes(value.descriptor)) !== value.descriptorSha256) fail();
      break;
    case "provider_accepted":
    case "provider_rejected":
    case "transport_unknown":
      if (!exactKeys(value, ["observedAtMs", "providerJobId", "slotId", "type"])
        || typeof value.slotId !== "string" || !SAFE_SLOT_ID.test(value.slotId)
        || !isSafeInteger(value.observedAtMs, 1, 9_007_199_254_740_991)
        || (value.type === "provider_accepted"
          ? typeof value.providerJobId !== "string" || !SAFE_PROVIDER_JOB_ID.test(value.providerJobId)
          : value.providerJobId !== null)) fail();
      break;
    case "accepted_outcome": {
      if (!exactKeys(value, ["audioSha256", "cancelDisposition", "delayTimeMs", "durationMs", "executionTimeMs", "observedAtMs", "outcome", "primaryStatus", "slotId", "type"])
        || typeof value.slotId !== "string" || !SAFE_SLOT_ID.test(value.slotId)
        || !["valid_completed", "provider_terminal_failed", "accepted_outcome_unknown", "application_validation_failed"].includes(String(value.outcome))
        || typeof value.primaryStatus !== "string" || !SAFE_STATUS.has(value.primaryStatus)
        || !["not_requested", "confirmed", "rejected_or_unknown"].includes(String(value.cancelDisposition))
        || !(value.audioSha256 === null || isHex64(value.audioSha256))
        || !isNullableBoundedInteger(value.durationMs, 900_000)
        || !isNullableBoundedInteger(value.delayTimeMs, 900_000)
        || !isNullableBoundedInteger(value.executionTimeMs, 900_000)
        || !isSafeInteger(value.observedAtMs, 1, 9_007_199_254_740_991)) fail();
      if (value.outcome === "valid_completed"
        ? value.primaryStatus !== "completed" || value.audioSha256 === null || value.durationMs === null
          || value.delayTimeMs === null || value.executionTimeMs === null
        : value.audioSha256 !== null || value.durationMs !== null || value.delayTimeMs !== null
          || value.executionTimeMs !== null) fail();
      break;
    }
    case "cer_result":
      if (!exactKeys(value, ["batchKind", "cerDenominator", "cerNumerator", "evaluatorBatchId", "evaluatorImageDigest", "expectedTextSha256", "ffmpegBinarySha256", "inputAudioSha256", "modelSha256", "runtimeFingerprintSha256", "slotId", "type"])
        || typeof value.slotId !== "string" || !SAFE_SLOT_ID.test(value.slotId)
        || !["ablation-8", "final-36"].includes(String(value.batchKind))
        || typeof value.evaluatorBatchId !== "string" || !OPAQUE_ID.test(value.evaluatorBatchId)
        || !/^sha256:[0-9a-f]{64}$/u.test(String(value.evaluatorImageDigest))
        || ![value.runtimeFingerprintSha256, value.modelSha256, value.ffmpegBinarySha256,
          value.inputAudioSha256, value.expectedTextSha256].every(isHex64)
        || !isSafeInteger(value.cerNumerator, 0, 1_000_000)
        || !isSafeInteger(value.cerDenominator, 1, 1_000_000)) fail();
      break;
    case "park_disposition":
      if (!exactKeys(value, ["disposition", "observedAtMs", "type"])
        || !["not_required", "confirmed", "unconfirmed"].includes(String(value.disposition))
        || !isSafeInteger(value.observedAtMs, 1, 9_007_199_254_740_991)) fail();
      break;
    case "evaluator_batch":
      if (!exactKeys(value, ["batchKind", "dependencyLockSha256", "evaluatorBatchId", "evaluatorImageDigest", "ffmpegBinarySha256", "fixtureTranscriptCerSha256", "inventorySha256", "modelSha256", "postFixtureProcessHashes", "preFixtureProcessHashes", "runtimeFingerprintSha256", "type"])
        || !["ablation-8", "final-36"].includes(String(value.batchKind))
        || typeof value.evaluatorBatchId !== "string" || !OPAQUE_ID.test(value.evaluatorBatchId)
        || !/^sha256:[0-9a-f]{64}$/u.test(String(value.evaluatorImageDigest))
        || ![value.runtimeFingerprintSha256, value.modelSha256, value.ffmpegBinarySha256,
          value.dependencyLockSha256, value.inventorySha256, value.fixtureTranscriptCerSha256].every(isHex64)
        || !Array.isArray(value.preFixtureProcessHashes) || value.preFixtureProcessHashes.length !== 3
        || !value.preFixtureProcessHashes.every(isHex64)
        || !Array.isArray(value.postFixtureProcessHashes) || value.postFixtureProcessHashes.length !== 3
        || !value.postFixtureProcessHashes.every(isHex64)) fail();
      break;
    case "objective_evidence":
      if (!exactKeys(value, ["evidenceHmac", "evidenceSha256", "phase", "type"])
        || !["ablation-8", "final-36"].includes(String(value.phase))
        || !isHex64(value.evidenceSha256) || !isHex64(value.evidenceHmac)) fail();
      break;
    default: fail();
  }
  return Object.freeze(value as unknown as HeroVoiceCanaryLedgerPayload);
}

function parseRecordJson(value: string): HeroVoiceCanaryLedgerPayload {
  const bytes = Buffer.from(value, "utf8");
  const parsed = parseHeroVoiceCanaryStrictJson(bytes);
  if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes) || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_RECORD_INVALID");
  }
  return parseHeroVoiceCanaryLedgerPayload(parsed);
}

function parseRunState(value: string): HeroVoiceCanaryRunState {
  if (!RUN_STATES.includes(value as HeroVoiceCanaryRunState)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_RUN_STATE_INVALID");
  }
  return value as HeroVoiceCanaryRunState;
}

function parseManifestJson(value: string | null, expectedSha256: string | null): HeroVoiceCanaryManifest {
  if (!value || !expectedSha256 || !HEX64.test(expectedSha256)
    || heroVoiceCanarySha256(Buffer.from(value, "utf8")) !== expectedSha256) {
    throw new HeroVoiceCanaryLedgerError("CANARY_MANIFEST_INVALID");
  }
  const parsed = parseHeroVoiceCanaryStrictJson(Buffer.from(value, "utf8"));
  const manifest = parseHeroVoiceCanaryManifest(parsed);
  if (!heroVoiceCanaryJcsBytes(manifest).equals(Buffer.from(value, "utf8"))) {
    throw new HeroVoiceCanaryLedgerError("CANARY_MANIFEST_INVALID");
  }
  return manifest;
}

type CanaryLedgerClient = Prisma.TransactionClient | typeof prisma;

async function verifyLedgerWithClient(client: CanaryLedgerClient, input: {
  runId: string;
  ownerHmac?: string;
}): Promise<readonly VerifiedHeroVoiceCanaryLedgerRecord[]> {
  const run = await client.reviewRun.findFirst({
    where: { id: input.runId, ...(input.ownerHmac ? { ownerHmac: input.ownerHmac } : {}) },
    select: { id: true, ownerHmac: true, ledgerSequence: true, ledgerHeadHmac: true },
  });
  if (!run) throw new HeroVoiceCanaryLedgerError("CANARY_RUN_NOT_FOUND", 404);
  const rows = await client.canaryLedgerRecord.findMany({ where: { runId: run.id }, orderBy: { sequence: "asc" } });
  const key = deriveHeroVoiceCanaryRunKey(reviewIkm(), "ledger", run.id);
  const verified: VerifiedHeroVoiceCanaryLedgerRecord[] = [];
  let previousRecordHmac = ZERO_HMAC;
  for (const [index, row] of rows.entries()) {
    const sequence = index + 1;
    if (row.sequence !== sequence || row.ownerHmac !== run.ownerHmac || !HEX64.test(row.recordHmac)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_CHAIN_INVALID");
    }
    const record = parseRecordJson(row.recordJson);
    const expected = heroVoiceCanaryHmacHex(key, {
      version: 1, runId: run.id, sequence, previousRecordHmac, record,
    });
    if (!heroVoiceCanaryHexMatches(expected, row.recordHmac)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_CHAIN_INVALID");
    }
    verified.push(Object.freeze({ sequence, previousRecordHmac, record, recordHmac: row.recordHmac }));
    previousRecordHmac = row.recordHmac;
  }
  if (run.ledgerSequence !== rows.length
    || (rows.length === 0 ? run.ledgerHeadHmac !== null : !heroVoiceCanaryHexMatches(run.ledgerHeadHmac ?? "", previousRecordHmac))) {
    throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_TRUNCATED");
  }
  return Object.freeze(verified);
}

export async function verifyHeroVoiceCanaryLedger(input: {
  runId: string;
  ownerHmac?: string;
}): Promise<readonly VerifiedHeroVoiceCanaryLedgerRecord[]> {
  return verifyLedgerWithClient(prisma, input);
}

export async function appendHeroVoiceCanaryLedgerRecordInTransaction(tx: Prisma.TransactionClient, input: {
  runId: string;
  ownerHmac: string;
  record: HeroVoiceCanaryLedgerPayload;
}): Promise<VerifiedHeroVoiceCanaryLedgerRecord> {
  const record = parseHeroVoiceCanaryLedgerPayload(input.record);
  const recordJson = heroVoiceCanaryJcsBytes(record).toString("utf8");
  const key = deriveHeroVoiceCanaryRunKey(reviewIkm(), "ledger", input.runId);
    const run = await tx.reviewRun.findFirst({
      where: { id: input.runId, ownerHmac: input.ownerHmac },
      select: { ledgerSequence: true, ledgerHeadHmac: true },
    });
    if (!run) throw new HeroVoiceCanaryLedgerError("CANARY_RUN_NOT_FOUND", 404);
    const sequence = run.ledgerSequence + 1;
    const previousRecordHmac = run.ledgerHeadHmac ?? ZERO_HMAC;
    if ((run.ledgerSequence === 0) !== (run.ledgerHeadHmac === null) || !HEX64.test(previousRecordHmac)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_HEAD_INVALID");
    }
    const recordHmac = heroVoiceCanaryHmacHex(key, {
      version: 1, runId: input.runId, sequence, previousRecordHmac, record: input.record,
    });
    await tx.canaryLedgerRecord.create({
      data: {
        id: randomUUID(), runId: input.runId, ownerHmac: input.ownerHmac,
        sequence, recordJson, recordHmac,
      },
    });
    observeLedgerCrash("after-record-before-head");
    const advanced = await tx.reviewRun.updateMany({
      where: {
        id: input.runId,
        ownerHmac: input.ownerHmac,
        ledgerSequence: run.ledgerSequence,
        ledgerHeadHmac: run.ledgerHeadHmac,
      },
      data: { ledgerSequence: sequence, ledgerHeadHmac: recordHmac },
    });
    if (advanced.count !== 1) throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_APPEND_RACE");
    return Object.freeze({ sequence, previousRecordHmac, record, recordHmac });
}

async function appendLedgerRecordUnlocked(input: {
  runId: string;
  ownerHmac: string;
  record: HeroVoiceCanaryLedgerPayload;
}): Promise<VerifiedHeroVoiceCanaryLedgerRecord> {
  return prisma.$transaction((tx) => appendHeroVoiceCanaryLedgerRecordInTransaction(tx, input));
}

export async function appendHeroVoiceCanaryLedgerRecord(input: {
  runId: string;
  ownerHmac: string;
  record: HeroVoiceCanaryLedgerPayload;
}): Promise<VerifiedHeroVoiceCanaryLedgerRecord> {
  await assertHeroVoiceCanaryMutationReady();
  return runHeroVoiceCanarySerializedMutation(() => appendLedgerRecordUnlocked(input));
}

export function heroVoiceCanaryCounters(
  records: readonly VerifiedHeroVoiceCanaryLedgerRecord[],
): HeroVoiceCanaryCounters {
  const recordsOf = <T extends HeroVoiceCanaryLedgerPayload["type"]>(type: T) => records
    .map((entry) => entry.record)
    .filter((record): record is Extract<HeroVoiceCanaryLedgerPayload, { type: T }> => record.type === type);
  const intents = recordsOf("dispatch_intent");
  const providerRejected = recordsOf("provider_rejected").length;
  const transportUnknown = recordsOf("transport_unknown").length;
  const providerAccepted = recordsOf("provider_accepted").length;
  const outcomes = recordsOf("accepted_outcome");
  const counts = {
    validCompleted: outcomes.filter((item) => item.outcome === "valid_completed").length,
    providerTerminalFailed: outcomes.filter((item) => item.outcome === "provider_terminal_failed").length,
    acceptedOutcomeUnknown: outcomes.filter((item) => item.outcome === "accepted_outcome_unknown").length,
    applicationValidationFailed: outcomes.filter((item) => item.outcome === "application_validation_failed").length,
  };
  if (intents.length !== providerRejected + transportUnknown + providerAccepted
    || providerAccepted < Object.values(counts).reduce((sum, value) => sum + value, 0)
    || intents.length > 44) {
    throw new HeroVoiceCanaryLedgerError("CANARY_LEDGER_CONSERVATION_INVALID");
  }
  const notStarted = 44 - intents.length;
  return Object.freeze({
    plannedSlots: 44,
    notStarted,
    dispatchIntents: intents.length,
    providerRejected,
    transportUnknown,
    providerAccepted,
    ...counts,
    possibleProviderReceived: Object.freeze([
      providerAccepted + providerRejected,
      providerAccepted + providerRejected + transportUnknown,
    ] as const),
  });
}

export async function createHeroVoiceCanaryRun(input: {
  runId: string;
  ownerHmac: string;
  referenceVoiceId: string;
  manifest: HeroVoiceCanaryManifest;
  manifestSha256: string;
}): Promise<void> {
  if (!OPAQUE_ID.test(input.runId) || !HEX64.test(input.ownerHmac)
    || !/^user_[A-Za-z0-9_-]{1,120}$/u.test(input.referenceVoiceId)
    || !HEX64.test(input.manifestSha256)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_RUN_INPUT_INVALID", 400);
  }
  const manifestBytes = heroVoiceCanaryJcsBytes(input.manifest);
  if (heroVoiceCanarySha256(manifestBytes) !== input.manifestSha256
    || input.manifest.totalUpperBoundUsdMicros > input.manifest.budgetUsdMicros) {
    throw new HeroVoiceCanaryLedgerError("CANARY_MANIFEST_INVALID");
  }
  parseHeroVoiceCanaryManifest(input.manifest);
  await runHeroVoiceCanarySerializedMutation(() => prisma.$transaction(async (tx) => {
    await tx.reviewRun.create({
      data: {
        id: input.runId,
        ownerHmac: input.ownerHmac,
        experimentId: input.manifest.experimentId,
        slotManifestSha256: input.manifestSha256,
        slotManifestJson: manifestBytes.toString("utf8"),
        referenceVoiceId: input.referenceVoiceId,
        runState: "planned",
        state: "collecting",
        revision: 1,
        costEvidenceJson: heroVoiceCanaryJcsBytes({
          version: 1,
          budgetUsdMicros: input.manifest.budgetUsdMicros,
          gpuReserveUsdMicros: input.manifest.gpuReserveUsdMicros,
          nonGpuReserveUsdMicros: input.manifest.nonGpuReserveUsdMicros,
          totalUpperBoundUsdMicros: input.manifest.totalUpperBoundUsdMicros,
        }).toString("utf8"),
      },
    });
    await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
      runId: input.runId,
      ownerHmac: input.ownerHmac,
      record: {
        type: "run_created",
        manifestSha256: input.manifestSha256,
        totalUpperBoundUsdMicros: input.manifest.totalUpperBoundUsdMicros,
        maxJobs: 44,
      },
    });
  }));
}

async function loadRunForMutation(runId: string, ownerHmac: string, client: CanaryLedgerClient = prisma) {
  const run = await client.reviewRun.findFirst({ where: { id: runId, ownerHmac } });
  if (!run) throw new HeroVoiceCanaryLedgerError("CANARY_RUN_NOT_FOUND", 404);
  return { run, manifest: parseManifestJson(run.slotManifestJson, run.slotManifestSha256) };
}

function submissionBySlot(records: readonly VerifiedHeroVoiceCanaryLedgerRecord[]): Map<string, HeroVoiceCanarySubmissionDisposition> {
  const output = new Map<string, HeroVoiceCanarySubmissionDisposition>();
  for (const { record } of records) {
    if (record.type === "provider_accepted" || record.type === "provider_rejected" || record.type === "transport_unknown") {
      if (output.has(record.slotId)) throw new HeroVoiceCanaryLedgerError("CANARY_SUBMISSION_DUPLICATE");
      output.set(record.slotId, record.type);
    }
  }
  return output;
}

function intentBySlot(records: readonly VerifiedHeroVoiceCanaryLedgerRecord[]): Map<string, Extract<HeroVoiceCanaryLedgerPayload, { type: "dispatch_intent" }>> {
  const output = new Map<string, Extract<HeroVoiceCanaryLedgerPayload, { type: "dispatch_intent" }>>();
  for (const { record } of records) {
    if (record.type !== "dispatch_intent") continue;
    if (output.has(record.slotId)) throw new HeroVoiceCanaryLedgerError("CANARY_DISPATCH_DUPLICATE");
    output.set(record.slotId, record);
  }
  return output;
}

function outcomeBySlot(records: readonly VerifiedHeroVoiceCanaryLedgerRecord[]): Map<string, Extract<HeroVoiceCanaryLedgerPayload, { type: "accepted_outcome" }>> {
  const output = new Map<string, Extract<HeroVoiceCanaryLedgerPayload, { type: "accepted_outcome" }>>();
  for (const { record } of records) {
    if (record.type !== "accepted_outcome") continue;
    if (output.has(record.slotId)) throw new HeroVoiceCanaryLedgerError("CANARY_OUTCOME_DUPLICATE");
    output.set(record.slotId, record);
  }
  return output;
}

function cerBySlot(records: readonly VerifiedHeroVoiceCanaryLedgerRecord[]): Map<string, Extract<HeroVoiceCanaryLedgerPayload, { type: "cer_result" }>> {
  const output = new Map<string, Extract<HeroVoiceCanaryLedgerPayload, { type: "cer_result" }>>();
  for (const { record } of records) {
    if (record.type !== "cer_result") continue;
    if (output.has(record.slotId)) throw new HeroVoiceCanaryLedgerError("CANARY_CER_DUPLICATE");
    output.set(record.slotId, record);
  }
  return output;
}

function expectedStateForSlot(slot: HeroVoiceCanarySlot): HeroVoiceCanaryRunState {
  return slot.phase === "ablation" ? "running_ablation"
    : slot.phase === "baseline" ? "running_baseline" : "running_candidate";
}

async function transitionRunInTransaction(tx: Prisma.TransactionClient, input: {
  runId: string;
  ownerHmac: string;
  from: HeroVoiceCanaryRunState;
  to: HeroVoiceCanaryRunState;
  reason: string;
  clearInFlight?: boolean;
}): Promise<void> {
  const changed = await tx.reviewRun.updateMany({
    where: { id: input.runId, ownerHmac: input.ownerHmac, runState: input.from },
    data: { runState: input.to, ...(input.clearInFlight ? { inFlightSlotId: null } : {}) },
  });
  if (changed.count !== 1) throw new HeroVoiceCanaryLedgerError("CANARY_RUN_TRANSITION_RACE");
  observeLedgerCrash("after-state-before-transition-record");
  await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
    runId: input.runId,
    ownerHmac: input.ownerHmac,
    record: { type: "run_transition", from: input.from, to: input.to, reason: input.reason },
  });
}

export async function abortHeroVoiceCanaryRunWithinSerializedMutation(input: {
  runId: string;
  ownerHmac: string;
  reason: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { run } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const from = parseRunState(run.runState);
    if (TERMINAL_RUN_STATES.has(from)) return;
    await transitionRunInTransaction(tx, {
      runId: run.id,
      ownerHmac: run.ownerHmac,
      from,
      to: "aborted_no_go",
      reason: input.reason,
      clearInFlight: true,
    });
  });
}

type CommitHeroVoiceCanaryDispatchIntentInput = {
  runId: string;
  ownerHmac: string;
  slotId: string;
  prepared: PreparedHeroVoiceCanaryWireRequest;
  nowMs?: number;
};

/** Internal seam for callers already executing under the Task 4 serialized
 * mutation coordinator. It must never be exposed through a route directly. */
export async function commitHeroVoiceCanaryDispatchIntentWithinSerializedMutation(
  input: CommitHeroVoiceCanaryDispatchIntentInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { run, manifest } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const runState = parseRunState(run.runState);
    if (TERMINAL_RUN_STATES.has(runState) || run.inFlightSlotId !== null) {
      throw new HeroVoiceCanaryLedgerError("CANARY_DISPATCH_DISABLED");
    }
    const records = await verifyLedgerWithClient(tx, { runId: run.id, ownerHmac: run.ownerHmac });
    const intents = intentBySlot(records);
    const nextSlot = manifest.slots[intents.size];
    if (!nextSlot || nextSlot.slotId !== input.slotId) throw new HeroVoiceCanaryLedgerError("CANARY_SLOT_ORDER_INVALID");
    const expectedState = expectedStateForSlot(nextSlot);
    if (runState === "planned") {
      if (expectedState !== "running_ablation") throw new HeroVoiceCanaryLedgerError("CANARY_PHASE_INVALID");
      await transitionRunInTransaction(tx, {
        runId: run.id, ownerHmac: run.ownerHmac, from: "planned", to: "running_ablation", reason: "first_ablation_dispatch",
      });
    } else if (runState !== expectedState) {
      throw new HeroVoiceCanaryLedgerError("CANARY_PHASE_INVALID");
    }
    verifyPreparedHeroVoiceCanaryWireRequest(input.prepared, nextSlot);
    computeHeroVoiceCanaryCost({
      rateUsdMicrosPerSecond: manifest.rateUsdMicrosPerSecond,
      nonGpuReserveComponents: manifest.nonGpuReserveComponents,
      submittedReservedSlots: intents.size,
      remainingMandatorySlots: manifest.slots.length - intents.size,
    });
    const claimed = await tx.reviewRun.updateMany({
      where: { id: run.id, ownerHmac: run.ownerHmac, inFlightSlotId: null, runState: expectedState },
      data: { inFlightSlotId: nextSlot.slotId },
    });
    if (claimed.count !== 1) throw new HeroVoiceCanaryLedgerError("CANARY_IN_FLIGHT_RACE");
    observeLedgerCrash("after-inflight-before-intent-record");
    await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
      runId: run.id,
      ownerHmac: run.ownerHmac,
      record: {
        type: "dispatch_intent",
        slotId: nextSlot.slotId,
        ordinal: nextSlot.ordinal,
        wireRequestSha256: input.prepared.wireRequestSha256,
        descriptorSha256: input.prepared.descriptorSha256,
        descriptor: input.prepared.descriptor,
        reservedUsdMicros: nextSlot.costReserve.usdMicros,
        preDispatchAtMs: input.nowMs ?? Date.now(),
      },
    });
  });
}

export async function commitHeroVoiceCanaryDispatchIntent(
  input: CommitHeroVoiceCanaryDispatchIntentInput,
): Promise<void> {
  await runHeroVoiceCanarySerializedMutation(
    () => commitHeroVoiceCanaryDispatchIntentWithinSerializedMutation(input),
  );
}

type RecordHeroVoiceCanarySubmissionInput = {
  runId: string;
  ownerHmac: string;
  slotId: string;
  disposition: HeroVoiceCanarySubmissionDisposition;
  providerJobId?: string;
  observedAtMs?: number;
  acceptedGeneration?: Readonly<{
    jobId: string;
    attemptId: string;
    providerStatus: "IN_QUEUE" | "IN_PROGRESS";
  }>;
};

export async function recordHeroVoiceCanarySubmissionInTransaction(
  tx: Prisma.TransactionClient,
  input: RecordHeroVoiceCanarySubmissionInput,
): Promise<{ primaryStillActive: boolean | null }> {
    const { run } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const runState = parseRunState(run.runState);
    if (TERMINAL_RUN_STATES.has(runState) || run.inFlightSlotId !== input.slotId) {
      throw new HeroVoiceCanaryLedgerError("CANARY_SUBMISSION_STATE_INVALID");
    }
    const records = await verifyLedgerWithClient(tx, { runId: run.id, ownerHmac: run.ownerHmac });
    if (!intentBySlot(records).has(input.slotId) || submissionBySlot(records).has(input.slotId)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_SUBMISSION_DUPLICATE");
    }
    const providerJobId = input.providerJobId ?? null;
    if (input.disposition === "provider_accepted") {
      if (!providerJobId || !SAFE_PROVIDER_JOB_ID.test(providerJobId)) {
        throw new HeroVoiceCanaryLedgerError("CANARY_PROVIDER_JOB_ID_INVALID");
      }
    } else if (providerJobId !== null) {
      throw new HeroVoiceCanaryLedgerError("CANARY_PROVIDER_JOB_ID_INVALID");
    }
    const linkedJob = await tx.aiGenerationJob.findFirst({
      where: { canaryRunId: run.id, canarySlotId: input.slotId },
      select: { id: true },
    });
    if (input.disposition === "provider_accepted" && Boolean(linkedJob) !== Boolean(input.acceptedGeneration)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_PROVIDER_ACCEPTANCE_BINDING_INVALID");
    }
    await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
      runId: run.id,
      ownerHmac: run.ownerHmac,
      record: { type: input.disposition, slotId: input.slotId, providerJobId, observedAtMs: input.observedAtMs ?? Date.now() },
    });
    if (input.disposition === "provider_accepted") {
      observeLedgerCrash("after-accepted-ledger-before-provider-binding");
    } else {
      observeLedgerCrash("after-submission-before-terminal-transition");
    }
    if (input.disposition !== "provider_accepted") {
      await transitionRunInTransaction(tx, {
        runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
        reason: input.disposition, clearInFlight: true,
      });
    }
    if (!input.acceptedGeneration) return { primaryStillActive: null };
    const now = new Date(input.observedAtMs ?? Date.now());
    const attempt = await tx.aiGenerationAttempt.findFirst({
      where: { id: input.acceptedGeneration.attemptId, jobId: input.acceptedGeneration.jobId },
    });
    const job = await tx.aiGenerationJob.findFirst({
      where: {
        id: input.acceptedGeneration.jobId,
        canaryRunId: run.id,
        canarySlotId: input.slotId,
      },
    });
    if (!attempt || !job || attempt.providerJobId !== null || job.providerJobId !== null
      || attempt.status !== "submitting"
      || !["intent_committed", "transport_unknown"].includes(attempt.submissionDisposition)
      || job.chargeState !== "reserved" || !["queued", "in_progress"].includes(job.status)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_PROVIDER_ACCEPTANCE_BINDING_INVALID");
    }
    const nextStatus = input.acceptedGeneration.providerStatus === "IN_PROGRESS" ? "in_progress" : "queued";
    const attemptChanged = await tx.aiGenerationAttempt.updateMany({
      where: { id: attempt.id, providerJobId: null, status: "submitting" },
      data: {
        providerJobId, status: nextStatus, submissionDisposition: "provider_accepted",
        providerResponseAt: now, dispatchLeaseExpiresAt: null, submittedAt: now,
      },
    });
    if (attemptChanged.count !== 1) throw new HeroVoiceCanaryLedgerError("CANARY_PROVIDER_ACCEPTANCE_BINDING_INVALID");
    await tx.aiGenerationJob.update({
      where: { id: job.id },
      data: {
        providerJobId, status: nextStatus,
        startedAt: nextStatus === "in_progress" ? (job.startedAt ?? now) : job.startedAt,
      },
    });
    return { primaryStillActive: true };
}

export async function recordHeroVoiceCanarySubmissionWithinSerializedMutation(
  input: RecordHeroVoiceCanarySubmissionInput,
): Promise<{ primaryStillActive: boolean | null }> {
  return prisma.$transaction((tx) => recordHeroVoiceCanarySubmissionInTransaction(tx, input));
}

export async function recordHeroVoiceCanarySubmission(
  input: RecordHeroVoiceCanarySubmissionInput,
): Promise<void> {
  await runHeroVoiceCanarySerializedMutation(
    () => recordHeroVoiceCanarySubmissionWithinSerializedMutation(input),
  );
}

const SAFE_PROVIDER_JOB_ID = /^[A-Za-z0-9_-]{1,160}$/u;

function rawCer(record: Extract<HeroVoiceCanaryLedgerPayload, { type: "cer_result" }>): number {
  if (!Number.isSafeInteger(record.cerNumerator) || record.cerNumerator < 0
    || !Number.isSafeInteger(record.cerDenominator) || record.cerDenominator <= 0) {
    throw new HeroVoiceCanaryLedgerError("CANARY_CER_INVALID");
  }
  return record.cerNumerator / record.cerDenominator;
}

export async function recordHeroVoiceCanaryResult(input: {
  runId: string;
  ownerHmac: string;
  slotId: string;
  outcome: HeroVoiceCanaryAcceptedOutcome;
  primaryStatus: string;
  cancelDisposition?: HeroVoiceCanaryCancelDisposition;
  audioSha256?: string;
  durationMs?: number;
  delayTimeMs?: number;
  executionTimeMs?: number;
  observedAtMs?: number;
}): Promise<void> {
  await runHeroVoiceCanarySerializedMutation(() => prisma.$transaction(async (tx) => {
    const { run, manifest } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const runState = parseRunState(run.runState);
    if (TERMINAL_RUN_STATES.has(runState) || run.inFlightSlotId !== input.slotId) {
      throw new HeroVoiceCanaryLedgerError("CANARY_RESULT_STATE_INVALID");
    }
    const slot = manifest.slots.find((item) => item.slotId === input.slotId);
    if (!slot || runState !== expectedStateForSlot(slot)) throw new HeroVoiceCanaryLedgerError("CANARY_RESULT_STATE_INVALID");
    const records = await verifyLedgerWithClient(tx, { runId: run.id, ownerHmac: run.ownerHmac });
    if (submissionBySlot(records).get(input.slotId) !== "provider_accepted" || outcomeBySlot(records).has(input.slotId)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_RESULT_DUPLICATE");
    }
    const isValid = input.outcome === "valid_completed";
    if (isValid) {
      if (!input.audioSha256 || !HEX64.test(input.audioSha256)
        || !Number.isSafeInteger(input.durationMs) || input.durationMs! <= 0
        || !Number.isSafeInteger(input.delayTimeMs) || input.delayTimeMs! < 0
        || !Number.isSafeInteger(input.executionTimeMs) || input.executionTimeMs! < 0) {
        throw new HeroVoiceCanaryLedgerError("CANARY_RESULT_INVALID");
      }
    }
    const record: Extract<HeroVoiceCanaryLedgerPayload, { type: "accepted_outcome" }> = Object.freeze({
      type: "accepted_outcome",
      slotId: input.slotId,
      outcome: input.outcome,
      primaryStatus: input.primaryStatus,
      cancelDisposition: input.cancelDisposition ?? "not_requested",
      audioSha256: input.audioSha256 ?? null,
      durationMs: input.durationMs ?? null,
      delayTimeMs: input.delayTimeMs ?? null,
      executionTimeMs: input.executionTimeMs ?? null,
      observedAtMs: input.observedAtMs ?? Date.now(),
    });
    await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, { runId: run.id, ownerHmac: run.ownerHmac, record });
    const abortReason: string | null = isValid ? null : input.outcome;
    if (abortReason) {
      await transitionRunInTransaction(tx, {
        runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
        reason: abortReason, clearInFlight: true,
      });
    } else {
      const cleared = await tx.reviewRun.updateMany({
        where: { id: run.id, ownerHmac: run.ownerHmac, runState, inFlightSlotId: input.slotId },
        data: { inFlightSlotId: null },
      });
      if (cleared.count !== 1) throw new HeroVoiceCanaryLedgerError("CANARY_RESULT_RACE");
    }
  }));
}

export type HeroVoiceCanaryEvaluatorEvidence = Readonly<{
  version: 1;
  batchKind: "ablation-8" | "final-36";
  evaluatorBatchId: string;
  runtimeFingerprintSha256: string;
  evaluatorImageDigest: string;
  modelSha256: string;
  ffmpegBinarySha256: string;
  dependencyLockSha256: string;
  inventorySha256: string;
  fixtureTranscriptCerSha256: string;
  preFixtureProcessHashes: readonly [string, string, string];
  postFixtureProcessHashes: readonly [string, string, string];
  platform: "linux/arm64";
  emulated: false;
  networkDisabled: true;
  inventoryCount: 8 | 36;
}>;

function validateEvaluatorEvidence(
  evidence: HeroVoiceCanaryEvaluatorEvidence,
  expectedKind: "ablation-8" | "final-36",
): void {
  const hashes = [
    evidence.runtimeFingerprintSha256, evidence.modelSha256, evidence.ffmpegBinarySha256,
    evidence.dependencyLockSha256, evidence.inventorySha256, evidence.fixtureTranscriptCerSha256,
    ...evidence.preFixtureProcessHashes, ...evidence.postFixtureProcessHashes,
  ];
  if (evidence.version !== 1 || evidence.batchKind !== expectedKind || !OPAQUE_ID.test(evidence.evaluatorBatchId)
    || !/^sha256:[0-9a-f]{64}$/u.test(evidence.evaluatorImageDigest)
    || evidence.platform !== "linux/arm64" || evidence.emulated !== false || evidence.networkDisabled !== true
    || evidence.inventoryCount !== (expectedKind === "ablation-8" ? 8 : 36)
    || hashes.some((hash) => !HEX64.test(hash))
    || new Set(evidence.preFixtureProcessHashes).size !== 1
    || new Set(evidence.postFixtureProcessHashes).size !== 1
    || evidence.preFixtureProcessHashes[0] !== evidence.postFixtureProcessHashes[0]
    || evidence.preFixtureProcessHashes[0] !== evidence.fixtureTranscriptCerSha256) {
    throw new HeroVoiceCanaryLedgerError("CANARY_EVALUATOR_EVIDENCE_INVALID");
  }
}

function evaluatorLedgerRecord(
  evidence: HeroVoiceCanaryEvaluatorEvidence,
): Extract<HeroVoiceCanaryLedgerPayload, { type: "evaluator_batch" }> {
  return Object.freeze({
    type: "evaluator_batch",
    batchKind: evidence.batchKind,
    evaluatorBatchId: evidence.evaluatorBatchId,
    runtimeFingerprintSha256: evidence.runtimeFingerprintSha256,
    evaluatorImageDigest: evidence.evaluatorImageDigest,
    modelSha256: evidence.modelSha256,
    ffmpegBinarySha256: evidence.ffmpegBinarySha256,
    dependencyLockSha256: evidence.dependencyLockSha256,
    inventorySha256: evidence.inventorySha256,
    fixtureTranscriptCerSha256: evidence.fixtureTranscriptCerSha256,
    preFixtureProcessHashes: evidence.preFixtureProcessHashes,
    postFixtureProcessHashes: evidence.postFixtureProcessHashes,
  });
}

export type HeroVoiceCanaryCerBatchResult = Readonly<{
  slotId: string;
  inputAudioSha256: string;
  expectedTextSha256: string;
  cerNumerator: number;
  cerDenominator: number;
}>;

/** Appends one uninterrupted evaluator batch after its post-fixture succeeds.
 * A crash partway through remains visibly incomplete and cannot be replaced. */
export async function recordHeroVoiceCanaryCerBatch(input: {
  runId: string;
  ownerHmac: string;
  evidence: HeroVoiceCanaryEvaluatorEvidence;
  results: readonly HeroVoiceCanaryCerBatchResult[];
}): Promise<void> {
  await runHeroVoiceCanarySerializedMutation(() => prisma.$transaction(async (tx) => {
    const { run, manifest } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const expectedKind = parseRunState(run.runState) === "running_ablation" ? "ablation-8"
      : parseRunState(run.runState) === "running_candidate" ? "final-36" : null;
    if (!expectedKind) throw new HeroVoiceCanaryLedgerError("CANARY_EVALUATOR_STATE_INVALID");
    validateEvaluatorEvidence(input.evidence, expectedKind);
    const records = await verifyLedgerWithClient(tx, { runId: run.id, ownerHmac: run.ownerHmac });
    if (records.some(({ record }) => record.type === "evaluator_batch" && record.batchKind === expectedKind)) {
      throw new HeroVoiceCanaryLedgerError("CANARY_EVALUATOR_BATCH_DUPLICATE");
    }
    const expectedSlots = manifest.slots.filter((slot) => expectedKind === "ablation-8"
      ? slot.phase === "ablation" : slot.phase !== "ablation");
    const outcomes = outcomeBySlot(records);
    const existingCer = cerBySlot(records);
    if (input.results.length !== expectedSlots.length
      || new Set(input.results.map((result) => result.slotId)).size !== expectedSlots.length
      || expectedSlots.some((slot) => !input.results.some((result) => result.slotId === slot.slotId)
        || outcomes.get(slot.slotId)?.outcome !== "valid_completed" || existingCer.has(slot.slotId))) {
      throw new HeroVoiceCanaryLedgerError("CANARY_EVALUATOR_INVENTORY_INVALID");
    }
    for (const result of input.results) {
      const slot = expectedSlots.find((candidate) => candidate.slotId === result.slotId)!;
      const outcome = outcomes.get(slot.slotId)!;
      if (!HEX64.test(result.inputAudioSha256) || result.inputAudioSha256 !== outcome.audioSha256
        || !HEX64.test(result.expectedTextSha256) || result.expectedTextSha256 !== slot.speechTextSha256
        || !Number.isSafeInteger(result.cerNumerator) || result.cerNumerator < 0
        || !Number.isSafeInteger(result.cerDenominator) || result.cerDenominator <= 0) {
        throw new HeroVoiceCanaryLedgerError("CANARY_CER_INVALID");
      }
    }
    await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, { runId: run.id, ownerHmac: run.ownerHmac, record: evaluatorLedgerRecord(input.evidence) });
    for (const result of input.results) {
      const slot = expectedSlots.find((candidate) => candidate.slotId === result.slotId)!;
      await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
        runId: run.id,
        ownerHmac: run.ownerHmac,
        record: Object.freeze({
          type: "cer_result" as const,
          slotId: slot.slotId,
          batchKind: expectedKind,
          evaluatorBatchId: input.evidence.evaluatorBatchId,
          runtimeFingerprintSha256: input.evidence.runtimeFingerprintSha256,
          evaluatorImageDigest: input.evidence.evaluatorImageDigest,
          modelSha256: input.evidence.modelSha256,
          ffmpegBinarySha256: input.evidence.ffmpegBinarySha256,
          inputAudioSha256: result.inputAudioSha256,
          expectedTextSha256: result.expectedTextSha256,
          cerNumerator: result.cerNumerator,
          cerDenominator: result.cerDenominator,
        }),
      });
    }
    await tx.reviewRun.update({
      where: { id: run.id },
      data: { evaluatorEvidenceJson: heroVoiceCanaryJcsBytes(input.evidence).toString("utf8") },
    });
  }));
}

const OBJECTIVE_OBSERVATION_FORBIDDEN_KEYS = new Set([
  "apikey", "cookie", "credential", "filepath", "filename", "ownerhmac", "rawaudio",
  "refaudio", "refaudiob64", "reviewkey", "secret", "session", "transcript", "userid",
]);

function assertSanitizedObjectiveObservation(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown): void => {
    nodes += 1;
    if (nodes > 20_000) throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
      return;
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > 512) throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 128) throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") {
      throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
    }
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
      if (OBJECTIVE_OBSERVATION_FORBIDDEN_KEYS.has(normalized)) {
        throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
      }
      visit(child);
    }
  };
  visit(value);
}

/** The parent authority commits exact sanitized observations before invoking
 * its captured signer. Existing rows are immutable-by-contract: restart may
 * reuse an identical observation but an adapter cannot replace it. */
export async function recordHeroVoiceCanaryObjectiveObservation(input: {
  runId: string;
  ownerHmac: string;
  phase: HeroVoiceCanaryObjectiveEvidencePhase;
  rows: unknown;
  authority: HeroVoiceCanaryObjectiveEvidenceAuthority;
  issuedAtMs?: number;
}): Promise<Readonly<{ bytes: Buffer; sha256: string; hmac: string }>> {
  assertSanitizedObjectiveObservation(input.rows);
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const unsignedBytes = heroVoiceCanaryJcsBytes({
    authority: "task6-independent-evidence-v1",
    issuedAtMs,
    manifestSha256: "0".repeat(64),
    phase: input.phase,
    rows: input.rows,
    runId: input.runId,
    version: 1,
  });
  if (unsignedBytes.length > 1_000_000) {
    throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
  }
  const captured = await runHeroVoiceCanarySerializedMutation(() => prisma.$transaction(async (tx) => {
    const { run, manifest } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const expectedState = input.phase === "ablation-8" ? "running_ablation" : "running_candidate";
    if (run.runState !== expectedState || !run.slotManifestSha256) {
      throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_INVALID");
    }
    const bytes = heroVoiceCanaryJcsBytes({
      authority: "task6-independent-evidence-v1",
      issuedAtMs,
      manifestSha256: run.slotManifestSha256,
      phase: input.phase,
      rows: input.rows,
      runId: run.id,
      version: 1,
    });
    const sha256 = heroVoiceCanarySha256(bytes);
    const existing = await tx.canaryObjectiveObservation.findUnique({
      where: { runId_batchKind: { runId: run.id, batchKind: input.phase } },
    });
    if (existing) {
      if (existing.ownerHmac !== run.ownerHmac || existing.observationSha256 !== sha256
        || existing.observationJson !== bytes.toString("utf8")) {
        throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_MISMATCH");
      }
      return { run, manifest, bytes, existing };
    }
    const created = await tx.canaryObjectiveObservation.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        ownerHmac: run.ownerHmac,
        batchKind: input.phase,
        observationJson: bytes.toString("utf8"),
        observationSha256: sha256,
      },
    });
    return { run, manifest, bytes, existing: created };
  }));
  // This is intentionally after the durable observation transaction.
  const signed = buildHeroVoiceCanaryObjectiveEvidence({
    phase: input.phase,
    runId: captured.run.id,
    manifestSha256: captured.run.slotManifestSha256!,
    rows: (parseHeroVoiceCanaryStrictJson(captured.bytes) as { rows: unknown }).rows,
    issuedAtMs: Number((parseHeroVoiceCanaryStrictJson(captured.bytes) as { issuedAtMs: number }).issuedAtMs),
    authority: input.authority,
  });
  if (!signed.bytes.equals(captured.bytes)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_OBJECTIVE_OBSERVATION_MISMATCH");
  }
  const records = await verifyHeroVoiceCanaryLedger({ runId: captured.run.id, ownerHmac: captured.run.ownerHmac });
  const outcomes = outcomeBySlot(records);
  const audioBySlot = new Map([...outcomes.entries()].flatMap(([slotId, outcome]) => (
    outcome.outcome === "valid_completed" && outcome.audioSha256 ? [[slotId, outcome.audioSha256] as const] : []
  )));
  const providerJobIdBySlot = new Map(records.flatMap(({ record }) => (
    record.type === "provider_accepted" && record.providerJobId
      ? [[record.slotId, record.providerJobId] as const] : []
  )));
  verifyHeroVoiceCanaryObjectiveEvidence({
    bytes: signed.bytes,
    expectedSha256: signed.sha256,
    hmac: signed.hmac,
    phase: input.phase,
    runId: captured.run.id,
    manifestSha256: captured.run.slotManifestSha256!,
    manifest: captured.manifest,
    audioBySlot,
    providerJobIdBySlot,
    authority: input.authority,
  });
  await runHeroVoiceCanarySerializedMutation(() => prisma.canaryObjectiveObservation.update({
    where: { runId_batchKind: { runId: input.runId, batchKind: input.phase } },
    data: { evidenceSha256: signed.sha256, evidenceHmac: signed.hmac, signedAt: new Date() },
  }));
  return signed;
}

export async function finalizeHeroVoiceCanaryRun(input: {
  runId: string;
  ownerHmac: string;
  evidence: HeroVoiceCanaryEvaluatorEvidence;
  objectiveEvidenceBytes?: Uint8Array;
  objectiveEvidenceSha256?: string;
  objectiveEvidenceHmac?: string;
  objectiveAuthority?: HeroVoiceCanaryObjectiveEvidenceAuthority;
}): Promise<HeroVoiceCanaryRunState> {
  return runHeroVoiceCanarySerializedMutation(() => prisma.$transaction(async (tx) => {
    const { run, manifest } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    const runState = parseRunState(run.runState);
    if (TERMINAL_RUN_STATES.has(runState) || run.inFlightSlotId !== null) return runState;
    const records = await verifyLedgerWithClient(tx, { runId: run.id, ownerHmac: run.ownerHmac });
    const counters = heroVoiceCanaryCounters(records);
    const outcomes = outcomeBySlot(records);
    const audioBySlot = new Map([...outcomes.entries()].flatMap(([slotId, outcome]) => (
      outcome.outcome === "valid_completed" && outcome.audioSha256 ? [[slotId, outcome.audioSha256] as const] : []
    )));
    const providerJobIdBySlot = new Map(records.flatMap(({ record }) => (
      record.type === "provider_accepted" && record.providerJobId
        ? [[record.slotId, record.providerJobId] as const] : []
    )));
    if (runState === "running_ablation") {
      validateEvaluatorEvidence(input.evidence, "ablation-8");
      const cers = cerBySlot(records);
      const batch = records.find(({ record }) => record.type === "evaluator_batch" && record.batchKind === "ablation-8")?.record;
      const ablation = manifest.slots.filter((slot) => slot.phase === "ablation");
      const ablationOutputsPass = !!batch
        && heroVoiceCanaryJcsBytes(batch).equals(heroVoiceCanaryJcsBytes(evaluatorLedgerRecord(input.evidence)))
        && counters.providerAccepted === 8 && !ablation.some((slot) => {
        const result = outcomes.get(slot.slotId);
        const cer = cers.get(slot.slotId);
        return !result || result.outcome !== "valid_completed" || !cer || rawCer(cer) > 0.10;
      });
      if (!ablationOutputsPass) {
        await transitionRunInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
          reason: "ablation_output_gate_failed", clearInFlight: true,
        });
        return "aborted_no_go";
      }
      if (!input.objectiveEvidenceBytes || !input.objectiveEvidenceSha256 || !input.objectiveEvidenceHmac) {
        await transitionRunInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
          reason: "ablation_objective_evidence_missing", clearInFlight: true,
        });
        return "aborted_no_go";
      }
      let objective;
      try {
        const observation = await tx.canaryObjectiveObservation.findUnique({
          where: { runId_batchKind: { runId: run.id, batchKind: "ablation-8" } },
        });
        if (!observation || observation.ownerHmac !== run.ownerHmac
          || observation.observationJson !== Buffer.from(input.objectiveEvidenceBytes).toString("utf8")
          || observation.observationSha256 !== input.objectiveEvidenceSha256
          || observation.evidenceSha256 !== input.objectiveEvidenceSha256
          || observation.evidenceHmac !== input.objectiveEvidenceHmac || observation.signedAt === null) {
          throw new Error("canary_objective_observation_missing");
        }
        objective = verifyHeroVoiceCanaryObjectiveEvidence({
          bytes: input.objectiveEvidenceBytes,
          expectedSha256: input.objectiveEvidenceSha256,
          hmac: input.objectiveEvidenceHmac,
          phase: "ablation-8",
          runId: run.id,
          manifestSha256: run.slotManifestSha256!,
          manifest,
          audioBySlot,
          providerJobIdBySlot,
          authority: input.objectiveAuthority,
        });
      } catch {
        await transitionRunInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
          reason: "ablation_objective_evidence_invalid", clearInFlight: true,
        });
        return "aborted_no_go";
      }
      await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
        runId: run.id, ownerHmac: run.ownerHmac,
        record: { type: "objective_evidence", phase: "ablation-8", ...objective },
      });
      await transitionRunInTransaction(tx, {
        runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "running_baseline", reason: "ablation_batch_passed",
      });
      return "running_baseline";
    }
    if (runState === "running_baseline") {
      const baseline = manifest.slots.filter((slot) => slot.phase === "baseline");
      if (baseline.some((slot) => outcomes.get(slot.slotId)?.outcome !== "valid_completed")) {
        await transitionRunInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
          reason: "baseline_incomplete", clearInFlight: true,
        });
        return "aborted_no_go";
      }
      await transitionRunInTransaction(tx, {
        runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "running_candidate", reason: "baseline_complete",
      });
      return "running_candidate";
    }
    validateEvaluatorEvidence(input.evidence, "final-36");
    const cers = cerBySlot(records);
    const batch = records.find(({ record }) => record.type === "evaluator_batch" && record.batchKind === "final-36")?.record;
    const finalSlots = manifest.slots.filter((slot) => slot.phase !== "ablation");
    const candidates = manifest.slots.filter((slot) => slot.phase === "candidate");
    const candidatePasses = candidates.filter((slot) => {
      const cer = cers.get(slot.slotId);
      return outcomes.get(slot.slotId)?.outcome === "valid_completed" && cer && rawCer(cer) <= 0.10;
    }).length;
    const complete = !!batch
      && heroVoiceCanaryJcsBytes(batch).equals(heroVoiceCanaryJcsBytes(evaluatorLedgerRecord(input.evidence)))
      && counters.dispatchIntents === 44 && counters.providerAccepted === 44
      && counters.validCompleted === 44 && counters.providerRejected === 0 && counters.transportUnknown === 0
      && finalSlots.every((slot) => outcomes.get(slot.slotId)?.outcome === "valid_completed" && cers.has(slot.slotId));
    let finalObjectivePass = false;
    if (complete && input.objectiveEvidenceBytes && input.objectiveEvidenceSha256 && input.objectiveEvidenceHmac) {
      try {
        const observation = await tx.canaryObjectiveObservation.findUnique({
          where: { runId_batchKind: { runId: run.id, batchKind: "final-36" } },
        });
        if (!observation || observation.ownerHmac !== run.ownerHmac
          || observation.observationJson !== Buffer.from(input.objectiveEvidenceBytes).toString("utf8")
          || observation.observationSha256 !== input.objectiveEvidenceSha256
          || observation.evidenceSha256 !== input.objectiveEvidenceSha256
          || observation.evidenceHmac !== input.objectiveEvidenceHmac || observation.signedAt === null) {
          throw new Error("canary_objective_observation_missing");
        }
        const objective = verifyHeroVoiceCanaryObjectiveEvidence({
          bytes: input.objectiveEvidenceBytes,
          expectedSha256: input.objectiveEvidenceSha256,
          hmac: input.objectiveEvidenceHmac,
          phase: "final-36",
          runId: run.id,
          manifestSha256: run.slotManifestSha256!,
          manifest,
          audioBySlot,
          providerJobIdBySlot,
          authority: input.objectiveAuthority,
        });
        await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac,
          record: { type: "objective_evidence", phase: "final-36", ...objective },
        });
        finalObjectivePass = true;
      } catch { finalObjectivePass = false; }
    }
    const objectivePass = complete && candidatePasses >= 17 && finalObjectivePass;
    const next: HeroVoiceCanaryRunState = !complete ? "aborted_no_go"
      : objectivePass ? "reviewable" : "completed_no_go";
    await transitionRunInTransaction(tx, {
      runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: next,
      reason: !complete ? "final_execution_incomplete"
        : objectivePass ? "objective_gate_passed" : "objective_gate_failed",
    });
    return next;
  }));
}

export async function reconcileHeroVoiceCanaryRun(input: {
  runId: string;
  ownerHmac: string;
}): Promise<{ runState: HeroVoiceCanaryRunState; counters: HeroVoiceCanaryCounters; resumableProviderJobId: string | null }> {
  return runHeroVoiceCanarySerializedMutation(() => prisma.$transaction(async (tx) => {
    const { run } = await loadRunForMutation(input.runId, input.ownerHmac, tx);
    let runState = parseRunState(run.runState);
    let records = await verifyLedgerWithClient(tx, input);
    const submissions = submissionBySlot(records);
    const intents = intentBySlot(records);
    if (run.inFlightSlotId) {
      const intent = intents.get(run.inFlightSlotId);
      if (!intent) {
        // This cannot be emitted by the transactional writer. Treat a legacy
        // or manually corrupted crash image as terminal; never leave it stuck.
        await transitionRunInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
          reason: "reconcile_inflight_without_intent", clearInFlight: true,
        });
        records = await verifyLedgerWithClient(tx, input);
        return { runState: "aborted_no_go", counters: heroVoiceCanaryCounters(records), resumableProviderJobId: null };
      }
      const linkedJob = await tx.aiGenerationJob.findFirst({
        where: { canaryRunId: run.id, canarySlotId: run.inFlightSlotId },
        include: { attempts: { orderBy: { sequence: "desc" }, take: 1 } },
      });
      const linkedAttempt = linkedJob?.attempts[0];
      let disposition = submissions.get(run.inFlightSlotId);
      const durableProviderId = linkedJob?.providerJobId ?? linkedAttempt?.providerJobId ?? null;
      if (!disposition && durableProviderId && SAFE_PROVIDER_JOB_ID.test(durableProviderId)
        && (!linkedJob?.providerJobId || linkedJob.providerJobId === durableProviderId)
        && (!linkedAttempt?.providerJobId || linkedAttempt.providerJobId === durableProviderId)) {
        // Pre-repair crash image: provider acceptance reached Task 2 but not
        // Task 5. Bind the same known ID into the ledger; it is never unknown.
        await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac,
          record: {
            type: "provider_accepted", slotId: run.inFlightSlotId,
            providerJobId: durableProviderId, observedAtMs: Date.now(),
          },
        });
        disposition = "provider_accepted";
        records = await verifyLedgerWithClient(tx, input);
      }
      if (!disposition) {
        await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
          runId: run.id,
          ownerHmac: run.ownerHmac,
          record: {
            type: "transport_unknown", slotId: run.inFlightSlotId, providerJobId: null, observedAtMs: Date.now(),
          },
        });
        await transitionRunInTransaction(tx, {
          runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
          reason: "restart_after_unresolved_dispatch_intent", clearInFlight: true,
        });
        runState = "aborted_no_go";
        records = await verifyLedgerWithClient(tx, input);
      } else if (disposition === "provider_accepted") {
        const accepted = records.map((entry) => entry.record).find((record) => (
          record.type === "provider_accepted" && record.slotId === run.inFlightSlotId
        )) as Extract<HeroVoiceCanaryLedgerPayload, { type: HeroVoiceCanarySubmissionDisposition }> | undefined;
        const acceptedId = accepted?.providerJobId ?? null;
        if (!acceptedId) throw new HeroVoiceCanaryLedgerError("CANARY_PROVIDER_ACCEPTANCE_BINDING_INVALID");
        if (linkedJob && ((linkedJob.providerJobId && linkedJob.providerJobId !== acceptedId)
          || (linkedAttempt?.providerJobId && linkedAttempt.providerJobId !== acceptedId))) {
          await transitionRunInTransaction(tx, {
            runId: run.id, ownerHmac: run.ownerHmac, from: runState, to: "aborted_no_go",
            reason: "reconcile_provider_identity_mismatch", clearInFlight: true,
          });
          records = await verifyLedgerWithClient(tx, input);
          return { runState: "aborted_no_go", counters: heroVoiceCanaryCounters(records), resumableProviderJobId: null };
        }
        if (linkedJob && linkedAttempt && (!linkedJob.providerJobId || !linkedAttempt.providerJobId)) {
          await tx.aiGenerationJob.update({ where: { id: linkedJob.id }, data: { providerJobId: acceptedId } });
          await tx.aiGenerationAttempt.update({
            where: { id: linkedAttempt.id },
            data: { providerJobId: acceptedId, submissionDisposition: "provider_accepted", dispatchLeaseExpiresAt: null },
          });
        }
        return {
          runState,
          counters: heroVoiceCanaryCounters(records),
          resumableProviderJobId: acceptedId,
        };
      }
    }
    return { runState, counters: heroVoiceCanaryCounters(records), resumableProviderJobId: null };
  }));
}

const TASK6_GATE_NAMES = Object.freeze([
  "billing-bound-660-seconds", "clerk-test-sessions", "control-peak-parity",
  "cost-rate-readback", "demucs-compatibility", "github-object-readback",
  "immutable-endpoint-readback", "legal-human-data", "license",
  "linux-arm64-evaluator", "meaningful-normalizer-delta",
] as const);

export type HeroVoiceCanaryTask6EvidenceV1 = Readonly<{
  version: 1;
  status: "approved";
  evidenceId: string;
  manifestSha256: string;
  issuedAtMs: number;
  expiresAtMs: number;
  rows: readonly Readonly<{
    gate: typeof TASK6_GATE_NAMES[number];
    evidenceSha256: string;
    identitySha256: string;
    predicateSha256: string;
  }>[];
  evidenceHmac: string;
}>;

function task6EvidenceKey(): Buffer {
  const encoded = process.env.HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_TASK6_EVIDENCE_KEY_REQUIRED", 503);
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    throw new HeroVoiceCanaryLedgerError("CANARY_TASK6_EVIDENCE_KEY_REQUIRED", 503);
  }
  return key;
}

export function signHeroVoiceCanaryTask6EvidenceForTests(unsignedEvidence: unknown): string {
  if (process.env.NODE_ENV === "production") throw new Error("task6 evidence signer unavailable");
  return heroVoiceCanaryHmacHex(task6EvidenceKey(), {
    domain: "hero-voice-canary/v1/task6-evidence", evidence: unsignedEvidence,
  });
}

export function assertHeroVoiceCanaryTask6ApplyEvidence(input: {
  evidenceBytes?: Uint8Array;
  expectedSha256?: string;
  manifestSha256: string;
  nowMs?: number;
}): HeroVoiceCanaryTask6EvidenceV1 {
  const envDigest = process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
  if (!input.evidenceBytes || !input.expectedSha256 || !HEX64.test(input.expectedSha256)
    || envDigest !== input.expectedSha256 || heroVoiceCanarySha256(input.evidenceBytes) !== input.expectedSha256) {
    throw new HeroVoiceCanaryLedgerError("CANARY_TASK6_EVIDENCE_REQUIRED", 503);
  }
  const parsed = parseHeroVoiceCanaryStrictJson(input.evidenceBytes);
  if (!heroVoiceCanaryJcsBytes(parsed).equals(Buffer.from(input.evidenceBytes))
    || !exactKeys(parsed, ["evidenceHmac", "evidenceId", "expiresAtMs", "issuedAtMs", "manifestSha256", "rows", "status", "version"])
    || parsed.version !== 1 || parsed.status !== "approved" || !OPAQUE_ID.test(String(parsed.evidenceId ?? ""))
    || parsed.manifestSha256 !== input.manifestSha256 || !HEX64.test(String(parsed.manifestSha256))
    || !isSafeInteger(parsed.issuedAtMs, 1) || !isSafeInteger(parsed.expiresAtMs, 1)
    || (parsed.expiresAtMs as number) <= (parsed.issuedAtMs as number)
    || (parsed.expiresAtMs as number) - (parsed.issuedAtMs as number) > 86_400_000
    || (input.nowMs ?? Date.now()) < (parsed.issuedAtMs as number)
    || (input.nowMs ?? Date.now()) > (parsed.expiresAtMs as number)
    || !Array.isArray(parsed.rows) || parsed.rows.length !== TASK6_GATE_NAMES.length
    || parsed.rows.some((row) => !exactKeys(row, ["evidenceSha256", "gate", "identitySha256", "predicateSha256"])
      || !TASK6_GATE_NAMES.includes(row.gate as typeof TASK6_GATE_NAMES[number])
      || ![row.evidenceSha256, row.identitySha256, row.predicateSha256].every(isHex64))
    || new Set(parsed.rows.map((row) => (row as { gate: string }).gate)).size !== TASK6_GATE_NAMES.length
    || TASK6_GATE_NAMES.some((gate) => !(parsed.rows as unknown[])
      .some((row) => (row as { gate: string }).gate === gate))
    || !isHex64(parsed.evidenceHmac)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_TASK6_EVIDENCE_INVALID", 503);
  }
  const unsigned = { ...parsed };
  delete unsigned.evidenceHmac;
  const expectedHmac = heroVoiceCanaryHmacHex(task6EvidenceKey(), {
    domain: "hero-voice-canary/v1/task6-evidence", evidence: unsigned,
  });
  if (!heroVoiceCanaryHexMatches(expectedHmac, parsed.evidenceHmac as string)) {
    throw new HeroVoiceCanaryLedgerError("CANARY_TASK6_EVIDENCE_INVALID", 503);
  }
  return parsed as HeroVoiceCanaryTask6EvidenceV1;
}

export const HERO_VOICE_CANARY_CURRENT_APPLY_BLOCKERS = Object.freeze([
  "task3_control_peak_normalization_parity_unresolved",
  "demucs_torchaudio_incompatible_combined_profile",
  "linux_arm64_non_emulated_evaluator_unavailable",
  "clerk_test_issuer_audience_two_sessions_not_evidenced",
  "meaningful_normalizer_delta_independent_evidence_absent",
  "github_commitment_authority_readback_evidence_absent",
  "provider_legal_rate_license_evidence_absent",
] as const);

export function dryRunHeroVoiceCanary(input: {
  manifest: HeroVoiceCanaryManifest;
  manifestSha256: string;
  apply?: boolean;
  task6EvidenceBytes?: Uint8Array;
  task6EvidenceSha256?: string;
}): Readonly<{
  mode: "dry-run" | "apply-authorized";
  manifestSha256: string;
  slotCount: 44;
  smokeSlotId: "final.candidate.script-01.repeat-01";
  totalUpperBoundUsdMicros: number;
  blockers: typeof HERO_VOICE_CANARY_CURRENT_APPLY_BLOCKERS | readonly [];
}> {
  const bytes = heroVoiceCanaryJcsBytes(input.manifest);
  if (heroVoiceCanarySha256(bytes) !== input.manifestSha256 || input.manifest.slots.length !== 44) {
    throw new HeroVoiceCanaryLedgerError("CANARY_MANIFEST_INVALID");
  }
  if (input.apply) {
    assertHeroVoiceCanaryTask6ApplyEvidence({
      evidenceBytes: input.task6EvidenceBytes,
      expectedSha256: input.task6EvidenceSha256,
      manifestSha256: input.manifestSha256,
    });
    return Object.freeze({
      mode: "apply-authorized" as const,
      manifestSha256: input.manifestSha256,
      slotCount: 44 as const,
      smokeSlotId: "final.candidate.script-01.repeat-01" as const,
      totalUpperBoundUsdMicros: input.manifest.totalUpperBoundUsdMicros,
      blockers: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    mode: "dry-run",
    manifestSha256: input.manifestSha256,
    slotCount: 44,
    smokeSlotId: "final.candidate.script-01.repeat-01",
    totalUpperBoundUsdMicros: input.manifest.totalUpperBoundUsdMicros,
    blockers: HERO_VOICE_CANARY_CURRENT_APPLY_BLOCKERS,
  });
}

export async function dispatchNextHeroVoiceCanarySlot(input: {
  runId: string;
  ownerHmac: string;
  slotId: string;
  prepared: PreparedHeroVoiceCanaryWireRequest;
  dispatch: (bytes: Buffer) => Promise<
    | { disposition: "provider_accepted"; providerJobId: string }
    | { disposition: "provider_rejected" }
    | { disposition: "transport_unknown" }
  >;
}): Promise<void> {
  await commitHeroVoiceCanaryDispatchIntent(input);
  // Reverify after the durable callback and immediately before the exact same
  // Buffer is handed to the adapter. Mutation becomes terminal unknown rather
  // than risking a request different from the committed bytes.
  const { manifest } = await loadRunForMutation(input.runId, input.ownerHmac);
  const slot = manifest.slots.find((item) => item.slotId === input.slotId);
  if (!slot) throw new HeroVoiceCanaryLedgerError("CANARY_SLOT_NOT_FOUND", 404);
  try {
    verifyPreparedHeroVoiceCanaryWireRequest(input.prepared, slot);
  } catch {
    await recordHeroVoiceCanarySubmission({
      runId: input.runId, ownerHmac: input.ownerHmac, slotId: input.slotId, disposition: "transport_unknown",
    });
    return;
  }
  let result: Awaited<ReturnType<typeof input.dispatch>>;
  try { result = await input.dispatch(input.prepared.bytes); } catch {
    result = { disposition: "transport_unknown" };
  }
  await recordHeroVoiceCanarySubmission({
    runId: input.runId,
    ownerHmac: input.ownerHmac,
    slotId: input.slotId,
    disposition: result.disposition,
    ...(result.disposition === "provider_accepted" ? { providerJobId: result.providerJobId } : {}),
  });
}
