import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";
import { buildBrandVisualBenchmarkCases } from "../src/lib/brand-visual-system";
import {
  firstRunpodImage,
  publicZImageProviderInput,
  type RunpodJobResponse,
} from "../src/lib/runpod-image-contract";
import {
  BRAND_VISUAL_GATE_COMPILER_CONTRACT,
  qualityGateCaseHash,
  qualityGateCompilerHash,
  qualityGateEntrySelected,
  reconcileQualityGateEntry,
  type QualityGateEntry,
} from "./brand-visual-quality-gate-manifest";

const root = process.cwd();
for (const candidate of [
  process.env.BRAND_VISUAL_BENCHMARK_ENV,
  path.join(root, ".env"),
  path.resolve(root, "../../.env"),
]) {
  if (candidate && fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false, quiet: true });
    break;
  }
}

const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is missing");

const endpointId = process.env.BRAND_VISUAL_BENCHMARK_ENDPOINT?.trim() || "z-image-turbo";
const outputRoot = path.resolve(
  process.env.BRAND_VISUAL_BENCHMARK_OUTPUT?.trim()
    || "artifacts/brand-visual-quality-gate/2026-08-09",
);
const imageRoot = path.join(outputRoot, "images");
const manifestPath = path.join(outputRoot, "manifest.json");
const concurrency = Math.max(1, Math.min(4, Number(process.env.BRAND_VISUAL_BENCHMARK_CONCURRENCY) || 3));
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

type Manifest = {
  schemaVersion: 1 | 2;
  gate: "brand-visual-v1-pre-ui";
  model: "z-image-turbo";
  endpointId: string;
  compilerContract?: string;
  compilerHash?: string;
  productionDataAccess: "read-only-aggregate-selects";
  generatedAt: string;
  entries: QualityGateEntry[];
};

fs.mkdirSync(imageRoot, { recursive: true });
const cases = buildBrandVisualBenchmarkCases();
const existing = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest
  : null;
const existingById = new Map(existing?.entries.map((entry) => [entry.id, entry]) ?? []);
const entries = cases.map((item): QualityGateEntry => {
  const currentWithoutHash = {
    id: item.id,
    benchmark: item.benchmark,
    sceneId: item.sceneId,
    variant: item.variant,
    visualFormatId: item.visualFormatId,
    recipeVersion: item.compiled.recipeVersion,
    seed: item.seed,
    prompt: item.compiled.positive,
    negativePrompt: item.compiled.negative,
  };
  const current: QualityGateEntry = {
    ...currentWithoutHash,
    caseHash: qualityGateCaseHash({
      ...currentWithoutHash,
      endpointId,
      model: "z-image-turbo",
      width: 720,
      height: 1280,
    }),
    status: "pending",
  };
  return reconcileQualityGateEntry({
    current,
    prior: existingById.get(item.id),
    imageExists: (relativePath) => fs.existsSync(path.resolve(outputRoot, relativePath)),
  });
});
const manifest: Manifest = {
  schemaVersion: 2,
  gate: "brand-visual-v1-pre-ui",
  model: "z-image-turbo",
  endpointId,
  compilerContract: BRAND_VISUAL_GATE_COMPILER_CONTRACT,
  compilerHash: qualityGateCompilerHash(entries),
  productionDataAccess: "read-only-aggregate-selects",
  generatedAt: new Date().toISOString(),
  entries,
};

function saveManifest() {
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, manifestPath);
}

async function runpod(operation: string, init?: RequestInit): Promise<RunpodJobResponse> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
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
      try {
        payload = JSON.parse(text) as RunpodJobResponse;
      } catch {
        throw new Error(`RunPod returned non-JSON status ${response.status}`);
      }
      if (response.ok) return payload;
      const error = new Error(payload.error || `RunPod request failed (${response.status})`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("RunPod request failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
  }
  throw lastError ?? new Error("RunPod request failed");
}

async function downloadImage(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "image.runpod.ai") {
    throw new Error(`Unexpected RunPod output host: ${parsed.hostname}`);
  }
  const response = await fetch(parsed, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`RunPod image redirected (${response.status})`);
  }
  if (!response.ok) throw new Error(`RunPod image download failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() || "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new Error(`Unexpected RunPod image type: ${contentType || "missing"}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("RunPod image size is invalid");
  return { bytes, contentType };
}

async function generate(entry: QualityGateEntry) {
  if (entry.status === "completed") {
    console.log(`SKIP ${entry.id}`);
    return;
  }
  try {
    let snapshot: RunpodJobResponse;
    if (entry.providerJobId && entry.status === "submitted") {
      snapshot = await runpod(`status/${encodeURIComponent(entry.providerJobId)}`);
    } else {
      snapshot = await runpod("run", {
        method: "POST",
        body: JSON.stringify({
          input: publicZImageProviderInput({
            prompt: entry.prompt,
            negativePrompt: entry.negativePrompt,
            width: 720,
            height: 1280,
            seed: entry.seed,
          }),
        }),
      });
      if (!snapshot.id) throw new Error("RunPod accepted the benchmark without a job id");
      entry.providerJobId = snapshot.id;
      entry.status = "submitted";
      entry.submittedAt = new Date().toISOString();
      saveManifest();
      console.log(`SUBMIT ${entry.id} ${snapshot.id}`);
    }

    const deadline = Date.now() + 8 * 60_000;
    while (snapshot.status !== "COMPLETED") {
      if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(snapshot.status ?? "")) {
        throw new Error(snapshot.error || `RunPod job ${snapshot.status}`);
      }
      if (Date.now() >= deadline) throw new Error("RunPod benchmark exceeded 8 minutes");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      snapshot = await runpod(`status/${encodeURIComponent(entry.providerJobId!)}`);
    }

    const image = firstRunpodImage(snapshot);
    if (image.type !== "temporary_url" && image.type !== "s3_url") {
      throw new Error(`Unsupported benchmark output type: ${image.type}`);
    }
    const downloaded = await downloadImage(image.data);
    const metadata = await sharp(downloaded.bytes).metadata();
    if (!metadata.width || !metadata.height || metadata.height <= metadata.width) {
      throw new Error(`Benchmark output is not vertical (${metadata.width ?? 0}×${metadata.height ?? 0})`);
    }
    const extension = downloaded.contentType === "image/jpeg"
      ? ".jpg"
      : downloaded.contentType === "image/webp" ? ".webp" : ".png";
    const relativeImagePath = path.join("images", `${entry.id}${extension}`);
    const absoluteImagePath = path.join(outputRoot, relativeImagePath);
    fs.writeFileSync(absoluteImagePath, downloaded.bytes);
    entry.status = "completed";
    entry.providerStatus = snapshot.status;
    entry.providerCostUsd = typeof snapshot.output?.cost === "number" ? snapshot.output.cost : undefined;
    entry.delayTimeMs = Math.round(snapshot.delayTime ?? 0);
    entry.executionTimeMs = Math.round(snapshot.executionTime ?? 0);
    entry.imagePath = relativeImagePath;
    entry.sha256 = crypto.createHash("sha256").update(downloaded.bytes).digest("hex");
    entry.width = metadata.width;
    entry.height = metadata.height;
    entry.bytes = downloaded.bytes.length;
    entry.completedAt = new Date().toISOString();
    delete entry.error;
    saveManifest();
    console.log(`DONE ${entry.id} ${metadata.width}x${metadata.height} $${entry.providerCostUsd ?? "?"}`);
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : "unknown benchmark failure";
    saveManifest();
    console.error(`FAIL ${entry.id}: ${entry.error}`);
  }
}

async function main() {
  saveManifest();
  const queue = manifest.entries.filter((entry) => qualityGateEntrySelected(entry.id, only));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (entry) await generate(entry);
    }
  }));
  const completed = manifest.entries.filter((entry) => entry.status === "completed").length;
  const failed = manifest.entries.filter((entry) => entry.status === "failed").length;
  console.log(`brand_visual_quality_gate_generation completed=${completed}/${manifest.entries.length} failed=${failed}`);
  if (completed !== manifest.entries.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "benchmark failed");
  process.exit(1);
});
