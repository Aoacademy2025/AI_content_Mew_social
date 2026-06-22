// Unit tests for buildBrollWindows (run: npx tsx scripts/verify-broll-windows.ts)
// Groups per-caption captions into ~cadence-second windows that tile the timeline with
// no gaps/overlaps. This is the single source of b-roll count + placement.
import { buildBrollWindows, type BrollWindowCaption } from "../src/lib/broll-windows";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
// N back-to-back captions of `each` seconds
const caps = (n: number, each: number): BrollWindowCaption[] =>
  Array.from({ length: n }, (_, i) => ({ startMs: i * each * 1000, endMs: (i + 1) * each * 1000, text: `c${i}` }));

// 12 × 1.5s captions (=18s), cadence 4 → ~4-5 windows, each spanning ~3 captions
const w = buildBrollWindows(caps(12, 1.5), 4);
check("count ≈ ceil(dur/cadence)", w.length >= 4 && w.length <= 5, `${w.length}`);
check("first window starts at 0", w[0].startMs === 0);
check("last window ends at audio end (18000ms)", w[w.length - 1].endMs === 18000);
check("tiles with no gaps", w.every((win, i) => i === 0 || win.startMs === w[i - 1].endMs));
check("each window span >= cadence except possibly last",
  w.slice(0, -1).every((win) => win.endMs - win.startMs >= 4000));
check("window text concatenates its captions", w[0].text.split(" ").length === (w[0].captionEndIdx - w[0].captionStartIdx + 1));
check("caption indices are contiguous & cover all", w[0].captionStartIdx === 0 && w[w.length - 1].captionEndIdx === 11);

// single caption longer than cadence → its own window
const long = buildBrollWindows([{ startMs: 0, endMs: 6000, text: "x" }], 4);
check("single long caption → 1 window", long.length === 1 && long[0].endMs === 6000);

// empty / invalid input
check("empty → []", buildBrollWindows([], 4).length === 0);
check("invalid caption filtered", buildBrollWindows([{ startMs: 5, endMs: 5, text: "bad" }], 4).length === 0);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll-windows checks passed.");
