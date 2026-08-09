// Verification for Task 5 (P0 disclosure UX): every credit spend is disclosed BEFORE it
// happens, defaults are budget-safe, and running out of credits leads to a top-up CTA.
// Run: npx tsx scripts/verify-hero-image-disclosure.ts
//
// Two layers, matching the established verify-* pattern:
//   1. Pure-function unit tests for the new estimate.ts helpers (heroDefaultTargetClipCount,
//      heroHoldLengthSec) and the new failure-view.ts classifier (classifyFailure,
//      failureViewCopy) — these carry the actual decision math, so they get real
//      fixture-based assertions, including the Tier-1 regression fixture (a prefixed
//      code like OMNIVOICE_PROVIDER_RATE_LIMITED must NOT classify as rate-limited).
//   2. Static regex checks over the edited components, pinning: no hardcoded hero price
//      digits (everything derives from HERO_AI_IMAGE_CREDITS), the default-8 logic and
//      its heroCountTouched guard at both call sites, the eligibility gate, the receipt's
//      deficit-disables-render wiring, and the EditorV2Shell → failure-view.ts wiring.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  heroDefaultTargetClipCount,
  heroHoldLengthSec,
  disclosedAutoMixAiImageCount,
} from "../src/app/(dashboard)/video-editor/_v2/estimate";
import { classifyFailure, failureViewCopy, type FailureJobLike } from "../src/app/(dashboard)/video-editor/_v2/failure-view";
import { HERO_AI_IMAGE_CREDITS } from "../src/lib/credit-costs";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── 1. heroDefaultTargetClipCount — PURE ────────────────────────────────────
check("default: 0 (unset) → 8", heroDefaultTargetClipCount(0) === 8);
check("default: negative (defensive) → 8", heroDefaultTargetClipCount(-1) === 8);
check("default: NaN (defensive) → 8", heroDefaultTargetClipCount(NaN) === 8);
check("default: existing custom count (5) is left untouched", heroDefaultTargetClipCount(5) === 5);
check("default: floors a fractional existing count", heroDefaultTargetClipCount(5.9) === 5);
check("trial taste: unset count defaults to 5 (10 credits / 2 per image)", heroDefaultTargetClipCount(0, true) === 5);
check("trial taste: an existing custom count is never overwritten", heroDefaultTargetClipCount(3, true) === 3);

// ── 2. heroHoldLengthSec — PURE ──────────────────────────────────────────────
check("hold: 60s / 8 รูป → 8 วิ", heroHoldLengthSec(60, 8) === 8, String(heroHoldLengthSec(60, 8)));
check("hold: 120s / 8 รูป → 15 วิ (exceeds the 12s hint threshold)", heroHoldLengthSec(120, 8) === 15);
check("hold: n = 0 → 0 (no divide-by-zero)", heroHoldLengthSec(60, 0) === 0);
check("hold: negative duration (defensive) → 0", heroHoldLengthSec(-1, 8) === 0);
check("hold: rounds to nearest second", heroHoldLengthSec(50, 8) === 6, String(heroHoldLengthSec(50, 8))); // 6.25 → 6

// ── 3. disclosedAutoMixAiImageCount stays the single source (Task 5 item 4 reuses it) ──
const recoWeights = { video: 3, photo: 2, ai: 1 };
const manualCount = disclosedAutoMixAiImageCount(600, recoWeights, 6);
check("disclosed count honors an explicit manual piece count over the duration estimate",
  manualCount === 1, `n=${manualCount}`); // matches verify-render-receipt.ts case O2

// ── 3b. classifyFailure / failureViewCopy — PURE (Tier-1 fast-follow: exact-code match) ──
const job = (over: Partial<FailureJobLike>): FailureJobLike =>
  ({ errorCode: null, errorMessage: null, errorProvider: null, ...over });

check("code INSUFFICIENT_CREDITS classifies as insufficient-credits",
  classifyFailure(job({ errorCode: "INSUFFICIENT_CREDITS" })) === "insufficient-credits");
check("code RATE_LIMITED classifies as rate-limited (the image-cap view)",
  classifyFailure(job({ errorCode: "RATE_LIMITED" })) === "rate-limited");
// The Tier-1 regression this fixture guards: OMNIVOICE_PROVIDER_RATE_LIMITED (Hero Voice
// TTS throttle, hero-voice-generation.server.ts:333) contains "RATE_LIMITED" as a
// substring and must NOT be misread as the image-generation rate cap.
check("code OMNIVOICE_PROVIDER_RATE_LIMITED (Hero Voice throttle) classifies as generic, NOT rate-limited",
  classifyFailure(job({ errorCode: "OMNIVOICE_PROVIDER_RATE_LIMITED", errorMessage: "เสียงพากย์ติดโควต้าชั่วคราว" })) === "generic");
check("a generic voice failure never shows the image-cap heading",
  failureViewCopy(classifyFailure(job({ errorCode: "OMNIVOICE_PROVIDER_RATE_LIMITED" })), job({ errorCode: "OMNIVOICE_PROVIDER_RATE_LIMITED" }), false).heading
    !== "ถึงเพดานการเจนรูปชั่วคราว");
check("heygen quota (provider+code pair) takes priority over any credits/rate code",
  classifyFailure(job({ errorProvider: "heygen", errorCode: "quota" })) === "heygen-quota");
check("insufficient-credits wins over rate-limited when (hypothetically) both markers are present",
  classifyFailure(job({ errorCode: "INSUFFICIENT_CREDITS", errorMessage: "RATE_LIMITED also present" })) === "insufficient-credits");
check("message-only เครดิตไม่พอ fallback still classifies as insufficient-credits when code is missing",
  classifyFailure(job({ errorCode: null, errorMessage: "เครดิตไม่พอสำหรับ Hero AI Image 5 ฉาก" })) === "insufficient-credits");
check("an unrelated generic failure keeps the plain render/export heading",
  failureViewCopy(classifyFailure(job({ errorMessage: "some other failure" })), job({ errorMessage: "some other failure" }), false).heading === "เรนเดอร์ไม่สำเร็จ");
check("insufficient-credits heading + body are pinned",
  failureViewCopy("insufficient-credits", job({}), false).heading === "เครดิต AI ไม่พอ"
    && failureViewCopy("insufficient-credits", job({}), false).body
      === "งานนี้ต้องใช้เครดิตมากกว่าที่มีอยู่ ระบบไม่หักเครดิตส่วนที่ไม่สำเร็จ — เติมเครดิตหรือลดจำนวนรูปแล้วลองใหม่");
check("rate-limited body falls back to the server's own (dynamic retry-after) message",
  failureViewCopy("rate-limited", job({ errorMessage: "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~120 วินาที" }), false).body
    === "Hero AI Image ใช้ครบโควต้าต่อชั่วโมงแล้ว ลองใหม่ได้ในอีก ~120 วินาที");

// ── 4. Static checks — Step2Elements.tsx ────────────────────────────────────
const step2Path = "src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx";
const step2 = readFileSync(step2Path, "utf8");

check("no hardcoded hero price literal — every credit figure interpolates HERO_AI_IMAGE_CREDITS",
  !new RegExp(`${HERO_AI_IMAGE_CREDITS} เครดิต`).test(step2));
check("imports the shared credit-costs constant instead of a literal",
  /import\s*\{\s*HERO_AI_IMAGE_CREDITS\s*\}\s*from\s*["']@\/lib\/credit-costs["']/.test(step2));

check("Hero AI Image + AutoMix cards unlock via the public-launch eligibility helper",
  step2.includes("const heroImageUnlocked = p.heroAiImageEligible")
    && step2.includes("const autoMixUnlocked = p.heroAiImageEligible"));
check("locked cards use the pinned อัปเกรด badge + PRO/BUSINESS tooltip copy",
  step2.includes('const HERO_UPGRADE_BADGE = "อัปเกรด"')
    && step2.includes('const HERO_UPGRADE_TITLE = "Hero AI Image ใช้ได้กับแผน PRO/BUSINESS"'));

check("selecting Hero AI Image uses the shared trial-aware default helper",
  /if \(value === "kie-image"\) \{[\s\S]{0,500}heroDefaultTargetClipCount\(p\.targetClipCount, p\.isActiveTrial\)/.test(step2));
check("the admin Hero AI Image card applies the same default on selection",
  /if \(o\.value === "kie-image" && !p\.heroCountTouched\) \{[\s\S]{0,180}heroDefaultTargetClipCount\(p\.targetClipCount, p\.isActiveTrial\)/.test(step2));
// Fast-follow fix: the default-8 must NOT re-fire once the user has touched the count
// control themselves (would otherwise clobber an explicit "อัตโนมัติ" choice on re-select).
// Pin the guard at BOTH call sites — customer selectSource() and the admin card onClick.
check("customer selectSource() guards the trial-aware default with !p.heroCountTouched",
  /if \(!p\.heroCountTouched\) p\.setTargetClipCount\(heroDefaultTargetClipCount\(p\.targetClipCount, p\.isActiveTrial\)\)/.test(step2));
check("admin card onClick guards the trial-aware default with !p.heroCountTouched",
  step2.includes('if (o.value === "kie-image" && !p.heroCountTouched) {'));
check("programmatic default calls never mark heroCountTouched themselves (must stay idempotent on re-selection)",
  !/heroDefaultTargetClipCount\(p\.targetClipCount, p\.isActiveTrial\)\)[\s\S]{0,40}p\.setHeroCountTouched/.test(step2));
check("the count Segmented control marks heroCountTouched on any direct user interaction (incl. picking อัตโนมัติ)",
  /onChange=\{\(v\) => \{[\s\S]{0,400}p\.setHeroCountTouched\(true\)[\s\S]{0,150}p\.setTargetClipCount\(v === "auto"/.test(step2));
check("the custom-count number input marks heroCountTouched on direct user input",
  /onChange=\{\(e\) => \{[\s\S]{0,50}p\.setHeroCountTouched\(true\)[\s\S]{0,150}p\.setTargetClipCount\(Math\.max\(1, Math\.min\(60/.test(step2));
check("the custom-count option is labeled กำหนดจำนวนรูป (แนะนำ) in Hero AI Image mode",
  step2.includes('{ value: "custom", label: "กำหนดจำนวนรูป (แนะนำ)" }'));
check("the auto option discloses its projected count using the shared window estimate",
  /label: `อัตโนมัติ \(1 รูป\/ช่วง ≈ \$\{heroAutoProjectedCount\} รูป\)`/.test(step2)
    && step2.includes("estimateAutoMixAiImageCount(displaySec, { video: 0, photo: 0, ai: 1 })"));

check("custom-count total-price template matches n รูป × price = total",
  /\$\{p\.targetClipCount\} รูป × \$\{HERO_AI_IMAGE_CREDITS\} เครดิต = \$\{p\.targetClipCount \* HERO_AI_IMAGE_CREDITS\} เครดิต/.test(step2));
check("auto-mode total-price template matches ~n รูป ≈ ~total เครดิต",
  /~\{heroAutoProjectedCount\} รูป ≈ ~\{heroAutoProjectedCount \* HERO_AI_IMAGE_CREDITS\} เครดิต/.test(step2));
check("hold-length hint uses the shared pure helper and the >12s follow-up copy",
  step2.includes("heroHoldLengthSec(displaySec, p.targetClipCount)")
    && step2.includes("รูปละ ~{heroHoldSec} วิ")
    && step2.includes("ภาพค้างนาน — เพิ่มจำนวนรูปช่วยให้คลิปดูมีชีวิตขึ้น"));

check("AutoMix AI เด่น/แนะนำ preset price is computed from disclosedAutoMixAiImageCount × HERO_AI_IMAGE_CREDITS",
  /disclosedAutoMixAiImageCount\(durationSec, PRESET_WEIGHTS\[pr\.key\], p\.targetClipCount\)/.test(step2)
    && /aiCount \* HERO_AI_IMAGE_CREDITS/.test(step2));
check("the old hardcoded AutoMix แนะนำ range copy is gone",
  !step2.includes("~6–9 เครดิต/คลิป"));

check("admin Hero card description carries the same total-price info as the customer card",
  /o\.value === "kie-image"[\s\S]{0,200}เริ่มต้น \$\{heroDefaultN\} รูป × \$\{HERO_AI_IMAGE_CREDITS\} เครดิต/.test(step2));

// ── 5. Static checks — RenderReceiptDialog.tsx ───────────────────────────────
const receiptDialogPath = "src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx";
const receiptDialog = readFileSync(receiptDialogPath, "utf8");

check("the render CTA disables on a credit deficit (reuses the receipt's own insufficient line)",
  /const insufficientCredits = model\.lines\.some\(\(l\) => l\.key === "insufficient"\)/.test(receiptDialog)
    && /disabled=\{submitting \|\| insufficientCredits\}/.test(receiptDialog));
check("the disabled render CTA carries the deficit tooltip copy",
  receiptDialog.includes('"เครดิตไม่พอ — เติมเครดิตก่อนเริ่มเรนเดอร์"'));
check("a top-up CTA links to /pricing?from=editor when insufficient",
  /insufficientCredits &&[\s\S]{0,150}href="\/pricing\?from=editor"[\s\S]{0,500}เติมเครดิต/.test(receiptDialog));

// ── 6. Static checks — EditorV2Shell.tsx + failure-view.ts ──────────────────
const shellPath = "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx";
const shell = readFileSync(shellPath, "utf8");
const failureViewPath = "src/app/(dashboard)/video-editor/_v2/failure-view.ts";
const failureView = readFileSync(failureViewPath, "utf8");

check("FailedView delegates classification to the pure, unit-tested failure-view module",
  shell.includes('import { classifyFailure, failureViewCopy } from "./failure-view"')
    && shell.includes("const kind = classifyFailure(job)")
    && shell.includes("failureViewCopy(kind, job, exportMode)"));
check("classifyFailure matches error CODE exactly (never a substring over combined code+message text)",
  failureView.includes('job.errorCode === INSUFFICIENT_CREDITS_CODE')
    && failureView.includes('job.errorCode === RATE_LIMITED_CODE')
    && !/failureText/.test(failureView)); // the old combined-text variable must be gone
check("insufficient-credits view shows the pinned heading + explanation copy",
  failureView.includes('"เครดิต AI ไม่พอ"')
    && failureView.includes("งานนี้ต้องใช้เครดิตมากกว่าที่มีอยู่ ระบบไม่หักเครดิตส่วนที่ไม่สำเร็จ — เติมเครดิตหรือลดจำนวนรูปแล้วลองใหม่"));
check("insufficient-credits view offers เติมเครดิต (/pricing?from=editor) plus the existing back CTA",
  /isInsufficientCredits \? \([\s\S]{0,300}href="\/pricing\?from=editor"[\s\S]{0,200}เติมเครดิต[\s\S]{0,300}onClick=\{onBack\}/.test(shell));
check("rate-limited view's pinned heading falls back to the server's own dynamic message",
  failureView.includes('"ถึงเพดานการเจนรูปชั่วคราว"')
    && /kind === "rate-limited"[\s\S]{0,200}body: job\.errorMessage/.test(failureView));
check("rate-limited failures keep only the existing back button (no extra CTA branch — same JSX arm as generic failures)",
  !shell.includes('kind === "rate-limited" ? ('));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll hero-image disclosure checks passed.");
