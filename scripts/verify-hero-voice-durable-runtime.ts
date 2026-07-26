import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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
process.env.RUNPOD_API_KEY = "test-key";
process.env.OMNIVOICE_REQUEST_BUDGET_MS = "840000";

const requests: Array<{ url: string; body: string }> = [];
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
  requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });

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
        voice_id: "voice_01",
        audio_base64: wavBase64,
        sample_rate: 24_000,
        generation_time: 1.1,
        worker_version: "test-v11",
        language: "th",
        num_step: 32,
      },
    });
  }
  if (url.endsWith("/cancel/durable-job-2")) {
    return Response.json({ id: "durable-job-2", status: "CANCELLED" });
  }
  return Response.json({ error: `unexpected request: ${url}` }, { status: 500 });
};

async function main() {
  const [{ prisma }, hero] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/hero-voice-generation.server"),
  ]);
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: {
      name: "Hero durable test",
      email: "hero-durable@test.invalid",
      plan: "PRO",
      planExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      usagePeriodStartedAt: new Date(),
    },
  });

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
  assert.equal(runBody.input.voice_id, "voice_01");
  assert.equal(runBody.input.num_step, 32);

  for (const job of await prisma.aiGenerationJob.findMany({
    where: { userId: user.id },
    select: { outputUrl: true },
  })) {
    if (!job.outputUrl?.startsWith("/api/renders/")) continue;
    try { fs.unlinkSync(path.join(process.cwd(), "public", "renders", path.basename(job.outputUrl))); } catch {}
  }
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  console.log("Durable Hero Voice submit/poll/pin/cancel runtime checks passed.");
}

main().finally(() => {
  globalThis.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
