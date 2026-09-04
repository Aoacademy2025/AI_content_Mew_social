import { createHmac, timingSafeEqual } from "node:crypto";

import {
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import {
  HERO_VOICE_CANARY_NORMALIZER_SOURCE_REVISION,
  HERO_VOICE_CANARY_NORMALIZER_VERSION,
  HERO_VOICE_CANARY_SCRIPTS,
  type HeroVoiceCanaryManifest,
  type HeroVoiceCanarySlot,
} from "@/lib/hero-voice-canary-manifest";

const HEX64 = /^[0-9a-f]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{3,159}$/u;
const DEMUCS_SOURCE_COMMIT = "e976d93ecc3865e5757426930257e200846a520a";
const DEMUCS_SIGNATURE = "955717e8";
const DEMUCS_CHECKPOINT_SHA256 = "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4";
const AUDIOSEAL_VERSION = "0.2.0";
const AUDIOSEAL_SOURCE_COMMIT = "e63a8a0e5cdf7bb797159c92ba15961557fe9bd2";
const AUDIOSEAL_MODEL_REVISION = "3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba";
const AUDIOSEAL_GENERATOR_SHA256 = "7a845b5fbe9364a63a3909d8ab3fe064d13a76ae4c2e983573e08c69b7b51748";
const AUDIOSEAL_DETECTOR_SHA256 = "8a78e8a83584113523e161fc599fcab10fd0e94c04d2eb9d2fa1e9ec91ab69d9";
const AUDIOSEAL_MESSAGE = "1011001011010110";
const SOURCE_MANIFEST_SHA256 = "178ffa75b54963a18bec2cb2307e220a0d8bb808a7ce7ca63418ec3c54d7e45d";
const MODEL_MANIFEST_SHA256 = "ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb";
const FINAL_COMBINED_STAGES = Object.freeze([
  "speech_text_attestation", "reference_decode", "demucs_reference_enhancement", "reference_peak_normalize",
  "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three", "speaker_pitch_rank",
  "output_validate_pcm16",
]);
const NORMALIZER_GOLDENS = Object.freeze([
  Object.freeze({ input: "OpenAI", output: "โอเพนเอไอ" }),
  Object.freeze({ input: "Gemini", output: "เจมิไน" }),
  Object.freeze({ input: "RunPod", output: "รันพ็อด" }),
]);

export type HeroVoiceCanaryObjectiveEvidencePhase = "ablation-8" | "final-36";

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function objectiveKey(): Buffer {
  const encoded = process.env.HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error("canary_objective_evidence_key_invalid");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("canary_objective_evidence_key_invalid");
  return key;
}

function evidenceMac(bytes: Buffer, key = objectiveKey()): string {
  return createHmac("sha256", key)
    .update("hero-voice-canary/v1/objective-evidence\0", "utf8")
    .update(bytes)
    .digest("hex");
}

function exactAuthenticatedEnvelope(input: {
  bytes: Uint8Array;
  expectedSha256: string;
  hmac: string;
  phase: HeroVoiceCanaryObjectiveEvidencePhase;
  authority?: HeroVoiceCanaryObjectiveEvidenceAuthority;
}): Record<string, unknown> {
  const bytes = Buffer.from(input.bytes);
  if (!HEX64.test(input.expectedSha256)
    || heroVoiceCanarySha256(bytes) !== input.expectedSha256 || !HEX64.test(input.hmac)) {
    throw new Error("canary_objective_evidence_identity_invalid");
  }
  const expectedMac = input.authority
    ? input.authority.authenticate(bytes)
    : evidenceMac(bytes);
  if (!timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(input.hmac, "hex"))) {
    throw new Error("canary_objective_evidence_auth_invalid");
  }
  const parsed = parseHeroVoiceCanaryStrictJson(bytes);
  if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes)
    || !exactKeys(parsed, ["authority", "issuedAtMs", "manifestSha256", "phase", "rows", "runId", "version"])
    || parsed.version !== 1 || parsed.phase !== input.phase
    || parsed.authority !== "task6-independent-evidence-v1"
    || typeof parsed.runId !== "string" || !OPAQUE.test(parsed.runId)
    || typeof parsed.manifestSha256 !== "string" || !HEX64.test(parsed.manifestSha256)
    || !Number.isSafeInteger(parsed.issuedAtMs) || (parsed.issuedAtMs as number) <= 0) {
    throw new Error("canary_objective_evidence_schema_invalid");
  }
  return parsed;
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new Error("canary_objective_evidence_schema_invalid");
}

/** Digest of the exact immutable response identity a provider result must
 * attest. The evidence authority hashes the actual validated response fields;
 * this verifier independently derives the expected digest from the manifest. */
export function expectedHeroVoiceCanaryResponseIdentitySha256(slot: HeroVoiceCanarySlot): string {
  return heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
    version: 1,
    runnerKind: slot.runnerKind,
    endpointId: slot.endpointId,
    templateId: slot.templateId,
    imageDigest: slot.imageDigest,
    sourceRevision: slot.sourceRevision,
    modelManifestSha256: slot.modelManifestSha256,
    contractVersion: slot.arm.contractVersion,
    expectedWorkerVersion: slot.expectedWorkerVersion,
    expectedCatalogVersion: slot.expectedCatalogVersion,
    profile: slot.arm.profile,
    normalizerVersion: slot.arm.contractVersion === 3 ? slot.normalizerVersion : null,
    requestCommitmentSha256: slot.requestCommitmentSha256,
    matchedSettingsSha256: slot.matchedSettingsSha256,
  }));
}

export function verifyHeroVoiceCanaryObjectiveEvidence(input: {
  bytes: Uint8Array;
  expectedSha256: string;
  hmac: string;
  phase: HeroVoiceCanaryObjectiveEvidencePhase;
  runId: string;
  manifestSha256: string;
  manifest: HeroVoiceCanaryManifest;
  audioBySlot: ReadonlyMap<string, string>;
  providerJobIdBySlot: ReadonlyMap<string, string>;
  authority?: HeroVoiceCanaryObjectiveEvidenceAuthority;
}): Readonly<{ evidenceSha256: string; evidenceHmac: string }> {
  const parsed = exactAuthenticatedEnvelope(input);
  if (parsed.runId !== input.runId || parsed.manifestSha256 !== input.manifestSha256) {
    throw new Error("canary_objective_evidence_binding_invalid");
  }
  if (input.manifest.identities.candidate.sourceRevision !== "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb"
    || input.manifest.identities.candidate.modelManifestSha256 !== MODEL_MANIFEST_SHA256) {
    throw new Error("canary_objective_evidence_binding_invalid");
  }
  if (!exactKeys(parsed.rows, input.phase === "ablation-8"
    ? ["demucs", "normalizer", "ranking", "watermark"]
    : ["items", "park", "stageAttestationSha256"])) {
    throw new Error("canary_objective_evidence_schema_invalid");
  }
  if (input.phase === "ablation-8") {
    const demucs = parsed.rows.demucs;
    if (!exactKeys(demucs, ["checkpointSha256", "controlDurationSamples24000", "controlReferenceSha256", "inputReferenceSha256", "outputAudioSha256", "overlapMicros", "profile", "segmentMillis", "shifts", "signature", "slotId", "sourceCommit", "split", "treatmentDurationSamples24000", "treatmentReferenceSha256", "vocalsStemSha256"])
      || demucs.slotId !== "ablation.reference-enhancement.delta.script-01"
      || demucs.profile !== "reference-enhancement-v1"
      || demucs.sourceCommit !== DEMUCS_SOURCE_COMMIT || demucs.signature !== DEMUCS_SIGNATURE
      || demucs.checkpointSha256 !== DEMUCS_CHECKPOINT_SHA256 || demucs.shifts !== 0
      || demucs.split !== true || demucs.overlapMicros !== 250_000 || demucs.segmentMillis !== 7_000
      || demucs.outputAudioSha256 !== input.audioBySlot.get(String(demucs.slotId))
      || demucs.inputReferenceSha256 !== input.manifest.referenceSha256) throw new Error("canary_objective_demucs_invalid");
    for (const key of ["controlReferenceSha256", "checkpointSha256", "treatmentReferenceSha256", "vocalsStemSha256", "outputAudioSha256"] as const) assertHash(demucs[key]);
    if (demucs.treatmentReferenceSha256 === input.manifest.referenceSha256
      || demucs.treatmentReferenceSha256 === demucs.controlReferenceSha256
      || demucs.vocalsStemSha256 === heroVoiceCanarySha256(Buffer.alloc(0))
      || !Number.isSafeInteger(demucs.controlDurationSamples24000)
      || !Number.isSafeInteger(demucs.treatmentDurationSamples24000)
      || demucs.controlDurationSamples24000 !== 240_000
      || Math.abs(Number(demucs.controlDurationSamples24000) - Number(demucs.treatmentDurationSamples24000)) > 1) {
      throw new Error("canary_objective_demucs_invalid");
    }
    const normalizer = parsed.rows.normalizer;
    const script = HERO_VOICE_CANARY_SCRIPTS[2];
    if (!exactKeys(normalizer, ["goldens", "normalizerName", "normalizerSourceRevision", "normalizerVersion", "normalizedText", "normalizedTextSha256", "slotId", "sourceText", "sourceTextSha256"])
      || normalizer.slotId !== "ablation.text-normalization.delta.script-03"
      || normalizer.normalizerName !== script.normalizerName
      || normalizer.sourceText !== script.sourceText || normalizer.normalizedText !== script.speechText
      || normalizer.sourceTextSha256 !== script.sourceTextSha256
      || normalizer.normalizedTextSha256 !== script.speechTextSha256
      || normalizer.normalizedTextSha256 === normalizer.sourceTextSha256
      || normalizer.normalizerVersion !== HERO_VOICE_CANARY_NORMALIZER_VERSION
      || normalizer.normalizerSourceRevision !== HERO_VOICE_CANARY_NORMALIZER_SOURCE_REVISION
      || !heroVoiceCanaryJcsBytes(normalizer.goldens).equals(heroVoiceCanaryJcsBytes(NORMALIZER_GOLDENS))) {
      throw new Error("canary_objective_normalizer_invalid");
    }
    const ranking = parsed.rows.ranking;
    const rankingSlot = input.manifest.slots.find((slot) => slot.slotId === "ablation.guidance-ranking.delta.script-05");
    if (!rankingSlot || !exactKeys(ranking, ["candidates", "formula", "outputAudioSha256", "profile", "selectedAudioSha256", "selectedIndex", "slotId"])
      || ranking.slotId !== rankingSlot.slotId || ranking.profile !== rankingSlot.arm.profile
      || ranking.formula !== "speaker_cosine+0.15*pitch_similarity_normalized"
      || ranking.outputAudioSha256 !== input.audioBySlot.get(rankingSlot.slotId)
      || !Array.isArray(ranking.candidates) || ranking.candidates.length !== 3
      || ranking.candidates.some((candidate, index) => !exactKeys(candidate, ["audioSha256", "index", "pitchSimilarityMicros", "scoreMicros", "speakerCosineMicros"])
        || candidate.index !== index || !HEX64.test(String(candidate.audioSha256))
        || !Number.isSafeInteger(candidate.speakerCosineMicros) || Number(candidate.speakerCosineMicros) < -1_000_000 || Number(candidate.speakerCosineMicros) > 1_000_000
        || !Number.isSafeInteger(candidate.pitchSimilarityMicros) || Number(candidate.pitchSimilarityMicros) < 0 || Number(candidate.pitchSimilarityMicros) > 1_000_000
        || candidate.scoreMicros !== Number(candidate.speakerCosineMicros) + Math.round(Number(candidate.pitchSimilarityMicros) * 0.15))
      || !Number.isSafeInteger(ranking.selectedIndex) || (ranking.selectedIndex as number) < 0 || (ranking.selectedIndex as number) > 2
      || ranking.selectedIndex !== ranking.candidates.map((candidate) => candidate.scoreMicros)
        .indexOf(Math.max(...ranking.candidates.map((candidate) => Number(candidate.scoreMicros))))
      || ranking.selectedAudioSha256 !== ranking.candidates[ranking.selectedIndex as number].audioSha256
      || ranking.selectedAudioSha256 !== input.audioBySlot.get(rankingSlot.slotId)) {
      throw new Error("canary_objective_ranking_invalid");
    }
    const watermark = parsed.rows.watermark;
    if (!exactKeys(watermark, ["alphaMicros", "controlAudioSha256", "controlDetectFractionMicros", "controlDetectorPositive", "controlSlotId", "deliveredSamples24000", "detectorSha256", "detectionThresholdMicros", "generatorSha256", "message", "messageThresholdMicros", "modelRevision", "preEmbedSamples24000", "profile", "sourceCommit", "treatmentAudioSha256", "treatmentDetectFractionMicros", "treatmentDetectorPositive", "treatmentSlotId", "version"])
      || watermark.controlSlotId !== "ablation.watermark.control.script-04"
      || watermark.treatmentSlotId !== "ablation.watermark.delta.script-04"
      || watermark.profile !== "watermark-v1" || watermark.version !== AUDIOSEAL_VERSION
      || watermark.sourceCommit !== AUDIOSEAL_SOURCE_COMMIT || watermark.modelRevision !== AUDIOSEAL_MODEL_REVISION
      || watermark.generatorSha256 !== AUDIOSEAL_GENERATOR_SHA256 || watermark.detectorSha256 !== AUDIOSEAL_DETECTOR_SHA256
      || watermark.message !== AUDIOSEAL_MESSAGE || watermark.alphaMicros !== 1_000_000
      || watermark.detectionThresholdMicros !== 500_000 || watermark.messageThresholdMicros !== 500_000
      || watermark.controlAudioSha256 !== input.audioBySlot.get(String(watermark.controlSlotId))
      || watermark.treatmentAudioSha256 !== input.audioBySlot.get(String(watermark.treatmentSlotId))
      || !Number.isSafeInteger(watermark.controlDetectFractionMicros) || Number(watermark.controlDetectFractionMicros) < 0 || Number(watermark.controlDetectFractionMicros) > 500_000
      || !Number.isSafeInteger(watermark.treatmentDetectFractionMicros) || Number(watermark.treatmentDetectFractionMicros) <= 500_000 || Number(watermark.treatmentDetectFractionMicros) > 1_000_000
      || watermark.controlDetectorPositive !== false || watermark.treatmentDetectorPositive !== true
      || !Number.isSafeInteger(watermark.preEmbedSamples24000) || Number(watermark.preEmbedSamples24000) < 1
      || !Number.isSafeInteger(watermark.deliveredSamples24000)
      || Math.abs(Number(watermark.preEmbedSamples24000) - Number(watermark.deliveredSamples24000)) > 1) {
      throw new Error("canary_objective_watermark_invalid");
    }
  } else {
    const items = parsed.rows.items;
    const finalSlots = input.manifest.slots.filter((slot) => slot.phase !== "ablation");
    if (!Array.isArray(items) || items.length !== 36 || new Set(items.map((item) => (
      item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).slotId : null
    ))).size !== 36) throw new Error("canary_objective_final_invalid");
    for (const item of items) {
      const slot = finalSlots.find((candidate) => candidate.slotId === item.slotId);
      const expectedStages = slot?.runnerKind === "CandidateAiStudioV3" ? FINAL_COMBINED_STAGES : null;
      if (!exactKeys(item, ["audioSha256", "contractVersion", "detectFractionMicros", "detectionThresholdMicros", "detectorEvidenceSha256", "detectorModelRevision", "detectorModelSha256", "detectorResult", "detectorSourceCommit", "detectorVersion", "endpointId", "expectedCatalogVersion", "expectedWorkerVersion", "imageDigest", "matchedSettingsSha256", "modelManifestSha256", "normalizerVersion", "outputChannels", "outputRate", "outputSubtype", "profile", "providerJobId", "requestCommitmentSha256", "responseEnvelopeSha256", "responseIdentitySha256", "runnerKind", "slotId", "sourceRevision", "stages", "templateId"])
        || !slot
        || item.audioSha256 !== input.audioBySlot.get(String(item.slotId))
        || item.providerJobId !== input.providerJobIdBySlot.get(String(item.slotId))
        || item.runnerKind !== slot.runnerKind || item.endpointId !== slot.endpointId || item.templateId !== slot.templateId
        || item.imageDigest !== slot.imageDigest || item.sourceRevision !== slot.sourceRevision
        || item.modelManifestSha256 !== slot.modelManifestSha256 || item.contractVersion !== slot.arm.contractVersion
        || item.expectedWorkerVersion !== slot.expectedWorkerVersion || item.expectedCatalogVersion !== slot.expectedCatalogVersion
        || item.profile !== slot.arm.profile || item.normalizerVersion !== slot.normalizerVersion
        || item.requestCommitmentSha256 !== slot.requestCommitmentSha256
        || item.matchedSettingsSha256 !== slot.matchedSettingsSha256
        || !heroVoiceCanaryJcsBytes(item.stages).equals(heroVoiceCanaryJcsBytes(expectedStages))
        || item.detectorResult !== "negative" || item.detectorVersion !== AUDIOSEAL_VERSION
        || item.detectorSourceCommit !== AUDIOSEAL_SOURCE_COMMIT
        || item.detectorModelRevision !== AUDIOSEAL_MODEL_REVISION
        || item.detectorModelSha256 !== AUDIOSEAL_DETECTOR_SHA256
        || item.detectionThresholdMicros !== 500_000
        || !Number.isSafeInteger(item.detectFractionMicros) || Number(item.detectFractionMicros) < 0
        || Number(item.detectFractionMicros) > 500_000 || item.outputChannels !== 1
        || item.outputRate !== 24_000 || item.outputSubtype !== "PCM_16"
        || item.responseIdentitySha256 !== expectedHeroVoiceCanaryResponseIdentitySha256(slot)) {
        throw new Error("canary_objective_final_invalid");
      }
      assertHash(item.audioSha256); assertHash(item.detectorEvidenceSha256); assertHash(item.responseIdentitySha256);
      assertHash(item.responseEnvelopeSha256);
    }
    if (new Set(items.map((item) => item.responseEnvelopeSha256)).size !== 36
      || new Set(items.map((item) => item.detectorEvidenceSha256)).size !== 36) {
      throw new Error("canary_objective_final_invalid");
    }
    if (!exactKeys(parsed.rows.park, ["disposition", "endpointId", "imageDigest", "observedState", "readbackSha256", "templateId"])
      || parsed.rows.park.disposition !== "confirmed" || parsed.rows.park.observedState !== "parked"
      || parsed.rows.park.endpointId !== input.manifest.identities.candidate.endpointId
      || parsed.rows.park.templateId !== input.manifest.identities.candidate.templateId
      || parsed.rows.park.imageDigest !== input.manifest.identities.candidate.imageDigest
      || parsed.rows.stageAttestationSha256 !== heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
        sourceManifestSha256: SOURCE_MANIFEST_SHA256,
        modelManifestSha256: MODEL_MANIFEST_SHA256,
        combinedStages: FINAL_COMBINED_STAGES,
      }))) throw new Error("canary_objective_park_invalid");
    assertHash(parsed.rows.park.readbackSha256); assertHash(parsed.rows.stageAttestationSha256);
  }
  return Object.freeze({ evidenceSha256: input.expectedSha256, evidenceHmac: input.hmac });
}

/** Captured before the untrusted Task 7 adapter process starts. The key never
 * enters adapter environment or IPC; later environment mutation cannot change
 * the authority used for this run. */
export type HeroVoiceCanaryObjectiveEvidenceAuthority = Readonly<{
  authenticate(bytes: Uint8Array): string;
}>;

export function captureHeroVoiceCanaryObjectiveEvidenceAuthority(): HeroVoiceCanaryObjectiveEvidenceAuthority {
  const key = Buffer.from(objectiveKey());
  return Object.freeze({
    authenticate(bytes: Uint8Array): string {
      return evidenceMac(Buffer.from(bytes), key);
    },
  });
}

export function buildHeroVoiceCanaryObjectiveEvidence(input: {
  phase: HeroVoiceCanaryObjectiveEvidencePhase;
  runId: string;
  manifestSha256: string;
  rows: unknown;
  issuedAtMs: number;
  authority: HeroVoiceCanaryObjectiveEvidenceAuthority;
}): Readonly<{ bytes: Buffer; sha256: string; hmac: string }> {
  if (!Number.isSafeInteger(input.issuedAtMs) || input.issuedAtMs <= 0) {
    throw new Error("canary_objective_observation_invalid");
  }
  const bytes = heroVoiceCanaryJcsBytes({
    authority: "task6-independent-evidence-v1",
    issuedAtMs: input.issuedAtMs,
    manifestSha256: input.manifestSha256,
    phase: input.phase,
    rows: input.rows,
    runId: input.runId,
    version: 1,
  });
  return Object.freeze({
    bytes,
    sha256: heroVoiceCanarySha256(bytes),
    hmac: input.authority.authenticate(bytes),
  });
}

/** Test/evidence-authority helper; never exposed by HTTP. */
export function signHeroVoiceCanaryObjectiveEvidenceForTests(bytes: Uint8Array): string {
  if (process.env.NODE_ENV === "production") throw new Error("objective evidence signer unavailable");
  return evidenceMac(Buffer.from(bytes));
}
