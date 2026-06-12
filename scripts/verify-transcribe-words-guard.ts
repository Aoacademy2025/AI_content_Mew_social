// Proof of the word-timestamp guards (2026-06): Gemini chunk responses can carry
// bogus/degenerate word timings (prod 06-12: chunk 2 returned 108 words for 105
// captions over 135s, with timestamps hallucinated past the chunk length — the
// "แบ่งซับ N คำ" button then rebuilt captions ending at 411s on a 285s clip → the
// editor timeline showed 6:51 and every subtitle ran 1.44× ahead of the audio).
// Run: npx tsx scripts/verify-transcribe-words-guard.ts
import assert from "node:assert/strict";
import {
  sanitizeChunkTimeline,
  boundWordsForSplit,
  type ChunkResult,
} from "../src/lib/transcribe-timeline";

let passed = 0;
function check(name: string, cond: boolean) { assert.ok(cond, name); console.log("✓ " + name); passed++; }

// ── helpers to fabricate chunk results ──
const CHUNK_MS = 135_400; // prod chunk 2: 285.37s clip cut at 150s

function mkCaptions(n: number, totalMs: number) {
  const step = totalMs / n;
  return Array.from({ length: n }, (_, i) => ({
    text: `cap${i}`,
    startMs: Math.round(i * step),
    endMs: Math.round((i + 1) * step) - 40,
    timestampMs: Math.round(i * step),
    confidence: 1,
    tag: "body" as const,
  }));
}

function mkWords(n: number, totalSec: number) {
  const step = totalSec / n;
  return Array.from({ length: n }, (_, i) => ({
    word: `w${i}`,
    start: i * step,
    end: (i + 1) * step - 0.02,
  }));
}

function mkChunk(caps: number, words: number, totalMs: number): ChunkResult {
  const captions = mkCaptions(caps, totalMs);
  return {
    words: mkWords(words, totalMs / 1000),
    segments: captions.map(c => ({ text: c.text, start: c.startMs / 1000, end: c.endMs / 1000 })),
    geminiDirectCaptions: captions,
    fullText: "",
  };
}

// ── 1. healthy chunk passes through untouched ──
{
  const r = mkChunk(100, 540, CHUNK_MS);
  const s = sanitizeChunkTimeline(r, CHUNK_MS);
  check("healthy chunk: words kept", s.words.length === 540);
  check("healthy chunk: not degenerate", !s.stats.wordsDegenerate);
  check("healthy chunk: no rescale", s.stats.rescaleK === 1);
  check("healthy chunk: captions untouched", s.geminiDirectCaptions[50].endMs === r.geminiDirectCaptions[50].endMs);
}

// ── 2. mid-array hallucinated word (past the chunk length) is dropped ──
{
  const r = mkChunk(100, 540, CHUNK_MS);
  r.words[200] = { word: "ghost", start: 260.0, end: 261.0 }; // 261s in a 135.4s chunk
  const s = sanitizeChunkTimeline(r, CHUNK_MS);
  check("bogus word dropped", s.words.length === 539 && !s.words.some(w => w.end > (CHUNK_MS + 2000) / 1000));
  check("dropping one word ≠ degenerate", !s.stats.wordsDegenerate);
}

// ── 3. degenerate words (prod case: 108 words for 105 captions) → words zeroed ──
{
  const r = mkChunk(105, 108, CHUNK_MS);
  const s = sanitizeChunkTimeline(r, CHUNK_MS);
  check("sparse words (≈1/caption) → degenerate", s.stats.wordsDegenerate);
  check("degenerate → words zeroed (interpolation takes over)", s.words.length === 0);
  check("degenerate → captions preserved", s.geminiDirectCaptions.length === 105);
}

// ── 4. progressive tail drift (last caption overshoots) → linear rescale ──
{
  const r = mkChunk(100, 540, 154_000); // built as if the chunk were 154s …
  const s = sanitizeChunkTimeline(r, CHUNK_MS); // … but it is really 135.4s (+14%)
  const last = s.geminiDirectCaptions[s.geminiDirectCaptions.length - 1];
  check("tail drift: rescaled k<1", s.stats.rescaleK < 1);
  check("tail drift: last caption lands on real chunk end", Math.abs(last.endMs - CHUNK_MS) <= 60);
  const mid = s.geminiDirectCaptions[49];
  check("tail drift: middle captions scaled proportionally (not tail-squeezed)",
    Math.abs(mid.endMs - r.geminiDirectCaptions[49].endMs * s.stats.rescaleK) <= 2);
  check("tail drift: still monotonic", s.geminiDirectCaptions.every((c, i, a) => i === 0 || c.startMs >= a[i - 1].startMs));
  check("tail drift: words scaled too", s.words.every(w => w.end <= (CHUNK_MS + 2000) / 1000));
}

// ── 5. mid-array hallucinated caption is clamped (text kept, time bounded) ──
{
  const r = mkChunk(100, 540, CHUNK_MS);
  r.geminiDirectCaptions[60].startMs = 260_000;
  r.geminiDirectCaptions[60].endMs = 261_000;
  const s = sanitizeChunkTimeline(r, CHUNK_MS);
  check("bogus caption text kept", s.geminiDirectCaptions.length === 100);
  check("bogus caption clamped into chunk", s.geminiDirectCaptions[60].endMs <= CHUNK_MS + 2000);
}

// ── 6. ≤2s overshoot is left alone (normal clamp downstream handles it) ──
{
  const r = mkChunk(100, 540, CHUNK_MS + 1500);
  const s = sanitizeChunkTimeline(r, CHUNK_MS);
  check("small overshoot: no rescale", s.stats.rescaleK === 1);
}

// ── boundWordsForSplit (client guard for the แบ่งซับ N คำ button) ──
const DUR = 285_370;
function mkClientWords(n: number, untilMs: number) {
  const step = untilMs / n;
  return Array.from({ length: n }, (_, i) => ({
    word: `w${i}`,
    startMs: Math.round(i * step),
    endMs: Math.round((i + 1) * step) - 20,
  }));
}

// ── 7. healthy full-coverage words → usable, all kept ──
{
  const g = boundWordsForSplit(mkClientWords(650, DUR), DUR);
  check("client: healthy words kept", g.words.length === 650);
  check("client: healthy words usable", g.coverageOk);
}

// ── 8. prod case: chunk-2 words hallucinated to 411s → dropped; survivors cover
//      only the first half → unusable (split must fall back, not desync) ──
{
  const firstHalf = mkClientWords(540, 150_000);
  const ghosts = [{ word: "ghost", startMs: 410_000, endMs: 411_000 }];
  const g = boundWordsForSplit([...firstHalf, ...ghosts], DUR);
  check("client: out-of-range words dropped", g.words.every(w => w.endMs <= DUR + 2000));
  check("client: half-coverage → NOT usable", !g.coverageOk);
}

// ── 9. unknown duration (0) → pass-through, usable if non-empty ──
{
  const g = boundWordsForSplit(mkClientWords(100, 60_000), 0);
  check("client: duration unknown → pass-through", g.words.length === 100 && g.coverageOk);
}

console.log(`\n✅ ALL ${passed} WORD-GUARD CHECKS PASSED`);
