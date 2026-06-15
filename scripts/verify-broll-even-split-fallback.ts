// Verify the generate-config blank-b-roll safety net (evenSplitBgVideos).
//
// Bug (confirmed in prod audit 2026-06-15): for some jobs the scene/per-subtitle mapping
// produced ZERO bgVideos, so the old fallback froze ONE clip over the whole video — e.g. an
// 81-scene clip rendered with a single looping b-roll = looks like "b-roll never loaded".
// The fix even-splits ALL fetched clips instead. This proves it.
//
// Run: npx tsx scripts/verify-broll-even-split-fallback.ts
import { evenSplitBgVideos, cyclePoolIndices } from "../src/lib/broll-even-split";

function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  const mkStocks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ localUrl: `/api/stocks/clip-${i}.mp4`, videoUrl: `https://x/${i}`, duration: 10 }));

  // ── the regression case: 34 clips, 64.7s video (matches the broken sahapanu 81-scene clip) ──
  const segs = evenSplitBgVideos(mkStocks(34), 64.758);
  check("uses ALL clips, not 1 (the blank-b-roll fix)", segs.length === 34, `got ${segs.length}`);
  check("every clip src is unique (no single frozen clip)", new Set(segs.map((s) => s.src)).size === 34);
  check("starts at 0", segs[0].start === 0);
  check("ends exactly at audio duration (no float drift)", segs[segs.length - 1].end === 64.758, `got ${segs[segs.length - 1].end}`);
  const contiguous = segs.every((s, i) => i === 0 || Math.abs(s.start - segs[i - 1].end) < 1e-9);
  check("segments are contiguous (no gaps → no blank stretches)", contiguous);
  const allForward = segs.every((s) => s.end > s.start);
  check("every segment has positive duration", allForward);

  // ── edge: a single clip → one full-length segment (still valid, not a crash) ──
  const one = evenSplitBgVideos(mkStocks(1), 30);
  check("1 clip → 1 segment covering the whole video", one.length === 1 && one[0].start === 0 && one[0].end === 30);

  // ── edge: no usable clips / bad duration → empty (caller keeps its own guard) ──
  check("no clips → []", evenSplitBgVideos([], 30).length === 0);
  check("clips without any url are skipped", evenSplitBgVideos([{ duration: 5 } as never], 30).length === 0);
  check("zero/negative duration → []", evenSplitBgVideos(mkStocks(5), 0).length === 0);

  // ── carries selection metadata through (so debugging/overlay still works) ──
  const withMeta = evenSplitBgVideos([{ localUrl: "/a.mp4", duration: 8, keyword: "drone", provider: "pixabay" }], 12);
  check("preserves keyword/provider metadata", withMeta[0].keyword === "drone" && withMeta[0].provider === "pixabay");

  // ── cyclePoolIndices: the dense-mode collapse fix (per-subtitle clip assignment) ──
  // The regression case: 81 short captions, 34 clips. The OLD merge scheme collapsed every
  // caption to pool[0] (1 clip, ratio=1%). Cycling must use ALL clips and never collapse.
  const idx = cyclePoolIndices(81, 34);
  check("cycle: one index per caption", idx.length === 81);
  check("cycle: uses ALL 34 clips (no collapse to a single frozen clip)", new Set(idx).size === 34, `distinct=${new Set(idx).size}`);
  check("cycle: adjacent captions get DIFFERENT clips (b-roll changes)", idx.every((v, i) => i === 0 || v !== idx[i - 1]));
  check("cycle: first 34 are 0..33 in order (on-topic 1:1 match preserved)", idx.slice(0, 34).every((v, i) => v === i));
  check("cycle: wraps after the pool (caption 34 → clip 0)", idx[34] === 0);
  // edge cases
  check("cycle: poolSize 1 → all 0 (only one clip available — can't change)", cyclePoolIndices(5, 1).every((v) => v === 0));
  check("cycle: 0 captions → []", cyclePoolIndices(0, 34).length === 0);
  check("cycle: poolSize 0 → all 0 (defensive, no divide-by-zero)", cyclePoolIndices(3, 0).join(",") === "0,0,0");

  console.log(failures === 0 ? "\n✅ ALL EVEN-SPLIT FALLBACK CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
