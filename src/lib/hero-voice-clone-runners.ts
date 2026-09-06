import { createHash } from "node:crypto";

import { HERO_VOICE_CLONE_SOURCE_REVISION } from "@/lib/hero-voice-clone-config";
import type { CandidateAiStudioV3Snapshot } from "@/lib/hero-voice-clone-snapshot";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 7_000_000;
const MAX_OUTPUT_SAMPLES_24K = Math.floor((MAX_OUTPUT_BYTES - 44) / 2);
const MAX_REFERENCE_SAMPLES_24K = 15 * 24_000;
const MAX_REFERENCE_SAMPLES_44K = 15 * 44_100 + 8;
const MIN_REFERENCE_SAMPLES_24K = 119_998;
const MIN_EFFECTIVE_REFERENCE_SAMPLES_24K = 119_997;
const MAX_OUTPUT_SAMPLES_16K = 2_333_327;
const MAX_PIPELINE_TIMING_MS = 540_000;
const MAX_WATERMARK_FRAME_PROBABILITIES = 4_096;
const PITCH_WEIGHT = 0.15;
const REFERENCE_PEAK_TARGET = 0.95;
const PCM16_LEVEL = 1 / 32_768;
const CANDIDATE_AUDIO_HASH_DOMAIN = "float32-le-mono-24000-v1";
const WATERMARK_INTERNAL_HASH_DOMAIN = "float32-le-mono-16000-v1";
const DELIVERED_AUDIO_HASH_DOMAIN = "pcm-s16le-mono-24000-wav-data-v1";
const WATERMARK_EVIDENCE_VERSION = 1;
const CANDIDATE_WORKER_VERSION = "hero-voice-clone-contract-v3-internal-eval-2";
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+/@:-]{0,127}$/;

export const BASELINE_V13_WORKER_VERSION = "hero-voice-ai-v2-565d0e6" as const;
export const BASELINE_V13_CATALOG_VERSION = "hero-voice-ai-v2-2026-08-24" as const;

export type BaselineV13Direct = {
  runnerKind: "BaselineV13Direct";
  endpointId: string;
  imageDigest: string;
  request: {
    contract_version: 2;
    mode: "clone";
    ref_audio_b64: string;
    ref_text: string;
    text: string;
    speed: number;
    num_step: number;
    mixed_language: true;
  };
};

export type CandidateExperimentV3Direct = {
  runnerKind: "CandidateExperimentV3Direct";
  endpointId: string;
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  experimentProfile:
    | "control-v1"
    | "reference-enhancement-v1"
    | "text-normalization-v1"
    | "guidance-ranking-v1"
    | "watermark-v1"
    | "combined-quality-thai-dominant-v1";
};

export type CandidateAiStudioV3 = {
  runnerKind: "CandidateAiStudioV3";
  snapshot: CandidateAiStudioV3Snapshot;
};

export type HeroVoiceCloneRunner = BaselineV13Direct | CandidateExperimentV3Direct | CandidateAiStudioV3;

export type CandidateV3Success = {
  ok: true;
  contract_version: 3;
  mode: "clone";
  worker_kind: "clone-only";
  worker_version: string;
  image_digest: string;
  source_revision: string;
  model_manifest_sha256: string;
  experiment_profile: string;
  normalizer_version: string;
  mixed_language: true;
  request_commitment_sha256: string;
  matched_settings_sha256: string;
  audio_base64: string;
  format: "wav";
  sample_rate: 24_000;
  channels: 1;
  subtype: "PCM_16";
  num_samples: number;
  duration_ms: number;
  stages: Array<{ name: string; identity: string }>;
  metrics: Record<string, unknown>;
  timing_ms: Record<string, number>;
};

export type BaselineV13Success = {
  contract_version: 2;
  mode: "clone";
  worker_version: typeof BASELINE_V13_WORKER_VERSION;
  catalog_version: typeof BASELINE_V13_CATALOG_VERSION;
  similarity_score: number;
  audio_base64: string;
  format: "wav";
  sample_rate: number;
  duration: number;
  generation_time: number;
};

export type CandidateV3ExpectedIdentity = {
  workerVersion: string;
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  experimentProfile: string;
  normalizerVersion: string;
  requestCommitmentSha256: string;
  matchedSettingsSha256: string;
  referenceSha256: string;
  referenceDurationSamples24000: number;
};

export type CloneResponseValidation<T> =
  | { ok: true; response: T; audio: Buffer; numSamples: number }
  | { ok: false; failure: "identity" | "output" };

const CANDIDATE_KEYS = [
  "ok", "contract_version", "mode", "worker_kind", "worker_version", "image_digest",
  "source_revision", "model_manifest_sha256", "experiment_profile", "normalizer_version",
  "mixed_language", "request_commitment_sha256", "matched_settings_sha256", "audio_base64",
  "format", "sample_rate", "channels", "subtype", "num_samples", "duration_ms", "stages",
  "metrics", "timing_ms",
] as const;
const TIMING_KEYS = ["reference", "prompt", "synthesis", "ranking", "watermark", "encode", "total"] as const;
const METRIC_KEYS = [
  "reference", "generation", "candidates", "selected_candidate_index", "ranking_formula", "watermark",
] as const;
const GENERATION_KEYS = ["candidate_count", "guidance", "class_temperature"] as const;
const REFERENCE_KEYS = [
  "input_sha256", "canonical_sha256", "effective_sha256", "input_samples_24000",
  "effective_samples_24000", "enhanced", "pre_peak", "post_peak", "pre_rms", "post_rms",
  "pre_samples", "post_samples", "pre_clipping_samples", "post_clipping_samples",
] as const;
const CANDIDATE_METRIC_KEYS = [
  "index", "audio_sha256", "audio_sha256_domain", "samples_24k", "speaker_cosine",
  "pitch_similarity_normalized", "ranking_score",
] as const;
const WATERMARK_KEYS = [
  "evidence_version", "message", "alpha", "detection_threshold", "message_threshold", "detect_fraction",
  "positive", "decoded_message", "frame_probabilities", "bit_probabilities", "bit_error_rate",
  "selected_candidate_24k_sha256", "selected_candidate_24k_sha256_domain", "pre_embed_sha256",
  "pre_embed_sha256_domain", "watermarked_16k_sha256", "watermarked_16k_sha256_domain",
  "delivered_24k_sha256", "delivered_24k_sha256_domain", "samples_24k_selected",
  "samples_16k_pre_embed", "samples_16k_post_embed", "samples_24k_output",
] as const;
const BASELINE_KEYS = [
  "contract_version", "mode", "worker_version", "catalog_version", "similarity_score", "audio_base64",
  "format", "sample_rate", "duration", "generation_time",
] as const;
const PITCH_PROFILES = new Set(["guidance-ranking-v1", "combined-quality-v1", "combined-quality-thai-dominant-v1"]);
const ENHANCED_PROFILES = new Set(["reference-enhancement-v1", "combined-quality-v1", "combined-quality-thai-dominant-v1"]);
const WATERMARK_BITS = "1011001011010110";
const STAGES: Record<string, readonly string[]> = {
  "control-v1": [
    "speech_text_attestation", "reference_decode", "reference_resample_24000",
    "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank", "output_validate_pcm16",
  ],
  "reference-enhancement-v1": [
    "speech_text_attestation", "reference_decode", "demucs_reference_enhancement", "reference_peak_normalize",
    "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank",
    "output_validate_pcm16",
  ],
  "text-normalization-v1": [
    "speech_text_attestation", "reference_decode", "reference_resample_24000",
    "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank", "output_validate_pcm16",
  ],
  "guidance-ranking-v1": [
    "speech_text_attestation", "reference_decode", "reference_resample_24000",
    "omnivoice_prompt", "omnivoice_generate_three", "speaker_pitch_rank", "output_validate_pcm16",
  ],
  "watermark-v1": [
    "speech_text_attestation", "reference_decode", "reference_resample_24000",
    "omnivoice_prompt", "omnivoice_generate_three", "speaker_cosine_rank", "audioseal_resample_16000",
    "audioseal_embed", "audioseal_resample_24000", "audioseal_detect", "output_validate_pcm16",
  ],
  "combined-quality-v1": [
    "speech_text_attestation", "reference_decode", "demucs_reference_enhancement", "reference_peak_normalize",
    "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three", "speaker_pitch_rank",
    "output_validate_pcm16",
  ],
  "combined-quality-thai-dominant-v1": [
    "speech_text_attestation", "thai_dominant_segmentation", "reference_decode", "demucs_reference_enhancement",
    "reference_peak_normalize", "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three",
    "speaker_pitch_rank", "output_validate_pcm16",
  ],
};

const STAGE_IDENTITIES: Record<string, string> = {
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && [...expected].sort().every((key, index) => actual[index] === key);
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function strictBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 10_000_000
    || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

export function validatePcm16MonoWav(
  wav: Buffer,
  expected: { sampleRate: number; numSamples?: number },
): { numSamples: number; durationMs: number; pcm16Frames: Buffer } | null {
  if (wav.length < 44 || wav.length > MAX_OUTPUT_BYTES
    || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.readUInt32LE(4) + 8 !== wav.length) return null;
  let formatSeen = false;
  let pcm16Frames: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) return null;
    if (id === "fmt ") {
      if (formatSeen || pcm16Frames !== null || size !== 16 || wav.readUInt16LE(start) !== 1
        || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== expected.sampleRate
        || wav.readUInt32LE(start + 8) !== expected.sampleRate * 2
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) return null;
      formatSeen = true;
    } else if (id === "data") {
      if (!formatSeen || pcm16Frames !== null || size <= 0 || size % 2 !== 0) return null;
      pcm16Frames = wav.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (!formatSeen || pcm16Frames === null || offset !== wav.length) return null;
  const numSamples = pcm16Frames.length / 2;
  if (expected.numSamples !== undefined && expected.numSamples !== numSamples) return null;
  return { numSamples, durationMs: Math.round(numSamples * 1_000 / expected.sampleRate), pcm16Frames };
}

function validateStages(value: unknown, profile: string): value is Array<{ name: string; identity: string }> {
  const expected = STAGES[profile];
  if (!expected || !Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((stage, index) => isRecord(stage) && exactKeys(stage, ["name", "identity"])
    && stage.name === expected[index] && stage.identity === STAGE_IDENTITIES[expected[index]]);
}

function validateReferenceMetrics(
  value: unknown,
  profile: string,
  expected: CandidateV3ExpectedIdentity,
): boolean {
  if (!isRecord(value) || !exactKeys(value, REFERENCE_KEYS)) return false;
  const enhanced = ENHANCED_PROFILES.has(profile);
  if (![value.input_sha256, value.canonical_sha256, value.effective_sha256]
    .every((digest) => typeof digest === "string" && HEX64.test(digest))) return false;
  const prePeakMaximum = enhanced ? 64 : 1;
  if (value.input_sha256 !== expected.referenceSha256
    || !boundedInteger(value.input_samples_24000, MIN_REFERENCE_SAMPLES_24K, MAX_REFERENCE_SAMPLES_24K)
    || Math.abs((value.input_samples_24000 as number) - expected.referenceDurationSamples24000) > 2
    || !boundedInteger(value.effective_samples_24000, MIN_EFFECTIVE_REFERENCE_SAMPLES_24K, MAX_REFERENCE_SAMPLES_24K + 1)
    || value.enhanced !== enhanced
    || !finiteNumber(value.pre_peak, 0, prePeakMaximum) || !finiteNumber(value.post_peak, 0, 1)
    || (enhanced
      ? Math.abs((value.post_peak as number) - REFERENCE_PEAK_TARGET) > PCM16_LEVEL
      : Math.abs((value.post_peak as number) - (value.pre_peak as number)) > PCM16_LEVEL)
    || !finiteNumber(value.pre_rms, 0, prePeakMaximum) || (value.pre_rms as number) > (value.pre_peak as number)
    || !finiteNumber(value.post_rms, 0, 1) || (value.post_rms as number) > (value.post_peak as number)
    || !boundedInteger(value.pre_samples, MIN_REFERENCE_SAMPLES_24K, enhanced ? MAX_REFERENCE_SAMPLES_44K : MAX_REFERENCE_SAMPLES_24K)
    || !boundedInteger(value.post_samples, MIN_EFFECTIVE_REFERENCE_SAMPLES_24K, MAX_REFERENCE_SAMPLES_24K + 1)
    || !boundedInteger(value.pre_clipping_samples, 0, value.pre_samples as number)
    || !boundedInteger(value.post_clipping_samples, 0, value.post_samples as number)
    || value.post_clipping_samples !== 0
    || ((value.pre_peak as number) < 1
      ? value.pre_clipping_samples !== 0
      : value.pre_clipping_samples === 0)
    || value.post_samples !== value.effective_samples_24000) return false;
  if (enhanced) {
    return value.canonical_sha256 !== value.effective_sha256
      && Math.abs((value.input_samples_24000 as number) - (value.effective_samples_24000 as number)) <= 1
      && Math.abs((value.pre_samples as number)
        - Math.round((value.input_samples_24000 as number) * 44_100 / 24_000)) <= 8;
  }
  return value.canonical_sha256 === value.effective_sha256
    && value.input_samples_24000 === value.effective_samples_24000
    && value.pre_samples === value.input_samples_24000
    && value.post_samples === value.input_samples_24000;
}

function validateWatermark(
  value: unknown,
  numSamples: number,
  selectedCandidate: Record<string, unknown>,
  deliveredPcm16Sha256: string,
): boolean {
  if (!isRecord(value) || !exactKeys(value, WATERMARK_KEYS)
    || value.evidence_version !== WATERMARK_EVIDENCE_VERSION
    || value.message !== WATERMARK_BITS || value.alpha !== 1
    || value.detection_threshold !== 0.5 || value.message_threshold !== 0.5
    || !finiteNumber(value.detect_fraction, 0, 1) || (value.detect_fraction as number) <= 0.5
    || value.positive !== true || value.decoded_message !== WATERMARK_BITS
    || !Array.isArray(value.frame_probabilities) || value.frame_probabilities.length < 1
    || value.frame_probabilities.length > MAX_WATERMARK_FRAME_PROBABILITIES
    || !value.frame_probabilities.every((metric) => finiteNumber(metric, 0, 1))
    || !Array.isArray(value.bit_probabilities) || value.bit_probabilities.length !== 16
    || !value.bit_probabilities.every((metric) => finiteNumber(metric, 0, 1))
    || value.bit_error_rate !== 0
    || ![value.pre_embed_sha256, value.watermarked_16k_sha256, value.delivered_24k_sha256]
      .every((digest) => typeof digest === "string" && HEX64.test(digest))
    || value.selected_candidate_24k_sha256 !== selectedCandidate.audio_sha256
    || value.selected_candidate_24k_sha256_domain !== CANDIDATE_AUDIO_HASH_DOMAIN
    || value.pre_embed_sha256_domain !== WATERMARK_INTERNAL_HASH_DOMAIN
    || value.watermarked_16k_sha256_domain !== WATERMARK_INTERNAL_HASH_DOMAIN
    || value.delivered_24k_sha256_domain !== DELIVERED_AUDIO_HASH_DOMAIN
    || value.pre_embed_sha256 === value.watermarked_16k_sha256
    || value.delivered_24k_sha256 !== deliveredPcm16Sha256
    || !boundedInteger(value.samples_24k_selected, 1, MAX_OUTPUT_SAMPLES_24K)
    || !boundedInteger(value.samples_16k_pre_embed, 1, MAX_OUTPUT_SAMPLES_16K)
    || !boundedInteger(value.samples_16k_post_embed, 1, MAX_OUTPUT_SAMPLES_16K)
    || !boundedInteger(value.samples_24k_output, 1, MAX_OUTPUT_SAMPLES_24K)
    || value.samples_24k_selected !== selectedCandidate.samples_24k
    || value.samples_16k_pre_embed !== value.samples_16k_post_embed
    || value.samples_24k_output !== numSamples
    || value.samples_24k_output !== value.samples_24k_selected
    || value.samples_16k_pre_embed !== Math.ceil((value.samples_24k_selected as number) * 2 / 3)) return false;
  const observedFraction = value.frame_probabilities.filter((metric) => (metric as number) > 0.5).length
    / value.frame_probabilities.length;
  const decoded = value.bit_probabilities.map((metric) => (metric as number) >= 0.5 ? "1" : "0").join("");
  return Math.abs(observedFraction - (value.detect_fraction as number)) <= 1e-6 && decoded === WATERMARK_BITS;
}

function validateMetrics(
  value: unknown,
  profile: string,
  numSamples: number,
  expected: CandidateV3ExpectedIdentity,
  deliveredPcm16Sha256: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || !exactKeys(value, METRIC_KEYS)
    || !validateReferenceMetrics(value.reference, profile, expected)
    || !isRecord(value.generation) || !exactKeys(value.generation, GENERATION_KEYS)
    || value.generation.candidate_count !== 3
    || value.generation.class_temperature !== 0.8
    || value.generation.guidance !== (PITCH_PROFILES.has(profile) ? 2 : 2.5)
    || !Array.isArray(value.candidates) || value.candidates.length !== 3
    || !boundedInteger(value.selected_candidate_index, 0, 2)) return false;
  const pitchRanking = PITCH_PROFILES.has(profile);
  const formula = pitchRanking ? "speaker_cosine+0.15*pitch_similarity_normalized" : "speaker_cosine";
  if (value.ranking_formula !== formula) return false;
  const rankingScores: number[] = [];
  for (const [index, metric] of value.candidates.entries()) {
    if (!isRecord(metric) || !exactKeys(metric, CANDIDATE_METRIC_KEYS) || metric.index !== index
      || typeof metric.audio_sha256 !== "string" || !HEX64.test(metric.audio_sha256)
      || metric.audio_sha256_domain !== CANDIDATE_AUDIO_HASH_DOMAIN
      || !boundedInteger(metric.samples_24k, 1, MAX_OUTPUT_SAMPLES_24K)
      || !finiteNumber(metric.speaker_cosine, -1, 1)) return false;
    if (pitchRanking) {
      if (!finiteNumber(metric.pitch_similarity_normalized, 0, 1)) return false;
      const recomputed = (metric.speaker_cosine as number)
        + PITCH_WEIGHT * (metric.pitch_similarity_normalized as number);
      if (!finiteNumber(metric.ranking_score, -1, 1 + PITCH_WEIGHT) || metric.ranking_score !== recomputed) return false;
    } else if (metric.pitch_similarity_normalized !== null || metric.ranking_score !== metric.speaker_cosine) {
      return false;
    }
    rankingScores.push(metric.ranking_score as number);
  }
  let independentlySelected = 0;
  for (let index = 1; index < rankingScores.length; index += 1) {
    if (rankingScores[index] > rankingScores[independentlySelected]) independentlySelected = index;
  }
  if (value.selected_candidate_index !== independentlySelected) return false;
  return profile === "watermark-v1"
    ? validateWatermark(
        value.watermark,
        numSamples,
        value.candidates[value.selected_candidate_index as number] as Record<string, unknown>,
        deliveredPcm16Sha256,
      )
    : value.watermark === null;
}

export function validateCandidateV3Response(
  value: unknown,
  expected: CandidateV3ExpectedIdentity,
): CloneResponseValidation<CandidateV3Success> {
  if (!isRecord(value) || !exactKeys(value, CANDIDATE_KEYS)) return { ok: false, failure: "output" };
  const identityMatches = value.ok === true && value.contract_version === 3 && value.mode === "clone"
    && value.worker_kind === "clone-only" && value.worker_version === CANDIDATE_WORKER_VERSION
    && value.worker_version === expected.workerVersion
    && typeof value.image_digest === "string" && value.image_digest.startsWith("sha256:")
    && HEX64.test(value.image_digest.slice(7)) && value.image_digest === expected.imageDigest
    && value.source_revision === HERO_VOICE_CLONE_SOURCE_REVISION
    && value.source_revision === expected.sourceRevision
    && typeof value.model_manifest_sha256 === "string" && HEX64.test(value.model_manifest_sha256)
    && value.model_manifest_sha256 === expected.modelManifestSha256
    && value.experiment_profile === expected.experimentProfile
    && typeof value.normalizer_version === "string" && SAFE_VERSION.test(value.normalizer_version)
    && value.normalizer_version === expected.normalizerVersion && value.mixed_language === true
    && typeof value.request_commitment_sha256 === "string" && HEX64.test(value.request_commitment_sha256)
    && value.request_commitment_sha256 === expected.requestCommitmentSha256
    && typeof value.matched_settings_sha256 === "string" && HEX64.test(value.matched_settings_sha256)
    && value.matched_settings_sha256 === expected.matchedSettingsSha256;
  if (!identityMatches) return { ok: false, failure: "identity" };
  if (value.format !== "wav" || value.sample_rate !== 24_000 || value.channels !== 1 || value.subtype !== "PCM_16"
    || !boundedInteger(value.num_samples, 1, MAX_OUTPUT_SAMPLES_24K)
    || !boundedInteger(value.duration_ms, 1, MAX_PIPELINE_TIMING_MS)
    || value.duration_ms !== Math.round((value.num_samples as number) * 1_000 / 24_000)
    || !validateStages(value.stages, expected.experimentProfile)
    || !isRecord(value.timing_ms) || !exactKeys(value.timing_ms, TIMING_KEYS)
    || !Object.values(value.timing_ms).every((metric) => boundedInteger(metric, 0, MAX_PIPELINE_TIMING_MS))) {
    return { ok: false, failure: "output" };
  }
  const audio = strictBase64(value.audio_base64);
  if (!audio) return { ok: false, failure: "output" };
  const wav = validatePcm16MonoWav(audio, { sampleRate: 24_000, numSamples: value.num_samples as number });
  if (!wav || wav.durationMs !== value.duration_ms
    || !validateMetrics(
      value.metrics,
      expected.experimentProfile,
      value.num_samples as number,
      expected,
      sha256Hex(wav.pcm16Frames),
    )) return { ok: false, failure: "output" };
  return {
    ok: true,
    response: value as unknown as CandidateV3Success,
    audio,
    numSamples: wav.numSamples,
  };
}

export function validateBaselineV13DirectResponse(value: unknown): CloneResponseValidation<BaselineV13Success> {
  if (!isRecord(value) || !exactKeys(value, BASELINE_KEYS)
    || value.contract_version !== 2 || value.mode !== "clone"
    || value.worker_version !== BASELINE_V13_WORKER_VERSION
    || value.catalog_version !== BASELINE_V13_CATALOG_VERSION
    || typeof value.similarity_score !== "number" || !Number.isFinite(value.similarity_score)
    || value.similarity_score < -1 || value.similarity_score > 1
    || value.format !== "wav" || value.sample_rate !== 24_000
    || !finiteNumber(value.duration, 1 / 24_000, MAX_OUTPUT_SAMPLES_24K / 24_000)
    || !finiteNumber(value.generation_time, 0, 540)) {
    return { ok: false, failure: "identity" };
  }
  const audio = strictBase64(value.audio_base64);
  if (!audio) return { ok: false, failure: "output" };
  const wav = validatePcm16MonoWav(audio, { sampleRate: value.sample_rate });
  if (!wav || Math.abs(wav.numSamples / value.sample_rate - value.duration) > (1 / value.sample_rate)) {
    return { ok: false, failure: "output" };
  }
  return { ok: true, response: value as unknown as BaselineV13Success, audio, numSamples: wav.numSamples };
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function runnerUsesApplicationResolver(runner: HeroVoiceCloneRunner): runner is CandidateAiStudioV3 {
  return runner.runnerKind === "CandidateAiStudioV3";
}
