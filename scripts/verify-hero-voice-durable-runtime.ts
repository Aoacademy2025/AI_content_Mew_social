import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HERO_VOICE_SPEECH_NORMALIZER_VERSION } from "../src/lib/hero-voice-speech";

function monoPcm16Wav(sampleRate = 24_000, durationMs = 1_000): Buffer {
  const samples = Math.round(sampleRate * durationMs / 1_000);
  const pcm = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

process.env.OMNIVOICE_ENABLED = "1";
process.env.OMNIVOICE_BACKEND = "runpod";
process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID = "endpoint-pinned-1";
process.env.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID = "clone-endpoint-pinned-1";
process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
process.env.RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb";
process.env.RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256 = "3".repeat(64);
process.env.RUNPOD_API_KEY = "test-key";
process.env.OMNIVOICE_REQUEST_BUDGET_MS = "840000";
process.env.HERO_VOICE_CLONING_ENABLED = "1";
process.env.HERO_VOICE_CANARY_EXECUTION_MODE = "1";
process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = "4".repeat(64);
process.env.OMNIVOICE_ALLOWED_USER_IDS = "";
const userVoiceStorage = fs.mkdtempSync(path.join(os.tmpdir(), "hero-user-voice-runtime-"));
process.env.USER_VOICE_STORAGE_DIR = userVoiceStorage;

const requests: Array<{ url: string; body: string; bodyWasBuffer: boolean }> = [];
let submitted = 0;
let durablePolls = 0;
const wavBase64 = monoPcm16Wav().toString("base64");
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const rawBody: unknown = init?.body;
  const body = typeof rawBody === "string"
    ? rawBody
    : Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : "";
  requests.push({ url, body, bodyWasBuffer: Buffer.isBuffer(rawBody) });

  if (url.endsWith("/run")) {
    submitted++;
    return Response.json({ id: `durable-job-${submitted}`, status: "IN_QUEUE" });
  }
  if (url.endsWith("/status/durable-job-1")) {
    durablePolls++;
    if (durablePolls === 1) {
      return Response.json({
        id: "durable-job-1",
        status: "IN_QUEUE",
        delayTime: 180_001,
      });
    }
    return Response.json({
      id: "durable-job-1",
      status: "COMPLETED",
      delayTime: 185_000,
      executionTime: 1_250,
      output: {
        contract_version: 2,
        mode: "tts",
        voice_id: "voice_01",
        audio_base64: wavBase64,
        format: "wav",
        sample_rate: 24_000,
        duration: 1,
        generation_time: 1.1,
        worker_version: "hero-voice-ai-v2-test",
        catalog_version: "hero-voice-ai-v2-test-catalog",
        language: "Thai",
        num_step: 32,
      },
    });
  }
  if (url.endsWith("/cancel/durable-job-2")) {
    return Response.json({ id: "durable-job-2", status: "CANCELLED" });
  }
  if (/\/status\/durable-job-[34]$/.test(url)) {
    const cloneRequest = [...requests].reverse().find(({ body }) => body && JSON.parse(body).input?.mode === "clone");
    const cloneInput = JSON.parse(cloneRequest?.body ?? "{}").input as Record<string, unknown>;
    return Response.json({
      id: url.split("/").at(-1),
      status: "COMPLETED",
      delayTime: 2_000,
      executionTime: 3_500,
      output: {
        ok: true,
        contract_version: 3,
        mode: "clone",
        worker_kind: "clone-only",
        worker_version: "hero-voice-clone-contract-v3-internal-eval-2",
        image_digest: `sha256:${"1".repeat(64)}`,
        source_revision: "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb",
        model_manifest_sha256: "3".repeat(64),
        experiment_profile: "combined-quality-v1",
        normalizer_version: HERO_VOICE_SPEECH_NORMALIZER_VERSION,
        mixed_language: true,
        request_commitment_sha256: cloneInput.request_commitment_sha256,
        matched_settings_sha256: cloneInput.matched_settings_sha256,
        audio_base64: wavBase64,
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
          generation: {
            candidate_count: 3,
            guidance: 2,
            class_temperature: 0.8,
          },
          reference: {
            input_sha256: createHash("sha256").update(Buffer.from(cloneInput.ref_audio_b64 as string, "base64")).digest("hex"),
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
          candidates: [
            { index: 0, audio_sha256: "c".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.8, pitch_similarity_normalized: 0.5, ranking_score: 0.8 + 0.15 * 0.5 },
            { index: 1, audio_sha256: "d".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.7, pitch_similarity_normalized: 0.9, ranking_score: 0.7 + 0.15 * 0.9 },
            { index: 2, audio_sha256: "e".repeat(64), audio_sha256_domain: "float32-le-mono-24000-v1", samples_24k: 24_000, speaker_cosine: 0.6, pitch_similarity_normalized: 0.2, ranking_score: 0.6 + 0.15 * 0.2 },
          ],
          selected_candidate_index: 0,
          ranking_formula: "speaker_cosine+0.15*pitch_similarity_normalized",
          watermark: null,
        },
        timing_ms: { reference: 1, prompt: 1, synthesis: 1, ranking: 1, watermark: 0, encode: 1, total: 5 },
      },
    });
  }
  return Response.json({ error: `unexpected request: ${url}` }, { status: 500 });
};

async function main() {
  const [{ prisma }, hero, userVoices, cloneAudio] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/hero-voice-generation.server"),
    import("../src/lib/user-voices.server"),
    import("../src/lib/hero-voice-clone-audio.server"),
  ]);
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: {
      name: "Hero durable test",
      email: "hero-durable@aoacademy.co",
      plan: "PRO",
      planExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      usagePeriodStartedAt: new Date(),
      role: "ADMIN",
    },
  });
  const publicAdmin = await prisma.user.create({
    data: {
      name: "Public admin without clone entitlement",
      email: "hero-durable-public@test.invalid",
      plan: "PRO",
      planExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      usagePeriodStartedAt: new Date(),
      role: "ADMIN",
    },
  });
  process.env.OMNIVOICE_ALLOWED_USER_IDS = `${user.id},${publicAdmin.id}`;

  const started = await hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text: "ทดสอบงานรอจีพียู",
    voiceId: "voice_01",
    speed: 1,
    studio: false,
    idempotencyKey: "durable-runtime-1",
  });
  assert.equal(started.created, true);
  assert.equal(started.job.providerEndpoint, "endpoint-pinned-1");
  assert.equal(started.job.providerJobId, "durable-job-1");
  assert.equal(started.job.chargeState, "reserved");

  // A rollout may change the default endpoint, but an accepted job must continue
  // polling the exact endpoint that received its provider job id.
  process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID = "endpoint-new-default";
  const queued = await hero.advanceHeroVoiceGeneration(user.id, started.job.id);
  assert.equal(queued.status, "queued");
  assert.equal(queued.delayTimeMs, 180_001);
  assert.equal(queued.providerJobId, "durable-job-1");
  assert.equal(requests.some(({ url }) => url.includes("/cancel/")), false);

  const completed = await hero.advanceHeroVoiceGeneration(user.id, started.job.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.chargeState, "settled");
  assert.equal(completed.providerEndpoint, "endpoint-pinned-1");
  assert.equal(hero.heroVoiceResultFromJob(completed)?.audioDurationMs, 1_000);
  assert.ok(completed.outputUrl);
  assert.equal(
    requests
      .filter(({ url }) => url.includes("/status/"))
      .every(({ url }) => url.includes("/v2/endpoint-pinned-1/")),
    true,
  );

  const replay = await hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text: "ทดสอบงานรอจีพียู",
    voiceId: "voice_01",
    speed: 1,
    studio: false,
    idempotencyKey: "durable-runtime-1",
  });
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, completed.id);
  assert.equal(submitted, 1);

  process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID = "endpoint-pinned-1";
  const cancelStarted = await hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text: "ยกเลิกงานเสียงเดิม",
    voiceId: "voice_01",
    speed: 1,
    studio: false,
    idempotencyKey: "durable-runtime-cancel",
  });
  const canceled = await hero.cancelHeroVoiceGeneration(user.id, cancelStarted.job.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.chargeState, "refunded");
  assert.equal(
    requests.some(({ url }) => url.endsWith("/v2/endpoint-pinned-1/cancel/durable-job-2")),
    true,
  );

  const runBody = JSON.parse(requests.find(({ url }) => url.endsWith("/run"))?.body ?? "{}");
  assert.equal(runBody.input.contract_version, 2);
  assert.equal(runBody.input.mode, "tts");
  assert.equal(runBody.input.voice_id, "voice_01");
  assert.equal(runBody.input.num_step, 32);
  assert.equal(runBody.input.mixed_language, true);

  const referenceFilename = "11111111-1111-4111-8111-111111111111.wav";
  const referenceText = "สวัสดีค่ะ นี่คือเสียงอ้างอิงสำหรับการทดสอบระบบ";
  const referenceWav = monoPcm16Wav(24_000, 8_000);
  fs.writeFileSync(path.join(userVoiceStorage, referenceFilename), referenceWav, { mode: 0o600 });
  const customVoice = await prisma.userVoice.create({
    data: {
      userId: user.id,
      name: "เสียงทดสอบส่วนตัว",
      refText: referenceText,
      filename: referenceFilename,
      durationMs: 8_000,
    },
  });
  const customVoiceId = userVoices.userVoiceIdFor(customVoice.id);
  const cloneRequest = (overrides: Partial<Parameters<typeof hero.startHeroVoiceGeneration>[0]> = {}) => ({
    userId: user.id,
    plan: "PRO" as const,
    text: "ทดสอบเสียงโคลนแบบ durable",
    voiceId: customVoiceId,
    speed: 1,
    studio: true,
    cloneCanarySurface: "ai-studio" as const,
    idempotencyKey: "durable-clone-default",
    ...overrides,
  });
  const expectCloneNotFound = async (operation: () => Promise<unknown>, message: string) => {
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof hero.HeroVoiceGenerationError
        && error.code === "USER_VOICE_NOT_FOUND"
        && error.status === 404,
      message,
    );
  };
  await assert.rejects(
    () => hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "clone cannot adopt a stock idempotency row",
      voiceId: customVoiceId,
      speed: 1,
      studio: true,
      cloneCanarySurface: "ai-studio",
      idempotencyKey: "durable-runtime-1",
    }),
    (error: unknown) => error instanceof hero.HeroVoiceGenerationError
      && error.code === "USER_VOICE_NOT_FOUND"
      && error.status === 404,
  );
  await assert.rejects(
    () => hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "direct non AI Studio clone must fail",
      voiceId: customVoiceId,
      speed: 1,
      studio: true,
      idempotencyKey: "durable-clone-wrong-surface",
    }),
    (error: unknown) => error instanceof hero.HeroVoiceGenerationError
      && error.code === "USER_VOICE_NOT_FOUND"
      && error.status === 404,
  );
  await assert.rejects(
    () => hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "cross account clone must fail",
      voiceId: "user_not-owned-by-this-account",
      speed: 1,
      studio: true,
      cloneCanarySurface: "ai-studio",
      idempotencyKey: "durable-clone-not-owned",
    }),
    (error: unknown) => error instanceof hero.HeroVoiceGenerationError
      && error.code === "USER_VOICE_NOT_FOUND"
      && error.status === 404,
  );
  await assert.rejects(
    () => hero.startHeroVoiceGeneration({
      userId: publicAdmin.id,
      plan: "PRO",
      text: "admin role alone must fail",
      voiceId: customVoiceId,
      speed: 1,
      studio: true,
      cloneCanarySurface: "ai-studio",
      idempotencyKey: "durable-clone-admin-bypass",
    }),
    (error: unknown) => error instanceof hero.HeroVoiceGenerationError
      && error.code === "USER_VOICE_NOT_FOUND"
      && error.status === 404,
  );
  await expectCloneNotFound(
    () => hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "stock mode cannot carry a clone surface marker",
      voiceId: "voice_01",
      speed: 1,
      studio: true,
      cloneCanarySurface: "ai-studio",
      idempotencyKey: "durable-stock-clone-surface",
    }),
    "stock generation must reject the clone-only AI Studio marker",
  );
  assert.equal(submitted, 2, "denied/direct clone calls create no provider request");
  assert.equal(
    await prisma.aiGenerationJob.count({
      where: { idempotencyKey: { in: [
        "durable-clone-wrong-surface",
        "durable-clone-not-owned",
        "durable-clone-admin-bypass",
        "durable-stock-clone-surface",
      ] } },
    }),
    0,
    "denied/direct clone calls create no durable job",
  );

  const cloneStarted = await hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text: "ทดสอบภาษาไทย English และเลข 123",
    voiceId: customVoiceId,
    speed: 1,
    studio: true,
    cloneCanarySurface: "ai-studio",
    idempotencyKey: "durable-runtime-clone",
  });
  assert.equal(cloneStarted.job.providerJobId, "durable-job-3");
  assert.equal(cloneStarted.job.providerEndpoint, "clone-endpoint-pinned-1");
  assert.equal(cloneStarted.job.providerModel, "omnivoice-clone");
  await assert.rejects(
    () => userVoices.deleteUserVoice(user.id, customVoice.id),
    (error: unknown) => error instanceof userVoices.UserVoiceError
      && error.code === "USER_VOICE_IN_USE",
  );

  await prisma.user.update({ where: { id: user.id }, data: { suspended: true } });
  const revoked = await hero.advanceHeroVoiceGeneration(user.id, cloneStarted.job.id);
  assert.equal(revoked.status, "failed_identity", "revoked clone policy terminalizes rather than parking forever");
  assert.equal(revoked.chargeState, "refunded");
  await prisma.user.update({ where: { id: user.id }, data: { suspended: false } });
  const cloneCompletionStarted = await hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text: "ทดสอบ clone completion ภาษาไทย English 456",
    voiceId: customVoiceId,
    speed: 1,
    studio: true,
    cloneCanarySurface: "ai-studio",
    idempotencyKey: "durable-runtime-clone-completion",
  });
  assert.equal(cloneCompletionStarted.job.providerJobId, "durable-job-4");
  process.env.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID = "clone-endpoint-new-default";
  const cloneCompleted = await hero.advanceHeroVoiceGeneration(user.id, cloneCompletionStarted.job.id);
  assert.equal(
    cloneCompleted.status,
    "completed",
    cloneCompleted.errorMessage ?? "clone completion must validate",
  );
  assert.equal(cloneCompleted.chargeState, "settled");
  assert.equal(cloneCompleted.outputUrl, `/api/ai-studio/voice-audio/${cloneCompleted.id}`);
  const cloneOutputPath = cloneAudio.heroVoiceCloneAudioFilePath(cloneCompleted.id);
  assert.ok(cloneOutputPath && fs.existsSync(cloneOutputPath));
  if (process.platform !== "win32") assert.equal(fs.statSync(cloneOutputPath!).mode & 0o777, 0o600);
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "public", "renders", `tts-omni-${cloneCompleted.id}.wav`)),
    false,
    "generated clone audio never enters public/renders",
  );
  const submittedCloneRequest = requests.find(({ url, body }) => (
    url.endsWith("/run") && JSON.parse(body).input?.mode === "clone"
  ));
  assert.ok(submittedCloneRequest);
  assert.equal(submittedCloneRequest.bodyWasBuffer, true,
    "clone dispatch hands the previously verified exact Buffer to fetch");
  const cloneRunBody = JSON.parse(submittedCloneRequest.body);
  assert.equal(cloneRunBody.input.contract_version, 3);
  assert.equal(cloneRunBody.input.mode, "clone");
  assert.equal(cloneRunBody.input.ref_audio_b64, referenceWav.toString("base64"));
  assert.equal(cloneRunBody.input.ref_text, referenceText);
  assert.equal(cloneRunBody.input.voice_id, undefined);
  assert.equal(cloneRunBody.input.num_step, 32);
  assert.equal(cloneRunBody.input.mixed_language, true);
  assert.equal(cloneRunBody.input.experiment_profile, "combined-quality-v1");
  assert.equal(cloneRunBody.policy.executionTimeout, 540_000);
  assert.equal(cloneRunBody.policy.ttl, 900_000);
  assert.equal(
    requests.some(({ url }) => url.endsWith("/v2/clone-endpoint-pinned-1/status/durable-job-4")),
    true,
    "clone polling must use the durable snapshot after environment drift",
  );
  assert.ok(!cloneCompleted.inputJson?.includes(referenceWav.toString("base64")));
  assert.ok(!cloneCompleted.inputJson?.includes(referenceText));

  const assertTerminalCloneImmutable = async (label: string) => {
    const advanced = await hero.advanceHeroVoiceGeneration(user.id, cloneCompleted.id);
    const canceled = await hero.cancelHeroVoiceGeneration(user.id, cloneCompleted.id);
    assert.equal(advanced.status, "completed", `${label}: terminal advance cannot rewrite success`);
    assert.equal(canceled.status, "completed", `${label}: terminal cancel cannot rewrite success`);
  };

  await prisma.user.update({ where: { id: user.id }, data: { suspended: true } });
  await assertTerminalCloneImmutable("suspended actor");
  await prisma.user.update({ where: { id: user.id }, data: { suspended: false } });

  process.env.HERO_VOICE_CLONING_ENABLED = "0";
  await assertTerminalCloneImmutable("disabled clone flag");
  process.env.HERO_VOICE_CLONING_ENABLED = "1";

  process.env.OMNIVOICE_ALLOWED_USER_IDS = publicAdmin.id;
  await assertTerminalCloneImmutable("removed OmniVoice allowlist entry");
  process.env.OMNIVOICE_ALLOWED_USER_IDS = `${user.id},${publicAdmin.id}`;

  await prisma.user.update({ where: { id: user.id }, data: { email: "revoked@example.invalid" } });
  await assertTerminalCloneImmutable("revoked internal tester predicate");
  await prisma.user.update({ where: { id: user.id }, data: { email: "hero-durable@aoacademy.co" } });

  const beforeIdenticalCollision = submitted;
  const identicalCollision = await Promise.all([
    hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "same concurrent stock request",
      voiceId: "voice_01",
      speed: 1,
      studio: false,
      idempotencyKey: "durable-race-identical",
    }),
    hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "same concurrent stock request",
      voiceId: "voice_01",
      speed: 1,
      studio: false,
      idempotencyKey: "durable-race-identical",
    }),
  ]);
  assert.equal(new Set(identicalCollision.map(({ job }) => job.id)).size, 1);
  assert.deepEqual(identicalCollision.map(({ created }) => created).sort(), [false, true]);
  assert.equal(submitted, beforeIdenticalCollision + 1, "an identical collision submits exactly one provider job");

  const beforeMismatchCollision = submitted;
  const mismatchCollision = await Promise.allSettled([
    hero.startHeroVoiceGeneration(cloneRequest({
      text: "clone side of an incompatible collision",
      idempotencyKey: "durable-race-mismatch",
    })),
    hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "stock side of an incompatible collision",
      voiceId: "voice_02",
      speed: 1,
      studio: false,
      idempotencyKey: "durable-race-mismatch",
    }),
  ]);
  assert.equal(mismatchCollision.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(mismatchCollision.filter(({ status }) => status === "rejected").length, 1,
    "a concurrent clone/stock collision cannot adopt the winner's provider or surface");
  assert.equal(
    await prisma.aiGenerationJob.count({ where: { userId: user.id, idempotencyKey: "durable-race-mismatch" } }),
    1,
  );
  assert.equal(submitted, beforeMismatchCollision + 1, "an incompatible collision submits only its winner");

  const kindCollision = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "seeded-image-model",
      providerModel: "seeded-image-provider",
      status: "completed",
      creditCost: 1,
      chargeState: "settled",
      idempotencyKey: "durable-kind-mismatch",
      productSurface: "ai_studio",
    },
  });
  await assert.rejects(
    () => hero.startHeroVoiceGeneration({
      userId: user.id,
      plan: "PRO",
      text: "voice cannot adopt an image row",
      voiceId: "voice_01",
      speed: 1,
      studio: false,
      idempotencyKey: "durable-kind-mismatch",
    }),
    (error: unknown) => error instanceof hero.HeroVoiceGenerationError
      && error.code === "OMNIVOICE_IDEMPOTENCY_CONFLICT"
      && error.status === 409,
  );
  assert.equal((await prisma.aiGenerationJob.findUnique({ where: { id: kindCollision.id } }))?.kind, "image");
  assert.equal(await userVoices.deleteUserVoice(user.id, customVoice.id), true);

  for (const job of await prisma.aiGenerationJob.findMany({
    where: { userId: user.id },
    select: { outputUrl: true },
  })) {
    if (!job.outputUrl?.startsWith("/api/renders/")) continue;
    try { fs.unlinkSync(path.join(process.cwd(), "public", "renders", path.basename(job.outputUrl))); } catch {}
  }
  await prisma.user.delete({ where: { id: publicAdmin.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  console.log("Durable Hero Voice TTS + clone submit/poll/pin/cancel runtime checks passed.");
}

main().finally(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(userVoiceStorage, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
