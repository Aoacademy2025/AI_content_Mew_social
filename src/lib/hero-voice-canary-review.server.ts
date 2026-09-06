import { execFile, spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  decodeHeroVoiceCanaryReviewIkm,
  decryptHeroVoiceCanaryReveal,
  deriveHeroVoiceCanaryRunKey,
  encryptHeroVoiceCanaryReveal,
  heroVoiceCanaryHexMatches,
  heroVoiceCanaryHmacHex,
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import {
  appendHeroVoiceCanaryLedgerRecordInTransaction,
  verifyHeroVoiceCanaryLedger,
} from "@/lib/hero-voice-canary-ledger.server";
import { parseHeroVoiceCanaryManifest, type HeroVoiceCanaryManifest } from "@/lib/hero-voice-canary-manifest";
import {
  beginHeroVoiceCanaryReviewArtifactIntent,
  closeHeroVoiceCanaryReviewRun,
  commitHeroVoiceCanaryReviewArtifactIntentInTransaction,
  finishHeroVoiceCanaryReviewArtifactIntent,
  observeHeroVoiceCanaryCrashForTests,
  rollBackHeroVoiceCanaryReviewArtifactIntent,
  runHeroVoiceCanarySerializedMutation,
  serializeHeroVoiceCanaryReviewArtifactManifest,
  serializeHeroVoiceCanarySanitizedReviewAggregates,
} from "@/lib/hero-voice-deletion-coordinator.server";
import {
  artifactSourcePath,
  durableWritePrivateFile,
  heroVoiceCanaryStorageContext,
  readPrivateFileNoFollow,
} from "@/lib/hero-voice-canary-storage.server";
import { prisma } from "@/lib/prisma";

const HEX64 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{22}$/u;
const SAFE_EXPERIMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,159}$/u;
const FLAGS = ["missing_text", "privacy_anomaly", "severe_distortion", "wrong_identity"] as const;
const FLAG_SET = new Set<string>(FLAGS);
const COMMITMENT_PATH_PREFIX = "docs/research/hero-voice-clone-canary/reveal-commitments/";
export const HERO_VOICE_CANARY_GITHUB_REPOSITORY_NODE_ID_ENV = "HERO_VOICE_CANARY_GITHUB_REPOSITORY_NODE_ID" as const;
export const HERO_VOICE_CANARY_GITHUB_CANONICAL_URL =
  "https://github.com/Aoacademy2025/AI_content_Mew_social" as const;
const HERO_VOICE_CANARY_GITHUB_REMOTE_URL = `${HERO_VOICE_CANARY_GITHUB_CANONICAL_URL}.git` as const;
const HERO_VOICE_CANARY_GIT_REF = "refs/heads/mewic/hero-voice-clone-prod-audit" as const;

export type HeroVoiceCanaryCriticalFlag = typeof FLAGS[number];
export type HeroVoiceCanaryScore = Readonly<{
  pairId: string;
  choice: "A" | "B" | "tie";
  flagsBySide: Readonly<{ A: readonly HeroVoiceCanaryCriticalFlag[]; B: readonly HeroVoiceCanaryCriticalFlag[] }>;
}>;

type RevealSide = Readonly<{
  arm: "baseline-v13" | "combined-quality-v1";
  slotId: string;
  audioSha256: string;
}>;

type RevealPair = Readonly<{
  pairId: string;
  comparisonKey: string;
  scriptId: string;
  repeatId: string;
  speechTextSha256: string;
  settingsSha256: string;
  A: RevealSide;
  B: RevealSide;
}>;

type RevealManifest = Readonly<{
  version: 1;
  experimentId: string;
  slotManifestSha256: string;
  pairs: readonly RevealPair[];
}>;

type PublicPair = Readonly<{
  pairId: string;
  audio: Readonly<{ A: string; B: string }>;
}>;

type PublicReview = Readonly<{ version: 1; pairs: readonly PublicPair[] }>;
type PrivateReview = Readonly<{
  version: 1;
  audioFiles: readonly Readonly<{ token: string; storageKey: string; sha256: string }>[];
  scores: readonly HeroVoiceCanaryScore[];
}>;

type ReviewPreparationV1 = Readonly<{
  version: 1;
  slotManifestSha256: string;
  outputAudioSha256: readonly Readonly<{ slotId: string; sha256: string }>[];
  publicReview: PublicReview;
  privateReview: PrivateReview;
  revealCiphertext: unknown;
  revealCiphertextSha256: string;
  gitRef: string;
  gitCommitmentPath: string;
  gitBlobSha256: string;
}>;

export type GitCommitmentBinding = Readonly<{
  repositoryNodeId: string;
  canonicalUrl: string;
  ref: string;
  commitSha: string;
  blobOid: string;
  path: string;
  blobSha256: string;
}>;

export interface GitCommitmentAuthority {
  publishCommitment(input: { path: string; ref: string; bytes: Buffer }): Promise<GitCommitmentBinding>;
  verifyCommitment(binding: GitCommitmentBinding, expectedBytes: Buffer): Promise<void>;
}

export interface GitHubCommitmentRemote {
  repositoryIdentity(): Promise<{ repositoryNodeId: string; canonicalUrl: string }>;
  pushCommitment(input: { path: string; ref: string; bytes: Buffer }): Promise<{
    commitSha: string;
    blobOid: string;
    created: boolean;
  }>;
  readRemoteRefCommit(input: { ref: string }): Promise<string>;
  readRemoteObject(input: { path: string; commitSha: string }): Promise<{ commitSha: string; blobOid: string; bytes: Buffer }>;
}

export class HeroVoiceCanaryReviewError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(status === 404 ? "Not found" : "Hero Voice canary review is unavailable");
    this.name = "HeroVoiceCanaryReviewError";
  }
}

function reviewIkm(): Buffer {
  const encoded = process.env.HERO_VOICE_CANARY_REVIEW_KEY;
  if (!encoded) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_KEY_INVALID", 503);
  try { return decodeHeroVoiceCanaryReviewIkm(encoded); } catch {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_KEY_INVALID", 503);
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseJcs<T>(value: string | null): T {
  if (!value) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
  const bytes = Buffer.from(value, "utf8");
  let parsed: unknown;
  try { parsed = parseHeroVoiceCanaryStrictJson(bytes); } catch {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
  }
  if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes)) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
  }
  return parsed as T;
}

function parseRunManifest(run: { slotManifestJson: string | null; slotManifestSha256: string | null }): HeroVoiceCanaryManifest {
  if (!run.slotManifestJson || !run.slotManifestSha256
    || heroVoiceCanarySha256(run.slotManifestJson) !== run.slotManifestSha256) {
    throw new HeroVoiceCanaryReviewError("CANARY_MANIFEST_INVALID");
  }
  try { return parseHeroVoiceCanaryManifest(parseJcs(run.slotManifestJson)); } catch {
    throw new HeroVoiceCanaryReviewError("CANARY_MANIFEST_INVALID");
  }
}

function parsePublic(value: string | null): PublicReview {
  const parsed = parseJcs<unknown>(value);
  if (!exactKeys(parsed, ["pairs", "version"]) || parsed.version !== 1 || !Array.isArray(parsed.pairs)
    || parsed.pairs.length !== 18) throw new HeroVoiceCanaryReviewError("CANARY_PUBLIC_REVIEW_INVALID");
  const pairs = parsed.pairs.map((item) => {
    if (!exactKeys(item, ["audio", "pairId"]) || typeof item.pairId !== "string" || !TOKEN.test(item.pairId)
      || !exactKeys(item.audio, ["A", "B"]) || typeof item.audio.A !== "string" || !TOKEN.test(item.audio.A)
      || typeof item.audio.B !== "string" || !TOKEN.test(item.audio.B)) {
      throw new HeroVoiceCanaryReviewError("CANARY_PUBLIC_REVIEW_INVALID");
    }
    return item as PublicPair;
  });
  if (new Set(pairs.map((pair) => pair.pairId)).size !== 18
    || new Set(pairs.flatMap((pair) => [pair.audio.A, pair.audio.B])).size !== 36) {
    throw new HeroVoiceCanaryReviewError("CANARY_PUBLIC_REVIEW_INVALID");
  }
  return Object.freeze({ version: 1, pairs: Object.freeze(pairs) });
}

function normalizeFlags(value: unknown): readonly HeroVoiceCanaryCriticalFlag[] {
  if (!Array.isArray(value) || value.some((flag) => typeof flag !== "string" || !FLAG_SET.has(flag))) {
    throw new HeroVoiceCanaryReviewError("CANARY_SCORE_INVALID", 400);
  }
  const normalized = [...new Set(value as HeroVoiceCanaryCriticalFlag[])].sort();
  if (normalized.length !== value.length) throw new HeroVoiceCanaryReviewError("CANARY_SCORE_INVALID", 400);
  return Object.freeze(normalized);
}

export function parseHeroVoiceCanaryScore(input: unknown, pairId: string): HeroVoiceCanaryScore {
  if (!TOKEN.test(pairId) || !exactKeys(input, ["choice", "flagsBySide"])
    || (input.choice !== "A" && input.choice !== "B" && input.choice !== "tie")
    || !exactKeys(input.flagsBySide, ["A", "B"])) {
    throw new HeroVoiceCanaryReviewError("CANARY_SCORE_INVALID", 400);
  }
  return Object.freeze({
    pairId,
    choice: input.choice,
    flagsBySide: Object.freeze({
      A: normalizeFlags(input.flagsBySide.A),
      B: normalizeFlags(input.flagsBySide.B),
    }),
  });
}

function parsePrivate(value: string | null): PrivateReview {
  const parsed = parseJcs<unknown>(value);
  if (!exactKeys(parsed, ["audioFiles", "scores", "version"]) || parsed.version !== 1
    || !Array.isArray(parsed.audioFiles) || parsed.audioFiles.length !== 36 || !Array.isArray(parsed.scores)) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
  }
  const audioFiles = parsed.audioFiles.map((item) => {
    if (!exactKeys(item, ["sha256", "storageKey", "token"])
      || typeof item.token !== "string" || !TOKEN.test(item.token)
      || typeof item.storageKey !== "string" || !/^[-A-Za-z0-9_]+\/[A-Za-z0-9_-]{22}\.wav$/u.test(item.storageKey)
      || typeof item.sha256 !== "string" || !HEX64.test(item.sha256)) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
    }
    return item as PrivateReview["audioFiles"][number];
  });
  if (new Set(audioFiles.map((file) => file.token)).size !== 36
    || new Set(audioFiles.map((file) => file.storageKey)).size !== 36) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
  }
  const scores = parsed.scores.map((score) => {
    if (!exactKeys(score, ["choice", "flagsBySide", "pairId"])) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
    }
    return parseHeroVoiceCanaryScore({ choice: score.choice, flagsBySide: score.flagsBySide }, String(score.pairId));
  });
  if (scores.length > 18 || new Set(scores.map((score) => score.pairId)).size !== scores.length) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PRIVATE_INVALID");
  }
  return Object.freeze({ version: 1, audioFiles: Object.freeze(audioFiles), scores: Object.freeze(scores) });
}

function bindingFromRun(run: {
  gitRepositoryNodeId: string | null; gitCanonicalUrl: string | null; gitRef: string | null;
  gitCommitSha: string | null; gitBlobOid: string | null; gitCommitmentPath: string | null; gitBlobSha256: string | null;
}): GitCommitmentBinding {
  const binding = {
    repositoryNodeId: run.gitRepositoryNodeId,
    canonicalUrl: run.gitCanonicalUrl,
    ref: run.gitRef,
    commitSha: run.gitCommitSha,
    blobOid: run.gitBlobOid,
    path: run.gitCommitmentPath,
    blobSha256: run.gitBlobSha256,
  };
  if (!binding.repositoryNodeId || !binding.canonicalUrl || !binding.ref || !binding.commitSha
    || !binding.blobOid || !binding.path || !binding.blobSha256) {
    throw new HeroVoiceCanaryReviewError("CANARY_GIT_AUTHORITY_INVALID");
  }
  return binding as GitCommitmentBinding;
}

function commitmentBytes(experimentId: string, revealCiphertextSha256: string): Buffer {
  return heroVoiceCanaryJcsBytes({ version: 1, experimentId, revealCiphertextSha256 });
}

function commitmentPathFromBytes(bytes: Buffer): string {
  let parsed: unknown;
  try { parsed = parseHeroVoiceCanaryStrictJson(bytes); } catch {
    throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
  }
  if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes)
    || !exactKeys(parsed, ["experimentId", "revealCiphertextSha256", "version"])
    || parsed.version !== 1 || typeof parsed.experimentId !== "string" || !SAFE_EXPERIMENT_ID.test(parsed.experimentId)
    || typeof parsed.revealCiphertextSha256 !== "string" || !HEX64.test(parsed.revealCiphertextSha256)) {
    throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
  }
  return `${COMMITMENT_PATH_PREFIX}${parsed.experimentId}.json`;
}

function validateRevealManifest(reveal: unknown, manifest: HeroVoiceCanaryManifest): RevealManifest {
  if (!exactKeys(reveal, ["experimentId", "pairs", "slotManifestSha256", "version"])
    || reveal.version !== 1 || reveal.experimentId !== manifest.experimentId
    || typeof reveal.slotManifestSha256 !== "string" || !HEX64.test(reveal.slotManifestSha256)
    || !Array.isArray(reveal.pairs) || reveal.pairs.length !== 18) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
  }
  const expectedFinal = manifest.slots.filter((slot) => slot.phase !== "ablation");
  const seenSlots = new Set<string>();
  const seenPairs = new Set<string>();
  const seenComparisons = new Set<string>();
  for (const value of reveal.pairs) {
    if (!exactKeys(value, ["A", "B", "comparisonKey", "pairId", "repeatId", "scriptId", "settingsSha256", "speechTextSha256"])
      || typeof value.pairId !== "string" || !TOKEN.test(value.pairId)
      || typeof value.comparisonKey !== "string" || typeof value.scriptId !== "string" || typeof value.repeatId !== "string"
      || typeof value.speechTextSha256 !== "string" || !HEX64.test(value.speechTextSha256)
      || value.settingsSha256 !== manifest.matchedSettingsSha256
      || !exactKeys(value.A, ["arm", "audioSha256", "slotId"])
      || !exactKeys(value.B, ["arm", "audioSha256", "slotId"])) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
    }
    const pair = value as unknown as RevealPair;
    if (seenPairs.has(pair.pairId) || seenComparisons.has(pair.comparisonKey)) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
    }
    seenPairs.add(pair.pairId); seenComparisons.add(pair.comparisonKey);
    const sides = [pair.A, pair.B];
    if (new Set(sides.map((side) => side.arm)).size !== 2
      || !sides.every((side) => (side.arm === "baseline-v13" || side.arm === "combined-quality-v1")
        && HEX64.test(side.audioSha256) && !seenSlots.has(side.slotId))) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
    }
    for (const side of sides) seenSlots.add(side.slotId);
    const baseline = manifest.slots.find((slot) => slot.slotId === sides.find((side) => side.arm === "baseline-v13")?.slotId);
    const candidate = manifest.slots.find((slot) => slot.slotId === sides.find((side) => side.arm === "combined-quality-v1")?.slotId);
    if (!baseline || !candidate || baseline.phase !== "baseline" || candidate.phase !== "candidate"
      || baseline.comparisonKey !== pair.comparisonKey || candidate.comparisonKey !== pair.comparisonKey
      || baseline.scriptId !== pair.scriptId || candidate.scriptId !== pair.scriptId
      || baseline.repeatId !== pair.repeatId || candidate.repeatId !== pair.repeatId
      || baseline.speechTextSha256 !== pair.speechTextSha256 || candidate.speechTextSha256 !== pair.speechTextSha256
      || baseline.matchedSettingsSha256 !== pair.settingsSha256 || candidate.matchedSettingsSha256 !== pair.settingsSha256) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
    }
  }
  if (seenSlots.size !== 36 || expectedFinal.some((slot) => !seenSlots.has(slot.slotId))) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
  }
  return reveal as RevealManifest;
}

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/** Strict review ingress parser. Review never trusts a filename, prefix, or
 * provider declaration as proof that bytes are the matched PCM contract. */
export function assertHeroVoiceCanaryReviewWav(bytes: Buffer): void {
  if (bytes.length < 44 || bytes.length > 7_000_000
    || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
    || bytes.subarray(8, 12).toString("ascii") !== "WAVE"
    || bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
  }
  let offset = 12;
  let sawFmt = false;
  let sawData = false;
  const chunkIds = new Set<string>();
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
    const chunkId = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[ -~]{4}$/u.test(chunkId) || chunkIds.has(chunkId)) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
    }
    chunkIds.add(chunkId);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const contentStart = offset + 8;
    const contentEnd = contentStart + chunkSize;
    const paddedEnd = contentEnd + (chunkSize & 1);
    if (!Number.isSafeInteger(contentEnd) || contentEnd > bytes.length || paddedEnd > bytes.length) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
    }
    if (chunkId === "fmt ") {
      if (sawFmt || chunkSize !== 16
        || bytes.readUInt16LE(contentStart) !== 1
        || bytes.readUInt16LE(contentStart + 2) !== 1
        || bytes.readUInt32LE(contentStart + 4) !== 24_000
        || bytes.readUInt32LE(contentStart + 8) !== 48_000
        || bytes.readUInt16LE(contentStart + 12) !== 2
        || bytes.readUInt16LE(contentStart + 14) !== 16) {
        throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
      }
      sawFmt = true;
    } else if (chunkId === "data") {
      if (sawData || !sawFmt || chunkSize === 0 || chunkSize % 2 !== 0) {
        throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
      }
      sawData = true;
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !sawFmt || !sawData) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
  }
}

function parseReviewPreparation(input: {
  run: {
    id: string;
    experimentId: string | null;
    slotManifestSha256: string | null;
    reviewPreparationJson: string | null;
  };
  manifest: HeroVoiceCanaryManifest;
}): {
  preparation: ReviewPreparationV1;
  publicReview: PublicReview;
  privateReview: PrivateReview;
  revealCiphertextBytes: Buffer;
  reveal: RevealManifest;
} {
  const parsed = parseJcs<unknown>(input.run.reviewPreparationJson);
  if (!exactKeys(parsed, [
    "gitBlobSha256", "gitCommitmentPath", "gitRef", "outputAudioSha256", "privateReview",
    "publicReview", "revealCiphertext", "revealCiphertextSha256", "slotManifestSha256", "version",
  ]) || parsed.version !== 1 || parsed.slotManifestSha256 !== input.run.slotManifestSha256
    || typeof parsed.revealCiphertextSha256 !== "string" || !HEX64.test(parsed.revealCiphertextSha256)
    || parsed.gitRef !== HERO_VOICE_CANARY_GIT_REF
    || parsed.gitCommitmentPath !== `${COMMITMENT_PATH_PREFIX}${input.run.experimentId}.json`
    || typeof parsed.gitBlobSha256 !== "string" || !HEX64.test(parsed.gitBlobSha256)
    || !Array.isArray(parsed.outputAudioSha256) || parsed.outputAudioSha256.length !== 36) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  const outputAudioSha256 = parsed.outputAudioSha256.map((value) => {
    if (!exactKeys(value, ["sha256", "slotId"]) || typeof value.slotId !== "string"
      || typeof value.sha256 !== "string" || !HEX64.test(value.sha256)) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
    }
    return Object.freeze({ slotId: value.slotId, sha256: value.sha256 });
  });
  if (new Set(outputAudioSha256.map((value) => value.slotId)).size !== 36) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  const publicReview = parsePublic(heroVoiceCanaryJcsBytes(parsed.publicReview).toString("utf8"));
  const privateReview = parsePrivate(heroVoiceCanaryJcsBytes(parsed.privateReview).toString("utf8"));
  if (privateReview.scores.length !== 0
    || privateReview.audioFiles.some((file) => file.storageKey !== `${input.run.id}/${file.token}.wav`)) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  const revealCiphertextBytes = heroVoiceCanaryJcsBytes(parsed.revealCiphertext);
  if (heroVoiceCanarySha256(revealCiphertextBytes) !== parsed.revealCiphertextSha256) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  const aad = {
    version: 1,
    experimentId: input.run.experimentId,
    runId: input.run.id,
    slotManifestSha256: input.run.slotManifestSha256,
  };
  let reveal: RevealManifest;
  try {
    reveal = validateRevealManifest(decryptHeroVoiceCanaryReveal({
      key: deriveHeroVoiceCanaryRunKey(reviewIkm(), "reveal", input.run.id),
      envelopeBytes: revealCiphertextBytes,
      aad,
    }).plaintext, input.manifest);
  } catch {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  const outputBySlot = new Map(outputAudioSha256.map((value) => [value.slotId, value.sha256]));
  const privateByToken = new Map(privateReview.audioFiles.map((file) => [file.token, file]));
  const revealByPair = new Map(reveal.pairs.map((pair) => [pair.pairId, pair]));
  const finalSlots = input.manifest.slots.filter((slot) => slot.phase !== "ablation");
  if (finalSlots.some((slot) => outputBySlot.get(slot.slotId) === undefined)
    || publicReview.pairs.some((pair) => {
      const revealPair = revealByPair.get(pair.pairId);
      if (!revealPair) return true;
      return (["A", "B"] as const).some((side) => {
        const file = privateByToken.get(pair.audio[side]);
        return !file || file.sha256 !== revealPair[side].audioSha256
          || file.sha256 !== outputBySlot.get(revealPair[side].slotId);
      });
    })) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  const commitBytes = commitmentBytes(input.run.experimentId!, parsed.revealCiphertextSha256);
  if (heroVoiceCanarySha256(commitBytes) !== parsed.gitBlobSha256) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_PREPARATION_INVALID");
  }
  return {
    preparation: parsed as unknown as ReviewPreparationV1,
    publicReview,
    privateReview,
    revealCiphertextBytes,
    reveal,
  };
}

export async function createHeroVoiceCanaryBlindReview(input: {
  runId: string;
  ownerHmac: string;
  outputs: readonly { slotId: string; wavBytes: Buffer }[];
  authority: GitCommitmentAuthority;
  gitRef?: string;
}): Promise<{ revision: number; revealCiphertextSha256: string }> {
  return runHeroVoiceCanarySerializedMutation(async () => {
    const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
    if (!run) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_NOT_FOUND", 404);
    if (run.runState !== "reviewable" || !["collecting", "preparing"].includes(run.state) || run.revision !== 1
      || !run.experimentId || !run.slotManifestSha256) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_STATE_INVALID");
    const requestedRef = input.gitRef ?? HERO_VOICE_CANARY_GIT_REF;
    if (requestedRef !== HERO_VOICE_CANARY_GIT_REF) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_AUTHORITY_INVALID");
    }
    const manifest = parseRunManifest(run);
    if (input.outputs.length !== 36 || new Set(input.outputs.map((output) => output.slotId)).size !== 36) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
    }
    const records = await verifyHeroVoiceCanaryLedger({ runId: run.id, ownerHmac: run.ownerHmac });
    const audioHashes = new Map<string, string>();
    for (const { record } of records) {
      if (record.type === "accepted_outcome" && record.outcome === "valid_completed" && record.audioSha256) {
        audioHashes.set(record.slotId, record.audioSha256);
      }
    }
    const outputBySlot = new Map(input.outputs.map((output) => [output.slotId, output.wavBytes]));
    const finalSlots = manifest.slots.filter((slot) => slot.phase !== "ablation");
    if (finalSlots.some((slot) => {
      const bytes = outputBySlot.get(slot.slotId);
      if (!bytes) return true;
      try { assertHeroVoiceCanaryReviewWav(bytes); } catch { return true; }
      return heroVoiceCanarySha256(bytes) !== audioHashes.get(slot.slotId);
    })) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");

    let preparationJson = run.reviewPreparationJson;
    if (run.state === "collecting") {
      const tokensBySlot = new Map(finalSlots.map((slot) => [slot.slotId, randomBytes(16).toString("base64url")]));
      if (new Set(tokensBySlot.values()).size !== 36) throw new HeroVoiceCanaryReviewError("CANARY_RANDOMNESS_INVALID");
      const comparisons = shuffled([...new Set(finalSlots.map((slot) => slot.comparisonKey!))]);
      const revealPairs: RevealPair[] = [];
      const publicPairs: PublicPair[] = [];
      for (const comparisonKey of comparisons) {
        const baseline = finalSlots.find((slot) => slot.comparisonKey === comparisonKey && slot.phase === "baseline")!;
        const candidate = finalSlots.find((slot) => slot.comparisonKey === comparisonKey && slot.phase === "candidate")!;
        const pairId = randomBytes(16).toString("base64url");
        const baselineFirst = randomInt(2) === 0;
        const side = (slot: typeof baseline, arm: RevealSide["arm"]): RevealSide => Object.freeze({
          arm, slotId: slot.slotId, audioSha256: audioHashes.get(slot.slotId)!,
        });
        const A = baselineFirst ? side(baseline, "baseline-v13") : side(candidate, "combined-quality-v1");
        const B = baselineFirst ? side(candidate, "combined-quality-v1") : side(baseline, "baseline-v13");
        revealPairs.push(Object.freeze({
          pairId, comparisonKey, scriptId: baseline.scriptId, repeatId: baseline.repeatId!,
          speechTextSha256: baseline.speechTextSha256, settingsSha256: baseline.matchedSettingsSha256, A, B,
        }));
        publicPairs.push(Object.freeze({
          pairId,
          audio: Object.freeze({ A: tokensBySlot.get(A.slotId)!, B: tokensBySlot.get(B.slotId)! }),
        }));
      }
      const reveal: RevealManifest = Object.freeze({
        version: 1, experimentId: run.experimentId, slotManifestSha256: run.slotManifestSha256,
        pairs: Object.freeze(revealPairs),
      });
      validateRevealManifest(reveal, manifest);
      const aad = { version: 1, experimentId: run.experimentId, runId: run.id, slotManifestSha256: run.slotManifestSha256 };
      const encrypted = encryptHeroVoiceCanaryReveal({
        key: deriveHeroVoiceCanaryRunKey(reviewIkm(), "reveal", run.id), plaintext: reveal, aad,
      });
      const revealCiphertextSha256 = heroVoiceCanarySha256(encrypted.envelopeBytes);
      const publicReview: PublicReview = Object.freeze({ version: 1, pairs: Object.freeze(publicPairs) });
      const privateReview: PrivateReview = Object.freeze({
        version: 1,
        audioFiles: Object.freeze(finalSlots.map((slot) => {
          const token = tokensBySlot.get(slot.slotId)!;
          return Object.freeze({ token, storageKey: `${run.id}/${token}.wav`, sha256: audioHashes.get(slot.slotId)! });
        })),
        scores: Object.freeze([]),
      });
      const commitBytes = commitmentBytes(run.experimentId, revealCiphertextSha256);
      const preparation: ReviewPreparationV1 = Object.freeze({
        version: 1,
        slotManifestSha256: run.slotManifestSha256,
        outputAudioSha256: Object.freeze(finalSlots.map((slot) => Object.freeze({
          slotId: slot.slotId, sha256: audioHashes.get(slot.slotId)!,
        }))),
        publicReview,
        privateReview,
        revealCiphertext: encrypted.envelope,
        revealCiphertextSha256,
        gitRef: requestedRef,
        gitCommitmentPath: `${COMMITMENT_PATH_PREFIX}${run.experimentId}.json`,
        gitBlobSha256: heroVoiceCanarySha256(commitBytes),
      });
      preparationJson = heroVoiceCanaryJcsBytes(preparation).toString("utf8");
      const prepared = await prisma.reviewRun.updateMany({
        where: { id: run.id, ownerHmac: run.ownerHmac, state: "collecting", revision: 1, reviewPreparationJson: null },
        data: { state: "preparing", reviewPreparationJson: preparationJson },
      });
      if (prepared.count !== 1) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_CAS_FAILED");
      observeHeroVoiceCanaryCrashForTests("after-review-preparation-commit", run.id);
    }
    const recovered = parseReviewPreparation({
      run: { ...run, reviewPreparationJson: preparationJson },
      manifest,
    });
    const preparedAudioHashes = new Map(recovered.preparation.outputAudioSha256.map((value) => [value.slotId, value.sha256]));
    if (finalSlots.some((slot) => preparedAudioHashes.get(slot.slotId) !== audioHashes.get(slot.slotId))) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_OUTPUTS_INVALID");
    }
    const commitBytes = commitmentBytes(run.experimentId, recovered.preparation.revealCiphertextSha256);
    const binding = await input.authority.publishCommitment({
      path: recovered.preparation.gitCommitmentPath,
      ref: recovered.preparation.gitRef,
      bytes: commitBytes,
    });
    await input.authority.verifyCommitment(binding, commitBytes);
    if (binding.path !== recovered.preparation.gitCommitmentPath || binding.ref !== recovered.preparation.gitRef
      || binding.blobSha256 !== heroVoiceCanarySha256(commitBytes)) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_AUTHORITY_INVALID");
    }
    observeHeroVoiceCanaryCrashForTests("after-review-remote-push-before-local-commit", run.id);

    const privateAudio = recovered.privateReview.audioFiles;
    const envelopeStorageKey = `${run.id}/reveal.json`;
    const artifacts: { storageKey: string; sha256: string }[] = [
      ...privateAudio.map(({ storageKey, sha256 }) => ({ storageKey, sha256 })),
      { storageKey: envelopeStorageKey, sha256: recovered.preparation.revealCiphertextSha256 },
    ];
    const creationArtifacts = [
      ...artifacts,
      ...artifacts.map((artifact) => ({
        storageKey: `${run.id}/staging/${artifact.storageKey.slice(run.id.length + 1)}`,
        sha256: artifact.sha256,
      })),
    ];
    const artifactTransactionId = await beginHeroVoiceCanaryReviewArtifactIntent({
      runId: run.id, ownerHmac: run.ownerHmac, artifacts: creationArtifacts,
    });
    const storage = heroVoiceCanaryStorageContext();
    try {
    const publicByPair = new Map(recovered.publicReview.pairs.map((pair) => [pair.pairId, pair]));
    const tokenBySlot = new Map<string, string>();
    for (const revealPair of recovered.reveal.pairs) {
      const publicPair = publicByPair.get(revealPair.pairId)!;
      tokenBySlot.set(revealPair.A.slotId, publicPair.audio.A);
      tokenBySlot.set(revealPair.B.slotId, publicPair.audio.B);
    }
    for (const slot of finalSlots) {
      const token = tokenBySlot.get(slot.slotId)!;
      const storageKey = `${run.id}/${token}.wav`;
      const destination = artifactSourcePath(storage, "review_private", storageKey);
      const staging = artifactSourcePath(storage, "review_private", `${run.id}/staging/${token}.wav`);
      durableWritePrivateFile(staging, destination, outputBySlot.get(slot.slotId)!);
    }
    const envelopePath = artifactSourcePath(storage, "review_private", envelopeStorageKey);
    const envelopeStaging = artifactSourcePath(storage, "review_private", `${run.id}/staging/reveal.json`);
    durableWritePrivateFile(envelopeStaging, envelopePath, recovered.revealCiphertextBytes);
      await prisma.$transaction(async (tx) => {
        const changed = await tx.reviewRun.updateMany({
          where: {
            id: run.id, ownerHmac: run.ownerHmac, state: "preparing", revision: 1,
            reviewPreparationJson: preparationJson,
          },
          data: {
            state: "reviewing", revision: 2,
            reviewPreparationJson: null,
            publicReviewJson: heroVoiceCanaryJcsBytes(recovered.publicReview).toString("utf8"),
            privateArtifactManifestJson: serializeHeroVoiceCanaryReviewArtifactManifest(artifacts),
            rawScoresJson: heroVoiceCanaryJcsBytes(recovered.privateReview).toString("utf8"),
            revealCiphertextJson: recovered.revealCiphertextBytes.toString("utf8"),
            revealCiphertextSha256: recovered.preparation.revealCiphertextSha256,
            gitRepositoryNodeId: binding.repositoryNodeId,
            gitCanonicalUrl: binding.canonicalUrl,
            gitRef: binding.ref,
            gitCommitSha: binding.commitSha,
            gitBlobOid: binding.blobOid,
            gitCommitmentPath: binding.path,
            gitBlobSha256: binding.blobSha256,
          },
        });
        if (changed.count !== 1) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_CAS_FAILED");
        observeHeroVoiceCanaryCrashForTests("after-review-cas-before-intent-commit", run.id);
        await commitHeroVoiceCanaryReviewArtifactIntentInTransaction(tx, artifactTransactionId);
      });
      await finishHeroVoiceCanaryReviewArtifactIntent(artifactTransactionId);
    } catch (error) {
      await rollBackHeroVoiceCanaryReviewArtifactIntent(artifactTransactionId);
      throw error;
    }
    return { revision: 2, revealCiphertextSha256: recovered.preparation.revealCiphertextSha256 };
  });
}

export async function getHeroVoiceCanaryReview(input: {
  runId: string;
  ownerHmac: string;
  authority?: GitCommitmentAuthority;
}) {
  const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
  if (!run || !["reviewing", "locked", "revealed"].includes(run.state)) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_NOT_FOUND", 404);
  }
  const publicReview = parsePublic(run.publicReviewJson);
  const scores = parsePrivate(run.rawScoresJson).scores;
  const scoreByPair = new Map(scores.map((score) => [score.pairId, score]));
  let revealByPair: Map<string, RevealPair> | null = null;
  if (run.state === "revealed") {
    if (!input.authority) throw new HeroVoiceCanaryReviewError("CANARY_GIT_AUTHORITY_INVALID", 503);
    const verified = await verifyAndDecryptRun({ run, authority: input.authority });
    revealByPair = new Map(verified.reveal.pairs.map((pair) => [pair.pairId, pair]));
    if (publicReview.pairs.some((pair) => !revealByPair?.has(pair.pairId))) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
    }
  }
  return Object.freeze({
    version: 1,
    state: run.state,
    revision: run.revision,
    complete: scores.length,
    pairs: Object.freeze(publicReview.pairs.map((pair) => Object.freeze({
      pairId: pair.pairId,
      audio: pair.audio,
      score: scoreByPair.get(pair.pairId) ?? null,
      ...(revealByPair ? {
        labels: Object.freeze({
          A: revealByPair.get(pair.pairId)!.A.arm === "combined-quality-v1" ? "Candidate" : "Baseline",
          B: revealByPair.get(pair.pairId)!.B.arm === "combined-quality-v1" ? "Candidate" : "Baseline",
        }),
      } : {}),
    }))),
    ...(run.state === "revealed" ? { aggregates: parseJcs(run.sanitizedAggregatesJson) } : {}),
  });
}

export async function readHeroVoiceCanaryReviewAudio(input: {
  runId: string; ownerHmac: string; token: string;
}): Promise<Buffer> {
  if (!TOKEN.test(input.token)) throw new HeroVoiceCanaryReviewError("CANARY_AUDIO_NOT_FOUND", 404);
  const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
  if (!run || !["reviewing", "locked", "revealed"].includes(run.state)) {
    throw new HeroVoiceCanaryReviewError("CANARY_AUDIO_NOT_FOUND", 404);
  }
  const file = parsePrivate(run.rawScoresJson).audioFiles.find((candidate) => candidate.token === input.token);
  if (!file) throw new HeroVoiceCanaryReviewError("CANARY_AUDIO_NOT_FOUND", 404);
  const bytes = readPrivateFileNoFollow(artifactSourcePath(heroVoiceCanaryStorageContext(), "review_private", file.storageKey));
  if (heroVoiceCanarySha256(bytes) !== file.sha256) throw new HeroVoiceCanaryReviewError("CANARY_AUDIO_INVALID", 503);
  return bytes;
}

export async function putHeroVoiceCanaryScore(input: {
  runId: string; ownerHmac: string; pairId: string; expectedRevision: number; score: HeroVoiceCanaryScore;
}): Promise<{ revision: number; complete: number }> {
  return runHeroVoiceCanarySerializedMutation(async () => prisma.$transaction(async (tx) => {
    const run = await tx.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
    if (!run) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_NOT_FOUND", 404);
    if (run.state !== "reviewing" || run.revision !== input.expectedRevision) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_REVISION_CONFLICT");
    }
    const publicReview = parsePublic(run.publicReviewJson);
    if (!publicReview.pairs.some((pair) => pair.pairId === input.pairId) || input.score.pairId !== input.pairId) {
      throw new HeroVoiceCanaryReviewError("CANARY_PAIR_NOT_FOUND", 404);
    }
    const privateReview = parsePrivate(run.rawScoresJson);
    const scores = [...privateReview.scores.filter((score) => score.pairId !== input.pairId), input.score]
      .sort((left, right) => left.pairId.localeCompare(right.pairId));
    const revision = run.revision + 1;
    const changed = await tx.reviewRun.updateMany({
      where: { id: run.id, ownerHmac: run.ownerHmac, state: "reviewing", revision: run.revision },
      data: {
        revision,
        rawScoresJson: heroVoiceCanaryJcsBytes({ version: 1, audioFiles: privateReview.audioFiles, scores }).toString("utf8"),
      },
    });
    if (changed.count !== 1) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_REVISION_CONFLICT");
    return { revision, complete: scores.length };
  }));
}

async function verifyAndDecryptRun(input: {
  run: NonNullable<Awaited<ReturnType<typeof prisma.reviewRun.findFirst>>>;
  authority: GitCommitmentAuthority;
}): Promise<{ reveal: RevealManifest; manifest: HeroVoiceCanaryManifest; envelopeBytes: Buffer }> {
  const { run } = input;
  if (!run.experimentId || !run.slotManifestSha256 || !run.revealCiphertextJson || !run.revealCiphertextSha256) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
  }
  const envelopeBytes = Buffer.from(run.revealCiphertextJson, "utf8");
  if (heroVoiceCanarySha256(envelopeBytes) !== run.revealCiphertextSha256) {
    throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
  }
  const expectedCommitment = commitmentBytes(run.experimentId, run.revealCiphertextSha256);
  await input.authority.verifyCommitment(bindingFromRun(run), expectedCommitment);
  const aad = { version: 1, experimentId: run.experimentId, runId: run.id, slotManifestSha256: run.slotManifestSha256 };
  const decrypted = decryptHeroVoiceCanaryReveal({
    key: deriveHeroVoiceCanaryRunKey(reviewIkm(), "reveal", run.id), envelopeBytes, aad,
  });
  const manifest = parseRunManifest(run);
  return { reveal: validateRevealManifest(decrypted.plaintext, manifest), manifest, envelopeBytes };
}

export async function lockHeroVoiceCanaryReview(input: {
  runId: string; ownerHmac: string; expectedRevision: number; authority: GitCommitmentAuthority;
}): Promise<{ revision: number }> {
  return runHeroVoiceCanarySerializedMutation(async () => {
    const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
    if (!run) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_NOT_FOUND", 404);
    if (run.state !== "reviewing" || run.revision !== input.expectedRevision || !run.experimentId
      || !run.slotManifestSha256 || !run.revealCiphertextSha256) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_REVISION_CONFLICT");
    }
    const privateReview = parsePrivate(run.rawScoresJson);
    const publicReview = parsePublic(run.publicReviewJson);
    if (privateReview.scores.length !== 18
      || publicReview.pairs.some((pair) => !privateReview.scores.some((score) => score.pairId === pair.pairId))) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_INCOMPLETE");
    }
    await verifyAndDecryptRun({ run, authority: input.authority });
    const scoreSheetHmac = heroVoiceCanaryHmacHex(
      deriveHeroVoiceCanaryRunKey(reviewIkm(), "score", run.id),
      {
        version: 1,
        experimentId: run.experimentId,
        slotManifestSha256: run.slotManifestSha256,
        revealCiphertextSha256: run.revealCiphertextSha256,
        scores: privateReview.scores,
      },
    );
    const revision = run.revision + 1;
    const changed = await prisma.reviewRun.updateMany({
      where: { id: run.id, ownerHmac: run.ownerHmac, state: "reviewing", revision: run.revision },
      data: { state: "locked", revision, scoreSheetHmac },
    });
    if (changed.count !== 1) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_REVISION_CONFLICT");
    return { revision };
  });
}

export async function revealHeroVoiceCanaryReview(input: {
  runId: string; ownerHmac: string; expectedRevision: number; authority: GitCommitmentAuthority;
}): Promise<{
  revision: number;
  aggregates: unknown;
  decision: "completed_no_go" | "review_passed_pending_mew_approval";
  armsByPair: readonly Readonly<{ pairId: string; A: RevealSide["arm"]; B: RevealSide["arm"] }>[];
}> {
  return runHeroVoiceCanarySerializedMutation(async () => {
    const run = await prisma.reviewRun.findFirst({ where: { id: input.runId, ownerHmac: input.ownerHmac } });
    if (!run) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_NOT_FOUND", 404);
    if (run.state !== "locked" || run.revision !== input.expectedRevision || !run.experimentId
      || !run.slotManifestSha256 || !run.revealCiphertextSha256 || !run.scoreSheetHmac) {
      throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_REVISION_CONFLICT");
    }
    const privateReview = parsePrivate(run.rawScoresJson);
    const expectedHmac = heroVoiceCanaryHmacHex(
      deriveHeroVoiceCanaryRunKey(reviewIkm(), "score", run.id),
      {
        version: 1, experimentId: run.experimentId, slotManifestSha256: run.slotManifestSha256,
        revealCiphertextSha256: run.revealCiphertextSha256, scores: privateReview.scores,
      },
    );
    if (!heroVoiceCanaryHexMatches(expectedHmac, run.scoreSheetHmac)) {
      throw new HeroVoiceCanaryReviewError("CANARY_SCORE_HMAC_INVALID");
    }
    const { reveal } = await verifyAndDecryptRun({ run, authority: input.authority });
    const pairById = new Map(reveal.pairs.map((pair) => [pair.pairId, pair]));
    let candidateWins = 0;
    let candidateLosses = 0;
    let ties = 0;
    let candidateCriticalFlagCount = 0;
    for (const score of privateReview.scores) {
      const pair = pairById.get(score.pairId);
      if (!pair) throw new HeroVoiceCanaryReviewError("CANARY_REVEAL_INVALID");
      const candidateSide = pair.A.arm === "combined-quality-v1" ? "A" : "B";
      if (score.choice === "tie") ties += 1;
      else if (score.choice === candidateSide) candidateWins += 1;
      else candidateLosses += 1;
      candidateCriticalFlagCount += score.flagsBySide[candidateSide].length;
    }
    const ledger = await verifyHeroVoiceCanaryLedger({ runId: run.id, ownerHmac: run.ownerHmac });
    const finalSlotIds = new Set(reveal.pairs.flatMap((pair) => [pair.A.slotId, pair.B.slotId]));
    const validFinalSlots = new Set(ledger.flatMap(({ record }) => (
      record.type === "accepted_outcome" && record.outcome === "valid_completed" && finalSlotIds.has(record.slotId)
        ? [record.slotId] : []
    )));
    const candidateCerPasses = ledger.filter(({ record }) => {
      if (record.type !== "cer_result") return false;
      const slot = reveal.pairs.flatMap((pair) => [pair.A, pair.B])
        .find((side) => side.slotId === record.slotId);
      return slot?.arm === "combined-quality-v1" && record.cerNumerator / record.cerDenominator <= 0.10;
    }).length;
    const postReviewPass = candidateWins + ties >= 15 && candidateCerPasses >= 17
      && validFinalSlots.size === 36 && candidateCriticalFlagCount === 0;
    const decision = postReviewPass ? "review_passed_pending_mew_approval" : "completed_no_go";
    const aggregates = {
      version: 1, completePairs: 18, candidateWins, candidateLosses, ties,
      candidateCriticalFlagCount, candidateCerPasses,
      acceptablePairs: candidateWins + ties,
      candidateImprovementWins: candidateWins,
      allFinalOutputsValid: validFinalSlots.size === 36,
      postReviewPass,
      mewPhraseApproved: false,
    } as const;
    const sanitizedAggregatesJson = serializeHeroVoiceCanarySanitizedReviewAggregates(aggregates);
    const revision = run.revision + 1;
    await prisma.$transaction(async (tx) => {
      const changed = await tx.reviewRun.updateMany({
        where: {
          id: run.id, ownerHmac: run.ownerHmac, state: "locked", revision: run.revision,
          scoreSheetHmac: run.scoreSheetHmac, runState: "reviewable",
        },
        data: { state: "revealed", revision, sanitizedAggregatesJson, runState: decision },
      });
      if (changed.count !== 1) throw new HeroVoiceCanaryReviewError("CANARY_REVIEW_REVISION_CONFLICT");
      await appendHeroVoiceCanaryLedgerRecordInTransaction(tx, {
        runId: run.id,
        ownerHmac: run.ownerHmac,
        record: {
          type: "run_transition", from: "reviewable", to: decision,
          reason: postReviewPass ? "post_review_gate_passed_pending_mew_phrase" : "post_review_gate_failed",
        },
      });
    });
    return {
      revision,
      aggregates: parseJcs(sanitizedAggregatesJson),
      decision,
      armsByPair: Object.freeze(reveal.pairs.map((pair) => Object.freeze({
        pairId: pair.pairId, A: pair.A.arm, B: pair.B.arm,
      }))),
    };
  });
}

export async function closeHeroVoiceCanaryReview(input: {
  runId: string; ownerHmac: string; expectedRevision: number;
}) {
  return closeHeroVoiceCanaryReviewRun(input);
}

function execGit(gitDir: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--git-dir", gitDir, ...args], {
      encoding: "buffer",
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Hero Voice Canary",
        GIT_AUTHOR_EMAIL: "hero-voice-canary@test.invalid",
        GIT_COMMITTER_NAME: "Hero Voice Canary",
        GIT_COMMITTER_EMAIL: "hero-voice-canary@test.invalid",
      },
    }, (error, stdout) => {
      if (error) reject(error); else resolve(Buffer.from(stdout));
    });
  });
}

function execGitWithInput(gitDir: string, args: readonly string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--git-dir", gitDir, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Hero Voice Canary",
        GIT_AUTHOR_EMAIL: "hero-voice-canary@test.invalid",
        GIT_COMMITTER_NAME: "Hero Voice Canary",
        GIT_COMMITTER_EMAIL: "hero-voice-canary@test.invalid",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(`local_git_failed:${code}:${Buffer.concat(stderr).length}`)));
    child.stdin.end(input);
  });
}

/** Offline Task 5 authority fake. It writes only a local bare repository; the
 * GitHub API/push/readback authority remains an explicit Task 6/7 gate. */
export class LocalBareGitCommitmentAuthority implements GitCommitmentAuthority {
  constructor(private readonly bareRepositoryPath: string) {}

  private identity(): Pick<GitCommitmentBinding, "repositoryNodeId" | "canonicalUrl"> {
    const repositoryDigest = heroVoiceCanarySha256(this.bareRepositoryPath);
    return {
      repositoryNodeId: `local-bare-${repositoryDigest.slice(0, 24)}`,
      canonicalUrl: `local-bare://${repositoryDigest}`,
    };
  }

  private async bindingAt(input: {
    ref: string;
    path: string;
    commitSha: string;
    bytes: Buffer;
  }): Promise<GitCommitmentBinding> {
    const oid = (await execGit(this.bareRepositoryPath, ["rev-parse", `${input.commitSha}:${input.path}`]))
      .toString("ascii").trim();
    const objectFormat = (await execGit(this.bareRepositoryPath, ["rev-parse", "--show-object-format"]))
      .toString("ascii").trim();
    const storedBytes = await execGit(this.bareRepositoryPath, ["cat-file", "blob", oid]);
    if (!storedBytes.equals(input.bytes)) throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
    return Object.freeze({
      ...this.identity(),
      ref: input.ref,
      commitSha: input.commitSha,
      blobOid: `${objectFormat}:${oid}`,
      path: input.path,
      blobSha256: heroVoiceCanarySha256(input.bytes),
    });
  }

  private async ensureRepository(): Promise<void> {
    if (process.env.NODE_ENV === "production" || !path.isAbsolute(this.bareRepositoryPath)) {
      throw new HeroVoiceCanaryReviewError("CANARY_LOCAL_GIT_DISABLED", 503);
    }
    if (!fs.existsSync(this.bareRepositoryPath)) {
      fs.mkdirSync(path.dirname(this.bareRepositoryPath), { recursive: true, mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["init", "--bare", this.bareRepositoryPath], (error) => error ? reject(error) : resolve());
      });
    }
  }

  async publishCommitment(input: { path: string; ref: string; bytes: Buffer }): Promise<GitCommitmentBinding> {
    await this.ensureRepository();
    if (!input.path.startsWith(COMMITMENT_PATH_PREFIX) || !input.path.endsWith(".json")
      || input.ref !== "refs/heads/mewic/hero-voice-clone-prod-audit"
      || !heroVoiceCanaryJcsBytes(parseHeroVoiceCanaryStrictJson(input.bytes)).equals(input.bytes)) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_AUTHORITY_INVALID");
    }
    let parent: string | null = null;
    try {
      parent = (await execGit(this.bareRepositoryPath, ["rev-parse", "--verify", input.ref])).toString("ascii").trim();
    } catch {}
    if (parent) {
      const additions = (await execGit(this.bareRepositoryPath, [
        "log", "--format=%H", "--diff-filter=A", input.ref, "--", input.path,
      ])).toString("ascii").trim().split("\n").filter(Boolean);
      if (additions.length > 1) throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
      if (additions.length === 1) {
        return await this.bindingAt({ ...input, commitSha: additions[0] });
      }
    }
    const blob = (await execGitWithInput(this.bareRepositoryPath, ["hash-object", "-w", "--stdin"], input.bytes))
      .toString("ascii").trim();
    const indexPath = path.join(path.dirname(this.bareRepositoryPath), `${randomBytes(16).toString("hex")}.index`);
    const gitEnvironment = { ...process.env, GIT_INDEX_FILE: indexPath };
    let commitSha: string;
    try {
      await execWorkingGit(process.cwd(), parent
        ? ["--git-dir", this.bareRepositoryPath, "read-tree", parent]
        : ["--git-dir", this.bareRepositoryPath, "read-tree", "--empty"], gitEnvironment);
      await execWorkingGit(process.cwd(), [
        "--git-dir", this.bareRepositoryPath, "update-index", "--add", "--cacheinfo", `100644,${blob},${input.path}`,
      ], gitEnvironment);
      const tree = (await execWorkingGit(process.cwd(), ["--git-dir", this.bareRepositoryPath, "write-tree"], gitEnvironment))
        .toString("ascii").trim();
      const commitArguments = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "hero voice canary reveal commitment"];
      commitSha = (await execGit(this.bareRepositoryPath, commitArguments)).toString("ascii").trim();
      await execGit(this.bareRepositoryPath, ["update-ref", input.ref, commitSha, parent ?? "0".repeat(commitSha.length)]);
    } finally {
      try { fs.unlinkSync(indexPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const binding = await this.bindingAt({ ...input, commitSha });
    await this.verifyCommitment(binding, input.bytes);
    return binding;
  }

  async verifyCommitment(binding: GitCommitmentBinding, expectedBytes: Buffer): Promise<void> {
    await this.ensureRepository();
    const { repositoryNodeId, canonicalUrl } = this.identity();
    if (binding.repositoryNodeId !== repositoryNodeId || binding.canonicalUrl !== canonicalUrl
      || binding.ref !== "refs/heads/mewic/hero-voice-clone-prod-audit"
      || binding.path !== commitmentPathFromBytes(expectedBytes)
      || !/^[0-9a-f]{40,64}$/u.test(binding.commitSha)
      || binding.blobSha256 !== heroVoiceCanarySha256(expectedBytes)) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
    }
    const oid = (await execGit(this.bareRepositoryPath, ["rev-parse", `${binding.commitSha}:${binding.path}`]))
      .toString("ascii").trim();
    const format = (await execGit(this.bareRepositoryPath, ["rev-parse", "--show-object-format"])).toString("ascii").trim();
    const bytes = await execGit(this.bareRepositoryPath, ["cat-file", "blob", oid]);
    if (binding.blobOid !== `${format}:${oid}` || !bytes.equals(expectedBytes)) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
    }
  }
}

export class DeferredGitHubCommitmentAuthority implements GitCommitmentAuthority {
  async publishCommitment(): Promise<GitCommitmentBinding> {
    throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_AUTHORITY_TASK6_REQUIRED", 503);
  }
  async verifyCommitment(): Promise<void> {
    throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_AUTHORITY_TASK6_REQUIRED", 503);
  }
}

function execWorkingGit(directory: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: directory,
      encoding: "buffer",
      maxBuffer: 2_000_000,
      env: environment,
    }, (error, stdout) => error ? reject(error) : resolve(Buffer.from(stdout)));
  });
}

/** Network-capable Task 6/7 transport. Merely constructing it performs no I/O.
 * Invocation requires an external 0700 askpass executable, a GitHub token for
 * repository-node identity readback, and the exact canonical repository. */
export class ShellGitHubCommitmentRemote implements GitHubCommitmentRemote {
  private environment(): NodeJS.ProcessEnv {
    const askpass = process.env.HERO_VOICE_CANARY_GIT_ASKPASS_PATH;
    const token = process.env.GITHUB_TOKEN;
    if (!askpass || !path.isAbsolute(askpass) || !token) {
      throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_CREDENTIALS_REQUIRED", 503);
    }
    const metadata = fs.lstatSync(askpass);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_CREDENTIALS_REQUIRED", 503);
    }
    return {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.useHttpPath",
      GIT_CONFIG_VALUE_0: "true",
      GIT_AUTHOR_NAME: "Hero Voice Canary",
      GIT_AUTHOR_EMAIL: "hero-voice-canary@test.invalid",
      GIT_COMMITTER_NAME: "Hero Voice Canary",
      GIT_COMMITTER_EMAIL: "hero-voice-canary@test.invalid",
    };
  }

  async repositoryIdentity(): Promise<{ repositoryNodeId: string; canonicalUrl: string }> {
    const expectedNodeId = process.env[HERO_VOICE_CANARY_GITHUB_REPOSITORY_NODE_ID_ENV];
    const token = process.env.GITHUB_TOKEN;
    if (!expectedNodeId || !token) throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_CREDENTIALS_REQUIRED", 503);
    const response = await fetch("https://api.github.com/repos/Aoacademy2025/AI_content_Mew_social", {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
    });
    const body = await response.json() as unknown;
    if (!response.ok || !exactKeys(body, [
      "archive_url", "assignees_url", "blobs_url", "branches_url", "collaborators_url", "comments_url",
      "commits_url", "compare_url", "contents_url", "contributors_url", "deployments_url", "downloads_url",
      "events_url", "forks_url", "full_name", "git_commits_url", "git_refs_url", "git_tags_url", "hooks_url",
      "html_url", "id", "issue_comment_url", "issue_events_url", "issues_url", "keys_url", "labels_url",
      "languages_url", "merges_url", "milestones_url", "name", "node_id", "notifications_url", "owner",
      "private", "pulls_url", "releases_url", "stargazers_url", "statuses_url", "subscribers_url",
      "subscription_url", "tags_url", "teams_url", "trees_url", "url",
    ])) {
      // GitHub can add response keys; consume only identity but require the
      // immutable fields below. The adapter never trusts redirect URLs.
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_IDENTITY_INVALID", 503);
      }
    }
    const record = body as Record<string, unknown>;
    if (record.node_id !== expectedNodeId || record.full_name !== "Aoacademy2025/AI_content_Mew_social"
      || record.html_url !== HERO_VOICE_CANARY_GITHUB_CANONICAL_URL || record.private !== true) {
      throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_IDENTITY_INVALID", 503);
    }
    return { repositoryNodeId: expectedNodeId, canonicalUrl: HERO_VOICE_CANARY_GITHUB_CANONICAL_URL };
  }

  async pushCommitment(input: { path: string; ref: string; bytes: Buffer }): Promise<{
    commitSha: string;
    blobOid: string;
    created: boolean;
  }> {
    const environment = this.environment();
    const scratch = fs.mkdtempSync(path.join(heroVoiceCanaryStorageContext().canaryRoot, ".git-publish-"));
    try {
      await execWorkingGit(scratch, ["init", "--quiet"], environment);
      await execWorkingGit(scratch, ["remote", "add", "origin", HERO_VOICE_CANARY_GITHUB_REMOTE_URL], environment);
      await execWorkingGit(scratch, ["fetch", "--quiet", "origin", input.ref], environment);
      await execWorkingGit(scratch, ["checkout", "--quiet", "--detach", "FETCH_HEAD"], environment);
      const filename = path.join(scratch, ...input.path.split("/"));
      if (fs.existsSync(filename)) {
        const metadata = fs.lstatSync(filename);
        if (!metadata.isFile() || metadata.isSymbolicLink() || !fs.readFileSync(filename).equals(input.bytes)) {
          throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
        }
        const touches = (await execWorkingGit(scratch, [
          "log", "--format=%H", "--", input.path,
        ], environment)).toString("ascii").trim().split("\n").filter(Boolean);
        if (touches.length !== 1 || !/^[0-9a-f]{40,64}$/u.test(touches[0])) {
          throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
        }
        const commitSha = touches[0];
        const committedBytes = await execWorkingGit(scratch, ["show", `${commitSha}:${input.path}`], environment);
        if (!committedBytes.equals(input.bytes)) {
          throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
        }
        const blob = (await execWorkingGit(scratch, ["rev-parse", `${commitSha}:${input.path}`], environment))
          .toString("ascii").trim();
        const format = (await execWorkingGit(scratch, ["rev-parse", "--show-object-format"], environment))
          .toString("ascii").trim();
        return { commitSha, blobOid: `${format}:${blob}`, created: false };
      }
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filename, input.bytes, { flag: "wx", mode: 0o600 });
      await execWorkingGit(scratch, ["add", "--", input.path], environment);
      const tree = (await execWorkingGit(scratch, ["write-tree"], environment)).toString("ascii").trim();
      const parent = (await execWorkingGit(scratch, ["rev-parse", "FETCH_HEAD"], environment)).toString("ascii").trim();
      const commitSha = (await execWorkingGit(scratch, ["commit-tree", tree, "-p", parent, "-m", "hero voice canary reveal commitment"], environment)).toString("ascii").trim();
      const blob = (await execWorkingGit(scratch, ["rev-parse", `${commitSha}:${input.path}`], environment)).toString("ascii").trim();
      const format = (await execWorkingGit(scratch, ["rev-parse", "--show-object-format"], environment)).toString("ascii").trim();
      await execWorkingGit(scratch, ["push", "--porcelain", "origin", `${commitSha}:${input.ref}`], environment);
      return { commitSha, blobOid: `${format}:${blob}`, created: true };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  async readRemoteRefCommit(input: { ref: string }): Promise<string> {
    const output = (await execWorkingGit(heroVoiceCanaryStorageContext().canaryRoot, [
      "ls-remote", "--refs", HERO_VOICE_CANARY_GITHUB_REMOTE_URL, input.ref,
    ], this.environment())).toString("ascii").trim();
    const fields = output.split(/\s+/u);
    if (fields.length !== 2 || fields[1] !== input.ref || !/^[0-9a-f]{40,64}$/u.test(fields[0])) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
    }
    return fields[0];
  }

  async readRemoteObject(input: { path: string; commitSha: string }): Promise<{ commitSha: string; blobOid: string; bytes: Buffer }> {
    const environment = this.environment();
    const scratch = fs.mkdtempSync(path.join(heroVoiceCanaryStorageContext().canaryRoot, ".git-readback-"));
    try {
      await execWorkingGit(scratch, ["init", "--quiet"], environment);
      await execWorkingGit(scratch, ["remote", "add", "origin", HERO_VOICE_CANARY_GITHUB_REMOTE_URL], environment);
      if (!/^[0-9a-f]{40,64}$/u.test(input.commitSha)) throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
      await execWorkingGit(scratch, ["fetch", "--quiet", "origin", input.commitSha], environment);
      const fetched = (await execWorkingGit(scratch, ["rev-parse", "FETCH_HEAD"], environment)).toString("ascii").trim();
      if (fetched !== input.commitSha) throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
      const blob = (await execWorkingGit(scratch, ["rev-parse", `${input.commitSha}:${input.path}`], environment)).toString("ascii").trim();
      const format = (await execWorkingGit(scratch, ["rev-parse", "--show-object-format"], environment)).toString("ascii").trim();
      const bytes = await execWorkingGit(scratch, ["show", `${input.commitSha}:${input.path}`], environment);
      return { commitSha: input.commitSha, blobOid: `${format}:${blob}`, bytes };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Real commitment authority with an injectable remote transport for offline
 * object-mismatch tests. It binds repository node, canonical URL, exact ref,
 * path, commit, Git object id, and byte-for-byte remote readback. */
export class GitHubGitCommitmentAuthority implements GitCommitmentAuthority {
  constructor(private readonly remote: GitHubCommitmentRemote = new ShellGitHubCommitmentRemote()) {}

  async publishCommitment(input: { path: string; ref: string; bytes: Buffer }): Promise<GitCommitmentBinding> {
    if (!input.path.startsWith(COMMITMENT_PATH_PREFIX) || !input.path.endsWith(".json")
      || input.ref !== HERO_VOICE_CANARY_GIT_REF
      || !heroVoiceCanaryJcsBytes(parseHeroVoiceCanaryStrictJson(input.bytes)).equals(input.bytes)) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_AUTHORITY_INVALID");
    }
    const identity = await this.remote.repositoryIdentity();
    if (identity.canonicalUrl !== HERO_VOICE_CANARY_GITHUB_CANONICAL_URL
      || identity.repositoryNodeId !== process.env[HERO_VOICE_CANARY_GITHUB_REPOSITORY_NODE_ID_ENV]) {
      throw new HeroVoiceCanaryReviewError("CANARY_GITHUB_IDENTITY_INVALID", 503);
    }
    const pushed = await this.remote.pushCommitment(input);
    if (pushed.created && await this.remote.readRemoteRefCommit({ ref: input.ref }) !== pushed.commitSha) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
    }
    const binding = Object.freeze({
      ...identity,
      ref: input.ref,
      commitSha: pushed.commitSha,
      blobOid: pushed.blobOid,
      path: input.path,
      blobSha256: heroVoiceCanarySha256(input.bytes),
    });
    await this.verifyCommitment(binding, input.bytes);
    return binding;
  }

  async verifyCommitment(binding: GitCommitmentBinding, expectedBytes: Buffer): Promise<void> {
    const identity = await this.remote.repositoryIdentity();
    if (identity.canonicalUrl !== binding.canonicalUrl || identity.repositoryNodeId !== binding.repositoryNodeId
      || binding.canonicalUrl !== HERO_VOICE_CANARY_GITHUB_CANONICAL_URL
      || binding.repositoryNodeId !== process.env[HERO_VOICE_CANARY_GITHUB_REPOSITORY_NODE_ID_ENV]
      || binding.ref !== HERO_VOICE_CANARY_GIT_REF || binding.path !== commitmentPathFromBytes(expectedBytes)
      || !/^[0-9a-f]{40,64}$/u.test(binding.commitSha)
      || binding.blobSha256 !== heroVoiceCanarySha256(expectedBytes)) {
      throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
    }
    const remote = await this.remote.readRemoteObject(binding);
    if (remote.commitSha !== binding.commitSha || remote.blobOid !== binding.blobOid
      || !remote.bytes.equals(expectedBytes)) throw new HeroVoiceCanaryReviewError("CANARY_GIT_OBJECT_MISMATCH");
  }
}
