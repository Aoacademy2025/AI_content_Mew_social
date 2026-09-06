import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

import {
  HERO_VOICE_CLONE_CONFIG_KEYS,
  HERO_VOICE_CLONE_SOURCE_REVISION,
  HeroVoiceCloneConfigError,
  resolveHeroVoiceCloneConfig,
  resolveHeroVoiceCloneHumanDataGate,
} from "../src/lib/hero-voice-clone-config";
import {
  createCandidateAiStudioV3Snapshot,
  heroVoiceCloneRequestCommitment,
  parseCandidateAiStudioV3Snapshot,
  snapshotContainsForbiddenReferenceData,
} from "../src/lib/hero-voice-clone-snapshot";
import { heroVoiceCloneHumanDataGate } from "../src/lib/omnivoice";
import {
  BASELINE_V13_CATALOG_VERSION,
  BASELINE_V13_WORKER_VERSION,
  runnerUsesApplicationResolver,
  validateBaselineV13DirectResponse,
  validateCandidateV3Response,
  validatePcm16MonoWav,
  type BaselineV13Direct,
  type CandidateExperimentV3Direct,
  type HeroVoiceCloneRunner,
} from "../src/lib/hero-voice-clone-runners";
import {
  heroVoiceCloneExternalAbortDirective,
  heroVoiceCloneConservation,
  heroVoiceCloneFailureHttpStatus,
  isHeroVoiceCloneTerminalStatus,
  normalizeHeroVoiceClonePublicJob,
} from "../src/lib/hero-voice-clone-state";

function wav(samples = 24_000, sampleRate = 24_000): Buffer {
  const pcm = Buffer.alloc(samples * 2, 1);
  const value = Buffer.alloc(44 + pcm.length);
  value.write("RIFF", 0);
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(sampleRate, 24);
  value.writeUInt32LE(sampleRate * 2, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(pcm.length, 40);
  pcm.copy(value, 44);
  return value;
}

const fiveInputs = {
  RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID: "candidate-endpoint",
  RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST: `sha256:${"1".repeat(64)}`,
  RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION: HERO_VOICE_CLONE_SOURCE_REVISION,
  RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256: "3".repeat(64),
  RUNPOD_API_KEY: "private-test-key",
};
assert.deepEqual(HERO_VOICE_CLONE_CONFIG_KEYS, Object.keys(fiveInputs));
const config = resolveHeroVoiceCloneConfig(fiveInputs);
assert.equal(config.endpointId, "candidate-endpoint");
assert.equal(config.contractVersion, 3);
assert.equal(config.experimentProfile, "combined-quality-v1");
for (const key of HERO_VOICE_CLONE_CONFIG_KEYS) {
  assert.throws(
    () => resolveHeroVoiceCloneConfig({ ...fiveInputs, [key]: "" }),
    HeroVoiceCloneConfigError,
    `missing ${key} fails before a job can be created`,
  );
}
assert.throws(() => resolveHeroVoiceCloneConfig({
  ...fiveInputs,
  RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID: "https://injected.invalid/run",
}), HeroVoiceCloneConfigError);
assert.throws(() => resolveHeroVoiceCloneConfig({
  ...fiveInputs,
  RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST: "candidate:latest",
}), HeroVoiceCloneConfigError);
assert.throws(() => resolveHeroVoiceCloneConfig({
  ...fiveInputs,
  RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION: "f".repeat(40),
}), HeroVoiceCloneConfigError);
assert.throws(() => resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "development",
  executionMode: "0",
  task6GateSha256: "4".repeat(64),
}), HeroVoiceCloneConfigError);
assert.throws(() => resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "production",
  executionMode: "1",
  task6GateSha256: "4".repeat(64),
}), HeroVoiceCloneConfigError);
assert.equal(resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "development",
  executionMode: "1",
  task6GateSha256: "4".repeat(64),
}).kind, "task6-human-data-gate");

// ADR 0061: the owner-consent production gate opens only through its own explicit
// input, and only when the canary execution mode is NOT set. Without it, production
// stays fail-closed exactly as ADR 0060 left it.
const noCanary = { executionMode: undefined, task6GateSha256: undefined } as const;
assert.equal(resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "production", ...noCanary, productionOptIn: "1",
}).kind, "owner-consent-production-gate");
assert.throws(() => resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "production", ...noCanary, productionOptIn: undefined,
}), HeroVoiceCloneConfigError, "production without the opt-in stays fail-closed");
for (const value of ["0", "true", "yes", " 1", "", "1 "]) {
  assert.throws(() => resolveHeroVoiceCloneHumanDataGate({
    nodeEnv: "production", ...noCanary, productionOptIn: value,
  }), HeroVoiceCloneConfigError, `opt-in value ${JSON.stringify(value)} is not an opt-in`);
}
assert.throws(() => resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "production", executionMode: "1", task6GateSha256: "4".repeat(64), productionOptIn: "1",
}), HeroVoiceCloneConfigError, "the canary execution mode never combines with the production opt-in");
assert.throws(() => resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "development", executionMode: "1", task6GateSha256: "4".repeat(64), productionOptIn: "1",
}), HeroVoiceCloneConfigError);
assert.equal(resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "development", ...noCanary, productionOptIn: "1",
}).kind, "owner-consent-production-gate", "the opt-in is a deployment decision, not a NODE_ENV one (local smoke tests share the path)");
assert.equal(resolveHeroVoiceCloneHumanDataGate({
  nodeEnv: "development", executionMode: "1", task6GateSha256: "4".repeat(64), productionOptIn: undefined,
}).kind, "task6-human-data-gate", "the canary path is unchanged when the opt-in is absent");
{
  // Process-level readback: the application gate reads the opt-in from the environment.
  const env = process.env as Record<string, string | undefined>;
  const saved = {
    NODE_ENV: env.NODE_ENV,
    HERO_VOICE_CANARY_EXECUTION_MODE: env.HERO_VOICE_CANARY_EXECUTION_MODE,
    HERO_VOICE_CANARY_TASK6_GATE_SHA256: env.HERO_VOICE_CANARY_TASK6_GATE_SHA256,
    HERO_VOICE_CLONE_PRODUCTION: env.HERO_VOICE_CLONE_PRODUCTION,
  };
  env.NODE_ENV = "production";
  delete env.HERO_VOICE_CANARY_EXECUTION_MODE;
  delete env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
  delete env.HERO_VOICE_CLONE_PRODUCTION;
  assert.throws(() => heroVoiceCloneHumanDataGate(), HeroVoiceCloneConfigError, "NODE_ENV=production without HERO_VOICE_CLONE_PRODUCTION fails closed");
  env.HERO_VOICE_CLONE_PRODUCTION = "1";
  assert.equal(heroVoiceCloneHumanDataGate().kind, "owner-consent-production-gate", "NODE_ENV=production + HERO_VOICE_CLONE_PRODUCTION=1 opens the owner gate");
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
}

const requestCommitment = heroVoiceCloneRequestCommitment({
  refAudioSha256: "a".repeat(64),
  refText: "เสียงอ้างอิง",
  text: "ทดสอบ OpenAI 123",
  speed: 1,
  numStep: 32,
  seed: 104729,
  experimentProfile: "combined-quality-v1",
  normalizerVersion: "2026-07-24.1",
});
assert.equal(requestCommitment, "6f92111da34800ccb48e628a1419fc04eadb59ea8218f3cbd077ac45f7f42a0a");
const snapshot = createCandidateAiStudioV3Snapshot({
  config,
  attemptId: "11111111-1111-4111-8111-111111111111",
  sequence: 1,
  normalizerVersion: "2026-07-24.1",
  speed: 1,
  seed: 104729,
  text: "ทดสอบ OpenAI 123",
  refAudioSha256: "a".repeat(64),
  refDurationSamples24000: 192_000,
  refText: "เสียงอ้างอิง",
});
assert.equal(snapshot.synthesis.requestCommitmentSha256, requestCommitment);
assert.equal(snapshot.synthesis.matchedSettingsSha256, "db5ee34bab618d7b2f5f9376db436e4bfb460a93349040477d5cd86bed140c33");
assert.deepEqual(parseCandidateAiStudioV3Snapshot(snapshot), snapshot);
assert.equal(snapshotContainsForbiddenReferenceData(snapshot), false);
assert.equal(snapshotContainsForbiddenReferenceData({ ...snapshot, ref_audio_b64: "R7GvKp92xQ" }), true);
assert.equal(snapshotContainsForbiddenReferenceData({ ...snapshot, nested: { apiKey: "Y8jFa4T2mN" } }), true);
assert.equal(parseCandidateAiStudioV3Snapshot({ ...snapshot, extra: true }), null);
assert.equal(parseCandidateAiStudioV3Snapshot({ ...snapshot, endpointId: "different" })?.endpointId, "different");
assert.equal(parseCandidateAiStudioV3Snapshot({
  ...snapshot,
  synthesis: { ...snapshot.synthesis, requestCommitmentSha256: "A".repeat(64) },
}), null);
for (const [field, invalid] of Object.entries({
  version: 2,
  runnerKind: "other",
  attemptId: "x",
  sequence: 0,
  endpointId: "https://invalid",
  contractVersion: 2,
  workerKind: "mixed",
  workerVersion: "mutable",
  imageDigest: `sha256:${"A".repeat(64)}`,
  sourceRevision: "f".repeat(40),
  modelManifestSha256: "A".repeat(64),
  experimentProfile: "control-v1",
  normalizerVersion: "not valid",
  referenceSha256: "A".repeat(64),
  referenceDurationSamples24000: 1,
  synthesis: null,
  policy: null,
})) {
  assert.equal(parseCandidateAiStudioV3Snapshot({ ...snapshot, [field]: invalid }), null, `${field} mutation must fail`);
}
for (const [field, invalid] of Object.entries({
  speed: 0,
  numStep: 31,
  mixedLanguage: false,
  seed: -1,
  textSha256: "A".repeat(64),
  requestCommitmentSha256: "A".repeat(64),
  matchedSettingsSha256: "A".repeat(64),
  outputRate: 16_000,
  outputChannels: 2,
  outputSubtype: "FLOAT",
})) {
  assert.equal(parseCandidateAiStudioV3Snapshot({
    ...snapshot,
    synthesis: { ...snapshot.synthesis, [field]: invalid },
  }), null, `synthesis.${field} mutation must fail`);
}
for (const [field, invalid] of Object.entries({ executionTimeout: 1, ttl: 1 })) {
  assert.equal(parseCandidateAiStudioV3Snapshot({
    ...snapshot,
    policy: { ...snapshot.policy, [field]: invalid },
  }), null, `policy.${field} mutation must fail`);
}

const outputWav = wav();
const parsedOutputWav = validatePcm16MonoWav(outputWav, { sampleRate: 24_000, numSamples: 24_000 });
assert.ok(parsedOutputWav);
assert.deepEqual(parsedOutputWav.pcm16Frames, outputWav.subarray(44));
assert.equal(
  validatePcm16MonoWav(Buffer.concat([outputWav, Buffer.from([0])]), { sampleRate: 24_000 }),
  null,
  "strict WAV parsing rejects bytes beyond the declared RIFF container",
);
const stageIdentity = {
  speech_text_attestation: "application-speech-text/no-worker-rewrite-v1",
  reference_decode: "riff-wave/mono-24000-pcm16-v1",
  reference_peak_normalize: "float32/peak-0.95-v1",
  reference_resample_24000: "scipy-resample-poly/mono-24000-v1",
  demucs_reference_enhancement: "demucs/e976d93ecc3865e5757426930257e200846a520a/955717e8/shifts-0_split-true_overlap-0.25_segment-7/vocals-mean-mono",
  omnivoice_prompt: "omnivoice/346bb75330980a236540d61a0808d00767c0973b/zero-shot-clone-prompt",
  omnivoice_generate_three: "omnivoice/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/best-of-3/temperature-0.8/seed-sequence-v1",
  speaker_cosine_rank: "resemblyzer/cosine/max-v1",
  thai_dominant_segmentation: "thai-english-v13/merge-english-runs-max4words-into-thai-v1",
  speaker_pitch_rank: "resemblyzer+librosa.pyin-C2-C6/cosine+0.15*pitch-v1",
  audioseal_resample_16000: "scipy-resample-poly/mono-16000-v1",
  audioseal_embed: "audioseal-0.2.0/e63a8a0e5cdf7bb797159c92ba15961557fe9bd2/3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba/16bits/message-1011001011010110/alpha-1.0",
  audioseal_resample_24000: "scipy-resample-poly/mono-24000/preserve-samples-v1",
  audioseal_detect: "audioseal-0.2.0/threshold-0.5/message-threshold-0.5/positive-gt-0.5",
  output_validate_pcm16: "wave/mono-24000-pcm16/max-7000000-v1",
} as const;
const stages = (...names: Array<keyof typeof stageIdentity>) => names.map((name) => ({
  name,
  identity: stageIdentity[name],
}));
const candidateResponse = {
  ok: true,
  contract_version: 3,
  mode: "clone",
  worker_kind: "clone-only",
  worker_version: snapshot.workerVersion,
  image_digest: snapshot.imageDigest,
  source_revision: snapshot.sourceRevision,
  model_manifest_sha256: snapshot.modelManifestSha256,
  experiment_profile: snapshot.experimentProfile,
  normalizer_version: snapshot.normalizerVersion,
  mixed_language: true,
  request_commitment_sha256: snapshot.synthesis.requestCommitmentSha256,
  matched_settings_sha256: snapshot.synthesis.matchedSettingsSha256,
  audio_base64: outputWav.toString("base64"),
  format: "wav",
  sample_rate: 24_000,
  channels: 1,
  subtype: "PCM_16",
  num_samples: 24_000,
  duration_ms: 1_000,
  stages: stages(
    "speech_text_attestation", "reference_decode", "demucs_reference_enhancement",
    "reference_peak_normalize", "reference_resample_24000", "omnivoice_prompt",
    "omnivoice_generate_three", "speaker_pitch_rank", "output_validate_pcm16",
  ),
  metrics: {
    reference: {
      input_sha256: snapshot.referenceSha256,
      canonical_sha256: "b".repeat(64),
      effective_sha256: "c".repeat(64),
      input_samples_24000: 192_000,
      effective_samples_24000: 192_000,
      enhanced: true,
      pre_peak: 0.8,
      post_peak: 0.95,
      pre_rms: 0.2,
      post_rms: 0.18,
      pre_samples: 352_800,
      post_samples: 192_000,
      pre_clipping_samples: 0,
      post_clipping_samples: 0,
    },
    generation: { candidate_count: 3, guidance: 2, class_temperature: 0.8 },
    candidates: [
      { index: 0, audio_sha256: "d".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.8, pitch_similarity_normalized: 0.5, ranking_score: 0.8 + 0.15 * 0.5 },
      { index: 1, audio_sha256: "e".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.7, pitch_similarity_normalized: 0.9, ranking_score: 0.7 + 0.15 * 0.9 },
      { index: 2, audio_sha256: "f".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.6, pitch_similarity_normalized: 0.2, ranking_score: 0.6 + 0.15 * 0.2 },
    ],
    selected_candidate_index: 0,
    ranking_formula: "speaker_cosine+0.15*pitch_similarity_normalized", watermark: null,
  },
  timing_ms: { reference: 1, prompt: 1, synthesis: 1, ranking: 1, watermark: 0, encode: 1, total: 5 },
};
const expectedIdentity = {
  workerVersion: snapshot.workerVersion,
  imageDigest: snapshot.imageDigest,
  sourceRevision: snapshot.sourceRevision,
  modelManifestSha256: snapshot.modelManifestSha256,
  experimentProfile: snapshot.experimentProfile,
  normalizerVersion: snapshot.normalizerVersion,
  requestCommitmentSha256: snapshot.synthesis.requestCommitmentSha256,
  matchedSettingsSha256: snapshot.synthesis.matchedSettingsSha256,
  referenceSha256: snapshot.referenceSha256,
  referenceDurationSamples24000: snapshot.referenceDurationSamples24000,
};
assert.equal(validateCandidateV3Response(candidateResponse, expectedIdentity).ok, true);
for (const [path, invalid, label] of [
  [["metrics", "reference", "effective_sha256"], candidateResponse.metrics.reference.canonical_sha256,
    "enhancement must change the exact prompt-domain PCM16 hash"],
  [["metrics", "reference", "post_peak"], 0.7,
    "the pinned peak-0.95 stage cannot attest post_peak 0.7"],
  [["metrics", "reference", "post_clipping_samples"], 1,
    "the peak-0.95 output cannot contain clipped samples"],
  [["metrics", "reference", "pre_clipping_samples"], 1,
    "a pre-peak below one cannot attest clipped input samples"],
  [["metrics", "reference", "post_rms"], 0.96,
    "post RMS cannot exceed the attested post peak"],
] as Array<[Array<string | number>, unknown, string]>) {
  assert.equal(
    validateCandidateV3Response(mutateAtPath(candidateResponse, path, invalid), expectedIdentity).ok,
    false,
    label,
  );
}
assert.deepEqual(validateCandidateV3Response({ ...candidateResponse, source_revision: "f".repeat(40) }, {
  ...expectedIdentity,
  sourceRevision: "f".repeat(40),
}), { ok: false, failure: "identity" }, "an injected arbitrary 40-hex revision cannot redefine identity");
for (const field of [
  "worker_version", "image_digest", "source_revision", "model_manifest_sha256",
  "experiment_profile", "normalizer_version", "request_commitment_sha256", "matched_settings_sha256",
] as const) {
  const result = validateCandidateV3Response({ ...candidateResponse, [field]: "wrong" }, expectedIdentity);
  assert.deepEqual(result, { ok: false, failure: "identity" }, `${field} mismatch is terminal identity failure`);
}
for (const mutation of [
  { ok: false },
  { contract_version: 2 },
  { mode: "tts" },
  { worker_kind: "mixed" },
  { mixed_language: false },
  { sample_rate: 16_000 },
  { channels: 2 },
  { subtype: "FLOAT" },
  { audio_base64: "AAAA" },
  { duration_ms: 999 },
  { num_samples: true },
  { stages: null },
  { metrics: null },
  { timing_ms: null },
  { extra: true },
]) {
  assert.equal(validateCandidateV3Response({ ...candidateResponse, ...mutation }, expectedIdentity).ok, false);
}
for (const [path, invalid] of [
  [["metrics", "selected_candidate_index"], 2],
  [["metrics", "ranking_formula"], "mutable"],
  [["metrics", "watermark"], {}],
  [["metrics", "candidates"], []],
] as Array<[Array<string | number>, unknown]>) {
  assert.equal(validateCandidateV3Response(mutateAtPath(candidateResponse, path, invalid), expectedIdentity).ok, false);
}
assert.equal(validateCandidateV3Response({
  ...candidateResponse,
  metrics: { ...candidateResponse.metrics, extra: true },
}, expectedIdentity).ok, false);
assert.equal(validateCandidateV3Response({
  ...candidateResponse,
  timing_ms: { ...candidateResponse.timing_ms, extra: 0 },
}, expectedIdentity).ok, false);
for (const [field, invalid] of Object.entries({ candidate_count: 2, guidance: 2.5, class_temperature: 1 })) {
  assert.equal(validateCandidateV3Response(
    mutateAtPath(candidateResponse, ["metrics", "generation", field], invalid), expectedIdentity,
  ).ok, false, `generation.${field} mutation must fail`);
}

function mutateAtPath<T>(source: T, path: Array<string | number>, replacement: unknown): T {
  const cloned = structuredClone(source);
  let cursor = cloned as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path.at(-1)!] = replacement;
  return cloned;
}

const invalidReferenceValues: Record<string, unknown> = {
  input_sha256: "A".repeat(64), canonical_sha256: "A".repeat(64), effective_sha256: "A".repeat(64),
  input_samples_24000: 1, effective_samples_24000: 1, enhanced: 1, pre_peak: Infinity,
  post_peak: 2, pre_rms: -1, post_rms: 2, pre_samples: 1, post_samples: 1,
  pre_clipping_samples: -1, post_clipping_samples: -1,
};
for (const [field, invalid] of Object.entries(invalidReferenceValues)) {
  assert.equal(validateCandidateV3Response(
    mutateAtPath(candidateResponse, ["metrics", "reference", field], invalid), expectedIdentity,
  ).ok, false, `reference.${field} mutation must fail`);
}
for (let index = 0; index < 3; index += 1) {
  for (const [field, invalid] of Object.entries({
    index: 9, audio_sha256: "A".repeat(64), audio_sha256_domain: "wrong", samples_24k: 0, speaker_cosine: 2,
    pitch_similarity_normalized: null, ranking_score: 999,
  })) {
    assert.equal(validateCandidateV3Response(
      mutateAtPath(candidateResponse, ["metrics", "candidates", index, field], invalid), expectedIdentity,
    ).ok, false, `candidates[${index}].${field} mutation must fail`);
  }
}
for (let index = 0; index < candidateResponse.stages.length; index += 1) {
  for (const field of ["name", "identity"] as const) {
    assert.equal(validateCandidateV3Response(
      mutateAtPath(candidateResponse, ["stages", index, field], "wrong"), expectedIdentity,
    ).ok, false, `stages[${index}].${field} mutation must fail`);
  }
}
for (const field of ["reference", "prompt", "synthesis", "ranking", "watermark", "encode", "total"]) {
  assert.equal(validateCandidateV3Response(
    mutateAtPath(candidateResponse, ["timing_ms", field], 540_001), expectedIdentity,
  ).ok, false, `timing_ms.${field} mutation must fail`);
}

const watermarkExpected = { ...expectedIdentity, experimentProfile: "watermark-v1" };
const watermarkBits = "1011001011010110";
const watermarkResponse = {
  ...candidateResponse,
  experiment_profile: "watermark-v1",
  stages: stages(
    "speech_text_attestation", "reference_decode", "reference_resample_24000",
    "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank", "audioseal_resample_16000",
    "audioseal_embed", "audioseal_resample_24000", "audioseal_detect", "output_validate_pcm16",
  ),
  metrics: {
    ...candidateResponse.metrics,
    generation: { ...candidateResponse.metrics.generation, guidance: 2.5 },
    reference: {
      ...candidateResponse.metrics.reference,
      enhanced: false,
      pre_samples: 192_000,
      canonical_sha256: "c".repeat(64),
      post_peak: 0.8,
    },
    candidates: candidateResponse.metrics.candidates.map((candidate) => ({
      ...candidate,
      pitch_similarity_normalized: null,
      ranking_score: candidate.speaker_cosine,
    })),
    ranking_formula: "speaker_cosine",
    watermark: {
      evidence_version: 1,
      message: watermarkBits,
      alpha: 1,
      detection_threshold: 0.5,
      message_threshold: 0.5,
      detect_fraction: 1,
      positive: true,
      decoded_message: watermarkBits,
      frame_probabilities: [0.8, 0.9],
      bit_probabilities: [...watermarkBits].map((bit) => bit === "1" ? 0.9 : 0.1),
      bit_error_rate: 0,
      selected_candidate_24k_sha256: candidateResponse.metrics.candidates[0].audio_sha256,
      selected_candidate_24k_sha256_domain: "float32-le-mono-24000-v1",
      pre_embed_sha256: "1".repeat(64),
      pre_embed_sha256_domain: "float32-le-mono-16000-v1",
      watermarked_16k_sha256: "2".repeat(64),
      watermarked_16k_sha256_domain: "float32-le-mono-16000-v1",
      delivered_24k_sha256: createHash("sha256").update(outputWav.subarray(44)).digest("hex"),
      delivered_24k_sha256_domain: "pcm-s16le-mono-24000-wav-data-v1",
      samples_24k_selected: 24_000,
      samples_16k_pre_embed: 16_000,
      samples_16k_post_embed: 16_000,
      samples_24k_output: 24_000,
    },
  },
};
assert.equal(validateCandidateV3Response(watermarkResponse, watermarkExpected).ok, true);
for (const [path, invalid, label] of [
  [["metrics", "reference", "canonical_sha256"], "9".repeat(64),
    "non-enhancement profiles must keep canonical and effective prompt hashes equal"],
  [["metrics", "reference", "pre_peak"], 1.1,
    "non-enhancement reference metrics stay in the decoded PCM domain"],
  [["metrics", "watermark", "selected_candidate_24k_sha256"], "9".repeat(64),
    "watermark evidence must identify the selected 24 kHz candidate in its own domain"],
  [["metrics", "watermark", "samples_24k_output"], 23_999,
    "delivered watermark samples must equal the accepted WAV sample count"],
] as Array<[Array<string | number>, unknown, string]>) {
  assert.equal(validateCandidateV3Response(mutateAtPath(watermarkResponse, path, invalid), watermarkExpected).ok, false, label);
}

const controlStages = stages(
  "speech_text_attestation", "reference_decode", "reference_resample_24000",
  "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank", "output_validate_pcm16",
);
const pitchStages = stages(
  "speech_text_attestation", "reference_decode", "reference_resample_24000",
  "omnivoice_prompt", "omnivoice_generate_three", "speaker_pitch_rank", "output_validate_pcm16",
);
const enhancementStages = stages(
  "speech_text_attestation", "reference_decode", "demucs_reference_enhancement", "reference_peak_normalize",
  "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank",
  "output_validate_pcm16",
);
const cosineCandidates = candidateResponse.metrics.candidates.map((candidate) => ({
  ...candidate,
  pitch_similarity_normalized: null,
  ranking_score: candidate.speaker_cosine,
}));
const nonEnhancedReference = {
  ...candidateResponse.metrics.reference,
  canonical_sha256: candidateResponse.metrics.reference.effective_sha256,
  enhanced: false,
  pre_peak: 0.8,
  post_peak: 0.8,
  pre_samples: 192_000,
};
for (const [profile, profileStages, pitch] of [
  ["control-v1", controlStages, false],
  ["text-normalization-v1", controlStages, false],
  ["guidance-ranking-v1", pitchStages, true],
  ["reference-enhancement-v1", enhancementStages, false],
] as const) {
  const response = {
    ...candidateResponse,
    experiment_profile: profile,
    stages: profileStages,
    metrics: {
      ...candidateResponse.metrics,
      generation: {
        ...candidateResponse.metrics.generation,
        guidance: pitch ? 2 : 2.5,
      },
      reference: profile === "reference-enhancement-v1"
        ? candidateResponse.metrics.reference
        : nonEnhancedReference,
      candidates: pitch ? candidateResponse.metrics.candidates : cosineCandidates,
      ranking_formula: pitch ? "speaker_cosine+0.15*pitch_similarity_normalized" : "speaker_cosine",
    },
  };
  const profileIdentity = { ...expectedIdentity, experimentProfile: profile };
  assert.equal(validateCandidateV3Response(response, profileIdentity).ok, true,
    `${profile} exact semantics must be accepted`);
  if (profile === "reference-enhancement-v1") {
    assert.equal(validateCandidateV3Response(mutateAtPath(
      response,
      ["metrics", "reference", "effective_sha256"],
      response.metrics.reference.canonical_sha256,
    ), profileIdentity).ok, false, `${profile} cannot attest a prompt-domain semantic no-op`);
  } else {
    assert.equal(validateCandidateV3Response(mutateAtPath(
      response,
      ["metrics", "reference", "canonical_sha256"],
      "9".repeat(64),
    ), profileIdentity).ok, false, `${profile} cannot attest an unrequested reference treatment`);
    assert.equal(validateCandidateV3Response(mutateAtPath(
      response,
      ["metrics", "reference", "effective_samples_24000"],
      192_001,
    ), profileIdentity).ok, false, `${profile} preserves reference sample count exactly`);
  }
}
const invalidWatermarkValues: Record<string, unknown> = {
  evidence_version: 2, message: "0", alpha: 0, detection_threshold: 0.4, message_threshold: 0.4,
  detect_fraction: 0.5, positive: false, decoded_message: "0", frame_probabilities: [],
  bit_probabilities: [], bit_error_rate: 0.1, selected_candidate_24k_sha256: "A".repeat(64),
  selected_candidate_24k_sha256_domain: "wrong", pre_embed_sha256: "A".repeat(64),
  pre_embed_sha256_domain: "wrong", watermarked_16k_sha256: "A".repeat(64),
  watermarked_16k_sha256_domain: "wrong", delivered_24k_sha256: "A".repeat(64),
  delivered_24k_sha256_domain: "wrong", samples_24k_selected: 0,
  samples_16k_pre_embed: 0, samples_16k_post_embed: 0, samples_24k_output: 0,
};
for (const [field, invalid] of Object.entries(invalidWatermarkValues)) {
  assert.equal(validateCandidateV3Response(
    mutateAtPath(watermarkResponse, ["metrics", "watermark", field], invalid), watermarkExpected,
  ).ok, false, `watermark.${field} mutation must fail`);
}

type CrossBoundaryFixture = {
  profile: string;
  response: typeof candidateResponse;
  expected: typeof expectedIdentity;
};
const crossBoundaryFixtures = JSON.parse(execFileSync(
  "python3",
  ["services/omnivoice-clone-runpod/emit_cross_boundary_fixtures.py"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
)) as CrossBoundaryFixture[];
assert.deepEqual(
  crossBoundaryFixtures.map((fixture) => fixture.profile).sort(),
  [
    "combined-quality-thai-dominant-v1", "combined-quality-v1", "control-v1", "guidance-ranking-v1",
    "reference-enhancement-v1", "text-normalization-v1", "watermark-v1",
  ],
  "the real Task 3 handler/FakeRuntime boundary emits all seven profiles",
);
for (const fixture of crossBoundaryFixtures) {
  assert.equal(
    validateCandidateV3Response(fixture.response, fixture.expected).ok,
    true,
    `Task 2 accepts the current Task 3 ${fixture.profile} envelope`,
  );
}
const crossBoundaryWatermark = crossBoundaryFixtures.find((fixture) => fixture.profile === "watermark-v1")!;
const crossWatermarkMetrics = crossBoundaryWatermark.response.metrics.watermark as Record<string, unknown>;
assert.notEqual(
  crossWatermarkMetrics.pre_embed_sha256,
  crossBoundaryWatermark.response.metrics.candidates[
    crossBoundaryWatermark.response.metrics.selected_candidate_index
  ].audio_sha256,
  "the fixture must not fabricate equality between selected 24 kHz and pre-embed 16 kHz float domains",
);
const changedDeliveredWav = Buffer.from(crossBoundaryWatermark.response.audio_base64, "base64");
changedDeliveredWav[changedDeliveredWav.length - 1] ^= 1;
assert.equal(
  validateCandidateV3Response(
    { ...crossBoundaryWatermark.response, audio_base64: changedDeliveredWav.toString("base64") },
    crossBoundaryWatermark.expected,
  ).ok,
  false,
  "Task 2 recomputes the delivered digest from the exact returned WAV PCM16 frames",
);
for (const [path, invalid, label] of [
  [["metrics", "watermark", "delivered_24k_sha256"], "0".repeat(64), "arbitrary delivered PCM hash"],
  [["metrics", "watermark", "pre_embed_sha256"], crossWatermarkMetrics.watermarked_16k_sha256,
    "pre-embed hash equal to marked hash"],
  [["metrics", "watermark", "selected_candidate_24k_sha256"], "0".repeat(64), "wrong selected hash"],
  [["metrics", "watermark", "samples_24k_selected"], 2_399, "wrong selected sample count"],
  [["metrics", "watermark", "samples_16k_pre_embed"], 1_599, "wrong pre-embed sample count"],
  [["metrics", "watermark", "samples_16k_post_embed"], 1_599, "wrong post-embed sample count"],
  [["metrics", "watermark", "samples_24k_output"], 2_399, "wrong final sample count"],
  [["metrics", "watermark", "selected_candidate_24k_sha256_domain"], "wrong", "wrong selected domain"],
  [["metrics", "watermark", "pre_embed_sha256_domain"], "wrong", "wrong pre-embed domain"],
  [["metrics", "watermark", "watermarked_16k_sha256_domain"], "wrong", "wrong marked domain"],
  [["metrics", "watermark", "delivered_24k_sha256_domain"], "wrong", "wrong delivered domain"],
] as Array<[Array<string | number>, unknown, string]>) {
  assert.equal(
    validateCandidateV3Response(
      mutateAtPath(crossBoundaryWatermark.response, path, invalid),
      crossBoundaryWatermark.expected,
    ).ok,
    false,
    `cross-boundary fixture rejects ${label}`,
  );
}

const baselineResponse = {
  contract_version: 2,
  mode: "clone",
  worker_version: BASELINE_V13_WORKER_VERSION,
  catalog_version: BASELINE_V13_CATALOG_VERSION,
  similarity_score: 0.9,
  audio_base64: outputWav.toString("base64"),
  format: "wav",
  sample_rate: 24_000,
  duration: 1,
  generation_time: 1.2,
};
assert.equal(validateBaselineV13DirectResponse(baselineResponse).ok, true);
assert.equal(validateBaselineV13DirectResponse({ ...baselineResponse, worker_version: "mutable" }).ok, false);
for (const [field, invalid] of Object.entries({
  contract_version: 3,
  mode: "tts",
  worker_version: "mutable",
  catalog_version: "mutable",
  similarity_score: 2,
  audio_base64: "AAAA",
  format: "mp3",
  sample_rate: 16_000,
  duration: 0,
  generation_time: -1,
})) {
  assert.equal(validateBaselineV13DirectResponse({ ...baselineResponse, [field]: invalid }).ok, false,
    `baseline ${field} mutation must fail`);
}
assert.equal(validateBaselineV13DirectResponse({ ...baselineResponse, extra: true }).ok, false);

const baselineRunner: BaselineV13Direct = {
  runnerKind: "BaselineV13Direct",
  endpointId: "baseline-only",
  imageDigest: `sha256:${"b".repeat(64)}`,
  request: {
    contract_version: 2,
    mode: "clone",
    ref_audio_b64: "AA==",
    ref_text: "ref",
    text: "text",
    speed: 1,
    num_step: 32,
    mixed_language: true,
  },
};
const experimentRunner: CandidateExperimentV3Direct = {
  runnerKind: "CandidateExperimentV3Direct",
  endpointId: "candidate-only",
  imageDigest: snapshot.imageDigest,
  sourceRevision: snapshot.sourceRevision,
  modelManifestSha256: snapshot.modelManifestSha256,
  experimentProfile: "control-v1",
};
const runners: HeroVoiceCloneRunner[] = [baselineRunner, experimentRunner, { runnerKind: "CandidateAiStudioV3", snapshot }];
assert.deepEqual(runners.map(runnerUsesApplicationResolver), [false, false, true]);

for (const status of [
  "failed_unknown_submit", "failed_timeout", "failed_poll_unavailable", "failed_provider_status",
  "failed_provider_missing", "failed_identity", "failed_output", "canceled", "completed",
]) assert.equal(isHeroVoiceCloneTerminalStatus(status), true);
assert.equal(heroVoiceCloneFailureHttpStatus("CLONE_POLL_UNAVAILABLE"), 503);
assert.equal(heroVoiceCloneFailureHttpStatus("CLONE_PROVIDER_JOB_MISSING"), 502);
assert.equal(normalizeHeroVoiceClonePublicJob({ status: "failed_identity", errorCode: "CLONE_IDENTITY_MISMATCH" }).status, "failed");
const abort = heroVoiceCloneExternalAbortDirective({
  externalRunDisposition: "abort_required",
  status: "failed_unknown_submit",
  errorCode: "CLONE_SUBMIT_OUTCOME_UNKNOWN",
  dispatchIntentAt: new Date(1_000),
});
assert.equal(abort?.preserveExternalReserveSeconds, 660);
assert.equal(abort?.firstParkNoLaterThanMs, 601_000);
assert.equal(abort?.finalObservationDeadlineMs, 661_000);
assert.deepEqual(heroVoiceCloneConservation({
  plannedSlots: 44,
  notStarted: 40,
  providerRejected: 1,
  transportUnknown: 1,
  providerAccepted: 2,
  validCompleted: 1,
  providerTerminalFailed: 0,
  acceptedOutcomeUnknown: 1,
  applicationValidationFailed: 0,
}), { dispatchIntents: 4, possibleProviderReceived: { minimum: 3, maximum: 4 } });
assert.throws(() => heroVoiceCloneConservation({
  plannedSlots: 44,
  notStarted: 44,
  providerRejected: 0,
  transportUnknown: 1,
  providerAccepted: 0,
  validCompleted: 0,
  providerTerminalFailed: 0,
  acceptedOutcomeUnknown: 0,
  applicationValidationFailed: 0,
}));

const omnivoiceSource = fs.readFileSync("src/lib/omnivoice.ts", "utf8");
const resolverSource = omnivoiceSource.slice(
  omnivoiceSource.indexOf("export function heroVoiceCloneConfig()"),
  omnivoiceSource.indexOf("export function heroVoiceCloneHumanDataGate()"),
);
assert.deepEqual(
  [...resolverSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]),
  [...HERO_VOICE_CLONE_CONFIG_KEYS],
  "application clone resolution reads exactly the five declared inputs",
);
assert.doesNotMatch(resolverSource, /RUNPOD_OMNIVOICE_ENDPOINT_ID|BASELINE|OMNIVOICE_BACKEND/);
assert.equal(
  [...omnivoiceSource.matchAll(/process\.env\.HERO_VOICE_CLONE_PRODUCTION/g)].length, 1,
  "the production opt-in is read once, inside heroVoiceCloneHumanDataGate()",
);
assert.match(omnivoiceSource, /process\.env\.RUNPOD_OMNIVOICE_ENDPOINT_ID/,
  "stock endpoint configuration remains on its existing variable");
assert.match(omnivoiceSource, /policy:\s*snapshot\.policy/);
assert.doesNotMatch(
  fs.readFileSync("src/lib/hero-voice-clone-runners.ts", "utf8"),
  /heroVoiceCloneConfig|resolveHeroVoiceCloneConfig/,
  "direct runner schemas cannot route through the application resolver",
);
const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
assert.match(schema, /model AiGenerationAttempt[\s\S]*?inputJson\s+String\?/);
const task2Migration = fs.readFileSync(
  "prisma/migrations/20260904043000_hero_voice_clone_terminal_identity/migration.sql",
  "utf8",
);
assert.doesNotMatch(task2Migration, /(?:DeletionTransaction|DeletionArtifact|ReviewRun|CanaryLedger)/,
  "Task 2's migration remains limited to its job/attempt durability fields");
assert.match(schema, /model DeletionTransaction\s*\{/,
  "the later additive Task 4 schema may coexist without modifying Task 2's migration");
const statusRoute = fs.readFileSync("src/app/api/ai-studio/jobs/[id]/route.ts", "utf8");
const studioPage = fs.readFileSync("src/app/(dashboard)/ai-studio/page.tsx", "utf8");
assert.match(statusRoute, /normalizeHeroVoiceClonePublicJob\(publicAiGenerationJob\(job\)\)/);
assert.match(studioPage, /const ACTIVE_JOB_STATUS = new Set\(\["queued", "in_progress"\]\)/);
assert.equal(normalizeHeroVoiceClonePublicJob({ status: "failed_provider_missing" }).status, "failed",
  "the existing UI terminates after the status route's deep-boundary projection");

console.log("Hero Voice clone Task 2 config/snapshot/runner/state/privacy checks passed.");
