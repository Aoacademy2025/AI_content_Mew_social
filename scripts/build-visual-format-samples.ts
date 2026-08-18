/**
 * Regenerate the five Visual Format sample cards shown on `/brands`.
 *
 * `public/brand-visual-formats/<formatId>.webp` is what the format picker
 * renders — it is how a creator decides which look their brand gets. The set
 * shipped on 2026-08-09 was rendered by the `-v2` compiler, so it kept showing
 * the bug ADR 0006 fixed after the fix was live: `clear-infographic-v2` forced
 * "geometric grouping made from circles, arrows and recognizable pictograms",
 * which is why that card carried floating discs. The images are static assets,
 * so nothing regenerated them on deploy.
 *
 * This renders the same benchmark scene at the same seed through whatever
 * compiler is current, so a rerun is always a like-for-like replacement and the
 * five cards stay comparable to each other — the only variable a creator is
 * choosing between is the format.
 *
 * DEFAULT MODE IS DRY-RUN. `--generate` calls RunPod and writes PNGs to
 * `artifacts/visual-format-samples-<date>/`; `--install` also converts them to
 * webp over `public/brand-visual-formats/`. Install is a separate flag so the
 * shipped assets are never replaced by images nobody looked at first.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  BRAND_VISUAL_BENCHMARK_SCENES,
  VISUAL_FORMATS,
  compileBrandVisualPrompt,
  type CompiledBrandVisualPrompt,
  type VisualFormatId,
} from "../src/lib/brand-visual-system";
import {
  firstRunpodImage,
  publicZImageProviderInput,
  type RunpodJobResponse,
} from "../src/lib/runpod-image-contract";

dotenv.config({ path: ".env", override: false, quiet: true });

const args = process.argv.slice(2);
const GENERATE = args.includes("--generate") || args.includes("--install");
const INSTALL = args.includes("--install");

const BATCH_ID = "visual-format-cards-2026-08-18-set-v1";
const OUTPUT_ROOT = path.resolve(`artifacts/${BATCH_ID}`);
const PUBLIC_ROOT = path.resolve("public/brand-visual-formats");

/** The card is a 9:16 crop at the size the picker requests, matching the
 * shipped assets exactly so the swap changes content and nothing else. */
const WIDTH = 720;
const HEIGHT = 1280;

/** The `hook` scene — a figure, architecture and one directed light source.
 * It separates the five formats better than a flat or crowded scene would, and
 * it is the scene the shipped cards already use, so old and new are directly
 * comparable. */
const SCENE = BRAND_VISUAL_BENCHMARK_SCENES.find((item) => item.id === "hook");
if (!SCENE) throw new Error("benchmark scene 'hook' is gone — pick a replacement deliberately");

type SampleCase = {
  formatId: VisualFormatId;
  label: string;
  recipeVersion: string;
  compiled: CompiledBrandVisualPrompt;
};

/** No brand payload: a format card must show the format, not one brand's grade
 * (ADR 0006). Every card therefore compiles with `brandVisualLanguage` absent. */
const CASES: SampleCase[] = VISUAL_FORMATS.map((format) => ({
  formatId: format.id,
  label: format.label,
  recipeVersion: format.recipeVersion,
  compiled: compileBrandVisualPrompt({
    visualFormatId: format.id,
    contentDomain: SCENE.contentDomain,
    treatment: SCENE.treatment,
    visualBeat: SCENE.visualBeat,
  }),
}));

const THAI_CHARACTER = /[฀-๿]/;

function selfCheck(): boolean {
  let pass = true;
  for (const item of CASES) {
    const positive = item.compiled.positive;
    const check = (ok: boolean, message: string) => {
      console.log(`${ok ? "PASS" : "FAIL"} ${item.formatId}: ${message}`);
      if (!ok) pass = false;
    };
    check(
      item.compiled.recipeVersion === item.recipeVersion,
      `compiles on current recipe ${item.recipeVersion}`,
    );
    check(!THAI_CHARACTER.test(positive), "no Thai character in the prompt");
    check(!positive.includes("#"), "no color code");
    check(
      !/circles, arrows and recognizable pictograms|circular motif|unmarked disc|unmarked ring/i.test(positive),
      "no forced graphic motif — this is the clause that put discs on the infographic card",
    );
    check(/reaches toward a narrow opening/.test(positive), "the scene's own action survives the recipe");
  }
  return pass;
}

const MODEL_ID = "z-image-turbo";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID?.trim() || MODEL_ID;

async function runpod(apiKey: string, operation: string, init?: RequestInit): Promise<RunpodJobResponse> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(RUNPOD_ENDPOINT_ID)}/${operation}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
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
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  throw lastError ?? new Error("RunPod request failed");
}

async function downloadImage(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "image.runpod.ai") {
    throw new Error(`Unexpected RunPod output host: ${parsed.hostname}`);
  }
  const response = await fetch(parsed, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`RunPod image download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("RunPod image size is invalid");
  return bytes;
}

async function generateOne(apiKey: string, item: SampleCase): Promise<string> {
  const outputPath = path.join(OUTPUT_ROOT, `${item.formatId}.png`);
  if (fs.existsSync(outputPath)) {
    console.log(`SKIP ${item.formatId} (already on disk)`);
    return outputPath;
  }
  const submitted = await runpod(apiKey, "run", {
    method: "POST",
    body: JSON.stringify({
      input: publicZImageProviderInput({
        prompt: item.compiled.positive,
        width: WIDTH,
        height: HEIGHT,
        seed: SCENE.seed,
      }),
    }),
  });
  const jobId = submitted.id;
  if (!jobId) throw new Error(`${item.formatId}: RunPod accepted the job without an id`);
  console.log(`SUBMIT ${item.formatId} ${jobId}`);

  const deadline = Date.now() + 8 * 60_000;
  let snapshot = submitted;
  while (snapshot.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(snapshot.status ?? "")) {
      throw new Error(`${item.formatId}: RunPod job ${snapshot.status} — ${snapshot.error ?? "no detail"}`);
    }
    if (Date.now() >= deadline) throw new Error(`${item.formatId}: RunPod job exceeded 8 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    snapshot = await runpod(apiKey, `status/${encodeURIComponent(jobId)}`);
  }

  const image = firstRunpodImage(snapshot);
  if (image.type !== "temporary_url" && image.type !== "s3_url") {
    throw new Error(`${item.formatId}: unsupported RunPod output type ${image.type}`);
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.writeFileSync(outputPath, await downloadImage(image.data));
  console.log(`DONE ${item.formatId}`);
  return outputPath;
}

/** cwebp keeps the assets in the same format and rough weight as the shipped
 * set. Quality 82 lands each card near the originals without visible banding on
 * the flat formats, which compress worst. */
function stageWebp(pngPath: string, formatId: VisualFormatId): { stagedPath: string; sha256: string } {
  const stagedRoot = path.join(OUTPUT_ROOT, "install");
  fs.mkdirSync(stagedRoot, { recursive: true });
  const stagedPath = path.join(stagedRoot, `${formatId}.webp`);
  execFileSync("cwebp", ["-quiet", "-q", "82", "-resize", String(WIDTH), String(HEIGHT), pngPath, "-o", stagedPath]);
  const bytes = fs.readFileSync(stagedPath);
  console.log(`STAGE ${formatId}.webp (${Math.round(bytes.length / 1024)} KB)`);
  return { stagedPath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function installSet(rendered: Array<{ item: SampleCase; pngPath: string }>): void {
  const staged = rendered.map(({ item, pngPath }) => ({
    item,
    ...stageWebp(pngPath, item.formatId),
  }));
  const manifest = {
    batchId: BATCH_ID,
    sceneId: SCENE!.id,
    seed: SCENE!.seed,
    // Record the customer-facing model, never a private custom endpoint ID.
    renderer: `runpod:${MODEL_ID}`,
    width: WIDTH,
    height: HEIGHT,
    formats: staged.map(({ item, sha256 }) => ({
      id: item.formatId,
      recipeVersion: item.recipeVersion,
      file: `${item.formatId}.webp`,
      sha256,
    })),
  };

  fs.mkdirSync(PUBLIC_ROOT, { recursive: true });
  for (const entry of staged) {
    const target = path.join(PUBLIC_ROOT, `${entry.item.formatId}.webp`);
    const temporary = `${target}.${BATCH_ID}.tmp`;
    fs.copyFileSync(entry.stagedPath, temporary);
    fs.renameSync(temporary, target);
    console.log(`INSTALL ${entry.item.formatId}.webp`);
  }
  const manifestTarget = path.join(PUBLIC_ROOT, "manifest.json");
  const manifestTemporary = `${manifestTarget}.${BATCH_ID}.tmp`;
  fs.writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(manifestTemporary, manifestTarget);
  console.log("INSTALL manifest.json");
}

async function main() {
  console.log(`Scene: ${SCENE.id} · seed ${SCENE.seed} · no brand payload`);
  console.log("");
  const ok = selfCheck();
  console.log("");
  console.log(ok ? "SELF-CHECK: PASS" : "SELF-CHECK: FAIL");
  if (!ok) {
    process.exitCode = 1;
    return;
  }

  if (!GENERATE) {
    for (const item of CASES) {
      console.log(`\n--- ${item.formatId} (${item.compiled.recipeVersion}) ---`);
      console.log(item.compiled.positive);
    }
    console.log("\nDry-run complete. No network calls. Add --generate to render, --install to also ship them.");
    return;
  }

  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!apiKey) throw new Error("RUNPOD_API_KEY is missing from .env — refusing to half-run the batch.");

  const rendered: Array<{ item: SampleCase; pngPath: string }> = [];
  for (const item of CASES) {
    rendered.push({ item, pngPath: await generateOne(apiKey, item) });
  }

  if (!INSTALL) {
    console.log(`\nRendered ${rendered.length}/${CASES.length} to ${OUTPUT_ROOT}. Re-run with --install to ship them.`);
    return;
  }
  fs.mkdirSync(PUBLIC_ROOT, { recursive: true });
  installSet(rendered);
  console.log(`\nInstalled ${rendered.length} cards into ${PUBLIC_ROOT}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "build-visual-format-samples failed");
  process.exit(1);
});
