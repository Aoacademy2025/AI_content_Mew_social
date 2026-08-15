/**
 * English-signage proof — the relaxed ADR 0007 rule, on real renders.
 * docs/plans/2026-08-10-image-text-policy.md § "แก้ไขภายหลัง (2026-08-10)"
 *
 * The first implementation kept Thai out of a frame by forbidding a surface
 * that must be read from ever being a beat's focal subject. That is
 * language-blind, so it also suppressed English signage a story is genuinely
 * about. Analyzer `-v5` states the rule as a writing system instead, and
 * `latinLetteringOnly()` enforces it deterministically at the prompt boundary.
 *
 * Two claims, one image set, through the same compiler and the same RunPod
 * Z-Image path production uses:
 *
 *   1. English lettering the story asked for now survives and renders — three
 *      beats whose focal subject IS a sign, which `-v4` would have refused.
 *   2. Thai still never reaches the model — including when a beat arrives with
 *      Thai in it anyway, which is what a planner that ignores its instruction
 *      (or a fallback brief seeded from Thai narration) actually produces.
 *
 * Plus one re-render of PR #212's cyclone Hook to show the storytelling fix is
 * unaffected.
 *
 * DEFAULT MODE IS DRY-RUN: compiles prompts, runs the self-check, writes
 * prompts.md, makes no network call. `--generate` is required to spend.
 * Resumable: an existing image for a case id is skipped without a provider call.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  compileBrandVisualPrompt,
  type BrandVisualLanguage,
  type CompiledBrandVisualPrompt,
  type VisualBeat,
  type VisualBeatPhase,
} from "../src/lib/brand-visual-system";
import {
  firstRunpodImage,
  publicZImageProviderInput,
  type RunpodJobResponse,
} from "../src/lib/runpod-image-contract";

dotenv.config({ path: ".env", override: false, quiet: true });

const GENERATE = process.argv.slice(2).includes("--generate");

const OUTPUT_ROOT = path.resolve("artifacts/english-signage-2026-08-10");
const IMAGE_ROOT = path.join(OUTPUT_ROOT, "images");
const PROMPTS_PATH = path.join(OUTPUT_ROOT, "prompts.md");
const VISUAL_FORMAT_ID = "cinematic-realism" as const;

/** Same mewsocial-representative payload the two earlier sheets used, retired
 * V1 fields included at their real shipped-bug values; v3 ignores both. */
const MEWSOCIAL_BRAND: BrandVisualLanguage = {
  palette: ["#000000", "#F8F5EE", "#38BDF8"],
  personality: "bold, raw, energetic and direct",
  peopleAndSetting: "ทีมงานในออฟฟิศ",
  memorableCues: ["วงกลมฟ้า", "ลูกศร marker"],
  visualNotes: "",
};

type ProofCase = {
  id: string;
  group: "english-focal" | "thai-suppression" | "regression";
  labelTh: string;
  contentDomain: string;
  treatment: string;
  phase: VisualBeatPhase;
  beat: Omit<VisualBeat, "phase">;
  seed: number;
  /** Words that must appear in the compiled prompt, and that a reader should be
   * able to find in the rendered frame. */
  expectWords?: readonly string[];
};

const SEED_BASE = 2026081060;

/** Group 1 — the relaxation itself. Each beat's focal subject is a surface that
 * has to be read, which is exactly what `-v4` forbade. */
const ENGLISH_FOCAL_CASES: ProofCase[] = [
  {
    id: "shop-open-late",
    group: "english-focal",
    labelTh: "ป้ายร้าน — OPEN LATE",
    contentDomain: "small shops that stay open after the offices close",
    treatment: "warm, direct, end-of-day light",
    phase: "hook",
    seed: SEED_BASE + 1,
    expectWords: ["OPEN LATE"],
    beat: {
      subject: 'a hand-lettered wooden shop sign reading "OPEN LATE"',
      action: "the owner hooks the sign onto the shutter as the last daylight goes",
      setting: "a narrow street of small shopfronts at dusk",
      emotion: "stubborn hope",
      emphasis: 'the words "OPEN LATE" standing out against the closing street',
    },
  },
  {
    id: "road-closed",
    group: "english-focal",
    labelTh: "ป้ายถนน — ROAD CLOSED",
    contentDomain: "how a single road closure reroutes an entire morning commute",
    treatment: "cold, early-morning documentary realism",
    phase: "explain",
    seed: SEED_BASE + 2,
    expectWords: ["ROAD CLOSED"],
    beat: {
      subject: 'a metal roadwork barrier carrying a large sign that reads "ROAD CLOSED"',
      action: "traffic slows and peels away to the right as drivers read the sign",
      setting: "a two-lane road at first light with orange cones narrowing the lane",
      emotion: "resigned early-morning frustration",
      emphasis: 'the sign reading "ROAD CLOSED" blocking the way ahead',
    },
  },
  {
    id: "clinic-walk-ins",
    group: "english-focal",
    labelTh: "ป้ายคลินิก — WALK-INS WELCOME",
    contentDomain: "small clinics that take patients without an appointment",
    treatment: "calm, reassuring daylight realism",
    phase: "close",
    seed: SEED_BASE + 3,
    expectWords: ["WALK-INS WELCOME"],
    beat: {
      subject: 'a small painted window sign reading "WALK-INS WELCOME"',
      action: "a patient pauses at the glass, reads it, and pushes the door open",
      setting: "the street-facing window of a small neighbourhood clinic in daylight",
      emotion: "quiet relief",
      emphasis: 'the words "WALK-INS WELCOME" that decided the patient to go in',
    },
  },
];

/** Group 2 — Thai suppression, including the case that actually happens: a beat
 * that arrives with Thai in it despite the instruction. Nothing downstream of
 * the compiler can refuse it, so the compiler must. */
const THAI_SUPPRESSION_CASES: ProofCase[] = [
  {
    id: "market-english-sign",
    group: "thai-suppression",
    labelTh: "ตลาดไทย — ป้ายเป็นอังกฤษ",
    contentDomain: "morning trade at a Thai wet market",
    treatment: "brisk, humid, early-market realism",
    phase: "hook",
    seed: SEED_BASE + 4,
    expectWords: ["FRESH TODAY"],
    beat: {
      subject: 'a chalk price sign above a fruit stall reading "FRESH TODAY"',
      action: "the vendor wipes the sign clean and rewrites the morning price beneath it",
      setting: "a crowded covered market aisle under a low tin roof",
      emotion: "brisk early-market energy",
      emphasis: 'the freshly chalked words "FRESH TODAY" above the fruit',
    },
  },
  {
    id: "defect-thai-beat",
    group: "thai-suppression",
    labelTh: "beat หลุดภาษาไทย (จำลองความผิดพลาด)",
    contentDomain: "การตลาดร้านเล็ก small shop marketing",
    treatment: "สดใส สนุก และเป็นกันเอง",
    phase: "explain",
    seed: SEED_BASE + 5,
    beat: {
      subject: 'ป้ายหน้าร้านเขียนว่า "ลดราคา" a hand-painted shop sign',
      action: "the owner ties the sign to the shutter and steps back to look at it",
      setting: "ตลาดเช้า a covered morning market aisle",
      emotion: "ความหวังเงียบๆ quiet hope",
      emphasis: "the sign the owner just hung above the shutter",
    },
  },
];

/** Group 3 — PR #212's cyclone Hook, copied verbatim, to show the storytelling
 * fix is untouched by any of this. */
const REGRESSION_CASES: ProofCase[] = [
  {
    id: "cyclone-hook",
    group: "regression",
    labelTh: "พายุไซโคลน — Hook (เช็คว่าไม่ถอยหลัง)",
    contentDomain: "extreme weather and cyclone preparedness in a Thai coastal fishing town",
    treatment: "urgent, cinematic and overwhelming in scale",
    phase: "hook",
    seed: SEED_BASE + 6,
    beat: {
      subject: "a towering cyclone wall of dark storm cloud and driving rain rolling over open water",
      action: "the storm wall advances toward the shoreline as wind visibly bends the treeline and whips up sea spray",
      setting: "an open coastal horizon off a Thai fishing town, with no structures in the foreground",
      emotion: "awe mixed with dread",
      emphasis: "the sheer scale of the approaching storm dominating the frame",
    },
  },
];

const ALL_CASES: ProofCase[] = [
  ...ENGLISH_FOCAL_CASES,
  ...THAI_SUPPRESSION_CASES,
  ...REGRESSION_CASES,
];

type CompiledCase = ProofCase & { compiled: CompiledBrandVisualPrompt };

function compileCases(): CompiledCase[] {
  return ALL_CASES.map((item) => ({
    ...item,
    compiled: compileBrandVisualPrompt({
      visualFormatId: VISUAL_FORMAT_ID,
      contentDomain: item.contentDomain,
      treatment: item.treatment,
      visualBeat: { ...item.beat, phase: item.phase },
      brandVisualLanguage: MEWSOCIAL_BRAND,
    }),
  }));
}

const THAI_CHARACTER = /[฀-๿]/;
const DANGLING_CONNECTOR = /story about\s*[,.]|show\s*[,.]|set in\s*[,.]|feels\s*[,.]|rests on\s*[,.]|favors\s*\./;

function runSelfCheck(cases: CompiledCase[]): { pass: boolean; lines: string[] } {
  const lines: string[] = [];
  let pass = true;
  const fail = (message: string) => {
    pass = false;
    lines.push(`FAIL ${message}`);
  };
  const ok = (message: string) => lines.push(`PASS ${message}`);

  for (const item of cases) {
    const positive = item.compiled.positive;

    if (THAI_CHARACTER.test(positive)) fail(`${item.id}: a Thai character reached the positive prompt`);
    else ok(`${item.id}: no Thai character in the positive prompt`);

    if (positive.includes("#")) fail(`${item.id}: positive prompt contains a hex code`);
    else ok(`${item.id}: no hex code`);

    if (DANGLING_CONNECTOR.test(positive)) fail(`${item.id}: a stripped field left a dangling connector`);
    else ok(`${item.id}: no dangling connector`);

    for (const words of item.expectWords ?? []) {
      if (positive.includes(words)) ok(`${item.id}: the story's own wording "${words}" survived to the prompt`);
      else fail(`${item.id}: the story's own wording "${words}" was scrubbed out of the prompt`);
    }
  }

  const defect = cases.find((item) => item.id === "defect-thai-beat")!;
  if (!defect.compiled.positive.includes("a hand-painted shop sign")) {
    fail("defect-thai-beat: stripping Thai also destroyed the English the beat carried");
  } else {
    ok("defect-thai-beat: the English half of a mixed-script field survives");
  }
  if (!defect.compiled.positive.includes("set in a covered morning market aisle")) {
    fail("defect-thai-beat: a mixed-script setting was dropped whole instead of stripped");
  } else {
    ok("defect-thai-beat: a mixed-script setting keeps its Latin half");
  }

  const cyclone = cases.find((item) => item.id === "cyclone-hook")!;
  if (!/storm|cyclone|rain|wind/i.test(cyclone.compiled.positive)) {
    fail("cyclone-hook: the prompt no longer describes weather");
  } else {
    ok("cyclone-hook: the prompt still genuinely describes weather");
  }
  if (/circular motif|unmarked disc|plain empty solid color fields/i.test(cyclone.compiled.positive)) {
    fail("cyclone-hook: a PR #212 forbidden phrase came back");
  } else {
    ok("cyclone-hook: no PR #212 forbidden phrase");
  }

  return { pass, lines };
}

const GROUP_LABEL: Record<ProofCase["group"], string> = {
  "english-focal": "1. English lettering as the beat's focal subject (the relaxation)",
  "thai-suppression": "2. Thai never reaches the model, including from a defective beat",
  regression: "3. PR #212 storytelling fix, re-rendered",
};

function writePromptsMarkdown(cases: CompiledCase[]): void {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const sections: string[] = [
    "# English-signage proof — compiled prompts",
    "",
    "Generated by `scripts/proof-english-signage.ts` (dry-run). No network calls produced this file.",
    "",
    `Visual Format: ${VISUAL_FORMAT_ID} (recipe ${cases[0]?.compiled.recipeVersion ?? "?"})`,
    "",
    "Brand payload used for every prompt:",
    "",
    "```json",
    JSON.stringify(MEWSOCIAL_BRAND, null, 2),
    "```",
    "",
  ];
  for (const group of ["english-focal", "thai-suppression", "regression"] as const) {
    sections.push(`## ${GROUP_LABEL[group]}`, "");
    for (const item of cases.filter((candidate) => candidate.group === group)) {
      sections.push(
        `### \`${item.id}\` — ${item.labelTh}`,
        "",
        `**contentDomain:** ${item.contentDomain}`,
        `**treatment:** ${item.treatment}`,
        `**seed:** ${item.seed}`,
        "",
        "**Beat (as authored, before the compiler):**",
        "```json",
        JSON.stringify({ phase: item.phase, ...item.beat }, null, 2),
        "```",
        "",
        "**Positive prompt (sent as-is; this route has no negative channel):**",
        "```",
        item.compiled.positive,
        "```",
        "",
      );
    }
  }
  fs.writeFileSync(PROMPTS_PATH, sections.join("\n"));
  console.log(`wrote ${PROMPTS_PATH}`);
}

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
  const existing = existingImagePath(item.id);
  if (existing) {
    console.log(`SKIP ${item.id} (already on disk)`);
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
  if (!jobId) throw new Error(`${item.id}: RunPod accepted the job without an id`);
  console.log(`SUBMIT ${item.id} ${jobId}`);

  const deadline = Date.now() + 8 * 60_000;
  let snapshot = submitted;
  while (snapshot.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(snapshot.status ?? "")) {
      throw new Error(`${item.id}: RunPod job ${snapshot.status} — ${snapshot.error ?? "no error detail"}`);
    }
    if (Date.now() >= deadline) throw new Error(`${item.id}: RunPod job exceeded 8 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    snapshot = await runpod(apiKey, `status/${encodeURIComponent(jobId)}`);
  }

  const image = firstRunpodImage(snapshot);
  if (image.type !== "temporary_url" && image.type !== "s3_url") {
    throw new Error(`${item.id}: unsupported RunPod output type ${image.type}`);
  }
  const downloaded = await downloadImage(image.data);
  const extension = downloaded.contentType === "image/jpeg"
    ? ".jpg"
    : downloaded.contentType === "image/webp" ? ".webp" : ".png";
  const outputPath = path.join(IMAGE_ROOT, `${item.id}${extension}`);
  fs.mkdirSync(IMAGE_ROOT, { recursive: true });
  fs.writeFileSync(outputPath, downloaded.bytes);
  console.log(`DONE ${item.id} -> ${path.relative(OUTPUT_ROOT, outputPath)}`);
  return outputPath;
}

async function main() {
  const cases = compileCases();
  writePromptsMarkdown(cases);

  console.log("");
  console.log("=== Self-check ===");
  const selfCheck = runSelfCheck(cases);
  for (const line of selfCheck.lines) console.log(line);
  console.log(selfCheck.pass ? `SELF-CHECK: PASS (${cases.length} prompts)` : "SELF-CHECK: FAIL — see above");

  if (!GENERATE) {
    console.log("");
    console.log(`Dry-run complete. No network calls. Re-run with --generate to submit ${cases.length} jobs.`);
    if (!selfCheck.pass) process.exitCode = 1;
    return;
  }
  if (!selfCheck.pass) throw new Error("refusing to spend on a batch whose prompts fail their own self-check");

  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!apiKey) throw new Error("RUNPOD_API_KEY is missing from .env — refusing to half-run the batch.");
  fs.mkdirSync(IMAGE_ROOT, { recursive: true });

  let failures = 0;
  for (const item of cases) {
    try {
      await generateOne(apiKey, item);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${item.id}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const completed = cases.filter((item) => existingImagePath(item.id)).length;
  console.log(`proof_english_signage completed=${completed}/${cases.length} failed=${failures}`);
  if (completed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "proof-english-signage failed");
  process.exit(1);
});
