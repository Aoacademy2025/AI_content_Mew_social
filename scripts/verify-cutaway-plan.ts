import {
  planCutaway,
  planCutawayRecomposite,
  buildEnableExpr,
  reconstructCutawayPersonRanges,
  resolveCutawayPersonRanges,
} from "../src/lib/cutaway-plan";
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
    "legacy reconstruct === creation formula (buildFixedCountBrollWindows path)",
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

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
