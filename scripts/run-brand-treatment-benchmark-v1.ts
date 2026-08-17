/**
 * Safe default: compile and validate the 120-case matrix without generation.
 * Paid execution requires BOTH --execute-paid and
 * ALLOW_PAID_BRAND_TREATMENT_BENCHMARK=1, plus the explicit public endpoint.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";
import {
  buildBrandTreatmentBenchmarkCases,
  buildBrandTreatmentEditorialV7SmokeCases,
  buildBrandTreatmentHardFactsLetteringV8ProbeCases,
  buildBrandTreatmentPositiveOnlyV9ProbeCases,
  buildBrandTreatmentCompletedStateV10ProbeCases,
  buildBrandTreatmentRelationalV11ProbeCases,
  buildBrandTreatmentV6SmokeCases,
} from "../src/lib/brand-treatment-benchmark";
import {
  firstRunpodImage,
  publicZImageProviderInput,
  type RunpodJobResponse,
} from "../src/lib/runpod-image-contract";

dotenv.config({ path: process.env.BRAND_VISUAL_BENCHMARK_ENV || ".env", quiet: true });

const executePaid = process.argv.includes("--execute-paid");
const historicalV6SmokeMode = process.argv.includes("--smoke-v6");
const editorialV7SmokeMode = process.argv.includes("--smoke-editorial-v7");
const hardFactsLetteringV8ProbeMode = process.argv.includes("--probe-hard-facts-lettering-v8");
const positiveOnlyV9ProbeMode = process.argv.includes("--probe-positive-only-v9");
const completedStateV10ProbeMode = process.argv.includes("--probe-completed-state-v10");
const relationalV11ProbeMode = process.argv.includes("--probe-relational-v11");
const selectedModes = [
  historicalV6SmokeMode,
  editorialV7SmokeMode,
  hardFactsLetteringV8ProbeMode,
  positiveOnlyV9ProbeMode,
  completedStateV10ProbeMode,
  relationalV11ProbeMode,
]
  .filter(Boolean).length;
if (selectedModes > 1) {
  throw new Error("Choose only one benchmark suite");
}
const targetedMode = selectedModes === 1;
const allCases = buildBrandTreatmentBenchmarkCases();
if (allCases.length !== 120) throw new Error(`Expected 120 benchmark cases, received ${allCases.length}`);
const cases = historicalV6SmokeMode
  ? buildBrandTreatmentV6SmokeCases()
  : editorialV7SmokeMode
    ? buildBrandTreatmentEditorialV7SmokeCases()
    : hardFactsLetteringV8ProbeMode
      ? buildBrandTreatmentHardFactsLetteringV8ProbeCases()
      : positiveOnlyV9ProbeMode
        ? buildBrandTreatmentPositiveOnlyV9ProbeCases()
        : completedStateV10ProbeMode
          ? buildBrandTreatmentCompletedStateV10ProbeCases()
          : relationalV11ProbeMode
            ? buildBrandTreatmentRelationalV11ProbeCases(allCases)
            : allCases;
const paidAcknowledged = process.env.ALLOW_PAID_BRAND_TREATMENT_BENCHMARK === "1";
const endpointId = process.argv.find((arg) => arg.startsWith("--endpoint="))?.slice(11).trim();
const suite = historicalV6SmokeMode
  ? "brand-treatment-v6-smoke"
  : editorialV7SmokeMode
    ? "brand-treatment-simple-editorial-v7-smoke"
    : hardFactsLetteringV8ProbeMode
      ? "brand-treatment-hard-facts-lettering-v8-probe"
      : positiveOnlyV9ProbeMode
        ? "brand-treatment-positive-only-v9-probe"
        : completedStateV10ProbeMode
          ? "brand-treatment-completed-state-v10-probe"
          : relationalV11ProbeMode
            ? "brand-treatment-relational-v11-probe"
            : "brand-treatment-v1";
const outputRoot = resolve(process.env.BRAND_TREATMENT_BENCHMARK_OUTPUT
  || (historicalV6SmokeMode
    ? "artifacts/brand-treatment-v6-smoke"
    : editorialV7SmokeMode
      ? "artifacts/brand-treatment-simple-editorial-v7-smoke"
      : hardFactsLetteringV8ProbeMode
        ? "artifacts/brand-treatment-hard-facts-lettering-v8-probe"
        : positiveOnlyV9ProbeMode
          ? "artifacts/brand-treatment-positive-only-v9-probe"
          : completedStateV10ProbeMode
            ? "artifacts/brand-treatment-completed-state-v10-probe"
            : relationalV11ProbeMode
              ? "artifacts/brand-treatment-relational-v11-probe"
              : "artifacts/brand-treatment-v1"));
const imageRoot = join(outputRoot, "images");
const manifestPath = join(outputRoot, "manifest.json");
const concurrency = Math.max(1, Math.min(3, Number(process.env.BRAND_TREATMENT_BENCHMARK_CONCURRENCY) || 2));

type Entry = {
  id: string;
  treatmentPresetId: string;
  visualFormatId: string;
  fixtureSceneId: string;
  recipeVersion: string;
  treatmentPresetVersion: string;
  seed: number;
  prompt: string;
  status: "pending" | "submitted" | "completed" | "failed";
  providerJobId?: string;
  imagePath?: string;
  sha256?: string;
  error?: string;
};

type Manifest = {
  schemaVersion: 1;
  benchmark:
    | "brand-treatment-v1"
    | "brand-treatment-v6-smoke"
    | "brand-treatment-simple-editorial-v7-smoke"
    | "brand-treatment-hard-facts-lettering-v8-probe"
    | "brand-treatment-positive-only-v9-probe"
    | "brand-treatment-completed-state-v10-probe"
    | "brand-treatment-relational-v11-probe";
  model: "z-image-turbo";
  endpointId: string;
  generatedAt: string;
  entries: Entry[];
};

function seedFor(id: string): number {
  return createHash("sha256").update(id).digest().readUInt32BE(0) & 0x7fffffff;
}

const compiledEntries: Entry[] = cases.map((entry) => ({
  id: entry.id,
  treatmentPresetId: entry.treatmentPresetId,
  visualFormatId: entry.visualFormatId,
  fixtureSceneId: entry.fixtureSceneId,
  recipeVersion: entry.compiled.recipeVersion,
  treatmentPresetVersion: entry.compiled.treatmentPin!.version,
  seed: seedFor(entry.id),
  prompt: entry.compiled.positive,
  status: "pending",
}));

if (!executePaid) {
  console.log(JSON.stringify({
    mode: "dry-run",
    suite,
    cases: compiledEntries.length,
    treatments: new Set(compiledEntries.map((entry) => entry.treatmentPresetId)).size,
    formats: new Set(compiledEntries.map((entry) => entry.visualFormatId)).size,
    scenesPerTreatment: targetedMode ? "targeted" : 3,
    paidGenerationStarted: false,
  }, null, 2));
  process.exit(0);
}

if (!paidAcknowledged) {
  throw new Error("Paid generation is locked. Set ALLOW_PAID_BRAND_TREATMENT_BENCHMARK=1 with --execute-paid after approval.");
}
if (!endpointId) throw new Error("Paid execution requires --endpoint=z-image-turbo");
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required for paid execution");

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
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
  let body: (T & { error?: unknown; message?: unknown; detail?: unknown }) | null = null;
  try { body = source ? JSON.parse(source) as typeof body : null; } catch {}
  if (!response.ok || !body) {
    const reason = typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : typeof body?.detail === "string"
          ? body.detail
          : `Benchmark request failed (${response.status})`;
    throw new Error(reason);
  }
  return body;
}

function assertApprovedEndpoint(): void {
  if (endpointId !== "z-image-turbo") {
    throw new Error("Paid benchmark is restricted to the approved public Z-Image endpoint");
  }
}

mkdirSync(imageRoot, { recursive: true });
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest : null;
const priorById = new Map(prior?.entries.map((entry) => [entry.id, entry]) ?? []);
const manifest: Manifest = {
  schemaVersion: 1,
  benchmark: suite,
  model: "z-image-turbo",
  endpointId,
  generatedAt: new Date().toISOString(),
  entries: compiledEntries.map((entry) => {
    const old = priorById.get(entry.id);
    return old?.status === "completed" && old.prompt === entry.prompt && old.imagePath
      && existsSync(resolve(outputRoot, old.imagePath))
      ? { ...entry, ...old }
      : entry;
  }),
};

function saveManifest(): void {
  const temporary = `${manifestPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, manifestPath);
}

async function generate(entry: Entry): Promise<void> {
  if (entry.status === "completed") return;
  try {
    let job = entry.status === "submitted" && entry.providerJobId
      ? await requestJson<RunpodJobResponse>(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId!)}/status/${encodeURIComponent(entry.providerJobId)}`)
      : await requestJson<RunpodJobResponse>(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId!)}/run`, {
          method: "POST",
          body: JSON.stringify({
            input: publicZImageProviderInput({
              prompt: entry.prompt,
              width: 720,
              height: 1280,
              seed: entry.seed,
            }),
          }),
        });
    if (!entry.providerJobId) {
      if (!job.id) throw new Error("Provider accepted no job id");
      entry.providerJobId = job.id;
      entry.status = "submitted";
      saveManifest();
    }
    const deadline = Date.now() + 75 * 60_000;
    let lastProgressAt = 0;
    while (job.status !== "COMPLETED") {
      if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status ?? "")) throw new Error(job.error || String(job.status));
      if (Date.now() >= deadline) throw new Error("Benchmark case exceeded seventy-five minutes");
      if (Date.now() - lastProgressAt >= 30_000) {
        console.log(JSON.stringify({ event: "benchmark-progress", caseId: entry.id, status: job.status ?? "UNKNOWN" }));
        lastProgressAt = Date.now();
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      job = await requestJson<RunpodJobResponse>(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId!)}/status/${encodeURIComponent(entry.providerJobId!)}`);
    }
    const image = firstRunpodImage(job);
    let bytes: Buffer;
    if (image.type === "base64") {
      const encoded = image.data.includes(",") ? image.data.slice(image.data.indexOf(",") + 1) : image.data;
      bytes = Buffer.from(encoded, "base64");
    } else {
      const response = await fetch(image.data, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Image download failed (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height || metadata.height <= metadata.width) throw new Error("Output is not a valid vertical image");
    const relative = join("images", `${entry.id}.webp`);
    const encodedWebp = await sharp(bytes).webp({ quality: 92 }).toBuffer();
    const imagePath = resolve(outputRoot, relative);
    const temporaryImagePath = `${imagePath}.tmp-${process.pid}`;
    writeFileSync(temporaryImagePath, encodedWebp);
    renameSync(temporaryImagePath, imagePath);
    entry.status = "completed";
    entry.imagePath = relative;
    entry.sha256 = createHash("sha256").update(encodedWebp).digest("hex");
    delete entry.error;
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : "unknown failure";
  }
  saveManifest();
}

async function main(): Promise<void> {
  assertApprovedEndpoint();
  saveManifest();
  const queue = manifest.entries.filter((entry) => entry.status !== "completed");
  const warmup = queue.shift();
  if (warmup) {
    console.log(JSON.stringify({ event: "benchmark-warmup", caseId: warmup.id }));
    await generate(warmup);
    if (warmup.status !== "completed") {
      throw new Error(`Benchmark warm-up failed: ${warmup.error || "unknown provider failure"}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (entry) await generate(entry);
    }
  }));
  const completed = manifest.entries.filter((entry) => entry.status === "completed").length;
  console.log(`brand_treatment_benchmark suite=${suite} completed=${completed}/${compiledEntries.length}`);
  if (completed !== compiledEntries.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "benchmark failed");
  process.exit(1);
});
