import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  consumeHeroVoiceCanaryAdmissionInTransaction,
  issueHeroVoiceCanarySubmitCapability,
} from "../src/lib/hero-voice-canary-admission.server";
import {
  authenticateHeroVoiceCanaryAuthState,
  bootstrapHeroVoiceCanaryUser,
  HeroVoiceCanaryAuthError,
  resolveHeroVoiceCanarySessionUser,
} from "../src/lib/hero-voice-canary-auth.server";
import {
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "../src/lib/hero-voice-canary-canonical";
import {
  commitHeroVoiceCanaryDispatchIntent,
  createHeroVoiceCanaryRun,
  finalizeHeroVoiceCanaryRun,
  heroVoiceCanaryCounters,
  reconcileHeroVoiceCanaryRun,
  recordHeroVoiceCanaryCerBatch,
  recordHeroVoiceCanaryObjectiveObservation,
  recordHeroVoiceCanaryResult,
  recordHeroVoiceCanarySubmission,
  setHeroVoiceCanaryLedgerCrashObserverForTests,
  signHeroVoiceCanaryTask6EvidenceForTests,
  verifyHeroVoiceCanaryLedger,
} from "../src/lib/hero-voice-canary-ledger.server";
import {
  buildHeroVoiceCanaryManifest,
  HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  parseHeroVoiceCanaryManifest,
} from "../src/lib/hero-voice-canary-manifest";
import {
  closeHeroVoiceCanaryReview,
  createHeroVoiceCanaryBlindReview,
  assertHeroVoiceCanaryReviewWav,
  getHeroVoiceCanaryReview,
  GitHubGitCommitmentAuthority,
  type GitHubCommitmentRemote,
  HeroVoiceCanaryReviewError,
  LocalBareGitCommitmentAuthority,
  lockHeroVoiceCanaryReview,
  parseHeroVoiceCanaryScore,
  putHeroVoiceCanaryScore,
  readHeroVoiceCanaryReviewAudio,
  revealHeroVoiceCanaryReview,
} from "../src/lib/hero-voice-canary-review.server";
import { loadHeroVoiceCanaryReference } from "../src/lib/hero-voice-canary-reference.server";
import {
  captureHeroVoiceCanaryObjectiveEvidenceAuthority,
  expectedHeroVoiceCanaryResponseIdentitySha256,
  signHeroVoiceCanaryObjectiveEvidenceForTests,
  verifyHeroVoiceCanaryObjectiveEvidence,
} from "../src/lib/hero-voice-canary-objective-evidence.server";
import { prepareHeroVoiceCanaryWireRequest } from "../src/lib/hero-voice-canary-wire";
import {
  runHeroVoiceCanaryApply,
  submitHeroVoiceCanaryCandidateViaLoopback,
} from "../src/lib/hero-voice-canary-runner.server";
import { submitHeroVoiceCanarySlotRequest } from "../src/lib/hero-voice-canary-submit.server";
import { readHeroVoiceCanaryRunOutput } from "../src/lib/hero-voice-canary-run-outputs.server";
import {
  HERO_VOICE_CANARY_DATABASE_MARKER_KEY,
  HERO_VOICE_CANARY_DATABASE_MARKER_VALUE,
  setHeroVoiceCanaryFileOperationObserverForTests,
} from "../src/lib/hero-voice-canary-storage.server";
import {
  HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS,
  HeroVoiceCanaryTask7AdapterProcess,
  heroVoiceCanaryTask7AdapterEnvironment,
} from "../src/lib/hero-voice-canary-task7-adapter-process.server";
import {
  HeroVoiceDeletionSimulatedCrash,
  initializeHeroVoiceDeletionCoordinator,
  reconcileHeroVoiceDeletionTransactions,
  setHeroVoiceDeletionCrashObserverForTests,
} from "../src/lib/hero-voice-deletion-coordinator.server";
import { prisma } from "../src/lib/prisma";

const reference = Buffer.from("RIFF-synthetic-reference-WAVE", "utf8");
let ownerHmac = process.env.HERO_VOICE_CANARY_TEST_OWNER_HMAC ?? "";

function syntheticWav(index: number): Buffer {
  const pcm = Buffer.alloc(48, index & 0xff);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function canonicalReferenceWav(fill = 0): Buffer {
  const pcm = Buffer.alloc(480_000, fill);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

function candidateTerminalEnvelope(input: {
  request: Record<string, unknown>;
  slot: ReturnType<typeof built>["manifest"]["slots"][number];
  wav: Buffer;
}) {
  const pcmSamples = (input.wav.length - 44) / 2;
  const stages = [
    ["speech_text_attestation", "application-speech-text/no-worker-rewrite-v1"],
    ["reference_decode", "riff-wave/mono-24000-pcm16-v1"],
    ["demucs_reference_enhancement", "demucs/e976d93ecc3865e5757426930257e200846a520a/955717e8/shifts-0_split-true_overlap-0.25_segment-7/vocals-mean-mono"],
    ["reference_peak_normalize", "float32/peak-0.95-v1"],
    ["reference_resample_24000", "scipy-resample-poly/mono-24000-v1"],
    ["omnivoice_prompt", "omnivoice/346bb75330980a236540d61a0808d00767c0973b/zero-shot-clone-prompt"],
    ["omnivoice_generate_three", "omnivoice/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/best-of-3/temperature-0.8/seed-sequence-v1"],
    ["speaker_pitch_rank", "resemblyzer+librosa.pyin-C2-C6/cosine+0.15*pitch-v1"],
    ["output_validate_pcm16", "wave/mono-24000-pcm16/max-7000000-v1"],
  ].map(([name, identity]) => ({ name, identity }));
  return {
    ok: true,
    contract_version: 3,
    mode: "clone",
    worker_kind: "clone-only",
    worker_version: input.slot.expectedWorkerVersion,
    image_digest: input.slot.imageDigest,
    source_revision: input.slot.sourceRevision,
    model_manifest_sha256: input.slot.modelManifestSha256,
    experiment_profile: input.slot.arm.profile,
    normalizer_version: input.slot.normalizerVersion,
    mixed_language: true,
    request_commitment_sha256: input.request.request_commitment_sha256,
    matched_settings_sha256: input.request.matched_settings_sha256,
    audio_base64: input.wav.toString("base64"),
    format: "wav",
    sample_rate: 24_000,
    channels: 1,
    subtype: "PCM_16",
    num_samples: pcmSamples,
    duration_ms: Math.round(pcmSamples * 1_000 / 24_000),
    stages,
    metrics: {
      reference: {
        input_sha256: heroVoiceCanarySha256(Buffer.from(String(input.request.ref_audio_b64), "base64")),
        canonical_sha256: "a".repeat(64),
        effective_sha256: "b".repeat(64),
        input_samples_24000: 240_000,
        effective_samples_24000: 240_000,
        enhanced: true,
        pre_peak: 0.8,
        post_peak: 0.95,
        pre_rms: 0.2,
        post_rms: 0.18,
        pre_samples: 441_000,
        post_samples: 240_000,
        pre_clipping_samples: 0,
        post_clipping_samples: 0,
      },
      generation: { candidate_count: 3, guidance: 2, class_temperature: 0.8 },
      candidates: [
        { index: 0, audio_sha256: "c".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: pcmSamples, speaker_cosine: 0.8, pitch_similarity_normalized: 0.5, ranking_score: 0.875 },
        { index: 1, audio_sha256: "d".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: pcmSamples, speaker_cosine: 0.7, pitch_similarity_normalized: 0.9, ranking_score: 0.835 },
        { index: 2, audio_sha256: "e".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: pcmSamples, speaker_cosine: 0.6, pitch_similarity_normalized: 0.2, ranking_score: 0.63 },
      ],
      selected_candidate_index: 0,
      ranking_formula: "speaker_cosine+0.15*pitch_similarity_normalized",
      watermark: null,
    },
    timing_ms: { reference: 1, prompt: 1, synthesis: 1, ranking: 1, watermark: 0, encode: 1, total: 5 },
  };
}

function syntheticEvaluatorEvidence(batchKind: "ablation-8" | "final-36") {
  const fixtureHash = "1".repeat(64);
  return {
    version: 1 as const,
    batchKind,
    evaluatorBatchId: `synthetic-${batchKind}`,
    runtimeFingerprintSha256: "2".repeat(64),
    evaluatorImageDigest: `sha256:${"4".repeat(64)}`,
    modelSha256: "5".repeat(64),
    ffmpegBinarySha256: "6".repeat(64),
    dependencyLockSha256: "7".repeat(64),
    inventorySha256: "3".repeat(64),
    fixtureTranscriptCerSha256: fixtureHash,
    preFixtureProcessHashes: [fixtureHash, fixtureHash, fixtureHash] as const,
    postFixtureProcessHashes: [fixtureHash, fixtureHash, fixtureHash] as const,
    platform: "linux/arm64" as const,
    emulated: false as const,
    networkDisabled: true as const,
    inventoryCount: batchKind === "ablation-8" ? 8 as const : 36 as const,
  };
}

function syntheticObjectiveEvidence(
  batchKind: "ablation-8" | "final-36",
  run: ReturnType<typeof built> & { runId: string },
  outputBySlot: ReadonlyMap<string, Buffer>,
) {
  const audio = (slotId: string) => heroVoiceCanarySha256(outputBySlot.get(slotId)!);
  const script = run.manifest.scripts[2];
  const rows = batchKind === "ablation-8" ? {
    demucs: {
      checkpointSha256: "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
      controlDurationSamples24000: 240_000,
      controlReferenceSha256: "a".repeat(64),
      inputReferenceSha256: run.manifest.referenceSha256,
      outputAudioSha256: audio("ablation.reference-enhancement.delta.script-01"),
      overlapMicros: 250_000,
      profile: "reference-enhancement-v1",
      segmentMillis: 7_000,
      shifts: 0,
      signature: "955717e8",
      slotId: "ablation.reference-enhancement.delta.script-01",
      sourceCommit: "e976d93ecc3865e5757426930257e200846a520a",
      split: true,
      treatmentDurationSamples24000: 240_001,
      treatmentReferenceSha256: "c".repeat(64),
      vocalsStemSha256: "d".repeat(64),
    },
    normalizer: {
      goldens: [
        { input: "OpenAI", output: "โอเพนเอไอ" },
        { input: "Gemini", output: "เจมิไน" },
        { input: "RunPod", output: "รันพ็อด" },
      ],
      normalizerName: script.normalizerName,
      normalizerSourceRevision: script.normalizerSourceRevision,
      normalizerVersion: script.normalizerVersion,
      normalizedText: script.speechText,
      normalizedTextSha256: script.speechTextSha256,
      slotId: "ablation.text-normalization.delta.script-03",
      sourceText: script.sourceText,
      sourceTextSha256: script.sourceTextSha256,
    },
    ranking: {
      candidates: [
        { audioSha256: audio("ablation.guidance-ranking.delta.script-05"), index: 0, pitchSimilarityMicros: 600_000, scoreMicros: 890_000, speakerCosineMicros: 800_000 },
        { audioSha256: "1".repeat(64), index: 1, pitchSimilarityMicros: 500_000, scoreMicros: 775_000, speakerCosineMicros: 700_000 },
        { audioSha256: "2".repeat(64), index: 2, pitchSimilarityMicros: 400_000, scoreMicros: 660_000, speakerCosineMicros: 600_000 },
      ],
      formula: "speaker_cosine+0.15*pitch_similarity_normalized",
      outputAudioSha256: audio("ablation.guidance-ranking.delta.script-05"),
      profile: "guidance-ranking-v1",
      selectedAudioSha256: audio("ablation.guidance-ranking.delta.script-05"),
      selectedIndex: 0,
      slotId: "ablation.guidance-ranking.delta.script-05",
    },
    watermark: {
      alphaMicros: 1_000_000,
      controlAudioSha256: audio("ablation.watermark.control.script-04"),
      controlDetectFractionMicros: 500_000,
      controlDetectorPositive: false,
      controlSlotId: "ablation.watermark.control.script-04",
      deliveredSamples24000: 240_001,
      detectorSha256: "8a78e8a83584113523e161fc599fcab10fd0e94c04d2eb9d2fa1e9ec91ab69d9",
      detectionThresholdMicros: 500_000,
      generatorSha256: "7a845b5fbe9364a63a3909d8ab3fe064d13a76ae4c2e983573e08c69b7b51748",
      message: "1011001011010110",
      messageThresholdMicros: 500_000,
      modelRevision: "3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba",
      preEmbedSamples24000: 240_000,
      profile: "watermark-v1",
      sourceCommit: "e63a8a0e5cdf7bb797159c92ba15961557fe9bd2",
      treatmentAudioSha256: audio("ablation.watermark.delta.script-04"),
      treatmentDetectFractionMicros: 500_001,
      treatmentDetectorPositive: true,
      treatmentSlotId: "ablation.watermark.delta.script-04",
      version: "0.2.0",
    },
  } : {
    items: run.manifest.slots.filter((slot) => slot.phase !== "ablation").map((slot) => ({
      audioSha256: audio(slot.slotId),
      contractVersion: slot.arm.contractVersion,
      detectFractionMicros: 0,
      detectionThresholdMicros: 500_000,
      detectorEvidenceSha256: heroVoiceCanarySha256(`detector/${slot.slotId}`),
      detectorModelRevision: "3c19eba53390776cf2cc9ed5f6c9ac67ce72ecba",
      detectorModelSha256: "8a78e8a83584113523e161fc599fcab10fd0e94c04d2eb9d2fa1e9ec91ab69d9",
      detectorResult: "negative",
      detectorSourceCommit: "e63a8a0e5cdf7bb797159c92ba15961557fe9bd2",
      detectorVersion: "0.2.0",
      endpointId: slot.endpointId,
      expectedCatalogVersion: slot.expectedCatalogVersion,
      expectedWorkerVersion: slot.expectedWorkerVersion,
      imageDigest: slot.imageDigest,
      matchedSettingsSha256: slot.matchedSettingsSha256,
      modelManifestSha256: slot.modelManifestSha256,
      normalizerVersion: slot.normalizerVersion,
      outputChannels: 1,
      outputRate: 24_000,
      outputSubtype: "PCM_16",
      profile: slot.arm.profile,
      providerJobId: `provider-${slot.ordinal}`,
      requestCommitmentSha256: slot.requestCommitmentSha256,
      responseEnvelopeSha256: heroVoiceCanarySha256(`response-envelope/${slot.slotId}`),
      responseIdentitySha256: expectedHeroVoiceCanaryResponseIdentitySha256(slot),
      runnerKind: slot.runnerKind,
      slotId: slot.slotId,
      sourceRevision: slot.sourceRevision,
      stages: slot.runnerKind === "CandidateAiStudioV3" ? [
        "speech_text_attestation", "reference_decode", "demucs_reference_enhancement", "reference_peak_normalize",
        "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three", "speaker_pitch_rank",
        "output_validate_pcm16",
      ] : null,
      templateId: slot.templateId,
    })),
    park: {
      disposition: "confirmed",
      endpointId: run.manifest.identities.candidate.endpointId,
      imageDigest: run.manifest.identities.candidate.imageDigest,
      observedState: "parked",
      readbackSha256: heroVoiceCanarySha256(`park/${run.runId}`),
      templateId: run.manifest.identities.candidate.templateId,
    },
    stageAttestationSha256: heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
      sourceManifestSha256: "8a71a53b121a0ad7963f494c411b2d64ef0c13bd18b2eb4ee4d49fd3231c75e8",
      modelManifestSha256: "ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb",
      combinedStages: [
        "speech_text_attestation", "reference_decode", "demucs_reference_enhancement", "reference_peak_normalize",
        "reference_resample_24000", "omnivoice_prompt", "omnivoice_generate_three", "speaker_pitch_rank",
        "output_validate_pcm16",
      ],
    })),
  };
  const bytes = heroVoiceCanaryJcsBytes({
    authority: "task6-independent-evidence-v1",
    issuedAtMs: 100_000,
    manifestSha256: run.manifestSha256,
    phase: batchKind,
    rows,
    runId: run.runId,
    version: 1,
  });
  const sha256 = heroVoiceCanarySha256(bytes);
  process.env[batchKind === "ablation-8" ? "HERO_VOICE_CANARY_ABLATION_EVIDENCE_SHA256" : "HERO_VOICE_CANARY_FINAL_EVIDENCE_SHA256"] = sha256;
  return { bytes, sha256, hmac: signHeroVoiceCanaryObjectiveEvidenceForTests(bytes), rows };
}

function built(label: string, referenceBytes: Buffer = reference) {
  return buildHeroVoiceCanaryManifest({
    experimentId: `experiment-${label}-${randomUUID()}`,
    referenceSha256: heroVoiceCanarySha256(referenceBytes),
    refTextSha256: heroVoiceCanarySha256(HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT),
    baseline: { endpointId: "baseline-endpoint", templateId: "baseline-template", imageDigest: `sha256:${"a".repeat(64)}` },
    candidate: {
      endpointId: "candidate-endpoint", templateId: "candidate-template", imageDigest: `sha256:${"b".repeat(64)}`,
      sourceRevision: "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb",
      modelManifestSha256: "ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb",
    },
    rateUsdMicrosPerSecond: 100,
    nonGpuReserveComponents: [{ name: "registry", usdMicros: 1000, evidenceSha256: "e".repeat(64) }],
  });
}

async function newRun(label: string) {
  const manifest = built(label);
  const runId = `run-${randomUUID()}`;
  await createHeroVoiceCanaryRun({
    runId,
    ownerHmac,
    referenceVoiceId: `user_${randomUUID()}`,
    manifest: manifest.manifest,
    manifestSha256: manifest.manifestSha256,
  });
  return { runId, ...manifest };
}

async function main() {
  const reconcileArgument = process.argv.indexOf("--reconcile-run");
  if (reconcileArgument >= 0) {
    const runId = process.argv[reconcileArgument + 1];
    assert.ok(runId, "restart child requires a run ID");
    await initializeHeroVoiceDeletionCoordinator();
    const result = await reconcileHeroVoiceCanaryRun({ runId, ownerHmac });
    process.stdout.write(JSON.stringify(result));
    await prisma.$disconnect();
    return;
  }
  const crashReviewArgument = process.argv.indexOf("--crash-review");
  if (crashReviewArgument >= 0) {
    const runId = process.argv[crashReviewArgument + 1];
    const crashStep = process.argv[crashReviewArgument + 2];
    assert.ok(runId && crashStep, "review crash child requires run and step");
    await initializeHeroVoiceDeletionCoordinator();
    const run = await prisma.reviewRun.findUniqueOrThrow({ where: { id: runId } });
    const manifest = parseHeroVoiceCanaryManifest(parseHeroVoiceCanaryStrictJson(Buffer.from(run.slotManifestJson!, "utf8")));
    setHeroVoiceCanaryFileOperationObserverForTests((step) => {
      if (step === crashStep) process.exit(97);
    });
    setHeroVoiceDeletionCrashObserverForTests((step) => {
      if (step === crashStep) process.exit(97);
    });
    await createHeroVoiceCanaryBlindReview({
      runId,
      ownerHmac: run.ownerHmac,
      outputs: manifest.slots.filter((slot) => slot.phase !== "ablation")
        .map((slot) => ({ slotId: slot.slotId, wavBytes: syntheticWav(slot.ordinal) })),
      authority: new LocalBareGitCommitmentAuthority(
        path.join(process.env.HERO_VOICE_CANARY_ROOT!, "git", `crash-${runId}.git`),
      ),
    });
    throw new Error("review_crash_step_not_reached");
  }
  await prisma.siteConfig.create({
    data: { key: HERO_VOICE_CANARY_DATABASE_MARKER_KEY, value: HERO_VOICE_CANARY_DATABASE_MARKER_VALUE },
  });
  assert.deepEqual(await initializeHeroVoiceDeletionCoordinator(), { mode: "ready" });
  const objectiveAuthority = captureHeroVoiceCanaryObjectiveEvidenceAuthority();
  const subject = process.env.HERO_VOICE_CANARY_AUTH_SUBJECT!;
  const issuer = process.env.HERO_VOICE_CANARY_AUTH_ISSUER!;
  const claims = { iss: issuer, sub: subject, aud: "hero-voice-clone-canary-v1" };
  const bootstrapped = await bootstrapHeroVoiceCanaryUser({
    sessionClaims: claims,
    authenticatedUserId: subject,
    displayName: "Synthetic Task 5",
    email: "hero-voice-task5@test.invalid",
    minutesLimit: 120,
  });
  ownerHmac = bootstrapped.ownerHmac;
  process.env.HERO_VOICE_CANARY_TEST_OWNER_HMAC = ownerHmac;
  const actor = await authenticateHeroVoiceCanaryAuthState({ userId: subject, sessionClaims: claims });
  assert.equal(actor.ownerHmac, ownerHmac);
  assert.equal((await resolveHeroVoiceCanarySessionUser({ userId: subject, sessionClaims: claims }))?.id, actor.user.id);
  await prisma.user.update({ where: { id: actor.user.id }, data: { suspended: true } });
  const suspendedActor = await resolveHeroVoiceCanarySessionUser({ userId: subject, sessionClaims: claims });
  assert.equal(suspendedActor?.suspended, true, "identity resolution preserves authenticated policy denial");
  await assert.rejects(
    authenticateHeroVoiceCanaryAuthState({ userId: subject, sessionClaims: claims }),
    (error: unknown) => error instanceof HeroVoiceCanaryAuthError && error.status === 404,
  );
  await prisma.user.update({ where: { id: actor.user.id }, data: { suspended: false } });
  await assert.rejects(
    authenticateHeroVoiceCanaryAuthState({ userId: null, sessionClaims: null }),
    (error: unknown) => error instanceof HeroVoiceCanaryAuthError && error.status === 401,
  );
  for (const badClaims of [
    { ...claims, iss: "https://wrong.clerk.accounts.dev" },
    { ...claims, sub: "user_wrong" },
    { ...claims, aud: "wrong-audience" },
  ]) {
    await assert.rejects(resolveHeroVoiceCanarySessionUser({ userId: subject, sessionClaims: badClaims }));
    await assert.rejects(
      authenticateHeroVoiceCanaryAuthState({ userId: subject, sessionClaims: badClaims }),
      (error: unknown) => error instanceof HeroVoiceCanaryAuthError && error.status === 404,
    );
  }

  const referenceStorageRoot = process.env.USER_VOICE_STORAGE_DIR!;
  const referenceFilename = `${randomUUID()}.wav`;
  const referencePath = path.join(referenceStorageRoot, referenceFilename);
  const canonicalReference = canonicalReferenceWav();
  fs.writeFileSync(referencePath, canonicalReference, { mode: 0o600 });
  const referenceSha256 = heroVoiceCanarySha256(canonicalReference);
  const pointer = {
    version: 1 as const,
    sourceUri: `private://user-voice/${referenceFilename}`,
    referenceSha256,
    transcript: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
    durationMs: 10_000 as const,
  };
  assert.equal(loadHeroVoiceCanaryReference({ pointer, expectedSha256: referenceSha256 }).sha256, referenceSha256);
  assert.throws(() => loadHeroVoiceCanaryReference({
    pointer: { ...pointer, referenceSha256: "f".repeat(64) }, expectedSha256: "f".repeat(64),
  }));
  const wrongFilename = `${randomUUID()}.wav`;
  fs.writeFileSync(path.join(referenceStorageRoot, wrongFilename), syntheticWav(1), { mode: 0o600 });
  assert.throws(() => loadHeroVoiceCanaryReference({
    pointer: { ...pointer, sourceUri: `private://user-voice/${wrongFilename}` }, expectedSha256: referenceSha256,
  }));
  const symlinkFilename = `${randomUUID()}.wav`;
  fs.symlinkSync(referencePath, path.join(referenceStorageRoot, symlinkFilename));
  assert.throws(() => loadHeroVoiceCanaryReference({
    pointer: { ...pointer, sourceUri: `private://user-voice/${symlinkFilename}` }, expectedSha256: referenceSha256,
  }));
  const swapFilename = `${randomUUID()}.wav`;
  const swapPath = path.join(referenceStorageRoot, swapFilename);
  const swapReplacement = path.join(referenceStorageRoot, `${randomUUID()}.wav`);
  fs.writeFileSync(swapPath, canonicalReference, { mode: 0o600 });
  fs.writeFileSync(swapReplacement, canonicalReferenceWav(1), { mode: 0o600 });
  let swapped = false;
  setHeroVoiceCanaryFileOperationObserverForTests((step, basename) => {
    if (!swapped && step === "after-open-before-stability" && basename === swapFilename) {
      swapped = true;
      fs.renameSync(swapReplacement, swapPath);
    }
  });
  assert.throws(() => loadHeroVoiceCanaryReference({
    pointer: { ...pointer, sourceUri: `private://user-voice/${swapFilename}` }, expectedSha256: referenceSha256,
  }));
  setHeroVoiceCanaryFileOperationObserverForTests();

  const validReviewWav = syntheticWav(17);
  assert.doesNotThrow(() => assertHeroVoiceCanaryReviewWav(validReviewWav));
  const maximumReviewWav = Buffer.alloc(7_000_000);
  maximumReviewWav.write("RIFF", 0); maximumReviewWav.writeUInt32LE(maximumReviewWav.length - 8, 4);
  maximumReviewWav.write("WAVEfmt ", 8); maximumReviewWav.writeUInt32LE(16, 16);
  maximumReviewWav.writeUInt16LE(1, 20); maximumReviewWav.writeUInt16LE(1, 22);
  maximumReviewWav.writeUInt32LE(24_000, 24); maximumReviewWav.writeUInt32LE(48_000, 28);
  maximumReviewWav.writeUInt16LE(2, 32); maximumReviewWav.writeUInt16LE(16, 34);
  maximumReviewWav.write("data", 36); maximumReviewWav.writeUInt32LE(maximumReviewWav.length - 44, 40);
  assert.doesNotThrow(() => assertHeroVoiceCanaryReviewWav(maximumReviewWav));
  const oversizedReviewWav = Buffer.concat([maximumReviewWav, Buffer.from([0])]);
  oversizedReviewWav.writeUInt32LE(oversizedReviewWav.length - 8, 4);
  assert.throws(() => assertHeroVoiceCanaryReviewWav(oversizedReviewWav));
  for (const malformed of [
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt32LE(1, 4); return wav; })(),
    validReviewWav.subarray(0, validReviewWav.length - 1),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt16LE(3, 20); return wav; })(),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt16LE(2, 22); return wav; })(),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt32LE(16_000, 24); return wav; })(),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt32LE(47_999, 28); return wav; })(),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt16LE(4, 32); return wav; })(),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt16LE(24, 34); return wav; })(),
    (() => { const wav = Buffer.from(validReviewWav); wav.writeUInt32LE(0, 40); return wav; })(),
    (() => {
      const duplicate = Buffer.concat([validReviewWav, validReviewWav.subarray(12, 36)]);
      duplicate.writeUInt32LE(duplicate.length - 8, 4);
      return duplicate;
    })(),
  ]) assert.throws(() => assertHeroVoiceCanaryReviewWav(malformed));

  const evidenceRun = { runId: `run-${randomUUID()}`, ...built("objective-adversarial") };
  const evidenceOutputs = new Map(evidenceRun.manifest.slots.map((slot) => [slot.slotId, syntheticWav(slot.ordinal)]));
  const evidenceAudio = new Map([...evidenceOutputs].map(([slotId, bytes]) => [slotId, heroVoiceCanarySha256(bytes)]));
  const evidenceProviders = new Map(evidenceRun.manifest.slots.map((slot) => [slot.slotId, `provider-${slot.ordinal}`]));
  const verifyObjective = (bytes: Buffer, phase: "ablation-8" | "final-36", runId = evidenceRun.runId) => {
    const sha256 = heroVoiceCanarySha256(bytes);
    process.env[phase === "ablation-8" ? "HERO_VOICE_CANARY_ABLATION_EVIDENCE_SHA256" : "HERO_VOICE_CANARY_FINAL_EVIDENCE_SHA256"] = sha256;
    return verifyHeroVoiceCanaryObjectiveEvidence({
      bytes, expectedSha256: sha256, hmac: signHeroVoiceCanaryObjectiveEvidenceForTests(bytes),
      phase, runId, manifestSha256: evidenceRun.manifestSha256, manifest: evidenceRun.manifest,
      audioBySlot: evidenceAudio, providerJobIdBySlot: evidenceProviders,
    });
  };
  const objectiveAblation = syntheticObjectiveEvidence("ablation-8", evidenceRun, evidenceOutputs).bytes;
  verifyObjective(objectiveAblation, "ablation-8");
  type MutableObjectiveFixture = {
    rows: {
      demucs?: Record<string, unknown>;
      items?: Array<Record<string, unknown>>;
    };
  };
  const mutateObjective = (source: Buffer, mutate: (value: MutableObjectiveFixture) => void): Buffer => {
    const value = parseHeroVoiceCanaryStrictJson(source) as unknown as MutableObjectiveFixture;
    mutate(value);
    return heroVoiceCanaryJcsBytes(value);
  };
  assert.throws(() => verifyObjective(mutateObjective(objectiveAblation, (value) => {
    value.rows.demucs!.shifts = 1;
  }), "ablation-8"));
  assert.throws(() => verifyObjective(mutateObjective(objectiveAblation, (value) => {
    delete value.rows.demucs!.signature;
  }), "ablation-8"));
  assert.throws(() => verifyObjective(objectiveAblation, "ablation-8", `run-${randomUUID()}`));
  const objectiveFinal = syntheticObjectiveEvidence("final-36", evidenceRun, evidenceOutputs).bytes;
  verifyObjective(objectiveFinal, "final-36");
  assert.throws(() => verifyObjective(mutateObjective(objectiveFinal, (value) => {
    value.rows.items![18].profile = "watermark-v1";
  }), "final-36"));
  assert.throws(() => verifyObjective(mutateObjective(objectiveFinal, (value) => {
    value.rows.items!.pop();
  }), "final-36"));
  assert.throws(() => verifyObjective(mutateObjective(objectiveFinal, (value) => {
    for (const item of value.rows.items!) item.responseEnvelopeSha256 = "f".repeat(64);
  }), "final-36"));

  const earlyNoGo = await newRun("early-objective-no-go");
  const earlyOutputs = new Map<string, Buffer>();
  for (const slot of earlyNoGo.manifest.slots.filter((item) => item.phase === "ablation")) {
    const wav = syntheticWav(slot.ordinal);
    earlyOutputs.set(slot.slotId, wav);
    await commitHeroVoiceCanaryDispatchIntent({
      runId: earlyNoGo.runId, ownerHmac, slotId: slot.slotId,
      prepared: prepareHeroVoiceCanaryWireRequest({
        slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
      }),
    });
    await recordHeroVoiceCanarySubmission({
      runId: earlyNoGo.runId, ownerHmac, slotId: slot.slotId,
      disposition: "provider_accepted", providerJobId: `provider-${slot.ordinal}`,
    });
    await recordHeroVoiceCanaryResult({
      runId: earlyNoGo.runId, ownerHmac, slotId: slot.slotId, outcome: "valid_completed",
      primaryStatus: "completed", audioSha256: heroVoiceCanarySha256(wav), durationMs: 1,
      delayTimeMs: 0, executionTimeMs: 1,
    });
  }
  await recordHeroVoiceCanaryCerBatch({
    runId: earlyNoGo.runId, ownerHmac, evidence: syntheticEvaluatorEvidence("ablation-8"),
    results: earlyNoGo.manifest.slots.filter((slot) => slot.phase === "ablation").map((slot) => ({
      slotId: slot.slotId, inputAudioSha256: heroVoiceCanarySha256(earlyOutputs.get(slot.slotId)!),
      expectedTextSha256: slot.speechTextSha256, cerNumerator: 0, cerDenominator: 1,
    })),
  });
  const invalidEarlyBytes = mutateObjective(
    syntheticObjectiveEvidence("ablation-8", earlyNoGo, earlyOutputs).bytes,
    (value) => { value.rows.demucs!.shifts = 1; },
  );
  const invalidEarlySha256 = heroVoiceCanarySha256(invalidEarlyBytes);
  process.env.HERO_VOICE_CANARY_ABLATION_EVIDENCE_SHA256 = invalidEarlySha256;
  const parentAuthorityEnvironment = Object.fromEntries(
    HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  const isolatedEnvironment = heroVoiceCanaryTask7AdapterEnvironment();
  assert.ok(HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS.every((key) => isolatedEnvironment[key] === undefined));
  const maliciousAdapter = new HeroVoiceCanaryTask7AdapterProcess({
    modulePath: "scripts/fixtures/hero-voice-canary-malicious-adapter.ts",
    testOnly: true,
  });
  const isolatedDispatch = await maliciousAdapter.dispatchDirect(
    earlyNoGo.manifest.slots[0], Buffer.from("{}"),
  );
  assert.equal(isolatedDispatch.disposition, "provider_accepted");
  if (isolatedDispatch.disposition !== "provider_accepted") throw new Error("synthetic_dispatch_not_accepted");
  assert.equal(isolatedDispatch.providerJobId, "isolated");
  const forgedBatch = await maliciousAdapter.evaluateBatch("ablation-8", earlyNoGo.manifest.slots.slice(0, 8));
  await assert.rejects(recordHeroVoiceCanaryObjectiveObservation({
    runId: earlyNoGo.runId,
    ownerHmac,
    phase: "ablation-8",
    rows: forgedBatch.objectiveRows,
    authority: objectiveAuthority,
    issuedAtMs: 100_000,
  }));
  await maliciousAdapter.dispose();
  for (const [key, value] of Object.entries(parentAuthorityEnvironment)) assert.equal(process.env[key], value);
  assert.equal(await finalizeHeroVoiceCanaryRun({
    runId: earlyNoGo.runId, ownerHmac, evidence: syntheticEvaluatorEvidence("ablation-8"),
    objectiveEvidenceBytes: invalidEarlyBytes,
    objectiveEvidenceSha256: invalidEarlySha256,
    objectiveEvidenceHmac: signHeroVoiceCanaryObjectiveEvidenceForTests(invalidEarlyBytes),
    objectiveAuthority,
  }), "aborted_no_go");
  const earlyCounters = heroVoiceCanaryCounters(await verifyHeroVoiceCanaryLedger({ runId: earlyNoGo.runId, ownerHmac }));
  assert.deepEqual({ intents: earlyCounters.dispatchIntents, accepted: earlyCounters.providerAccepted,
    completed: earlyCounters.validCompleted, notStarted: earlyCounters.notStarted },
  { intents: 8, accepted: 8, completed: 8, notStarted: 36 });

  const rejected = await newRun("rejected");
  let records = await verifyHeroVoiceCanaryLedger({ runId: rejected.runId, ownerHmac });
  assert.equal(records.length, 1);
  const prepared = prepareHeroVoiceCanaryWireRequest({
    slot: rejected.manifest.slots[0], referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  });
  await commitHeroVoiceCanaryDispatchIntent({
    runId: rejected.runId, ownerHmac, slotId: rejected.manifest.slots[0].slotId, prepared, nowMs: 1_000,
  });
  records = await verifyHeroVoiceCanaryLedger({ runId: rejected.runId, ownerHmac });
  assert.equal(records.filter(({ record }) => record.type === "dispatch_intent").length, 1);

  const first = await prisma.canaryLedgerRecord.findFirstOrThrow({ where: { runId: rejected.runId }, orderBy: { sequence: "asc" } });
  await assert.rejects(prisma.canaryLedgerRecord.update({ where: { id: first.id }, data: { recordJson: "{}" } }));
  await assert.rejects(prisma.canaryLedgerRecord.delete({ where: { id: first.id } }));
  await assert.rejects(prisma.canaryLedgerRecord.create({
    data: {
      id: randomUUID(), runId: rejected.runId, ownerHmac, sequence: 99,
      recordJson: heroVoiceCanaryJcsBytes({ type: "park_disposition", disposition: "confirmed", observedAtMs: 1 }).toString("utf8"),
      recordHmac: "f".repeat(64),
    },
  }));
  const rejectedRow = await prisma.reviewRun.findUniqueOrThrow({ where: { id: rejected.runId } });
  await assert.rejects(prisma.reviewRun.update({
    where: { id: rejected.runId }, data: { ledgerSequence: rejectedRow.ledgerSequence - 1, ledgerHeadHmac: null },
  }));

  await recordHeroVoiceCanarySubmission({
    runId: rejected.runId, ownerHmac, slotId: rejected.manifest.slots[0].slotId,
    disposition: "provider_rejected", observedAtMs: 1_001,
  });
  records = await verifyHeroVoiceCanaryLedger({ runId: rejected.runId, ownerHmac });
  const counts = heroVoiceCanaryCounters(records);
  assert.equal(counts.notStarted, 43);
  assert.equal(counts.providerRejected, 1);
  assert.deepEqual(counts.possibleProviderReceived, [1, 1]);
  assert.equal((await prisma.reviewRun.findUniqueOrThrow({ where: { id: rejected.runId } })).runState, "aborted_no_go");

  for (const step of [
    "after-record-before-head",
    "after-state-before-transition-record",
    "after-inflight-before-intent-record",
  ] as const) {
    const atomic = await newRun(`atomic-${step}`);
    const atomicPrepared = prepareHeroVoiceCanaryWireRequest({
      slot: atomic.manifest.slots[0], referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
    });
    setHeroVoiceCanaryLedgerCrashObserverForTests((observed) => {
      if (observed === step) throw new Error(`synthetic_${step}`);
    });
    await assert.rejects(commitHeroVoiceCanaryDispatchIntent({
      runId: atomic.runId, ownerHmac, slotId: atomic.manifest.slots[0].slotId, prepared: atomicPrepared,
    }));
    setHeroVoiceCanaryLedgerCrashObserverForTests();
    const atomicRow = await prisma.reviewRun.findUniqueOrThrow({ where: { id: atomic.runId } });
    assert.equal(atomicRow.runState, "planned");
    assert.equal(atomicRow.inFlightSlotId, null);
    assert.equal((await verifyHeroVoiceCanaryLedger({ runId: atomic.runId, ownerHmac })).length, 1);
  }

  const rejectionCrash = await newRun("atomic-rejection");
  const rejectionPrepared = prepareHeroVoiceCanaryWireRequest({
    slot: rejectionCrash.manifest.slots[0], referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  });
  await commitHeroVoiceCanaryDispatchIntent({
    runId: rejectionCrash.runId, ownerHmac, slotId: rejectionCrash.manifest.slots[0].slotId, prepared: rejectionPrepared,
  });
  setHeroVoiceCanaryLedgerCrashObserverForTests((step) => {
    if (step === "after-submission-before-terminal-transition") throw new Error("synthetic_submission_boundary");
  });
  await assert.rejects(recordHeroVoiceCanarySubmission({
    runId: rejectionCrash.runId, ownerHmac, slotId: rejectionCrash.manifest.slots[0].slotId,
    disposition: "provider_rejected",
  }));
  setHeroVoiceCanaryLedgerCrashObserverForTests();
  assert.equal((await verifyHeroVoiceCanaryLedger({ runId: rejectionCrash.runId, ownerHmac }))
    .some(({ record }) => record.type === "provider_rejected"), false);
  assert.equal((await reconcileHeroVoiceCanaryRun({ runId: rejectionCrash.runId, ownerHmac })).runState, "aborted_no_go");

  const restart = await newRun("restart");
  const restartPrepared = prepareHeroVoiceCanaryWireRequest({
    slot: restart.manifest.slots[0], referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  });
  await commitHeroVoiceCanaryDispatchIntent({
    runId: restart.runId, ownerHmac, slotId: restart.manifest.slots[0].slotId, prepared: restartPrepared, nowMs: 2_000,
  });
  const restartProcess = spawnSync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", process.argv[1], "--reconcile-run", restart.runId,
  ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(restartProcess.status, 0, restartProcess.stderr);
  const reconciled = JSON.parse(restartProcess.stdout) as Awaited<ReturnType<typeof reconcileHeroVoiceCanaryRun>>;
  assert.equal(reconciled.runState, "aborted_no_go");
  assert.equal(reconciled.counters.transportUnknown, 1);
  assert.equal(reconciled.counters.dispatchIntents, 1);
  assert.equal((await reconcileHeroVoiceCanaryRun({ runId: restart.runId, ownerHmac })).counters.transportUnknown, 1);

  const applyManifest = built("apply-runner");
  const applyRun = { runId: `run-${randomUUID()}`, ...applyManifest };
  const applyEvidenceUnsigned = {
    version: 1,
    status: "approved",
    evidenceId: "synthetic-apply-runner-evidence",
    manifestSha256: applyManifest.manifestSha256,
    issuedAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    rows: [
      "billing-bound-660-seconds", "clerk-test-sessions", "control-peak-parity",
      "cost-rate-readback", "demucs-compatibility", "github-object-readback",
      "immutable-endpoint-readback", "legal-human-data", "license",
      "linux-arm64-evaluator", "meaningful-normalizer-delta",
    ].map((gate, index) => ({
      gate,
      evidenceSha256: heroVoiceCanarySha256(`apply/evidence/${index}`),
      identitySha256: heroVoiceCanarySha256(`apply/identity/${index}`),
      predicateSha256: heroVoiceCanarySha256(`apply/predicate/${index}`),
    })),
  };
  const applyEvidenceBytes = heroVoiceCanaryJcsBytes({
    ...applyEvidenceUnsigned,
    evidenceHmac: signHeroVoiceCanaryTask6EvidenceForTests(applyEvidenceUnsigned),
  });
  const applyEvidenceSha256 = heroVoiceCanarySha256(applyEvidenceBytes);
  process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = applyEvidenceSha256;
  const applyOutputs = new Map<string, Buffer>();
  const dispatchedOrdinals: number[] = [];
  let inFlight = 0;
  await assert.rejects(runHeroVoiceCanaryApply({
    ...applyRun,
    ownerHmac,
    referenceVoiceId: `user_${randomUUID()}`,
    referenceWav: reference,
    task6EvidenceBytes: applyEvidenceBytes,
    task6EvidenceSha256: applyEvidenceSha256,
    adapter: {
      async dispatchDirect(slot, bytes) {
        assert.ok(bytes.length > 0);
        inFlight += 1;
        assert.equal(inFlight, 1);
        dispatchedOrdinals.push(slot.ordinal);
        return { disposition: "provider_accepted" as const, providerJobId: `provider-${slot.ordinal}` };
      },
      async submitCandidate(slot, signed) {
        inFlight += 1;
        assert.equal(inFlight, 1);
        dispatchedOrdinals.push(slot.ordinal);
        // This synthetic-only adapter emulates the application-owned durable
        // intent. A later integration block exercises the real service,
        // generation and transport seams end to end.
        const prepared = prepareHeroVoiceCanaryWireRequest({
          slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
        });
        await commitHeroVoiceCanaryDispatchIntent({
          runId: signed.capability.runId, ownerHmac, slotId: slot.slotId, prepared,
        });
        await recordHeroVoiceCanarySubmission({
          runId: signed.capability.runId,
          ownerHmac,
          slotId: slot.slotId,
          disposition: "provider_accepted",
          providerJobId: `provider-${slot.ordinal}`,
        });
        return { disposition: "application_accepted" as const, applicationJobId: `apply-app-${slot.ordinal}` };
      },
      async awaitDirectTerminal(slot, providerJobId) {
        assert.equal(providerJobId, `provider-${slot.ordinal}`);
        const wav = syntheticWav(slot.ordinal);
        applyOutputs.set(slot.slotId, wav);
        inFlight -= 1;
        return {
          outcome: "valid_completed" as const,
          primaryStatus: "completed" as const,
          audioBase64: wav.toString("base64"),
          audioSha256: heroVoiceCanarySha256(wav), durationMs: 1, delayTimeMs: 0, executionTimeMs: 1,
        };
      },
      async evaluateBatch(kind, slots) {
        assert.equal(inFlight, 0);
        const objective = syntheticObjectiveEvidence(kind, applyRun, applyOutputs);
        return {
          evidence: syntheticEvaluatorEvidence(kind),
          results: slots.map((slot) => ({
            slotId: slot.slotId,
            inputAudioSha256: heroVoiceCanarySha256(applyOutputs.get(slot.slotId)!),
            expectedTextSha256: slot.speechTextSha256,
            cerNumerator: 0,
            cerDenominator: 1,
          })),
          objectiveRows: objective.rows,
        };
      },
    },
  }), /canary job (?:identity is invalid|is unavailable)/u);
  assert.deepEqual(dispatchedOrdinals, Array.from({ length: 27 }, (_, index) => index + 1));

  for (const malformed of ["missing-bytes", "wrong-hash"] as const) {
    const rejectedOutput = { runId: `run-${randomUUID()}`, ...built(`reject-output-${malformed}`) };
    const unsigned = { ...applyEvidenceUnsigned, manifestSha256: rejectedOutput.manifestSha256,
      issuedAtMs: Date.now() - 1_000, expiresAtMs: Date.now() + 60_000 };
    const evidenceBytes = heroVoiceCanaryJcsBytes({ ...unsigned, evidenceHmac: signHeroVoiceCanaryTask6EvidenceForTests(unsigned) });
    const evidenceSha256 = heroVoiceCanarySha256(evidenceBytes);
    process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = evidenceSha256;
    let submissions = 0;
    let disposed = false;
    const state = await runHeroVoiceCanaryApply({
      ...rejectedOutput, ownerHmac, referenceVoiceId: `user_${randomUUID()}`, referenceWav: reference,
      task6EvidenceBytes: evidenceBytes, task6EvidenceSha256: evidenceSha256,
      adapter: {
        async dispatchDirect() { submissions++; return { disposition: "provider_accepted", providerJobId: "synthetic-invalid-output" }; },
        async submitCandidate() { throw new Error("must not reach candidate after invalid direct output"); },
        async awaitDirectTerminal() {
          return { outcome: "valid_completed", primaryStatus: "completed", audioSha256: "0".repeat(64),
            durationMs: 1, delayTimeMs: 0, executionTimeMs: 1,
            ...(malformed === "wrong-hash" ? { audioBase64: syntheticWav(1).toString("base64") } : {}),
          };
        },
        async evaluateBatch() { throw new Error("must not evaluate invalid direct output"); },
        async dispose() { disposed = true; },
      },
    });
    assert.equal(state, "aborted_no_go");
    assert.equal(submissions, 1);
    assert.equal(disposed, true);
    assert.equal(await prisma.canaryRunOutput.count({ where: { runId: rejectedOutput.runId } }), 0);
    const counters = heroVoiceCanaryCounters(await verifyHeroVoiceCanaryLedger({ runId: rejectedOutput.runId, ownerHmac }));
    assert.equal(counters.dispatchIntents, 1);
    assert.equal(counters.providerAccepted, 1);
    assert.equal(counters.validCompleted, 0);
    assert.equal(counters.notStarted, 43);
  }

  // Execute the complete runner through the real authenticated request
  // parser, admission, generation, mandatory beforeDispatch and atomic
  // provider-acceptance seams. Only the provider transport is a local fake.
  const referenceVoiceRowId = referenceFilename.slice(0, -4);
  await prisma.userVoice.create({
    data: {
      id: referenceVoiceRowId,
      userId: actor.user.id,
      name: "Synthetic canary reference",
      refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
      filename: referenceFilename,
      durationMs: 10_000,
      consentVersion: "voice-clone-v1",
    },
  });
  process.env.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID = "candidate-endpoint";
  process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
  process.env.RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb";
  process.env.RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256 = "ca609f414c72cf2d574e198d7268ce528f309b5cde6eff25cf3cd1a824af33bb";
  process.env.RUNPOD_API_KEY = "synthetic-never-network";
  const integratedManifest = built("real-generation-integration", canonicalReference);
  const integrated = { runId: `run-${randomUUID()}`, ...integratedManifest };
  const integratedEvidenceUnsigned = {
    ...applyEvidenceUnsigned,
    evidenceId: "synthetic-real-generation-evidence",
    manifestSha256: integrated.manifestSha256,
  };
  const integratedEvidenceBytes = heroVoiceCanaryJcsBytes({
    ...integratedEvidenceUnsigned,
    evidenceHmac: signHeroVoiceCanaryTask6EvidenceForTests(integratedEvidenceUnsigned),
  });
  const integratedEvidenceSha256 = heroVoiceCanarySha256(integratedEvidenceBytes);
  process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = integratedEvidenceSha256;
  const originalFetch = globalThis.fetch;
  let submittingCandidateOrdinal = 0;
  let integratedInFlight = 0;
  let providerPosts = 0;
  const integratedOutputs = new Map<string, Buffer>();
  const candidateRequests = new Map<string, { request: Record<string, unknown>; slot: typeof integrated.manifest.slots[number] }>();
  globalThis.fetch = (async (requestInput, requestInit) => {
    const url = String(requestInput);
    if (url === "https://api.runpod.ai/v2/candidate-endpoint/run") {
      assert.equal(requestInit?.method, "POST");
      assert.ok(submittingCandidateOrdinal >= 27 && submittingCandidateOrdinal <= 44);
      assert.equal(integratedInFlight, 0);
      integratedInFlight = 1;
      providerPosts += 1;
      const body = requestInit?.body;
      assert.ok(body instanceof Uint8Array);
      const slot = integrated.manifest.slots[submittingCandidateOrdinal - 1];
      const expected = prepareHeroVoiceCanaryWireRequest({
        slot, referenceWav: canonicalReference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
      });
      assert.ok(Buffer.from(body).equals(expected.bytes));
      const providerJobId = `provider-${slot.ordinal}`;
      const parsedBody = parseHeroVoiceCanaryStrictJson(Buffer.from(body)) as { input: Record<string, unknown> };
      candidateRequests.set(providerJobId, { request: parsedBody.input, slot });
      return new Response(JSON.stringify({ id: providerJobId, status: "IN_QUEUE" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const providerJobId = url.match(/\/status\/(provider-[0-9]+)$/u)?.[1];
    const candidate = providerJobId ? candidateRequests.get(providerJobId) : undefined;
    if (candidate && providerJobId) {
      assert.equal(integratedInFlight, 1);
      integratedInFlight = 0;
      const wav = syntheticWav(candidate.slot.ordinal);
      integratedOutputs.set(candidate.slot.slotId, wav);
      return Response.json({
        id: providerJobId,
        status: "COMPLETED",
        delayTime: 2,
        executionTime: 3,
        output: candidateTerminalEnvelope({ request: candidate.request, slot: candidate.slot, wav }),
      });
    }
    throw new Error(`unexpected synthetic provider URL: ${url}`);
  }) as typeof fetch;
  let integratedState: Awaited<ReturnType<typeof runHeroVoiceCanaryApply>>;
  try {
    integratedState = await runHeroVoiceCanaryApply({
      ...integrated,
      ownerHmac,
      referenceVoiceId: `user_${referenceVoiceRowId}`,
      referenceWav: canonicalReference,
      task6EvidenceBytes: integratedEvidenceBytes,
      task6EvidenceSha256: integratedEvidenceSha256,
      adapter: {
        async dispatchDirect(slot, bytes) {
          assert.equal(integratedInFlight, 0);
          integratedInFlight = 1;
          assert.ok(bytes.equals(prepareHeroVoiceCanaryWireRequest({
            slot, referenceWav: canonicalReference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
          }).bytes));
          return { disposition: "provider_accepted" as const, providerJobId: `provider-${slot.ordinal}` };
        },
        async submitCandidate(slot, signed) {
          submittingCandidateOrdinal = slot.ordinal;
          return submitHeroVoiceCanaryCandidateViaLoopback({
            origin: "http://127.0.0.1:43117",
            attestation: "synthetic-loopback-attestation",
            cookieHeader: "__session=synthetic-test-session",
            slot,
            signed,
            fetchImpl: async (requestInput, requestInit) => {
              const url = new URL(String(requestInput));
              assert.equal(url.pathname,
                `/api/ai-studio/voice-clone-canary/runs/${integrated.runId}/slots/${slot.slotId}/submit`);
              assert.equal(new Headers(requestInit?.headers).get("x-hero-voice-canary-loopback-attestation"),
                "synthetic-loopback-attestation");
              const requestBytes = Buffer.from(String(requestInit?.body), "utf8");
              const job = await submitHeroVoiceCanarySlotRequest({
                actor: actor.user,
                ownerHmac,
                runId: integrated.runId,
                slotId: slot.slotId,
                requestBytes,
              });
              return new Response(JSON.stringify({ job }), { status: 202 });
            },
          });
        },
        async awaitDirectTerminal(slot, providerJobId) {
          assert.notEqual(slot.runnerKind, "CandidateAiStudioV3");
          assert.equal(providerJobId, `provider-${slot.ordinal}`);
          assert.equal(integratedInFlight, 1);
          integratedInFlight = 0;
          const wav = syntheticWav(slot.ordinal);
          integratedOutputs.set(slot.slotId, wav);
          return {
            outcome: "valid_completed" as const,
            primaryStatus: "completed" as const,
            audioBase64: wav.toString("base64"),
            audioSha256: heroVoiceCanarySha256(wav), durationMs: 1, delayTimeMs: 0, executionTimeMs: 1,
          };
        },
        async evaluateBatch(kind, slots) {
          assert.equal(integratedInFlight, 0);
          const objective = syntheticObjectiveEvidence(kind, integrated, integratedOutputs);
          return {
            evidence: syntheticEvaluatorEvidence(kind),
            results: slots.map((slot) => ({
              slotId: slot.slotId,
              inputAudioSha256: heroVoiceCanarySha256(integratedOutputs.get(slot.slotId)!),
              expectedTextSha256: slot.speechTextSha256,
              cerNumerator: 0,
              cerDenominator: 1,
            })),
            objectiveRows: objective.rows,
          };
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(integratedState, "reviewable");
  assert.equal(providerPosts, 18);
  const integratedRecords = await verifyHeroVoiceCanaryLedger({ runId: integrated.runId, ownerHmac });
  assert.equal(integratedRecords.filter(({ record }) => record.type === "dispatch_intent").length, 44);
  assert.equal(new Set(integratedRecords.filter(({ record }) => record.type === "dispatch_intent")
    .map(({ record }) => "slotId" in record ? record.slotId : "")).size, 44);
  const directOutputs = await prisma.canaryRunOutput.findMany({ where: { runId: integrated.runId } });
  assert.equal(directOutputs.length, 26);
  for (const output of directOutputs) {
    assert.deepEqual(await readHeroVoiceCanaryRunOutput({ runId: integrated.runId, ownerHmac, slotId: output.slotId }),
      integratedOutputs.get(output.slotId));
  }
  assert.equal(/"(?:audioBase64|storageKey)":/u.test(JSON.stringify(integratedRecords)), false);
  const integratedJobs = await prisma.aiGenerationJob.findMany({
    where: { canaryRunId: integrated.runId }, include: { attempts: true }, orderBy: { canarySlotId: "asc" },
  });
  assert.equal(integratedJobs.length, 18);
  assert.ok(integratedJobs.every((job) => job.idempotencyKey === null && job.chargeState === "settled"
    && job.status === "completed" && job.outputUrl === `/api/ai-studio/voice-audio/${job.id}`
    && job.providerJobId && job.attempts.length === 1
    && job.attempts[0].providerJobId === job.providerJobId
    && job.attempts[0].status === "completed"
    && job.attempts[0].submissionDisposition === "provider_accepted"));
  for (const job of integratedJobs) {
    const filename = path.join(process.env.USER_VOICE_STORAGE_DIR!, "generated", `clone-${job.id}.wav`);
    const bytes = fs.readFileSync(filename);
    assert.equal((fs.statSync(filename).mode & 0o777), 0o600);
    assert.equal(heroVoiceCanarySha256(bytes), heroVoiceCanarySha256(integratedOutputs.get(job.canarySlotId!)!));
  }

  const admissionRun = await newRun("nonce-adversarial");
  const admissionOutputs = new Map<string, Buffer>();
  for (const slot of admissionRun.manifest.slots.filter((item) => item.phase === "ablation")) {
    const wav = syntheticWav(slot.ordinal);
    admissionOutputs.set(slot.slotId, wav);
    const preparedSlot = prepareHeroVoiceCanaryWireRequest({
      slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
    });
    await commitHeroVoiceCanaryDispatchIntent({ runId: admissionRun.runId, ownerHmac, slotId: slot.slotId, prepared: preparedSlot });
    await recordHeroVoiceCanarySubmission({
      runId: admissionRun.runId, ownerHmac, slotId: slot.slotId,
      disposition: "provider_accepted", providerJobId: `provider-${slot.ordinal}`,
    });
    await recordHeroVoiceCanaryResult({
      runId: admissionRun.runId, ownerHmac, slotId: slot.slotId, outcome: "valid_completed",
      primaryStatus: "completed", audioSha256: heroVoiceCanarySha256(wav), durationMs: 1,
      delayTimeMs: 0, executionTimeMs: 1,
    });
  }
  await recordHeroVoiceCanaryCerBatch({
    runId: admissionRun.runId, ownerHmac, evidence: syntheticEvaluatorEvidence("ablation-8"),
    results: admissionRun.manifest.slots.filter((slot) => slot.phase === "ablation").map((slot) => ({
      slotId: slot.slotId, inputAudioSha256: heroVoiceCanarySha256(admissionOutputs.get(slot.slotId)!),
      expectedTextSha256: slot.speechTextSha256, cerNumerator: 0, cerDenominator: 1,
    })),
  });
  const admissionObjectiveRows = syntheticObjectiveEvidence("ablation-8", admissionRun, admissionOutputs).rows;
  const admissionObjective = await recordHeroVoiceCanaryObjectiveObservation({
    runId: admissionRun.runId, ownerHmac, phase: "ablation-8", rows: admissionObjectiveRows,
    authority: objectiveAuthority, issuedAtMs: 100_000,
  });
  const priorObjectiveKey = process.env.HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY;
  process.env.HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY = Buffer.alloc(32, 31).toString("base64url");
  process.env.HERO_VOICE_CANARY_ABLATION_EVIDENCE_SHA256 = "f".repeat(64);
  const restartedAdmissionObjective = await recordHeroVoiceCanaryObjectiveObservation({
    runId: admissionRun.runId, ownerHmac, phase: "ablation-8", rows: admissionObjectiveRows,
    authority: objectiveAuthority, issuedAtMs: 100_000,
  });
  assert.deepEqual(restartedAdmissionObjective, admissionObjective);
  process.env.HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY = priorObjectiveKey;
  assert.equal(await finalizeHeroVoiceCanaryRun({
    runId: admissionRun.runId, ownerHmac, evidence: syntheticEvaluatorEvidence("ablation-8"),
    objectiveEvidenceBytes: admissionObjective.bytes, objectiveEvidenceSha256: admissionObjective.sha256,
    objectiveEvidenceHmac: admissionObjective.hmac,
    objectiveAuthority,
  }), "running_baseline");
  for (const slot of admissionRun.manifest.slots.filter((item) => item.phase === "baseline")) {
    const preparedSlot = prepareHeroVoiceCanaryWireRequest({
      slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
    });
    await commitHeroVoiceCanaryDispatchIntent({ runId: admissionRun.runId, ownerHmac, slotId: slot.slotId, prepared: preparedSlot });
    await recordHeroVoiceCanarySubmission({
      runId: admissionRun.runId, ownerHmac, slotId: slot.slotId,
      disposition: "provider_accepted", providerJobId: `provider-${slot.ordinal}`,
    });
    await recordHeroVoiceCanaryResult({
      runId: admissionRun.runId, ownerHmac, slotId: slot.slotId, outcome: "valid_completed",
      primaryStatus: "completed", audioSha256: heroVoiceCanarySha256(syntheticWav(slot.ordinal)), durationMs: 1,
      delayTimeMs: 0, executionTimeMs: 1,
    });
  }
  assert.equal(await finalizeHeroVoiceCanaryRun({
    runId: admissionRun.runId, ownerHmac, evidence: syntheticEvaluatorEvidence("ablation-8"),
  }), "running_candidate");
  const admissionSlot = admissionRun.manifest.slots[26];
  const admissionCapability = await issueHeroVoiceCanarySubmitCapability({
    runId: admissionRun.runId, ownerHmac, slotId: admissionSlot.slotId, nowMs: 40_000,
  });
  await assert.rejects(prisma.$transaction(async (tx) => consumeHeroVoiceCanaryAdmissionInTransaction(tx, {
    ownerHmac,
    capabilityBytes: admissionCapability.capabilityBytes,
    submitHmac: `${admissionCapability.submitHmac.slice(0, 63)}${admissionCapability.submitHmac.endsWith("0") ? "1" : "0"}`,
    jobId: `job-${randomUUID()}`,
    nowMs: 40_001,
  })));
  await assert.rejects(prisma.$transaction(async (tx) => consumeHeroVoiceCanaryAdmissionInTransaction(tx, {
    ownerHmac,
    capabilityBytes: admissionCapability.capabilityBytes,
    submitHmac: admissionCapability.submitHmac,
    jobId: `job-${randomUUID()}`,
    nowMs: 340_000,
  })));
  await assert.rejects(prisma.$transaction(async (tx) => {
    await consumeHeroVoiceCanaryAdmissionInTransaction(tx, {
      ownerHmac,
      capabilityBytes: admissionCapability.capabilityBytes,
      submitHmac: admissionCapability.submitHmac,
      jobId: `job-${randomUUID()}`,
      nowMs: 40_002,
    });
    throw new Error("synthetic_rollback");
  }));
  assert.equal((await prisma.canarySubmitNonce.findFirstOrThrow({ where: { runId: admissionRun.runId } })).usedAt, null);
  const racers = await Promise.allSettled([1, 2].map((index) => prisma.$transaction(async (tx) => (
    consumeHeroVoiceCanaryAdmissionInTransaction(tx, {
      ownerHmac,
      capabilityBytes: admissionCapability.capabilityBytes,
      submitHmac: admissionCapability.submitHmac,
      jobId: `job-${index}-${randomUUID()}`,
      nowMs: 40_003,
    })
  ))));
  assert.equal(racers.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(racers.filter((result) => result.status === "rejected").length, 1);

  const gitRoot = path.join(process.env.HERO_VOICE_CANARY_ROOT!, "git", "commitments.git");
  const authority = new LocalBareGitCommitmentAuthority(gitRoot);
  const gitBytes = heroVoiceCanaryJcsBytes({ version: 1, experimentId: "experiment-local-git", revealCiphertextSha256: "a".repeat(64) });
  const binding = await authority.publishCommitment({
    path: "docs/research/hero-voice-clone-canary/reveal-commitments/experiment-local-git.json",
    ref: "refs/heads/mewic/hero-voice-clone-prod-audit",
    bytes: gitBytes,
  });
  await authority.verifyCommitment(binding, gitBytes);
  const idempotentBinding = await authority.publishCommitment({
    path: binding.path,
    ref: binding.ref,
    bytes: gitBytes,
  });
  assert.deepEqual(idempotentBinding, binding, "a create-once commitment retry must reuse the immutable creation object");
  await assert.rejects(authority.publishCommitment({
    path: binding.path,
    ref: binding.ref,
    bytes: Buffer.from(gitBytes.toString("utf8").replace("aaaa", "bbbb")),
  }), /CANARY_GIT_OBJECT_MISMATCH|canary/i);
  await assert.rejects(authority.verifyCommitment(binding, Buffer.from(gitBytes.toString("utf8").replace("aaaa", "bbbb"))));

  process.env.HERO_VOICE_CANARY_GITHUB_REPOSITORY_NODE_ID = "R_kgDOsynthetic";
  let remoteBytes = Buffer.alloc(0);
  let remoteRefCommit = "a".repeat(40);
  let remotePublished = false;
  const remote: GitHubCommitmentRemote = {
    async repositoryIdentity() {
      return {
        repositoryNodeId: "R_kgDOsynthetic",
        canonicalUrl: "https://github.com/Aoacademy2025/AI_content_Mew_social",
      };
    },
    async pushCommitment(input) {
      if (remotePublished) {
        assert.ok(remoteBytes.equals(input.bytes));
        return { commitSha: "a".repeat(40), blobOid: `sha1:${"b".repeat(40)}`, created: false };
      }
      remoteBytes = Buffer.from(input.bytes);
      remoteRefCommit = "a".repeat(40);
      remotePublished = true;
      return { commitSha: "a".repeat(40), blobOid: `sha1:${"b".repeat(40)}`, created: true };
    },
    async readRemoteRefCommit() {
      return remoteRefCommit;
    },
    async readRemoteObject() {
      return { commitSha: "a".repeat(40), blobOid: `sha1:${"b".repeat(40)}`, bytes: Buffer.from(remoteBytes) };
    },
  };
  const realAuthorityOffline = new GitHubGitCommitmentAuthority(remote);
  const realBinding = await realAuthorityOffline.publishCommitment({
    path: "docs/research/hero-voice-clone-canary/reveal-commitments/experiment-local-git.json",
    ref: "refs/heads/mewic/hero-voice-clone-prod-audit",
    bytes: gitBytes,
  });
  assert.equal(realBinding.repositoryNodeId, "R_kgDOsynthetic");
  // Branch movement after publication must not change the immutable object
  // readback used by lock/reveal.
  remoteRefCommit = "c".repeat(40);
  await realAuthorityOffline.verifyCommitment(realBinding, gitBytes);
  const retriedRealBinding = await realAuthorityOffline.publishCommitment({
    path: realBinding.path,
    ref: realBinding.ref,
    bytes: gitBytes,
  });
  assert.deepEqual(retriedRealBinding, realBinding,
    "a post-push retry must reuse the recorded commit after the branch advances");
  await assert.rejects(realAuthorityOffline.publishCommitment({
    path: realBinding.path,
    ref: realBinding.ref,
    bytes: Buffer.from(gitBytes.toString("utf8").replace("aaaa", "bbbb")),
  }), "a create-once remote path must reject different retry bytes");
  for (const forgedBinding of [
    { ...realBinding, repositoryNodeId: "R_kgDOwrong" },
    { ...realBinding, canonicalUrl: "https://github.com/wrong/repository" },
    { ...realBinding, ref: "refs/heads/wrong" },
    { ...realBinding, commitSha: "d".repeat(40) },
    { ...realBinding, blobOid: `sha1:${"d".repeat(40)}` },
    { ...realBinding, path: "docs/research/hero-voice-clone-canary/reveal-commitments/wrong.json" },
  ]) await assert.rejects(realAuthorityOffline.verifyCommitment(forgedBinding, gitBytes));
  remoteBytes = Buffer.from(gitBytes.toString("utf8").replace("aaaa", "bbbb"));
  await assert.rejects(realAuthorityOffline.verifyCommitment(realBinding, gitBytes));

  // This is an explicitly synthetic state-machine/review fixture. The
  // evaluator lock verifier separately prevents treating it as canonical
  // linux/arm64 evidence or enabling --apply on this Mac.
  const reviewable = await newRun("blind-review-lifecycle");
  const outputBySlot = new Map<string, Buffer>();
  const recordSlots = async (phase: "ablation" | "baseline" | "candidate") => {
    const slots = reviewable.manifest.slots.filter((slot) => slot.phase === phase);
    for (const slot of slots) {
      const wavBytes = syntheticWav(slot.ordinal);
      outputBySlot.set(slot.slotId, wavBytes);
      const preparedSlot = prepareHeroVoiceCanaryWireRequest({
        slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
      });
      await commitHeroVoiceCanaryDispatchIntent({
        runId: reviewable.runId,
        ownerHmac,
        slotId: slot.slotId,
        prepared: preparedSlot,
        nowMs: 100_000 + reviewable.manifest.slots.indexOf(slot) * 10,
      });
      await recordHeroVoiceCanarySubmission({
        runId: reviewable.runId,
        ownerHmac,
        slotId: slot.slotId,
        disposition: "provider_accepted",
        providerJobId: `provider-${slot.ordinal}`,
        observedAtMs: 100_001 + reviewable.manifest.slots.indexOf(slot) * 10,
      });
      await recordHeroVoiceCanaryResult({
        runId: reviewable.runId,
        ownerHmac,
        slotId: slot.slotId,
        outcome: "valid_completed",
        primaryStatus: "completed",
        audioSha256: heroVoiceCanarySha256(wavBytes),
        durationMs: 1,
        delayTimeMs: 0,
        executionTimeMs: 1,
        observedAtMs: 100_002 + reviewable.manifest.slots.indexOf(slot) * 10,
      });
    }
  };
  const cerResults = (batchKind: "ablation-8" | "final-36") => reviewable.manifest.slots
    .filter((slot) => batchKind === "ablation-8" ? slot.phase === "ablation" : slot.phase !== "ablation")
    .map((slot) => ({
      slotId: slot.slotId,
      inputAudioSha256: heroVoiceCanarySha256(outputBySlot.get(slot.slotId)!),
      expectedTextSha256: slot.speechTextSha256,
      cerNumerator: 0,
      cerDenominator: 1,
    }));

  await recordSlots("ablation");
  await recordHeroVoiceCanaryCerBatch({
    runId: reviewable.runId,
    ownerHmac,
    evidence: syntheticEvaluatorEvidence("ablation-8"),
    results: cerResults("ablation-8"),
  });
  const ablationObjectiveRows = syntheticObjectiveEvidence("ablation-8", reviewable, outputBySlot).rows;
  const ablationObjective = await recordHeroVoiceCanaryObjectiveObservation({
    runId: reviewable.runId, ownerHmac, phase: "ablation-8", rows: ablationObjectiveRows,
    authority: objectiveAuthority, issuedAtMs: 100_000,
  });
  assert.equal(await finalizeHeroVoiceCanaryRun({
    runId: reviewable.runId,
    ownerHmac,
    evidence: syntheticEvaluatorEvidence("ablation-8"),
    objectiveEvidenceBytes: ablationObjective.bytes,
    objectiveEvidenceSha256: ablationObjective.sha256,
    objectiveEvidenceHmac: ablationObjective.hmac,
    objectiveAuthority,
  }), "running_baseline");
  await recordSlots("baseline");
  assert.equal(await finalizeHeroVoiceCanaryRun({
    runId: reviewable.runId,
    ownerHmac,
    evidence: syntheticEvaluatorEvidence("ablation-8"),
  }), "running_candidate");
  await recordSlots("candidate");
  await recordHeroVoiceCanaryCerBatch({
    runId: reviewable.runId,
    ownerHmac,
    evidence: syntheticEvaluatorEvidence("final-36"),
    results: cerResults("final-36"),
  });
  const finalObjectiveRows = syntheticObjectiveEvidence("final-36", reviewable, outputBySlot).rows;
  const finalObjective = await recordHeroVoiceCanaryObjectiveObservation({
    runId: reviewable.runId, ownerHmac, phase: "final-36", rows: finalObjectiveRows,
    authority: objectiveAuthority, issuedAtMs: 100_000,
  });
  assert.equal(await finalizeHeroVoiceCanaryRun({
    runId: reviewable.runId,
    ownerHmac,
    evidence: syntheticEvaluatorEvidence("final-36"),
    objectiveEvidenceBytes: finalObjective.bytes,
    objectiveEvidenceSha256: finalObjective.sha256,
    objectiveEvidenceHmac: finalObjective.hmac,
    objectiveAuthority,
  }), "reviewable");
  const completedLedger = await verifyHeroVoiceCanaryLedger({ runId: reviewable.runId, ownerHmac });
  const completedCounters = heroVoiceCanaryCounters(completedLedger);
  assert.deepEqual({
    intents: completedCounters.dispatchIntents,
    accepted: completedCounters.providerAccepted,
    valid: completedCounters.validCompleted,
    rejected: completedCounters.providerRejected,
    unknown: completedCounters.transportUnknown,
  }, { intents: 44, accepted: 44, valid: 44, rejected: 0, unknown: 0 });

  const reviewGitRoot = path.join(process.env.HERO_VOICE_CANARY_ROOT!, "git", "review-lifecycle.git");
  const reviewAuthority = new LocalBareGitCommitmentAuthority(reviewGitRoot);
  const finalOutputs = reviewable.manifest.slots
    .filter((slot) => slot.phase !== "ablation")
    .map((slot) => ({ slotId: slot.slotId, wavBytes: outputBySlot.get(slot.slotId)! }));
  const preReviewDirectory = path.join(process.env.HERO_VOICE_CANARY_REVIEW_ROOT!, reviewable.runId);
  let durablePreparationJson: string | null = null;
  for (const crashStep of [
    "after-review-preparation-commit", "after-review-remote-push-before-local-commit",
    "after-create", "after-write", "after-fsync", "before-rename", "after-rename",
    "after-review-cas-before-intent-commit",
  ] as const) {
    const child = spawnSync(process.execPath, [
      "--conditions=react-server", "--import", "tsx", process.argv[1],
      "--crash-review", reviewable.runId, crashStep,
    ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
    assert.equal(child.status, 97, `${crashStep}: ${child.stderr}`);
    await reconcileHeroVoiceDeletionTransactions();
    const runAfterCrash = await prisma.reviewRun.findUniqueOrThrow({ where: { id: reviewable.runId } });
    assert.equal(runAfterCrash.state, "preparing");
    assert.equal(runAfterCrash.revision, 1);
    assert.ok(runAfterCrash.reviewPreparationJson);
    if (durablePreparationJson === null) durablePreparationJson = runAfterCrash.reviewPreparationJson;
    else assert.equal(runAfterCrash.reviewPreparationJson, durablePreparationJson,
      "review retry must reuse the exact randomized reveal preparation");
    assert.equal(await prisma.deletionTransaction.count({
      where: { operationKind: "review_artifact_create", status: { in: ["planned", "db_committed"] } },
    }), 0);
    assert.ok(!fs.existsSync(preReviewDirectory) || fs.readdirSync(preReviewDirectory).length === 0);
  }
  setHeroVoiceDeletionCrashObserverForTests((step) => {
    if (step === "after-transaction-a") throw new HeroVoiceDeletionSimulatedCrash(step);
  });
  await assert.rejects(createHeroVoiceCanaryBlindReview({
    runId: reviewable.runId,
    ownerHmac,
    outputs: finalOutputs,
    authority: reviewAuthority,
  }), (error: unknown) => error instanceof HeroVoiceDeletionSimulatedCrash);
  setHeroVoiceDeletionCrashObserverForTests();
  await reconcileHeroVoiceDeletionTransactions();
  assert.equal(await prisma.deletionTransaction.count({
    where: { operationKind: "review_artifact_create", status: { in: ["planned", "db_committed"] } },
  }), 0);
  assert.ok(!fs.existsSync(preReviewDirectory) || fs.readdirSync(preReviewDirectory).length === 0);
  const createdReview = await createHeroVoiceCanaryBlindReview({
    runId: reviewable.runId,
    ownerHmac,
    outputs: finalOutputs,
    authority: reviewAuthority,
  });
  assert.equal(createdReview.revision, 2);
  const publicReview = await getHeroVoiceCanaryReview({ runId: reviewable.runId, ownerHmac });
  assert.deepEqual(Object.keys(publicReview).sort(), ["complete", "pairs", "revision", "state", "version"]);
  assert.equal(publicReview.pairs.length, 18);
  assert.equal(new Set(publicReview.pairs.map((pair) => pair.pairId)).size, 18);
  assert.equal(new Set(publicReview.pairs.flatMap((pair) => [pair.audio.A, pair.audio.B])).size, 36);
  assert.ok(publicReview.pairs.every((pair) => pair.score === null));
  assert.ok(publicReview.pairs.every((pair) => (
    JSON.stringify(Object.keys(pair).sort()) === JSON.stringify(["audio", "pairId", "score"])
    && /^[A-Za-z0-9_-]{22}$/u.test(pair.audio.A)
    && /^[A-Za-z0-9_-]{22}$/u.test(pair.audio.B)
  )));
  const preLockNetworkPayload = JSON.stringify(publicReview);
  for (const privateSentinel of [
    reviewable.manifest.identities.baseline.endpointId,
    reviewable.manifest.identities.candidate.endpointId,
    reviewable.manifest.identities.baseline.imageDigest,
    reviewable.manifest.identities.candidate.imageDigest,
    reviewable.manifest.identities.candidate.sourceRevision,
    reviewable.manifest.identities.candidate.modelManifestSha256,
    HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
    ...reviewable.manifest.slots.map((slot) => slot.slotId),
  ]) assert.equal(preLockNetworkPayload.includes(privateSentinel), false);
  await assert.rejects(
    getHeroVoiceCanaryReview({ runId: reviewable.runId, ownerHmac: "e".repeat(64) }),
    (error: unknown) => error instanceof HeroVoiceCanaryReviewError && error.status === 404,
  );
  const firstAudio = await readHeroVoiceCanaryReviewAudio({
    runId: reviewable.runId,
    ownerHmac,
    token: publicReview.pairs[0].audio.A,
  });
  assert.ok(finalOutputs.some((output) => output.wavBytes.equals(firstAudio)));
  await assert.rejects(readHeroVoiceCanaryReviewAudio({
    runId: reviewable.runId, ownerHmac, token: "A".repeat(22),
  }), (error: unknown) => error instanceof HeroVoiceCanaryReviewError && error.status === 404);
  assert.throws(() => parseHeroVoiceCanaryScore({
    choice: "A", flagsBySide: { A: ["wrong_identity", "wrong_identity"], B: [] },
  }, publicReview.pairs[0].pairId));

  let reviewRevision = createdReview.revision;
  await assert.rejects(lockHeroVoiceCanaryReview({
    runId: reviewable.runId,
    ownerHmac,
    expectedRevision: reviewRevision,
    authority: reviewAuthority,
  }));
  for (const [index, pair] of publicReview.pairs.entries()) {
    const score = parseHeroVoiceCanaryScore({
      choice: index % 3 === 0 ? "tie" : index % 2 === 0 ? "A" : "B",
      flagsBySide: { A: [], B: [] },
    }, pair.pairId);
    const saved = await putHeroVoiceCanaryScore({
      runId: reviewable.runId,
      ownerHmac,
      pairId: pair.pairId,
      expectedRevision: reviewRevision,
      score,
    });
    if (index === 0) {
      await assert.rejects(putHeroVoiceCanaryScore({
        runId: reviewable.runId,
        ownerHmac,
        pairId: pair.pairId,
        expectedRevision: reviewRevision,
        score,
      }));
    }
    reviewRevision = saved.revision;
  }
  const locked = await lockHeroVoiceCanaryReview({
    runId: reviewable.runId,
    ownerHmac,
    expectedRevision: reviewRevision,
    authority: reviewAuthority,
  });
  await assert.rejects(putHeroVoiceCanaryScore({
    runId: reviewable.runId,
    ownerHmac,
    pairId: publicReview.pairs[0].pairId,
    expectedRevision: locked.revision,
    score: parseHeroVoiceCanaryScore({ choice: "tie", flagsBySide: { A: [], B: [] } }, publicReview.pairs[0].pairId),
  }));
  const lockedRow = await prisma.reviewRun.findUniqueOrThrow({ where: { id: reviewable.runId } });
  await prisma.reviewRun.update({ where: { id: reviewable.runId }, data: { scoreSheetHmac: "f".repeat(64) } });
  await assert.rejects(revealHeroVoiceCanaryReview({
    runId: reviewable.runId,
    ownerHmac,
    expectedRevision: locked.revision,
    authority: reviewAuthority,
  }));
  await prisma.reviewRun.update({ where: { id: reviewable.runId }, data: { scoreSheetHmac: lockedRow.scoreSheetHmac } });
  const revealed = await revealHeroVoiceCanaryReview({
    runId: reviewable.runId,
    ownerHmac,
    expectedRevision: locked.revision,
    authority: reviewAuthority,
  });
  assert.equal((revealed.aggregates as { completePairs: number }).completePairs, 18);
  assert.equal(revealed.armsByPair.length, 18);
  assert.ok(revealed.armsByPair.every((pair) => new Set([pair.A, pair.B]).size === 2));
  const revealedReview = await getHeroVoiceCanaryReview({
    runId: reviewable.runId, ownerHmac, authority: reviewAuthority,
  });
  assert.ok(revealedReview.pairs.every((pair) => (
    pair.labels && new Set([pair.labels.A, pair.labels.B]).size === 2
  )));
  const closed = await closeHeroVoiceCanaryReview({
    runId: reviewable.runId,
    ownerHmac,
    expectedRevision: revealed.revision,
  });
  assert.equal(closed.revision, revealed.revision + 1);
  const closedRow = await prisma.reviewRun.findUniqueOrThrow({ where: { id: reviewable.runId } });
  assert.equal(closedRow.state, "closed");
  assert.equal(closedRow.ledgerSequence, 0);
  assert.equal(closedRow.ledgerHeadHmac, null);
  assert.equal(await prisma.canaryLedgerRecord.count({ where: { runId: reviewable.runId } }), 0);
  assert.equal(await prisma.canarySubmitNonce.count({ where: { runId: reviewable.runId } }), 0);
  const closedReviewDirectory = path.join(process.env.HERO_VOICE_CANARY_REVIEW_ROOT!, reviewable.runId);
  assert.ok(!fs.existsSync(closedReviewDirectory) || fs.readdirSync(closedReviewDirectory).length === 0);
  await assert.rejects(getHeroVoiceCanaryReview({ runId: reviewable.runId, ownerHmac }));

  // The database triggers already rejected ordinary mutation/deletion/gaps.
  // Drop only the update trigger in this disposable test database to prove the
  // HMAC verifier also detects adversarial mutation and row reordering.
  await prisma.$executeRawUnsafe('DROP TRIGGER "CanaryLedgerRecord_update_forbidden"');
  await prisma.$executeRawUnsafe(
    'UPDATE "CanaryLedgerRecord" SET "recordJson" = ? WHERE "id" = ?',
    "{}",
    first.id,
  );
  await assert.rejects(verifyHeroVoiceCanaryLedger({ runId: rejected.runId, ownerHmac }));

  const reorderRows = await prisma.canaryLedgerRecord.findMany({
    where: { runId: restart.runId }, orderBy: { sequence: "asc" }, take: 2,
  });
  assert.equal(reorderRows.length, 2);
  await prisma.$executeRawUnsafe(
    'UPDATE "CanaryLedgerRecord" SET "sequence" = 99 WHERE "id" = ?', reorderRows[0].id,
  );
  await prisma.$executeRawUnsafe(
    'UPDATE "CanaryLedgerRecord" SET "sequence" = 1 WHERE "id" = ?', reorderRows[1].id,
  );
  await prisma.$executeRawUnsafe(
    'UPDATE "CanaryLedgerRecord" SET "sequence" = 2 WHERE "id" = ?', reorderRows[0].id,
  );
  await assert.rejects(verifyHeroVoiceCanaryLedger({ runId: restart.runId, ownerHmac }));

  await prisma.siteConfig.create({
    data: { key: "hero_voice_canary_ledger_mutation_guard_v1", value: admissionRun.runId },
  });
  await prisma.canaryLedgerRecord.deleteMany({ where: { runId: admissionRun.runId } });
  await prisma.siteConfig.delete({ where: { key: "hero_voice_canary_ledger_mutation_guard_v1" } });
  await assert.rejects(verifyHeroVoiceCanaryLedger({ runId: admissionRun.runId, ownerHmac }));

  await prisma.$disconnect();
  console.log("Hero Voice Task 5 ledger mutation/gap/reorder/truncation/restart, nonce race, Git object, and 18-pair lifecycle verified.");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
