import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  autoHeadlineHookDurationMs,
  createDefaultHeadlineHook,
  headlineHookDraftFragment,
  headlineHookFontCssFamily,
  headlineHookEndFrame,
  headlineHookFontSizes,
  normalizeHeadlineHook,
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
});

assert.equal(normalizeHeadlineHook({ enabled: true, headline: "" }, 60_000)?.enabled, false);
assert.equal(normalizeHeadlineHook(null), null);
assert.equal(headlineHookFontCssFamily("Prompt"), "'Prompt', 'Noto Sans Thai', sans-serif");
assert.deepEqual(headlineHookFontSizes("หัวข้อ", 84), { headline: 84, subheadline: 52 });
const guardedTypography = normalizeHeadlineHook({
  enabled: true,
  headline: "ทดสอบขอบเขต",
  fontFamily: "Comic Sans",
  fontSize: 999,
})!;
assert.equal(guardedTypography.fontFamily, undefined);
assert.equal(guardedTypography.fontSize, 120);

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

console.log("headline-hook: all checks passed");
