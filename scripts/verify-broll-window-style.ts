// EP5 #11 (hard cut per window) + U3 (fit per window): the pure half of the core edit model.
// Edit validation + merge (Thai errors), the re-render request's project default, coverage
// carrying each window's style onto every segment it renders, the composition's cut plan, and
// the browser apply journal. Legacy inputs (no style anywhere) must come out byte-identical.
import assert from "node:assert/strict";
import { coverBrollTimeline, type BrollCoverageAsset } from "../src/lib/broll-coverage";
import {
  mergeWindowEdits,
  validateBrollRerenderRequest,
  validateWindowEdits,
} from "../src/lib/broll-rerender";
import {
  brollCutAfter,
  effectiveBrollFit,
  effectiveBrollTransition,
} from "../src/lib/broll-window-style";
import { readPendingBrollApply, writePendingBrollApply, type PendingBrollApply } from "../src/lib/broll-apply-recovery";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const TRANSITION_ERROR = "รูปแบบการเปลี่ยนฉาก b-roll ไม่ถูกต้อง";
const FIT_ERROR = "รูปแบบการจัดภาพ b-roll ไม่ถูกต้อง";

console.log("validateWindowEdits");
check("a style-only edit is a change (transition / fit / back to the project default)", () => {
  assert.deepEqual(validateWindowEdits([{ index: 0, transition: "cut" }]), [{ index: 0, transition: "cut" }]);
  assert.deepEqual(validateWindowEdits([{ index: 1, fit: "contain" }]), [{ index: 1, fit: "contain" }]);
  assert.deepEqual(validateWindowEdits([{ index: 2, transition: "default" }]), [{ index: 2, transition: "default" }]);
  assert.deepEqual(validateWindowEdits([{ index: 0 }]), { error: "รายการแก้ b-roll ไม่มีการเปลี่ยนแปลง" });
});
check("style rides along with a replacement", () => {
  assert.deepEqual(
    validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", transition: "dissolve", fit: "cover" }]),
    [{ index: 0, src: "/api/stocks/a.mp4", transition: "dissolve", fit: "cover" }],
  );
});
check("unknown values are refused in Thai", () => {
  assert.deepEqual(validateWindowEdits([{ index: 0, transition: "wipe" }]), { error: TRANSITION_ERROR });
  assert.deepEqual(validateWindowEdits([{ index: 0, transition: 1 }]), { error: TRANSITION_ERROR });
  assert.deepEqual(validateWindowEdits([{ index: 0, fit: "stretch" }]), { error: FIT_ERROR });
  assert.deepEqual(validateWindowEdits([{ index: 0, fit: null }]), { error: FIT_ERROR });
});
check("legacy edits gain no style keys", () => {
  const edits = validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", enabled: true }]);
  assert.deepEqual(edits, [{ index: 0, src: "/api/stocks/a.mp4", enabled: true }]);
});

console.log("mergeWindowEdits");
const windows = [
  { src: "/api/stocks/a.mp4", start: 0, end: 2, clipDuration: 6, provider: "pexels" },
  { src: "/api/stocks/b.mp4", start: 2, end: 4, clipDuration: 6, transition: "cut", fit: "contain" },
];
check("style edit sets the window's own fields and keeps its media", () => {
  const edits = validateWindowEdits([{ index: 0, transition: "cut", fit: "contain" }]);
  assert.ok(!("error" in edits));
  const merged = mergeWindowEdits(windows, edits);
  assert.ok(!("error" in merged));
  assert.deepEqual(merged.bgVideos[0], { ...windows[0], transition: "cut", fit: "contain" });
  assert.deepEqual(merged.bgVideos[1], windows[1]);
});
check("a replacement keeps the window's style (style belongs to the window, not the clip)", () => {
  const edits = validateWindowEdits([{ index: 1, src: "/api/stocks/c.mp4", clipDuration: 3 }]);
  assert.ok(!("error" in edits));
  const merged = mergeWindowEdits(windows, edits);
  assert.ok(!("error" in merged));
  assert.equal(merged.bgVideos[1].src, "/api/stocks/c.mp4");
  assert.equal(merged.bgVideos[1].transition, "cut");
  assert.equal(merged.bgVideos[1].fit, "contain");
});
check("\"default\" drops the window override; fit cover is stored explicitly", () => {
  const edits = validateWindowEdits([{ index: 1, transition: "default", fit: "cover" }]);
  assert.ok(!("error" in edits));
  const merged = mergeWindowEdits(windows, edits);
  assert.ok(!("error" in merged));
  assert.equal("transition" in merged.bgVideos[1], false);
  assert.equal(merged.bgVideos[1].fit, "cover");
});
check("an untouched window list merges byte-identically", () => {
  const legacy = [{ src: "/api/stocks/a.mp4", start: 0, end: 2 }, { src: "/api/stocks/b.mp4", start: 2, end: 4 }];
  const merged = mergeWindowEdits(legacy, []);
  assert.ok(!("error" in merged));
  assert.equal(JSON.stringify(merged.bgVideos), JSON.stringify(legacy));
});

console.log("validateBrollRerenderRequest (project default)");
check("a project default alone is a valid re-render", () => {
  assert.deepEqual(validateBrollRerenderRequest(undefined, "cut"), { windowEdits: [], brollTransition: "cut" });
  assert.deepEqual(validateBrollRerenderRequest([], "dissolve"), { windowEdits: [], brollTransition: "dissolve" });
});
check("without a default the request is exactly validateWindowEdits", () => {
  assert.deepEqual(validateBrollRerenderRequest([], undefined), { error: "ไม่มีการแก้ b-roll" });
  assert.deepEqual(
    validateBrollRerenderRequest([{ index: 0, enabled: false }], undefined),
    { windowEdits: [{ index: 0, enabled: false }] },
  );
});
check("a bad default or bad edits are refused", () => {
  assert.deepEqual(validateBrollRerenderRequest([], "fade"), { error: TRANSITION_ERROR });
  assert.deepEqual(validateBrollRerenderRequest(undefined, "default"), { error: TRANSITION_ERROR });
  assert.deepEqual(validateBrollRerenderRequest([{ index: 0, fit: "x" }], "cut"), { error: FIT_ERROR });
  assert.deepEqual(validateBrollRerenderRequest("nope", "cut"), { error: "รูปแบบการแก้ b-roll ไม่ถูกต้อง" });
});

console.log("coverage");
const FPS = 30;
check("legacy windows come out with no style keys", () => {
  const legacy: BrollCoverageAsset[] = [
    { src: "/a.mp4", start: 0, end: 2, clipDuration: 6, sourceIndex: 0 },
    { src: "/b.mp4", start: 2, end: 4, clipDuration: 1, sourceIndex: 1 },
  ];
  const { segments, complete } = coverBrollTimeline(legacy, legacy, 4, FPS);
  assert.equal(complete, true);
  for (const segment of segments) {
    assert.equal("transition" in segment, false);
    assert.equal("fit" in segment, false);
  }
});
check("every segment of a styled window carries its style, borrowed footage included", () => {
  // b.mp4 is shorter than its window, so window 1 borrows a.mp4 for the shortfall.
  const styled: BrollCoverageAsset[] = [
    { src: "/a.mp4", start: 0, end: 2, clipDuration: 6, sourceIndex: 0 },
    { src: "/b.mp4", start: 2, end: 5, clipDuration: 1.5, sourceIndex: 1, transition: "cut", fit: "contain" },
  ];
  const { segments, complete } = coverBrollTimeline(styled, styled, 5, FPS);
  assert.equal(complete, true);
  const inWindow1 = segments.filter((segment) => segment.start >= 2 - 1e-6);
  assert.ok(inWindow1.length >= 2, "window 1 needed a borrowed segment");
  assert.ok(inWindow1.some((segment) => segment.src === "/a.mp4"), "borrowed footage present");
  for (const segment of inWindow1) {
    assert.equal(segment.transition, "cut");
    assert.equal(segment.fit, "contain");
  }
  for (const segment of segments.filter((segment) => segment.end <= 2 + 1e-6)) {
    assert.equal("transition" in segment, false, "window 0 keeps the default");
    assert.equal("fit" in segment, false);
  }
});
check("a styled window never lends its style to the window it fills", () => {
  const styled: BrollCoverageAsset[] = [
    { src: "/a.mp4", start: 0, end: 2, clipDuration: 6, sourceIndex: 0, transition: "cut", fit: "contain" },
    { src: "/b.mp4", start: 2, end: 5, clipDuration: 1.5, sourceIndex: 1 },
  ];
  const { segments } = coverBrollTimeline(styled, styled, 5, FPS);
  for (const segment of segments.filter((segment) => segment.start >= 2 - 1e-6)) {
    assert.equal("transition" in segment, false);
    assert.equal("fit" in segment, false);
  }
});
check("same-source neighbours with different styles stay separate segments", () => {
  const legacy: BrollCoverageAsset[] = [
    { src: "/a.mp4", start: 0, end: 2, clipDuration: 10 },
    { src: "/a.mp4", start: 2, end: 4, clipDuration: 10, clipOffset: 2 },
  ];
  assert.equal(coverBrollTimeline(legacy, legacy, 4, FPS).segments.length, 1, "legacy behaviour: one continuous segment");
  const styled = [legacy[0], { ...legacy[1], transition: "cut" as const }];
  const { segments } = coverBrollTimeline(styled, styled, 4, FPS);
  assert.equal(segments.length, 2);
  assert.equal(segments[1].transition, "cut");
});
check("re-covering styled segments is idempotent", () => {
  const styled: BrollCoverageAsset[] = [
    { src: "/a.mp4", start: 0, end: 2, clipDuration: 6, sourceIndex: 0, fit: "contain" },
    { src: "/b.mp4", start: 2, end: 5, clipDuration: 1.5, sourceIndex: 1, transition: "cut" },
  ];
  // Compared in whole frames: re-quantizing a boundary can drift by one float ulp.
  const frames = (segments: BrollCoverageAsset[]) => segments.map((segment) => [
    segment.src, Math.round(segment.start * FPS), Math.round(segment.end * FPS),
    segment.transition ?? null, segment.fit ?? null,
  ]);
  const first = coverBrollTimeline(styled, styled, 5, FPS).segments;
  const second = coverBrollTimeline(first, first, 5, FPS).segments;
  assert.deepEqual(frames(second), frames(first));
});

console.log("composition cut plan");
check("effective values: window wins, then project default, then today's look", () => {
  assert.equal(effectiveBrollTransition(undefined, undefined), "dissolve");
  assert.equal(effectiveBrollTransition(undefined, "cut"), "cut");
  assert.equal(effectiveBrollTransition("dissolve", "cut"), "dissolve");
  assert.equal(effectiveBrollTransition("cut", undefined), "cut");
  assert.equal(effectiveBrollTransition("bogus", "bogus"), "dissolve");
  assert.equal(effectiveBrollFit(undefined), "cover");
  assert.equal(effectiveBrollFit("contain"), "contain");
  assert.equal(effectiveBrollFit("bogus"), "cover");
});
check("cutAfter[i] = window i ends on a hard cut (the last one: no fade to black)", () => {
  assert.deepEqual(brollCutAfter([{}, {}, {}], undefined), [false, false, false]);
  assert.deepEqual(brollCutAfter([{}, { transition: "cut" }, {}], undefined), [false, true, false]);
  assert.deepEqual(brollCutAfter([{}, { transition: "dissolve" }, {}], "cut"), [true, false, true]);
  assert.deepEqual(brollCutAfter([], "cut"), []);
});

console.log("browser apply journal");
const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
};
const journal: PendingBrollApply = {
  version: 1,
  accountId: "acct",
  projectId: "proj",
  sourceJobId: "job-1",
  idempotencyKey: "editor-v2-broll-rerender-12345678-1234-1234-1234-123456789abc",
  jobId: null,
  draftEdits: [],
  windowEdits: [],
  brollTransition: "cut",
};
check("a project-default-only apply survives a refresh", () => {
  assert.equal(writePendingBrollApply(storage, journal), true);
  const read = readPendingBrollApply(storage, "acct", "proj");
  assert.equal(read.kind, "found");
  assert.equal(read.kind === "found" && read.operation.brollTransition, "cut");
});
check("an empty apply or a bad default is still refused", () => {
  const { brollTransition: _unused, ...withoutDefault } = journal;
  void _unused;
  assert.equal(writePendingBrollApply(storage, withoutDefault as PendingBrollApply), false);
  assert.equal(writePendingBrollApply(storage, { ...journal, brollTransition: "wipe" as "cut" }), false);
});
check("per-window style edits round-trip through the journal", () => {
  const withStyle: PendingBrollApply = {
    ...journal,
    draftEdits: [[0, { transition: "cut", fit: "contain" }]],
    windowEdits: [{ index: 0, transition: "cut", fit: "contain" }],
  };
  delete withStyle.brollTransition;
  assert.equal(writePendingBrollApply(storage, withStyle), true);
  const read = readPendingBrollApply(storage, "acct", "proj");
  assert.equal(read.kind, "found");
});

console.log(`\nAll broll-window-style checks passed (${passed}).`);
