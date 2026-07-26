// Run with: npx tsx scripts/verify-avatar-fade.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AVATAR_FADE_DURATION_SEC,
  avatarFadeBlendFilter,
  avatarFadeEdgeDurationSec,
  avatarOpacityExpression,
  avatarSourceFadeWindows,
  singleAvatarFadeWindow,
} from "../src/lib/avatar-fade";
import { buildCompositeFilter } from "../src/lib/chroma-key";

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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("avatar-fade: all checks passed");
