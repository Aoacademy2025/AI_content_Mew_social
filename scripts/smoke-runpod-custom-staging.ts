import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", override: false, quiet: true });

type Mode = "omnivoice" | "z-image";
type RunpodJob = {
  id?: string;
  status?: string;
  output?: Record<string, unknown>;
  error?: string;
  message?: string;
  delayTime?: number;
  executionTime?: number;
  cost?: number;
};

const mode = process.argv[2] as Mode | undefined;
const resumeJobId = process.argv.find((value) => value.startsWith("--job-id="))?.slice(9).trim();
const requestedSeedRaw = process.argv.find((value) => value.startsWith("--seed="))?.slice(7).trim();
const requestedSeed = requestedSeedRaw ? Number(requestedSeedRaw) : 20260721;
const apiKey = process.env.RUNPOD_API_KEY?.trim();
const startedAt = Date.now();
if (mode !== "omnivoice" && mode !== "z-image") {
  throw new Error("Usage: smoke:runpod-custom-staging -- <omnivoice|z-image> [--job-id=...] [--seed=<integer>]");
}
if (!apiKey) throw new Error("RUNPOD_API_KEY is missing");
if (!Number.isSafeInteger(requestedSeed) || requestedSeed < 0) {
  throw new Error("--seed must be a non-negative safe integer");
}

const endpointId = (mode === "omnivoice"
  ? process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID
  : process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID)?.trim();
if (!endpointId) throw new Error(`Custom ${mode} endpoint ID is missing`);

async function runpod(operation: string, init?: RequestInit): Promise<RunpodJob> {
  const response = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/${operation}`, {
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
  let body: RunpodJob;
  try {
    body = JSON.parse(source) as RunpodJob;
  } catch {
    throw new Error(`Runpod returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      body.error
      || body.message
      || `Runpod request failed (${response.status}): ${source.slice(0, 500)}`,
    );
  }
  return body;
}

function replaceTokens(value: unknown, replacements: Record<string, string | number>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  for (const [token, replacement] of Object.entries(replacements)) {
    if (value === token && typeof replacement === "number") return replacement;
  }
  return Object.entries(replacements).reduce(
    (text, [token, replacement]) => text.split(token).join(String(replacement)),
    value,
  );
}

function buildPayload(): Record<string, unknown> {
  if (mode === "omnivoice") {
    return {
      input: {
        op: "tts",
        text: "สวัสดีค่ะ นี่คือการทดสอบเสียงจากระบบฮีโร่เอไอ",
        voice_id: "voice_01",
        num_step: 32,
        speed: 1,
      },
    };
  }

  const workflowPath = path.resolve(
    process.env.RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH?.trim() || "config/ai-workflows/z-image-turbo.json",
  );
  const source = JSON.parse(fs.readFileSync(workflowPath, "utf8")) as unknown;
  const workflow = replaceTokens(source, {
    "{{PROMPT}}": "A Thai specialty coffee shop owner preparing hand-poured coffee in soft morning window light, cinematic vertical editorial photograph, natural skin texture, realistic hands, no text, no logo",
    "{{NEGATIVE_PROMPT}}": "letters, words, typography, watermark, logo, malformed hands, extra fingers, low quality",
    "{{WIDTH}}": 720,
    "{{HEIGHT}}": 1280,
    "{{SEED}}": requestedSeed,
  });
  if (JSON.stringify(workflow).includes("{{")) throw new Error("Workflow contains unresolved tokens");
  return { input: { workflow } };
}

async function waitForCompletion(jobId: string, initial: RunpodJob): Promise<RunpodJob> {
  // A fully cold 28 GB BF16 image has previously waited ~55 minutes for the
  // scarce 48 GB pool. Keep following the same durable job instead of timing
  // out locally and tempting an operator to submit a duplicate.
  const deadline = Date.now() + 75 * 60_000;
  let result = initial;
  let lastStatus = "";
  let lastUpdate = 0;
  while (result.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(result.status ?? "")) {
      throw new Error(result.error || `Runpod job ${result.status}`);
    }
    if (Date.now() >= deadline) throw new Error("Runpod custom smoke job exceeded 75 minutes");
    if (result.status !== lastStatus || Date.now() - lastUpdate >= 30_000) {
      console.log(`status=${result.status ?? "UNKNOWN"} elapsed_s=${Math.round((Date.now() - startedAt) / 1000)}`);
      lastStatus = result.status ?? "";
      lastUpdate = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    result = await runpod(`status/${encodeURIComponent(jobId)}`);
  }
  return result;
}

function outputDirectory(): string {
  const directory = path.resolve("public", "renders");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function saveAudio(jobId: string, output: Record<string, unknown>): string {
  if (typeof output.audio_base64 !== "string") throw new Error("OmniVoice completed without audio_base64");
  const bytes = Buffer.from(output.audio_base64, "base64");
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("OmniVoice output is not a valid WAV container");
  }
  const outputPath = path.join(outputDirectory(), `runpod-omnivoice-smoke-${jobId}.wav`);
  fs.writeFileSync(outputPath, bytes);
  console.log(`audio_bytes=${bytes.length}`);
  console.log(`duration_s=${String(output.duration ?? "UNKNOWN")}`);
  console.log(`sample_rate=${String(output.sample_rate ?? "UNKNOWN")}`);
  console.log(`worker_version=${String(output.worker_version ?? "UNKNOWN")}`);
  return outputPath;
}

function imageExtension(bytes: Buffer): ".png" | ".jpg" | ".webp" {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  throw new Error("Runpod image output has an unsupported signature");
}

async function saveImage(jobId: string, output: Record<string, unknown>): Promise<string> {
  const image = Array.isArray(output.images) ? output.images[0] as Record<string, unknown> | undefined : undefined;
  if (!image || typeof image.data !== "string") throw new Error("Z-Image completed without images[0].data");
  let bytes: Buffer;
  if (image.type === "base64") {
    const encoded = image.data.includes(",") ? image.data.slice(image.data.indexOf(",") + 1) : image.data;
    bytes = Buffer.from(encoded, "base64");
  } else if (image.type === "s3_url") {
    const url = new URL(image.data);
    if (url.protocol !== "https:") throw new Error("Z-Image output URL must use HTTPS");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Z-Image output download failed (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error(`Unsupported Z-Image output type: ${String(image.type)}`);
  }
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("Z-Image output size is invalid");
  const outputPath = path.join(outputDirectory(), `runpod-z-image-custom-smoke-${jobId}${imageExtension(bytes)}`);
  fs.writeFileSync(outputPath, bytes);
  console.log(`image_bytes=${bytes.length}`);
  return outputPath;
}

async function main() {
  const submitted = resumeJobId
    ? await runpod(`status/${encodeURIComponent(resumeJobId)}`)
    : await runpod("run", { method: "POST", body: JSON.stringify(buildPayload()) });
  const jobId = submitted.id || resumeJobId;
  if (!jobId) throw new Error("Runpod returned no job id");
  console.log(`mode=${mode}`);
  console.log(`endpoint_id=${endpointId}`);
  console.log(`job_id=${jobId}`);
  console.log(`resumed_existing_job=${resumeJobId ? "YES" : "NO"}`);

  const result = await waitForCompletion(jobId, submitted);
  const output = result.output;
  if (!output) throw new Error("Runpod completed without output");
  const saved = mode === "omnivoice" ? saveAudio(jobId, output) : await saveImage(jobId, output);
  console.log(`delay_ms=${Math.round(result.delayTime ?? 0)}`);
  console.log(`execution_ms=${Math.round(result.executionTime ?? 0)}`);
  console.log(`provider_cost_usd=${typeof output.cost === "number" ? output.cost.toFixed(6) : typeof result.cost === "number" ? result.cost.toFixed(6) : "UNKNOWN"}`);
  console.log(`saved=${saved}`);
}

main().catch((error) => {
  console.error(`smoke_failed=${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
