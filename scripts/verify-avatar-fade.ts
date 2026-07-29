// Run with: npx tsx scripts/verify-avatar-fade.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AVATAR_FADE_DURATION_SEC,
  avatarFadeApplies,
  avatarFadeBlendFilter,
  avatarFadeEdgeDurationSec,
  avatarOpacityAtTime,
  avatarOpacityExpression,
  avatarSourceFadeWindows,
  singleAvatarFadeWindow,
} from "../src/lib/avatar-fade";
import { buildCompositeFilter } from "../src/lib/chroma-key";
import { LIVE_PREVIEW_MAX_SEC } from "../src/lib/preview-bg-constants";

function ffmpegPath(): string {
  return require("@ffmpeg-installer/ffmpeg").path as string;
}

const ffmpeg = ffmpegPath();
assert.equal(fs.existsSync(ffmpeg), true, `bundled ffmpeg not found: ${ffmpeg}`);
assert.equal(AVATAR_FADE_DURATION_SEC, 0.35);

assert.deepEqual(
  avatarSourceFadeWindows({
    timing: "full",
    totalDurationSec: 12,
    introSecs: 5,
    tailSecs: 4,
  }),
  [{ startSec: 0, endSec: 12 }],
);
assert.deepEqual(
  avatarSourceFadeWindows({
    timing: "bookend",
    totalDurationSec: 12,
    introSecs: 5,
    tailSecs: 4,
  }),
  [{ startSec: 0, endSec: 5 }],
);
assert.deepEqual(
  avatarSourceFadeWindows({
    timing: "bookend-both",
    totalDurationSec: 12,
    introSecs: 5,
    tailSecs: 4,
  }),
  [
    { startSec: 0, endSec: 5 },
    { startSec: 5, endSec: 9 },
  ],
  "legacy combined intro/tail source gets an independent fade on both avatar segments",
);
assert.deepEqual(
  avatarSourceFadeWindows({
    timing: "bookend-both",
    totalDurationSec: 6,
    introSecs: 5,
    tailSecs: 5,
  }),
  [
    { startSec: 0, endSec: 5 },
    { startSec: 5, endSec: 6 },
  ],
  "intro and tail are clamped without exceeding the available source duration",
);
assert.deepEqual(singleAvatarFadeWindow(4), [{ startSec: 0, endSec: 4 }]);
assert.deepEqual(singleAvatarFadeWindow(Number.NaN), []);
assert.deepEqual(singleAvatarFadeWindow(0.0004), []);
assert.equal(avatarFadeEdgeDurationSec({ startSec: 0, endSec: 0.4 }), 0.2);
assert.equal(avatarFadeEdgeDurationSec({ startSec: 0, endSec: 5 }), 0.35);
assert.equal(
  avatarFadeEdgeDurationSec({ startSec: 0, endSec: 5 }, 0),
  AVATAR_FADE_DURATION_SEC,
);

// ── H7 must-fix: client-side live-preview fade (AvatarAdjustOverlay) must compute the
// EXACT same opacity, at any timestamp, that export bakes in via avatarOpacityExpression's
// ffmpeg blend — both are built from the same normalizeAvatarFadeWindows/avatarFadeEdgeDurationSec
// primitives (see avatar-fade.ts docstrings), so this is a real numeric check, not a regex.
function approxEqual(actual: number, expected: number, label: string, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label}: expected ${actual} to be within ${eps} of ${expected}`,
  );
}

// full: single window spans the whole clip — fades in at 0, steady through the middle, fades
// out at the very end. introSecs/tailSecs are irrelevant to "full".
{
  const windows = avatarSourceFadeWindows({ timing: "full", totalDurationSec: 12, introSecs: 5, tailSecs: 4 });
  approxEqual(avatarOpacityAtTime(windows, 0), 0, "full@0 (fade-in starts invisible)");
  approxEqual(avatarOpacityAtTime(windows, AVATAR_FADE_DURATION_SEC), 1, "full@edge (fade-in complete)");
  approxEqual(avatarOpacityAtTime(windows, 6), 1, "full@mid (steady)");
  approxEqual(avatarOpacityAtTime(windows, 12 - AVATAR_FADE_DURATION_SEC), 1, "full@(end-edge) (fade-out not yet started)");
  approxEqual(avatarOpacityAtTime(windows, 12), 0, "full@end (fade-out complete)");
}

// bookend: single window [0, introSecs] — same fade-in shape as full, but opacity drops to 0
// once the bookend window ends (avatar isn't composited past that point at all).
{
  const windows = avatarSourceFadeWindows({ timing: "bookend", totalDurationSec: 12, introSecs: 5, tailSecs: 4 });
  approxEqual(avatarOpacityAtTime(windows, 0), 0, "bookend@0");
  approxEqual(avatarOpacityAtTime(windows, AVATAR_FADE_DURATION_SEC), 1, "bookend@edge");
  approxEqual(avatarOpacityAtTime(windows, 2.5), 1, "bookend@mid-intro (steady)");
  approxEqual(avatarOpacityAtTime(windows, 5), 0, "bookend@5 (window end, fully faded out)");
  approxEqual(avatarOpacityAtTime(windows, 6), 0, "bookend@6 (past the avatar window entirely)");
}

// bookend-both — AvatarAdjustOverlay's live preview: the component's preview clip is ALWAYS
// keyed from the INTRO avatar (avatarVideoUrl); the tail is a separate HeyGen render it never
// fetches. Production only reaches this component for bookend-both when a real split composite
// will run (canAdjustAvatar requires tailAvatarUrl present), and that split path
// (applyBookendBothSplit in composite/route.ts) fades the intro segment with its OWN single
// window: `segmentFadeWindow = singleAvatarFadeWindow(dur)` where dur = min(introSecs, bgDur).
// The client must reproduce exactly that window — not the two-window combined-timeline shape
// avatarSourceFadeWindows(timing:"bookend-both", …) returns (that shape is for the LEGACY
// non-split path, unreachable from this component). Assert the two formulations coincide.
{
  const introSecs = 5;
  const bgDurationSec = 12;
  // What export's split composite actually uses for the intro segment (mirrors route.ts:509).
  const exportIntroSegmentWindow = singleAvatarFadeWindow(Math.min(introSecs, bgDurationSec));
  // What the client computes by normalizing "bookend-both" → "bookend" (AvatarAdjustOverlay.tsx).
  const clientWindows = avatarSourceFadeWindows({
    timing: "bookend", // AvatarAdjustOverlay's normalization for bookend-both
    totalDurationSec: bgDurationSec,
    introSecs,
    tailSecs: 4,
  });
  assert.deepEqual(
    clientWindows,
    exportIntroSegmentWindow,
    "AvatarAdjustOverlay's bookend-both windows must match the split composite's intro-segment window",
  );
  approxEqual(avatarOpacityAtTime(clientWindows, 0), 0, "bookend-both@0 (intro fade-in starts)");
  approxEqual(avatarOpacityAtTime(clientWindows, AVATAR_FADE_DURATION_SEC), 1, "bookend-both@intro-edge");
  approxEqual(avatarOpacityAtTime(clientWindows, 2.5), 1, "bookend-both@intro-mid (steady)");
  approxEqual(avatarOpacityAtTime(clientWindows, 5), 0, "bookend-both@5 (intro segment end, fully faded out)");
  // A naive combined-timeline model (avatarSourceFadeWindows(timing:"bookend-both", …), which is
  // NOT what this component uses) would spuriously report opacity 1 here (inside its tail
  // window [5,9]) even though the preview never shows the tail clip at all — guard against that
  // regression explicitly.
  approxEqual(avatarOpacityAtTime(clientWindows, 6), 0, "bookend-both@6 (past intro entirely — no phantom tail fade-in)");
}

// ── Review fix: loop-snap regression ────────────────────────────────────────────────────────
// AvatarAdjustOverlay's preview <video> is LOOPED and its actual playable content never exceeds
// LIVE_PREVIEW_MAX_SEC (the ffmpeg `-t` bound preview-bg is given). Feeding the real bgDurationSec
// into avatarSourceFadeWindows (as the pre-fix code did) made "full" mode — and any bookend/intro
// longer than the excerpt — compute a window that's still at opacity=1 well past the loop point,
// so every loop restart SNAPPED 1→0→1 instead of fading. Mirrors AvatarAdjustOverlay.tsx's actual
// fadeWindows useMemo: clamp totalDurationSec to min(bgDurationSec, LIVE_PREVIEW_MAX_SEC) first.
function livePreviewFadeWindows(
  timing: string,
  bgDurationSec: number,
  introSecs: number,
  tailSecs: number,
) {
  return avatarSourceFadeWindows({
    timing: timing === "bookend-both" ? "bookend" : timing,
    totalDurationSec: Math.min(bgDurationSec, LIVE_PREVIEW_MAX_SEC),
    introSecs,
    tailSecs,
  });
}

// full mode, a long render (12s) — the excerpt is the binding constraint.
{
  const windows = livePreviewFadeWindows("full", 12, 5, 4);
  assert.deepEqual(windows, [{ startSec: 0, endSec: LIVE_PREVIEW_MAX_SEC }], "full@12s render clamps to the excerpt length");
  approxEqual(avatarOpacityAtTime(windows, 0), 0, "full-clamped@0");
  approxEqual(avatarOpacityAtTime(windows, AVATAR_FADE_DURATION_SEC), 1, "full-clamped@edge");
  approxEqual(avatarOpacityAtTime(windows, 2), 1, "full-clamped@mid (steady)");
  approxEqual(avatarOpacityAtTime(windows, LIVE_PREVIEW_MAX_SEC), 0, "full-clamped@excerpt-end (fade-out completes exactly at the loop boundary)");

  // Regression proof: the UNCLAMPED (pre-fix) computation is still at opacity=1 at the exact
  // instant this preview loops — that's the snap the review caught. The clamped version isn't.
  const unclamped = avatarSourceFadeWindows({ timing: "full", totalDurationSec: 12, introSecs: 5, tailSecs: 4 });
  approxEqual(avatarOpacityAtTime(unclamped, LIVE_PREVIEW_MAX_SEC), 1, "pre-fix: still opaque at the loop point (the bug)");
  approxEqual(avatarOpacityAtTime(windows, LIVE_PREVIEW_MAX_SEC), 0, "post-fix: faded out by the loop point (the fix)");
}

// bookend mode, introSecs (5) >= excerpt (4) — same clamp applies, same shape as "full" here.
{
  const windows = livePreviewFadeWindows("bookend", 12, 5, 4);
  assert.deepEqual(windows, [{ startSec: 0, endSec: LIVE_PREVIEW_MAX_SEC }], "bookend@intro=5s > excerpt clamps to the excerpt length");
  approxEqual(avatarOpacityAtTime(windows, LIVE_PREVIEW_MAX_SEC), 0, "bookend-clamped@excerpt-end");
}

// bookend mode, introSecs (2) < excerpt (4) — the REAL intro length is the binding constraint,
// not the excerpt cap: fade-out must land at 2s, not get stretched out to 4s.
{
  const windows = livePreviewFadeWindows("bookend", 12, 2, 4);
  assert.deepEqual(windows, [{ startSec: 0, endSec: 2 }], "bookend@intro=2s < excerpt keeps the real intro length");
  approxEqual(avatarOpacityAtTime(windows, 2), 0, "bookend-short-intro@2 (faded out well before the loop boundary)");
  approxEqual(avatarOpacityAtTime(windows, 3), 0, "bookend-short-intro@3 (still invisible mid-excerpt, not re-appearing)");
}

// A render itself shorter than the excerpt cap — the real content is the binding constraint.
{
  const windows = livePreviewFadeWindows("full", 1.5, 5, 4);
  assert.deepEqual(windows, [{ startSec: 0, endSec: 1.5 }], "full@short render (1.5s) isn't padded out to the excerpt cap");
}

// avatarFadeApplies (M10/B-13): drives the timeline gradient/tooltip + mobile hint — must be
// true for every HeyGen avatar id (any timing) and false for "none"/"upload-cutaway"/absent,
// since cutawayComposite never receives fade windows at all.
assert.equal(avatarFadeApplies("Wayne_20240711"), true, "heygen avatarId → fade applies");
assert.equal(avatarFadeApplies("upload-cutaway"), false, "cutaway → cutawayComposite never fades");
assert.equal(avatarFadeApplies("none"), false, "no avatar → no fade");
assert.equal(avatarFadeApplies(null), false, "absent avatarModel → no fade");
assert.equal(avatarFadeApplies(undefined), false, "undefined avatarModel → no fade");

const expression = avatarOpacityExpression([
  { startSec: 0, endSec: 5 },
  { startSec: 5, endSec: 9 },
]);
assert.match(expression, /T/);
assert.match(expression, /max/);
assert.doesNotMatch(expression, /NaN|Infinity|;|\[/);
assert.throws(
  () =>
    avatarFadeBlendFilter({
      compositeLabel: "composite",
      backgroundLabel: "background];anull",
      outputLabel: "output",
      windows: [{ startSec: 0, endSec: 1 }],
    }),
  /invalid FFmpeg filter label/,
);

const windows = [
  { startSec: 0, endSec: 0.8 },
  { startSec: 0.8, endSec: 1.6 },
];
const filter = buildCompositeFilter(
  { color: "0x12FF05", similarity: 0.28, blend: 0.1 },
  null,
  false,
  windows,
);
assert.match(filter, /split=2\[bg\]\[bg_fade\]/);
assert.match(filter, /blend=all_expr=/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-fade-"));
const output = path.join(tmp, "fade.mp4");
try {
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x0000FF:s=1080x1920:d=2:r=20",
    "-f", "lavfi",
    "-i", "color=c=0x12FF05:s=720x1280:d=2:r=20,drawbox=x=210:y=440:w=300:h=400:color=0xFF0000:t=fill",
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", "2",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    output,
  ], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 32 * 1024 * 1024 });

  function centerPixel(timeSec: number): [number, number, number] {
    const pixel = execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", String(timeSec),
      "-i", output,
      "-vf", "crop=2:2:539:959,scale=1:1,format=rgb24",
      "-frames:v", "1",
      "-f", "rawvideo",
      "-",
    ], { maxBuffer: 1024 * 1024 });
    assert.equal(pixel.length, 3);
    return [pixel[0], pixel[1], pixel[2]];
  }

  const entering = centerPixel(0.05);
  const steadyIntro = centerPixel(0.4);
  const introLeaving = centerPixel(0.75);
  const tailEntering = centerPixel(0.85);
  const steadyTail = centerPixel(1.2);
  const backgroundOnly = centerPixel(1.8);
  assert.ok(
    steadyIntro[0] > entering[0] + 80
      && steadyIntro[0] > introLeaving[0] + 80
      && steadyTail[0] > tailEntering[0] + 80,
    `each avatar segment must fade independently: ${entering} / ${steadyIntro} / ${introLeaving} / ${tailEntering} / ${steadyTail}`,
  );
  assert.ok(
    backgroundOnly[2] > 150 && backgroundOnly[0] < 80,
    `background must remain fully visible after the avatar window: ${backgroundOnly}`,
  );

  const routeSource = fs.readFileSync(
    "src/app/api/heygen/composite/route.ts",
    "utf8",
  );
  assert.match(routeSource, /avatarSourceFadeWindows/);
  assert.match(routeSource, /singleAvatarFadeWindow/);
  assert.match(
    routeSource,
    /directComposite\(bgTmp,\s*avatarTmp,\s*outPath,\s*sourceFadeWindows\)/,
  );
  assert.match(
    routeSource,
    /chromakeyComposite\([\s\S]{0,320}sourceFadeWindows/,
  );
  assert.match(
    routeSource,
    /fadeCompositeAgainstBackground\([\s\S]{0,220}sourceFadeWindows/,
  );
  assert.match(
    routeSource,
    /segmentFadeWindow\s*=\s*singleAvatarFadeWindow\(dur\)/,
  );

  const timelineSource = fs.readFileSync(
    "src/app/(dashboard)/video-editor/_v2/TimelinePanel.tsx",
    "utf8",
  );
  assert.match(timelineSource, /data-avatar-fade-edge/);
  assert.match(timelineSource, /AVATAR_FADE_DURATION_SEC/);

  // M10: the gradient/tooltip must be gated on a real avatarFadeApplies prop, not just
  // hasAvatar — that's the whole point of the fix (cutaway has hasAvatar=true, fade=false).
  assert.match(timelineSource, /avatarFadeApplies:\s*boolean/, "TimelinePanel must accept avatarFadeApplies as a typed prop");
  // Integration (b) reconcile: this branch originally pinned the gate to `avatarFadeApplies`
  // alone. After merging editor-layer-visibility-toggles, turning the avatar layer OFF makes
  // export fall back to compositeBaseUrl — a file with no avatar and therefore no fade at all
  // — so `avatarFadeApplies` alone is no longer the honest gate. The single source of truth is
  // now `avatarFadeIndicated`, which is strictly narrower (it still excludes cutaway).
  assert.match(
    timelineSource,
    /const avatarFadeIndicated = avatarFadeApplies && layerVisibility\.avatar;/,
    "the fade indicator gate must combine avatarFadeApplies with the avatar layer toggle",
  );
  assert.match(
    timelineSource,
    /const avatarFadeEdges = avatarFadeIndicated \? \(/,
    "avatarFadeEdges must be gated by avatarFadeIndicated, not rendered unconditionally",
  );
  assert.match(
    timelineSource,
    /const avatarFadeTitle = avatarFadeIndicated \? "เฟดเข้า–ออกอัตโนมัติ" : undefined;/,
    "the misleading tooltip must also be gated by avatarFadeIndicated",
  );
  assert.doesNotMatch(
    timelineSource,
    /title="เฟดเข้า–ออกอัตโนมัติ"/,
    "no unconditional fade tooltip should remain — must route through avatarFadeTitle",
  );

  const postPhaseSource = fs.readFileSync(
    "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx",
    "utf8",
  );
  assert.match(
    postPhaseSource,
    /avatarFadeApplies=\{avatarFadeApplies\(ed\.preview\?\.avatarModel \?\? null\)\}/,
    "PostPhase must wire TimelinePanel's avatarFadeApplies prop from the shared lib/avatar-fade helper",
  );

  const mobileSource = fs.readFileSync(
    "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx",
    "utf8",
  );
  assert.match(
    mobileSource,
    /avatarFadeApplies\(preview\?\.avatarModel \?\? null\)/,
    "B-13: mobile ClipSummary must gate the fade hint on avatarFadeApplies too",
  );
  assert.match(
    mobileSource,
    /hint=\{fadeApplies \? "เฟดเข้า–ออกอัตโนมัติ" : undefined\}/,
    "B-13: the avatar SummaryRow must pass the fade hint conditionally",
  );

  const avatarAdjustSource = fs.readFileSync(
    "src/app/(dashboard)/video-editor/_v2/AvatarAdjustOverlay.tsx",
    "utf8",
  );
  assert.match(
    avatarAdjustSource,
    /avatarOpacityAtTime,\s*avatarSourceFadeWindows/,
    "H7: AvatarAdjustOverlay must import the client fade helpers",
  );
  assert.match(
    avatarAdjustSource,
    /onTimeUpdate=\{\(e\) => setAvatarOpacity\(avatarOpacityAtTime\(fadeWindows, e\.currentTarget\.currentTime\)\)\}/,
    "H7: the live keyed preview <video> must sync opacity from fade windows on every timeupdate tick",
  );
  assert.match(
    avatarAdjustSource,
    /opacity: avatarOpacity/,
    "H7: the computed opacity must actually be applied to the preview <video>'s style",
  );
  // Review fix (loop-snap): the excerpt cap must be a single shared constant, not a hardcoded
  // literal duplicated between the preview-bg fetch and the fade-window clamp (which is exactly
  // how they drifted and caused the regression in the first place).
  assert.match(
    avatarAdjustSource,
    /import \{ LIVE_PREVIEW_MAX_SEC \} from "@\/lib\/preview-bg-constants";/,
    "loop-snap fix: AvatarAdjustOverlay must import the shared excerpt-length constant",
  );
  // Build guard: this is a Client Component, and "@/lib/preview-bg-params" imports fs/path.
  // Importing the constant from THERE type-checks fine but fails the production webpack build
  // ("Module not found: Can't resolve 'fs'"), which is exactly how it shipped broken — tsc and
  // the unit checks were both green. The constant lives in the dependency-free sibling instead.
  assert.doesNotMatch(
    avatarAdjustSource,
    /from "@\/lib\/preview-bg-params"/,
    "a Client Component must never import the fs-backed preview-bg-params module",
  );
  assert.match(
    avatarAdjustSource,
    /maxSec: LIVE_PREVIEW_MAX_SEC/,
    "loop-snap fix: the preview-bg fetch must request the SAME excerpt length the fade clamp assumes",
  );
  assert.match(
    avatarAdjustSource,
    /totalDurationSec: Math\.min\(bgDurationSec, LIVE_PREVIEW_MAX_SEC\)/,
    "loop-snap fix: fade windows must be computed against the excerpt actually played, not the full render duration",
  );
  assert.doesNotMatch(
    avatarAdjustSource,
    /maxSec:\s*4\b/,
    "no hardcoded maxSec literal should remain — must route through LIVE_PREVIEW_MAX_SEC",
  );
  assert.match(
    avatarAdjustSource,
    /transition: "opacity 100ms linear"/,
    "[Low] opacity changes should transition smoothly between ~4Hz timeupdate ticks",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("avatar-fade: all checks passed");
