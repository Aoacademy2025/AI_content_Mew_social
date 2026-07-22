// Unit tests for buildBrollWindows (run: npx tsx scripts/verify-broll-windows.ts)
// Groups per-caption captions into ~cadence-second windows that tile the timeline with
// no gaps/overlaps. This is the single source of b-roll count + placement.
import {
  buildBrollWindows,
  buildFixedCountBrollWindows,
  type BrollWindowCaption,
} from "../src/lib/broll-windows";

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

// Minimized from duckyhero production timings: natural TTS pauses between semantic
// windows must hold the prior visual, not become 0.1–0.3s standalone B-roll cuts.
const duckyGap = buildBrollWindows([
  { startMs: 0, endMs: 6333, text: "first thought" },
  { startMs: 6500, endMs: 10900, text: "second thought" },
], 4, 11200);
check("real TTS pause is absorbed into adjacent windows",
  duckyGap.length === 2
  && duckyGap[0].startMs === 0
  && duckyGap[0].endMs === 6500
  && duckyGap[1].startMs === 6500
  && duckyGap[1].endMs === 11200,
  JSON.stringify(duckyGap.map(({ startMs, endMs }) => [startMs, endMs])));
check("real TTS windows tile the full audio timeline",
  duckyGap.every((win, i) => i === 0 || win.startMs === duckyGap[i - 1].endMs));

// Manual count is a user contract, not a sampling hint. A long 120s video with
// "5 B-roll" must become five contiguous semantic chapters, so downstream AI
// generation receives exactly five subjects and never cycles an asset.
const manualFive = buildFixedCountBrollWindows(caps(24, 5), 5, 120_000);
check("manual count 5 → exactly 5 timeline windows", manualFive.length === 5, `${manualFive.length}`);
check("manual windows tile the whole 120s timeline",
  manualFive[0]?.startMs === 0
  && manualFive[manualFive.length - 1]?.endMs === 120_000
  && manualFive.every((win, i) => i === 0 || win.startMs === manualFive[i - 1].endMs),
  JSON.stringify(manualFive.map(({ startMs, endMs }) => [startMs, endMs])));
check("manual chapters keep every caption exactly once",
  manualFive[0]?.captionStartIdx === 0
  && manualFive[manualFive.length - 1]?.captionEndIdx === 23
  && manualFive.every((win, i) => i === 0 || win.captionStartIdx === manualFive[i - 1].captionEndIdx + 1));

// If a user asks for more visuals than there are subtitle cards, the visual
// timeline still honors the explicit count by splitting time (without gaps).
const manualFourFromTwo = buildFixedCountBrollWindows(caps(2, 10), 4, 20_000);
check("manual count remains exact when captions are fewer", manualFourFromTwo.length === 4);
check("time-split manual windows still tile the timeline",
  manualFourFromTwo.every((win, i) => i === 0 || win.startMs === manualFourFromTwo[i - 1].endMs)
  && manualFourFromTwo[3]?.endMs === 20_000);

// empty / invalid input
check("empty → []", buildBrollWindows([], 4).length === 0);
check("invalid caption filtered", buildBrollWindows([{ startMs: 5, endMs: 5, text: "bad" }], 4).length === 0);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll broll-windows checks passed.");
