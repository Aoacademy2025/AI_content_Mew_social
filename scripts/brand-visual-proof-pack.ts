/**
 * Brand Visual Proof Pack — Task 5 harness
 * docs/plans/2026-08-10-brand-visual-storytelling-fix.md § "Task 5 — Proof pack (9 real images)"
 *
 * Compiles 9 real-world prompts (3 Thai short-form stories × Hook/Explain/Close) through the
 * shipped `compileBrandVisualPrompt` (Task 1's v3 compiler) under a mewsocial-representative
 * Brand Profile, then — only when explicitly asked — submits them through the real RunPod
 * Z-Image path and lays the results out as a before/after contact sheet.
 *
 * DEFAULT MODE IS DRY-RUN. `--dry-run` (default, also accepted explicitly) makes no network
 * calls: it only compiles prompts and writes them to `prompts.md`. `--generate` is required to
 * actually call RunPod, spend credits, and write images. This file was built and dry-run-tested
 * without ever passing `--generate` — Mew triggers the real generation separately once the two
 * in-flight reviews land.
 *
 * JUDGMENT CALL — beats are hand-authored, not pulled from the real content-preflight path:
 * `createGeminiContentPreflightAnalyzer` (src/lib/content-preflight.server.ts) is not a pure
 * function of script text — it requires a `userId`, a Prisma `User` row (for `geminiKey`/`plan`),
 * `resolveGeminiKey()`, and `reserveAiTextCall()` (a DB-backed monthly quota). There is no way to
 * run it "without a Gemini key" — the analysis step is inherently an LLM call — so per this
 * task's own instruction ("if a key is unavailable, hand-author beats"), and because standing up
 * a throwaway SQLite + seeded user + quota row is exactly the kind of scope creep the plan's
 * "Out of scope" section warns against (content-preflight extraction quality is explicitly
 * deferred: "Revisit only if Task 5 shows weak beats"), the beats below are hand-authored to
 * faithfully match each script. This also makes the self-check in the plan deterministic instead
 * of depending on nondeterministic LLM output — important for a harness whose whole point is
 * proving the *compiler* fix, not the beat extractor. Each script is included in full below so a
 * rerun (or a future real-preflight rerun) is reproducible from the same source text.
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

// ---------------------------------------------------------------------------
// .env loading — same pattern as scripts/smoke-runpod-public-image.ts and
// scripts/run-brand-visual-quality-gate.ts.
// ---------------------------------------------------------------------------
dotenv.config({ path: ".env", override: false, quiet: true });

const args = process.argv.slice(2);
const GENERATE = args.includes("--generate");

const OUTPUT_ROOT = path.resolve("artifacts/brand-visual-fix-2026-08-10");
const IMAGE_ROOT = path.join(OUTPUT_ROOT, "images");
const BEFORE_ROOT = path.join(OUTPUT_ROOT, "before");
const PROMPTS_PATH = path.join(OUTPUT_ROOT, "prompts.md");
const INDEX_PATH = path.join(OUTPUT_ROOT, "index.html");

// ---------------------------------------------------------------------------
// mewsocial-representative Brand Profile payload
//
// Palette is passed the way the real /brands form produces it: the color field
// is an `<input type="color">` (src/app/(dashboard)/brands/_components/AdvancedSettings.tsx),
// so every entry is a raw hex string — never a color word. `#000000` / `#F8F5EE` /
// `#38BDF8` are the exact high-contrast black / warm white / sky blue values the
// existing STORM_BRAND fixture in scripts/verify-brand-visual-system.ts already
// uses for this same brand.
//
// `peopleAndSetting` and `memorableCues` are the two retired-from-the-prompt V1
// fields (ADR 0006, ยกเลิก decision 2). They are DELIBERATELY set here to their
// real shipped-bug values — "ทีมงานในออฟฟิศ" / circle+arrow cues — so the proof
// pack demonstrates the v3 compiler ignores them rather than by omitting them
// and trivially passing.
// ---------------------------------------------------------------------------
const MEWSOCIAL_VISUAL_FORMAT_ID = "cinematic-realism" as const; // ภาพสมจริงแบบหนัง — this is the
// actual regression case: Mew picked the realistic style ("สไตล์สมจริง") for her
// video, and every broken frame she sent is a photorealistic image of people in
// an office with blue discs on the walls. The 2026-08-09 product brief's own
// Brand Differentiation Benchmark pairs Mewsocial with `stick-figure-story`
// (docs/plans/2026-08-09-brand-visual-system-product-brief.md line 38;
// MEWSOCIAL_BENCHMARK_VISUAL_LANGUAGE in src/lib/brand-visual-system.ts), but that
// is a *different* demonstration (format-differentiation), not Mew's shipped bug —
// a marker/stick-figure proof pack would not demonstrate her case is fixed.

const MEWSOCIAL_BRAND: BrandVisualLanguage = {
  palette: ["#000000", "#F8F5EE", "#38BDF8"],
  personality: "bold, raw, energetic and direct",
  peopleAndSetting: "ทีมงานในออฟฟิศ", // retired field — must be ignored by v3
  memorableCues: ["วงกลมฟ้า", "ลูกศร marker"], // retired field — must be ignored by v3
  visualNotes: "",
};

// ---------------------------------------------------------------------------
// Three stories. Each script is a full Thai faceless-creator short (~60–90s
// spoken), written Hook / Explain / Close so the three visual beats map 1:1
// onto the three narration segments below.
// ---------------------------------------------------------------------------

type ProofPackBeat = {
  phase: VisualBeatPhase;
  contentDomain: string;
  treatment: string;
  visualBeat: Omit<VisualBeat, "phase">;
};

type ProofPackStory = {
  id: string;
  titleTh: string;
  /** Full Thai narration, split into the same three phases as the visual beats. */
  scriptTh: { hook: string; explain: string; close: string };
  beats: readonly [ProofPackBeat, ProofPackBeat, ProofPackBeat];
};

const STORIES: readonly ProofPackStory[] = [
  {
    // (a) Regression case — Mew's shipped video on this topic produced only
    // office/meeting-room frames. Every visual beat below is coastal/weather
    // content; none of them mention an office, meeting or team.
    id: "cyclone",
    titleTh: "ทำไมพายุไซโคลนถึงถล่มบ้านริมทะเลได้ในไม่กี่ชั่วโมง",
    scriptTh: {
      hook:
        "ลองจินตนาการว่าเช้าวันหนึ่งฟ้าใสที่คุณเห็นทุกวัน กลับกลายเป็นสีดำมืดครึ้มภายในไม่กี่ชั่วโมง " +
        "คลื่นที่เคยซัดเบา ๆ ริมหาด กลายเป็นกำแพงน้ำสูงเท่าตึกสองชั้น กวาดเข้าหาฝั่งอย่างไม่ปรานี " +
        "นี่ไม่ใช่ฉากในหนัง แต่คือสิ่งที่เกิดขึ้นจริงกับหมู่บ้านชาวประมงริมทะเลทุกครั้งที่พายุไซโคลนก่อตัวขึ้นกลางทะเล",
      explain:
        "พายุไซโคลนสะสมพลังงานจากน้ำทะเลที่อุ่นจัด ยิ่งน้ำอุ่นนานเท่าไหร่ พายุก็ยิ่งหมุนแรงและขยายตัวเร็วขึ้นเท่านั้น " +
        "พอเคลื่อนตัวเข้าใกล้ฝั่ง แรงลมจะดันมวลน้ำทะเลให้สูงขึ้นกลายเป็น \"คลื่นพายุซัดฝั่ง\" ที่ท่วมบ้านเรือนได้ " +
        "ก่อนที่ลมแรงจะพัดหลังคาปลิวเสียอีก นี่คือเหตุผลที่ชาวบ้านริมทะเลต้องรีบมัดเชือกยึดเรือให้แน่น " +
        "วางกระสอบทรายกั้นหน้าประตู และขนของมีค่าขึ้นที่สูงทันทีที่ได้ยินประกาศเตือนภัยแรก ๆ " +
        "เพราะเมื่อพายุมาถึง เวลาจะเหลือน้อยกว่าที่คิดมาก",
      close:
        "ทุกนาทีก่อนพายุขึ้นฝั่งมีค่ามากกว่าที่คุณคิด ถ้าคุณอยู่ในพื้นที่เสี่ยงชายฝั่ง เตรียมกระเป๋าฉุกเฉินไว้ล่วงหน้า " +
        "ชาร์จมือถือให้เต็ม และติดตามประกาศจากกรมอุตุนิยมวิทยาอย่างใกล้ชิด เพราะความพร้อมที่คุณลงมือทำวันนี้ " +
        "อาจเป็นสิ่งเดียวที่ปกป้องบ้านและคนที่คุณรักได้ในวันพรุ่งนี้",
    },
    beats: [
      {
        phase: "hook",
        contentDomain: "extreme weather and cyclone preparedness in a Thai coastal fishing town",
        treatment: "urgent, cinematic and overwhelming in scale",
        visualBeat: {
          subject: "a towering cyclone wall of dark storm cloud and driving rain rolling over open water",
          action: "the storm wall advances toward the shoreline as wind visibly bends the treeline and whips up sea spray",
          setting: "an open coastal horizon off a Thai fishing town, with no structures in the foreground",
          emotion: "awe mixed with dread",
          emphasis: "the sheer scale of the approaching storm dominating the frame",
        },
      },
      {
        phase: "explain",
        contentDomain: "extreme weather and cyclone preparedness in a Thai coastal fishing town",
        treatment: "calm, determined and grounded in practical action",
        visualBeat: {
          subject: "a pair of hands stacking sandbags against a wooden doorway",
          action: "each sandbag is pressed firmly into place as loose shutters rattle in the rising wind outside",
          setting: "the doorway of a stilted Thai coastal house with the storm visibly approaching over the water behind it",
          emotion: "calm, determined focus",
          emphasis: "the direct link between preparing now and the household staying safe once the storm makes landfall",
        },
      },
      {
        phase: "close",
        contentDomain: "extreme weather and cyclone preparedness in a Thai coastal fishing town",
        treatment: "hard-won calm and quiet readiness",
        visualBeat: {
          subject: "a Thai coastal resident standing at the railing of a stilted house, looking out over the secured shoreline",
          action: "steps back from the railing with arms crossed in quiet resolve as the storm looms on the darkening horizon",
          setting: "the elevated porch of a stilted coastal house facing the open sea",
          emotion: "hard-won calm and readiness",
          emphasis: "the resident's readiness against the storm now bearing down on the coast",
        },
      },
    ],
  },
  {
    id: "finance",
    titleTh: "เงินเดือนหมดก่อนสิ้นเดือนทุกที? กฎ 3 ซองเปลี่ยนชีวิตการเงินคุณ",
    scriptTh: {
      hook:
        "เดือนนี้เพิ่งผ่านมาแค่ครึ่งทาง แต่เปิดแอปธนาคารมาเจอตัวเลขที่เหลือน้อยจนใจหาย " +
        "ธนบัตรใบสุดท้ายในกระเป๋าตังค์แทบไม่พอค่าข้าวมื้อเย็น ถ้าคุณเคยรู้สึกแบบนี้ทุกสิ้นเดือน คุณไม่ได้อยู่คนเดียว " +
        "และมีวิธีง่าย ๆ ที่จะหยุดวงจรนี้ได้จริง",
      explain:
        "กฎ 3 ซองทำงานง่ายมาก พอเงินเดือนเข้า ให้แบ่งเป็นสามซองทันที ซองแรกสำหรับค่าใช้จ่ายจำเป็นอย่างค่าเช่าและค่าน้ำค่าไฟ " +
        "ซองที่สองสำหรับใช้จ่ายในชีวิตประจำวันแบบมีลิมิต และซองที่สามกันไว้เป็นเงินออมที่ห้ามแตะเด็ดขาด " +
        "เมื่อเงินในซองไหนหมด แปลว่าต้องหยุดใช้ในหมวดนั้นจนกว่าจะถึงรอบเงินเดือนใหม่ วิธีนี้ทำให้คุณเห็นภาพรวมการเงินชัดเจนตั้งแต่ต้นเดือน " +
        "แทนที่จะมารู้ตัวว่าเงินหมดตอนปลายเดือนเหมือนเคย",
      close:
        "ลองเริ่มกฎ 3 ซองตั้งแต่เงินเดือนรอบหน้า แล้วดูยอดเงินออมของคุณค่อย ๆ เพิ่มขึ้นทุกเดือน " +
        "ความมั่นคงทางการเงินไม่ได้เริ่มจากรายได้ที่มากขึ้น แต่เริ่มจากวินัยเล็ก ๆ ที่คุณทำซ้ำทุกเดือนต่างหาก",
    },
    beats: [
      {
        phase: "hook",
        contentDomain: "personal finance and monthly budgeting for a Thai freelancer",
        treatment: "anxious, intimate and quietly tense",
        visualBeat: {
          subject: "an open wallet with only a few crumpled banknotes left inside, beside a phone showing a low bank balance",
          action: "the last banknote is pulled halfway out of the wallet as the phone screen glows with the low balance",
          setting: "a small kitchen table lit by early morning window light",
          emotion: "quiet financial anxiety",
          emphasis: "the gap between what's left in the wallet and what the rest of the month still demands",
        },
      },
      {
        phase: "explain",
        contentDomain: "personal finance and monthly budgeting for a Thai freelancer",
        treatment: "clear, methodical and reassuring",
        visualBeat: {
          subject: "a pair of hands dividing cash between three labeled paper envelopes on a table",
          action: "one banknote at a time is placed into each envelope in turn, splitting the stack evenly",
          setting: "a home desk with a notebook and a calculator resting nearby",
          emotion: "methodical clarity",
          emphasis: "the direct relationship between splitting income upfront and staying in control of spending",
        },
      },
      {
        phase: "close",
        contentDomain: "personal finance and monthly budgeting for a Thai freelancer",
        treatment: "optimistic, warm and quietly triumphant",
        visualBeat: {
          subject: "a young Thai woman sealing a glass savings jar and setting it on a shelf beside a small stack of bills",
          action: "she presses the lid closed and steps back with a satisfied smile",
          setting: "a tidy home shelf lit by warm evening light",
          emotion: "quiet pride and momentum",
          emphasis: "the visible, growing progress toward a savings cushion",
        },
      },
    ],
  },
  {
    id: "health",
    titleTh: "นั่งทำงานทั้งวันจนปวดหลัง? ท่ายืดตัว 3 นาทีที่ช่วยได้จริง",
    scriptTh: {
      hook:
        "นั่งทำงานมาทั้งวัน จู่ ๆ ก็รู้สึกปวดร้าวที่หลังส่วนล่างจนต้องเอามือกดไว้ ไหล่ห่อลงมาโดยไม่รู้ตัว " +
        "และคอเริ่มตึงจนหันซ้ายขวาลำบาก ถ้าอาการนี้เกิดกับคุณแทบทุกบ่าย นั่นเป็นสัญญาณที่ร่างกายกำลังบอกว่าคุณนั่งอยู่ในท่าเดิมนานเกินไปแล้ว",
      explain:
        "ท่ายืดที่ช่วยได้จริงใช้เวลาแค่สามนาที เริ่มจากบิดลำตัวช้า ๆ ไปด้านข้างขณะนั่ง มือหนึ่งจับพนักเก้าอี้เพื่อพยุงตัว " +
        "ค้างไว้สิบวินาทีแล้วสลับข้าง ท่านี้ช่วยคลายกล้ามเนื้อรอบแนวกระดูกสันหลังที่ตึงจากการนั่งนิ่งนาน ๆ " +
        "ต่อด้วยการยืนขึ้น ยืดแขนทั้งสองข้างขึ้นเหนือศีรษะพร้อมหายใจเข้าลึก ๆ แล้วค่อย ๆ ผ่อนหายใจออกพร้อมปล่อยไหล่ลง " +
        "ทำแบบนี้ทุกชั่วโมงจะช่วยลดอาการปวดสะสมได้มาก",
      close:
        "ลุกขึ้นยืดตัวตอนนี้เลยก็ยังทัน แค่สามนาทีทุกชั่วโมง หลังของคุณจะขอบคุณในระยะยาว " +
        "และคุณจะทำงานต่อได้อย่างสบายตัวมากขึ้นตลอดทั้งวัน",
    },
    beats: [
      {
        phase: "hook",
        contentDomain: "desk posture and lower-back health for a Thai remote worker",
        treatment: "weary, heavy and uncomfortable",
        visualBeat: {
          subject: "a person's hand pressed against their own lower back in visible discomfort",
          action: "the hand rubs the lower back slowly as the shoulders slump forward",
          setting: "a home desk late in the day with a laptop screen glowing in low light",
          emotion: "mounting physical fatigue",
          emphasis: "the tension visibly built up in the lower back after a long day seated",
        },
      },
      {
        phase: "explain",
        contentDomain: "desk posture and lower-back health for a Thai remote worker",
        treatment: "focused, calm and instructional",
        visualBeat: {
          subject: "a person demonstrating a seated spinal twist stretch, one hand braced on the back of their chair",
          action: "the torso rotates slowly to one side while the braced hand provides support",
          setting: "a bright home desk beside a window",
          emotion: "focused relief",
          emphasis: "the exact stretching motion that releases tension along the spine",
        },
      },
      {
        phase: "close",
        contentDomain: "desk posture and lower-back health for a Thai remote worker",
        treatment: "refreshed, light and energized",
        visualBeat: {
          subject: "a person standing up from their desk chair, rolling their shoulders back with relaxed posture",
          action: "stretches both arms overhead and exhales visibly with relief",
          setting: "a bright home desk with the chair pushed back",
          emotion: "renewed energy and lightness",
          emphasis: "the immediate physical relief carrying forward into the rest of the day",
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Compile all 9 prompts.
// ---------------------------------------------------------------------------

type ProofPackCase = {
  id: string; // `${storyId}-${phase}`
  storyId: string;
  storyTitleTh: string;
  scriptTh: string;
  phase: VisualBeatPhase;
  seed: number;
  compiled: CompiledBrandVisualPrompt;
};

const PHASE_LABEL: Record<VisualBeatPhase, string> = { hook: "Hook", explain: "Explain", close: "Close" };
const SEED_BASE = 2026081000;

function buildCases(): ProofPackCase[] {
  const cases: ProofPackCase[] = [];
  STORIES.forEach((story, storyIndex) => {
    story.beats.forEach((beat, phaseIndex) => {
      const compiled = compileBrandVisualPrompt({
        visualFormatId: MEWSOCIAL_VISUAL_FORMAT_ID,
        contentDomain: beat.contentDomain,
        treatment: beat.treatment,
        visualBeat: { ...beat.visualBeat, phase: beat.phase },
        brandVisualLanguage: MEWSOCIAL_BRAND,
      });
      cases.push({
        id: `${story.id}-${beat.phase}`,
        storyId: story.id,
        storyTitleTh: story.titleTh,
        scriptTh: story.scriptTh[beat.phase],
        phase: beat.phase,
        seed: SEED_BASE + storyIndex * 3 + phaseIndex + 1,
        compiled,
      });
    });
  });
  return cases;
}

// ---------------------------------------------------------------------------
// Self-check — mirrors the plan's explicit acceptance checks, run automatically
// on every dry-run so a defect surfaces immediately instead of only on eyeball
// review.
// ---------------------------------------------------------------------------

const FORBIDDEN_PHRASES = [
  "circular motif",
  "solid unmarked disc",
  "plain empty solid color fields",
  "Repeat the visual cues",
  "People and places follow",
] as const;
const OFFICE_LANGUAGE = /\boffice\b|\bmeeting room\b|ออฟฟิศ|ประชุม/i;
const WEATHER_LANGUAGE = /storm|cyclone|wind|rain|cloud|wave|sea|coast|water|weather/i;
const COLOR_GRADE_MARKER = "The overall color grade favors";
const COLOR_GRADE_PATTERN = /The overall color grade favors ([^.]+)\./;

/** Sentence tokens shared by the story-boundary + palette-bound checks below.
 * `compileBrandVisualPromptV3` always emits ". "-joined sentences, so this is
 * a safe split for a v3-compiled positive prompt (asserted separately). */
function sentences(positive: string): string[] {
  return positive.replace(/\.$/, "").split(". ");
}

const SCENE_SENTENCE_PREFIXES = ["For a story about ", "Shape the scene with a "];

function runSelfCheck(cases: ProofPackCase[]): { pass: boolean; lines: string[] } {
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
    else ok(`${item.id}: no forbidden A1/A2/A4/A5 phrases`);

    if (item.storyId === "cyclone") {
      if (OFFICE_LANGUAGE.test(positive)) fail(`${item.id}: cyclone prompt contains office/meeting-room language`);
      else ok(`${item.id}: no office/meeting-room language`);
    }

    // NEW — the palette must still resolve to a real, non-empty color-grade
    // clause under Task 1's tightened vocabulary bound. Mew's palette
    // (black / warm white / sky blue #38BDF8) must not be silently dropped.
    const gradeMatch = COLOR_GRADE_PATTERN.exec(positive);
    if (!positive.includes(COLOR_GRADE_MARKER) || !gradeMatch || !gradeMatch[1].trim()) {
      fail(`${item.id}: palette produced NO color-grade clause (bounded vocabulary silently dropped the brand palette)`);
    } else {
      ok(`${item.id}: color-grade clause present — "${gradeMatch[1].trim()}"`);
    }
  }

  const cycloneHook = cases.find((item) => item.id === "cyclone-hook")!;
  if (!WEATHER_LANGUAGE.test(cycloneHook.compiled.positive)) {
    fail("cyclone-hook: positive prompt does not genuinely describe weather");
  } else {
    ok("cyclone-hook: positive prompt genuinely describes weather");
  }

  // NEW — the three stories must be clearly distinguishable in scene content
  // while sharing one palette/lighting/lens/format signature. Every sentence
  // in a v3-compiled positive prompt is fixed except the two scene sentences
  // ("For a story about ..." and "Shape the scene with a ... feeling"), so the
  // remaining sentence set must be byte-identical across all 9 cases, and the
  // two scene sentences must differ pairwise across the three stories (same
  // phase compared to same phase).
  const nonSceneSignatures = new Set(
    cases.map((item) => JSON.stringify(
      sentences(item.compiled.positive).filter(
        (sentence) => !SCENE_SENTENCE_PREFIXES.some((prefix) => sentence.startsWith(prefix)),
      ),
    )),
  );
  if (nonSceneSignatures.size !== 1) {
    fail(`shared signature: the non-scene sentences differ across cases (expected one shared signature, found ${nonSceneSignatures.size})`);
  } else {
    ok("shared signature: all 9 prompts share one identical palette/lighting/lens/format signature outside the scene sentences");
  }

  for (const phase of ["hook", "explain", "close"] as const) {
    const bySid = new Map(cases.filter((item) => item.phase === phase).map((item) => [item.storyId, item]));
    const storyIds = [...bySid.keys()];
    for (let i = 0; i < storyIds.length; i += 1) {
      for (let j = i + 1; j < storyIds.length; j += 1) {
        const a = bySid.get(storyIds[i])!;
        const b = bySid.get(storyIds[j])!;
        const sceneA = sentences(a.compiled.positive).filter((s) => SCENE_SENTENCE_PREFIXES.some((p) => s.startsWith(p))).join(". ");
        const sceneB = sentences(b.compiled.positive).filter((s) => SCENE_SENTENCE_PREFIXES.some((p) => s.startsWith(p))).join(". ");
        if (sceneA === sceneB) {
          fail(`${a.id} vs ${b.id}: scene content is identical — stories are not distinguishable`);
        } else {
          ok(`${a.id} vs ${b.id}: scene content differs`);
        }
      }
    }
  }

  return { pass, lines };
}

// ---------------------------------------------------------------------------
// Dry-run output: artifacts/brand-visual-fix-2026-08-10/prompts.md
// ---------------------------------------------------------------------------

function writePromptsMarkdown(cases: ProofPackCase[]): void {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const sections: string[] = [
    "# Brand Visual Proof Pack — compiled prompts",
    "",
    `Generated ${new Date().toISOString()} by scripts/brand-visual-proof-pack.ts --dry-run.`,
    "No network calls were made to produce this file.",
    "",
    `Visual Format: ${MEWSOCIAL_VISUAL_FORMAT_ID} (recipe ${cases[0]?.compiled.recipeVersion ?? "?"})`,
    "",
    "Brand payload used for all 9 prompts (mewsocial-representative, including the two retired",
    "fields deliberately set to their real shipped-bug values to prove v3 ignores them):",
    "",
    "```json",
    JSON.stringify(MEWSOCIAL_BRAND, null, 2),
    "```",
    "",
  ];
  for (const story of STORIES) {
    sections.push(`## ${story.titleTh} (\`${story.id}\`)`, "");
    for (const phase of ["hook", "explain", "close"] as const) {
      const item = cases.find((candidate) => candidate.id === `${story.id}-${phase}`)!;
      const beat = story.beats.find((candidate) => candidate.phase === phase)!;
      sections.push(
        `### ${PHASE_LABEL[phase]} — \`${item.id}\``,
        "",
        `**บทพูด (script segment):** ${item.scriptTh}`,
        "",
        `**contentDomain:** ${beat.contentDomain}`,
        `**treatment:** ${beat.treatment}`,
        `**seed:** ${item.seed}`,
        "",
        "**Positive prompt:**",
        "```",
        item.compiled.positive,
        "```",
        "",
        "**Negative prompt:**",
        "```",
        item.compiled.negative,
        "```",
        "",
      );
    }
  }
  fs.writeFileSync(PROMPTS_PATH, sections.join("\n"));
  console.log(`wrote ${PROMPTS_PATH}`);
}

// ---------------------------------------------------------------------------
// --generate: real RunPod Z-Image path (same protocol as
// scripts/run-brand-visual-quality-gate.ts). Resumable: an existing image file
// on disk for a case id is skipped without any provider call.
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

function existingBeforePath(storyId: string): string | null {
  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = path.join(BEFORE_ROOT, `${storyId}-before${extension}`);
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

async function generateOne(apiKey: string, item: ProofPackCase): Promise<string> {
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
        negativePrompt: item.compiled.negative,
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildIndexHtml(cases: ProofPackCase[]): string {
  const rows = STORIES.map((story) => {
    const beforePath = existingBeforePath(story.id);
    const beforeCell = beforePath
      ? `<img src="${escapeHtml(path.relative(OUTPUT_ROOT, beforePath))}" alt="${escapeHtml(story.titleTh)} — before" />`
      : `<div class="empty-slot">รอ Mew ใส่ภาพ before<br/>(วางไฟล์ที่ before/${story.id}-before.png)</div>`;
    const cells = (["hook", "explain", "close"] as const).map((phase) => {
      const item = cases.find((candidate) => candidate.id === `${story.id}-${phase}`)!;
      const imagePath = existingImagePath(item.id);
      const imageCell = imagePath
        ? `<img src="${escapeHtml(path.relative(OUTPUT_ROOT, imagePath))}" alt="${escapeHtml(item.id)}" />`
        : `<div class="empty-slot">ยังไม่ได้เจน<br/>(รัน --generate)</div>`;
      return `
        <td>
          <div class="cell-label">${PHASE_LABEL[phase]}</div>
          ${imageCell}
          <pre class="prompt">${escapeHtml(item.compiled.positive)}</pre>
        </td>`;
    }).join("\n");
    return `
      <tr>
        <th>
          <div class="story-title">${escapeHtml(story.titleTh)}</div>
          <div class="cell-label">ก่อนแก้ (before)</div>
          ${beforeCell}
        </th>
        ${cells}
      </tr>`;
  }).join("\n");

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<title>Brand Visual Proof Pack — 2026-08-10</title>
<style>
  body { font-family: -apple-system, "Noto Sans Thai", sans-serif; margin: 24px; color: #151515; background: #fff; }
  h1 { font-size: 20px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 1px solid #ddd; padding: 10px; vertical-align: top; width: 24%; }
  th { width: 22%; background: #fafafa; }
  img { max-width: 100%; height: auto; border-radius: 4px; display: block; margin-bottom: 8px; }
  .cell-label { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin-bottom: 6px; }
  .story-title { font-weight: 700; font-size: 14px; margin-bottom: 10px; }
  .empty-slot { border: 1px dashed #bbb; border-radius: 4px; padding: 24px 8px; text-align: center; font-size: 12px; color: #888; margin-bottom: 8px; }
  .prompt { max-height: 140px; overflow-y: auto; font-size: 11px; line-height: 1.4; background: #f6f6f6; padding: 8px; border-radius: 4px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>Brand Visual Proof Pack — 3 stories × Hook/Explain/Close</h1>
  <p>Visual Format: ${escapeHtml(MEWSOCIAL_VISUAL_FORMAT_ID)} · Generated ${new Date().toISOString()}</p>
  <table>
    ${rows}
  </table>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const cases = buildCases();
  writePromptsMarkdown(cases);

  console.log("");
  console.log("=== Compiled prompts ===");
  for (const item of cases) {
    console.log(`\n--- ${item.id} (${item.compiled.recipeVersion}) ---`);
    console.log(`POSITIVE: ${item.compiled.positive}`);
    console.log(`NEGATIVE: ${item.compiled.negative}`);
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
  fs.mkdirSync(BEFORE_ROOT, { recursive: true });

  let failures = 0;
  for (const item of cases) {
    try {
      await generateOne(apiKey, item);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${item.id}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const html = buildIndexHtml(cases);
  fs.writeFileSync(INDEX_PATH, html);
  console.log(`wrote ${INDEX_PATH}`);

  const completed = cases.filter((item) => existingImagePath(item.id)).length;
  console.log(`brand_visual_proof_pack completed=${completed}/9 failed=${failures}`);
  if (completed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "brand-visual-proof-pack failed");
  process.exit(1);
});
