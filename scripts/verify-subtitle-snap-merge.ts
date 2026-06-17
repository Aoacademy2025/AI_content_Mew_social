// Verify the 2026-06-17 subtitle fix in src/lib/tts-timing.ts:
//   • snapCaptionsToSilences(target:"onset") snaps a between-card boundary to the
//     pause END (speech onset), not the midpoint (legacy "midpoint" still works).
//   • degenerate intervals {s:m,e:m} reproduce legacy behaviour (back-compat).
//   • mergeShortCaptions folds too-short captions into the previous one.
//   • the minCardMs guard prevents crushing a card.
// Run: npx tsx scripts/verify-subtitle-snap-merge.ts
import { snapCaptionsToSilences, mergeShortCaptions, splitCardsAtSilences, type SilenceInterval, type TimedWord, type ScriptCard } from "@/lib/tts-timing";

let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else { fail++; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
const caps = (...xs: [string, number, number][]) => xs.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

// A) onset snap → boundary moves to silence END
{
  const c = caps(["A", 0, 1000], ["B", 1000, 3000]);
  const sil: SilenceInterval[] = [{ startMs: 900, endMs: 1400 }];
  snapCaptionsToSilences(c, sil, { target: "onset" });
  check("onset: boundary snaps to silence_end (1400)", c[0].endMs === 1400 && c[1].startMs === 1400,
    `A.end=${c[0].endMs} B.start=${c[1].startMs}`);
}
// B) midpoint mode → boundary moves to pause centre (legacy)
{
  const c = caps(["A", 0, 1000], ["B", 1000, 3000]);
  snapCaptionsToSilences(c, [{ startMs: 900, endMs: 1400 }], { target: "midpoint" });
  check("midpoint: boundary snaps to centre (1150)", c[0].endMs === 1150 && c[1].startMs === 1150,
    `A.end=${c[0].endMs}`);
}
// C) degenerate interval (only a midpoint known) → onset == midpoint == back-compat
{
  const c1 = caps(["A", 0, 1000], ["B", 1000, 3000]);
  const c2 = caps(["A", 0, 1000], ["B", 1000, 3000]);
  snapCaptionsToSilences(c1, [{ startMs: 1150, endMs: 1150 }], { target: "onset" });
  snapCaptionsToSilences(c2, [{ startMs: 1150, endMs: 1150 }], { target: "midpoint" });
  check("degenerate interval: onset behaves like legacy midpoint", c1[0].endMs === 1150 && c2[0].endMs === 1150,
    `onset=${c1[0].endMs} mid=${c2[0].endMs}`);
}
// D) minCardMs guard: snap skipped if it would crush a card
{
  const c = caps(["A", 0, 1000], ["B", 1000, 1100]); // B only 100ms total
  snapCaptionsToSilences(c, [{ startMs: 950, endMs: 1080 }], { target: "onset", minCardMs: 240 });
  check("guard: snap skipped when it would crush a card", c[0].endMs === 1000 && c[1].startMs === 1000,
    `A.end=${c[0].endMs} B.start=${c[1].startMs}`);
}
// E) merge: short caption folds into previous; long ones untouched; count drops
{
  const c = caps(["A", 0, 1000], ["B", 1000, 1300], ["C", 1300, 2600]); // B=300ms < 600
  const out = mergeShortCaptions(c, 600);
  check("merge: short caption folded into previous", out.length === 2 && out[0].text === "A B" && out[0].endMs === 1300,
    JSON.stringify(out.map((x) => [x.text, x.startMs, x.endMs])));
  check("merge: long caption preserved", out[1].text === "C" && out[1].startMs === 1300);
}
// F) merge minMs<=0 → no-op
{
  const c = caps(["A", 0, 300], ["B", 300, 600]);
  const out = mergeShortCaptions(c, 0);
  check("merge: minMs<=0 is a no-op", out.length === 2);
}
// G) first caption never merges backward
{
  const c = caps(["A", 0, 300], ["B", 300, 1500]); // A short & first
  const out = mergeShortCaptions(c, 600);
  check("merge: first (short) caption is kept, not dropped", out.length === 2 && out[0].text === "A");
}
// H) no silences / single caption → returned unchanged
{
  const c = caps(["only", 0, 1000]);
  snapCaptionsToSilences(c, [{ startMs: 100, endMs: 200 }], { target: "onset" });
  check("snap: single caption untouched", c.length === 1 && c[0].endMs === 1000);
}
// I) splitCardsAtSilences: a card straddling a pause is split at the word ending near it
{
  // one card spanning chars 0..20; words: wordA ends@char10 (endMs 2000), wordB ends@char20 (endMs 4000)
  const words: TimedWord[] = [
    { word: "A", startChar: 0, endChar: 10, startMs: 0, endMs: 2000 },
    { word: "B", startChar: 10, endChar: 20, startMs: 2100, endMs: 4000 },
  ];
  const cards: ScriptCard[] = [{ startChar: 0, endChar: 20, tag: "hook" }];
  const sil: SilenceInterval[] = [{ startMs: 2000, endMs: 2100 }]; // pause right after wordA
  const out = splitCardsAtSilences(cards, words, sil);
  check("split: card straddling a pause is split at the word boundary", out.length === 2 && out[0].endChar === 10 && out[1].startChar === 10,
    JSON.stringify(out));
  check("split: first piece keeps tag, second has none", out[0].tag === "hook" && out[1].tag === undefined);
}
// J) splitCardsAtSilences: no straddled pause → cards unchanged
{
  const words: TimedWord[] = [{ word: "A", startChar: 0, endChar: 10, startMs: 0, endMs: 2000 }];
  const cards: ScriptCard[] = [{ startChar: 0, endChar: 10 }];
  const out = splitCardsAtSilences(cards, words, [{ startMs: 5000, endMs: 5200 }]); // pause far from any word end
  check("split: no straddled pause leaves cards unchanged", out.length === 1 && out[0].endChar === 10);
}
// K) mergeShortCaptions pause-aware: a short caption that BEGINS at a pause is NOT merged back
{
  const c = caps(["A", 0, 2000], ["B", 2100, 2400]); // B is 300ms (<600) but starts at a pause
  const out = mergeShortCaptions(c, 600, [{ startMs: 2000, endMs: 2100 }]);
  check("merge: short caption at a real pause is NOT merged across it", out.length === 2 && out[1].text === "B");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
