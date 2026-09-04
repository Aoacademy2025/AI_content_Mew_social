import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pcm16Wav(durationMs: number): Buffer {
  const samples = Math.round(24_000 * durationMs / 1_000);
  const pcm = Buffer.alloc(samples * 2, 1);
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

process.env.OMNIVOICE_ENABLED = "1";
process.env.HERO_VOICE_CLONING_ENABLED = "1";
process.env.OMNIVOICE_BACKEND = "runpod";
process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID = "stock-unchanged";
process.env.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID = "clone-matrix";
process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
const SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb";
const PRIVATE_SENTINEL = "RefSecret_K9v7T2mQ4xL8pZ6nR3cW1yH5";
const API_SECRET_SENTINEL = "Rpk_6Jt9Qv3Nz8Ls2Hx7Wm4Bc1Ya5Fd0";
process.env.RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION = SOURCE_REVISION;
process.env.RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256 = "3".repeat(64);
process.env.RUNPOD_API_KEY = API_SECRET_SENTINEL;
process.env.HERO_VOICE_CANARY_EXECUTION_MODE = "1";
process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = "4".repeat(64);
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "hero-task2-runtime-"));
process.env.USER_VOICE_STORAGE_DIR = storage;

type Scenario =
  | "unknown" | "reject" | "poll-unavailable" | "malformed" | "missing"
  | "identity" | "output" | "success" | "cancel-unconfirmed"
  | "submit-read-fail" | "submit-oversized" | "submit-stream-oversized" | "poll-read-fail" | "cancel-read-fail"
    | "delayed-submit" | "delayed-poll-success" | "delayed-poll-unavailable";
let scenario: Scenario = "success";
let serial = 0;
let pollCalls = 0;
let cancelCalls = 0;
const cancelledProviderJobIds: string[] = [];
const cancelledEndpoints: string[] = [];
const requests = new Map<string, Record<string, unknown>>();
const output = pcm16Wav(1_000);
const originalFetch = globalThis.fetch;
let submitReached: (() => void) | null = null;
let releaseSubmit: (() => void) | null = null;
let pollReached: (() => void) | null = null;
let releasePoll: (() => void) | null = null;

function brokenJsonResponse(): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.error(new TypeError(PRIVATE_SENTINEL));
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function successEnvelope(request: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    contract_version: 3,
    mode: "clone",
    worker_kind: "clone-only",
    worker_version: "hero-voice-clone-contract-v3-internal-eval-2",
    image_digest: `sha256:${"1".repeat(64)}`,
    source_revision: SOURCE_REVISION,
    model_manifest_sha256: "3".repeat(64),
    experiment_profile: "combined-quality-v1",
    normalizer_version: "2026-07-24.1",
    mixed_language: true,
    request_commitment_sha256: request.request_commitment_sha256,
    matched_settings_sha256: request.matched_settings_sha256,
    audio_base64: output.toString("base64"),
    format: "wav",
    sample_rate: 24_000,
    channels: 1,
    subtype: "PCM_16",
    num_samples: 24_000,
    duration_ms: 1_000,
    stages: [
      ["speech_text_attestation", "application-speech-text/no-worker-rewrite-v1"],
      ["reference_decode", "riff-wave/mono-24000-pcm16-v1"],
      ["demucs_reference_enhancement", "demucs/e976d93ecc3865e5757426930257e200846a520a/955717e8/shifts-0_split-true_overlap-0.25_segment-7/vocals-mean-mono"],
      ["reference_peak_normalize", "float32/peak-0.95-v1"],
      ["reference_resample_24000", "scipy-resample-poly/mono-24000-v1"],
      ["omnivoice_prompt", "omnivoice/346bb75330980a236540d61a0808d00767c0973b/zero-shot-clone-prompt"],
      ["omnivoice_generate_three", "omnivoice/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/best-of-3/temperature-0.8/seed-sequence-v1"],
      ["speaker_pitch_rank", "resemblyzer+librosa.pyin-C2-C6/cosine+0.15*pitch-v1"],
      ["output_validate_pcm16", "wave/mono-24000-pcm16/max-7000000-v1"],
    ].map(([name, identity]) => ({ name, identity })),
    metrics: {
      reference: {
        input_sha256: createHash("sha256").update(Buffer.from(request.ref_audio_b64 as string, "base64")).digest("hex"),
        canonical_sha256: "a".repeat(64),
        effective_sha256: "b".repeat(64),
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
        { index: 0, audio_sha256: "c".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.8, pitch_similarity_normalized: 0.5, ranking_score: 0.8 + 0.15 * 0.5 },
        { index: 1, audio_sha256: "d".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.7, pitch_similarity_normalized: 0.9, ranking_score: 0.7 + 0.15 * 0.9 },
        { index: 2, audio_sha256: "e".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.6, pitch_similarity_normalized: 0.2, ranking_score: 0.6 + 0.15 * 0.2 },
      ],
      selected_candidate_index: 0,
      ranking_formula: "speaker_cosine+0.15*pitch_similarity_normalized", watermark: null,
    },
    timing_ms: { reference: 1, prompt: 1, synthesis: 1, ranking: 1, watermark: 0, encode: 1, total: 5 },
    ...overrides,
  };
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.endsWith("/run")) {
    if (scenario === "unknown") throw new TypeError(`transport failed with ${PRIVATE_SENTINEL}`);
    if (scenario === "submit-read-fail") return brokenJsonResponse();
    if (scenario === "submit-oversized") {
      return new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 + 1) } });
    }
    if (scenario === "submit-stream-oversized") {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(40 * 1024));
          controller.enqueue(new Uint8Array(40 * 1024));
          controller.close();
        },
      }), { status: 200 });
    }
    if (scenario === "reject") {
      return Response.json({ error: PRIVATE_SENTINEL }, { status: 400 });
    }
    const rawBody: unknown = init?.body;
    assert.equal(Buffer.isBuffer(rawBody), true,
      "clone dispatch hands the previously verified exact Buffer to fetch");
    const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "{}") as {
      input: Record<string, unknown>;
      policy: Record<string, unknown>;
    };
    assert.deepEqual(body.policy, { executionTimeout: 540_000, ttl: 900_000 });
    const providerJobId = `${scenario}-${++serial}`;
    requests.set(providerJobId, body.input);
    if (scenario === "delayed-submit") {
      await new Promise<void>((resolve) => {
        releaseSubmit = resolve;
        submitReached?.();
      });
    }
    return Response.json({ id: providerJobId, status: "IN_QUEUE" });
  }
  const statusMatch = /\/status\/([^/]+)$/.exec(url);
  if (statusMatch) {
    pollCalls += 1;
    const providerJobId = statusMatch[1];
    if (scenario === "poll-unavailable") throw new TypeError(PRIVATE_SENTINEL);
    if (scenario === "poll-read-fail") return brokenJsonResponse();
    if (scenario === "missing") return Response.json({ error: PRIVATE_SENTINEL }, { status: 404 });
    if (scenario === "malformed") return Response.json({ id: providerJobId, status: "MYSTERY", text: PRIVATE_SENTINEL });
    const request = requests.get(providerJobId)!;
    if (scenario === "delayed-poll-success") {
      await new Promise<void>((resolve) => {
        releasePoll = resolve;
        pollReached?.();
      });
    }
    if (scenario === "delayed-poll-unavailable") {
      const delayedSignal = pollReached;
      if (delayedSignal) {
        await new Promise<void>((resolve) => {
          releasePoll = resolve;
          delayedSignal();
        });
      }
      throw new TypeError(PRIVATE_SENTINEL);
    }
    if (scenario === "identity") {
      return Response.json({ id: providerJobId, status: "COMPLETED", output: successEnvelope(request, {
        image_digest: `sha256:${"9".repeat(64)}`,
      }) });
    }
    if (scenario === "output") {
      return Response.json({ id: providerJobId, status: "COMPLETED", output: successEnvelope(request, {
        audio_base64: "AAAA",
      }) });
    }
    return Response.json({ id: providerJobId, status: "COMPLETED", output: successEnvelope(request) });
  }
  const cancelMatch = /\/cancel\/([^/]+)$/.exec(url);
  if (cancelMatch) {
    cancelCalls += 1;
    cancelledProviderJobIds.push(cancelMatch[1]);
    cancelledEndpoints.push(new URL(url).pathname.split("/").at(-3) ?? "");
    if (scenario === "cancel-read-fail") return brokenJsonResponse();
    if (scenario === "cancel-unconfirmed" || scenario === "poll-unavailable") {
      return Response.json({ error: PRIVATE_SENTINEL }, { status: 500 });
    }
    return Response.json({ id: cancelMatch[1], status: "CANCELLED" });
  }
  return Response.json({ error: "unexpected" }, { status: 500 });
};

async function main() {
  const [{ prisma }, hero, voices, snapshotModule, omnivoice, stateModule, runnerModule] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/hero-voice-generation.server"),
    import("../src/lib/user-voices.server"),
    import("../src/lib/hero-voice-clone-snapshot"),
    import("../src/lib/omnivoice"),
    import("../src/lib/hero-voice-clone-state"),
    import("../src/lib/hero-voice-clone-runners"),
  ]);
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: {
      name: "Task2 owner",
      email: "task2@aoacademy.co",
      plan: "PRO",
      planExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      usagePeriodStartedAt: new Date(),
      role: "USER",
      minutesLimit: 1_000,
    },
  });
  process.env.OMNIVOICE_ALLOWED_USER_IDS = user.id;
  const refFilename = "22222222-2222-4222-8222-222222222222.wav";
  const reference = pcm16Wav(8_000);
  const refText = `${PRIVATE_SENTINEL} เสียงอ้างอิงยาวแปดวินาที`;
  fs.writeFileSync(path.join(storage, refFilename), reference, { mode: 0o600 });
  const voice = await prisma.userVoice.create({
    data: { userId: user.id, name: "Q", refText, filename: refFilename, durationMs: 8_000 },
  });
  const voiceId = voices.userVoiceIdFor(voice.id);

  const usage = async () => prisma.user.findUniqueOrThrow({
    where: { id: user.id }, select: { aiAudioMinutesUsed: true, minutesUsed: true },
  });
  const assertUsageEqual = (
    actual: Awaited<ReturnType<typeof usage>>,
    expected: Awaited<ReturnType<typeof usage>>,
    message?: string,
  ) => {
    assert.ok(Math.abs(actual.aiAudioMinutesUsed - expected.aiAudioMinutesUsed) < 1e-9, message);
    assert.equal(actual.minutesUsed, expected.minutesUsed, message);
  };
  const start = (key: string) => hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text: `ทดสอบสถานะ ${key}`,
    voiceId,
    speed: 1,
    studio: true,
    cloneCanarySurface: "ai-studio",
    cloneSeed: 104729,
    idempotencyKey: `task2-${key}`,
  });
  const assertReleasedOnce = async (jobId: string, before: Awaited<ReturnType<typeof usage>>) => {
    const after = await usage();
    assertUsageEqual(after, before);
    await hero.advanceHeroVoiceGeneration(user.id, jobId);
    assertUsageEqual(await usage(), before, "terminal replay cannot release twice");
  };

  const jobsBeforeConfigFailure = await prisma.aiGenerationJob.count({ where: { userId: user.id } });
  const usageBeforeConfigFailure = await usage();
  delete process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST;
  await assert.rejects(() => start("missing-config"), omnivoice.HeroVoiceCloneConfigError);
  process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
  delete process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
  await assert.rejects(() => start("missing-human-gate"), omnivoice.HeroVoiceCloneConfigError);
  process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = "4".repeat(64);
  assert.equal(await prisma.aiGenerationJob.count({ where: { userId: user.id } }), jobsBeforeConfigFailure);
  assertUsageEqual(await usage(), usageBeforeConfigFailure, "config/gate failures create no reservation");

  scenario = "unknown";
  const beforeUnknown = await usage();
  const unknown = await start("unknown");
  assert.equal(unknown.job.status, "failed_unknown_submit");
  assert.equal(unknown.job.chargeState, "refunded");
  assert.equal(unknown.job.externalRunDisposition, "abort_required");
  const unknownAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: unknown.job.id } });
  assert.ok(unknownAttempt.dispatchIntentAt);
  assert.equal(unknownAttempt.status, "failed_unknown_submit");
  assert.ok(stateModule.heroVoiceCloneExternalAbortDirective({ ...unknown.job, dispatchIntentAt: unknownAttempt.dispatchIntentAt }));
  await assertReleasedOnce(unknown.job.id, beforeUnknown);

  for (const readScenario of ["submit-read-fail", "submit-oversized", "submit-stream-oversized"] as const) {
    scenario = readScenario;
    const before = await usage();
    const result = await start(readScenario);
    assert.equal(result.job.status, "failed_unknown_submit");
    assert.equal(result.job.errorCode, "CLONE_SUBMIT_OUTCOME_UNKNOWN");
    assert.equal(result.job.externalRunDisposition, "abort_required");
    await assertReleasedOnce(result.job.id, before);
  }

  scenario = "reject";
  const beforeReject = await usage();
  const rejected = await start("reject");
  assert.equal(rejected.job.status, "failed");
  assert.equal(rejected.job.errorCode, "CLONE_SUBMIT_REJECTED");
  assert.equal((rejected.job.errorMessage ?? "").includes(PRIVATE_SENTINEL), false);
  await assertReleasedOnce(rejected.job.id, beforeReject);

  for (const [kind, expectedStatus, expectedCode] of [
    ["malformed", "failed_provider_status", "CLONE_PROVIDER_STATUS_INVALID"],
    ["missing", "failed_provider_missing", "CLONE_PROVIDER_JOB_MISSING"],
  ] as const) {
    scenario = kind;
    const before = await usage();
    const started = await start(kind);
    const failed = await hero.advanceHeroVoiceGeneration(user.id, started.job.id);
    assert.equal(failed.status, expectedStatus);
    assert.equal(failed.errorCode, expectedCode);
    assert.equal(failed.cancelDisposition, "confirmed");
    assert.equal((failed.errorMessage ?? "").includes(PRIVATE_SENTINEL), false);
    await assertReleasedOnce(failed.id, before);
  }

  scenario = "poll-unavailable";
  const beforePoll = await usage();
  const pollStarted = await start("poll");
  const pollsBefore = pollCalls;
  const cancelsBefore = cancelCalls;
  const pollBackoffMs = [2_000, 5_000, 10_000] as const;
  for (let failure = 1; failure <= 3; failure++) {
    await prisma.aiGenerationAttempt.updateMany({
      where: { jobId: pollStarted.job.id },
      data: { nextPollAt: new Date(0) },
    });
    const beforePollAt = Date.now();
    const concurrentPollsBefore = pollCalls;
    const concurrentResults = await Promise.all([
      hero.advanceHeroVoiceGeneration(user.id, pollStarted.job.id),
      hero.advanceHeroVoiceGeneration(user.id, pollStarted.job.id),
    ]);
    const current = concurrentResults.find((result) => result.status === "queued")!;
    const persistedAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({
      where: { jobId: pollStarted.job.id },
    });
    assert.equal(persistedAttempt.pollFailureCount, failure);
    assert.ok(persistedAttempt.nextPollAt);
    const persistedBackoffMs = persistedAttempt.nextPollAt.getTime() - beforePollAt;
    assert.ok(
      persistedBackoffMs >= pollBackoffMs[failure - 1]
        && persistedBackoffMs <= pollBackoffMs[failure - 1] + 2_000,
      `poll failure ${failure} must persist the exact bounded backoff`,
    );
    assert.equal(current.status, "queued", "all three transport failures persist their exact delay first");
    assert.equal(pollCalls - concurrentPollsBefore, 1,
      `concurrent failure ${failure} may consume exactly one ${pollBackoffMs[failure - 1]}ms backoff step`);
  }
  assert.equal(pollCalls - pollsBefore, 3);
  await prisma.aiGenerationAttempt.updateMany({
    where: { jobId: pollStarted.job.id },
    data: { nextPollAt: new Date(0) },
  });
  const terminalAfterThirdDelay = await hero.advanceHeroVoiceGeneration(user.id, pollStarted.job.id);
  assert.equal(terminalAfterThirdDelay.status, "failed_poll_unavailable");
  assert.equal(terminalAfterThirdDelay.errorCode, "CLONE_POLL_UNAVAILABLE");
  assert.equal(terminalAfterThirdDelay.cancelDisposition, "rejected_or_unknown");
  assert.equal(pollCalls - pollsBefore, 3, "the terminal boundary cannot issue a fourth status request");
  assert.equal(cancelCalls - cancelsBefore, 1);
  await assertReleasedOnce(pollStarted.job.id, beforePoll);
  assert.equal(cancelCalls - cancelsBefore, 1, "terminal resume cannot issue a second cancel");

  scenario = "delayed-poll-unavailable";
  const beforeStalePoll = await usage();
  const stalePollStarted = await start("stale-poll-failure-cas");
  let signalStalePollReached!: () => void;
  const stalePollWasReached = new Promise<void>((resolve) => { signalStalePollReached = resolve; });
  pollReached = signalStalePollReached;
  const delayedFailure = hero.advanceHeroVoiceGeneration(user.id, stalePollStarted.job.id);
  await stalePollWasReached;
  pollReached = null;
  await prisma.aiGenerationAttempt.updateMany({
    where: { jobId: stalePollStarted.job.id },
    data: { pollLeaseExpiresAt: new Date(0) },
  });
  await hero.advanceHeroVoiceGeneration(user.id, stalePollStarted.job.id);
  const authoritativeFailure = await prisma.aiGenerationAttempt.findFirstOrThrow({
    where: { jobId: stalePollStarted.job.id },
  });
  assert.equal(authoritativeFailure.pollFailureCount, 1);
  assert.ok(authoritativeFailure.nextPollAt);
  const authoritativeNextPollAt = authoritativeFailure.nextPollAt.getTime();
  releasePoll?.();
  await delayedFailure;
  releasePoll = null;
  const afterStaleFailure = await prisma.aiGenerationAttempt.findFirstOrThrow({
    where: { jobId: stalePollStarted.job.id },
  });
  assert.equal(afterStaleFailure.pollFailureCount, 1,
    "an expired delayed poll lease cannot overwrite the authoritative failure count");
  assert.equal(afterStaleFailure.nextPollAt?.getTime(), authoritativeNextPollAt,
    "an expired delayed poll lease cannot repeat or lower the 2-second backoff");
  scenario = "success";
  await hero.cancelHeroVoiceGeneration(user.id, stalePollStarted.job.id);
  assertUsageEqual(await usage(), beforeStalePoll);

  scenario = "poll-read-fail";
  const beforePollRead = await usage();
  const pollReadStarted = await start("poll-read-fail");
  const pollRead = await hero.advanceHeroVoiceGeneration(user.id, pollReadStarted.job.id);
  const pollReadAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: pollRead.id } });
  assert.equal(pollRead.status, "queued");
  assert.equal(pollReadAttempt.pollFailureCount, 1, "body stream errors map to poll_transport backoff");
  scenario = "success";
  await hero.cancelHeroVoiceGeneration(user.id, pollRead.id);
  assertUsageEqual(await usage(), beforePollRead);

  for (const [kind, expectedStatus] of [["identity", "failed_identity"], ["output", "failed_output"]] as const) {
    scenario = kind;
    const before = await usage();
    const started = await start(kind);
    const failed = await hero.advanceHeroVoiceGeneration(user.id, started.job.id);
    assert.equal(failed.status, expectedStatus);
    assert.equal(failed.cancelDisposition, "not_requested", "completed provider work is not canceled retroactively");
    await assertReleasedOnce(failed.id, before);
  }

  scenario = "success";
  const successStarted = await start("success");
  const reservedState = JSON.parse(successStarted.job.inputJson ?? "{}") as {
    aiReservedMin: number;
    studioReservedMin: number;
  };
  const reservedAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: successStarted.job.id } });
  assert.equal(successStarted.job.chargeState, "reserved");
  assert.ok(successStarted.job.reservedAiAudioMinutes > 0);
  assert.equal(successStarted.job.reservedAiAudioMinutes, reservedState.aiReservedMin);
  assert.equal(successStarted.job.reservedStudioMinutes, reservedState.studioReservedMin);
  assert.equal(reservedAttempt.submissionDisposition, "provider_accepted");
  assert.ok(reservedAttempt.dispatchIntentAt && reservedAttempt.providerResponseAt);
  const success = await hero.advanceHeroVoiceGeneration(user.id, successStarted.job.id);
  assert.equal(success.status, "completed");
  assert.equal(success.chargeState, "settled");
  const settledUsage = await usage();
  await hero.advanceHeroVoiceGeneration(user.id, success.id);
  assertUsageEqual(await usage(), settledUsage, "completed replay cannot settle twice");
  const persistedAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: success.id } });
  const persistedState = JSON.parse(success.inputJson ?? "{}") as { cloneSnapshots: unknown[] };
  assert.equal(persistedAttempt.inputJson, JSON.stringify(persistedState.cloneSnapshots[0]));
  const persisted = `${success.inputJson}\n${persistedAttempt.inputJson}\n${success.errorMessage ?? ""}`;
  for (const secret of [reference.toString("base64"), refText, path.join(storage, refFilename), user.id, process.env.RUNPOD_API_KEY!]) {
    assert.equal(persisted.includes(secret), false, "durable state contains no reference/user/path/secret sentinel");
  }

  scenario = "cancel-unconfirmed";
  const beforeCancel = await usage();
  const cancelStarted = await start("cancel");
  const cancelBefore = cancelCalls;
  const canceled = await hero.cancelHeroVoiceGeneration(user.id, cancelStarted.job.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.cancelDisposition, "rejected_or_unknown");
  await hero.cancelHeroVoiceGeneration(user.id, canceled.id);
  assert.equal(cancelCalls - cancelBefore, 1);
  assertUsageEqual(await usage(), beforeCancel);

  scenario = "cancel-read-fail";
  const beforeCancelRead = await usage();
  const cancelReadStarted = await start("cancel-read-fail");
  const cancelRead = await hero.cancelHeroVoiceGeneration(user.id, cancelReadStarted.job.id);
  assert.equal(cancelRead.status, "canceled");
  assert.equal(cancelRead.cancelDisposition, "rejected_or_unknown");
  assertUsageEqual(await usage(), beforeCancelRead);

  scenario = "delayed-submit";
  let signalSubmitReached!: () => void;
  const submitWasReached = new Promise<void>((resolve) => { signalSubmitReached = resolve; });
  submitReached = signalSubmitReached;
  const beforeSubmitCancelRace = await usage();
  const delayedStartPromise = start("delayed-submit-cancel-race");
  await submitWasReached;
  const racingJob = await prisma.aiGenerationJob.findFirstOrThrow({
    where: { userId: user.id, idempotencyKey: "task2-delayed-submit-cancel-race" },
  });
  const canceledWhileSubmitting = await hero.cancelHeroVoiceGeneration(user.id, racingJob.id);
  assert.equal(canceledWhileSubmitting.status, "canceled");
  const cancelBeforeLateSubmit = cancelCalls;
  releaseSubmit?.();
  const delayedStart = await delayedStartPromise;
  submitReached = null;
  releaseSubmit = null;
  assert.equal(delayedStart.job.status, "canceled");
  const lateAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: racingJob.id } });
  assert.ok(lateAttempt.providerJobId, "a late accepted provider id is never discarded");
  assert.equal(lateAttempt.status, "canceled", "late provider acceptance cannot rewrite the primary terminal state");
  assert.equal(lateAttempt.submissionDisposition, "provider_accepted");
  assert.equal(lateAttempt.cancelDisposition, "confirmed");
  assert.equal(cancelCalls - cancelBeforeLateSubmit, 1, "the late accepted provider run is canceled exactly once");
  assertUsageEqual(await usage(), beforeSubmitCancelRace);

  scenario = "success";
  const beforeAtomicCollision = await usage();
  const submissionsBeforeAtomicCollision = requests.size;
  const atomicCollision = await Promise.all([
    start("atomic-idempotency-collision"),
    start("atomic-idempotency-collision"),
  ]);
  assert.equal(new Set(atomicCollision.map(({ job }) => job.id)).size, 1);
  assert.deepEqual(atomicCollision.map(({ created }) => created).sort(), [false, true]);
  assert.equal(requests.size - submissionsBeforeAtomicCollision, 1, "one atomic reservation creates one provider dispatch");
  const atomicJob = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: atomicCollision[0].job.id } });
  const afterAtomicCollision = await usage();
  assert.ok(Math.abs(
    afterAtomicCollision.aiAudioMinutesUsed - beforeAtomicCollision.aiAudioMinutesUsed
      - atomicJob.reservedAiAudioMinutes,
  ) < 1e-9, "idempotent collision reserves AI audio exactly once");
  assert.equal(
    afterAtomicCollision.minutesUsed - beforeAtomicCollision.minutesUsed,
    atomicJob.reservedStudioMinutes,
    "idempotent collision reserves studio minutes exactly once",
  );
  await hero.cancelHeroVoiceGeneration(user.id, atomicJob.id);
  assertUsageEqual(await usage(), beforeAtomicCollision);

  const beforeConcurrentPoll = await usage();
  const concurrentPollStarted = await start("single-poller");
  const pollsBeforeConcurrent = pollCalls;
  await Promise.all([
    hero.advanceHeroVoiceGeneration(user.id, concurrentPollStarted.job.id),
    hero.advanceHeroVoiceGeneration(user.id, concurrentPollStarted.job.id),
  ]);
  const concurrentPollFinished = await prisma.aiGenerationJob.findUniqueOrThrow({
    where: { id: concurrentPollStarted.job.id },
  });
  assert.equal(concurrentPollFinished.status, "completed");
  assert.equal(pollCalls - pollsBeforeConcurrent, 1, "the durable poll lease permits only one status request");
  assert.ok((await usage()).aiAudioMinutesUsed > beforeConcurrentPoll.aiAudioMinutesUsed);

  scenario = "delayed-poll-success";
  const beforePollCancelRace = await usage();
  const delayedPollStarted = await start("delayed-poll-cancel-race");
  let signalPollReached!: () => void;
  const pollWasReached = new Promise<void>((resolve) => { signalPollReached = resolve; });
  pollReached = signalPollReached;
  const delayedAdvancePromise = hero.advanceHeroVoiceGeneration(user.id, delayedPollStarted.job.id);
  await pollWasReached;
  const cancelsBeforePollRace = cancelCalls;
  const canceledDuringPoll = await hero.cancelHeroVoiceGeneration(user.id, delayedPollStarted.job.id);
  assert.equal(canceledDuringPoll.status, "canceled");
  releasePoll?.();
  const stalePollResult = await delayedAdvancePromise;
  pollReached = null;
  releasePoll = null;
  assert.equal(stalePollResult.status, "canceled", "a late COMPLETED poll cannot overwrite owner cancellation");
  assert.equal(cancelCalls - cancelsBeforePollRace, 1);
  const persistedPollRace = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: delayedPollStarted.job.id } });
  assert.equal(persistedPollRace.status, "canceled");
  assert.equal(persistedPollRace.chargeState, "refunded");
  assertUsageEqual(await usage(), beforePollCancelRace);

  const assertCorruptTerminal = async (
    label: string,
    mutate: (jobId: string) => Promise<string | void>,
    expectedCancelRequests = 1,
    expectedCancelDisposition = expectedCancelRequests ? "confirmed" : "rejected_or_unknown",
  ) => {
    scenario = "success";
    const before = await usage();
    const started = await start(`corrupt-${label}`);
    const expectedProviderJobId = await mutate(started.job.id);
    const cancelsBeforeCorrupt = cancelCalls;
    const failed = await hero.advanceHeroVoiceGeneration(user.id, started.job.id);
    assert.equal(failed.status, "failed_identity", `${label} must terminalize as identity failure`);
    assert.equal(failed.errorCode, "CLONE_SNAPSHOT_INVALID");
    assert.equal(failed.chargeState, "refunded");
    assert.equal(failed.externalRunDisposition, "abort_required");
    assert.ok(failed.cancelAttemptedAt, `${label} must durably close the cancel decision exactly once`);
    assert.equal(cancelCalls - cancelsBeforeCorrupt, expectedCancelRequests);
    assert.equal(failed.cancelDisposition, expectedCancelDisposition);
    await hero.advanceHeroVoiceGeneration(user.id, started.job.id);
    assert.equal(cancelCalls - cancelsBeforeCorrupt, expectedCancelRequests, `${label} replay cannot cancel twice`);
    if (typeof expectedProviderJobId === "string") {
      assert.ok(cancelledProviderJobIds.slice(-expectedCancelRequests).includes(expectedProviderJobId),
        `${label} must cancel the authoritative job-level provider id`);
      assert.equal(cancelledEndpoints.at(-1), "clone-matrix",
        `${label} must cancel through the authoritative job-level endpoint`);
    }
    assertUsageEqual(await usage(), before);
  };
  await assertCorruptTerminal("job-extra", async (jobId) => {
    const value = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    await prisma.aiGenerationJob.update({
      where: { id: jobId },
      data: { inputJson: JSON.stringify({ ...JSON.parse(value.inputJson ?? "{}"), unexpected: true }) },
    });
  });
  await assertCorruptTerminal("job-missing", async (jobId) => {
    const value = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    const state = JSON.parse(value.inputJson ?? "{}") as Record<string, unknown>;
    delete state.cloneSnapshots;
    await prisma.aiGenerationJob.update({ where: { id: jobId }, data: { inputJson: JSON.stringify(state) } });
  });
  await assertCorruptTerminal("job-malformed", async (jobId) => {
    await prisma.aiGenerationJob.update({ where: { id: jobId }, data: { inputJson: "{" } });
  });
  await assertCorruptTerminal("job-snapshot-extra", async (jobId) => {
    const value = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    const state = JSON.parse(value.inputJson ?? "{}") as { cloneSnapshots: unknown[] };
    state.cloneSnapshots.push(structuredClone(state.cloneSnapshots[0]));
    await prisma.aiGenerationJob.update({ where: { id: jobId }, data: { inputJson: JSON.stringify(state) } });
  });
  await assertCorruptTerminal("job-snapshot-malformed", async (jobId) => {
    const value = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    const state = JSON.parse(value.inputJson ?? "{}") as { cloneSnapshots: Array<Record<string, unknown>> };
    state.cloneSnapshots[0] = { ...state.cloneSnapshots[0], sourceRevision: "f".repeat(40) };
    await prisma.aiGenerationJob.update({ where: { id: jobId }, data: { inputJson: JSON.stringify(state) } });
  });
  await assertCorruptTerminal("attempt-extra", async (jobId) => {
    const value = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    await prisma.aiGenerationAttempt.update({
      where: { id: value.id },
      data: { inputJson: JSON.stringify({ ...JSON.parse(value.inputJson ?? "{}"), unexpected: true }) },
    });
  });
  await assertCorruptTerminal("attempt-mismatch", async (jobId) => {
    const value = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    await prisma.aiGenerationAttempt.update({
      where: { id: value.id },
      data: { inputJson: JSON.stringify({ ...JSON.parse(value.inputJson ?? "{}"), referenceSha256: "9".repeat(64) }) },
    });
  });
  await assertCorruptTerminal("attempt-snapshot-missing", async (jobId) => {
    const value = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    await prisma.aiGenerationAttempt.update({ where: { id: value.id }, data: { inputJson: null } });
  });
  await assertCorruptTerminal("reservation-mismatch", async (jobId) => {
    const value = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    const state = JSON.parse(value.inputJson ?? "{}") as Record<string, unknown>;
    state.aiReservedMin = 999;
    await prisma.aiGenerationJob.update({ where: { id: jobId }, data: { inputJson: JSON.stringify(state) } });
  });
  await assertCorruptTerminal("job-only-known-provider-id", async (jobId) => {
    const value = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    const job = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    await prisma.aiGenerationAttempt.update({
      where: { id: value.id },
      data: { providerJobId: null },
    });
    assert.ok(job.providerJobId);
    return job.providerJobId;
  });
  await assertCorruptTerminal("stale-attempt-provider-columns", async (jobId) => {
    const value = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    const job = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    await prisma.aiGenerationAttempt.update({
      where: { id: value.id },
      data: { providerEndpoint: null, providerJobId: null },
    });
    assert.ok(job.providerJobId);
    return job.providerJobId;
  });
  await assertCorruptTerminal("missing-attempt", async (jobId) => {
    const job = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.ok(job.providerJobId);
    await prisma.aiGenerationAttempt.deleteMany({ where: { jobId } });
    return job.providerJobId;
  });
  await assertCorruptTerminal("mismatched-provider-id", async (jobId) => {
    await prisma.aiGenerationAttempt.updateMany({
      where: { jobId },
      data: { providerJobId: "conflicting-provider-job" },
    });
  }, 0);
  await assertCorruptTerminal("mismatched-endpoint", async (jobId) => {
    await prisma.aiGenerationAttempt.updateMany({
      where: { jobId },
      data: { providerEndpoint: "conflicting-endpoint" },
    });
  }, 0);
  await assertCorruptTerminal("cancel-identity-unknown", async (jobId) => {
    await prisma.aiGenerationJob.update({
      where: { id: jobId },
      data: { providerJobId: null, providerEndpoint: null },
    });
    await prisma.aiGenerationAttempt.updateMany({
      where: { jobId },
      data: { providerJobId: null, providerEndpoint: null },
    });
  }, 0);
  await assertCorruptTerminal("cancel-provider-outcome-unknown", async (jobId) => {
    const value = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId } });
    await prisma.aiGenerationAttempt.update({ where: { id: value.id }, data: { inputJson: null } });
    scenario = "cancel-unconfirmed";
  }, 1, "rejected_or_unknown");

  scenario = "success";
  const beforeCorruptReplay = await usage();
  const corruptReplayStarted = await start("corrupt-idempotent-replay");
  const corruptReplayState = JSON.parse(corruptReplayStarted.job.inputJson ?? "{}") as Record<string, unknown>;
  corruptReplayState.unexpected = true;
  await prisma.aiGenerationJob.update({
    where: { id: corruptReplayStarted.job.id },
    data: { inputJson: JSON.stringify(corruptReplayState) },
  });
  const submissionsBeforeCorruptReplay = requests.size;
  const corruptReplay = await start("corrupt-idempotent-replay");
  assert.equal(corruptReplay.created, false);
  assert.equal(corruptReplay.job.status, "failed_identity");
  assert.equal(requests.size, submissionsBeforeCorruptReplay, "idempotency replay cannot dispatch corrupt state");
  assertUsageEqual(await usage(), beforeCorruptReplay);

  // Simulated crash boundary: reservation + exact snapshot + dispatch intent
  // committed, but no provider response was recorded. Resume must never POST.
  const crashText = "ทดสอบ crash ก่อนบันทึก provider id";
  const crashConfig = omnivoice.heroVoiceCloneConfig();
  const crashAttemptId = "33333333-3333-4333-8333-333333333333";
  const crashSnapshot = snapshotModule.createCandidateAiStudioV3Snapshot({
    config: crashConfig,
    attemptId: crashAttemptId,
    sequence: 1,
    normalizerVersion: "2026-07-24.1",
    speed: 1,
    seed: 130363,
    text: crashText,
    refAudioSha256: runnerModule.sha256Hex(reference),
    refDurationSamples24000: 192_000,
    refText,
  });
  const crashState = {
    version: 1,
    mode: "clone",
    cloneCanarySurface: "ai-studio",
    voiceId,
    speed: 1,
    backend: "runpod",
    providerDeadlineAt: new Date(Date.now() + 540_000).toISOString(),
    aiReservedMin: 0.1,
    studioReservedMin: 1,
    speechNormalizerVersion: "2026-07-24.1",
    speechRiskCategories: [],
    chunks: [{ text: crashText, speechText: crashText }],
    cloneSnapshots: [crashSnapshot],
  };
  const beforeCrash = await usage();
  await prisma.user.update({
    where: { id: user.id },
    data: { aiAudioMinutesUsed: { increment: 0.1 }, minutesUsed: { increment: 1 } },
  });
  const crashJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "voice",
      provider: "runpod",
      model: voiceId,
      providerModel: "omnivoice-clone",
      providerRoute: "runpod-custom",
      providerEndpoint: crashSnapshot.endpointId,
      productSurface: "ai_studio",
      status: "queued",
      inputJson: JSON.stringify(crashState),
      chargeState: "reserved",
      reservedAiAudioMinutes: 0.1,
      reservedStudioMinutes: 1,
      idempotencyKey: "task2-crash-resume",
      attempts: {
        create: {
          id: crashAttemptId,
          sequence: 1,
          provider: "runpod",
          providerModel: "omnivoice-clone",
          providerRoute: "runpod-custom",
          providerEndpoint: crashSnapshot.endpointId,
          status: "submitting",
          inputJson: JSON.stringify(crashSnapshot),
          dispatchIntentAt: new Date(),
          dispatchLeaseExpiresAt: new Date(0),
          submissionDisposition: "intent_committed",
          estimatedCostUsdMicros: 0,
        },
      },
    },
  });
  const requestCountBeforeResume = requests.size;
  const crashResumes = await Promise.all([
    hero.advanceHeroVoiceGeneration(user.id, crashJob.id),
    hero.advanceHeroVoiceGeneration(user.id, crashJob.id),
  ]);
  const crashFailed = await prisma.aiGenerationJob.findUniqueOrThrow({ where: { id: crashJob.id } });
  assert.ok(crashResumes.every((result) => ["queued", "failed_unknown_submit"].includes(result.status)));
  assert.equal(crashFailed.status, "failed_unknown_submit");
  assert.equal(requests.size, requestCountBeforeResume, "resume cannot submit an ambiguous dispatch intent");
  assertUsageEqual(await usage(), beforeCrash);

  const unreservedText = "ทดสอบ zero dispatch without reservation";
  const unreservedAttemptId = "44444444-4444-4444-8444-444444444444";
  const unreservedSnapshot = snapshotModule.createCandidateAiStudioV3Snapshot({
    config: crashConfig,
    attemptId: unreservedAttemptId,
    sequence: 1,
    normalizerVersion: "2026-07-24.1",
    speed: 1,
    seed: 170141,
    text: unreservedText,
    refAudioSha256: runnerModule.sha256Hex(reference),
    refDurationSamples24000: 192_000,
    refText,
  });
  const unreservedState = {
    ...crashState,
    aiReservedMin: 0,
    studioReservedMin: 0,
    chunks: [{ text: unreservedText, speechText: unreservedText }],
    cloneSnapshots: [unreservedSnapshot],
  };
  const unreservedJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "voice",
      provider: "runpod",
      model: voiceId,
      providerModel: "omnivoice-clone",
      providerRoute: "runpod-custom",
      providerEndpoint: unreservedSnapshot.endpointId,
      productSurface: "ai_studio",
      status: "queued",
      inputJson: JSON.stringify(unreservedState),
      chargeState: "none",
      reservedAiAudioMinutes: 0,
      reservedStudioMinutes: 0,
      idempotencyKey: "task2-unreserved-no-dispatch",
      attempts: {
        create: {
          id: unreservedAttemptId,
          sequence: 1,
          provider: "runpod",
          providerModel: "omnivoice-clone",
          providerRoute: "runpod-custom",
          providerEndpoint: unreservedSnapshot.endpointId,
          status: "planned",
          inputJson: JSON.stringify(unreservedSnapshot),
          estimatedCostUsdMicros: 0,
        },
      },
    },
  });
  const beforeUnreserved = await usage();
  const requestsBeforeUnreserved = requests.size;
  const unreservedFailed = await hero.advanceHeroVoiceGeneration(user.id, unreservedJob.id);
  assert.equal(unreservedFailed.status, "failed_identity");
  assert.equal(requests.size, requestsBeforeUnreserved, "no provider request is possible without a proven reservation");
  assertUsageEqual(await usage(), beforeUnreserved);

  const telemetry = JSON.stringify(await prisma.telemetryEvent.findMany({ where: { userId: user.id } }));
  assert.equal(telemetry.includes(PRIVATE_SENTINEL), false);
  assert.equal(telemetry.includes(API_SECRET_SENTINEL), false);
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  console.log("Hero Voice clone Task 2 terminal/crash/conservation/precedence runtime checks passed.");
}

main().finally(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(storage, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
