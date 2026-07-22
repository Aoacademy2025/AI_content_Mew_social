import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { pcmFromWav } from "../src/lib/omnivoice-core";
import { RUNPOD_HERO_VOICE_PREVIEWS } from "../src/lib/hero-voice-preview";

dotenv.config({ path: ".env", override: false, quiet: true });

type RunpodJob = {
  id?: string;
  status?: string;
  output?: {
    audio_base64?: string;
    sample_rate?: number;
    duration?: number;
    worker_version?: string;
  };
  error?: string;
};

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const apiKey = process.env.RUNPOD_API_KEY?.trim();
const endpointId = process.env.RUNPOD_OMNIVOICE_ENDPOINT_ID?.trim();
const outputDirectory = path.resolve("assets", "hero-voice-previews");

async function runpod(operation: string, init?: RequestInit): Promise<RunpodJob> {
  if (!apiKey || !endpointId) throw new Error("RUNPOD_API_KEY and RUNPOD_OMNIVOICE_ENDPOINT_ID are required");
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
    throw new Error(`RunPod returned non-JSON status ${response.status}`);
  }
  if (!response.ok) throw new Error(body.error || `RunPod request failed (${response.status})`);
  return body;
}

async function waitForCompletion(jobId: string, initial: RunpodJob): Promise<RunpodJob> {
  const deadline = Date.now() + 15 * 60_000;
  let result = initial;
  while (result.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(result.status ?? "")) {
      throw new Error(result.error || `RunPod job ${result.status}`);
    }
    if (Date.now() >= deadline) throw new Error(`RunPod preview job ${jobId} exceeded 15 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await runpod(`status/${encodeURIComponent(jobId)}`);
  }
  return result;
}

async function generate(voice: (typeof RUNPOD_HERO_VOICE_PREVIEWS)[number]) {
  const outputPath = path.join(outputDirectory, voice.filename);
  if (fs.existsSync(outputPath) && !force) {
    console.log(`skip=${voice.voiceId} reason=exists`);
    return;
  }
  const submitted = await runpod("run", {
    method: "POST",
    body: JSON.stringify({
      input: {
        voice_id: voice.voiceId,
        text: voice.previewText,
        speed: 1,
        num_step: 4,
      },
    }),
  });
  if (!submitted.id) throw new Error(`RunPod returned no job id for ${voice.voiceId}`);
  console.log(`submitted=${voice.voiceId} job_id=${submitted.id}`);
  const completed = await waitForCompletion(submitted.id, submitted);
  const encoded = completed.output?.audio_base64;
  if (!encoded) throw new Error(`RunPod returned no audio for ${voice.voiceId}`);
  const audio = Buffer.from(encoded, "base64");
  const parsed = pcmFromWav(audio);
  if (audio.length > 7_000_000 || parsed.pcm.length < parsed.sampleRate * 2) {
    throw new Error(`RunPod returned an invalid preview duration for ${voice.voiceId}`);
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, audio, { mode: 0o644 });
  fs.renameSync(temporaryPath, outputPath);
  console.log(`saved=${voice.voiceId} bytes=${audio.length} duration_s=${completed.output?.duration ?? "unknown"}`);
}

async function main() {
  console.log(`output=${outputDirectory}`);
  console.log(`voices=${RUNPOD_HERO_VOICE_PREVIEWS.map((voice) => voice.voiceId).join(",")}`);
  if (!apply) {
    console.log("dry_run=YES rerun with --apply to submit three paid RunPod preview jobs");
    return;
  }
  if (!apiKey || !endpointId) throw new Error("RUNPOD_API_KEY and RUNPOD_OMNIVOICE_ENDPOINT_ID are required");
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  for (const voice of RUNPOD_HERO_VOICE_PREVIEWS) await generate(voice);
}

main().catch((error) => {
  console.error(`preview_generation_failed=${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
