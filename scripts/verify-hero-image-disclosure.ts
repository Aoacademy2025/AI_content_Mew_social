// Verification for Task 5 (P0 disclosure UX): every credit spend is disclosed BEFORE it
// happens, defaults are budget-safe, and running out of credits leads to a top-up CTA.
// Run: npx tsx scripts/verify-hero-image-disclosure.ts
//
// Two layers, matching the established verify-* pattern:
//   1. Pure-function unit tests for the new estimate.ts helpers (heroDefaultTargetClipCount,
//      heroHoldLengthSec) — these carry the actual math, so they get real assertions.
//   2. Static regex checks over the three edited components, pinning: no hardcoded hero
//      price digits (everything derives from HERO_AI_IMAGE_CREDITS), the default-8 logic,
//      the eligibility gate, the receipt's deficit-disables-render wiring, and the
//      EditorV2Shell INSUFFICIENT_CREDITS/RATE_LIMITED → CTA view mapping.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  heroDefaultTargetClipCount,
  heroHoldLengthSec,
  disclosedAutoMixAiImageCount,
} from "../src/app/(dashboard)/video-editor/_v2/estimate";
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

check("selecting Hero AI Image defaults an unset count to 8 via the shared helper",
  /if \(value === "kie-image"\) \{[\s\S]{0,500}heroDefaultTargetClipCount\(p\.targetClipCount\)/.test(step2));
check("the admin Hero AI Image card applies the same default on selection",
  /if \(o\.value === "kie-image"\) p\.setTargetClipCount\(heroDefaultTargetClipCount\(p\.targetClipCount\)\)/.test(step2));
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

// ── 6. Static checks — EditorV2Shell.tsx ─────────────────────────────────────
const shellPath = "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx";
const shell = readFileSync(shellPath, "utf8");

check("FailedView detects the INSUFFICIENT_CREDITS marker robustly (code or message text)",
  /INSUFFICIENT_CREDITS_MARKER = \/INSUFFICIENT_CREDITS\|เครดิตไม่พอ\//.test(shell)
    && shell.includes("INSUFFICIENT_CREDITS_MARKER.test(failureText)"));
check("FailedView detects the RATE_LIMITED marker",
  /RATE_LIMITED_MARKER = \/RATE_LIMITED\//.test(shell)
    && shell.includes("RATE_LIMITED_MARKER.test(failureText)"));
check("insufficient-credits view shows the pinned heading + explanation copy",
  shell.includes('"เครดิต AI ไม่พอ"')
    && shell.includes("งานนี้ต้องใช้เครดิตมากกว่าที่มีอยู่ ระบบไม่หักเครดิตส่วนที่ไม่สำเร็จ — เติมเครดิตหรือลดจำนวนรูปแล้วลองใหม่"));
check("insufficient-credits view offers เติมเครดิต (/pricing?from=editor) plus the existing back CTA",
  /isInsufficientCredits \? \([\s\S]{0,300}href="\/pricing\?from=editor"[\s\S]{0,200}เติมเครดิต[\s\S]{0,300}onClick=\{onBack\}/.test(shell));
check("rate-limited view shows the pinned heading and falls back to the server's own message",
  shell.includes('"ถึงเพดานการเจนรูปชั่วคราว"')
    && /const body = isInsufficientCredits[\s\S]{0,40}\?[\s\S]{0,200}: job\.errorMessage/.test(shell));
check("rate-limited failures keep only the existing back button (no extra CTA branch)",
  /isRateLimited/.test(shell) && !/isRateLimited \? \(/.test(shell));

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll hero-image disclosure checks passed.");
