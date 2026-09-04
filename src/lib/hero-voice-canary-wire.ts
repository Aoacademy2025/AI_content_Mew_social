import {
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import {
  HERO_VOICE_CANARY_MATCHED_SETTINGS,
  HERO_VOICE_CANARY_MATCHED_SETTINGS_SHA256,
  HERO_VOICE_CANARY_NORMALIZER_VERSION,
  type HeroVoiceCanaryArmFields,
  type HeroVoiceCanaryRunnerKind,
  type HeroVoiceCanarySlot,
  speechTextForHeroVoiceCanarySlot,
} from "@/lib/hero-voice-canary-manifest";

const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/u;
const OUTER_KEYS = ["input", "policy"] as const;
const POLICY_KEYS = ["executionTimeout", "ttl"] as const;
const V2_KEYS = [
  "contract_version", "mixed_language", "mode", "num_step", "ref_audio_b64", "ref_text", "speed", "text",
] as const;
const V3_KEYS = [
  "contract_version", "experiment_profile", "matched_settings_sha256", "mixed_language", "mode",
  "normalizer_version", "num_step", "ref_audio_b64", "ref_text", "request_commitment_sha256",
  "seed", "speed", "text",
] as const;

type JsonRecord = Record<string, unknown>;

export type HeroVoiceCanaryWireDescriptor = Readonly<{
  version: 1;
  runnerKind: HeroVoiceCanaryRunnerKind;
  endpointId: string;
  templateId: string;
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  expectedWorkerVersion: string;
  expectedCatalogVersion: string | null;
  contractVersion: 2 | 3;
  mode: "clone";
  referenceSha256: string;
  refTextSha256: string;
  textSha256: string;
  matchedSettings: typeof HERO_VOICE_CANARY_MATCHED_SETTINGS;
  matchedSettingsSha256: string;
  requestCommitmentSha256: string | null;
  normalizerVersion: string | null;
  arm: HeroVoiceCanaryArmFields;
  policy: Readonly<{ executionTimeout: 540_000; ttl: 900_000 }>;
}>;

export type PreparedHeroVoiceCanaryWireRequest = Readonly<{
  bytes: Buffer;
  wireRequestSha256: string;
  descriptor: HeroVoiceCanaryWireDescriptor;
  descriptorSha256: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function decodeStrictBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > 12_000_000
    || value.length % 4 !== 0 || !STANDARD_BASE64.test(value)) throw new Error("canary_wire_invalid");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) throw new Error("canary_wire_invalid");
  return decoded;
}

function armFromParsed(input: JsonRecord): HeroVoiceCanaryArmFields {
  if (input.contract_version === 2) {
    return Object.freeze({
      contractVersion: 2, seedSupport: "unsupported-v2", seed: null, profile: "baseline-v13",
      guidance: 2.5, candidateCount: 3, temperature: 0.8,
      ranking: "speaker-cosine-max", watermark: "none", referenceTreatment: "audited-v13-reference",
    });
  }
  const profile = input.experiment_profile;
  if (typeof profile !== "string" || ![
    "control-v1", "reference-enhancement-v1", "text-normalization-v1",
    "guidance-ranking-v1", "watermark-v1", "combined-quality-v1",
  ].includes(profile)) throw new Error("canary_wire_invalid");
  const ranked = profile === "guidance-ranking-v1" || profile === "combined-quality-v1";
  const enhanced = profile === "reference-enhancement-v1" || profile === "combined-quality-v1";
  return Object.freeze({
    contractVersion: 3,
    seedSupport: "explicit-v3",
    seed: input.seed as number,
    profile: profile as HeroVoiceCanaryArmFields["profile"],
    guidance: ranked ? 2 : 2.5,
    candidateCount: 3,
    temperature: 0.8,
    ranking: ranked ? "speaker-cosine-plus-0.15-pitch" : "speaker-cosine-max",
    watermark: profile === "watermark-v1" ? "audioseal-v1" : "none",
    referenceTreatment: enhanced ? "demucs-then-peak-0.95" : "audited-v13-reference",
  });
}

function requestCommitment(input: {
  referenceSha256: string;
  refTextSha256: string;
  textSha256: string;
  speed: number;
  numStep: number;
  seed: number;
  experimentProfile: string;
  normalizerVersion: string;
}): string {
  return heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
    contractVersion: 3,
    mode: "clone",
    refAudioSha256: input.referenceSha256,
    refTextSha256: input.refTextSha256,
    textSha256: input.textSha256,
    speed: input.speed,
    numStep: input.numStep,
    mixedLanguage: true,
    seed: input.seed,
    experimentProfile: input.experimentProfile,
    normalizerVersion: input.normalizerVersion,
  }));
}

export function describeHeroVoiceCanaryWireRequest(input: {
  bytes: Uint8Array;
  runnerKind: HeroVoiceCanaryRunnerKind;
  endpointId: string;
  templateId: string;
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  expectedWorkerVersion: string;
  expectedCatalogVersion: string | null;
}): HeroVoiceCanaryWireDescriptor {
  if (!SAFE_ID.test(input.endpointId) || !SAFE_ID.test(input.templateId)
    || !/^sha256:[0-9a-f]{64}$/u.test(input.imageDigest)
    || !input.sourceRevision || !HEX64.test(input.modelManifestSha256)
    || !input.expectedWorkerVersion) throw new Error("canary_wire_identity_invalid");
  const parsed = parseHeroVoiceCanaryStrictJson(input.bytes);
  if (!isRecord(parsed) || !exactKeys(parsed, OUTER_KEYS)
    || !isRecord(parsed.input) || !isRecord(parsed.policy) || !exactKeys(parsed.policy, POLICY_KEYS)
    || parsed.policy.executionTimeout !== 540_000 || parsed.policy.ttl !== 900_000) {
    throw new Error("canary_wire_invalid");
  }
  const workerInput = parsed.input;
  const isV2 = workerInput.contract_version === 2;
  if (isV2 ? !exactKeys(workerInput, V2_KEYS) : !exactKeys(workerInput, V3_KEYS)) {
    throw new Error("canary_wire_invalid");
  }
  if (workerInput.mode !== "clone" || workerInput.mixed_language !== true
    || workerInput.speed !== 1 || workerInput.num_step !== 32
    || typeof workerInput.ref_text !== "string" || workerInput.ref_text.length === 0 || workerInput.ref_text.length > 2_000
    || typeof workerInput.text !== "string" || workerInput.text.length === 0 || workerInput.text.length > 800) {
    throw new Error("canary_wire_invalid");
  }
  const reference = decodeStrictBase64(workerInput.ref_audio_b64);
  const referenceSha256 = heroVoiceCanarySha256(reference);
  const refTextSha256 = heroVoiceCanarySha256(workerInput.ref_text);
  const textSha256 = heroVoiceCanarySha256(workerInput.text);
  let commitment: string | null = null;
  let normalizerVersion: string | null = null;
  if (isV2) {
    if (input.runnerKind !== "BaselineV13Direct" || input.expectedCatalogVersion === null) {
      throw new Error("canary_wire_runner_invalid");
    }
  } else {
    if (input.runnerKind === "BaselineV13Direct"
      || !Number.isSafeInteger(workerInput.seed) || (workerInput.seed as number) < 0
      || (workerInput.seed as number) > 2_147_483_647
      || workerInput.normalizer_version !== HERO_VOICE_CANARY_NORMALIZER_VERSION
      || typeof workerInput.experiment_profile !== "string"
      || typeof workerInput.request_commitment_sha256 !== "string" || !HEX64.test(workerInput.request_commitment_sha256)
      || workerInput.matched_settings_sha256 !== HERO_VOICE_CANARY_MATCHED_SETTINGS_SHA256) {
      throw new Error("canary_wire_invalid");
    }
    commitment = requestCommitment({
      referenceSha256, refTextSha256, textSha256,
      speed: workerInput.speed as number,
      numStep: workerInput.num_step as number,
      seed: workerInput.seed as number,
      experimentProfile: workerInput.experiment_profile,
      normalizerVersion: workerInput.normalizer_version,
    });
    if (commitment !== workerInput.request_commitment_sha256) throw new Error("canary_wire_commitment_invalid");
    normalizerVersion = workerInput.normalizer_version;
  }
  return Object.freeze({
    version: 1,
    runnerKind: input.runnerKind,
    endpointId: input.endpointId,
    templateId: input.templateId,
    imageDigest: input.imageDigest,
    sourceRevision: input.sourceRevision,
    modelManifestSha256: input.modelManifestSha256,
    expectedWorkerVersion: input.expectedWorkerVersion,
    expectedCatalogVersion: input.expectedCatalogVersion,
    contractVersion: isV2 ? 2 : 3,
    mode: "clone",
    referenceSha256,
    refTextSha256,
    textSha256,
    matchedSettings: HERO_VOICE_CANARY_MATCHED_SETTINGS,
    matchedSettingsSha256: HERO_VOICE_CANARY_MATCHED_SETTINGS_SHA256,
    requestCommitmentSha256: commitment,
    normalizerVersion,
    arm: armFromParsed(workerInput),
    policy: Object.freeze({ executionTimeout: 540_000 as const, ttl: 900_000 as const }),
  });
}

export function assertHeroVoiceCanaryDescriptorMatchesSlot(
  descriptor: HeroVoiceCanaryWireDescriptor,
  slot: HeroVoiceCanarySlot,
): void {
  const expected: HeroVoiceCanaryWireDescriptor = {
    version: 1,
    runnerKind: slot.runnerKind,
    endpointId: slot.endpointId,
    templateId: slot.templateId,
    imageDigest: slot.imageDigest,
    sourceRevision: slot.sourceRevision,
    modelManifestSha256: slot.modelManifestSha256,
    expectedWorkerVersion: slot.expectedWorkerVersion,
    expectedCatalogVersion: slot.expectedCatalogVersion,
    contractVersion: slot.arm.contractVersion,
    mode: "clone",
    referenceSha256: slot.referenceSha256,
    refTextSha256: slot.refTextSha256,
    textSha256: slot.speechTextSha256,
    matchedSettings: slot.matchedSettings,
    matchedSettingsSha256: slot.matchedSettingsSha256,
    requestCommitmentSha256: slot.requestCommitmentSha256,
    normalizerVersion: slot.arm.contractVersion === 3 ? slot.normalizerVersion : null,
    arm: slot.arm,
    policy: slot.policy,
  };
  if (!heroVoiceCanaryJcsBytes(descriptor).equals(heroVoiceCanaryJcsBytes(expected))) {
    throw new Error("canary_wire_manifest_mismatch");
  }
}

export function prepareHeroVoiceCanaryWireRequest(input: {
  slot: HeroVoiceCanarySlot;
  referenceWav: Uint8Array;
  refText: string;
}): PreparedHeroVoiceCanaryWireRequest {
  const referenceWav = Buffer.from(input.referenceWav);
  if (referenceWav.length === 0 || heroVoiceCanarySha256(referenceWav) !== input.slot.referenceSha256
    || heroVoiceCanarySha256(input.refText) !== input.slot.refTextSha256) {
    throw new Error("canary_reference_mismatch");
  }
  const text = speechTextForHeroVoiceCanarySlot(input.slot);
  const common = {
    contract_version: input.slot.arm.contractVersion,
    mode: "clone",
    ref_audio_b64: referenceWav.toString("base64"),
    ref_text: input.refText,
    text,
    speed: input.slot.matchedSettings.speed,
    num_step: input.slot.matchedSettings.numStep,
    mixed_language: true,
  };
  const workerInput = input.slot.arm.contractVersion === 2 ? common : {
    ...common,
    seed: input.slot.arm.seed,
    experiment_profile: input.slot.arm.profile,
    normalizer_version: input.slot.normalizerVersion,
    request_commitment_sha256: input.slot.requestCommitmentSha256,
    matched_settings_sha256: input.slot.matchedSettingsSha256,
  };
  const bytes = heroVoiceCanaryJcsBytes({ input: workerInput, policy: input.slot.policy });
  const descriptor = describeHeroVoiceCanaryWireRequest({
    bytes,
    runnerKind: input.slot.runnerKind,
    endpointId: input.slot.endpointId,
    templateId: input.slot.templateId,
    imageDigest: input.slot.imageDigest,
    sourceRevision: input.slot.sourceRevision,
    modelManifestSha256: input.slot.modelManifestSha256,
    expectedWorkerVersion: input.slot.expectedWorkerVersion,
    expectedCatalogVersion: input.slot.expectedCatalogVersion,
  });
  assertHeroVoiceCanaryDescriptorMatchesSlot(descriptor, input.slot);
  return Object.freeze({
    bytes,
    wireRequestSha256: heroVoiceCanarySha256(bytes),
    descriptor,
    descriptorSha256: heroVoiceCanarySha256(heroVoiceCanaryJcsBytes(descriptor)),
  });
}

export function verifyPreparedHeroVoiceCanaryWireRequest(
  prepared: PreparedHeroVoiceCanaryWireRequest,
  slot: HeroVoiceCanarySlot,
): void {
  if (heroVoiceCanarySha256(prepared.bytes) !== prepared.wireRequestSha256
    || heroVoiceCanarySha256(heroVoiceCanaryJcsBytes(prepared.descriptor)) !== prepared.descriptorSha256) {
    throw new Error("canary_wire_mutated");
  }
  const described = describeHeroVoiceCanaryWireRequest({
    bytes: prepared.bytes,
    runnerKind: prepared.descriptor.runnerKind,
    endpointId: prepared.descriptor.endpointId,
    templateId: prepared.descriptor.templateId,
    imageDigest: prepared.descriptor.imageDigest,
    sourceRevision: prepared.descriptor.sourceRevision,
    modelManifestSha256: prepared.descriptor.modelManifestSha256,
    expectedWorkerVersion: prepared.descriptor.expectedWorkerVersion,
    expectedCatalogVersion: prepared.descriptor.expectedCatalogVersion,
  });
  if (!heroVoiceCanaryJcsBytes(described).equals(heroVoiceCanaryJcsBytes(prepared.descriptor))) {
    throw new Error("canary_wire_descriptor_mutated");
  }
  assertHeroVoiceCanaryDescriptorMatchesSlot(described, slot);
}
