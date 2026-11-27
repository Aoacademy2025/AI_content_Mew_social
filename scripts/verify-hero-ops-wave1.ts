/**
 * Verification suite for HERO Studio Ops Wave 1:
 * - HERO-130: Instant PromptPay / monthly fallback on failed/canceled annual checkouts
 * - HERO-133: Flagship Motion B-Roll presets in Step 1 Starter & Styled Templates
 * - HERO-131: Bounded 3-script Hero Script sample quota for Conversion Trial + Step 1 handoff
 * - HERO-98: Post-export social scheduling handoff to app.heroaiengine.com + Weekly Series seed
 * - HERO-132: Fuzzy partial-word salvage on elided particles (incomplete_alignment fix)
 * - HERO-46: Synchronous SyncLane saveStatus batching + ref guard to prevent React #185
 * - HERO-58 / HERO-53: Parallel B-roll asset probing, worker bundle warm-read & draft fetch guard
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveAnnualCheckoutFallback } from "../src/lib/pricing-period-method";
import {
  FLAGSHIP_MOTION_STEP1_PRESETS,
  findFlagshipMotionPreset,
} from "../src/lib/video-template-apply";
import { isActiveStylePackId } from "../src/lib/style-pack-catalog";
import { isMotionThemeId } from "../src/lib/motion-broll-catalog";
import {
  buildHeroSocialHandoffUrl,
  buildSocialPostCaptionPack,
  buildWeeklySeriesHref,
  HERO_AI_SOCIAL_SCHEDULER_URL,
  HERO_AI_VIDEO_HANDOFF_URL,
  resolveStudioHandoffVideoUrl,
} from "../src/lib/social-post-handoff";
import { alignTranscriptWordsToSourceDetailed } from "../src/lib/mcp/subtitle-quality";
import { buildPartialAlignmentClock } from "../src/lib/mcp/partial-alignment";
import { prepareBrollRenderAssets } from "../src/lib/broll-coverage";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (!cond) {
    throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
  passed += 1;
  console.log(`✓ ${label}`);
}

async function main() {
  console.log("\n[1] HERO-130 — Annual Checkout PromptPay & Monthly Fallback");
  {
    const ctxOff = { promptpayMonthlyEnabled: false, monthlyOffered: { PRO: false, BUSINESS: false } };
    const ctxOn = { promptpayMonthlyEnabled: true, monthlyOffered: { PRO: true, BUSINESS: false } };

    const annualCard = resolveAnnualCheckoutFallback(
      {
        paymentResult: "cancelled",
        cancelReturn: { plan: "PRO", period: "annual", method: "card" },
      },
      ctxOn,
    );
    check(
      "canceled annual+card offers annual PromptPay AND 30d PromptPay monthly fallback when PRO offered",
      annualCard?.reason === "cancelled_annual_card"
        && annualCard.offerAnnualPromptpay === true
        && annualCard.monthlyFallbackMethod === "promptpay",
      JSON.stringify(annualCard),
    );

    const annualPromptpay = resolveAnnualCheckoutFallback(
      {
        paymentResult: "cancelled",
        cancelReturn: { plan: "BUSINESS", period: "annual", method: "promptpay" },
      },
      ctxOn,
    );
    check(
      "canceled annual+promptpay offers monthly card fallback when tier monthly PromptPay is off",
      annualPromptpay?.reason === "cancelled_annual_promptpay"
        && annualPromptpay.offerAnnualPromptpay === false
        && annualPromptpay.monthlyFallbackMethod === "card",
      JSON.stringify(annualPromptpay),
    );

    const genericCancel = resolveAnnualCheckoutFallback(
      {
        paymentResult: "cancelled",
        cancelReturn: {},
      },
      ctxOff,
    );
    check(
      "bare ?payment=cancelled still surfaces immediate annual PromptPay + monthly card fallback",
      genericCancel?.reason === "cancelled_generic"
        && genericCancel.plan === "PRO"
        && genericCancel.offerAnnualPromptpay === true
        && genericCancel.monthlyFallbackMethod === "card",
      JSON.stringify(genericCancel),
    );

    const monthlyCancel = resolveAnnualCheckoutFallback(
      {
        paymentResult: "cancelled",
        cancelReturn: { plan: "PRO", period: "monthly", method: "card" },
      },
      ctxOn,
    );
    check("monthly cancel does not trigger annual fallback", monthlyCancel === null);

    const recovery = resolveAnnualCheckoutFallback(
      {
        paymentResult: null,
        acquisitionSource: "checkout_recovery",
        preferredPeriod: "annual",
        cancelReturn: { plan: "BUSINESS" },
      },
      ctxOff,
    );
    check(
      "HERO-111 checkout_recovery source surfaces inline PromptPay + monthly fallback",
      recovery?.reason === "checkout_recovery" && recovery.plan === "BUSINESS",
      JSON.stringify(recovery),
    );
  }

  console.log("\n[2] HERO-133 — Flagship Motion B-Roll Presets in Step 1");
  {
    check("exactly 3 flagship Motion presets defined", FLAGSHIP_MOTION_STEP1_PRESETS.length === 3);
    const themeIds = FLAGSHIP_MOTION_STEP1_PRESETS.map((p) => p.motionThemeId);
    check(
      "covers paper-cutout-doc, social-chat-sim, apple-bento-glass",
      JSON.stringify(themeIds) === JSON.stringify(["paper-cutout-doc", "social-chat-sim", "apple-bento-glass"]),
    );
    for (const preset of FLAGSHIP_MOTION_STEP1_PRESETS) {
      check(
        `${preset.id} pairs valid MotionThemeId + ActiveStylePackId + >=4-line Thai starter script`,
        isMotionThemeId(preset.motionThemeId)
          && isActiveStylePackId(preset.templateId)
          && preset.sampleScript.split("\n").length >= 4
          && findFlagshipMotionPreset(preset.motionThemeId)?.id === preset.id,
      );
    }
    const step1Src = read("src/app/(dashboard)/video-editor/_v2/Step1Script.tsx");
    check("Step1Script renders Flagship Motion presets in template strip", step1Src.includes("data-motion-preset-id={preset.motionThemeId}"));
    check("Step1Script renders Flagship Motion starters in empty-state strip", step1Src.includes("step1-motion-starter-"));
    const projectSrc = read("src/app/(dashboard)/video-editor/_v2/useV2Project.ts");
    check(
      "resetProject clears motionThemeId and motionMascot",
      projectSrc.includes("setMotionThemeIdRaw(null);") && projectSrc.includes("setMotionMascotRaw(null);"),
    );
  }

  console.log("\n[3] HERO-131 — Bounded 3-Script Trial Sample Quota");
  {
    const heroServerSrc = read("src/lib/hero-script.server.ts");
    check(
      "HERO_SCRIPT_TRIAL_GENERATIONS is bounded to 3",
      /export const HERO_SCRIPT_TRIAL_GENERATIONS = 3;/.test(heroServerSrc),
    );
    const rolloutSrc = read("src/lib/hero-script-rollout.server.ts");
    check(
      "hero-script-rollout admits genuine Conversion Trial into cohort 'trial' and respects trialSampleEnabled kill-switch",
      rolloutSrc.includes("conversionTrial && flags.trialSampleEnabled !== false")
        && rolloutSrc.includes('cohort: "trial"')
        && rolloutSrc.includes("user.trialStartedAt")
        && rolloutSrc.includes("user.trialEndsAt"),
    );
    const mcpScriptSrc = read("src/lib/mcp/brand-script-tools.ts");
    check(
      "MCP generate_hero_script keeps trial cohort gated with payment_required",
      mcpScriptSrc.includes('access.cohort === "trial"'),
    );
  }

  console.log("\n[4] HERO-98 — Post-Export Social Handoff & Weekly Content Series");
  {
    const pack = buildSocialPostCaptionPack({
      title: "โปรเจกต์ทดสอบ",
      headline: "3 เทคนิคปิดการขายไว",
      script: "3 เทคนิคปิดการขายไว\nข้อแรก ตอบแชตให้เร็วภายใน 5 นาที\nข้อสอง สรุปราคาให้ชัดเจน",
    });
    check(
      "buildSocialPostCaptionPack extracts hook, deduplicated body lines, and hashtags",
      pack.hookLine === "3 เทคนิคปิดการขายไว"
        && pack.bodySummary.includes("ข้อแรก")
        && !pack.bodySummary.startsWith("3 เทคนิคปิดการขายไว")
        && pack.captionText.includes("#HeroAI"),
      JSON.stringify(pack),
    );
    const seriesHref = buildWeeklySeriesHref({ script: "วิธีเพิ่มยอดวิวคลิปสั้น\nเนื้อหา" });
    check(
      "buildWeeklySeriesHref encodes seriesSeed into /hero-script",
      seriesHref.startsWith("/hero-script?seriesSeed=")
        && decodeURIComponent(seriesHref).includes("วิธีเพิ่มยอดวิวคลิปสั้น"),
      seriesHref,
    );
    check(
      "HERO_AI_SOCIAL_SCHEDULER_URL targets app.heroaiengine.com with attribution",
      HERO_AI_SOCIAL_SCHEDULER_URL.startsWith("https://app.heroaiengine.com/?utm_source=hero_studio"),
    );
    const directUrlRaw = buildHeroSocialHandoffUrl({
      videoUrl: "/api/renders/export-hero98.mp4",
      title: "โปรเจกต์ทดสอบ",
      headline: "3 เทคนิคปิดการขายไว",
      script: "3 เทคนิคปิดการขายไว\nข้อแรก ตอบแชตให้เร็วภายใน 5 นาที\nข้อสอง สรุปราคาให้ชัดเจน",
      durationSec: 42.6,
    });
    const directParsed = new URL(directUrlRaw);
    check(
      "buildHeroSocialHandoffUrl resolves relative /api/renders/... to studio.heroaiengine.com and sets metadata",
      directParsed.origin + directParsed.pathname === HERO_AI_VIDEO_HANDOFF_URL
        && directParsed.searchParams.get("videoUrl") === "https://studio.heroaiengine.com/api/renders/export-hero98.mp4"
        && directParsed.searchParams.get("headline") === "3 เทคนิคปิดการขายไว"
        && directParsed.searchParams.get("title") === "โปรเจกต์ทดสอบ"
        && directParsed.searchParams.get("durationSec") === "43"
        && (directParsed.searchParams.get("caption") ?? "").includes("#HeroAI"),
      directUrlRaw,
    );
    check(
      "resolveStudioHandoffVideoUrl accepts media.heroaiengine.com HTTPS renders",
      resolveStudioHandoffVideoUrl("https://media.heroaiengine.com/renders/clip-1.mp4#t=0.1")
        === "https://media.heroaiengine.com/renders/clip-1.mp4",
    );
    check(
      "buildHeroSocialHandoffUrl safely falls back on empty, insecure, external-host, or non-render URLs",
      buildHeroSocialHandoffUrl({ videoUrl: "" }) === HERO_AI_SOCIAL_SCHEDULER_URL
        && buildHeroSocialHandoffUrl({ videoUrl: "http://studio.heroaiengine.com/api/renders/a.mp4" }) === HERO_AI_SOCIAL_SCHEDULER_URL
        && buildHeroSocialHandoffUrl({ videoUrl: "https://evil.example.com/api/renders/a.mp4" }) === HERO_AI_SOCIAL_SCHEDULER_URL
        && buildHeroSocialHandoffUrl({ videoUrl: "//evil.example.com/api/renders/a.mp4" }) === HERO_AI_SOCIAL_SCHEDULER_URL
        && buildHeroSocialHandoffUrl({ videoUrl: "https://studio.heroaiengine.com/pricing" }) === HERO_AI_SOCIAL_SCHEDULER_URL,
    );
    const hugeThaiLine = "เทคนิคปั้นช่องคลิปสั้นขายดีด้วยระบบอัตโนมัติสำหรับครีเอเตอร์ไทยยุคใหม่".repeat(25);
    const hugeScript = `${hugeThaiLine}\n${hugeThaiLine}\n${hugeThaiLine}\n${hugeThaiLine}`;
    const hugePack = buildSocialPostCaptionPack({
      title: hugeThaiLine,
      headline: hugeThaiLine,
      script: hugeScript,
    });
    const hugeHandoffUrl = buildHeroSocialHandoffUrl({
      videoUrl: "/renders/very-long-thai-script-export.mp4",
      title: hugeThaiLine,
      headline: hugeThaiLine,
      script: hugeScript,
      durationSec: 90,
    });
    check(
      "very long Thai script + title + headline keeps handoff URL <= 3500 chars (< 4000) while preserving full clipboard pack",
      hugeHandoffUrl.startsWith(`${HERO_AI_VIDEO_HANDOFF_URL}?`)
        && hugeHandoffUrl.length <= 3500
        && hugePack.captionText.length > 1000,
      `len=${hugeHandoffUrl.length}`,
    );
    for (const rel of [
      "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx",
      "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx",
      "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx",
      "src/app/(dashboard)/videos/page.tsx",
    ]) {
      const src = read(rel);
      check(
        `${rel} wires buildHeroSocialHandoffUrl and HERO_AI_SOCIAL_SCHEDULER_URL`,
        src.includes("buildHeroSocialHandoffUrl") && src.includes("HERO_AI_SOCIAL_SCHEDULER_URL"),
      );
    }
    const videosSrc = read("src/app/(dashboard)/videos/page.tsx");
    check(
      "videos/page.tsx wires buildHeroSocialHandoffUrl on both desktop hover and mobile touch bars",
      (videosSrc.match(/buildHeroSocialHandoffUrl\(/g) ?? []).length >= 2,
    );
  }

  console.log("\n[5] HERO-132 — Fuzzy Partial-Word Salvage on Elided Particles");
  {
    const phrases = [
      "สวัสดี", "ครับ", "วันนี้", "เรา", "จะ", "มา", "สรุป", "เทคนิค", "การ", "ทำ",
      "คลิป", "สั้น", "ให้", "คน", "ดู", "จบ", "นะ", "ครับ", "ด้วย", "วิธี",
      "ง่าย", "มาก", "ที่", "ใคร", "ก็", "เริ่ม", "ทำ", "ตาม", "ได้", "ทันที",
    ];
    const fullText = phrases.join(" ");
    // Word index 2 ("วันนี้" -> "วันนี") triggers fuzzy alignment instead of exact,
    // and word index 16 ("นะ") is elided by TTS/ASR so mapped.length === 0 on 1/30 words.
    const transcriptWords = phrases
      .map((word, idx) => ({
        word: idx === 2 ? "วันนี" : word,
        startMs: idx * 400,
        endMs: idx * 400 + 320,
        idx,
      }))
      .filter((item) => item.idx !== 16)
      .map(({ word, startMs, endMs }) => ({ word, startMs, endMs }));

    const detailed = alignTranscriptWordsToSourceDetailed(fullText, transcriptWords);
    check(
      "fuzzy incomplete_alignment preserves measured partialWords across the whole script (>=28 words)",
      detailed.status === "failed"
        && detailed.code === "incomplete_alignment"
        && (detailed.partialWords?.length ?? 0) >= 28,
      JSON.stringify({ status: detailed.status, code: detailed.status === "failed" ? detailed.code : null, count: detailed.status === "failed" ? detailed.partialWords?.length : 0 }),
    );
    const salvaged = buildPartialAlignmentClock({
      fullText,
      measuredWords: detailed.status === "failed" ? (detailed.partialWords ?? []) : [],
      audioDurationMs: 30 * 400 + 200,
    });
    check(
      "buildPartialAlignmentClock salvages >95% fuzzy-aligned words and spans the 1 elided particle",
      salvaged !== null && salvaged.coverage > 0.95 && salvaged.words.length >= 30,
      JSON.stringify({ coverage: salvaged?.coverage, words: salvaged?.words.length }),
    );
  }

  console.log("\n[6] HERO-46 — Synchronous SyncLane saveStatus Batching & Ref Guard");
  {
    const projectSrc = read("src/app/(dashboard)/video-editor/_v2/useV2Project.ts");
    check(
      "saveStatus is guarded by saveStatusRef to prevent redundant DefaultLane updates",
      projectSrc.includes("if (saveStatusRef.current === next) return;"),
    );
    check(
      "stageExplicitUserDraftMutation synchronously sets saveStatus('saving') on user mutation",
      /stageExplicitUserDraftMutation[\s\S]{0,1600}setSaveStatus\("saving"\)/.test(projectSrc),
    );
    check(
      "passive autosave useEffect only calls setSaveStatus('saving') on explicit save retry",
      projectSrc.includes('if (hasSaveRetry) setSaveStatus("saving");'),
    );
  }

  console.log("\n[7] HERO-58 & HERO-53 — Parallel Asset Probing & Conditional Draft Fetch");
  {
    let activeProbes = 0;
    let maxConcurrentProbes = 0;
    const assets = Array.from({ length: 8 }, (_, idx) => ({
      src: `/api/stocks/clip-${idx}.mp4`,
      start: idx * 2,
      end: (idx + 1) * 2,
      sourceIndex: idx,
    }));
    await prepareBrollRenderAssets(assets, 16, 30, {
      resolveAsset: (src) => ({ src, localPath: `/fake${src}` }),
      isUsableLocalFile: () => true,
      probeDurationSec: async () => {
        activeProbes += 1;
        maxConcurrentProbes = Math.max(maxConcurrentProbes, activeProbes);
        await new Promise((r) => setTimeout(r, 25));
        activeProbes -= 1;
        return 5;
      },
    });
    check(
      "prepareBrollRenderAssets probes unique local files concurrently (bounded concurrency = 4)",
      maxConcurrentProbes >= 2 && maxConcurrentProbes <= 4,
      `maxConcurrentProbes=${maxConcurrentProbes}`,
    );
    assert.equal(activeProbes, 0);

    const pendingHookSrc = read("src/app/(dashboard)/video-editor/_v2/usePendingEditDraft.ts");
    check(
      "usePendingEditDraft skips duplicate GET /api/editor-projects/:id when activeJobId is null",
      pendingHookSrc.includes("if (!projectId || !activeJobId)"),
    );
    const renderWorkerSrc = read("scripts/render-worker.ts");
    check(
      "render-worker hydrates warm bundle location from readRenderWorkerBundle",
      renderWorkerSrc.includes("readRenderWorkerBundle(fp)"),
    );
  }

  console.log(`\n✅ ALL ${passed} HERO OPS WAVE 1 CHECKS PASSED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
