import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  autoHeadlineHookDurationMs,
  clampHeadlineHookCenterPercent,
  createDefaultHeadlineHook,
  headlineHookDraftFragment,
  headlineHookFontCssFamily,
  headlineHookEndFrame,
  headlineHookFontSizes,
  headlineHookFontWeights,
  headlineHookOffsetPercent,
  normalizeHeadlineHook,
  normalizeHeadlineHookDraft,
  normalizeHeadlineHookSuggestions,
  visibleCaptionRangeAfterHeadline,
} from "@/lib/headline-hook";
import { createEditorProjectAutosaveCandidate } from "@/lib/editor-project-autosave-lineage";
import { headlineHookMotionAt } from "@/remotion/HeadlineHookView";
import {
  DEFAULT_V2_SUB,
  buildV2BurnConfig,
  type V2Caption,
} from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";

assert.equal(autoHeadlineHookDurationMs(20_000), 5_000);
assert.equal(autoHeadlineHookDurationMs(29_000), 7_250);
assert.equal(autoHeadlineHookDurationMs(30_000), 10_000);
assert.equal(autoHeadlineHookDurationMs(90_000), 15_000);
assert.equal(autoHeadlineHookDurationMs(180_000), 20_000);

const normalized = normalizeHeadlineHook({
  enabled: true,
  headline: "  เมืองไทย\nกำลังเปลี่ยน?\nบรรทัดเกิน  ",
  subheadline: "  เข้าใจประเด็น   แม้ปิดเสียง  ",
  durationMs: 99_000,
  preset: "not-a-preset",
  topPercent: -10,
  fontFamily: "Prompt",
  fontSize: 84,
  fontWeight: 600,
  subheadlineFontSize: 48,
}, 60_000);
assert.deepEqual(normalized, {
  enabled: true,
  headline: "เมืองไทย\nกำลังเปลี่ยน?",
  subheadline: "เข้าใจประเด็น แม้ปิดเสียง",
  durationMs: 20_000,
  preset: "viral",
  topPercent: 10,
  fontFamily: "Prompt",
  fontSize: 84,
  fontWeight: 600,
  subheadlineFontSize: 48,
});

assert.equal(normalizeHeadlineHook({ enabled: true, headline: "" }, 60_000)?.enabled, false);
assert.equal(normalizeHeadlineHook(null), null);
assert.equal(
  normalizeHeadlineHookDraft({ enabled: true, headline: "พิมพ์คำถัดไป " }, 60_000)?.headline,
  "พิมพ์คำถัดไป ",
  "controlled headline draft preserves the trailing space needed to type the next word",
);
const headlineAfterMiddleSpace = "คำแรก  คำสอง";
assert.equal(
  normalizeHeadlineHookDraft({ enabled: true, headline: headlineAfterMiddleSpace }, 60_000)?.headline,
  headlineAfterMiddleSpace,
  "controlled headline draft must not rewrite a space inserted at the caret and move it to the sentence end",
);
assert.equal(
  normalizeHeadlineHook({ enabled: true, headline: headlineAfterMiddleSpace }, 60_000)?.headline,
  "คำแรก คำสอง",
  "persisted/rendered headline still canonicalizes repeated draft whitespace",
);
assert.equal(
  normalizeHeadlineHook({ enabled: true, headline: "พิมพ์คำถัดไป " }, 60_000)?.headline,
  "พิมพ์คำถัดไป",
  "persisted/rendered headline remains normalized",
);
assert.equal(headlineHookFontCssFamily("Prompt"), "'Prompt', 'Noto Sans Thai', sans-serif");
assert.deepEqual(headlineHookFontSizes("หัวข้อ", 84), { headline: 84, subheadline: 52 });
assert.deepEqual(headlineHookFontSizes("หัวข้อ", 84, 64), { headline: 84, subheadline: 64 });
assert.deepEqual(headlineHookFontWeights(undefined), { headline: 900, subheadline: 800 });
assert.deepEqual(headlineHookFontWeights(400), { headline: 400, subheadline: 400 });
assert.deepEqual(headlineHookFontWeights(600), { headline: 600, subheadline: 600 });
const guardedTypography = normalizeHeadlineHook({
  enabled: true,
  headline: "ทดสอบขอบเขต",
  fontFamily: "Comic Sans",
  fontSize: 999,
  fontWeight: 500,
  subheadlineFontSize: 999,
})!;
assert.equal(guardedTypography.fontFamily, undefined);
assert.equal(guardedTypography.fontSize, 120);
assert.equal(guardedTypography.fontWeight, undefined);
assert.equal(guardedTypography.subheadlineFontSize, 88);

const generatedDefault = createDefaultHeadlineHook(
  "นี่คือประเด็นแรกที่ต้องรู้! ประโยคถัดไปไม่ควรถูกนำมาใช้",
  45_000,
);
assert.equal(generatedDefault.enabled, true);
assert.equal(generatedDefault.headline, "นี่คือประเด็นแรกที่ต้องรู้!");
assert.equal(generatedDefault.durationMs, 10_000);

const hook = normalizeHeadlineHook({
  enabled: true,
  headline: "Headline",
  durationMs: 10_000,
  preset: "news",
  topPercent: 20,
  fontFamily: "Prompt",
  fontSize: 84,
}, 60_000)!;

const setupDraft = {
  script: "สคริปต์ที่กำลังแก้ไข",
  ...headlineHookDraftFragment(undefined),
};
assert.equal(Object.hasOwn(setupDraft, "headlineHook"), false);
assert.ok(createEditorProjectAutosaveCandidate({
  projectId: "headline-hook-setup-draft",
  revision: 0,
  draft: setupDraft,
}), "setup draft without a configured headline must remain autosave-safe");

const configuredDraft = {
  script: "สคริปต์ที่กำลังแก้ไข",
  ...headlineHookDraftFragment(hook),
};
assert.deepEqual(configuredDraft.headlineHook, hook);
assert.ok(createEditorProjectAutosaveCandidate({
  projectId: "headline-hook-configured-draft",
  revision: 0,
  draft: configuredDraft,
}), "configured headline draft must remain autosave-safe");

assert.equal(visibleCaptionRangeAfterHeadline({ startMs: 0, endMs: 4_000 }, hook, 60_000), null);
assert.deepEqual(
  visibleCaptionRangeAfterHeadline({ startMs: 8_000, endMs: 12_000 }, hook, 60_000),
  { startMs: 10_000, endMs: 12_000 },
);
assert.deepEqual(
  visibleCaptionRangeAfterHeadline({ startMs: 14_000, endMs: 18_000 }, hook, 60_000),
  { startMs: 14_000, endMs: 18_000 },
);
assert.equal(headlineHookEndFrame(hook, 30, 1_800), 300);

const suggestions = normalizeHeadlineHookSuggestions({
  suggestions: [
    { headline: "คำถามเดียวกัน", subheadline: "แบบแรก" },
    { headline: "คำถามเดียวกัน", subheadline: "ซ้ำ" },
    { headline: "มุมขัดแย้ง" },
    { headline: "ผลกระทบต่อคนดู" },
    { headline: "ตัวเลือกเกิน" },
  ],
});
assert.deepEqual(suggestions, [
  { headline: "คำถามเดียวกัน", subheadline: "แบบแรก" },
  { headline: "มุมขัดแย้ง" },
  { headline: "ผลกระทบต่อคนดู" },
]);

const captions: V2Caption[] = [
  { text: "ซับแรก", startMs: 0, endMs: 4_000, tag: "hook" },
  { text: "ซับคร่อม", startMs: 8_000, endMs: 12_000, tag: "body" },
  { text: "ซับหลังพาดหัว", startMs: 14_000, endMs: 18_000, tag: "body" },
];
const burn = buildV2BurnConfig(
  "https://example.com/video.mp4",
  captions,
  60_000,
  DEFAULT_V2_SUB,
  30,
  {},
  undefined,
  undefined,
  hook,
);
assert.deepEqual(burn.headlineHook, hook);
assert.deepEqual(burn.keywordPopups.map((popup) => [popup.start, popup.end]), [
  [0, 120],
  [240, 360],
  [420, 540],
]);
assert.deepEqual(captions.map((caption) => [caption.startMs, caption.endMs]), [
  [0, 4_000],
  [8_000, 12_000],
  [14_000, 18_000],
]);

assert.equal(headlineHookMotionAt(0, 10_000).opacity, 0);
assert.equal(headlineHookMotionAt(240, 10_000).opacity, 1);
assert.equal(headlineHookMotionAt(5_000, 10_000).opacity, 1);
assert.ok(headlineHookMotionAt(9_900, 10_000).opacity < 1);

const controlsSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/HeadlineHookControls.tsx",
  "utf8",
);
assert.match(controlsSource, /aria-label="ตั้งค่าขั้นสูงของพาดหัว"/);
assert.match(controlsSource, /aria-label="ฟอนต์พาดหัว"/);
assert.match(controlsSource, /aria-label="ขนาดพาดหัว"/);
assert.match(controlsSource, /aria-label="น้ำหนักตัวอักษรพาดหัว"/);
assert.match(controlsSource, /aria-label="ขนาดบรรทัดเสริม"/);
const postPhaseEditorSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
  "utf8",
);
assert.match(
  postPhaseEditorSource,
  /const next = normalizeHeadlineHookDraft\(/,
  "the controlled input path must use the whitespace-preserving draft normalizer",
);

// ── EP5 #13: anchor + offset (top/bottom, px or %) ──────────────────────────────────────────

// Old headlines with none of the new fields render exactly as today: same shape, same 10–42
// clamp, no anchor/offsetPercent keys at all.
const legacyOnly = normalizeHeadlineHook({ enabled: true, headline: "เดิม", topPercent: 25 }, 60_000)!;
assert.equal(Object.hasOwn(legacyOnly, "anchor"), false);
assert.equal(Object.hasOwn(legacyOnly, "offsetPercent"), false);
assert.equal(legacyOnly.topPercent, 25);

// anchor "bottom" + offsetPercent: measured from the bottom edge, converted to the same
// top-from-center `topPercent` the renderer reads, then clamped off the (default) subtitle band.
const bottomNearEdge = normalizeHeadlineHook({
  enabled: true,
  headline: "ล่างสุด",
  anchor: "bottom",
  offsetPercent: 0,
}, 60_000)!;
assert.equal(bottomNearEdge.anchor, "bottom");
assert.equal(
  bottomNearEdge.topPercent,
  clampHeadlineHookCenterPercent(100, "bottom"),
  "flush-bottom request is clamped off the safe area + default subtitle band",
);
assert.ok(bottomNearEdge.topPercent < 70, "must not overlap the default subtitle band near 82%");

// offsetPx (px of the 1080×1920 canvas) converts to the same result as the equivalent %.
const halfwayByPx = normalizeHeadlineHook({
  enabled: true,
  headline: "กลางจอ",
  anchor: "bottom",
  offsetPx: 960, // 50%
}, 60_000)!;
const halfwayByPercent = normalizeHeadlineHook({
  enabled: true,
  headline: "กลางจอ",
  anchor: "bottom",
  offsetPercent: 50,
}, 60_000)!;
assert.equal(halfwayByPx.topPercent, halfwayByPercent.topPercent);
assert.equal(halfwayByPx.offsetPercent, 50);

// Both offsetPx and offsetPercent given: offsetPx wins (documented in the MCP tool schema).
const bothUnits = normalizeHeadlineHook({
  enabled: true,
  headline: "ทั้งคู่",
  anchor: "top",
  offsetPx: 384, // 20%, inside the safe area so the clamp does not also intervene
  offsetPercent: 80,
}, 60_000)!;
assert.equal(bothUnits.offsetPercent, 20);

// A headline anchored "top" is pushed below a subtitle band that has moved near the top instead
// of its default near-bottom position — the clamp reacts to the REAL subtitle position, not a
// hard-coded assumption that subtitles are always at the bottom.
const pushedBelowTopSubtitles = normalizeHeadlineHook({
  enabled: true,
  headline: "ดันลง",
  anchor: "top",
  offsetPercent: 20,
}, 60_000, 15)!;
assert.ok(
  pushedBelowTopSubtitles.topPercent > 29,
  `expected the headline pushed clear of a subtitle band at 15%, got ${pushedBelowTopSubtitles.topPercent}`,
);

// headlineHookOffsetPercent reads the same number back regardless of representation.
assert.equal(headlineHookOffsetPercent(legacyOnly), 25);
assert.equal(headlineHookOffsetPercent(bottomNearEdge), 100 - bottomNearEdge.topPercent);

// The draft normalizer forwards the subtitle position too, and keeps the same whitespace-safe
// headline/subheadline handling it always had.
const bottomDraft = normalizeHeadlineHookDraft({
  enabled: true,
  headline: "กำลังพิมพ์ ",
  anchor: "bottom",
  offsetPercent: 20,
}, 60_000, 15)!;
assert.equal(bottomDraft.headline, "กำลังพิมพ์ ");
assert.equal(bottomDraft.anchor, "bottom");

// The Remotion overlay must still read the single resolved `topPercent` field directly — the
// anchor/offset resolution happens entirely in normalizeHeadlineHook, so the render layer needs
// no anchor-awareness of its own.
const overlaySource = readFileSync("src/remotion/HeadlineHookOverlay.tsx", "utf8");
assert.match(
  overlaySource,
  /top: `\$\{hook\.topPercent\}%`/,
  "HeadlineHookOverlay must position from the resolved topPercent (anchor/offset already baked in)",
);

const headlineControlsSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/HeadlineHookControls.tsx",
  "utf8",
);
assert.match(headlineControlsSource, /อ้างอิงตำแหน่งจากขอบ/, "controls must expose the new anchor toggle");

console.log("headline-hook: all checks passed");
