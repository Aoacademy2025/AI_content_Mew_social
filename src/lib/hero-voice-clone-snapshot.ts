import { createHash } from "node:crypto";

import {
  HERO_VOICE_CLONE_SOURCE_REVISION,
  type HeroVoiceCloneConfig,
} from "@/lib/hero-voice-clone-config";

export const HERO_VOICE_CLONE_SNAPSHOT_VERSION = 1 as const;
export const HERO_VOICE_CLONE_POLICY = Object.freeze({
  executionTimeout: 540_000 as const,
  ttl: 900_000 as const,
});

export type CandidateAiStudioV3Snapshot = {
  version: typeof HERO_VOICE_CLONE_SNAPSHOT_VERSION;
  runnerKind: "CandidateAiStudioV3";
  attemptId: string;
  sequence: number;
  endpointId: string;
  contractVersion: 3;
  workerKind: "clone-only";
  workerVersion: "hero-voice-clone-contract-v3-internal-eval-2";
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  experimentProfile: "combined-quality-v1";
  normalizerVersion: string;
  referenceSha256: string;
  referenceDurationSamples24000: number;
  synthesis: {
    speed: number;
    numStep: 32;
    mixedLanguage: true;
    seed: number;
    textSha256: string;
    requestCommitmentSha256: string;
    matchedSettingsSha256: string;
    outputRate: 24_000;
    outputChannels: 1;
    outputSubtype: "PCM_16";
  };
  policy: typeof HERO_VOICE_CLONE_POLICY;
};

const SNAPSHOT_KEYS = [
  "version", "runnerKind", "attemptId", "sequence", "endpointId", "contractVersion",
  "workerKind", "workerVersion", "imageDigest", "sourceRevision", "modelManifestSha256",
  "experimentProfile", "normalizerVersion", "referenceSha256", "referenceDurationSamples24000",
  "synthesis", "policy",
] as const;
const SYNTHESIS_KEYS = [
  "speed", "numStep", "mixedLanguage", "seed", "textSha256", "requestCommitmentSha256",
  "matchedSettingsSha256", "outputRate", "outputChannels", "outputSubtype",
] as const;
const POLICY_KEYS = ["executionTimeout", "ttl"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+/@:-]{0,127}$/;
const FORBIDDEN_PRIVATE_KEYS = new Set([
  "apikey", "audiobase64", "credential", "filepath", "filename", "ownerid", "rawaudio",
  "refaudio", "refaudiob64", "referenceaudio", "referencepath", "reftext", "secret",
  "transcript", "userid",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && [...expected].sort().every((key, index) => actual[index] === key);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jcsBytes(value: unknown): Buffer {
  if (value === null) return Buffer.from("null");
  if (value === true) return Buffer.from("true");
  if (value === false) return Buffer.from("false");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS cannot encode non-finite numbers");
    return Buffer.from(JSON.stringify(value));
  }
  if (typeof value === "string") return Buffer.from(JSON.stringify(value), "utf8");
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from("["),
      ...value.flatMap((item, index) => [index ? Buffer.from(",") : Buffer.alloc(0), jcsBytes(item)]),
      Buffer.from("]"),
    ]);
  }
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().flatMap((key, index) => [
      index ? Buffer.from(",") : Buffer.alloc(0),
      jcsBytes(key),
      Buffer.from(":"),
      jcsBytes(value[key]),
    ]);
    return Buffer.concat([Buffer.from("{"), ...entries, Buffer.from("}")]);
  }
  throw new Error("JCS encountered an unsupported value");
}

export function heroVoiceMatchedSettings(input: { speed: number; numStep: number }) {
  return {
    speed: input.speed,
    numStep: input.numStep,
    mixedLanguage: true,
    outputRate: 24_000,
    outputChannels: 1,
    outputSubtype: "PCM_16",
  } as const;
}

export function heroVoiceCloneRequestCommitment(input: {
  refAudioSha256: string;
  refText: string;
  text: string;
  speed: number;
  numStep: number;
  seed: number;
  experimentProfile: string;
  normalizerVersion: string;
}): string {
  return sha256(jcsBytes({
    contractVersion: 3,
    mode: "clone",
    refAudioSha256: input.refAudioSha256,
    refTextSha256: sha256(input.refText),
    textSha256: sha256(input.text),
    speed: input.speed,
    numStep: input.numStep,
    mixedLanguage: true,
    seed: input.seed,
    experimentProfile: input.experimentProfile,
    normalizerVersion: input.normalizerVersion,
  }));
}

export function createCandidateAiStudioV3Snapshot(input: {
  config: HeroVoiceCloneConfig;
  attemptId: string;
  sequence: number;
  normalizerVersion: string;
  speed: number;
  seed: number;
  text: string;
  refAudioSha256: string;
  refDurationSamples24000: number;
  refText: string;
}): CandidateAiStudioV3Snapshot {
  const settings = heroVoiceMatchedSettings({ speed: input.speed, numStep: input.config.numStep });
  return {
    version: HERO_VOICE_CLONE_SNAPSHOT_VERSION,
    runnerKind: "CandidateAiStudioV3",
    attemptId: input.attemptId,
    sequence: input.sequence,
    endpointId: input.config.endpointId,
    contractVersion: input.config.contractVersion,
    workerKind: input.config.workerKind,
    workerVersion: input.config.workerVersion,
    imageDigest: input.config.imageDigest,
    sourceRevision: input.config.sourceRevision,
    modelManifestSha256: input.config.modelManifestSha256,
    experimentProfile: input.config.experimentProfile,
    normalizerVersion: input.normalizerVersion,
    referenceSha256: input.refAudioSha256,
    referenceDurationSamples24000: input.refDurationSamples24000,
    synthesis: {
      speed: input.speed,
      numStep: input.config.numStep,
      mixedLanguage: true,
      seed: input.seed,
      textSha256: sha256(input.text),
      requestCommitmentSha256: heroVoiceCloneRequestCommitment({
        refAudioSha256: input.refAudioSha256,
        refText: input.refText,
        text: input.text,
        speed: input.speed,
        numStep: input.config.numStep,
        seed: input.seed,
        experimentProfile: input.config.experimentProfile,
        normalizerVersion: input.normalizerVersion,
      }),
      matchedSettingsSha256: sha256(jcsBytes(settings)),
      outputRate: settings.outputRate,
      outputChannels: settings.outputChannels,
      outputSubtype: settings.outputSubtype,
    },
    policy: HERO_VOICE_CLONE_POLICY,
  };
}

export function parseCandidateAiStudioV3Snapshot(value: unknown): CandidateAiStudioV3Snapshot | null {
  if (!isRecord(value) || !exactKeys(value, SNAPSHOT_KEYS)) return null;
  const synthesis = value.synthesis;
  const policy = value.policy;
  if (!isRecord(synthesis) || !exactKeys(synthesis, SYNTHESIS_KEYS)
    || !isRecord(policy) || !exactKeys(policy, POLICY_KEYS)) return null;
  if (value.version !== 1 || value.runnerKind !== "CandidateAiStudioV3"
    || typeof value.attemptId !== "string" || !SAFE_ID.test(value.attemptId)
    || typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1
    || typeof value.endpointId !== "string" || !SAFE_ID.test(value.endpointId)
    || value.contractVersion !== 3 || value.workerKind !== "clone-only"
    || value.workerVersion !== "hero-voice-clone-contract-v3-internal-eval-2"
    || typeof value.imageDigest !== "string" || !value.imageDigest.startsWith("sha256:") || !HEX64.test(value.imageDigest.slice(7))
    || value.sourceRevision !== HERO_VOICE_CLONE_SOURCE_REVISION
    || typeof value.modelManifestSha256 !== "string" || !HEX64.test(value.modelManifestSha256)
    || value.experimentProfile !== "combined-quality-v1"
    || typeof value.normalizerVersion !== "string" || !SAFE_VERSION.test(value.normalizerVersion)
    || typeof value.referenceSha256 !== "string" || !HEX64.test(value.referenceSha256)
    || !Number.isSafeInteger(value.referenceDurationSamples24000)
    || (value.referenceDurationSamples24000 as number) < 120_000
    || (value.referenceDurationSamples24000 as number) > 360_000) return null;
  if (typeof synthesis.speed !== "number" || !Number.isFinite(synthesis.speed)
    || synthesis.speed < 0.3 || synthesis.speed > 3
    || synthesis.numStep !== 32 || synthesis.mixedLanguage !== true
    || typeof synthesis.seed !== "number" || !Number.isInteger(synthesis.seed)
    || synthesis.seed < 0 || synthesis.seed > 2_147_483_647
    || typeof synthesis.textSha256 !== "string" || !HEX64.test(synthesis.textSha256)
    || typeof synthesis.requestCommitmentSha256 !== "string" || !HEX64.test(synthesis.requestCommitmentSha256)
    || typeof synthesis.matchedSettingsSha256 !== "string" || !HEX64.test(synthesis.matchedSettingsSha256)
    || synthesis.outputRate !== 24_000 || synthesis.outputChannels !== 1 || synthesis.outputSubtype !== "PCM_16"
    || policy.executionTimeout !== 540_000 || policy.ttl !== 900_000) return null;
  return value as unknown as CandidateAiStudioV3Snapshot;
}

export function snapshotContainsForbiddenReferenceData(
  snapshot: unknown,
): boolean {
  const visits = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visits);
    if (!isRecord(value)) return false;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      if (FORBIDDEN_PRIVATE_KEYS.has(normalized) || visits(child)) return true;
    }
    return false;
  };
  // Exact allowlisting and forbidden-key inspection are intentionally
  // structural. Scanning arbitrary string values made a one-character voice
  // name capable of matching ordinary identity fields and blocking a safe job.
  return visits(snapshot) || parseCandidateAiStudioV3Snapshot(snapshot) === null;
}
