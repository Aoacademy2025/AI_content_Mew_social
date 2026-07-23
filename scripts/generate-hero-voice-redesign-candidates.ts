// Paid, staging-only candidate generator for the Hero AI Voice catalog audit.
// This never promotes candidates or mutates the application catalog.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { pcmFromWav } from "../src/lib/omnivoice-core";
import redesignPlan from "../services/omnivoice-runpod/assets/voices/redesign-plan.json";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

type Endpoint = {
  id: string;
  name: string;
  workersMin: number;
  workersMax: number;
};

type Job = {
  id?: string;
  status?: string;
  error?: string;
  output?: {
    audio_base64?: string;
    duration?: number;
    worker_version?: string;
    language?: string;
    num_step?: number;
    seed?: number;
    instruct?: string;
    text?: string;
  };
};

const CANONICAL_TEXT = "ยินดีต้อนรับสู่ระบบสร้างวิดีโอภาษาไทย พร้อมเริ่มต้นสร้างผลงานแล้ววันนี้";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
const endpointId = process.argv.find((arg) => arg.startsWith("--endpoint="))?.slice("--endpoint=".length).trim();
const outputDirectory = process.argv.find((arg) => arg.startsWith("--out-dir="))?.slice("--out-dir=".length).trim();
const seedCountArg = process.argv.find((arg) => arg.startsWith("--seeds="))?.slice("--seeds=".length);
const seedCount = Number(seedCountArg ?? 6);
const seedRoundArg = process.argv.find((arg) => arg.startsWith("--seed-round="))?.slice("--seed-round=".length);
const seedRound = Number(seedRoundArg ?? 1);
const requestedVoiceIds = process.argv.find((arg) => arg.startsWith("--voices="))
  ?.slice("--voices=".length)
  .split(",")
  .map((voiceId) => voiceId.trim())
  .filter(Boolean);
const selectedPlan = requestedVoiceIds?.length
  ? redesignPlan.filter((voice) => requestedVoiceIds.includes(voice.id))
  : redesignPlan;
const apply = process.argv.includes("--apply");

if (!apiKey) throw new Error("RUNPOD_API_KEY is required");
if (!endpointId) throw new Error("Pass the explicit staging design endpoint with --endpoint=<id>");
if (!outputDirectory || !path.isAbsolute(outputDirectory)) {
  throw new Error("Pass an explicit absolute temporary directory with --out-dir=<path>");
}
if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > 12) {
  throw new Error("--seeds must be an integer from 1 to 12");
}
if (!Number.isInteger(seedRound) || seedRound < 1 || seedRound > 9) {
  throw new Error("--seed-round must be an integer from 1 to 9");
}
if (requestedVoiceIds?.length && selectedPlan.length !== requestedVoiceIds.length) {
  throw new Error("--voices contains an ID outside redesign-plan.json");
}

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const source = await response.text();
  let body: unknown;
  try { body = source ? JSON.parse(source) : null; }
  catch { throw new Error(`${url} returned non-JSON status ${response.status}`); }
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  return body as T;
}

async function waitForJob(jobId: string, initial: Job): Promise<Job> {
  const deadline = Date.now() + 30 * 60_000;
  let job = initial;
  let lastStatus = "";
  let lastUpdate = 0;
  while (job.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status ?? "")) {
      throw new Error(job.error || `RunPod job ${job.status}`);
    }
    if (Date.now() >= deadline) throw new Error(`RunPod job ${jobId} exceeded 30 minutes`);
    if (job.status !== lastStatus || Date.now() - lastUpdate >= 30_000) {
      console.log(JSON.stringify({ event: "progress", jobId, status: job.status }));
      lastStatus = job.status ?? "";
      lastUpdate = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    job = await request<Job>(
      `https://api.runpod.ai/v2/${encodeURIComponent(endpointId!)}/status/${encodeURIComponent(jobId)}`,
    );
  }
  return job;
}

async function generate(voice: (typeof redesignPlan)[number], seed: number) {
  const submitted = await request<Job>(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId!)}/run`, {
    method: "POST",
    body: JSON.stringify({
      input: {
        operation: "design",
        text: CANONICAL_TEXT,
        instruct: voice.instruct,
        num_step: 32,
        seed,
      },
    }),
  });
  if (!submitted.id) throw new Error(`${voice.id} seed ${seed}: RunPod returned no job id`);
  console.log(JSON.stringify({ event: "submitted", voiceId: voice.id, seed, jobId: submitted.id }));
  const completed = await waitForJob(submitted.id, submitted);
  const output = completed.output;
  if (
    !output?.audio_base64
    || output.worker_version !== "heroai-omnivoice-design-recovery-v1"
    || output.language !== "th"
    || output.num_step !== 32
    || output.seed !== seed
    || output.instruct !== voice.instruct
    || output.text !== CANONICAL_TEXT
  ) {
    throw new Error(`${voice.id} seed ${seed}: output contract mismatch`);
  }
  const audio = Buffer.from(output.audio_base64, "base64");
  const parsed = pcmFromWav(audio);
  const durationSeconds = parsed.pcm.length / (parsed.sampleRate * 2);
  if (parsed.sampleRate !== 24_000 || durationSeconds < 2 || durationSeconds > 10) {
    throw new Error(`${voice.id} seed ${seed}: invalid WAV duration/rate (${durationSeconds.toFixed(2)}s)`);
  }

  const voiceDirectory = path.join(outputDirectory!, voice.id);
  fs.mkdirSync(voiceDirectory, { recursive: true, mode: 0o700 });
  const stem = `seed-${seed}`;
  fs.writeFileSync(path.join(voiceDirectory, `${stem}.wav`), audio, { mode: 0o600 });
  fs.writeFileSync(path.join(voiceDirectory, `${stem}.json`), JSON.stringify({
    voiceId: voice.id,
    reason: voice.reason,
    instruct: voice.instruct,
    text: CANONICAL_TEXT,
    seed,
    jobId: submitted.id,
    durationSeconds,
    workerVersion: output.worker_version,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ event: "saved", voiceId: voice.id, seed, durationSeconds }));
}

async function main() {
  const endpoint = await request<Endpoint>(
    `https://rest.runpod.io/v1/endpoints/${encodeURIComponent(endpointId!)}`,
  );
  if (!/staging|design-audit/i.test(endpoint.name) || endpoint.workersMin !== 0 || endpoint.workersMax !== 1) {
    throw new Error("Refusing candidate generation outside a scale-to-zero staging endpoint");
  }
  console.log(JSON.stringify({
    event: "plan",
    endpoint: { id: endpoint.id, name: endpoint.name },
    voices: selectedPlan,
    seedCount,
    seedRound,
    jobs: selectedPlan.length * seedCount,
    outputDirectory,
    apply,
  }));
  if (!apply) return;

  fs.mkdirSync(outputDirectory!, { recursive: true, mode: 0o700 });
  const failures: string[] = [];
  for (const voice of selectedPlan) {
    const voiceNumber = Number(voice.id.slice(-2));
    for (let offset = 1; offset <= seedCount; offset += 1) {
      const seed = voiceNumber * 10_000 + (6_000 + seedRound * 1_000) + offset;
      try {
        await generate(voice, seed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        failures.push(`${voice.id}/${seed}: ${message}`);
        console.error(JSON.stringify({ event: "failed", voiceId: voice.id, seed, message }));
      }
    }
  }
  if (failures.length) throw new Error(`${failures.length} candidate jobs failed: ${failures.join("; ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "candidate generation failed");
  process.exitCode = 1;
});
