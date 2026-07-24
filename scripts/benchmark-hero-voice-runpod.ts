// Paid staging-only benchmark for Hero AI Voice cold/warm/FlashBoot behavior.
// Dry-run: npm run benchmark:hero-voice-runpod -- --endpoint=<staging-id>
// Execute: npm run benchmark:hero-voice-runpod -- --endpoint=<staging-id> --apply

import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

type Endpoint = {
  id: string;
  name: string;
  idleTimeout: number;
  flashboot: boolean;
  workersMin: number;
  workersMax: number;
  gpuTypeIds: string[];
  workers?: Array<{ id?: string; status?: string; desiredStatus?: string }>;
};

type Job = {
  id?: string;
  status?: string;
  delayTime?: number;
  executionTime?: number;
  error?: string;
  output?: {
    audio_base64?: string;
    duration?: number;
    generation_time?: number;
    worker_version?: string;
    language?: string;
    voice_id?: string;
    num_step?: number;
  };
};

const apiKey = process.env.RUNPOD_API_KEY?.trim();
const endpointId = process.argv.find((arg) => arg.startsWith("--endpoint="))?.slice("--endpoint=".length).trim();
const apply = process.argv.includes("--apply");
const qualityFloor = process.argv.includes("--quality-floor");
const roundsSource = process.argv.find((arg) => arg.startsWith("--rounds="))?.slice("--rounds=".length) ?? "1";
const rounds = Number(roundsSource);
const numStepSource = process.argv.find((arg) => arg.startsWith("--num-step="))?.slice("--num-step=".length) ?? "32";
const benchmarkNumStep = Number(numStepSource);
const expectedWorkerVersion = process.argv.find((arg) => arg.startsWith("--expected-worker-version="))
  ?.slice("--expected-worker-version=".length)
  .trim();
const queueBase = "https://api.runpod.ai/v2";
const restBase = "https://rest.runpod.io/v1";

if (!apiKey) throw new Error("RUNPOD_API_KEY is required");
if (!endpointId) throw new Error("Pass the explicit staging endpoint with --endpoint=<id>");
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
  throw new Error("--rounds must be an integer from 1 to 5");
}
if (!Number.isInteger(benchmarkNumStep) || benchmarkNumStep < 1 || benchmarkNumStep > 64) {
  throw new Error("--num-step must be an integer from 1 to 64");
}

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
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
  if (!response.ok) {
    const reason = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return body as T;
}

async function endpoint(): Promise<Endpoint> {
  return jsonRequest<Endpoint>(`${restBase}/endpoints/${encodeURIComponent(endpointId!)}`);
}

async function endpointWithWorkers(): Promise<Endpoint> {
  const endpoints = await jsonRequest<Endpoint[]>(`${restBase}/endpoints?includeWorkers=true`);
  const selected = endpoints.find((item) => item.id === endpointId);
  if (!selected) throw new Error(`Staging endpoint ${endpointId} was not found`);
  return selected;
}

async function waitForScaleDown(label: string, idleTimeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + (idleTimeoutSeconds + 300) * 1_000;
  let consecutiveStoppedChecks = 0;
  let lastProgressAt = 0;

  while (Date.now() < deadline) {
    const current = await endpointWithWorkers();
    const workers = current.workers ?? [];
    const activeWorkers = workers.filter((worker) => worker.desiredStatus !== "EXITED");
    if (activeWorkers.length === 0) {
      consecutiveStoppedChecks += 1;
      if (consecutiveStoppedChecks >= 2) {
        console.log(JSON.stringify({
          event: "scale-down-confirmed",
          label,
          workers: workers.map((worker) => ({ id: worker.id, desiredStatus: worker.desiredStatus })),
        }));
        return;
      }
    } else {
      consecutiveStoppedChecks = 0;
    }

    const now = Date.now();
    if (now - lastProgressAt >= 15_000) {
      console.log(JSON.stringify({
        event: "waiting-for-scale-down",
        label,
        workers: workers.map((worker) => ({ id: worker.id, desiredStatus: worker.desiredStatus })),
      }));
      lastProgressAt = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`${label}: worker did not scale down after ${idleTimeoutSeconds + 300} seconds`);
}

async function runJob(
  label: string,
  voiceId: string,
  requestedNumStep = benchmarkNumStep,
  expectedNumStep = requestedNumStep,
): Promise<Record<string, unknown>> {
  const wallStartedAt = Date.now();
  const submitted = await jsonRequest<Job>(`${queueBase}/${encodeURIComponent(endpointId!)}/run`, {
    method: "POST",
    body: JSON.stringify({
      input: {
        voice_id: voiceId,
        text: "สวัสดีค่ะ นี่คือการทดสอบเสียงภาษาไทยของฮีโร่ เอไอ วอยซ์",
        speed: 1,
        num_step: requestedNumStep,
      },
    }),
  });
  if (!submitted.id) throw new Error(`${label}: RunPod returned no job id`);
  console.log(JSON.stringify({ event: "submitted", label, jobId: submitted.id, at: new Date().toISOString() }));

  const deadline = Date.now() + 30 * 60_000;
  let lastStatus = "";
  let lastProgressAt = 0;
  let job = submitted;
  while (job.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status ?? "")) {
      throw new Error(`${label}: ${job.error || job.status}`);
    }
    if (Date.now() >= deadline) throw new Error(`${label}: exceeded 30 minutes`);
    const now = Date.now();
    if (job.status !== lastStatus || now - lastProgressAt >= 30_000) {
      console.log(JSON.stringify({ event: "progress", label, status: job.status, wallMs: now - wallStartedAt }));
      lastStatus = job.status ?? "";
      lastProgressAt = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    job = await jsonRequest<Job>(
      `${queueBase}/${encodeURIComponent(endpointId!)}/status/${encodeURIComponent(submitted.id)}`,
    );
  }

  const output = job.output;
  if (!output?.audio_base64 || !output.worker_version?.startsWith("heroai-omnivoice-runpod-v") || output.language !== "th") {
    throw new Error(`${label}: output contract or Thai worker identity failed`);
  }
  if (expectedWorkerVersion && output.worker_version !== expectedWorkerVersion) {
    throw new Error(`${label}: expected worker_version=${expectedWorkerVersion}, got ${output.worker_version}`);
  }
  if (expectedNumStep !== undefined && output.num_step !== expectedNumStep) {
    throw new Error(`${label}: expected effective num_step=${expectedNumStep}, got ${output.num_step ?? "missing"}`);
  }
  const result = {
    event: "completed",
    label,
    jobId: submitted.id,
    wallMs: Date.now() - wallStartedAt,
    delayMs: Math.round(job.delayTime ?? 0),
    executionMs: Math.round(job.executionTime ?? 0),
    generationSeconds: output.generation_time,
    audioSeconds: output.duration,
    workerVersion: output.worker_version,
    language: output.language,
    voiceId: output.voice_id,
    effectiveNumStep: output.num_step,
  };
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  const before = await endpoint();
  if (!/staging/i.test(before.name)) {
    throw new Error(`Refusing paid benchmark against non-staging endpoint ${before.name}`);
  }
  if (before.workersMin !== 0 || before.workersMax !== 1 || !before.flashboot) {
    throw new Error("Staging safety gate requires workersMin=0, workersMax=1, and FlashBoot enabled");
  }
  console.log(JSON.stringify({
    event: "plan",
    endpoint: { id: before.id, name: before.name },
    config: {
      idleTimeout: before.idleTimeout,
      flashboot: before.flashboot,
      workersMin: before.workersMin,
      workersMax: before.workersMax,
      gpuTypeIds: before.gpuTypeIds,
    },
    rounds,
    benchmarkNumStep,
    expectedWorkerVersion: expectedWorkerVersion || null,
    paidRun: apply,
  }));
  if (!apply) return;

  await waitForScaleDown("before-round-1", before.idleTimeout);
  const benchmarkRounds: Array<Record<string, unknown>> = [];
  for (let round = 1; round <= rounds; round += 1) {
    const cold = await runJob(`round-${round}-cold-first-prompt`, "voice_01");
    const warm = await runJob(`round-${round}-warm-cached-prompt`, "voice_01");
    benchmarkRounds.push({ round, cold, warm });

    if (round < rounds) {
      await waitForScaleDown(`after-round-${round}`, before.idleTimeout);
    }
  }

  const quality = qualityFloor
    ? [
        await runJob("quality-floor-voice-32", "voice_32", 16, 16),
        await runJob("quality-floor-voice-33", "voice_33", 16, 16),
        await runJob("catalog-tail-voice-48", "voice_48", 8, 8),
      ]
    : [];

  await waitForScaleDown("after-final-round", before.idleTimeout);
  const afterIdle = await endpointWithWorkers();
  console.log(JSON.stringify({
    event: "after-final-idle",
    workers: (afterIdle.workers ?? []).map((worker) => ({
      id: worker.id,
      status: worker.status,
      desiredStatus: worker.desiredStatus,
    })),
  }));
  console.log(JSON.stringify({ event: "summary", rounds: benchmarkRounds, quality }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Hero Voice benchmark failed");
  process.exitCode = 1;
});
