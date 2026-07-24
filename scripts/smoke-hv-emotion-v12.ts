// T2 (hv-emotion) smoke test for the new v12 staging endpoint.
// Submits exactly 4 jobs on voice_01 (default / 0.0 / mid / max class_temperature),
// asserts the contract, records timings, then waits for scale-to-zero (EXITED).
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const REST_BASE = "https://rest.runpod.io/v1";
const QUEUE_BASE = "https://api.runpod.ai/v2";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const ENDPOINT_ID = "d66lniwmhsjt51"; // hv-emotion-v12-omnivoice-staging
const EXPECTED_WORKER_VERSION = "heroai-omnivoice-runpod-v7-all-voices-32-temp";
const TEXT = "สวัสดีค่ะ นี่คือการทดสอบเสียงภาษาไทยของฮีโร่ เอไอ วอยซ์";

type Job = {
  id?: string;
  status?: string;
  delayTime?: number;
  executionTime?: number;
  error?: string;
  output?: {
    audio_base64?: string;
    format?: string;
    voice_id?: string;
    duration?: number;
    generation_time?: number;
    worker_version?: string;
    language?: string;
    num_step?: number;
    class_temperature?: number;
  };
};

type Endpoint = { id: string; workers?: Array<{ id?: string; desiredStatus?: string }> };

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const source = await response.text();
  let body: unknown;
  try {
    body = source ? JSON.parse(source) : null;
  } catch {
    throw new Error(`${url} returned non-JSON status ${response.status}: ${source.slice(0, 300)}`);
  }
  if (!response.ok) {
    // Scrub before embedding in the thrown message: an error body from the
    // endpoints/workers listing (REST_BASE /endpoints?includeWorkers=true,
    // an array of endpoints each with a `workers` array) can carry
    // per-worker secrets (RUNPOD_AI_API_KEY / RUNPOD_ENDPOINT_SECRET), and
    // this message is logged verbatim by the top-level catch in main().
    const redactWorkers = (value: unknown): unknown =>
      value && typeof value === "object" && "workers" in value
        ? { ...(value as Record<string, unknown>), workers: "[redacted]" }
        : value;
    const safeBody = Array.isArray(body) ? body.map(redactWorkers) : redactWorkers(body);
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `${url} failed with status ${response.status}: ${JSON.stringify(safeBody)}`;
    throw new Error(message);
  }
  return body as T;
}

async function runJob(label: string, input: Record<string, unknown>): Promise<{ label: string; job: Job; wallMs: number }> {
  const wallStartedAt = Date.now();
  const submitted = await jsonRequest<Job>(`${QUEUE_BASE}/${ENDPOINT_ID}/run`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  if (!submitted.id) throw new Error(`${label}: RunPod returned no job id`);
  console.log(JSON.stringify({ event: "submitted", label, jobId: submitted.id }));

  const deadline = Date.now() + 10 * 60_000;
  let job = submitted;
  let lastStatus = "";
  while (job.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status ?? "")) {
      throw new Error(`${label}: ${job.error || job.status}`);
    }
    if (Date.now() >= deadline) throw new Error(`${label}: exceeded 10 minutes`);
    if (job.status !== lastStatus) {
      console.log(JSON.stringify({ event: "progress", label, status: job.status }));
      lastStatus = job.status ?? "";
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    job = await jsonRequest<Job>(`${QUEUE_BASE}/${ENDPOINT_ID}/status/${submitted.id}`);
  }
  const wallMs = Date.now() - wallStartedAt;
  console.log(JSON.stringify({
    event: "completed",
    label,
    wallMs,
    delayTime: job.delayTime,
    executionTime: job.executionTime,
    worker_version: job.output?.worker_version,
    class_temperature: job.output?.class_temperature,
    num_step: job.output?.num_step,
    language: job.output?.language,
    audio_bytes_b64_len: job.output?.audio_base64?.length,
    duration: job.output?.duration,
  }));
  return { label, job, wallMs };
}

function assertContract(label: string, job: Job, expectedClassTemperature: number) {
  const output = job.output;
  if (!output?.audio_base64 || output.format !== "wav") {
    throw new Error(`${label}: missing/invalid WAV output`);
  }
  if (output.worker_version !== EXPECTED_WORKER_VERSION) {
    throw new Error(`${label}: expected worker_version=${EXPECTED_WORKER_VERSION}, got ${output.worker_version}`);
  }
  if (output.language !== "th") {
    throw new Error(`${label}: expected language=th, got ${output.language}`);
  }
  if (output.num_step !== 32) {
    throw new Error(`${label}: expected num_step=32, got ${output.num_step}`);
  }
  if (output.class_temperature !== expectedClassTemperature) {
    throw new Error(`${label}: expected class_temperature=${expectedClassTemperature}, got ${output.class_temperature}`);
  }
}

async function waitForScaleDown(idleTimeoutSeconds = 60): Promise<void> {
  const deadline = Date.now() + (idleTimeoutSeconds + 300) * 1_000;
  let consecutiveStoppedChecks = 0;
  while (Date.now() < deadline) {
    const endpoints = await jsonRequest<Endpoint[]>(`${REST_BASE}/endpoints?includeWorkers=true`);
    const current = endpoints.find((item) => item.id === ENDPOINT_ID);
    const workers = current?.workers ?? [];
    // Scrub before logging: RunPod worker objects can carry per-worker
    // secrets (RUNPOD_AI_API_KEY / RUNPOD_ENDPOINT_SECRET) — never log the
    // raw worker, only the fields this script actually needs.
    const scrubbedWorkers = workers.map((worker) => ({ id: worker.id, desiredStatus: worker.desiredStatus }));
    const activeWorkers = workers.filter((worker) => worker.desiredStatus !== "EXITED");
    if (activeWorkers.length === 0) {
      consecutiveStoppedChecks += 1;
      if (consecutiveStoppedChecks >= 2) {
        console.log(JSON.stringify({ event: "scale-down-confirmed", workers: scrubbedWorkers }));
        return;
      }
    } else {
      consecutiveStoppedChecks = 0;
      console.log(JSON.stringify({ event: "waiting-for-scale-down", workers: scrubbedWorkers }));
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`worker did not scale down after ${idleTimeoutSeconds + 300} seconds`);
}

async function main() {
  const results: Array<{ label: string; job: Job; wallMs: number }> = [];

  const jobDefault = await runJob("default (no class_temperature key)", {
    operation: "tts",
    voice_id: "voice_01",
    text: TEXT,
    num_step: 32,
    speed: 1,
  });
  assertContract("default", jobDefault.job, 0.0);
  results.push(jobDefault);

  const jobZero = await runJob("explicit class_temperature=0.0", {
    operation: "tts",
    voice_id: "voice_01",
    text: TEXT,
    num_step: 32,
    speed: 1,
    class_temperature: 0.0,
  });
  assertContract("explicit-0.0", jobZero.job, 0.0);
  results.push(jobZero);

  // default==0.0 parameters echoed identically
  const a = jobDefault.job.output!;
  const b = jobZero.job.output!;
  if (a.worker_version !== b.worker_version || a.num_step !== b.num_step || a.language !== b.language || a.class_temperature !== b.class_temperature) {
    throw new Error("default and explicit-0.0 jobs did not echo identical parameters");
  }
  console.log(JSON.stringify({ event: "assert-default-equals-zero", ok: true }));

  const jobMid = await runJob("mid class_temperature=2.5", {
    operation: "tts",
    voice_id: "voice_01",
    text: TEXT,
    num_step: 32,
    speed: 1,
    class_temperature: 2.5,
  });
  assertContract("mid-2.5", jobMid.job, 2.5);
  results.push(jobMid);

  const jobMax = await runJob("max valid class_temperature=5.0", {
    operation: "tts",
    voice_id: "voice_01",
    text: TEXT,
    num_step: 32,
    speed: 1,
    class_temperature: 5.0,
  });
  assertContract("max-5.0", jobMax.job, 5.0);
  results.push(jobMax);

  console.log(JSON.stringify({
    event: "summary",
    jobs: results.map((r) => ({
      label: r.label,
      jobId: r.job.id,
      wallMs: r.wallMs,
      delayTime: r.job.delayTime,
      executionTime: r.job.executionTime,
      class_temperature: r.job.output?.class_temperature,
      worker_version: r.job.output?.worker_version,
    })),
  }));

  await waitForScaleDown(60);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "smoke failed");
  process.exit(1);
});
