import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { buildArtworkOnlyPrompt } from "../src/lib/ai-image-policy";
import { buildKieImagePrompt } from "../src/lib/kie-image-prompt";
import { publicZImageProviderInput, type RunpodJobResponse } from "../src/lib/runpod-image-contract";

dotenv.config({ path: ".env", override: false, quiet: true });

const apiKey = process.env.RUNPOD_API_KEY?.trim();
const endpointId = process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID?.trim() || "z-image-turbo";
const resumeJobId = process.argv.slice(2).find((item) => item.startsWith("--job-id="))?.slice("--job-id=".length).trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is missing");

const videoPrompt = buildKieImagePrompt(
  "a Thai specialty coffee shop owner preparing one hand-poured coffee in soft morning window light",
  { region: "thai", style: "cinematic" },
);
const prompt = buildArtworkOnlyPrompt(videoPrompt, "cinematic");
const providerInput = publicZImageProviderInput({
  prompt: prompt.positive,
  negativePrompt: prompt.negative,
  width: 768,
  height: 1344,
  seed: 20260721,
});

async function runpod(operation: string, init?: RequestInit): Promise<RunpodJobResponse> {
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
  const text = await response.text();
  let payload: RunpodJobResponse;
  try { payload = JSON.parse(text) as RunpodJobResponse; }
  catch { throw new Error(`Runpod returned non-JSON status ${response.status}`); }
  if (!response.ok) throw new Error(payload.error || `Runpod request failed (${response.status})`);
  return payload;
}

async function main() {
  const submitted = resumeJobId
    ? await runpod(`status/${encodeURIComponent(resumeJobId)}`)
    : await runpod("run", {
        method: "POST",
        body: JSON.stringify({ input: providerInput }),
      });
  const jobId = submitted.id || resumeJobId;
  if (!jobId) throw new Error("Runpod returned no job id");
  console.log(`job_id=${jobId}`);
  console.log(`submitted_status=${submitted.status ?? "UNKNOWN"}`);
  console.log(`resumed_existing_job=${resumeJobId ? "YES" : "NO"}`);

  const deadline = Date.now() + 5 * 60_000;
  let result = submitted;
  while (result.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(result.status ?? "")) {
      throw new Error(result.error || `Runpod job ${result.status}`);
    }
    if (Date.now() >= deadline) throw new Error("Runpod smoke job exceeded 5 minutes");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await runpod(`status/${encodeURIComponent(jobId)}`);
  }

  const outputUrl = result.output?.image_url ?? result.output?.result;
  if (typeof outputUrl !== "string" || !outputUrl) throw new Error("Runpod completed without image_url");
  const parsedUrl = new URL(outputUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "image.runpod.ai") {
    throw new Error(`Unexpected Runpod output host: ${parsedUrl.hostname}`);
  }

  const imageResponse = await fetch(parsedUrl, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (imageResponse.status >= 300 && imageResponse.status < 400) {
    throw new Error(`Runpod output redirected (${imageResponse.status}); storage allowlist must be updated before use`);
  }
  if (!imageResponse.ok) throw new Error(`Runpod output download failed (${imageResponse.status})`);
  const contentType = imageResponse.headers.get("content-type")?.split(";", 1)[0].trim() || "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new Error(`Unexpected Runpod output content type: ${contentType || "missing"}`);
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("Runpod output size is invalid");

  const ext = contentType === "image/jpeg" ? ".jpg" : contentType === "image/webp" ? ".webp" : ".png";
  const outputPath = path.resolve("public", "renders", `runpod-smoke-${jobId}${ext}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);

  console.log(`delay_ms=${Math.round(result.delayTime ?? 0)}`);
  console.log(`execution_ms=${Math.round(result.executionTime ?? 0)}`);
  console.log(`provider_cost_usd=${typeof result.output?.cost === "number" ? result.output.cost.toFixed(6) : "UNKNOWN"}`);
  console.log(`content_type=${contentType}`);
  console.log(`bytes=${bytes.length}`);
  console.log(`saved=${outputPath}`);
}

main().catch((error) => {
  console.error(`smoke_failed=${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
