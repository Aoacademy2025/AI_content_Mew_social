// T5 (hv-emotion) Step 0.3 smoke for the v13 dynamic-ref staging worker.
// Submits exactly 2 jobs against this experiment's own endpoint
// (d66lniwmhsjt51, now running the freshly-pushed v13 image):
//   1. baked-ref path (voice_id only, class_temperature=0.0) — must be
//      byte-identical-contract to v12/v11 behavior, echoes ref_source="baked".
//   2. payload-ref path — feeds job 1's own WAV output back in as
//      ref_audio_b64/ref_text, echoes ref_source="payload".
// Counts 2/650 toward the task job cap. Never logs raw RunPod worker objects
// (scrub to {id, desiredStatus} only — T2 hygiene lesson).
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const REST_BASE = "https://rest.runpod.io/v1";
const QUEUE_BASE = "https://api.runpod.ai/v2";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const ENDPOINT_ID = "d66lniwmhsjt51"; // hv-emotion-v12-omnivoice-staging (this experiment's own)
const EXPECTED_WORKER_VERSION = "heroai-omnivoice-runpod-v8-all-voices-32-temp-dynref";
const BAKED_TEXT = "สวัสดีค่ะ นี่คือการทดสอบเสียงภาษาไทยของฮีโร่ เอไอ วอยซ์ เวอร์ชันสิบสาม";
const PAYLOAD_TEXT = "นี่คือการทดสอบการโคลนเสียงจากไฟล์อ้างอิงที่ส่งมาโดยตรง";

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
    ref_source?: string;
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
    ref_source: job.output?.ref_source,
    num_step: job.output?.num_step,
    language: job.output?.language,
    audio_bytes_b64_len: job.output?.audio_base64?.length,
    duration: job.output?.duration,
  }));
  return { label, job, wallMs };
}

function assertContract(label: string, job: Job, expectedRefSource: "baked" | "payload") {
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
  if (output.ref_source !== expectedRefSource) {
    throw new Error(`${label}: expected ref_source=${expectedRefSource}, got ${output.ref_source}`);
  }
}

async function waitForScaleDown(idleTimeoutSeconds = 60): Promise<void> {
  const deadline = Date.now() + (idleTimeoutSeconds + 300) * 1_000;
  let consecutiveStoppedChecks = 0;
  while (Date.now() < deadline) {
    const endpoints = await jsonRequest<Endpoint[]>(`${REST_BASE}/endpoints?includeWorkers=true`);
    const current = endpoints.find((item) => item.id === ENDPOINT_ID);
    const workers = current?.workers ?? [];
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
  const jobBaked = await runJob("baked-ref (voice_01, temp 0.0)", {
    operation: "tts",
    voice_id: "voice_01",
    text: BAKED_TEXT,
    num_step: 32,
    speed: 1,
    class_temperature: 0.0,
  });
  assertContract("baked", jobBaked.job, "baked");

  const bakedAudioB64 = jobBaked.job.output!.audio_base64!;
  const bakedDuration = jobBaked.job.output!.duration!;
  if (!(bakedDuration >= 3.0 && bakedDuration <= 20.0)) {
    throw new Error(`baked-ref output duration ${bakedDuration}s is outside the 3-20s ref_audio_b64 window; cannot chain into payload smoke`);
  }

  const jobPayload = await runJob("payload-ref (cloned from job 1's own WAV)", {
    operation: "tts",
    voice_id: "voice_01", // telemetry-only in payload mode per contract
    text: PAYLOAD_TEXT,
    num_step: 32,
    speed: 1,
    class_temperature: 0.0,
    ref_audio_b64: bakedAudioB64,
    ref_text: BAKED_TEXT,
  });
  assertContract("payload", jobPayload.job, "payload");

  console.log(JSON.stringify({
    event: "summary",
    jobs: [jobBaked, jobPayload].map((r) => ({
      label: r.label,
      jobId: r.job.id,
      wallMs: r.wallMs,
      delayTime: r.job.delayTime,
      executionTime: r.job.executionTime,
      ref_source: r.job.output?.ref_source,
      worker_version: r.job.output?.worker_version,
    })),
  }));

  await waitForScaleDown(60);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "smoke failed");
  process.exit(1);
});
