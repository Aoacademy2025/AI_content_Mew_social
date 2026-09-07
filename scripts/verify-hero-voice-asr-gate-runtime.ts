import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { droppedLetterRun, insertedLetterRun } from "../src/lib/hero-voice-asr-gate";
import { HERO_VOICE_SPEECH_NORMALIZER_VERSION } from "../src/lib/hero-voice-speech";

/**
 * Runtime checks for the Hero Voice ASR content gate (spec §11.5).
 *
 * The clone worker's best-of-3 ranking never checks the words, so this gate
 * listens to every generated part with two machine ears and regenerates a
 * chunk with the next seed when a run of letters went missing. Everything
 * external is faked at the fetch boundary: the RunPod clone endpoint encodes
 * the chunk index and the seed offset into the WAV it returns, and the fake
 * Gemini ears decode those bytes to pick a scripted transcript. That way the
 * ears never see the intended script, exactly like production.
 */

process.env.OMNIVOICE_ENABLED = "1";
process.env.HERO_VOICE_CLONING_ENABLED = "1";
process.env.OMNIVOICE_BACKEND = "runpod";
process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID = "stock-unchanged";
process.env.RUNPOD_HERO_VOICE_CLONE_ENDPOINT_ID = "clone-matrix";
process.env.RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
const SOURCE_REVISION = "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb";
const PRIVATE_SENTINEL = "RefSecret_K9v7T2mQ4xL8pZ6nR3cW1yH5";
const API_SECRET_SENTINEL = "Rpk_6Jt9Qv3Nz8Ls2Hx7Wm4Bc1Ya5Fd0";
const GEMINI_SECRET_SENTINEL = "Gsk_2Vq8Lm5Zt1Xr7Kp4Hn9Wc3Yb6Fd0";
process.env.RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION = SOURCE_REVISION;
process.env.RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256 = "3".repeat(64);
process.env.RUNPOD_API_KEY = API_SECRET_SENTINEL;
process.env.GEMINI_SERVER_KEY = GEMINI_SECRET_SENTINEL;
// Two passes share this file: the canary gate (Task 6 digest + execution mode) and,
// with HERO_VOICE_TEST_GATE_MODE=production, the ADR 0061 owner-consent production gate
// under NODE_ENV=production with no canary variable at all. Every scenario below must
// hold in both, so no other production-only closure can hide in the clone state machine.
const PRODUCTION_GATE = process.env.HERO_VOICE_TEST_GATE_MODE === "production";
if (PRODUCTION_GATE) {
  assert.equal(process.env.NODE_ENV, "production", "the production-gate pass runs with NODE_ENV=production");
  delete process.env.HERO_VOICE_CANARY_EXECUTION_MODE;
  delete process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
  delete process.env.HERO_VOICE_CANARY_ROOT;
  process.env.HERO_VOICE_CLONE_PRODUCTION = "1";
} else {
  process.env.HERO_VOICE_CANARY_EXECUTION_MODE = "1";
  process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = "4".repeat(64);
  delete process.env.HERO_VOICE_CLONE_PRODUCTION;
}
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "hero-asr-gate-runtime-"));
process.env.USER_VOICE_STORAGE_DIR = storage;

const BASE_SEED = 104729;
const TRANSCRIBE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent";
const VERBATIM_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

function pcm16Wav(durationMs: number, chunkIndex: number, seedOffset: number): Buffer {
  const samples = Math.round(24_000 * durationMs / 1_000);
  const pcm = Buffer.alloc(samples * 2, 1);
  pcm.writeInt16LE(chunkIndex + 1, 0);
  pcm.writeInt16LE(seedOffset + 1, 2);
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

function decodeGeneration(wav: Buffer): { chunkIndex: number; seedOffset: number } {
  return { chunkIndex: wav.readInt16LE(44) - 1, seedOffset: wav.readInt16LE(46) - 1 };
}

/** Remove an eight-letter run from the middle of the intended text. */
function dropPhrase(text: string): string {
  const middle = Math.floor(text.length / 2);
  return `${text.slice(0, middle)}${text.slice(middle + 8)}`;
}

/** Read a word twice (the round-5 "จริง" → "จริงๆ" defect): six letters nobody asked for. */
function repeatPhrase(text: string): string {
  const middle = Math.floor(text.length / 2);
  return `${text.slice(0, middle)}ประโยค${text.slice(middle)}`;
}

type EarPlan = {
  /** Transcript per [chunkIndex][seedOffset]; a function lets one ear differ. */
  transcript: (chunkIndex: number, seedOffset: number, ear: "transcribe" | "verbatim") => string;
  /** HTTP status for the ears; 200 unless a scenario takes them down. */
  earStatus?: number;
};

let chunkTexts: string[] = [];
let earPlan: EarPlan = { transcript: (index) => chunkTexts[index] };
let serial = 0;
const requests = new Map<string, { text: string; seed: number }>();
const earCalls: Array<{ model: "transcribe" | "verbatim"; chunkIndex: number; seedOffset: number }> = [];
let referenceBase64 = "";
let refText = "";
const originalFetch = globalThis.fetch;

function successEnvelope(request: { text: string; seed: number; ref_audio_b64: string; request_commitment_sha256: string; matched_settings_sha256: string }, audio: Buffer) {
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
    normalizer_version: HERO_VOICE_SPEECH_NORMALIZER_VERSION,
    mixed_language: true,
    request_commitment_sha256: request.request_commitment_sha256,
    matched_settings_sha256: request.matched_settings_sha256,
    audio_base64: audio.toString("base64"),
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
        input_sha256: createHash("sha256").update(Buffer.from(request.ref_audio_b64, "base64")).digest("hex"),
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
  };
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === TRANSCRIBE_URL || url === VERBATIM_URL) {
    const model = url === TRANSCRIBE_URL ? "transcribe" : "verbatim";
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-goog-api-key"), GEMINI_SECRET_SENTINEL, "ears authenticate with the server Gemini key");
    const bodyText = typeof init?.body === "string" ? init.body : Buffer.from(init?.body as ArrayBuffer).toString("utf8");
    assert.equal(bodyText.includes(referenceBase64), false, "ears never receive the reference recording");
    assert.equal(bodyText.includes(refText), false, "ears never receive the reference transcript");
    assert.equal(bodyText.includes(API_SECRET_SENTINEL), false);
    const body = JSON.parse(bodyText) as {
      contents: Array<{ parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string }; inlineData?: { mimeType: string; data: string } }> }>;
    };
    const parts = body.contents.flatMap((content) => content.parts);
    const audioPart = parts.find((part) => part.inline_data ?? part.inlineData);
    assert.ok(audioPart, "each ear receives the generated audio inline");
    const audioBase64 = (audioPart.inline_data ?? audioPart.inlineData)!.data;
    const generation = decodeGeneration(Buffer.from(audioBase64, "base64"));
    for (const part of parts) {
      if (part.text) {
        for (const text of chunkTexts) {
          assert.equal(part.text.includes(text.trim()), false, "the ears are blind: the intended script is never in the prompt");
        }
      }
    }
    if (model === "transcribe") {
      assert.equal(parts.some((part) => part.text), false, "gemini-3.5-transcribe receives the audio part only");
    } else {
      assert.ok(parts.some((part) => part.text), "the verbatim ear receives its blind prompt");
    }
    earCalls.push({ model, ...generation });
    if (earPlan.earStatus && earPlan.earStatus !== 200) {
      return Response.json({ error: { message: PRIVATE_SENTINEL } }, { status: earPlan.earStatus });
    }
    const transcript = earPlan.transcript(generation.chunkIndex, generation.seedOffset, model);
    return model === "transcribe"
      ? Response.json({ candidates: [{ content: { parts: [{ audioTranscription: { text: transcript } }] } }] })
      : Response.json({ candidates: [{ content: { parts: [{ text: transcript }] } }] });
  }
  if (url.endsWith("/run")) {
    const rawBody: unknown = init?.body;
    const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "{}") as {
      input: { text: string; seed: number; ref_audio_b64: string; request_commitment_sha256: string; matched_settings_sha256: string };
    };
    const providerJobId = `gen-${++serial}`;
    requests.set(providerJobId, body.input);
    return Response.json({ id: providerJobId, status: "IN_QUEUE" });
  }
  const statusMatch = /\/status\/([^/]+)$/.exec(url);
  if (statusMatch) {
    const providerJobId = statusMatch[1];
    const request = requests.get(providerJobId)!;
    const chunkIndex = chunkTexts.indexOf(request.text);
    assert.ok(chunkIndex >= 0, "every dispatched text is one of the planned chunks");
    const audio = pcm16Wav(1_000, chunkIndex, request.seed - BASE_SEED);
    return Response.json({ id: providerJobId, status: "COMPLETED", output: successEnvelope(request as never, audio) });
  }
  const cancelMatch = /\/cancel\/([^/]+)$/.exec(url);
  if (cancelMatch) {
    return Response.json({ id: cancelMatch[1], status: "CANCELLED" });
  }
  return Response.json({ error: "unexpected" }, { status: 500 });
};

type AsrGateState = {
  version: 1;
  chunks: Array<{
    sequence: number;
    attempts: number;
    droppedRun: number | null;
    insertedRun: number | null;
    ears: number;
    rejected: Array<{ attemptId: string; providerJobId: string; seed: number; droppedRun: number; insertedRun: number }>;
  }>;
};

async function main() {
  const [{ prisma }, hero, voices, speech, audioModule] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/hero-voice-generation.server"),
    import("../src/lib/user-voices.server"),
    import("../src/lib/hero-voice-speech"),
    import("../src/lib/hero-voice-clone-audio.server"),
  ]);
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: {
      name: "ASR gate owner",
      email: "asr-gate@aoacademy.co",
      plan: "PRO",
      planExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      usagePeriodStartedAt: new Date(),
      role: "USER",
      minutesLimit: 1_000,
    },
  });
  process.env.OMNIVOICE_ALLOWED_USER_IDS = user.id;
  const refFilename = "22222222-2222-4222-8222-222222222222.wav";
  const reference = pcm16Wav(8_000, 0, 0);
  referenceBase64 = reference.toString("base64");
  refText = `${PRIVATE_SENTINEL} เสียงอ้างอิงยาวแปดวินาที`;
  fs.writeFileSync(path.join(storage, refFilename), reference, { mode: 0o600 });
  const voice = await prisma.userVoice.create({
    data: { userId: user.id, name: "Q", refText, filename: refFilename, durationMs: 8_000 },
  });
  const voiceId = voices.userVoiceIdFor(voice.id);

  const twoSentences = "ทดสอบท่อนแรกของประโยคครับ ทดสอบท่อนที่สองของประโยคครับ";
  const planned = speech.splitHeroVoiceScriptForTts(twoSentences, 400);
  assert.equal(planned.length, 2, "the fixture script splits into two sentence chunks");
  const expectedDrop = droppedLetterRun(planned[0].speechText, dropPhrase(planned[0].speechText));
  assert.ok(expectedDrop >= 5, "the fixture drop is long enough to fail the gate");
  const expectedInsertion = insertedLetterRun(planned[1].speechText, repeatPhrase(planned[1].speechText));
  assert.ok(expectedInsertion >= 3, "the fixture repeat is long enough to fail the insertion gate");
  assert.equal(droppedLetterRun(planned[1].speechText, repeatPhrase(planned[1].speechText)), 0, "a pure insertion drops nothing");

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
  const start = (key: string, text = twoSentences) => hero.startHeroVoiceGeneration({
    userId: user.id,
    plan: "PRO",
    text,
    voiceId,
    speed: 1,
    studio: true,
    cloneCanarySurface: "ai-studio",
    cloneSeed: BASE_SEED,
    idempotencyKey: `asr-gate-${key}`,
  });
  const runToTerminal = async (jobId: string) => {
    for (let round = 0; round < 12; round += 1) {
      const job = await hero.advanceHeroVoiceGeneration(user.id, jobId);
      if (!["queued", "in_progress"].includes(job.status)) return job;
    }
    throw new Error("job did not reach a terminal state");
  };
  const resetPlan = async (texts: string[], plan: EarPlan) => {
    chunkTexts = texts;
    earPlan = plan;
    earCalls.length = 0;
    // The shared usage cycle re-derives the studio minute limit from the plan; keep
    // every scenario inside it (each completed clip settles one studio minute).
    await prisma.user.update({ where: { id: user.id }, data: { minutesUsed: 0 } });
  };
  const stateOf = (inputJson: string | null) => JSON.parse(inputJson ?? "{}") as {
    cloneSnapshots: Array<{ attemptId: string; synthesis: { seed: number } }>;
    asrGate?: AsrGateState;
  };
  const attemptRows = (jobId: string) => prisma.aiGenerationAttempt.findMany({ where: { jobId }, orderBy: { sequence: "asc" } });
  const noPartsLeft = (jobId: string) => {
    for (const sequence of [1, 2]) {
      assert.equal(fs.existsSync(audioModule.heroVoiceClonePartFilePath(jobId, sequence)!), false,
        `no private part file survives for sequence ${sequence}`);
    }
  };

  // 1. Flag off: nothing listens, the existing behavior is byte-for-byte unchanged.
  delete process.env.HERO_VOICE_ASR_GATE;
  await resetPlan(planned.map((chunk) => chunk.speechText), { transcript: (index) => chunkTexts[index] });
  const submissionsBeforeOff = requests.size;
  const offStarted = await start("flag-off");
  const off = await runToTerminal(offStarted.job.id);
  assert.equal(off.status, "completed");
  assert.equal(earCalls.length, 0, "flag off: no Gemini ear is ever called");
  assert.equal(requests.size - submissionsBeforeOff, 2);
  assert.equal(stateOf(off.inputJson).asrGate, undefined, "flag off: no gate record is written");

  // 2. Flag on, every part reads every word: both ears per part, no regeneration.
  process.env.HERO_VOICE_ASR_GATE = "1";
  await resetPlan(planned.map((chunk) => chunk.speechText), { transcript: (index) => chunkTexts[index] });
  const submissionsBeforeClean = requests.size;
  const cleanStarted = await start("clean");
  const originalCleanAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: cleanStarted.job.id } });
  const clean = await runToTerminal(cleanStarted.job.id);
  assert.equal(clean.status, "completed");
  assert.equal(clean.chargeState, "settled");
  assert.equal(requests.size - submissionsBeforeClean, 2, "clean parts are generated exactly once each");
  assert.deepEqual(
    earCalls.map((call) => `${call.model}:${call.chunkIndex}:${call.seedOffset}`).sort(),
    ["transcribe:0:0", "transcribe:1:0", "verbatim:0:0", "verbatim:1:0"],
    "both ears listen to each part exactly once",
  );
  const cleanState = stateOf(clean.inputJson);
  assert.deepEqual(cleanState.asrGate, {
    version: 1,
    chunks: [
      { sequence: 1, attempts: 1, droppedRun: 0, insertedRun: 0, ears: 2, rejected: [] },
      { sequence: 2, attempts: 1, droppedRun: 0, insertedRun: 0, ears: 2, rejected: [] },
    ],
  });
  assert.equal(cleanState.cloneSnapshots[0].attemptId, originalCleanAttempt.id, "a passing part keeps its original attempt");
  assert.equal(cleanState.cloneSnapshots[0].synthesis.seed, BASE_SEED);
  const cleanReplay = await hero.advanceHeroVoiceGeneration(user.id, clean.id);
  assert.equal(cleanReplay.status, "completed", "state with an asrGate record round-trips through parseState");
  assert.ok(hero.heroVoiceResultFromJob(cleanReplay));
  noPartsLeft(clean.id);

  // 3. First generation of chunk 1 skips a phrase (both ears agree); seed+1 reads it all.
  //    Chunk 2 is clean and must not be touched.
  await resetPlan(planned.map((chunk) => chunk.speechText), {
    transcript: (index, seedOffset) => index === 0 && seedOffset === 0 ? dropPhrase(chunkTexts[0]) : chunkTexts[index],
  });
  const submissionsBeforeRetry = requests.size;
  const beforeRetry = await usage();
  const retryStarted = await start("retry");
  const originalRetryAttempt = await prisma.aiGenerationAttempt.findFirstOrThrow({ where: { jobId: retryStarted.job.id } });
  const retry = await runToTerminal(retryStarted.job.id);
  assert.equal(retry.status, "completed", "a chunk regenerated with the next seed completes normally");
  assert.equal(retry.chargeState, "settled");
  assert.equal(requests.size - submissionsBeforeRetry, 3, "one extra provider job for the one rejected part");
  const dispatchedSeeds = [...requests.values()].slice(-3).map((request) => `${chunkTexts.indexOf(request.text)}:${request.seed - BASE_SEED}`);
  assert.deepEqual(dispatchedSeeds, ["0:0", "0:1", "1:0"], "the rejected chunk is re-dispatched with seed+1 before chunk 2 starts");
  const retryState = stateOf(retry.inputJson);
  assert.equal(retryState.cloneSnapshots[0].synthesis.seed, BASE_SEED + 1);
  assert.equal(retryState.cloneSnapshots[1].synthesis.seed, BASE_SEED, "the clean chunk keeps its seed");
  assert.notEqual(retryState.cloneSnapshots[0].attemptId, originalRetryAttempt.id, "the replacement snapshot carries a new attempt id");
  const retryAttempts = await attemptRows(retry.id);
  assert.deepEqual(retryAttempts.map((attempt) => attempt.sequence), [1, 2]);
  assert.equal(retryAttempts[0].id, retryState.cloneSnapshots[0].attemptId, "the attempt row is replaced together with its snapshot");
  assert.equal(retryAttempts[0].inputJson, JSON.stringify(retryState.cloneSnapshots[0]));
  assert.equal(retryAttempts[0].status, "completed");
  assert.deepEqual(retryState.asrGate, {
    version: 1,
    chunks: [
      {
        sequence: 1,
        attempts: 2,
        droppedRun: 0,
        insertedRun: 0,
        ears: 2,
        rejected: [{ attemptId: originalRetryAttempt.id, providerJobId: `gen-${serial - 2}`, seed: BASE_SEED, droppedRun: expectedDrop, insertedRun: 0 }],
      },
      { sequence: 2, attempts: 1, droppedRun: 0, insertedRun: 0, ears: 2, rejected: [] },
    ],
  });
  assert.equal(earCalls.length, 6, "three generations, two ears each");
  assert.ok((await usage()).aiAudioMinutesUsed > beforeRetry.aiAudioMinutesUsed, "the regenerated clip is settled like any other");
  const retryReplay = await hero.advanceHeroVoiceGeneration(user.id, retry.id);
  assert.equal(retryReplay.status, "completed", "replaced attempt identity round-trips on replay");
  noPartsLeft(retry.id);

  // 3b. First generation of chunk 2 reads a word twice (both ears agree): seed+1 reads it
  //     as written. Chunk 1 is clean and keeps its seed. (Round 5: "จริง" → "จริงๆ".)
  await resetPlan(planned.map((chunk) => chunk.speechText), {
    transcript: (index, seedOffset) => index === 1 && seedOffset === 0 ? repeatPhrase(chunkTexts[1]) : chunkTexts[index],
  });
  const submissionsBeforeInsert = requests.size;
  const insertStarted = await start("insertion");
  const insertion = await runToTerminal(insertStarted.job.id);
  assert.equal(insertion.status, "completed", "a chunk regenerated after an insertion completes normally");
  assert.equal(requests.size - submissionsBeforeInsert, 3, "one extra provider job for the one inserted part");
  assert.deepEqual(
    [...requests.values()].slice(-3).map((request) => `${chunkTexts.indexOf(request.text)}:${request.seed - BASE_SEED}`),
    ["0:0", "1:0", "1:1"],
    "the inserted chunk is re-dispatched with seed+1",
  );
  const insertionState = stateOf(insertion.inputJson);
  assert.equal(insertionState.cloneSnapshots[0].synthesis.seed, BASE_SEED, "the clean chunk keeps its seed");
  assert.equal(insertionState.cloneSnapshots[1].synthesis.seed, BASE_SEED + 1);
  assert.deepEqual(insertionState.asrGate?.chunks.map((chunk) => ({ ...chunk, rejected: chunk.rejected.map((r) => ({ seed: r.seed, droppedRun: r.droppedRun, insertedRun: r.insertedRun })) })), [
    { sequence: 1, attempts: 1, droppedRun: 0, insertedRun: 0, ears: 2, rejected: [] },
    { sequence: 2, attempts: 2, droppedRun: 0, insertedRun: 0, ears: 2, rejected: [{ seed: BASE_SEED, droppedRun: 0, insertedRun: expectedInsertion }] },
  ]);
  const insertionEvents = await prisma.telemetryEvent.findMany({
    where: { userId: user.id, name: "omnivoice_asr_gate_rejected" }, orderBy: { createdAt: "desc" }, take: 1,
  });
  assert.equal(insertionEvents.length, 1);
  assert.match(insertionEvents[0].properties ?? "", /"reason":"inserted"/, "the rejection telemetry names the insertion");
  assert.match(insertionEvents[0].properties ?? "", new RegExp(`"insertedRun":${expectedInsertion}`));
  noPartsLeft(insertion.id);

  // 4b. Only one ear hears the repeat: that is ASR noise, not a misread. No regeneration.
  await resetPlan(planned.map((chunk) => chunk.speechText), {
    transcript: (index, _seedOffset, ear) => ear === "verbatim" ? repeatPhrase(chunkTexts[index]) : chunkTexts[index],
  });
  const submissionsBeforeOneEar = requests.size;
  const oneEar = await runToTerminal((await start("one-ear-insertion")).job.id);
  assert.equal(oneEar.status, "completed");
  assert.equal(requests.size - submissionsBeforeOneEar, 2, "a repeat only one ear heard is not regenerated");
  assert.deepEqual(stateOf(oneEar.inputJson).asrGate?.chunks.map((chunk) => chunk.insertedRun), [0, 0]);

  // 4. One ear hears everything, the other drops a phrase: the best ear wins, no regeneration.
  await resetPlan(planned.map((chunk) => chunk.speechText), {
    transcript: (index, _seedOffset, ear) => ear === "transcribe" ? dropPhrase(chunkTexts[index]) : chunkTexts[index],
  });
  const submissionsBeforeBestEar = requests.size;
  const bestEar = await runToTerminal((await start("best-ear")).job.id);
  assert.equal(bestEar.status, "completed");
  assert.equal(requests.size - submissionsBeforeBestEar, 2, "a part one ear reads fully is not regenerated");
  assert.deepEqual(stateOf(bestEar.inputJson).asrGate?.chunks.map((chunk) => chunk.droppedRun), [0, 0]);

  // 5. Every generation of chunk 1 drops a phrase: 2 retries, then fail + refund, nothing shipped.
  await resetPlan(planned.map((chunk) => chunk.speechText), {
    transcript: (index) => index === 0 ? dropPhrase(chunkTexts[0]) : chunkTexts[index],
  });
  const submissionsBeforeExhausted = requests.size;
  const beforeExhausted = await usage();
  const exhaustedStarted = await start("exhausted");
  const exhausted = await runToTerminal(exhaustedStarted.job.id);
  assert.equal(exhausted.status, "failed_output");
  assert.equal(exhausted.errorCode, "OMNIVOICE_CONTENT_DROPPED");
  assert.equal(exhausted.chargeState, "refunded");
  assert.equal(exhausted.outputUrl, null, "no audio with dropped words is ever exposed");
  assert.equal(requests.size - submissionsBeforeExhausted, 3, "original + two retries, never a fourth");
  assert.deepEqual(
    [...requests.values()].slice(-3).map((request) => request.seed - BASE_SEED),
    [0, 1, 2],
    "retries walk the seed forward one at a time",
  );
  const exhaustedState = stateOf(exhausted.inputJson);
  assert.equal(exhaustedState.asrGate?.chunks[0].rejected.length, 2, "both replacements are recorded before the terminal failure");
  assert.equal(exhaustedState.cloneSnapshots[0].synthesis.seed, BASE_SEED + 2);
  const exhaustedAttempts = await attemptRows(exhausted.id);
  assert.equal(exhaustedAttempts.length, 1, "chunk 2 never starts");
  assert.equal(exhaustedAttempts[0].status, "failed_output");
  assert.equal(exhaustedAttempts[0].errorCode, "OMNIVOICE_CONTENT_DROPPED");
  assert.equal((exhausted.errorMessage ?? "").includes(PRIVATE_SENTINEL), false);
  assertUsageEqual(await usage(), beforeExhausted, "the failed job refunds its reservation");
  await hero.advanceHeroVoiceGeneration(user.id, exhausted.id);
  assertUsageEqual(await usage(), beforeExhausted, "terminal replay cannot refund twice");
  noPartsLeft(exhausted.id);

  // 6. Both ears unavailable (5xx): the part is kept but marked unverified, never refunded for an outage.
  await resetPlan(planned.map((chunk) => chunk.speechText), { transcript: (index) => chunkTexts[index], earStatus: 503 });
  const submissionsBeforeDeaf = requests.size;
  const deaf = await runToTerminal((await start("ears-down")).job.id);
  assert.equal(deaf.status, "completed", "an ASR outage is not a content failure");
  assert.equal(requests.size - submissionsBeforeDeaf, 2, "an outage never spends a retry generation");
  assert.deepEqual(stateOf(deaf.inputJson).asrGate, {
    version: 1,
    chunks: [
      { sequence: 1, attempts: 1, droppedRun: null, insertedRun: null, ears: 0, rejected: [] },
      { sequence: 2, attempts: 1, droppedRun: null, insertedRun: null, ears: 0, rejected: [] },
    ],
  });
  const outageEvents = await prisma.telemetryEvent.count({ where: { userId: user.id, name: "omnivoice_asr_gate_unavailable" } });
  assert.equal(outageEvents, 2, "each unverified part is reported");

  // 7. A corrupt gate record is rejected like any other durable-state corruption.
  await resetPlan(planned.map((chunk) => chunk.speechText), { transcript: (index) => chunkTexts[index] });
  const corruptStarted = await start("corrupt-gate");
  const corruptState = JSON.parse(corruptStarted.job.inputJson ?? "{}") as Record<string, unknown>;
  corruptState.asrGate = { version: 1, chunks: [{ sequence: 1, attempts: "two" }] };
  await prisma.aiGenerationJob.update({ where: { id: corruptStarted.job.id }, data: { inputJson: JSON.stringify(corruptState) } });
  const corrupt = await hero.advanceHeroVoiceGeneration(user.id, corruptStarted.job.id);
  assert.equal(corrupt.status, "failed_identity");
  assert.equal(corrupt.errorCode, "CLONE_SNAPSHOT_INVALID");

  const telemetry = JSON.stringify(await prisma.telemetryEvent.findMany({ where: { userId: user.id } }));
  for (const secret of [PRIVATE_SENTINEL, API_SECRET_SENTINEL, GEMINI_SECRET_SENTINEL, referenceBase64]) {
    assert.equal(telemetry.includes(secret), false, "telemetry carries no secret, transcript of the reference, or audio");
  }
  const persistedJobs = JSON.stringify(await prisma.aiGenerationJob.findMany({ where: { userId: user.id } }));
  for (const secret of [refText, GEMINI_SECRET_SENTINEL, referenceBase64]) {
    assert.equal(persistedJobs.includes(secret), false, "durable state carries no reference data or key");
  }
  if (PRODUCTION_GATE) {
    // 8. Rollback is one variable: without the opt-in, production refuses to start a clone job.
    delete process.env.HERO_VOICE_CLONE_PRODUCTION;
    await resetPlan(planned.map((chunk) => chunk.speechText), { transcript: (index) => chunkTexts[index] });
    await assert.rejects(start("opt-in-removed"), (error: unknown) => (error as { code?: string })?.code === "CLONE_CONFIG_UNAVAILABLE",
      "NODE_ENV=production without HERO_VOICE_CLONE_PRODUCTION cannot start a clone job");
    process.env.HERO_VOICE_CLONE_PRODUCTION = "1";
  }
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  console.log(`Hero Voice ASR gate runtime checks passed (${PRODUCTION_GATE ? "owner-consent production gate, NODE_ENV=production" : "canary gate"}).`);
}

main().finally(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(storage, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
