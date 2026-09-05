/**
 * Task 10 (Brands wave 1 — Style Packs): generate one 720x1280 card sample
 * image per ACTIVE Style Pack (`src/lib/style-pack-catalog.ts`), saved in
 * a review directory, for inspection before versioned public promotion
 * with explicit unavailable states until a sample passes review.
 *
 * Safe default: `--dry-run` (or no flags) compiles and prints the 7 prompts
 * without any network call. Paid execution requires BOTH `--execute-paid`
 * and `ALLOW_PAID_STYLE_PACK_CARDS=1`, plus the explicit approved public
 * endpoint (`--endpoint=z-image-turbo`) — same shape as
 * `scripts/run-brand-treatment-benchmark-v1.ts`.
 *
 * Each pack's scene is a FIXED neutral, people-free scene (task brief) so the
 * treatment/format compiler applies only the pack's look. `--only <id>`
 * regenerates a single pack without re-running the whole batch.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import sharp from "sharp";
import { createCatalogTreatmentPin, type TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import { VISUAL_FORMATS, compileBrandVisualPrompt, type VisualBeat } from "@/lib/brand-visual-system";
import { activeStylePacks, type StylePack, type StylePackId } from "@/lib/style-pack-catalog";
import {
  firstRunpodImage,
  publicZImageProviderInput,
  type RunpodJobResponse,
} from "@/lib/runpod-image-contract";

dotenv.config({ path: process.env.STYLE_PACK_CARDS_ENV || ".env", quiet: true });

/** Fixed neutral scene per pack, verbatim from the task-10 brief. No people,
 * no readable text, no logos — the treatment compiler adds the look. */
const FIXED_SCENES: Record<StylePackId & string, string> = {
  "thai-ghost": "an old wooden Thai house at night, one lit window, thin fog, moonlight",
  "thai-history": "a close-up of weathered terracotta bricks and gilded lotus-flower tiles on an old Thai temple wall, cracked aged plaster in late afternoon light",
  "life-drama": "a quiet Thai street-side kitchen at dusk, one warm lamp, an empty chair, natural light",
  "finance-clear": "a clean modern desk with a laptop, a notebook and a coffee cup, bright daylight, minimal",
  "news-fast": "a city skyline at night with light trails on a highway, high contrast",
  "health-simple": "fresh vegetables and a glass of water on a bright white kitchen counter, soft morning light",
  "premium-product": "a matte black surface with a single gold-rimmed glass bottle, soft studio light",
} as Record<StylePackId & string, string>;

/** Short English content-domain label per pack, feeding the compiler's
 * flexible scene direction. Not customer copy — never shown to a creator. */
const CONTENT_DOMAINS: Record<StylePackId & string, string> = {
  "thai-ghost": "Thai supernatural horror",
  "thai-history": "Thai historical storytelling",
  "life-drama": "Thai human drama",
  "finance-clear": "business and personal finance",
  "news-fast": "investigative news",
  "health-simple": "everyday health and wellness",
  "premium-product": "premium product lifestyle",
} as Record<StylePackId & string, string>;

/** Describe the positive composition once. Repeated negations naming people
 * and statues contaminated the September review batch with those subjects. */
function sceneVisualBeat(pack: StylePack): VisualBeat {
  const scene = FIXED_SCENES[pack.id];
  if (!scene) throw new Error(`No fixed scene defined for pack ${pack.id}`);
  return {
    phase: "hook",
    subject: scene,
    action: "still-life study of the stated objects and architecture",
    setting: "a tightly composed environmental detail study",
    emotion: pack.personality,
    hardSceneFacts: {
      entityTypes: ["architectural and still-life objects"], ages: [], genders: [],
      actions: ["static environmental detail"], locationTypes: [scene],
      timeOfDay: null, historicalPeriod: null, count: null, essentialObjects: [scene],
    },
    emphasis: "the stated objects fill the composition; material, light and color tell the story",
    safetyBoundary: "none",
  };
}

function recipeVersionFor(visualFormatId: StylePack["visualFormatId"]): string {
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === visualFormatId);
  if (!format) throw new Error(`Unsupported Visual Format: ${visualFormatId}`);
  return format.recipeVersion;
}

function seedFor(id: string): number {
  return createHash("sha256").update(`style-pack-card__${id}`).digest().readUInt32BE(0) & 0x7fffffff;
}

type Entry = {
  id: string;
  visualFormatId: string;
  treatmentPresetId: string;
  recipeVersion: string;
  seed: number;
  prompt: string;
  status: "pending" | "submitted" | "completed" | "failed";
  providerJobId?: string;
  imagePath?: string;
  sha256?: string;
  qualityUsed?: number;
  bytes?: number;
  error?: string;
};

type Manifest = {
  schemaVersion: 1;
  model: "z-image-turbo";
  endpointId: string;
  generatedAt: string;
  entries: Entry[];
};

const dryRun = !process.argv.includes("--execute-paid");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).trim();
const endpointId = process.argv.find((arg) => arg.startsWith("--endpoint="))?.slice(11).trim();
const paidAcknowledged = process.env.ALLOW_PAID_STYLE_PACK_CARDS === "1";

const outputRoot = resolve(process.env.STYLE_PACK_CARDS_OUTPUT || "artifacts/style-pack-cards");
const manifestPath = join(outputRoot, "manifest.json");
const publicDir = resolve(process.env.STYLE_PACK_CARDS_PUBLIC_OUTPUT || join(outputRoot, "review"));
const MAX_BYTES = 120 * 1024;
const QUALITY_LADDER = [90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30];

// Always compiled for every active pack — regardless of --only — so a
// dry-run always shows all 7 prompts and a paid --only run's manifest never
// drops the other packs' completed-entry bookkeeping (see queue filtering in
// main()).
const allPacks = activeStylePacks();
if (allPacks.length === 0) throw new Error("No active Style Packs found in the catalog");
if (onlyArg && !allPacks.some((pack) => pack.id === onlyArg)) {
  throw new Error(`--only=${onlyArg} does not match any active Style Pack`);
}

const compiledEntries: Entry[] = allPacks.map((pack) => {
  const treatmentPin = createCatalogTreatmentPin(pack.treatmentPresetId as TreatmentPresetId, "adaptive");
  const compiled = compileBrandVisualPrompt({
    visualFormatId: pack.visualFormatId,
    recipeVersion: recipeVersionFor(pack.visualFormatId),
    contentDomain: CONTENT_DOMAINS[pack.id] ?? pack.id,
    treatmentPin,
    visualBeat: sceneVisualBeat(pack),
    brandVisualLanguage: { palette: [...pack.palette], personality: pack.personality, visualNotes: "" },
  });
  return {
    id: pack.id,
    visualFormatId: pack.visualFormatId,
    treatmentPresetId: pack.treatmentPresetId,
    recipeVersion: compiled.recipeVersion,
    seed: seedFor(pack.id),
    prompt: compiled.positive,
    status: "pending",
  };
});

if (dryRun) {
  console.log(JSON.stringify({
    mode: "dry-run",
    packs: compiledEntries.length,
    entries: compiledEntries.map((entry) => ({
      id: entry.id,
      visualFormatId: entry.visualFormatId,
      treatmentPresetId: entry.treatmentPresetId,
      recipeVersion: entry.recipeVersion,
      seed: entry.seed,
      prompt: entry.prompt,
    })),
    paidGenerationStarted: false,
  }, null, 2));
  process.exit(0);
}

if (!paidAcknowledged) {
  throw new Error("Paid generation is locked. Set ALLOW_PAID_STYLE_PACK_CARDS=1 with --execute-paid after approval.");
}
if (!endpointId) throw new Error("Paid execution requires --endpoint=z-image-turbo");

function assertApprovedEndpoint(): void {
  if (endpointId !== "z-image-turbo") {
    throw new Error("Paid style pack card generation is restricted to the approved public Z-Image endpoint");
  }
}

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
          : `Style pack card request failed (${response.status})`;
    throw new Error(reason);
  }
  return body;
}

mkdirSync(join(outputRoot, "images"), { recursive: true });
mkdirSync(publicDir, { recursive: true });
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest : null;
const priorById = new Map(prior?.entries.map((entry) => [entry.id, entry]) ?? []);
const manifest: Manifest = {
  schemaVersion: 1,
  model: "z-image-turbo",
  endpointId,
  generatedAt: new Date().toISOString(),
  entries: compiledEntries.map((entry) => {
    const old = priorById.get(entry.id);
    const inScopeThisRun = !onlyArg || entry.id === onlyArg;
    // A pack outside this run's --only scope keeps its prior manifest record
    // verbatim (even if the shared prompt-wording changed) — this run never
    // touches its file, so its bookkeeping must not be invalidated either.
    if (!inScopeThisRun && old) return old;
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

/** Resize to 720x1280 cover and re-encode, walking the quality ladder down
 * until the JPEG is <= 120 KB. Returns the smallest-quality encoding tried
 * even if it never clears the cap, so the caller can report and reject it. */
async function encodeUnderBudget(bytes: Buffer): Promise<{ buffer: Buffer; quality: number; underBudget: boolean }> {
  const resized = sharp(bytes).resize(720, 1280, { fit: "cover" });
  let last: { buffer: Buffer; quality: number } | null = null;
  for (const quality of QUALITY_LADDER) {
    const buffer = await resized.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    last = { buffer, quality };
    if (buffer.length <= MAX_BYTES) return { ...last, underBudget: true };
  }
  return { ...last!, underBudget: false };
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
      if (Date.now() >= deadline) throw new Error("Style pack card generation exceeded seventy-five minutes");
      if (Date.now() - lastProgressAt >= 30_000) {
        console.log(JSON.stringify({ event: "style-pack-card-progress", packId: entry.id, status: job.status ?? "UNKNOWN" }));
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
    const rawMetadata = await sharp(bytes).metadata();
    if (!rawMetadata.width || !rawMetadata.height) throw new Error("Output is not a valid image");

    const encoded = await encodeUnderBudget(bytes);
    if (!encoded.underBudget) {
      throw new Error(`Could not encode under ${MAX_BYTES} bytes even at quality ${encoded.quality} (got ${encoded.buffer.length} bytes)`);
    }

    const relative = join("images", `${entry.id}.jpg`);
    const artifactPath = resolve(outputRoot, relative);
    const temporaryArtifactPath = `${artifactPath}.tmp-${process.pid}`;
    writeFileSync(temporaryArtifactPath, encoded.buffer);
    renameSync(temporaryArtifactPath, artifactPath);

    const publicPath = join(publicDir, `${entry.id}.jpg`);
    const temporaryPublicPath = `${publicPath}.tmp-${process.pid}`;
    writeFileSync(temporaryPublicPath, encoded.buffer);
    renameSync(temporaryPublicPath, publicPath);

    entry.status = "completed";
    entry.imagePath = relative;
    entry.sha256 = createHash("sha256").update(encoded.buffer).digest("hex");
    entry.qualityUsed = encoded.quality;
    entry.bytes = encoded.buffer.length;
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
  const queue = manifest.entries.filter((entry) => onlyArg ? entry.id === onlyArg : true).filter((entry) => entry.status !== "completed");
  for (const entry of queue) {
    // eslint-disable-next-line no-await-in-loop
    await generate(entry);
  }
  const relevant = manifest.entries.filter((entry) => onlyArg ? entry.id === onlyArg : true);
  const completed = relevant.filter((entry) => entry.status === "completed").length;
  console.log(JSON.stringify({
    event: "style-pack-cards-done",
    completed,
    total: relevant.length,
    table: relevant.map((entry) => ({
      id: entry.id,
      status: entry.status,
      bytes: entry.bytes ?? null,
      qualityUsed: entry.qualityUsed ?? null,
      error: entry.error ?? null,
    })),
  }, null, 2));
  if (completed !== relevant.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "style pack card generation failed");
  process.exit(1);
});
