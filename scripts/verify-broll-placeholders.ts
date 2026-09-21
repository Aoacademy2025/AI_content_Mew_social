// HERO-44 "ใส่ B-roll เอง" on the script path: windows are planned, left empty, and filled
// one at a time. An empty window is a hidden segment with no `src`; the composition paints
// the brand background there. Pure checks — no DB, no ffmpeg.
import { readFileSync } from "node:fs";
import {
  buildPlaceholderBgVideos,
  prepareFilledWindowRenderAssets,
  withAssetMetadata,
} from "../src/lib/broll-placeholders";
import { coverBrollTimeline } from "../src/lib/broll-coverage";
import { mergeWindowEdits } from "../src/lib/broll-rerender";
import { brollWindowSpans } from "../src/lib/broll-spans";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok - ${msg}`);
  else { failed++; console.error(`  FAIL - ${msg}`); }
}

const FPS = 30;
const windows = [0, 1, 2, 3].map((i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000 }));
const probe = (durations: Record<string, number>) => ({
  resolveAsset: (src: string) => ({ src: `http://localhost${src}`, localPath: `/disk${src}` }),
  isUsableLocalFile: () => true,
  probeDurationSec: async (localPath: string) => durations[localPath.replace("/disk", "")] ?? null,
});

async function main() {
  console.log("placeholders from windows");
  const placeholders = buildPlaceholderBgVideos(windows, 16);
  assert(placeholders.length === 4, "one placeholder per planned window");
  assert(placeholders.every((p) => p.src === "" && p.brollEnabled === false), "a placeholder is a hidden segment with no src");
  assert(placeholders.every((p, i) => p.sourceIndex === i), "each placeholder keeps its own sourceIndex so neighbours never merge");
  assert(placeholders[0].start === 0 && placeholders[3].end === 16, "placeholders span the clip in seconds");
  assert(buildPlaceholderBgVideos([{ startMs: 0, endMs: 20_000 }], 16)[0].end === 16, "a window is clamped to the clip duration");
  assert(buildPlaceholderBgVideos([{ startMs: 5, endMs: 5 }, { startMs: NaN, endMs: 9 }], 16).length === 0, "degenerate windows are dropped");
  assert(brollWindowSpans({ bgVideos: placeholders }, 16_000).length === 4, "the editor timeline sees four selectable windows");

  console.log("filling a window");
  const filled = mergeWindowEdits(placeholders, [{ index: 1, src: "/api/stocks/mine.mp4", clipDuration: 10 }]);
  assert(!("error" in filled), "an empty window accepts a replacement");
  const merged = "error" in filled ? [] : filled.bgVideos;
  assert(merged[1]?.src === "/api/stocks/mine.mp4" && merged[1]?.brollEnabled === true, "filling an empty window makes it visible");
  assert(merged[0]?.src === "" && merged[0]?.brollEnabled === false, "untouched windows stay empty");
  const keptHidden = mergeWindowEdits(placeholders, [{ index: 2, src: "/api/stocks/mine.mp4", enabled: false }]);
  assert(!("error" in keptHidden) && keptHidden.bgVideos[2]?.brollEnabled === false, "an explicit enabled:false still wins");
  const realHidden = mergeWindowEdits(
    [{ src: "/api/stocks/old.mp4", start: 0, end: 4, brollEnabled: false }],
    [{ index: 0, src: "/api/stocks/new.mp4" }],
  );
  assert(!("error" in realHidden) && realHidden.bgVideos[0]?.brollEnabled === false, "replacing a hidden window that HAD footage does not unhide it");

  console.log("render assets");
  const nothing = await prepareFilledWindowRenderAssets(placeholders, FPS, probe({}));
  assert(nothing.length === 0, "nothing filled => nothing to render, no probe needed");

  const oneFilled = await prepareFilledWindowRenderAssets(merged as never, FPS, probe({ "/api/stocks/mine.mp4": 10 }));
  assert(oneFilled.length >= 1, "a filled window renders");
  assert(oneFilled.every((s) => s.start >= 4 - 1e-6 && s.end <= 8 + 1e-6), "a fill never spreads into the empty windows beside it");
  assert(Math.abs(oneFilled[0].start - 4) < 1e-6 && Math.abs(oneFilled[oneFilled.length - 1].end - 8) < 1e-6, "the filled window is covered end to end");
  assert(oneFilled.every((s) => s.src === "http://localhost/api/stocks/mine.mp4"), "the resolved src reaches the composition");

  const shortClip = await prepareFilledWindowRenderAssets(merged as never, FPS, probe({ "/api/stocks/mine.mp4": 1.5 }));
  assert(shortClip.length > 1 && shortClip.every((s) => s.start >= 4 - 1e-6 && s.end <= 8 + 1e-6), "a clip shorter than its window repeats inside that window only");

  let threw = false;
  try { await prepareFilledWindowRenderAssets(merged as never, FPS, { ...probe({}), isUsableLocalFile: () => false }); } catch { threw = true; }
  assert(threw, "a filled window whose file is missing still fails closed");

  console.log("upload clips: neighbouring presenter windows stay separate");
  // Found by a real upload render: every presenter window shares ONE src, and the by-src
  // metadata table stamped the LAST window's sourceIndex onto all of them, so coverage
  // fused the whole clip into a single window and left the customer one slot to fill.
  const presenter = [0, 1, 2].map((i) => ({
    src: "/api/renders/presenter.mp4", start: i * 4, end: (i + 1) * 4, sourceIndex: i,
    clipOffset: i * 4, clipDuration: 12, timelineAligned: true,
  }));
  const metaBySrc = new Map([["/api/renders/presenter.mp4", { keyword: "uploaded presenter clip", sourceIndex: 2 }]]);
  const stamped = withAssetMetadata(presenter, metaBySrc);
  assert(stamped.map((s) => s.sourceIndex).join(",") === "0,1,2", "a window keeps its own sourceIndex over the per-src metadata");
  assert(stamped.every((s) => s.keyword === "uploaded presenter clip"), "the rest of the asset metadata still applies");
  assert(withAssetMetadata([{ src: "/a.mp4", start: 0, end: 4 }], new Map([["/a.mp4", { sourceIndex: 5 }]]))[0].sourceIndex === 5, "a segment without its own sourceIndex still inherits one");
  assert(coverBrollTimeline(stamped, stamped, 12, FPS).segments.length === 3, "coverage keeps three windows for the customer to fill");

  console.log("upload clips: filling a presenter window");
  // Found by a real upload re-render: the replacement inherited `timelineAligned` from the
  // presenter it replaced, so a 5 s clip dropped into a window starting at 6 s was asked to
  // play from ITS 6th second, judged unplayable, and silently covered by the presenter again.
  const presenterFill = mergeWindowEdits(stamped, [{ index: 1, src: "/api/stocks/mine.mp4", clipDuration: 5, enabled: true }]);
  assert(!("error" in presenterFill), "a presenter window accepts a replacement");
  const filledPresenter = "error" in presenterFill ? [] : presenterFill.bgVideos;
  assert(filledPresenter[1]?.timelineAligned !== true, "the replacement does not inherit the presenter's timeline alignment");
  assert(filledPresenter[0]?.timelineAligned === true && filledPresenter[2]?.timelineAligned === true, "untouched presenter windows stay timeline-aligned");
  const covered = coverBrollTimeline(filledPresenter as never, filledPresenter as never, 12, FPS);
  assert(
    covered.complete && covered.segments.some((seg) => seg.src === "/api/stocks/mine.mp4" && seg.start < 4.1 && seg.clipOffset === 0),
    "coverage plays the customer's clip from its start inside the filled window",
  );

  console.log("wiring");
  const config = readFileSync("src/app/api/videos/generate-config/route.ts", "utf8");
  assert(/bgVideos = brollDisabled\s*\?\s*buildPlaceholderBgVideos\(/.test(config), "generate-config emits placeholders instead of an empty timeline");
  assert(/bgVideos = withAssetMetadata\(bgVideos, brollMetadataBySrc\);/.test(config), "generate-config applies metadata without clobbering sourceIndex");
  const render = readFileSync("src/app/api/videos/render/route.ts", "utf8");
  assert(/prepareFilledWindowRenderAssets\(/.test(render), "the render route renders filled windows of a brand-background config");
  assert(!/bgVideos: \[\],\s*\n\s*headlineHook/.test(render), "the render route no longer discards every fill");
  const composition = readFileSync("src/remotion/ShortVideoComposition.tsx", "utf8");
  assert(/brollEnabled: v\.brollEnabled !== false && Boolean\(v\.src\)/.test(composition), "the composition never mounts a video without a src");

  if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
  console.log("\nALL PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
