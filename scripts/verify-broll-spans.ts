// Unit tests for brollWindowSpans (run: npx tsx scripts/verify-broll-spans.ts)
// Converts config.bgVideos[] (seconds) into per-window timeline spans (ms) for the
// Editor v2 Post-phase timeline's b-roll lane. Missing/invalid input -> [] so callers
// fall back to today's single "บีโรลอัตโนมัติ" block (preserves old-job behavior).
import { brollWindowSpans } from "../src/lib/broll-spans";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// (a) 3-window config -> 3 spans, ms conversion + labels correct
const cfgA = {
  bgVideos: [
    { src: "/renders/a.mp4", start: 0, end: 4, keyword: "cats" },
    { src: "/renders/b.mp4", start: 4, end: 8 },
    { src: "/renders/c.mp4", start: 8, end: 12, keyword: "dogs" },
  ],
};
const spansA = brollWindowSpans(cfgA, 12000);
check("3-window config -> 3 spans", spansA.length === 3, `${spansA.length}`);
check("span 0 ms conversion", spansA[0].startMs === 0 && spansA[0].endMs === 4000);
check("span 1 ms conversion", spansA[1].startMs === 4000 && spansA[1].endMs === 8000);
check("span 2 ms conversion", spansA[2].startMs === 8000 && spansA[2].endMs === 12000);
check("label uses keyword when present", spansA[0].label === "cats" && spansA[2].label === "dogs");
check("label falls back to index when no keyword", spansA[1].label === `คลิป 2`);
check("index carried through in order", spansA[0].index === 0 && spansA[1].index === 1 && spansA[2].index === 2);
check("src carried through", spansA[0].src === "/renders/a.mp4");

// (b) missing bgVideos -> []
check("missing bgVideos -> []", brollWindowSpans({}, 12000).length === 0);
check("null config -> []", brollWindowSpans(null, 12000).length === 0);
check("undefined config -> []", brollWindowSpans(undefined, 12000).length === 0);

// (c) span exceeding durMs clamps
const cfgC = { bgVideos: [{ src: "/renders/d.mp4", start: 10, end: 20 }] };
const spansC = brollWindowSpans(cfgC, 12000);
check("clamps endMs to durMs", spansC.length === 1 && spansC[0].endMs === 12000, `${JSON.stringify(spansC)}`);
check("clamps startMs to durMs range too", spansC[0].startMs === 10000);

// entirely out-of-range (start >= durMs) should drop as zero-width after clamp
const cfgC2 = { bgVideos: [{ src: "/renders/e.mp4", start: 15, end: 20 }] };
const spansC2 = brollWindowSpans(cfgC2, 12000);
check("fully out-of-range span dropped (zero-width after clamp)", spansC2.length === 0, `${spansC2.length}`);

// (d) non-array garbage -> [] (no throw)
check("bgVideos non-array garbage -> []", brollWindowSpans({ bgVideos: "nope" } as unknown as Record<string, unknown>, 12000).length === 0);
check("bgVideos: null -> []", brollWindowSpans({ bgVideos: null } as unknown as Record<string, unknown>, 12000).length === 0);
check("bgVideos: [] -> []", brollWindowSpans({ bgVideos: [] }, 12000).length === 0);
check("garbage config (array) -> [] no throw", brollWindowSpans([1, 2, 3] as unknown as Record<string, unknown>, 12000).length === 0);
check("entries missing start/end -> dropped, no throw", brollWindowSpans({ bgVideos: [{ src: "x" }] } as unknown as Record<string, unknown>, 12000).length === 0);

// sorted by start even if input out of order
const cfgSort = {
  bgVideos: [
    { src: "/renders/late.mp4", start: 8, end: 12, keyword: "late" },
    { src: "/renders/early.mp4", start: 0, end: 4, keyword: "early" },
  ],
};
const spansSort = brollWindowSpans(cfgSort, 12000);
check("sorted by start", spansSort.length === 2 && spansSort[0].label === "early" && spansSort[1].label === "late");

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll-spans checks passed.");
