// Unit tests for the PURE b-roll re-render merge/validation helpers
// (run: npx tsx scripts/verify-broll-rerender.ts — no DB, no network).
//
// validateWindowEdits: shape/whitelist gate for the client-sent window edits.
//   - replacement src MUST match /^\/api\/(renders|stocks)\/[\w.-]+\.mp4$/ (single flat
//     file, no traversal, no external host, .mp4 only) — this is the ONLY place a
//     client-named asset path enters the re-render, so a hostile src must be rejected here.
//   - visibility-only edits carry enabled:boolean and never need a client-supplied src.
//   - index int >= 0; 1..40 edits; dedupe by index (last wins).
// mergeWindowEdits: apply validated edits onto the SOURCE preview's bgVideos[].
//   - NEVER touches start/end (window timing is locked — subtitle invariant); never reorders.
//   - per edited window: replace src (+ keyword/duration when given), set clipOffset 0,
//     and STRIP stale source metadata (provider/title/query/selectionReason/relevanceScore) so
//     the inspector badge reflects the NEW asset. UNEDITED windows keep all metadata.
//   - enabled is persisted as brollEnabled on the server-owned source window.
//   - bounds-checks index against the source bgVideos length (atomic: any OOB index => error,
//     no partial merge).
import {
  firstPassVisualRejectionReasonForWindow,
  validateWindowEdits,
  mergeWindowEdits,
  rerenderSkipEligible,
  type WindowEdit,
} from "../src/lib/broll-rerender";
import { resolveBrollPlaybackPlan } from "../src/lib/broll-playback";
import { readFileSync } from "node:fs";

let failures = 0;
let passed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failures++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const isErr = (v: unknown): v is { error: string } =>
  typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);

// ── validateWindowEdits ───────────────────────────────────────────────────────

// happy path: valid edits pass, dedupe not triggered
{
  const r = validateWindowEdits([{ index: 0, src: "/api/stocks/stock-1.mp4" }, { index: 2, src: "/api/renders/render-x.mp4", keyword: "coffee" }]);
  check("valid edits accepted", !isErr(r) && (r as WindowEdit[]).length === 2, JSON.stringify(r));
  if (!isErr(r)) {
    check("keyword carried when given", (r as WindowEdit[])[1].keyword === "coffee");
    check("keyword absent when omitted", (r as WindowEdit[])[0].keyword === undefined);
  }
}

// src whitelist — accept both /api/renders and /api/stocks
check("accepts /api/renders/*.mp4", !isErr(validateWindowEdits([{ index: 0, src: "/api/renders/render-1700000000000-abc.mp4" }])));
check("accepts /api/stocks/*.mp4", !isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/stock-user-window-pexels-abc123.mp4" }])));
check("accepts visibility-only disable", !isErr(validateWindowEdits([{ index: 0, enabled: false }])));
check("accepts visibility-only enable", !isErr(validateWindowEdits([{ index: 0, enabled: true }])));
{
  const r = validateWindowEdits([{ index: 0, src: "/api/stocks/new.mp4", replacementKind: "stock" }]);
  check("accepts and preserves replacement kind for acceptance telemetry", !isErr(r) && r[0].replacementKind === "stock", JSON.stringify(r));
}
{
  const r = validateWindowEdits([{
    index: 0,
    src: "/api/stocks/broll-ai-candidate.mp4",
    replacementKind: "ai",
    imageJobId: "cm1234567890scenejob",
  }]);
  check(
    "accepts and preserves an AI candidate job until deliberate Apply",
    !isErr(r) && r[0].imageJobId === "cm1234567890scenejob",
    JSON.stringify(r),
  );
}
check("rejects image job id on a Stock replacement", isErr(validateWindowEdits([{
  index: 0,
  src: "/api/stocks/new.mp4",
  replacementKind: "stock",
  imageJobId: "cm1234567890scenejob",
}])));
check("rejects image job id without an AI replacement source", isErr(validateWindowEdits([{
  index: 0,
  enabled: true,
  imageJobId: "cm1234567890scenejob",
}])));
check("rejects malformed image job id", isErr(validateWindowEdits([{
  index: 0,
  src: "/api/stocks/broll-ai-candidate.mp4",
  replacementKind: "ai",
  imageJobId: "../../another-job",
}])));
check("rejects unknown replacement kind", isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/new.mp4", replacementKind: "other" }])));
check("rejects replacement kind without source", isErr(validateWindowEdits([{ index: 0, enabled: false, replacementKind: "stock" }])));
check("rejects edit without replacement or visibility change", isErr(validateWindowEdits([{ index: 0 }])));
check("rejects non-boolean enabled", isErr(validateWindowEdits([{ index: 0, enabled: "no" as unknown as boolean }])));

// src whitelist — reject hostile / malformed sources
check("rejects external host url", isErr(validateWindowEdits([{ index: 0, src: "https://evil.example.com/x.mp4" }])));
check("rejects protocol-relative url", isErr(validateWindowEdits([{ index: 0, src: "//evil.example.com/x.mp4" }])));
check("rejects path traversal", isErr(validateWindowEdits([{ index: 0, src: "/api/renders/../../etc/passwd" }])));
check("rejects traversal that ends in .mp4", isErr(validateWindowEdits([{ index: 0, src: "/api/renders/../secret.mp4" }])));
check("rejects nested subdir", isErr(validateWindowEdits([{ index: 0, src: "/api/renders/sub/dir/file.mp4" }])));
check("rejects non-mp4 extension", isErr(validateWindowEdits([{ index: 0, src: "/api/renders/x.png" }])));
check("rejects wrong route prefix (music)", isErr(validateWindowEdits([{ index: 0, src: "/api/music/x.mp4" }])));
check("rejects bare /renders (no /api)", isErr(validateWindowEdits([{ index: 0, src: "/renders/x.mp4" }])));
check("rejects backslash", isErr(validateWindowEdits([{ index: 0, src: "/api/renders/x\\y.mp4" }])));
check("rejects empty src", isErr(validateWindowEdits([{ index: 0, src: "" }])));

// index validation
check("rejects negative index", isErr(validateWindowEdits([{ index: -1, src: "/api/stocks/a.mp4" }])));
check("rejects non-integer index", isErr(validateWindowEdits([{ index: 1.5, src: "/api/stocks/a.mp4" }])));
check("rejects non-number index", isErr(validateWindowEdits([{ index: "0" as unknown as number, src: "/api/stocks/a.mp4" }])));
check("accepts index 0", !isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4" }])));

// keyword validation
check("rejects non-string keyword", isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", keyword: 5 as unknown as string }])));
check("rejects keyword without replacement src", isErr(validateWindowEdits([{ index: 0, enabled: false, keyword: "unused" }])));

// replacement duration is server-derived metadata from upload/select/generate. Keeping it lets
// Remotion loop a short replacement instead of exposing the following B-roll before the locked
// subtitle window ends (production incident: 3.53s upload inside a 4.70s window).
{
  const r = validateWindowEdits([{ index: 0, src: "/api/stocks/short.mp4", clipDuration: 3.533 }]);
  check("accepts positive replacement clipDuration", !isErr(r), JSON.stringify(r));
  if (!isErr(r)) check("replacement clipDuration is preserved by validation", r[0].clipDuration === 3.533);
}
check("rejects zero clipDuration", isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", clipDuration: 0 }])));
check("rejects negative clipDuration", isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", clipDuration: -1 }])));
check("rejects non-numeric clipDuration", isErr(validateWindowEdits([{ index: 0, src: "/api/stocks/a.mp4", clipDuration: "3" }])));
check("rejects clipDuration without replacement src", isErr(validateWindowEdits([{ index: 0, enabled: true, clipDuration: 3 }])));

// count bounds
check("rejects empty array (0 edits)", isErr(validateWindowEdits([])));
check("rejects non-array", isErr(validateWindowEdits({ index: 0, src: "/api/stocks/a.mp4" } as unknown)));
check("rejects null", isErr(validateWindowEdits(null)));
{
  const forty = Array.from({ length: 40 }, (_, i) => ({ index: i, src: "/api/stocks/a.mp4" }));
  check("accepts exactly 40 edits", !isErr(validateWindowEdits(forty)));
  const fortyOne = Array.from({ length: 41 }, (_, i) => ({ index: i, src: "/api/stocks/a.mp4" }));
  check("rejects 41 edits (>40)", isErr(validateWindowEdits(fortyOne)));
}

// dedupe: same index twice -> last wins
{
  const r = validateWindowEdits([
    { index: 1, src: "/api/stocks/first.mp4", keyword: "old" },
    { index: 1, src: "/api/stocks/second.mp4", keyword: "new" },
  ]);
  check("dedupe collapses same index", !isErr(r) && (r as WindowEdit[]).length === 1, JSON.stringify(r));
  if (!isErr(r)) {
    check("dedupe keeps LAST src", (r as WindowEdit[])[0].src === "/api/stocks/second.mp4");
    check("dedupe keeps LAST keyword", (r as WindowEdit[])[0].keyword === "new");
  }
}

// ── mergeWindowEdits ──────────────────────────────────────────────────────────

const srcBg = [
  { src: "/api/stocks/orig-0.mp4", start: 0, end: 4, clipOffset: 1.5, clipDuration: 3, keyword: "cats", provider: "pexels" },
  { src: "/api/stocks/orig-1.mp4", start: 4, end: 8, clipOffset: 0, clipDuration: 4, keyword: "dogs" },
  { src: "/api/stocks/orig-2.mp4", start: 8, end: 12, clipDuration: 4, keyword: "birds" },
];

// valid merge: only edited window changes; start/end untouched; clipOffset->0; replacement
// clipDuration preserved so short assets can loop for the complete locked window.
{
  const edits = validateWindowEdits([{ index: 1, src: "/api/renders/new-1.mp4", keyword: "puppies", clipDuration: 3.533 }]);
  const m = mergeWindowEdits(structuredClone(srcBg), edits as WindowEdit[]);
  check("merge succeeds", !isErr(m), JSON.stringify(m));
  if (!isErr(m)) {
    const out = m.bgVideos;
    check("length preserved (no reorder/add/drop)", out.length === 3);
    // edited window (index 1)
    check("edited src replaced", out[1].src === "/api/renders/new-1.mp4");
    check("edited keyword replaced", out[1].keyword === "puppies");
    check("edited clipOffset reset to 0", out[1].clipOffset === 0);
    check("edited replacement clipDuration preserved", out[1].clipDuration === 3.533);
    check("edited start UNTOUCHED", out[1].start === 4);
    check("edited end UNTOUCHED", out[1].end === 8);
    // untouched windows are byte-identical
    check("window 0 untouched src", out[0].src === "/api/stocks/orig-0.mp4");
    check("window 0 keeps clipDuration", out[0].clipDuration === 3);
    check("window 0 keeps clipOffset", out[0].clipOffset === 1.5);
    check("window 2 untouched", out[2].src === "/api/stocks/orig-2.mp4" && out[2].clipDuration === 4);
  }
}

// Playback plan for the exact production shape: 4.70s (141f) target and 3.53s (106f)
// replacement. The source must loop after its guarded usable range instead of ending early.
{
  const plan = resolveBrollPlaybackPlan({ startFrom: 0, totalFrames: 141, clipDurFrames: 106 });
  check("short replacement produces a loop plan", plan.loopDurationInFrames === 104, JSON.stringify(plan));
  check("short replacement never decodes past its guarded source end", plan.endAt === 104, JSON.stringify(plan));
}
{
  const plan = resolveBrollPlaybackPlan({ startFrom: 0, totalFrames: 90, clipDurFrames: 150 });
  check("long replacement does not loop", plan.loopDurationInFrames === null, JSON.stringify(plan));
  check("long replacement keeps the requested playback range", plan.endAt === 90, JSON.stringify(plan));
}

// edit WITHOUT keyword keeps the window's existing keyword
{
  const edits = validateWindowEdits([{ index: 0, src: "/api/renders/new-0.mp4" }]);
  const m = mergeWindowEdits(structuredClone(srcBg), edits as WindowEdit[]);
  check("merge (no keyword) succeeds", !isErr(m));
  if (!isErr(m)) {
    check("src replaced without keyword", m.bgVideos[0].src === "/api/renders/new-0.mp4");
    check("existing keyword preserved when edit omits it", m.bgVideos[0].keyword === "cats");
    check("clipOffset reset to 0", m.bgVideos[0].clipOffset === 0);
    check("clipDuration dropped", !("clipDuration" in m.bgVideos[0]));
  }
}

// visibility-only edit: source/timing stay intact and brollEnabled is explicit so cutaway
// projects can override their alternating default in either direction.
{
  const edits = validateWindowEdits([{ index: 1, enabled: false }]);
  const m = mergeWindowEdits(structuredClone(srcBg), edits as WindowEdit[]);
  check("visibility-only merge succeeds", !isErr(m), JSON.stringify(m));
  if (!isErr(m)) {
    check("disable persists brollEnabled=false", m.bgVideos[1].brollEnabled === false);
    check("disable keeps source", m.bgVideos[1].src === srcBg[1].src);
    check("disable keeps timing", m.bgVideos[1].start === 4 && m.bgVideos[1].end === 8);
    check("disable keeps clip metadata", m.bgVideos[1].clipDuration === 4 && m.bgVideos[1].clipOffset === 0);
  }
}
{
  const hidden = structuredClone(srcBg);
  hidden[1] = { ...hidden[1], brollEnabled: false };
  const edits = validateWindowEdits([{ index: 1, enabled: true }]);
  const m = mergeWindowEdits(hidden, edits as WindowEdit[]);
  check("visibility enable merge succeeds", !isErr(m), JSON.stringify(m));
  if (!isErr(m)) {
    check("enable persists brollEnabled=true", m.bgVideos[1].brollEnabled === true);
    check("enable keeps timing", m.bgVideos[1].start === 4 && m.bgVideos[1].end === 8);
  }
}

// replacement and visibility may be batched on the same window without changing timing.
{
  const edits = validateWindowEdits([{
    index: 2,
    src: "/api/stocks/replacement-visible.mp4",
    keyword: "new scene",
    enabled: true,
  }]);
  const m = mergeWindowEdits(structuredClone(srcBg), edits as WindowEdit[]);
  check("combined replacement + visibility merge succeeds", !isErr(m), JSON.stringify(m));
  if (!isErr(m)) {
    check("combined edit replaces source", m.bgVideos[2].src === "/api/stocks/replacement-visible.mp4");
    check("combined edit enables window", m.bgVideos[2].brollEnabled === true);
    check("combined edit keeps timing", m.bgVideos[2].start === 8 && m.bgVideos[2].end === 12);
  }
}

// out-of-range index -> error (atomic: nothing merged)
{
  const edits: WindowEdit[] = [{ index: 3, src: "/api/stocks/oob.mp4" }];
  const m = mergeWindowEdits(structuredClone(srcBg), edits);
  check("out-of-range index rejected", isErr(m), JSON.stringify(m));
}
{
  // mixed: one valid + one OOB -> whole merge rejected (no partial)
  const edits: WindowEdit[] = [{ index: 0, src: "/api/stocks/ok.mp4" }, { index: 99, src: "/api/stocks/oob.mp4" }];
  const m = mergeWindowEdits(structuredClone(srcBg), edits);
  check("any OOB index rejects the whole merge", isErr(m));
}

// empty / invalid source bgVideos -> error
check("empty source bgVideos rejected", isErr(mergeWindowEdits([], [{ index: 0, src: "/api/stocks/a.mp4" }])));
check("non-array source bgVideos rejected", isErr(mergeWindowEdits(null as unknown as unknown[], [{ index: 0, src: "/api/stocks/a.mp4" }])));

// First-pass rejection telemetry is scoped to windows that were AI in the SOURCE preview.
// An edit's replacement kind alone must never turn a Stock AutoMix window into an AI rejection.
check(
  "Stock source replaced with Stock is not an AI first-pass rejection",
  firstPassVisualRejectionReasonForWindow(
    { src: "/api/stocks/original.mp4", provider: "pexels" },
    { index: 0, src: "/api/stocks/replacement.mp4", replacementKind: "stock" },
  ) === null,
);
check(
  "AI provider source replaced with Stock records a Stock rejection",
  firstPassVisualRejectionReasonForWindow(
    { src: "/api/stocks/generated.mp4", provider: "runpod" },
    { index: 0, src: "/api/stocks/replacement.mp4", replacementKind: "stock" },
  ) === "stock_replacement",
);
check(
  "applied AI filename source disabled records an AI first-pass rejection",
  firstPassVisualRejectionReasonForWindow(
    { src: "/api/stocks/broll-ai-existing.mp4" },
    { index: 0, enabled: false },
  ) === "broll_disabled",
);

// merge does not mutate the caller's input array/objects
{
  const original = structuredClone(srcBg);
  const edits: WindowEdit[] = [{ index: 1, src: "/api/renders/z.mp4" }];
  mergeWindowEdits(original, edits);
  check("source input not mutated by merge", original[1].src === "/api/stocks/orig-1.mp4" && original[1].clipDuration === 4);
}

// ── stale source-metadata stripping (Finding 2) ────────────────────────────────
// An edited window must DROP the old asset's provider/title/query/selectionReason/relevanceScore
// so the inspector badge reflects the NEW source — but timing (start/end) and keyword handling
// stay exactly as before.
const metaBg = [
  { src: "/api/stocks/orig-0.mp4", start: 0, end: 4, clipOffset: 0.5, clipDuration: 3,
    keyword: "cats", provider: "pexels", title: "A cat", query: "cats playing",
    selectionReason: "top match", relevanceScore: 0.9 },
];
{
  const edits = validateWindowEdits([{ index: 0, src: "/api/stocks/broll-ai-123.mp4" }]);
  const m = mergeWindowEdits(structuredClone(metaBg), edits as WindowEdit[]);
  check("merge (metadata strip) succeeds", !isErr(m), JSON.stringify(m));
  if (!isErr(m)) {
    const w = m.bgVideos[0];
    check("edited src replaced (strip case)", w.src === "/api/stocks/broll-ai-123.mp4");
    check("stale provider stripped", !("provider" in w));
    check("stale title stripped", !("title" in w));
    check("stale query stripped", !("query" in w));
    check("stale selectionReason stripped", !("selectionReason" in w));
    check("stale relevanceScore stripped", !("relevanceScore" in w));
    check("edited start UNTOUCHED (strip case)", w.start === 0);
    check("edited end UNTOUCHED (strip case)", w.end === 4);
    check("edited clipOffset reset (strip case)", w.clipOffset === 0);
    check("edited clipDuration dropped (strip case)", !("clipDuration" in w));
    check("existing keyword preserved when edit omits it (strip case)", w.keyword === "cats");
  }
}

// keyword provided by the edit replaces the stale one; metadata still stripped
{
  const edits = validateWindowEdits([{ index: 0, src: "/api/stocks/broll-upload-9.mp4", keyword: "new kw" }]);
  const m = mergeWindowEdits(structuredClone(metaBg), edits as WindowEdit[]);
  check("merge (keyword + strip) succeeds", !isErr(m));
  if (!isErr(m)) {
    const w = m.bgVideos[0];
    check("keyword replaced when edit supplies it (strip case)", w.keyword === "new kw");
    check("provider stripped (keyword case)", !("provider" in w));
    check("title stripped (keyword case)", !("title" in w));
    check("start/end untouched (keyword case)", w.start === 0 && w.end === 4);
  }
}

// UNEDITED windows keep ALL their metadata — stripping only touches edited windows
{
  const bg = [
    { src: "/api/stocks/keep-0.mp4", start: 0, end: 4, provider: "pexels", title: "keep",
      query: "q", selectionReason: "r", relevanceScore: 0.7, clipDuration: 4 },
    { src: "/api/stocks/edit-1.mp4", start: 4, end: 8, provider: "pixabay", title: "gone",
      query: "gq", selectionReason: "gr", relevanceScore: 0.3 },
  ];
  const edits = validateWindowEdits([{ index: 1, src: "/api/renders/x.mp4" }]);
  const m = mergeWindowEdits(structuredClone(bg), edits as WindowEdit[]);
  check("merge (partial strip) succeeds", !isErr(m));
  if (!isErr(m)) {
    check("unedited window keeps provider", m.bgVideos[0].provider === "pexels");
    check("unedited window keeps title", m.bgVideos[0].title === "keep");
    check("unedited window keeps query/selectionReason/relevanceScore",
      m.bgVideos[0].query === "q" && m.bgVideos[0].selectionReason === "r" && m.bgVideos[0].relevanceScore === 0.7);
    check("unedited window keeps clipDuration", m.bgVideos[0].clipDuration === 4);
    check("edited window strips provider (partial)", !("provider" in m.bgVideos[1]));
    check("edited window strips title (partial)", !("title" in m.bgVideos[1]));
    check("edited window strips query (partial)", !("query" in m.bgVideos[1]));
    check("edited window start/end untouched (partial)", m.bgVideos[1].start === 4 && m.bgVideos[1].end === 8);
  }
}

// ── rerenderSkipEligible (billing-bypass finding) ───────────────────────────────
// The FREE `rerenderOf` charge-skip must bind to the paid source's DURATION *and* AUDIO. Binding
// only the frame count let a caller keep the same length but swap in a different soundtrack/scenes
// for free (minute-quota bypass). A legit per-window edit reuses the source's voiceFile verbatim
// (orchestrator's rrBaseConfig = { ...preview.config, bgVideos, keywordPopups: [] }), so it still
// qualifies. Any mismatch → false → the route falls through to NORMAL charging (never an error).
const voiceA = "/api/renders/tts-1700000000000-aaaa.mp3";
const voiceB = "/api/renders/tts-1700000000000-bbbb.mp3";
const srcCfg = { durationInFrames: 900, voiceFile: voiceA };

// (a) same duration + same voiceFile (verbatim — the legit orchestrator path) ⇒ ELIGIBLE.
//     Incoming carries DIFFERENT bgVideos/captions (the point of the edit) — those don't matter.
check("skip: same duration + same voiceFile ⇒ eligible", rerenderSkipEligible({
  sourceConfig: srcCfg,
  incomingConfig: { durationInFrames: 900, voiceFile: voiceA, bgVideos: [{ src: "/api/stocks/new.mp4" }], captions: [{ text: "x" }] },
}) === true);

// (b) same duration + DIFFERENT voiceFile (swapped soundtrack) ⇒ NOT eligible (falls through → charges).
check("skip: same duration + different voiceFile ⇒ NOT eligible", rerenderSkipEligible({
  sourceConfig: srcCfg,
  incomingConfig: { durationInFrames: 900, voiceFile: voiceB },
}) === false);

// duration mismatch ⇒ NOT eligible (existing invariant preserved).
check("skip: different duration ⇒ NOT eligible", rerenderSkipEligible({
  sourceConfig: srcCfg,
  incomingConfig: { durationInFrames: 1200, voiceFile: voiceA },
}) === false);

// source has NO voiceFile ⇒ NOT eligible (can't bind audio identity → never a free bypass).
check("skip: source without voiceFile ⇒ NOT eligible", rerenderSkipEligible({
  sourceConfig: { durationInFrames: 900 },
  incomingConfig: { durationInFrames: 900, voiceFile: voiceA },
}) === false);

// incoming omits voiceFile ⇒ NOT eligible.
check("skip: incoming without voiceFile ⇒ NOT eligible", rerenderSkipEligible({
  sourceConfig: srcCfg,
  incomingConfig: { durationInFrames: 900 },
}) === false);

// canonicalization: the /renders/ mirror + absolute-URL form of the SAME file still count as SAME audio.
check("skip: /renders mirror of same voice ⇒ eligible", rerenderSkipEligible({
  sourceConfig: srcCfg,
  incomingConfig: { durationInFrames: 900, voiceFile: "/renders/tts-1700000000000-aaaa.mp3" },
}) === true);
check("skip: absolute-URL form of same voice ⇒ eligible", rerenderSkipEligible({
  sourceConfig: srcCfg,
  incomingConfig: { durationInFrames: 900, voiceFile: "https://studio.heroaiengine.com" + voiceA },
}) === true);

// zero/negative/NaN frames and null/garbage configs ⇒ NOT eligible.
check("skip: zero frames ⇒ NOT eligible", rerenderSkipEligible({
  sourceConfig: { durationInFrames: 0, voiceFile: voiceA }, incomingConfig: { durationInFrames: 0, voiceFile: voiceA },
}) === false);
check("skip: null configs ⇒ NOT eligible", rerenderSkipEligible({ sourceConfig: null, incomingConfig: null }) === false);
check("skip: undefined incoming ⇒ NOT eligible", rerenderSkipEligible({ sourceConfig: srcCfg, incomingConfig: undefined }) === false);

const postPhaseSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
  "utf8",
);
const inspectorSource = readFileSync(
  "src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx",
  "utf8",
);
const compositionSource = readFileSync("src/remotion/ShortVideoComposition.tsx", "utf8");
check(
  "b-roll rerender client supplies an explicit operation-scoped idempotency key",
  /idempotencyKey:\s*`editor-v2-broll-rerender-\$\{globalThis\.crypto\.randomUUID\(\)\}`/u.test(postPhaseSource),
);
check(
  "b-roll inspector stages server-derived replacement duration",
  /markEdited\([^\n]+d\.clipDuration\)/u.test(inspectorSource),
);
check(
  "b-roll rerender payload carries staged replacement duration",
  /typeof e\.clipDuration === "number" \? \{ clipDuration: e\.clipDuration \} : \{\}/u.test(postPhaseSource),
);
check(
  "Remotion composition applies the short-source loop plan",
  /<Loop durationInFrames=\{playback\.loopDurationInFrames\}/u.test(compositionSource),
);

if (failures) { console.error(`\n${failures} FAILED (${passed} passed)`); process.exit(1); }
console.log(`\nALL ${passed} BROLL-RERENDER CHECKS PASSED`);
