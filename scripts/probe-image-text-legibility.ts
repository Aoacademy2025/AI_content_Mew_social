/**
 * Image Text Legibility Probe — empirical evidence for Mew's revised
 * "ภาพไม่มีตัวอักษร / Text-free AI Image" policy (CONTEXT.md,
 * TEXT_FREE_NEGATIVE_PROMPT_TERMS in src/lib/brand-visual-system.ts).
 *
 * Mew's revised position (2026-08-10):
 *   1. Numerals/letters INTRINSIC to a depicted object (banknote denominations,
 *      coin faces, price tags) are acceptable — not a defect.
 *   2. Thai script in images is FORBIDDEN — the model is believed to render it
 *      garbled. Needs hard evidence either way.
 *   3. English text is UNDECIDED — unknown how well this model handles it. If
 *      garbled, it should stay banned as text-in-image, same as Thai.
 *
 * This script compiles 8 deliberately chosen prompts through the SAME real
 * compiler Mew's product uses (`compileBrandVisualPrompt`, cinematic-realism-v3
 * recipe) and — only under --generate — submits them through the exact same
 * production RunPod Z-Image path as scripts/brand-visual-proof-pack.ts
 * (`publicZImageProviderInput` from src/lib/runpod-image-contract.ts).
 *
 * IMPORTANT PROVIDER-CONTRACT FINDING (read before interpreting the "control"
 * case): `publicZImageProviderInput()` — the actual function every production
 * z-image-turbo call goes through (src/lib/runpod-serverless.ts:159-161,
 * gated "production-safe default" at src/lib/runpod-serverless.ts:48-66) —
 * builds its RunPod payload from only `{ prompt, size, seed, output_format,
 * enable_safety_checker }`. It never reads `input.negativePrompt` at all. This
 * is corroborated by the comment on `buildArtworkOnlyPrompt` in
 * src/lib/ai-image-policy.ts:140-142: "RunPod Public Z-Image currently accepts
 * only a positive prompt." `TEXT_FREE_NEGATIVE_PROMPT_TERMS` is computed by the
 * compiler and returned as `compiled.negative`, but on the live production
 * route it is silently discarded before the RunPod call — it has NEVER been
 * transmitted to the provider. Case 8 below ("control") still threads
 * `compiled.negative` through the call exactly as case 7 omits it, to make
 * this concretely checkable: the two provider payloads come out byte-identical
 * (see `runSelfCheck`'s payload-equality assertion), which is itself part of
 * the hard evidence this probe produces.
 *
 * DEFAULT MODE IS DRY-RUN. `--dry-run` (default, also accepted explicitly)
 * makes no network calls: it only compiles prompts, runs the self-check and
 * writes `prompts.md`. `--generate` is required to actually call RunPod, spend
 * credits, and write images. Resumable: an existing image file for a case id
 * is skipped without a provider call, same as scripts/brand-visual-proof-pack.ts.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  compileBrandVisualPrompt,
  type CompiledBrandVisualPrompt,
  type VisualBeat,
} from "../src/lib/brand-visual-system";
import {
  firstRunpodImage,
  publicZImageProviderInput,
  type RunpodJobResponse,
} from "../src/lib/runpod-image-contract";

dotenv.config({ path: ".env", override: false, quiet: true });

const args = process.argv.slice(2);
const GENERATE = args.includes("--generate");

const OUTPUT_ROOT = path.resolve("artifacts/image-text-probe-2026-08-10");
const IMAGE_ROOT = path.join(OUTPUT_ROOT, "images");
const PROMPTS_PATH = path.join(OUTPUT_ROOT, "prompts.md");

// ---------------------------------------------------------------------------
// Visual Format: cinematic-realism-v3 — same recipe production uses for the
// "ภาพสมจริงแบบหนัง" format, per this probe's own instructions ("so the result
// transfers to Mew's real use"). No Brand Visual Language is attached: this
// probe isolates the model's raw text-rendering ability from any brand palette
// noise. `compileBrandVisualPrompt` treats a missing brand as "use the
// format's neutral house palette" (src/lib/brand-visual-system.ts:819-828), so
// this is a supported, real call shape, not a synthetic one.
// ---------------------------------------------------------------------------
const VISUAL_FORMAT_ID = "cinematic-realism" as const;
const RECIPE_VERSION = "cinematic-realism-v3" as const;

type ProbeCase = {
  id: string;
  labelEn: string;
  targetText: string | null; // exact literal string the beat asks the model to render, for the self-check
  contentDomain: string;
  treatment: string;
  visualBeat: Omit<VisualBeat, "phase">;
  seedOf?: string; // if set, reuse that case's seed (used by "control" to match "mixed")
  applyNegative: boolean; // whether this case's RunPod call threads compiled.negative through
};

// ---------------------------------------------------------------------------
// The 8 cases. Beat text is written to avoid every trigger token that
// `positiveArtDirectionValue`/`v3PositiveArtDirectionValue` strip from a Visual
// Beat field (text, letters, words, numbers, typography, caption, subtitle,
// headline, logo, watermark, signature, label, signage, prompt, write, spell,
// brand name, and the Thai equivalents incl. ป้าย = "sign") — see
// src/lib/brand-visual-system.ts COPY_OR_MARK_INTENT. Plain "sign"/"signs" is
// NOT on that list, so it is used freely below; each beat instead grounds the
// literal target string with the neutral verb "reads".
// ---------------------------------------------------------------------------
const CASES: readonly ProbeCase[] = [
  {
    id: "english-short",
    labelEn: "English, short — single word on a shop sign",
    targetText: "OPEN",
    contentDomain: "a small independent coffee shop opening for the morning in a Western city",
    treatment: "warm, inviting and unhurried morning energy",
    applyNegative: false,
    visualBeat: {
      subject: "a glass shopfront door with a small hanging wooden sign that reads OPEN in bold paint",
      action: "the sign sways gently as a barista props the door open with a rubber wedge",
      setting: "the entrance of a small independent coffee shop on a quiet morning street",
      emotion: "warm, inviting morning energy",
      emphasis: "the sign hanging just inside the doorway",
    },
  },
  {
    id: "english-medium",
    labelEn: "English, medium — 2-4 word phrase on a sign",
    targetText: "WET FLOOR CAUTION",
    contentDomain: "everyday safety signage inside a small convenience store",
    treatment: "ordinary, unremarkable workday calm",
    applyNegative: false,
    visualBeat: {
      subject: "a bright yellow caution sign standing in a convenience store aisle that reads WET FLOOR CAUTION in bold black print",
      action: "a store employee mops the tile a few steps away from the sign",
      setting: "the beverage aisle of a small 24-hour convenience store",
      emotion: "ordinary, unremarkable workday calm",
      emphasis: "the caution sign standing prominently in the aisle",
    },
  },
  {
    id: "english-long",
    labelEn: "English, long — full sentence on a whiteboard",
    targetText: "THE FOOD DRIVE STARTS AT NINE ON SATURDAY MORNING",
    contentDomain: "grassroots community organizing at a neighborhood volunteer center",
    treatment: "organized, purposeful and community-minded",
    applyNegative: false,
    visualBeat: {
      subject: "a whiteboard mounted on a community center wall that reads THE FOOD DRIVE STARTS AT NINE ON SATURDAY MORNING in blue marker handwriting",
      action: "a volunteer coordinator steps back from the board after finishing the sentence",
      setting: "a small community center meeting corner with folding chairs stacked nearby",
      emotion: "organized, purposeful energy",
      emphasis: "the full sentence spanning the width of the board",
    },
  },
  {
    id: "thai-short",
    labelEn: "Thai, short — single common word on a shop sign",
    targetText: "เปิด",
    contentDomain: "a small roadside noodle shop opening for the morning on a Bangkok soi",
    treatment: "brisk, everyday morning routine",
    applyNegative: false,
    visualBeat: {
      subject: "a small roadside noodle shop with a hand-painted wooden sign that reads เปิด, hanging by the entrance",
      action: "the shop owner flips the sign into view as she unlocks the folding metal shutter",
      setting: "a narrow Bangkok soi lined with parked motorbikes early in the morning",
      emotion: "brisk, everyday morning routine",
      emphasis: "the hanging sign catching the early light",
    },
  },
  {
    id: "thai-medium",
    labelEn: "Thai, medium — short phrase on a banner",
    targetText: "ลดราคาสินค้าทุกชิ้น",
    contentDomain: "a bustling fresh market stall advertising a discount to shoppers",
    treatment: "lively, bustling midday market energy",
    applyNegative: false,
    visualBeat: {
      subject: "a red vinyl banner strung above a market stall that reads ลดราคาสินค้าทุกชิ้น in bold white paint",
      action: "the vendor arranges baskets of fruit beneath the banner as it flutters slightly in the breeze",
      setting: "a busy fresh market alley under a corrugated metal roof",
      emotion: "lively, bustling midday market energy",
      emphasis: "the banner stretched across the top of the stall",
    },
  },
  {
    id: "numerals",
    labelEn: "Intrinsic numerals — Thai banknotes and coins on a table",
    targetText: null,
    contentDomain: "personal finance and counting cash savings at home in Thailand",
    treatment: "careful, methodical focus",
    applyNegative: false,
    visualBeat: {
      subject: "a neat fan of Thai banknotes and a small stack of coins spread across a wooden table, denominations clearly visible on each note and coin face",
      action: "a hand counts through the notes one at a time, setting each aside in a growing pile",
      setting: "a small home desk beside a calculator and a notebook",
      emotion: "careful, methodical focus",
      emphasis: "the printed denominations on each note and coin",
    },
  },
  {
    id: "mixed",
    labelEn: "Mixed — Thai street scene with Thai + English signage",
    targetText: null, // two targets checked separately below
    contentDomain: "a bustling inner-city Bangkok street corner with mixed Thai and English shopfront signage",
    treatment: "energetic, layered urban bustle",
    applyNegative: false,
    visualBeat: {
      subject: "a Bangkok street corner lined with small shopfronts: one sign that reads กาแฟ and a neighboring shopfront sign that reads COFFEE",
      action: "pedestrians walk past under the two signs as a motorbike taxi waits at the curb",
      setting: "a busy inner-city street corner in the late afternoon",
      emotion: "energetic, layered urban bustle",
      emphasis: "the two neighboring signs in different scripts side by side",
    },
  },
  {
    id: "control",
    labelEn: "Control — same street scene, current negative-prompt ban applied",
    targetText: null,
    contentDomain: "a bustling inner-city Bangkok street corner with mixed Thai and English shopfront signage",
    treatment: "energetic, layered urban bustle",
    applyNegative: true,
    seedOf: "mixed", // deliberately reuse "mixed"'s seed — see runSelfCheck payload-equality assertion
    visualBeat: {
      subject: "a Bangkok street corner lined with small shopfronts: one sign that reads กาแฟ and a neighboring shopfront sign that reads COFFEE",
      action: "pedestrians walk past under the two signs as a motorbike taxi waits at the curb",
      setting: "a busy inner-city street corner in the late afternoon",
      emotion: "energetic, layered urban bustle",
      emphasis: "the two neighboring signs in different scripts side by side",
    },
  },
] as const;

const SEED_BASE = 2026081100;

type CompiledCase = {
  case: ProbeCase;
  seed: number;
  compiled: CompiledBrandVisualPrompt;
};

function buildCompiledCases(): CompiledCase[] {
  const seedById = new Map<string, number>();
  CASES.forEach((item, index) => {
    if (!item.seedOf) seedById.set(item.id, SEED_BASE + index + 1);
  });
  return CASES.map((item) => {
    const seed = item.seedOf ? seedById.get(item.seedOf)! : seedById.get(item.id)!;
    const compiled = compileBrandVisualPrompt({
      visualFormatId: VISUAL_FORMAT_ID,
      recipeVersion: RECIPE_VERSION,
      contentDomain: item.contentDomain,
      treatment: item.treatment,
      visualBeat: { ...item.visualBeat, phase: "explain" },
      brandVisualLanguage: null,
    });
    return { case: item, seed, compiled };
  });
}

// ---------------------------------------------------------------------------
// Self-check — run on every dry-run so a defect (e.g. the sanitizer silently
// eating the literal target string) surfaces before any credits are spent.
// ---------------------------------------------------------------------------
function runSelfCheck(compiledCases: CompiledCase[]): { pass: boolean; lines: string[] } {
  const lines: string[] = [];
  let pass = true;
  const fail = (message: string) => { pass = false; lines.push(`FAIL ${message}`); };
  const ok = (message: string) => lines.push(`PASS ${message}`);

  for (const item of compiledCases) {
    if (item.case.targetText) {
      if (item.compiled.positive.includes(item.case.targetText)) {
        ok(`${item.case.id}: literal target text "${item.case.targetText}" survived the compiler unmodified`);
      } else {
        fail(`${item.case.id}: literal target text "${item.case.targetText}" was NOT found in the compiled positive prompt (sanitizer likely stripped it)`);
      }
    }
  }

  const mixed = compiledCases.find((item) => item.case.id === "mixed")!;
  for (const target of ["กาแฟ", "COFFEE"]) {
    if (mixed.compiled.positive.includes(target)) ok(`mixed: literal target text "${target}" survived the compiler unmodified`);
    else fail(`mixed: literal target text "${target}" was NOT found in the compiled positive prompt`);
  }

  const control = compiledCases.find((item) => item.case.id === "control")!;
  if (mixed.compiled.positive === control.compiled.positive) {
    ok("mixed vs control: compiled positive prompts are byte-identical (same scene, as intended for a control)");
  } else {
    fail("mixed vs control: compiled positive prompts differ — control is not a valid control for mixed");
  }
  if (mixed.seed === control.seed) {
    ok(`mixed vs control: seeds match (${mixed.seed}) by design`);
  } else {
    fail("mixed vs control: seeds do not match — control was supposed to reuse mixed's seed");
  }

  // The core provider-contract finding: build both RunPod payloads the way
  // generateOne() below actually will, and prove they are byte-identical
  // despite "control" threading compiled.negative through and "mixed" not.
  // `applyNegative` no longer has anywhere to apply to: the contract type has no
  // negative-prompt field, because the endpoint has no such channel. The payload
  // comparison is kept as the regression guard for that fact.
  const mixedPayload = publicZImageProviderInput({
    prompt: mixed.compiled.positive,
    width: 720,
    height: 1280,
    seed: mixed.seed,
  });
  const controlPayload = publicZImageProviderInput({
    prompt: control.compiled.positive,
    width: 720,
    height: 1280,
    seed: control.seed,
  });
  if (JSON.stringify(mixedPayload) === JSON.stringify(controlPayload)) {
    ok("mixed vs control: RunPod public-z-image payloads are BYTE-IDENTICAL — the public Z-Image contract carries no negative prompt at all, so TEXT_FREE_NEGATIVE_PROMPT_TERMS has ZERO effect on this endpoint");
  } else {
    fail("mixed vs control: RunPod payloads differ — either the seeds diverged or publicZImageProviderInput() gained a negative-prompt channel (re-check this script's assumption)");
  }

  return { pass, lines };
}

// ---------------------------------------------------------------------------
// Dry-run output: artifacts/image-text-probe-2026-08-10/prompts.md
// ---------------------------------------------------------------------------
function writePromptsMarkdown(compiledCases: CompiledCase[], selfCheck: { pass: boolean; lines: string[] }): void {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const sections: string[] = [
    "# Image Text Legibility Probe — compiled prompts",
    "",
    `Generated ${new Date().toISOString()} by scripts/probe-image-text-legibility.ts --dry-run.`,
    "No network calls were made to produce this file.",
    "",
    `Visual Format: ${VISUAL_FORMAT_ID} (recipe ${RECIPE_VERSION}), no Brand Visual Language applied (isolating raw model text ability).`,
    "",
    "## Provider-contract finding",
    "",
    "`publicZImageProviderInput()` (src/lib/runpod-image-contract.ts), the function every production",
    "z-image-turbo call goes through, builds its RunPod payload from only",
    "`{ prompt, size, seed, output_format, enable_safety_checker }` — it never reads `negativePrompt`.",
    "`TEXT_FREE_NEGATIVE_PROMPT_TERMS` is computed by the compiler but is silently discarded before the",
    "RunPod call on the live production route. The `control` case below still threads",
    "`compiled.negative` through the call (case `mixed` does not) to make this checkable: see the",
    "self-check line below proving the two resulting RunPod payloads are byte-identical.",
    "",
    "## Self-check",
    "",
    "```",
    ...selfCheck.lines,
    selfCheck.pass ? "SELF-CHECK: PASS" : "SELF-CHECK: FAIL — see above",
    "```",
    "",
  ];
  for (const item of compiledCases) {
    sections.push(
      `## ${item.case.labelEn} (\`${item.case.id}\`)`,
      "",
      item.case.targetText ? `**Target text:** \`${item.case.targetText}\`` : "**Target text:** n/a (see beat text)",
      `**contentDomain:** ${item.case.contentDomain}`,
      `**treatment:** ${item.case.treatment}`,
      `**seed:** ${item.compiled ? "" : ""}${item.seed}${item.case.seedOf ? ` (reused from \`${item.case.seedOf}\`)` : ""}`,
      `**negative prompt threaded through the RunPod call:** ${item.case.applyNegative ? "YES" : "NO"} (see provider-contract finding above — has no effect either way on the live route)`,
      "",
      "**Positive prompt (as sent to the compiler; the model only ever receives the positive prompt):**",
      "```",
      item.compiled.positive,
      "```",
      "",
      "**Negative prompt (computed by the compiler; NOT transmitted to RunPod on this route):**",
      "```",
      item.compiled.negative,
      "```",
      "",
    );
  }
  fs.writeFileSync(PROMPTS_PATH, sections.join("\n"));
  console.log(`wrote ${PROMPTS_PATH}`);
}

// ---------------------------------------------------------------------------
// --generate: real RunPod Z-Image path — identical protocol to
// scripts/brand-visual-proof-pack.ts. Resumable: an existing image file on
// disk for a case id is skipped without any provider call.
// ---------------------------------------------------------------------------
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID?.trim() || "z-image-turbo";
const IMAGE_EXTENSIONS = [".png", ".jpg", ".webp"] as const;

function existingImagePath(caseId: string): string | null {
  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = path.join(IMAGE_ROOT, `${caseId}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function runpod(apiKey: string, operation: string, init?: RequestInit): Promise<RunpodJobResponse> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(RUNPOD_ENDPOINT_ID)}/${operation}`, {
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
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  throw lastError ?? new Error("RunPod request failed");
}

async function downloadImage(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "image.runpod.ai") {
    throw new Error(`Unexpected RunPod output host: ${parsed.hostname}`);
  }
  const response = await fetch(parsed, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000) });
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

async function generateOne(apiKey: string, item: CompiledCase): Promise<string> {
  const existing = existingImagePath(item.case.id);
  if (existing) {
    console.log(`SKIP ${item.case.id} (already on disk: ${path.relative(OUTPUT_ROOT, existing)})`);
    return existing;
  }
  const submitted = await runpod(apiKey, "run", {
    method: "POST",
    body: JSON.stringify({
      input: publicZImageProviderInput({
        prompt: item.compiled.positive,
        width: 720,
        height: 1280,
        seed: item.seed,
      }),
    }),
  });
  const jobId = submitted.id;
  if (!jobId) throw new Error(`${item.case.id}: RunPod accepted the job without an id`);
  console.log(`SUBMIT ${item.case.id} ${jobId}`);

  const deadline = Date.now() + 8 * 60_000;
  let snapshot = submitted;
  while (snapshot.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(snapshot.status ?? "")) {
      throw new Error(`${item.case.id}: RunPod job ${snapshot.status} — ${snapshot.error ?? "no error detail"}`);
    }
    if (Date.now() >= deadline) throw new Error(`${item.case.id}: RunPod job exceeded 8 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    snapshot = await runpod(apiKey, `status/${encodeURIComponent(jobId)}`);
  }

  const image = firstRunpodImage(snapshot);
  if (image.type !== "temporary_url" && image.type !== "s3_url") {
    throw new Error(`${item.case.id}: unsupported RunPod output type ${image.type}`);
  }
  const downloaded = await downloadImage(image.data);
  const extension = downloaded.contentType === "image/jpeg" ? ".jpg" : downloaded.contentType === "image/webp" ? ".webp" : ".png";
  const outputPath = path.join(IMAGE_ROOT, `${item.case.id}${extension}`);
  fs.mkdirSync(IMAGE_ROOT, { recursive: true });
  fs.writeFileSync(outputPath, downloaded.bytes);
  console.log(`DONE ${item.case.id} -> ${path.relative(OUTPUT_ROOT, outputPath)} ($${typeof snapshot.output?.cost === "number" ? snapshot.output.cost.toFixed(6) : "?"})`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const compiledCases = buildCompiledCases();

  console.log("");
  console.log("=== Compiled prompts ===");
  for (const item of compiledCases) {
    console.log(`\n--- ${item.case.id} (seed ${item.seed}) ---`);
    console.log(`POSITIVE: ${item.compiled.positive}`);
    console.log(`NEGATIVE (${item.case.applyNegative ? "threaded through call" : "computed but NOT sent"}): ${item.compiled.negative}`);
  }

  console.log("");
  console.log("=== Self-check ===");
  const selfCheck = runSelfCheck(compiledCases);
  for (const line of selfCheck.lines) console.log(line);
  console.log(selfCheck.pass ? "SELF-CHECK: PASS (8/8 cases)" : "SELF-CHECK: FAIL — see above");

  writePromptsMarkdown(compiledCases, selfCheck);

  if (!GENERATE) {
    console.log("");
    console.log("Dry-run complete. No network calls were made. Re-run with --generate to submit the 8 jobs to RunPod.");
    if (!selfCheck.pass) process.exitCode = 1;
    return;
  }

  if (!selfCheck.pass) {
    throw new Error("Refusing to --generate: self-check failed (see above) — a target string may have been silently stripped.");
  }

  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "RUNPOD_API_KEY is missing from .env — refusing to start --generate rather than half-running the 8-image batch.",
    );
  }
  fs.mkdirSync(IMAGE_ROOT, { recursive: true });

  let failures = 0;
  for (const item of compiledCases) {
    try {
      await generateOne(apiKey, item);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${item.case.id}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const completed = compiledCases.filter((item) => existingImagePath(item.case.id)).length;
  console.log(`image_text_legibility_probe completed=${completed}/8 failed=${failures}`);
  if (completed !== compiledCases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "probe-image-text-legibility failed");
  process.exit(1);
});
