/**
 * Focused paid image-model A/B approved on 2026-08-18.
 *
 * Safe default: dry-run only. Paid execution requires --execute-paid,
 * ALLOW_PAID_IMAGE_MODEL_AB=1, and a declared --max-usd ceiling.
 * Existing Z-Image V11 outputs are reused as immutable controls.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config({ path: process.env.IMAGE_MODEL_AB_ENV || ".env", quiet: true });

const SOURCE_ROOT = resolve("artifacts/brand-treatment-relational-v11-probe");
const SOURCE_MANIFEST = join(SOURCE_ROOT, "manifest.json");
const OUTPUT_ROOT = resolve("artifacts/image-model-ab-2026-08-18");
const IMAGE_ROOT = join(OUTPUT_ROOT, "images");
const MANIFEST_PATH = join(OUTPUT_ROOT, "manifest.json");
const FX_BAHT_PER_USD = 35;

const CASE_IDS = [
  "thai-human-drama__cinematic-realism__drama-bus-close",
  "premium-product-lifestyle__cinematic-realism__premium-serum-explain",
  "investigative-news-crime__dramatic-comic__news-files-hook",
  "thai-supernatural-horror__cinematic-realism__horror-house-close",
] as const;

const REFERENCE_CASES = [
  {
    id: "person-identity-and-shared-bag",
    sourceId: "thai-human-drama__simple-editorial-story__drama-bus-close",
    seed: 1_810_001,
    prompt: [
      "Use case: identity-preserve.",
      "Edit the supplied image while preserving the same two Thai women, their faces, ages, clothing, illustration style, and exactly one shared cloth bag held together by both women.",
      "Replace only the plain background with a clearly recognizable provincial Thai street at evening with warm streetlights.",
      "Keep exactly two women and exactly one bag in the complete frame. No additional people, hands, bags, text, labels, logos, collage, or watermark.",
    ].join(" "),
  },
  {
    id: "product-bottle-and-drop-contact",
    sourceId: "premium-product-lifestyle__cinematic-realism__premium-serum-explain",
    seed: 1_810_002,
    prompt: [
      "Use case: identity-preserve product edit.",
      "Preserve the supplied amber serum bottle's recognizable size, shape, plain label-free glass, dropper, premium photorealistic lighting, and color.",
      "Refine the action so exactly two anatomically correct hands are visible and exactly one clear drop from the bottle is visibly touching one clean fingertip.",
      "No extra bottle, hand, dropper, finger, person, text, label, logo, collage, or watermark.",
    ].join(" "),
  },
  {
    id: "retro-style-transfer-evidence-room",
    sourceId: "thai-supernatural-horror__retro-story__horror-house-close",
    seed: 1_810_003,
    prompt: [
      "Use case: style-transfer.",
      "Use the supplied image only as the reference for its vintage Thai pulp-print illustration style, paper texture, limited ink palette, dramatic shadows, and vertical composition.",
      "Replace the subject and scene with one empty evidence room containing exactly one empty chair and exactly one switched-on desk lamp in the complete frame.",
      "No people, body parts, additional chair, additional lamp, text, signage, collage, or watermark.",
    ].join(" "),
  },
] as const;

type SourceEntry = {
  id: string;
  prompt: string;
  seed: number;
  status: string;
  providerJobId?: string;
  imagePath?: string;
  sha256?: string;
};

type SourceManifest = { entries: SourceEntry[] };

type RunpodResponse = {
  id?: string;
  status?: string;
  error?: string;
  output?: {
    image_url?: string;
    result?: string;
    cost?: number;
  };
};

type AbEntry = {
  id: string;
  kind: "text-to-image" | "reference-edit";
  provider: "runpod";
  model: "z-image-turbo" | "p-image-t2i" | "qwen-image-t2i" | "p-image-edit";
  sourceCaseId: string;
  sourceImagePath?: string;
  prompt: string;
  seed: number;
  status: "pending" | "submitted" | "completed" | "failed";
  providerJobId?: string;
  providerReportedCostUsd?: number;
  incrementalCostUsd?: number;
  incrementalCostBaht?: number;
  imagePath?: string;
  sha256?: string;
  width?: number;
  height?: number;
  reusedControl?: boolean;
  error?: string;
};

type AbManifest = {
  schemaVersion: 1;
  benchmark: "image-model-ab-2026-08-18";
  generatedAt: string;
  fxBahtPerUsd: number;
  approvedPlan: {
    cases: string[];
    paidProviders: string[];
    includeReferenceEdits: boolean;
    maxUsd: number;
  };
  entries: AbEntry[];
  totals: {
    completed: number;
    failed: number;
    incrementalCostUsd: number;
    incrementalCostBaht: number;
  };
};

const args = process.argv.slice(2);
const executePaid = args.includes("--execute-paid");
const includePImage = args.includes("--p-image");
const includeQwenRunpod = args.includes("--qwen-runpod");
const includeReferenceEdits = args.includes("--p-image-edit");
const referenceUrlMapArg = args.find((arg) => arg.startsWith("--reference-url-map="));
const referenceUrlMapPath = referenceUrlMapArg?.slice("--reference-url-map=".length);
const maxUsdArg = args.find((arg) => arg.startsWith("--max-usd="));
const maxUsd = Number(maxUsdArg?.slice("--max-usd=".length));
const paidAcknowledged = process.env.ALLOW_PAID_IMAGE_MODEL_AB === "1";
const runpodApiKey = process.env.RUNPOD_API_KEY?.trim();

const plannedUsd =
  (includePImage ? CASE_IDS.length * 0.005 : 0) +
  (includeQwenRunpod ? CASE_IDS.length * 0.02 : 0) +
  (includeReferenceEdits ? REFERENCE_CASES.length * 0.01 : 0);

if (!existsSync(SOURCE_MANIFEST)) throw new Error("V11 source manifest is missing");
const sourceManifest = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")) as SourceManifest;
const sourceById = new Map(sourceManifest.entries.map((entry) => [entry.id, entry]));

function requireSource(id: string): SourceEntry {
  const entry = sourceById.get(id);
  if (!entry || entry.status !== "completed" || !entry.imagePath || !entry.prompt) {
    throw new Error(`Completed V11 source is missing: ${id}`);
  }
  const absoluteImage = resolve(SOURCE_ROOT, entry.imagePath);
  if (!existsSync(absoluteImage)) throw new Error(`V11 source image is missing: ${id}`);
  return entry;
}

for (const id of CASE_IDS) requireSource(id);
for (const spec of REFERENCE_CASES) requireSource(spec.sourceId);

if (!executePaid) {
  console.log(JSON.stringify({
    mode: "dry-run",
    reusedZControls: CASE_IDS.length,
    paidPImageT2I: includePImage ? CASE_IDS.length : 0,
    paidQwenRunpod: includeQwenRunpod ? CASE_IDS.length : 0,
    paidPImageEdits: includeReferenceEdits ? REFERENCE_CASES.length : 0,
    plannedCostUsd: plannedUsd,
    plannedCostBaht: plannedUsd * FX_BAHT_PER_USD,
    paidGenerationStarted: false,
  }, null, 2));
  process.exit(0);
}

if (!paidAcknowledged) {
  throw new Error("Paid A/B is locked. Set ALLOW_PAID_IMAGE_MODEL_AB=1 after explicit approval.");
}
if (!runpodApiKey) throw new Error("RUNPOD_API_KEY is required");
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("Paid A/B requires --max-usd=<positive ceiling>");
let referenceUrlBySource: Record<string, string> = {};
if (includeReferenceEdits) {
  if (!referenceUrlMapPath || !existsSync(resolve(referenceUrlMapPath))) {
    throw new Error("P-Image Edit requires --reference-url-map=<temporary signed URL map>");
  }
  const parsedMap = JSON.parse(readFileSync(resolve(referenceUrlMapPath), "utf8")) as {
    references?: Array<{ sourceId?: unknown; url?: unknown }>;
  };
  for (const item of parsedMap.references ?? []) {
    if (typeof item.sourceId === "string" && typeof item.url === "string") {
      referenceUrlBySource[item.sourceId] = item.url;
    }
  }
  for (const spec of REFERENCE_CASES) {
    let parsedReference: URL;
    const sourceUrl = referenceUrlBySource[spec.sourceId];
    if (!sourceUrl) throw new Error(`Signed reference URL is missing: ${spec.sourceId}`);
    try {
      parsedReference = new URL(sourceUrl);
    } catch {
      throw new Error(`Signed reference URL is invalid: ${spec.sourceId}`);
    }
    if (parsedReference.protocol !== "https:" || parsedReference.username || parsedReference.password) {
      throw new Error(`Signed reference URL is unsafe: ${spec.sourceId}`);
    }
  }
}
if (plannedUsd > maxUsd + 1e-9) {
  throw new Error(`Planned provider cost $${plannedUsd.toFixed(3)} exceeds $${maxUsd.toFixed(3)} ceiling`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestTotals(entries: AbEntry[]): AbManifest["totals"] {
  const incrementalCostUsd = entries.reduce((sum, entry) => sum + (entry.incrementalCostUsd ?? 0), 0);
  return {
    completed: entries.filter((entry) => entry.status === "completed").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    incrementalCostUsd,
    incrementalCostBaht: incrementalCostUsd * FX_BAHT_PER_USD,
  };
}

function sameCompletedEntry(old: AbEntry | undefined, next: AbEntry): boolean {
  if (!old || old.status !== "completed" || old.prompt !== next.prompt || old.seed !== next.seed || !old.imagePath) {
    return false;
  }
  return existsSync(resolve(OUTPUT_ROOT, old.imagePath));
}

const plannedEntries: AbEntry[] = [];
for (const id of CASE_IDS) {
  const source = requireSource(id);
  plannedEntries.push({
    id: `z-image-turbo__${id}`,
    kind: "text-to-image",
    provider: "runpod",
    model: "z-image-turbo",
    sourceCaseId: id,
    prompt: source.prompt,
    seed: source.seed,
    status: "pending",
    providerJobId: source.providerJobId,
    providerReportedCostUsd: 0.005,
    incrementalCostUsd: 0,
    incrementalCostBaht: 0,
    reusedControl: true,
  });
  if (includePImage) {
    plannedEntries.push({
      id: `p-image-t2i__${id}`,
      kind: "text-to-image",
      provider: "runpod",
      model: "p-image-t2i",
      sourceCaseId: id,
      prompt: source.prompt,
      seed: source.seed,
      status: "pending",
    });
  }
  if (includeQwenRunpod) {
    plannedEntries.push({
      id: `qwen-image-t2i__${id}`,
      kind: "text-to-image",
      provider: "runpod",
      model: "qwen-image-t2i",
      sourceCaseId: id,
      prompt: source.prompt,
      seed: source.seed,
      status: "pending",
    });
  }
}
if (includeReferenceEdits) {
  for (const spec of REFERENCE_CASES) {
    const source = requireSource(spec.sourceId);
    plannedEntries.push({
      id: `p-image-edit__${spec.id}`,
      kind: "reference-edit",
      provider: "runpod",
      model: "p-image-edit",
      sourceCaseId: spec.sourceId,
      sourceImagePath: source.imagePath,
      prompt: spec.prompt,
      seed: spec.seed,
      status: "pending",
    });
  }
}

mkdirSync(IMAGE_ROOT, { recursive: true });
const prior = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as AbManifest
  : null;
const priorById = new Map(prior?.entries.map((entry) => [entry.id, entry]) ?? []);
const plannedIds = new Set(plannedEntries.map((entry) => entry.id));
const retainedPriorEntries = (prior?.entries ?? []).filter((entry) =>
  !plannedIds.has(entry.id) &&
  entry.status === "completed" &&
  Boolean(entry.imagePath) &&
  existsSync(resolve(OUTPUT_ROOT, entry.imagePath!))
);
const manifest: AbManifest = {
  schemaVersion: 1,
  benchmark: "image-model-ab-2026-08-18",
  generatedAt: new Date().toISOString(),
  fxBahtPerUsd: FX_BAHT_PER_USD,
  approvedPlan: {
    cases: [...CASE_IDS],
    paidProviders: [
      ...(includePImage ? ["runpod/p-image-t2i"] : []),
      ...(includeQwenRunpod ? ["runpod/qwen-image-t2i"] : []),
    ],
    includeReferenceEdits,
    maxUsd,
  },
  entries: [
    ...plannedEntries.map((entry) => {
      const old = priorById.get(entry.id);
      return sameCompletedEntry(old, entry) ? { ...entry, ...old } : entry;
    }),
    ...retainedPriorEntries,
  ],
  totals: manifestTotals([]),
};

function saveManifest(): void {
  manifest.totals = manifestTotals(manifest.entries);
  const temporary = `${MANIFEST_PATH}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, MANIFEST_PATH);
}

async function requestRunpod(endpoint: string, input: Record<string, unknown>): Promise<RunpodResponse> {
  const request = async (url: string, init?: RequestInit): Promise<RunpodResponse> => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${runpodApiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const source = await response.text();
    let body: RunpodResponse | null = null;
    try { body = source ? JSON.parse(source) as RunpodResponse : null; } catch {}
    if (!response.ok || !body) {
      throw new Error(body?.error || `RunPod request failed (${response.status})`);
    }
    return body;
  };

  let job = await request(`https://api.runpod.ai/v2/${endpoint}/runsync`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  const deadline = Date.now() + 20 * 60_000;
  while (job.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status ?? "")) {
      throw new Error(job.error || String(job.status));
    }
    if (!job.id) throw new Error("RunPod accepted no job id");
    if (Date.now() >= deadline) throw new Error("RunPod A/B case exceeded twenty minutes");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    job = await request(`https://api.runpod.ai/v2/${endpoint}/status/${encodeURIComponent(job.id)}`);
  }
  return job;
}

async function saveOutput(entry: AbEntry, bytes: Buffer): Promise<void> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height || metadata.height <= metadata.width) {
    throw new Error("Provider output is not a valid vertical image");
  }
  const relative = join("images", `${entry.id}.webp`);
  const outputPath = resolve(OUTPUT_ROOT, relative);
  const encoded = await sharp(bytes).webp({ quality: 92 }).toBuffer();
  const temporary = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporary, encoded);
  renameSync(temporary, outputPath);
  entry.imagePath = relative;
  entry.sha256 = sha256(encoded);
  entry.width = metadata.width;
  entry.height = metadata.height;
  entry.status = "completed";
  delete entry.error;
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Provider image download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function completeControl(entry: AbEntry): Promise<void> {
  if (entry.status === "completed") return;
  const source = requireSource(entry.sourceCaseId);
  const sourcePath = resolve(SOURCE_ROOT, source.imagePath!);
  const relative = join("images", `${entry.id}.webp`);
  const outputPath = resolve(OUTPUT_ROOT, relative);
  copyFileSync(sourcePath, outputPath);
  const bytes = readFileSync(outputPath);
  const metadata = await sharp(bytes).metadata();
  entry.imagePath = relative;
  entry.sha256 = sha256(bytes);
  entry.width = metadata.width;
  entry.height = metadata.height;
  entry.status = "completed";
  saveManifest();
}

async function generate(entry: AbEntry): Promise<void> {
  if (entry.status === "completed") return;
  try {
    let endpoint: string;
    let input: Record<string, unknown>;
    if (entry.model === "p-image-t2i") {
      endpoint = "p-image-t2i";
      input = { prompt: entry.prompt, aspect_ratio: "9:16", seed: entry.seed };
    } else if (entry.model === "qwen-image-t2i") {
      endpoint = "qwen-image-t2i";
      input = {
        prompt: entry.prompt,
        negative_prompt: "",
        size: "720*1280",
        seed: entry.seed,
        enable_safety_checker: true,
      };
    } else if (entry.model === "p-image-edit") {
      endpoint = "p-image-edit";
      const sourceUrl = referenceUrlBySource[entry.sourceCaseId];
      if (!sourceUrl) throw new Error(`Signed reference URL is missing: ${entry.sourceCaseId}`);
      input = {
        images: [sourceUrl],
        reference_image: "1",
        prompt: entry.prompt,
        aspect_ratio: "9:16",
        seed: entry.seed,
      };
    } else {
      throw new Error(`Unsupported paid model: ${entry.model}`);
    }

    entry.status = "submitted";
    saveManifest();
    const job = await requestRunpod(endpoint, input);
    entry.providerJobId = job.id;
    const outputUrl = job.output?.image_url ?? job.output?.result;
    if (!outputUrl) throw new Error("RunPod completed without image URL");
    const cost = job.output?.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      throw new Error("RunPod completed without a valid provider-reported cost");
    }
    entry.providerReportedCostUsd = cost;
    entry.incrementalCostUsd = cost;
    entry.incrementalCostBaht = cost * FX_BAHT_PER_USD;
    await saveOutput(entry, await downloadImage(outputUrl));
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : "unknown failure";
  }
  saveManifest();
}

async function main(): Promise<void> {
  saveManifest();
  for (const entry of manifest.entries) {
    if (entry.reusedControl) await completeControl(entry);
    else await generate(entry);
    console.log(JSON.stringify({
      event: "image-model-ab-progress",
      id: entry.id,
      status: entry.status,
      costUsd: entry.incrementalCostUsd ?? 0,
    }));
  }
  console.log(JSON.stringify({ event: "image-model-ab-complete", ...manifest.totals }));
  if (manifest.totals.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "image-model A/B failed");
  process.exit(1);
});
