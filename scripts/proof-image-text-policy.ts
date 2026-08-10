/**
 * Image Text Policy Proof — Task 4 harness
 * docs/plans/2026-08-10-image-text-policy.md § "Task 4 — Image proof"
 *
 * Proves whether beats written the way Task 2's new instruction requires
 * (`content-preflight.server.ts`, `CONTENT_PREFLIGHT_ANALYZER_VERSION =
 * "brand-content-preflight-v4-focal-subject"`) actually keep readable Thai out
 * of generated images, without suppressing English, and without regressing
 * the PR #212 storytelling fix.
 *
 * Task 2 added NO compiler clause — `compileBrandVisualPromptV3`'s positive
 * prompt is byte-identical to before (verified: no "Thai" token anywhere in
 * `V3_FORMAT_RECIPE_DIRECTION`, unlike v1/v2's hardcoded "believable Thai
 * environments"). The only lever pulled is what Gemini is told to extract as
 * a Visual Beat: "a sign, banner, poster, screen, page or any other surface
 * whose meaning depends on being read must never be what a beat is about, in
 * any language" (src/lib/content-preflight.server.ts:239). So this harness
 * hand-authors beats the way that instruction requires — physical situation
 * and human consequence, never a sign as the focal subject — through the same
 * real compiler and the same real RunPod Z-Image path production uses
 * (`compileBrandVisualPrompt` cinematic-realism-v3 +
 * `publicZImageProviderInput`, positive-prompt-only per
 * src/lib/runpod-image-contract.ts).
 *
 * Four groups, 9 images total, matching the plan's Task 4 spec:
 *   1. `market-*`   (3) — Thai market/street scene. Main claim under test:
 *                          no readable Thai may appear.
 *   2. `airport`,
 *      `depot`      (2) — English signage is natural (airport gate, shipping
 *                          depot). English must not be suppressed.
 *   3. `us-diner`    (1) — locale explicitly the United States. Proves v3 has
 *                          no hardcoded "believable Thai environments" pull
 *                          (that phrase only exists in the frozen v1/v2
 *                          recipes, never in V3_FORMAT_RECIPE_DIRECTION).
 *   4. `cyclone-*`   (3) — same beats as
 *                          artifacts/brand-visual-fix-2026-08-10/ (copied
 *                          verbatim from scripts/brand-visual-proof-pack.ts),
 *                          re-rendered to prove PR #212's storytelling fix
 *                          still holds after Task 2's changes.
 *
 * DEFAULT MODE IS DRY-RUN. `--dry-run` (default, also accepted explicitly)
 * makes no network calls: it only compiles prompts, runs the self-check and
 * writes `prompts.md`. `--generate` is required to actually call RunPod,
 * spend credits, and write images. Resumable: an existing image file for a
 * case id is skipped without a provider call, same as
 * scripts/brand-visual-proof-pack.ts and scripts/probe-image-text-legibility.ts.
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

const args = process.argv.slice(2);
const GENERATE = args.includes("--generate");

const OUTPUT_ROOT = path.resolve("artifacts/image-text-policy-2026-08-10");
const IMAGE_ROOT = path.join(OUTPUT_ROOT, "images");
const PROMPTS_PATH = path.join(OUTPUT_ROOT, "prompts.md");

// ---------------------------------------------------------------------------
// Visual Format: cinematic-realism, default (unpinned) recipe version — v3,
// the shipped current compiler. Same format the earlier two sheets used, so
// this result transfers to Mew's real, live use.
// ---------------------------------------------------------------------------
const VISUAL_FORMAT_ID = "cinematic-realism" as const;

// ---------------------------------------------------------------------------
// mewsocial-representative Brand Profile payload — identical to the one in
// scripts/brand-visual-proof-pack.ts (STORM_BRAND fixture values), reused
// here per this task's own instruction ("the same mewsocial-representative
// brand payload the earlier proof pack uses"). The two retired V1 fields
// (`peopleAndSetting`, `memorableCues`) are kept at their real shipped-bug
// values; v3 ignores both.
// ---------------------------------------------------------------------------
const MEWSOCIAL_BRAND: BrandVisualLanguage = {
  palette: ["#000000", "#F8F5EE", "#38BDF8"],
  personality: "bold, raw, energetic and direct",
  peopleAndSetting: "ทีมงานในออฟฟิศ",
  memorableCues: ["วงกลมฟ้า", "ลูกศร marker"],
  visualNotes: "",
};

type ProofCase = {
  id: string;
  group: "market" | "english-signage" | "locale-us" | "cyclone";
  labelTh: string;
  contentDomain: string;
  treatment: string;
  phase: VisualBeatPhase;
  beat: Omit<VisualBeat, "phase">;
  seed: number;
};

const SEED_BASE = 2026081040;

// ---------------------------------------------------------------------------
// Group 1 — Thai market/street scene (3). Beats are written the way Task 2's
// new instruction requires: the underlying story (haggling over price) is
// exactly the kind of content that, pre-instruction, would have tempted a
// beat like `subject: "a chalkboard price sign"`. Every beat below instead
// names the physical situation and human consequence — hands, gestures,
// coins, the completed exchange — never a sign/banner/board as what the beat
// is about, in any language. This is the harness's own compliance with the
// rule Task 2 taught Gemini; the self-check below asserts it mechanically.
// ---------------------------------------------------------------------------
const MARKET_DOMAIN = "haggling over produce prices at a busy Thai morning wet market";
const MARKET_CASES: ProofCase[] = [
  {
    id: "market-hook",
    group: "market",
    labelTh: "ตลาดสด — ต่อรองราคา",
    contentDomain: MARKET_DOMAIN,
    treatment: "playful, brisk haggling tension",
    phase: "hook",
    seed: SEED_BASE + 1,
    beat: {
      subject: "a vendor holding up two fingers while gesturing toward a pile of ripe mangoes",
      action: "the vendor counters a customer's low offer with a firm shake of the head and a raised hand",
      setting: "a crowded wet market alley lined with wooden fruit stalls under a low tin roof",
      emotion: "playful haggling tension",
      emphasis: "the back-and-forth hand gestures between vendor and customer",
    },
  },
  {
    id: "market-explain",
    group: "market",
    labelTh: "ตลาดสด — จ่ายเงิน",
    contentDomain: MARKET_DOMAIN,
    treatment: "brisk, matter-of-fact exchange",
    phase: "explain",
    seed: SEED_BASE + 2,
    beat: {
      subject: "a customer's hand dropping coins one by one into a vendor's cupped palm",
      action: "the coins are counted out loud as a bag of green vegetables is passed across the stall counter",
      setting: "a narrow market aisle crowded with woven baskets and hanging bunches of herbs",
      emotion: "brisk, matter-of-fact exchange",
      emphasis: "the coins changing hands as the deal is settled",
    },
  },
  {
    id: "market-close",
    group: "market",
    labelTh: "ตลาดสด — ปิดการขาย",
    contentDomain: MARKET_DOMAIN,
    treatment: "warm, satisfied resolution",
    phase: "close",
    seed: SEED_BASE + 3,
    beat: {
      subject: "a vendor and a customer shaking hands over a full bag of produce",
      action: "the vendor smiles and nods as the customer lifts the bag and turns to leave",
      setting: "the same crowded stall row now lit by mid-morning sun filtering through the tin roof",
      emotion: "warm, satisfied resolution",
      emphasis: "the handshake sealing the completed exchange",
    },
  },
];

// ---------------------------------------------------------------------------
// Group 2 — English-signage scene (2). An airport gate and a shipping depot
// are locations where English lettering (gate boards, container stencils) is
// a natural, incidental part of the environment. Nothing here suppresses it —
// there is no negative-prompt channel to suppress it with in the first place
// (publicZImageProviderInput carries positive-only) — this proves English
// keeps rendering and reading correctly rather than being collaterally
// damaged by the Thai-suppression beat instruction.
// ---------------------------------------------------------------------------
const ENGLISH_SIGNAGE_CASES: ProofCase[] = [
  {
    id: "airport",
    group: "english-signage",
    labelTh: "สนามบิน — ประตูขึ้นเครื่อง",
    contentDomain: "a traveler moving through a departure gate area in a busy international airport",
    treatment: "brisk, well-lit, modern travel realism",
    phase: "hook",
    seed: SEED_BASE + 4,
    beat: {
      subject: "a traveler pulling a rolling suitcase while checking the time on their wristwatch",
      action: "they walk briskly past a row of gate seating as fellow passengers begin lining up to board",
      setting: "a wide airport terminal corridor near a departure gate with tall windows overlooking the tarmac",
      emotion: "mild travel urgency",
      emphasis: "the traveler weaving quickly through the gathering crowd toward the gate",
    },
  },
  {
    id: "depot",
    group: "english-signage",
    labelTh: "คลังสินค้า — จุดขนส่ง",
    contentDomain: "a warehouse worker processing an incoming shipment at a cargo depot",
    treatment: "brisk industrial realism, functional lighting",
    phase: "explain",
    seed: SEED_BASE + 5,
    beat: {
      subject: "a warehouse worker scanning a barcode on a cardboard shipping box with a handheld scanner",
      action: "the worker stacks the scanned box onto a loaded wheeled cart beside rows of shipping pallets",
      setting: "a large shipping depot loading dock with stacked cargo containers and open bay doors",
      emotion: "brisk industrial efficiency",
      emphasis: "the worker's hand pressing the scanner trigger against the box",
    },
  },
];

// ---------------------------------------------------------------------------
// Group 3 — Locale-follows-story (1). A story explicitly set in the United
// States. Proves the v3 recipe carries no hardcoded locale pull: v1/v2's
// `V1_FORMAT_DIRECTION["cinematic-realism"]` / `V2_FORMAT_RECIPE_DIRECTION`
// both hardcode "real human anatomy and believable Thai environments";
// `V3_FORMAT_RECIPE_DIRECTION["cinematic-realism-v3"]` has no such phrase —
// it says only "physically plausible surroundings wherever they appear". If
// that removal actually took, this frame should read as American, driven
// purely by the beat content below (chrome diner counter, trucker, yellow
// school bus, interstate highway, American Midwest).
// ---------------------------------------------------------------------------
const LOCALE_US_CASES: ProofCase[] = [
  {
    id: "us-diner",
    group: "locale-us",
    labelTh: "ร้านอาหารริมทาง สหรัฐฯ",
    contentDomain: "a late-night roadside diner scene along a rural highway in the American Midwest",
    treatment: "warm, nostalgic Americana, film-grain lit",
    phase: "hook",
    seed: SEED_BASE + 6,
    beat: {
      subject: "a waitress in a checkered apron pouring coffee for a trucker seated at a chrome diner counter",
      action: "she tops off his mug as a yellow school bus passes by on the highway outside the window",
      setting:
        "a classic roadside diner along a rural interstate highway in the American Midwest, red vinyl stools and a jukebox glowing in the corner",
      emotion: "warm late-night hospitality",
      emphasis: "the steam rising from the coffee as it's poured",
    },
  },
];

// ---------------------------------------------------------------------------
// Group 4 — Cyclone Hook/Explain/Close (3), copied verbatim (contentDomain,
// treatment and every VisualBeat field) from the `cyclone` story in
// scripts/brand-visual-proof-pack.ts (PR #212's proof pack, re-rendered at
// artifacts/brand-visual-fix-2026-08-10/). Re-rendering the exact same beats
// through the exact same compiler proves Task 2's changes did not regress the
// storytelling fix: still weather-and-story, no circular motifs, no flat
// color plates.
// ---------------------------------------------------------------------------
const CYCLONE_DOMAIN = "extreme weather and cyclone preparedness in a Thai coastal fishing town";
const CYCLONE_CASES: ProofCase[] = [
  {
    id: "cyclone-hook",
    group: "cyclone",
    labelTh: "พายุไซโคลน — Hook",
    contentDomain: CYCLONE_DOMAIN,
    treatment: "urgent, cinematic and overwhelming in scale",
    phase: "hook",
    seed: SEED_BASE + 7,
    beat: {
      subject: "a towering cyclone wall of dark storm cloud and driving rain rolling over open water",
      action: "the storm wall advances toward the shoreline as wind visibly bends the treeline and whips up sea spray",
      setting: "an open coastal horizon off a Thai fishing town, with no structures in the foreground",
      emotion: "awe mixed with dread",
      emphasis: "the sheer scale of the approaching storm dominating the frame",
    },
  },
  {
    id: "cyclone-explain",
    group: "cyclone",
    labelTh: "พายุไซโคลน — Explain",
    contentDomain: CYCLONE_DOMAIN,
    treatment: "calm, determined and grounded in practical action",
    phase: "explain",
    seed: SEED_BASE + 8,
    beat: {
      subject: "a pair of hands stacking sandbags against a wooden doorway",
      action: "each sandbag is pressed firmly into place as loose shutters rattle in the rising wind outside",
      setting: "the doorway of a stilted Thai coastal house with the storm visibly approaching over the water behind it",
      emotion: "calm, determined focus",
      emphasis: "the direct link between preparing now and the household staying safe once the storm makes landfall",
    },
  },
  {
    id: "cyclone-close",
    group: "cyclone",
    labelTh: "พายุไซโคลน — Close",
    contentDomain: CYCLONE_DOMAIN,
    treatment: "hard-won calm and quiet readiness",
    phase: "close",
    seed: SEED_BASE + 9,
    beat: {
      subject: "a Thai coastal resident standing at the railing of a stilted house, looking out over the secured shoreline",
      action: "steps back from the railing with arms crossed in quiet resolve as the storm looms on the darkening horizon",
      setting: "the elevated porch of a stilted coastal house facing the open sea",
      emotion: "hard-won calm and readiness",
      emphasis: "the resident's readiness against the storm now bearing down on the coast",
    },
  },
];

const ALL_CASES: ProofCase[] = [
  ...MARKET_CASES,
  ...ENGLISH_SIGNAGE_CASES,
  ...LOCALE_US_CASES,
  ...CYCLONE_CASES,
];

if (ALL_CASES.length !== 9) {
  throw new Error(`Expected exactly 9 cases, found ${ALL_CASES.length}`);
}

// ---------------------------------------------------------------------------
// Compile.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Self-check.
// ---------------------------------------------------------------------------

// The literal words a beat must never center on, per Task 2's instruction
// verbatim ("a sign, banner, poster, screen, page or any other surface whose
// meaning depends on being read must never be what a beat is about, in any
// language"). Checked against `subject`/`action`/`emphasis` — the fields that
// say what the beat is "about" — not `setting`, where an incidental
// background mention would be permitted by the rule. Deliberately does NOT
// include the bare word "board": it collides with unrelated senses ("line up
// to board" a plane, "cutting board") that are not the instruction's target
// and would make this check noisy rather than precise.
const FOCAL_SIGNAGE_WORDS = /\bsign\b|\bsigns\b|\bsignage\b|\bbanner\b|\bposter\b|\bscreen\b|\bpage\b|\bnotice board\b|\bmenu board\b|\bchalkboard\b|\bplacard\b/i;

const FORBIDDEN_PHRASES = [
  "circular motif",
  "solid unmarked disc",
  "plain empty solid color fields",
  "Repeat the visual cues",
  "People and places follow",
] as const;

const WEATHER_LANGUAGE = /storm|cyclone|wind|rain|cloud|wave|sea|coast|water|weather/i;
const THAI_LOCALE_HINTS = /Thai|Thailand|baht|ตัว/i;
const COLOR_GRADE_MARKER = "The overall color grade favors";

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

    if (positive.includes("#")) fail(`${item.id}: positive prompt contains a hex code`);
    else ok(`${item.id}: no hex code`);

    const hitPhrase = FORBIDDEN_PHRASES.find((phrase) => positive.includes(phrase));
    if (hitPhrase) fail(`${item.id}: positive prompt contains forbidden phrase "${hitPhrase}"`);
    else ok(`${item.id}: no forbidden art-direction-as-instruction phrases`);

    if (!positive.includes(COLOR_GRADE_MARKER)) {
      fail(`${item.id}: no color-grade clause — brand palette silently dropped`);
    } else {
      ok(`${item.id}: color-grade clause present`);
    }

    // Compliance check on this harness's own authored beats: subject/action/
    // emphasis must never center the beat on a sign/banner/poster/screen/
    // page/board, for every group, in either language.
    const beatCore = `${item.beat.subject} ${item.beat.action} ${item.beat.emphasis}`;
    if (FOCAL_SIGNAGE_WORDS.test(beatCore)) {
      fail(`${item.id}: beat subject/action/emphasis names a sign/banner/poster/screen/board as the focal subject`);
    } else {
      ok(`${item.id}: beat is about a physical situation, not a sign/banner/poster/screen/board`);
    }
  }

  const cycloneHook = cases.find((item) => item.id === "cyclone-hook")!;
  if (!WEATHER_LANGUAGE.test(cycloneHook.compiled.positive)) {
    fail("cyclone-hook: positive prompt does not genuinely describe weather");
  } else {
    ok("cyclone-hook: positive prompt genuinely describes weather");
  }

  const usDiner = cases.find((item) => item.id === "us-diner")!;
  if (THAI_LOCALE_HINTS.test(usDiner.compiled.positive)) {
    fail("us-diner: positive prompt leaks a Thai-locale word despite an explicitly American beat");
  } else {
    ok("us-diner: positive prompt carries no Thai-locale word");
  }

  return { pass, lines };
}

// ---------------------------------------------------------------------------
// Dry-run output.
// ---------------------------------------------------------------------------

const GROUP_LABEL: Record<ProofCase["group"], string> = {
  market: "1. Thai market / street scene (main claim: no readable Thai)",
  "english-signage": "2. English-signage scene (English must survive)",
  "locale-us": "3. Locale-follows-story (United States)",
  cyclone: "4. Cyclone Hook/Explain/Close re-render (storytelling regression check)",
};

function writePromptsMarkdown(cases: CompiledCase[]): void {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const sections: string[] = [
    "# Image Text Policy Proof — compiled prompts",
    "",
    `Generated ${new Date().toISOString()} by scripts/proof-image-text-policy.ts --dry-run.`,
    "No network calls were made to produce this file.",
    "",
    `Visual Format: ${VISUAL_FORMAT_ID} (recipe ${cases[0]?.compiled.recipeVersion ?? "?"})`,
    "",
    "Brand payload used for all 9 prompts (mewsocial-representative, same as",
    "scripts/brand-visual-proof-pack.ts):",
    "",
    "```json",
    JSON.stringify(MEWSOCIAL_BRAND, null, 2),
    "```",
    "",
  ];
  for (const group of ["market", "english-signage", "locale-us", "cyclone"] as const) {
    sections.push(`## ${GROUP_LABEL[group]}`, "");
    for (const item of cases.filter((candidate) => candidate.group === group)) {
      sections.push(
        `### \`${item.id}\` — ${item.labelTh}`,
        "",
        `**contentDomain:** ${item.contentDomain}`,
        `**treatment:** ${item.treatment}`,
        `**seed:** ${item.seed}`,
        "",
        "**Beat:**",
        "```json",
        JSON.stringify({ phase: item.phase, ...item.beat }, null, 2),
        "```",
        "",
        "**Positive prompt (sent to RunPod as-is, no negative channel exists on this route):**",
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

// ---------------------------------------------------------------------------
// --generate: real RunPod Z-Image path, same protocol as
// scripts/brand-visual-proof-pack.ts / scripts/probe-image-text-legibility.ts.
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
  const existing = existingImagePath(item.id);
  if (existing) {
    console.log(`SKIP ${item.id} (already on disk: ${path.relative(OUTPUT_ROOT, existing)})`);
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
  const extension = downloaded.contentType === "image/jpeg" ? ".jpg" : downloaded.contentType === "image/webp" ? ".webp" : ".png";
  const outputPath = path.join(IMAGE_ROOT, `${item.id}${extension}`);
  fs.mkdirSync(IMAGE_ROOT, { recursive: true });
  fs.writeFileSync(outputPath, downloaded.bytes);
  console.log(`DONE ${item.id} -> ${path.relative(OUTPUT_ROOT, outputPath)} ($${typeof snapshot.output?.cost === "number" ? snapshot.output.cost.toFixed(6) : "?"})`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const cases = compileCases();
  writePromptsMarkdown(cases);

  console.log("");
  console.log("=== Compiled prompts ===");
  for (const item of cases) {
    console.log(`\n--- ${item.id} (${item.group}, ${item.compiled.recipeVersion}) ---`);
    console.log(`POSITIVE: ${item.compiled.positive}`);
  }

  console.log("");
  console.log("=== Self-check ===");
  const selfCheck = runSelfCheck(cases);
  for (const line of selfCheck.lines) console.log(line);
  console.log(selfCheck.pass ? "SELF-CHECK: PASS (9/9 prompts)" : "SELF-CHECK: FAIL — see above");

  if (!GENERATE) {
    console.log("");
    console.log("Dry-run complete. No network calls were made. Re-run with --generate to submit the 9 jobs to RunPod.");
    if (!selfCheck.pass) process.exitCode = 1;
    return;
  }

  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "RUNPOD_API_KEY is missing from .env — refusing to start --generate rather than half-running the 9-image batch.",
    );
  }
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
  console.log(`proof_image_text_policy completed=${completed}/9 failed=${failures}`);
  if (completed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "proof-image-text-policy failed");
  process.exit(1);
});
