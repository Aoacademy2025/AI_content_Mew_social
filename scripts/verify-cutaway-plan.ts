import {
  buildCutawayBackgroundTimeline,
  planCutaway,
  planCutawayRecomposite,
  buildEnableExpr,
  estimatedCutawayPieceCount,
  manualCutawayWindowCount,
  reconstructCutawayPersonRanges,
  resolveCutawayPersonRanges,
  cutawayTimelineScene,
  cutawayTimelineSourceFromJob,
  sceneRerollBeatTarget,
  sourceJobUsesCutawayTimeline,
  CUTAWAY_PRESENTER_SCENE_REROLL_MESSAGE,
} from "../src/lib/cutaway-plan";
import { readFileSync } from "node:fs";
import { assignBrollWindows } from "../src/lib/broll-coverage";
import { buildBrollWindows, buildFixedCountBrollWindows } from "../src/lib/broll-windows";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗", msg); failed++; } else { console.log("✓", msg); }
}

// windows tiling [0, n*4s] at 4s each (mirrors buildBrollWindows output shape)
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000 }));

// 1) hook (window 0) is always person
assert(planCutaway(mk(6)).person.some(r => r.startMs === 0), "window 0 (hook) is person");

// 2) alternation => b-roll only on odd windows (=> never two consecutive)
assert(
  JSON.stringify(planCutaway(mk(6)).broll.map(r => r.startMs)) === JSON.stringify([4000, 12000, 20000]),
  "b-roll on odd windows only (no consecutive)",
);

// 3) person + broll cover all windows, disjoint
{
  const { person, broll } = planCutaway(mk(5));
  assert(person.length + broll.length === 5, "person+broll count == window count");
  const starts = [...person, ...broll].map(r => r.startMs).sort((a, b) => a - b);
  assert(JSON.stringify(starts) === JSON.stringify([0, 4000, 8000, 12000, 16000]), "union covers all windows, disjoint");
}

// 4) < 2 windows => all person, no cutaway
{
  const { person, broll } = planCutaway(mk(1));
  assert(person.length === 1 && broll.length === 0, "1 window => all person, no b-roll");
  assert(planCutaway([]).person.length === 0 && planCutaway([]).broll.length === 0, "0 windows => empty plan");
}

// 5) b-roll ratio ~40-50% for typical lengths
{
  const ratio = planCutaway(mk(10)).broll.length / 10;
  assert(ratio >= 0.4 && ratio <= 0.5, `b-roll ratio ${ratio} within 0.4-0.5`);
}

// 6) enable expr formatting
assert(
  buildEnableExpr([{ start: 0, end: 3.5 }, { start: 8, end: 12 }]) === "between(t,0.000,3.500)+between(t,8.000,12.000)",
  "enable expr joins ranges with +",
);
assert(buildEnableExpr([]) === "", "empty ranges => empty expr");

// A manual upload count is a customer-facing count of VISIBLE B-roll pieces.
// planCutaway reserves every even window for the uploaded presenter, so the
// fixed-count builder needs two internal windows per requested B-roll piece.
assert(manualCutawayWindowCount(3) === 6, "manual upload target 3 => 6 alternating internal windows");
assert(manualCutawayWindowCount(60) === 120, "manual upload target caps at 60 visible pieces => 120 windows");
assert(manualCutawayWindowCount(0) === 0, "manual upload target 0 keeps automatic cadence");
assert(manualCutawayWindowCount(8, 9_999) === 0, "upload shorter than 10s skips cutaway");
assert(manualCutawayWindowCount(8, 10_000) === 2, "10s upload allows one 5s visible cutaway");
assert(manualCutawayWindowCount(8, 60_000) === 16, "60s upload keeps eight 3.75s visible cutaways");
assert(estimatedCutawayPieceCount(0, 15_190) === 2, "15.19s auto upload quotes two visible cutaways");
assert(estimatedCutawayPieceCount(8, 15_190) === 2, "15.19s manual target8 quotes the duration-clamped two");
assert(estimatedCutawayPieceCount(0, 9_999) === 0, "sub-10s auto upload quotes zero B-roll generation");
// Support regression #odqpq2 — the retained production job was a 15.19s upload
// with targetClipCount=8. The old formula produced 16 alternating windows, so
// each paid Hero B-roll was visible for only ~0.95s despite the 3–5s promise.
// Duration-aware planning must cap it at two visible pieces / four windows.
{
  const productionDurationMs = 15_190;
  const durationAwareWindowCount = (
    manualCutawayWindowCount as (target: unknown, durationMs?: unknown) => number
  )(8, productionDurationMs);
  assert(
    durationAwareWindowCount === 4,
    `#odqpq2 15.19s/target8 => 4 internal windows, got ${durationAwareWindowCount}`,
  );
  const productionCaptions = [
    { startMs: 0, endMs: 1700, text: "บางคนไม่ได้ผิดที่เขาไม่รัก" },
    { startMs: 2300, endMs: 6300, text: "แต่ผิดที่เขาปล่อยให้เราหวังเขาไม่เคยพูดว่าใช่" },
    { startMs: 6800, endMs: 11000, text: "แต่ก็ไม่เคยพูดว่าไม่แล้วเราก็รอ" },
    { startMs: 11600, endMs: 15190, text: "จนลืมไปว่าเราเองก็มีค่า" },
  ];
  const productionWindows = buildFixedCountBrollWindows(
    productionCaptions,
    durationAwareWindowCount,
    productionDurationMs,
    120,
  );
  const visibleRanges = planCutaway(productionWindows).broll;
  assert(visibleRanges.length === 2, `#odqpq2 renders 2 visible B-roll pieces, got ${visibleRanges.length}`);
  assert(
    visibleRanges.every((range) => range.endMs - range.startMs >= 3_000),
    "#odqpq2 keeps every visible B-roll on screen for at least 3s",
  );
}
{
  const captions = Array.from({ length: 12 }, (_, i) => ({
    startMs: i * 1000,
    endMs: (i + 1) * 1000,
    text: `ช่วง ${i + 1}`,
  }));
  const windows = buildFixedCountBrollWindows(captions, manualCutawayWindowCount(3), 12000, 120);
  assert(planCutaway(windows).broll.length === 3, "manual upload target 3 produces exactly 3 visible B-roll pieces");
}
const orchestratorSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
assert(
  orchestratorSource.includes("manualCutawayWindowCount(input.targetClipCount, upDurMs)"),
  "upload orchestrator duration-clamps the visible target through the shared helper",
);
const step2Source = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
const receiptSource = readFileSync("src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx", "utf8");
const useV2JobSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "utf8");
assert(step2Source.includes("effectiveManualCutawayPieceCount"), "Step 2 duration-clamps the visible custom count");
assert(receiptSource.includes("estimatedCutawayPieceCount"), "receipt quotes only visible upload cutaways");
assert(useV2JobSource.includes("estimatedCutawayPieceCount"), "submission ceiling matches visible upload cutaways");

// 7) small-window behavior is intentional (product ruling): short clips get fewer cutaways
{
  const p2 = planCutaway(mk(2));
  assert(p2.broll.length === 1 && p2.person.some(r => r.startMs === 0), "n=2 => 1 b-roll (50%), hook person");
  const p3 = planCutaway(mk(3));
  assert(p3.broll.length === 1, "n=3 => exactly 1 b-roll (33%, intentional for short clips)");
  assert(p3.person.some(r => r.startMs === 0) && p3.person.some(r => r.startMs === 8000), "n=3 => windows 0 and 2 are person");
  assert(planCutaway(mk(4)).broll.length === 2, "n=4 => 2 b-roll (50%)");
}

// 8) invalid windows are filtered before planning; buildEnableExpr drops backwards ranges
{
  const withJunk = [
    { startMs: 0, endMs: 4000 },
    { startMs: 4000, endMs: 4000 },   // zero-length => dropped
    { startMs: NaN, endMs: 8000 },     // non-finite => dropped
    { startMs: 8000, endMs: 12000 },
  ];
  const plan = planCutaway(withJunk);
  assert(plan.person.length + plan.broll.length === 2, "invalid windows filtered before planning");
  assert(buildEnableExpr([{ start: 5, end: 3 }]) === "", "buildEnableExpr drops backwards range");
}

// 9) buildEnableExpr hardening: malformed/hostile input never injects and never throws
{
  const bad = (x: unknown) => buildEnableExpr(x as { start: number; end: number }[]);
  assert(bad("evil'); drop") === "", "non-array input => empty expr (no throw)");
  assert(bad(null) === "" && bad(undefined) === "", "null/undefined => empty expr");
  assert(bad([{ start: "0)'", end: 5 }]) === "", "non-numeric start dropped (no injection)");
  assert(bad([{ start: 5, end: Infinity }]) === "", "Infinity end dropped");
  assert(buildEnableExpr([{ start: -3, end: 5 }]) === "", "negative start dropped");
  assert(buildEnableExpr([{ start: 0, end: 5 }]) === "between(t,0.000,5.000)", "valid range still works");
}

// 10) Upload Avatar re-render: visibility overrides add/remove the uploaded speaker without
// changing the fixed B-roll window timings.
{
  const basePerson = [{ start: 0, end: 4 }, { start: 8, end: 12 }];
  const windows = [
    { src: "/api/stocks/a.mp4", start: 0, end: 4, sourceIndex: 0 },
    { src: "/api/stocks/b.mp4", start: 4, end: 8, sourceIndex: 1, brollEnabled: false },
    { src: "/api/stocks/c.mp4", start: 8, end: 12, sourceIndex: 2, brollEnabled: true },
  ];
  const resolved = resolveCutawayPersonRanges(windows, basePerson);
  assert(
    JSON.stringify(resolved) === JSON.stringify([{ start: 0, end: 8 }]),
    "disable B-roll reveals uploaded speaker; enable B-roll removes speaker overlay",
  );
  assert(windows[1].start === 4 && windows[1].end === 8, "visibility overrides never mutate timing");
}

// 11) Legacy Upload Avatar previews have no stored personRanges. The baseline is REPLAYED from
// the creation formula (captions + cadence/targetClipCount) — never guessed from `sourceIndex`,
// which repeats whenever coverage repair reuses one asset across windows (nearest fallback).
//
// 8 captions × 2s over a 16s clip => buildBrollWindows(4s) yields four 4s windows,
// planCutaway makes windows 0 and 2 the person => [0,4] and [8,12].
const legacyCaptions = Array.from({ length: 8 }, (_, i) => ({
  startMs: i * 2000,
  endMs: (i + 1) * 2000,
  text: `คำที่ ${i + 1}`,
}));
const LEGACY_DUR_MS = 16000;
const legacyBase = reconstructCutawayPersonRanges({
  captions: legacyCaptions,
  audioDurationMs: LEGACY_DUR_MS,
  windowSec: 4,
});
{
  assert(
    JSON.stringify(legacyBase) === JSON.stringify([{ start: 0, end: 4 }, { start: 8, end: 12 }]),
    "legacy reconstruct replays buildBrollWindows + planCutaway (hook clamped to 0)",
  );

  // exact-formula check: identical to what the upload path computes at creation time
  const expected = planCutaway(
    buildBrollWindows(legacyCaptions, 4, LEGACY_DUR_MS).map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
  ).person.map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));
  if (expected.length > 0) expected[0] = { ...expected[0], start: 0 };
  assert(
    JSON.stringify(legacyBase) === JSON.stringify(expected),
    "legacy reconstruct === creation formula (buildBrollWindows path)",
  );

  // (ข-1) nearest-fallback duplicated sourceIndex across several windows: the OLD heuristic
  // collapsed them into one ordinal and inverted person/B-roll for the whole clip.
  const duplicatedSourceIndex = [
    { src: "/api/stocks/a.mp4", start: 0, end: 4, sourceIndex: 0 },
    { src: "/api/stocks/a.mp4", start: 4, end: 8, sourceIndex: 0 },
    { src: "/api/stocks/a.mp4", start: 8, end: 12, sourceIndex: 0 },
    { src: "/api/stocks/b.mp4", start: 12, end: 16, sourceIndex: 1 },
  ];
  assert(
    JSON.stringify(resolveCutawayPersonRanges(duplicatedSourceIndex, legacyBase))
      === JSON.stringify([{ start: 0, end: 4 }, { start: 8, end: 12 }]),
    "repeated sourceIndex no longer shifts person/B-roll (H2)",
  );

  // (ข-2) segments with NO sourceIndex at all (and a window split into two segments by
  // coverage repair) resolve to the very same layout.
  const noSourceIndex = [
    { src: "/api/stocks/a.mp4", start: 0, end: 2 },
    { src: "/api/stocks/a.mp4", start: 2, end: 4 },
    { src: "/api/stocks/b.mp4", start: 4, end: 8 },
    { src: "/api/stocks/c.mp4", start: 8, end: 12 },
    { src: "/api/stocks/d.mp4", start: 12, end: 16 },
  ];
  assert(
    JSON.stringify(resolveCutawayPersonRanges(noSourceIndex, legacyBase))
      === JSON.stringify([{ start: 0, end: 4 }, { start: 8, end: 12 }]),
    "missing sourceIndex + split window resolve to the same layout",
  );

  // (H3) swapping ONE clip (no visibility toggle at all) must not move person ranges
  const swappedOneClip = duplicatedSourceIndex.map((w, i) =>
    (i === 1 ? { ...w, src: "/api/renders/new-clip.mp4" } : w));
  assert(
    JSON.stringify(resolveCutawayPersonRanges(swappedOneClip, legacyBase))
      === JSON.stringify(resolveCutawayPersonRanges(duplicatedSourceIndex, legacyBase)),
    "changing a clip without toggling visibility keeps the layout identical (H3)",
  );

  // (ค) reconstruction is read-only: window timings are never touched (subtitle invariant)
  const timingSnapshot = JSON.stringify(duplicatedSourceIndex.map((w) => [w.start, w.end]));
  planCutawayRecomposite(duplicatedSourceIndex, legacyBase);
  assert(
    JSON.stringify(duplicatedSourceIndex.map((w) => [w.start, w.end])) === timingSnapshot,
    "reconstruct + recomposite never mutate window start/end",
  );

  // custom clip count uses the fixed-count builder, exactly like creation
  const fixed = reconstructCutawayPersonRanges({
    captions: legacyCaptions,
    audioDurationMs: LEGACY_DUR_MS,
    windowSec: 4,
    targetClipCount: 3,
  });
  const expectedFixed = planCutaway(
    buildFixedCountBrollWindows(legacyCaptions, 3, LEGACY_DUR_MS)
      .map((w) => ({ startMs: w.startMs, endMs: w.endMs })),
  ).person.map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));
  if (expectedFixed.length > 0) expectedFixed[0] = { ...expectedFixed[0], start: 0 };
  assert(
    JSON.stringify(fixed) === JSON.stringify(expectedFixed) && fixed.length > 0,
    "legacy reconstruct preserves the pre-fix creation formula (buildFixedCountBrollWindows path)",
  );
  assert(
    JSON.stringify(fixed) !== JSON.stringify(legacyBase),
    "targetClipCount actually changes the reconstructed plan (not silently ignored)",
  );

  // no usable captions => [] so the caller can fail closed instead of guessing
  assert(reconstructCutawayPersonRanges({ captions: [], audioDurationMs: 16000 }).length === 0,
    "no captions => empty reconstruct (caller must fail closed)");
  assert(reconstructCutawayPersonRanges({}).length === 0, "empty input => empty reconstruct (no throw)");
  assert(
    reconstructCutawayPersonRanges({ captions: "nope" as unknown as [] }).length === 0,
    "garbage captions => empty reconstruct (no throw)",
  );
}

// 11b) resolve() never invents a baseline any more — with an empty baseline and no visibility
// edits the result is empty (the old sourceIndex heuristic would have returned half the clip).
{
  const segments = [
    { src: "a", start: 0, end: 4, sourceIndex: 0 },
    { src: "b", start: 4, end: 8, sourceIndex: 1 },
  ];
  assert(resolveCutawayPersonRanges(segments, []).length === 0, "empty baseline stays empty (no inference)");
  assert(
    resolveCutawayPersonRanges(segments, undefined as unknown as { start: number; end: number }[]).length === 0,
    "non-array baseline is treated as empty (never throws)",
  );
}

// 11c) H1 — every window shows B-roll => no speaker overlay left => SKIP the composite.
// (Compositing with zero ranges makes ffmpeg draw the uploaded clip over the whole video.)
{
  const allBroll = [
    { src: "a", start: 0, end: 4, brollEnabled: true },
    { src: "b", start: 4, end: 8, brollEnabled: true },
    { src: "c", start: 8, end: 12, brollEnabled: true },
    { src: "d", start: 12, end: 16, brollEnabled: true },
  ];
  const decision = planCutawayRecomposite(allBroll, legacyBase);
  assert(decision.personRanges.length === 0, "all windows enabled => zero person ranges");
  assert(decision.skipComposite === true, "zero person ranges => skipComposite (H1)");
  assert(buildEnableExpr(decision.personRanges) === "", "zero ranges => empty enable expr (would fail-open)");

  // and the normal case still composites
  const mixed = allBroll.map((w, i) => (i === 0 ? { ...w, brollEnabled: false } : w));
  const kept = planCutawayRecomposite(mixed, legacyBase);
  assert(kept.skipComposite === false, "at least one person range => composite still runs");
  assert(
    JSON.stringify(kept.personRanges) === JSON.stringify([{ start: 0, end: 4 }]),
    "re-enabling one window restores exactly that span as person",
  );

  // hook clamp is preserved by the decision helper
  const hookLate = planCutawayRecomposite(
    [{ src: "a", start: 0, end: 4 }, { src: "b", start: 4, end: 8, brollEnabled: true }],
    [{ start: 0.4, end: 4 }],
  );
  assert(hookLate.personRanges[0]?.start === 0, "hook person range is clamped to frame 0");
}

// 12) Ranges are sanitized, clamped to valid spans, and coalesced for a compact FFmpeg expr.
{
  const resolved = resolveCutawayPersonRanges(
    [
      { src: "a", start: 0, end: 4, brollEnabled: false },
      { src: "b", start: 4, end: 8, brollEnabled: false },
      { src: "bad", start: 9, end: 8, brollEnabled: false },
    ],
    [],
  );
  assert(JSON.stringify(resolved) === JSON.stringify([{ start: 0, end: 8 }]), "adjacent person ranges are merged");
}

// 13) Sparse billable cutaways are expanded before coverage assignment. Without
// this mapping, person windows consume the next AI asset under the presenter and
// create a one-frame flash/reused image at the visible cutaway boundary.
{
  const windows = mk(4);
  const plan = planCutaway(windows);
  const timeline = buildCutawayBackgroundTimeline({
    windows,
    brollRanges: plan.broll,
    brollAssets: [
      { videoUrl: "/ai-0.png", duration: 8, sourceIndex: 0 },
      { videoUrl: "/ai-1.png", duration: 8, sourceIndex: 1 },
    ],
    presenterAsset: { videoUrl: "/uploaded-presenter.mp4", duration: 16 },
  });
  assert(timeline.windows.length === 4, "render timeline keeps all person + cutaway windows");
  assert(timeline.assets.length === 4, "render timeline has one preferred asset per full window");
  assert(timeline.assets[0]?.videoUrl === "/uploaded-presenter.mp4", "person window uses uploaded clip filler");
  assert(timeline.assets[0]?.clipOffset === 0, "first presenter filler starts at matching media offset");
  assert(timeline.assets[1]?.videoUrl === "/ai-0.png", "first visible cutaway keeps its first AI image");
  assert(timeline.assets[2]?.clipOffset === 8, "later presenter filler stays aligned to source time");
  assert(timeline.assets[3]?.videoUrl === "/ai-1.png", "second visible cutaway keeps its second AI image");

  const coverage = assignBrollWindows(
    timeline.windows,
    timeline.assets.map((asset) => ({
      src: String(asset.videoUrl),
      start: 0,
      end: 0,
      sourceIndex: asset.sourceIndex,
      clipOffset: Number(asset.clipOffset ?? 0),
      clipDuration: Number(asset.duration ?? 8),
    })),
    16,
    30,
  );
  const visible = plan.broll.map((range) => coverage.segments.filter((segment) =>
    segment.end > range.startMs / 1_000 && segment.start < range.endMs / 1_000,
  ));
  assert(coverage.complete, "expanded upload timeline has complete frame coverage");
  assert(visible.every((segments) => segments.length === 1), "each visible cutaway has no short flash segment");
  assert(
    visible[0]?.[0]?.src === "/ai-0.png" && visible[1]?.[0]?.src === "/ai-1.png",
    "visible cutaways use distinct AI images in order",
  );
}

assert(cutawayTimelineScene(0).kind === "presenter", "cutaway window 0 is the presenter hook");
assert(cutawayTimelineScene(18).kind === "presenter", "cutaway even window is presenter");
{
  const one = cutawayTimelineScene(1);
  const thirteen = cutawayTimelineScene(13);
  const nineteen = cutawayTimelineScene(19);
  assert(one.kind === "broll" && one.visualBeatSequence === 0, "cutaway window 1 is Visual Beat 0");
  assert(thirteen.kind === "broll" && thirteen.visualBeatSequence === 6, "cutaway window 13 is Visual Beat 6");
  assert(nineteen.kind === "broll" && nineteen.visualBeatSequence === 9, "cutaway window 19 is Visual Beat 9");
}
assert(sourceJobUsesCutawayTimeline({ mode: "upload" }) === true, "upload jobs use the cutaway timeline");
assert(
  sourceJobUsesCutawayTimeline({ cutawayPersonRanges: [{ start: 0, end: 5 }] }) === true,
  "persisted person ranges mark a cutaway timeline",
);
assert(sourceJobUsesCutawayTimeline({ mode: "broll" }) === false, "faceless jobs keep 1:1 window→beat indexes");

{
  const cutawayNineteen = sceneRerollBeatTarget(19, { mode: "upload" });
  const cutawayZero = sceneRerollBeatTarget(0, { mode: "upload" });
  const facelessNine = sceneRerollBeatTarget(9, { mode: "broll" });
  assert(
    cutawayNineteen.kind === "broll" && cutawayNineteen.visualBeatSequence === 9,
    "Scene Reroll maps cutaway window 19 to Visual Beat 9",
  );
  assert(cutawayZero.kind === "presenter", "Scene Reroll refuses cutaway presenter windows");
  assert(
    facelessNine.kind === "broll" && facelessNine.visualBeatSequence === 9,
    "faceless Scene Reroll keeps window 9 as Visual Beat 9",
  );
}
assert(
  sourceJobUsesCutawayTimeline(cutawayTimelineSourceFromJob({
    inputJson: JSON.stringify({ mode: "upload" }),
  })) === true,
  "upload inputJson is enough to detect a cutaway timeline",
);
assert(
  sourceJobUsesCutawayTimeline(cutawayTimelineSourceFromJob({
    outputJson: JSON.stringify({ preview: { cutawayPersonRanges: [{ start: 0, end: 5 }] } }),
  })) === true,
  "persisted preview person ranges detect a cutaway timeline",
);
assert(
  sourceJobUsesCutawayTimeline(cutawayTimelineSourceFromJob({
    inputJson: JSON.stringify({ mode: "broll" }),
    outputJson: "{}",
  })) === false,
  "faceless jobs without person ranges stay 1:1",
);
assert(
  CUTAWAY_PRESENTER_SCENE_REROLL_MESSAGE.includes("คลิปที่ถ่ายเอง"),
  "presenter Scene Reroll copy names the uploaded clip in Thai",
);

const generateRoute = readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
const resolveIdx = generateRoute.indexOf("brandVisualPrompt = await resolveProjectVisualPromptForVideoScene");
const heroIdx = generateRoute.indexOf("await generateHeroImageForVideo");
const presenterIdx = generateRoute.indexOf('beatTarget.kind === "presenter"');
assert(generateRoute.includes("sceneRerollBeatTarget"), "generate maps the timeline window through sceneRerollBeatTarget");
assert(generateRoute.includes("cutawayTimelineSourceFromJob"), "generate reads cutaway detection from the source job JSON");
assert(generateRoute.includes("CUTAWAY_PRESENTER_SCENE_REROLL_MESSAGE"), "generate refuses presenter windows with the shared Thai copy");
assert(
  presenterIdx >= 0 && resolveIdx >= 0 && heroIdx >= 0 && presenterIdx < resolveIdx && presenterIdx < heroIdx,
  "presenter refusal runs before Visual Beat lookup and Hero image admission",
);
assert(
  generateRoute.includes("sceneIndex: visualBeatSequence")
    || generateRoute.includes("sceneIndex: beatTarget.visualBeatSequence"),
  "generate looks up the remapped Visual Beat, not the raw timeline index",
);
assert(
  /generateHeroImageForVideo\([\s\S]*sceneIndex:\s*input\.sceneIndex/.test(generateRoute),
  "Hero idempotency stays keyed by the timeline window",
);
assert(
  /sceneRerollDerivative\.create\([\s\S]*sceneIndex:\s*input\.sceneIndex/.test(generateRoute),
  "the staged derivative stays bound to the timeline window",
);

const applySource = readFileSync("src/lib/scene-reroll-apply.server.ts", "utf8");
assert(applySource.includes("sceneRerollBeatTarget"), "Apply remaps cutaway windows onto the same Visual Beat");
assert(applySource.includes("cutawayTimelineSourceFromJob"), "Apply detects cutaway from the source job JSON");

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
