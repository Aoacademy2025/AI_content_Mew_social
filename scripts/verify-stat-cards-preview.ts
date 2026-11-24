// Run: npm run verify:stat-cards-preview
// Regression test for HERO-117: Stat cards live editor preview parity with Remotion export,
// live match-count formatting on the toggle (zero-match vs multi-match), and desktop/mobile wiring.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  STAT_CARD_DEFAULT_TOP_PERCENT,
  STAT_CARD_ZERO_MATCH_HINT,
  findActiveStatCard,
  formatStatCardToggleStatus,
  planEditorStatCards,
  planStatCardsForCaptions,
} from "../src/lib/stat-cards";
import {
  headlineHookEndFrame,
  headlineHookEndMs,
  normalizeHeadlineHook,
} from "../src/lib/headline-hook";
import {
  StatCardBadge,
  statCardMotionAt,
  statCardPreviewElapsedMs,
} from "../src/remotion/StatCardView";
import {
  DEFAULT_V2_SUB,
  buildV2BurnConfig,
  type V2Caption,
  type V2SubConfig,
} from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import {
  StatCardPreview,
  StatCardToggleBadge,
  StatCardToggleHint,
} from "../src/app/(dashboard)/video-editor/_v2/StatCardPreview";

const FPS = 30;

/**
 * Mirrors SubtitleOverlayComposition's exact stat card planning logic from a burn config.
 */
function planRemotionExportStatCards(burn: ReturnType<typeof buildV2BurnConfig>, fps = FPS) {
  if (!burn.subtitleStatCards) return [];
  const hookEndFrame = headlineHookEndFrame(burn.headlineHook, fps, burn.durationInFrames);
  const accentColor = burn.subtitleAccentColor ?? "#FFE500";
  return planStatCardsForCaptions(
    burn.keywordPopups.map((popup) => ({
      text: popup.text,
      startMs: (popup.start / fps) * 1000,
      endMs: (popup.end / fps) * 1000,
      tag: popup.tag,
    })),
    {
      enabled: true,
      headlineHookEndMs: (hookEndFrame / fps) * 1000,
      accentColor,
    },
  );
}

// ── 1. Planner parity between Editor preview and Remotion export ────────────────────────────
const captions: V2Caption[] = [
  { startMs: 0, endMs: 2_500, text: "ยอดขายโตขึ้น 200% ตั้งแต่ต้นคลิป", tag: "hook" },
  { startMs: 3_000, endMs: 5_500, text: "ยอดขายโตขึ้น 300% ในเดือนแรก", tag: "body" },
  { startMs: 6_000, endMs: 8_000, text: "ประหยัดค่าโฆษณา 45% ทันที", tag: "body" }, // inside 3s gap after 5500 -> skipped
  { startMs: 9_000, endMs: 11_500, text: "ลูกค้าเก่ากลับมาซื้อซ้ำ 5 เท่า", tag: "body" },
  { startMs: 15_000, endMs: 17_500, text: "ลดต้นทุนได้ 10,000 บาท ต่อเดือน", tag: "cta" },
];
const totalDurationMs = 18_000;
const headlineHook = normalizeHeadlineHook(
  {
    enabled: true,
    headline: "เคล็ดลับเพิ่มยอดขาย",
    durationMs: 3_000,
    preset: "viral",
    topPercent: 20,
  },
  totalDurationMs,
)!;
const enabledCfg: V2SubConfig = {
  ...DEFAULT_V2_SUB,
  statCards: true,
  accentColor: "#38BDF8",
  fontFamily: "'Prompt', sans-serif",
};

const suppressionEndMs = headlineHookEndMs(headlineHook, totalDurationMs);
assert.equal(suppressionEndMs, 3_000, "opening headline hook suppresses captions before 3000ms");

const editorPlan = planEditorStatCards({
  captions,
  enabled: Boolean(enabledCfg.statCards),
  subtitlesVisible: true,
  headlineHookEndMs: suppressionEndMs,
  accentColor: enabledCfg.accentColor,
});

const burnWithCards = buildV2BurnConfig(
  "https://example.com/base.mp4",
  captions,
  totalDurationMs,
  enabledCfg,
  FPS,
  {},
  undefined,
  { avatar: true, subtitles: true },
  headlineHook,
);
const remotionCards = planRemotionExportStatCards(burnWithCards, FPS);

assert.equal(editorPlan.activeCards.length, 3, "3 qualifying captions after opening headline hook and 3s gap");
assert.deepEqual(
  editorPlan.activeCards,
  remotionCards,
  "editor preview stat cards must match Remotion export stat cards identically",
);
assert.deepEqual(
  editorPlan.activeCards.map((c) => c.valueText),
  ["300%", "5เท่า", "10,000บาท"],
  "opening 200% card is suppressed by headlineHook and 45% card respects minGapMs",
);
assert.equal(editorPlan.activeCards[0]?.accentColor, "#38BDF8", "accentColor propagates to planned cards");

// Turning headline hook OFF immediately includes the opening 200% caption in BOTH preview and export
const disabledHook = { ...headlineHook, enabled: false };
const noHookSuppressionEndMs = headlineHookEndMs(disabledHook, totalDurationMs);
const editorPlanNoHook = planEditorStatCards({
  captions,
  enabled: true,
  subtitlesVisible: true,
  headlineHookEndMs: noHookSuppressionEndMs,
  accentColor: enabledCfg.accentColor,
});
const burnNoHook = buildV2BurnConfig(
  "https://example.com/base.mp4",
  captions,
  totalDurationMs,
  enabledCfg,
  FPS,
  {},
  undefined,
  { avatar: true, subtitles: true },
  disabledHook,
);
const remotionNoHook = planRemotionExportStatCards(burnNoHook, FPS);
assert.deepEqual(
  editorPlanNoHook.activeCards,
  remotionNoHook,
  "disabling headlineHook updates editor preview and Remotion export identically",
);
assert.equal(editorPlanNoHook.activeCards[0]?.valueText, "200%", "opening stat card activates when headline hook is off");
assert.equal(editorPlanNoHook.status.badgeText, `พบ ${remotionNoHook.length} จุด`);

// Extending headline hook duration to 6000ms suppresses both 200% and 300% identically
const longerHook = normalizeHeadlineHook({ ...headlineHook, durationMs: 6_000 }, totalDurationMs)!;
const editorPlanLongerHook = planEditorStatCards({
  captions,
  enabled: true,
  subtitlesVisible: true,
  headlineHookEndMs: headlineHookEndMs(longerHook, totalDurationMs),
  accentColor: enabledCfg.accentColor,
});
const burnLongerHook = buildV2BurnConfig(
  "https://example.com/base.mp4",
  captions,
  totalDurationMs,
  enabledCfg,
  FPS,
  {},
  undefined,
  { avatar: true, subtitles: true },
  longerHook,
);
assert.deepEqual(
  editorPlanLongerHook.activeCards,
  planRemotionExportStatCards(burnLongerHook, FPS),
  "changing headline hook duration keeps preview and export in exact parity",
);

// Toggle OFF keeps detectedCards/count live for toggle feedback while clearing activeCards & export flag
const disabledCfg: V2SubConfig = { ...enabledCfg, statCards: false };
const editorPlanToggleOff = planEditorStatCards({
  captions,
  enabled: false,
  subtitlesVisible: true,
  headlineHookEndMs: suppressionEndMs,
  accentColor: disabledCfg.accentColor,
});
const burnToggleOff = buildV2BurnConfig(
  "https://example.com/base.mp4",
  captions,
  totalDurationMs,
  disabledCfg,
  FPS,
  {},
  undefined,
  { avatar: true, subtitles: true },
  headlineHook,
);
assert.equal(editorPlanToggleOff.activeCards.length, 0, "preview renders no stat cards when toggle is off");
assert.equal(planRemotionExportStatCards(burnToggleOff, FPS).length, 0, "export renders no stat cards when toggle is off");
assert.equal(editorPlanToggleOff.detectedCards.length, 3, "live match count still reports 3 qualifying cards while toggle is off");
assert.equal(editorPlanToggleOff.status.badgeText, "พบ 3 จุด");

// Subtitle layer hidden suppresses stat cards in BOTH preview and export
const editorPlanSubtitlesHidden = planEditorStatCards({
  captions,
  enabled: true,
  subtitlesVisible: false,
  headlineHookEndMs: suppressionEndMs,
  accentColor: enabledCfg.accentColor,
});
const burnSubtitlesHidden = buildV2BurnConfig(
  "https://example.com/base.mp4",
  captions,
  totalDurationMs,
  enabledCfg,
  FPS,
  {},
  undefined,
  { avatar: true, subtitles: false },
  headlineHook,
);
assert.equal(editorPlanSubtitlesHidden.activeCards.length, 0, "preview suppresses stat cards when subtitles layer is hidden");
assert.equal(burnSubtitlesHidden.keywordPopups.length, 0, "burn omits popups when subtitles layer is hidden");
assert.equal(planRemotionExportStatCards(burnSubtitlesHidden, FPS).length, 0, "export produces 0 stat cards when subtitles layer is hidden");

// ── 2. Zero-match vs multi-match live count formatting & non-expansion guard ────────────────
const spelledOutThaiCaptions: V2Caption[] = [
  { startMs: 0, endMs: 2_500, text: "ยอดขายเติบโตสามเท่าในเจ็ดวัน", tag: "hook" },
  { startMs: 3_000, endMs: 5_500, text: "ประหยัดเวลาทำงานได้หลายชั่วโมงเลยครับ", tag: "body" },
  { startMs: 6_000, endMs: 8_500, text: "มี 3 เรื่องที่อยากแชร์ให้ทุกคนรู้", tag: "cta" }, // bare single digit ignored
];
const zeroMatchPlan = planEditorStatCards({
  captions: spelledOutThaiCaptions,
  enabled: true,
  subtitlesVisible: true,
  headlineHookEndMs: 0,
  accentColor: enabledCfg.accentColor,
});
assert.equal(zeroMatchPlan.detectedCards.length, 0, "spelled-out Thai words and bare single digits must not trigger stat cards");
assert.equal(zeroMatchPlan.activeCards.length, 0);
assert.deepEqual(zeroMatchPlan.status, {
  count: 0,
  hasMatches: false,
  badgeText: "ไม่พบตัวเลขในซับ",
  helperText: STAT_CARD_ZERO_MATCH_HINT,
});
assert.match(zeroMatchPlan.status.helperText ?? "", /300%/, "zero-match hint includes percentage example");
assert.match(zeroMatchPlan.status.helperText ?? "", /5 เท่า/, "zero-match hint includes multiplier example");
assert.match(zeroMatchPlan.status.helperText ?? "", /10,000 บาท/, "zero-match hint includes currency example");

const singleMatchStatus = formatStatCardToggleStatus(editorPlan.activeCards.slice(0, 1));
assert.deepEqual(singleMatchStatus, {
  count: 1,
  hasMatches: true,
  badgeText: "พบ 1 จุด",
  helperText: null,
});

const multiMatchStatus = formatStatCardToggleStatus(editorPlan.activeCards);
assert.deepEqual(multiMatchStatus, {
  count: 3,
  hasMatches: true,
  badgeText: "พบ 3 จุด",
  helperText: null,
});

// Live caption text edit flips zero-match -> 1 match immediately
const editedCaptions = spelledOutThaiCaptions.map((cap, idx) =>
  idx === 1 ? { ...cap, text: "ยอดขายโตขึ้น 300% ภายในเดือนเดียว" } : cap,
);
const afterEditPlan = planEditorStatCards({
  captions: editedCaptions,
  enabled: true,
  subtitlesVisible: true,
  headlineHookEndMs: 0,
  accentColor: enabledCfg.accentColor,
});
assert.equal(afterEditPlan.activeCards.length, 1);
assert.equal(afterEditPlan.status.badgeText, "พบ 1 จุด");
assert.equal(afterEditPlan.status.helperText, null);

// ── 3. Playback timing, paused visibility, and SSR preview markup parity ────────────────────
const firstCard = editorPlan.activeCards[0]!;
assert.equal(findActiveStatCard(editorPlan.activeCards, firstCard.startMs - 1), null);
assert.equal(findActiveStatCard(editorPlan.activeCards, firstCard.startMs)?.id, firstCard.id);
assert.equal(findActiveStatCard(editorPlan.activeCards, firstCard.endMs - 1)?.id, firstCard.id);
assert.equal(findActiveStatCard(editorPlan.activeCards, firstCard.endMs), null);

// Playing uses exact elapsedMs; paused right after caption-click seek (+10ms) clamps to steady state
assert.equal(statCardPreviewElapsedMs(10, 2_500, true), 10, "playing keeps exact entrance ramp");
const pausedElapsed = statCardPreviewElapsedMs(10, 2_500, false);
const pausedMotion = statCardMotionAt(pausedElapsed, 2_500);
assert.equal(pausedMotion.opacity, 1, "paused preview renders stat card at full opacity");
assert.ok(Math.abs(pausedMotion.scale - 1) < 1e-4, "paused preview renders stat card at full scale");

const nullVideoRef = { current: null };
const activePreviewHtml = renderToStaticMarkup(
  React.createElement(StatCardPreview, {
    cards: editorPlan.activeCards,
    videoRef: nullVideoRef,
    timeMs: firstCard.startMs + 10,
    playing: false,
    fontFamily: enabledCfg.fontFamily,
  }),
);
const expectedBadgeHtml = renderToStaticMarkup(
  React.createElement(StatCardBadge, {
    card: firstCard,
    frameScale: 0.3,
    motion: pausedMotion,
    fontFamily: enabledCfg.fontFamily,
  }),
);
assert.ok(activePreviewHtml.includes('data-stat-card-preview="true"'), "active preview mounts overlay container");
assert.ok(activePreviewHtml.includes("pointer-events-none"), "preview overlay is non-blocking (pointer-events-none)");
assert.ok(activePreviewHtml.includes(`top:${STAT_CARD_DEFAULT_TOP_PERCENT}%`), "preview matches Remotion topPercent");
assert.ok(activePreviewHtml.includes(expectedBadgeHtml), "preview renders the exact shared StatCardBadge markup");

const inactivePreviewHtml = renderToStaticMarkup(
  React.createElement(StatCardPreview, {
    cards: editorPlan.activeCards,
    videoRef: nullVideoRef,
    timeMs: 500, // inside opening headlineHook window, before firstCard.startMs
    playing: false,
    fontFamily: enabledCfg.fontFamily,
  }),
);
assert.ok(!inactivePreviewHtml.includes('data-stat-card-preview="true"'), "no stat card renders outside active windows");
assert.ok(inactivePreviewHtml.includes('class="hidden"'), "inactive preview keeps hidden anchor for ResizeObserver");

const emptyBadgeHtml = renderToStaticMarkup(
  React.createElement(StatCardToggleBadge, { status: zeroMatchPlan.status, enabled: true }),
);
const emptyHintHtml = renderToStaticMarkup(
  React.createElement(StatCardToggleHint, {
    status: zeroMatchPlan.status,
    enabled: true,
    subtitlesVisible: true,
  }),
);
assert.ok(emptyBadgeHtml.includes("ไม่พบตัวเลขในซับ") && emptyBadgeHtml.includes('data-stat-cards-count="0"'));
assert.ok(emptyHintHtml.includes('data-stat-cards-hint="empty"') && emptyHintHtml.includes("300%"));

const matchBadgeHtml = renderToStaticMarkup(
  React.createElement(StatCardToggleBadge, { status: multiMatchStatus, enabled: true }),
);
const hiddenLayerHintHtml = renderToStaticMarkup(
  React.createElement(StatCardToggleHint, {
    status: multiMatchStatus,
    enabled: true,
    subtitlesVisible: false,
  }),
);
assert.ok(matchBadgeHtml.includes("พบ 3 จุด") && matchBadgeHtml.includes('data-stat-cards-count="3"'));
assert.ok(hiddenLayerHintHtml.includes('data-stat-cards-hint="subtitles-hidden"'));

// ── 4. Desktop/mobile wiring and Remotion boundary hygiene ──────────────────────────────────
const root = process.cwd();
const read = (relPath: string) => readFileSync(path.join(root, relPath), "utf8");

const hookSource = read("src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts");
const desktopSource = read("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx");
const mobileSource = read("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx");
const previewSource = read("src/app/(dashboard)/video-editor/_v2/StatCardPreview.tsx");
const viewSource = read("src/remotion/StatCardView.tsx");
const overlaySource = read("src/remotion/StatCardOverlay.tsx");

assert.match(hookSource, /planEditorStatCards\(/, "usePostPhaseEditor plans stat cards via shared planner");
assert.match(hookSource, /subtitlesVisible:\s*effectiveLayerVisibility\.subtitles/, "editor stat card plan respects layerVisibility.subtitles");
assert.match(hookSource, /headlineHookEndMs:\s*subtitleSuppressionEndMs/, "editor stat card plan respects headlineHook suppression end time");
assert.match(hookSource, /plannedStatCards:\s*statCardsPlan\.activeCards/, "usePostPhaseEditor exposes plannedStatCards");
assert.match(hookSource, /statCardsStatus:\s*statCardsPlan\.status/, "usePostPhaseEditor exposes statCardsStatus");

for (const [label, source] of [
  ["PostPhase.tsx", desktopSource],
  ["PostPhaseMobile.tsx", mobileSource],
] as const) {
  assert.match(source, /<StatCardPreview[\s\S]*?cards=\{ed\.plannedStatCards\}/, `${label} mounts StatCardPreview with plannedStatCards`);
  assert.match(source, /<StatCardPreview[\s\S]*?videoRef=\{ed\.videoRef\}/, `${label} syncs StatCardPreview with videoRef`);
  assert.match(source, /<StatCardPreview[\s\S]*?timeMs=\{ed\.timeMs\}/, `${label} syncs StatCardPreview with timeMs`);
  assert.match(source, /<StatCardToggleBadge[\s\S]*?status=\{ed\.statCardsStatus\}/, `${label} renders live match-count badge beside Stat Cards toggle`);
  assert.match(source, /<StatCardToggleHint[\s\S]*?status=\{ed\.statCardsStatus\}/, `${label} renders zero-match / hidden-layer guidance under Stat Cards toggle`);
}

assert.doesNotMatch(viewSource, /from ["']remotion["']/, "StatCardView stays free of Remotion imports for browser bundle safety");
assert.doesNotMatch(previewSource, /from ["']remotion["']/, "StatCardPreview never imports Remotion directly");
assert.match(previewSource, /pointer-events-none/, "StatCardPreview keeps pointer-events-none");
assert.match(overlaySource, /from ["']\.\/StatCardView["']/, "Remotion StatCardOverlay delegates badge/motion to shared StatCardView");
assert.match(overlaySource, /findActiveStatCard\(/, "Remotion StatCardOverlay uses shared findActiveStatCard matcher");

console.log("verify-stat-cards-preview: all checks passed");
