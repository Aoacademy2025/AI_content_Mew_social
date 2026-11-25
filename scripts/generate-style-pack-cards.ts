/**
 * Task 10 (Brands wave 1 — Style Packs): generate one 720x1280 card sample
 * image per ACTIVE Style Pack (`src/lib/style-pack-catalog.ts`), saved in
 * a review directory, for inspection before versioned public promotion
 * with explicit unavailable states until a sample passes review.
 *
 * Safe default: `--dry-run` (or no flags) compiles and prints every active pack prompt
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

type HookSceneSpec = {
  subject: string;
  action: string;
  setting: string;
  emphasis: string;
  entityTypes: string[];
  essentialObjects: string[];
};

/** Viral 9:16 hook-frame scene specs per active Style Pack.
 * Positive-only affirmative phrasing, completely lettering-free and logo-free
 * so `z-image-turbo` produces clean, high-impact vertical frames with real
 * depth, lighting, and scroll-stopping mood. */
const HOOK_SCENES: Record<StylePackId & string, HookSceneSpec> = {
  "thai-ghost": {
    subject: "an old wooden Thai house at night, one lit window, thin fog, moonlight",
    action: "thin silver mist drifting slowly past the shadowy wooden veranda",
    setting: "a quiet rural Thai house surrounded by dark tropical trees at night",
    emphasis: "eerie nocturnal moonlight and warm solitary window glow in deep cold shadows",
    entityTypes: ["architectural and still-life objects"],
    essentialObjects: ["old wooden Thai house", "lit window", "thin fog"],
  },
  "thai-history": {
    subject: "a close-up of weathered terracotta bricks and gilded lotus-flower tiles on an old Thai temple wall, cracked aged plaster in late afternoon light",
    action: "warm golden late-afternoon light grazing across carved historic temple masonry",
    setting: "an ancient Thai temple courtyard bathed in rich sepia heritage light",
    emphasis: "tactile aged masonry, warm gilded gold detail, dignified historical scale",
    entityTypes: ["architectural and still-life objects"],
    essentialObjects: ["weathered terracotta bricks", "gilded lotus-flower tiles"],
  },
  "life-drama": {
    subject: "a quiet Thai street-side kitchen at dusk, one warm lamp, an empty chair, natural light",
    action: "soft golden tungsten glow spilling across the warm worn wooden table at dusk",
    setting: "an intimate neighborhood Thai home kitchen in gentle evening light",
    emphasis: "warm human intimacy, authentic Thai everyday texture, tender emotional atmosphere",
    entityTypes: ["architectural and still-life objects"],
    essentialObjects: ["warm hanging lamp", "worn wooden kitchen table", "chair"],
  },
  "finance-clear": {
    subject: "three ascending geometric stacks of gleaming gold coins rising from left to right beside a crisp glowing cobalt-blue upward arrow",
    action: "clean upward financial momentum rising steeply across the central composition",
    setting: "a sleek deep midnight-navy vertical studio field with wide clean breathing space",
    emphasis: "bold iconic upward growth geometry, crisp cobalt blue and gleaming gold contrast, pure minimalist wealth symbols",
    entityTypes: ["geometric financial pictograms"],
    essentialObjects: ["three ascending stacks of gold coins", "one sharp upward diagonal arrow"],
  },
  "news-fast": {
    subject: "a city skyline at night with light trails on a highway, high contrast",
    action: "fast crimson and white traffic light trails streaking through downtown towers",
    setting: "a dramatic metropolitan highway overlooking modern high-rise buildings at night",
    emphasis: "urgent high-contrast urban energy, dramatic depth, crisp breaking-news intensity",
    entityTypes: ["architectural and still-life objects"],
    essentialObjects: ["city skyline", "glowing highway light trails"],
  },
  "health-simple": {
    subject: "an energetic young woman stretching calmly in golden morning sunlight beside lush emerald park trees with a clear glass carafe of fresh water and vibrant sliced fruit on a sunlit wooden bench",
    action: "taking a refreshing morning stretch outdoors bathed in crisp sunlit greenery",
    setting: "a bright airy morning tropical park path with warm cream light and fresh emerald foliage",
    emphasis: "inviting modern lifestyle editorial illustration, fresh emerald-green and sunlit cream harmony, uplifting daily wellness feel",
    entityTypes: ["active young adult", "fresh wellness props"],
    essentialObjects: ["woman stretching in morning park", "clear glass water carafe", "fresh vibrant fruit"],
  },
  "premium-product": {
    subject: "a matte black surface with a single gold-rimmed glass bottle, soft studio light",
    action: "soft studio rim light gliding across brushed gold and dark obsidian glass",
    setting: "a refined minimalist luxury studio plinth with velvety dark shadows",
    emphasis: "tactile high-end luxury restraint, gleaming black and gold reflections",
    entityTypes: ["luxury product still-life"],
    essentialObjects: ["matte black plinth", "gold-rimmed blank glass bottle"],
  },
  "comic-story": {
    subject: "a determined young Thai person in a dark utility jacket standing on a rain-slicked Bangkok street at twilight, turning back over one shoulder in dramatic three-quarter profile",
    action: "pausing intensely under glowing warm amber streetlamp rain streaks as passing headlights cast sharp ink shadows",
    setting: "a dramatic rain-soaked Thai city street at dusk with glowing warm orange shopfronts and deep indigo sky",
    emphasis: "expressive bold graphic-novel protagonist framing, heavy dynamic ink contours, vivid burnt-orange rim light against deep midnight shadows",
    entityTypes: ["expressive young Thai protagonist"],
    essentialObjects: ["young Thai protagonist in jacket", "rain-slicked glowing neon street", "warm amber streetlamp"],
  },
  "shop-review": {
    subject: "a smooth blank frosted rose-pink glass skincare serum bottle with a gleaming gold dropper standing on a sunlit cream travertine marble pedestal beside dewy fresh citrus slices and soft satin ribbon",
    action: "radiant morning sunbeams refracting through translucent rose glass with sparkling water droplets",
    setting: "a bright airy sunlit creator product-review studio table with warm bokeh glow and clean soft shadows",
    emphasis: "irresistible bright hero product showcase, crisp dewy glass texture, vibrant coral-rose and warm sunlight energy, completely smooth unlabelled glass",
    entityTypes: ["hero lifestyle product"],
    essentialObjects: ["smooth blank frosted rose glass serum bottle", "gold dropper", "travertine marble tray", "dewy citrus slices"],
  },
  "listicle-fast": {
    subject: "a gleaming brass sand hourglass and stepped matte-black architectural blocks ascending diagonally under a crisp golden spotlight beam",
    action: "sharp amber rim lighting sweeping across the ascending stepped blocks and falling golden sand",
    setting: "a sleek modern dark-slate studio stage with crisp geometric depth and subtle warm golden bokeh",
    emphasis: "punchy high-energy creator studio hook, crisp amber-gold against deep charcoal slate, clear ascending progression feel",
    entityTypes: ["crisp studio objects"],
    essentialObjects: ["gleaming brass hourglass", "ascending stepped dark blocks", "warm golden spotlight"],
  },
  "ai-tech-doc": {
    subject: "a luminous geometric crystal neural core floating just above a dark reflective obsidian glass pedestal inside a futuristic modern research lab",
    action: "electric cyan-blue light filaments pulsing sharply through translucent glass prisms with crisp volumetric rays",
    setting: "a sleek dark midnight-navy high-tech laboratory with subtle out-of-focus cyan data lights and polished glass reflections",
    emphasis: "Netflix technology documentary cinematography, razor-sharp glass reflections, deep midnight navy and vivid electric cyan glow, futuristic scale",
    entityTypes: ["futuristic technology sculpture"],
    essentialObjects: ["luminous crystal neural core", "reflective obsidian pedestal", "cyan volumetric light rays"],
  },
  "true-crime": {
    subject: "a rain-soaked empty concrete city alleyway at midnight illuminated by a lone crimson streetlamp reflecting across dark puddles with a distant shadowy figure standing in drifting mist",
    action: "cold night rain falling through harsh overhead light beams casting long stark shadows across wet asphalt",
    setting: "a gritty nocturnal urban alley in heavy mist with dark wet brick walls and stark red light reflections on puddles",
    emphasis: "gripping cinematic true-crime noir tension, dramatic chiaroscuro shadows, cold steel charcoal accented with stark crimson glow",
    entityTypes: ["nocturnal urban noir scene", "distant silhouetted figure"],
    essentialObjects: ["rain-soaked alley", "crimson streetlamp reflection in puddle", "distant mist silhouette"],
  },
  "self-growth": {
    subject: "a solitary determined silhouette of an athlete standing atop a rugged misty mountain ridge at dawn looking out over an endless sea of clouds as golden sunrise breaks across deep navy skies",
    action: "standing tall and resolute facing radiant golden morning sunbeams sweeping across the high mountain crest",
    setting: "a breathtaking alpine summit overlook at first light with dramatic volumetric golden rays piercing deep steel-blue clouds",
    emphasis: "epic cinematic stoic inspiration frame, glowing golden-amber sunrise rim lighting against deep navy atmosphere, powerful heroic scale",
    entityTypes: ["determined silhouetted athlete"],
    essentialObjects: ["mountain summit silhouette", "sea of clouds", "radiant golden sunrise rays"],
  },
} as Record<StylePackId & string, HookSceneSpec>;

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
  "comic-story": "Thai human drama told as a comic",
  "shop-review": "energetic product review and shopping showcase",
  "listicle-fast": "fast-paced numbered listicle summary",
  "ai-tech-doc": "modern AI and global technology mini-documentary",
  "true-crime": "tense investigative true-crime and dark mystery storytelling",
  "self-growth": "cinematic self-improvement and stoic daily mindset",
} as Record<StylePackId & string, string>;

/** Describe the positive composition once. Repeated negations naming people
 * and statues contaminated the September review batch with those subjects. */
function sceneVisualBeat(pack: StylePack): VisualBeat {
  const spec = HOOK_SCENES[pack.id];
  if (!spec) throw new Error(`No hook scene defined for pack ${pack.id}`);
  return {
    phase: "hook",
    subject: spec.subject,
    action: spec.action,
    setting: spec.setting,
    emotion: pack.personality,
    hardSceneFacts: {
      entityTypes: spec.entityTypes, ages: [], genders: [],
      actions: [spec.action], locationTypes: [spec.setting],
      timeOfDay: null, historicalPeriod: null, count: null, essentialObjects: spec.essentialObjects,
    },
    emphasis: spec.emphasis,
    safetyBoundary: "none",
  };
}

function recipeVersionFor(visualFormatId: StylePack["visualFormatId"]): string {
  const format = VISUAL_FORMATS.find((candidate) => candidate.id === visualFormatId);
  if (!format) throw new Error(`Unsupported Visual Format: ${visualFormatId}`);
  return format.recipeVersion;
}

function seedFor(id: string): number {
  const key = seedSalt ? `style-pack-card__${id}__${seedSalt}` : `style-pack-card__${id}`;
  return createHash("sha256").update(key).digest().readUInt32BE(0) & 0x7fffffff;
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
const onlySet = onlyArg ? new Set(onlyArg.split(",").map((item) => item.trim()).filter(Boolean)) : null;
const seedSalt = process.argv.find((arg) => arg.startsWith("--seed-salt="))?.slice(12).trim() ?? "";
const endpointId = process.argv.find((arg) => arg.startsWith("--endpoint="))?.slice(11).trim();
const paidAcknowledged = process.env.ALLOW_PAID_STYLE_PACK_CARDS === "1";

const outputRoot = resolve(process.env.STYLE_PACK_CARDS_OUTPUT || "artifacts/style-pack-cards");
const manifestPath = join(outputRoot, "manifest.json");
const publicDir = resolve(process.env.STYLE_PACK_CARDS_PUBLIC_OUTPUT || join(outputRoot, "review"));
const MAX_BYTES = 120 * 1024;
const QUALITY_LADDER = [90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30];

// Always compiled for every active pack — regardless of --only — so a
// dry-run always shows every active pack prompt and a paid --only run's manifest never
// drops the other packs' completed-entry bookkeeping (see queue filtering in
// main()).
const allPacks = activeStylePacks();
if (allPacks.length === 0) throw new Error("No active Style Packs found in the catalog");
if (onlySet) {
  for (const id of onlySet) {
    if (!allPacks.some((pack) => pack.id === id)) {
      throw new Error(`--only contains "${id}" which does not match any active Style Pack`);
    }
  }
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
    const inScopeThisRun = !onlySet || onlySet.has(entry.id);
    // A pack outside this run's --only scope keeps its prior manifest record
    // verbatim (even if the shared prompt-wording changed) — this run never
    // touches its file, so its bookkeeping must not be invalidated either.
    if (!inScopeThisRun && old) return old;
    return old?.status === "completed" && old.prompt === entry.prompt && old.seed === entry.seed && old.imagePath
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
  const queue = manifest.entries.filter((entry) => onlySet ? onlySet.has(entry.id) : true).filter((entry) => entry.status !== "completed");
  for (const entry of queue) {
    // eslint-disable-next-line no-await-in-loop
    await generate(entry);
  }
  const relevant = manifest.entries.filter((entry) => onlySet ? onlySet.has(entry.id) : true);
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
