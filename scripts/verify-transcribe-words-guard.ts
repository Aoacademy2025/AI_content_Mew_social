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
  chunkOvershootRatio,
  chunkTailGapMs,
  chunkNeedsRetry,
  type ChunkResult,
  type SanitizedChunk,
} from "../src/lib/transcribe-timeline";
import { repairCaptionTiming } from "../src/lib/mcp/subtitle-quality";
import {
  mergeTranscribeWarning,
  type TranscribeWarning,
} from "../src/lib/transcribe-partial-coverage";

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

// ── 3. truncated word timeline (prod shape: sparse survivors cover half) → zeroed ──
{
  const r = mkChunk(105, 108, CHUNK_MS);
  r.words = mkWords(108, CHUNK_MS / 2 / 1000);
  const s = sanitizeChunkTimeline(r, CHUNK_MS);
  check("half-timeline words → degenerate", s.stats.wordsDegenerate);
  check("degenerate reason is explicit", s.stats.wordEvidenceCode === "insufficient_timeline_coverage");
  check("degenerate → words zeroed so the route can retry the chunk", s.words.length === 0);
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
  // Rescale must happen BEFORE the bogus-word filter: with uniform drift the
  // tail words map back INSIDE the chunk — dropping them first (prod 06-12 #2:
  // 327/502 kept) left the last ~30s of the chunk with no words → "ซับหายเป็นช่วง"
  // in word-split mode.
  check("tail drift: tail words survive (rescaled before filtered)", s.words.length === 540);
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

// ── chunkOvershootRatio (per-chunk desync detection → retry the chunk) ──
{
  const healthy = mkChunk(100, 540, CHUNK_MS);
  check("overshoot: healthy ≈ 1", Math.abs(chunkOvershootRatio(healthy.geminiDirectCaptions, CHUNK_MS) - 1) < 0.02);
  const drifted = mkChunk(89, 502, 171_200); // prod 06-12 #2: chunk 1 overshot ×1.264
  const ratio = chunkOvershootRatio(drifted.geminiDirectCaptions, CHUNK_MS);
  check("overshoot: 26% drift detected (>1.10 retry threshold)", ratio > 1.10 && Math.abs(ratio - 171_200 / CHUNK_MS) < 0.02);
  check("overshoot: no captions → neutral 1", chunkOvershootRatio([], CHUNK_MS) === 1);
  check("overshoot: unknown duration → neutral 1", chunkOvershootRatio(healthy.geminiDirectCaptions, 0) === 1);
}

// ── chunkNeedsRetry / chunkTailGapMs (bidirectional desync detection) ──
// Prod 06-12 #3: chunk 2 attempt 1 overshot ×1.408 → retried, but the kept
// attempt UNDERSHOT and the one-sided check let it through → subs ran ahead
// of the audio after 2:20. Retry must look both ways and judge by |gap|.
{
  const dur = 75_000;
  const ok = mkCaptions(40, dur);
  check("retry: in-sync chunk → no retry", !chunkNeedsRetry(ok, dur));
  const over = mkCaptions(40, Math.round(dur * 1.408));
  check("retry: ×1.408 overshoot → retry", chunkNeedsRetry(over, dur));
  check("retry: overshoot gap is positive", chunkTailGapMs(over, dur) > 0);
  const slightlyOver = mkCaptions(40, dur + 1500); // within codec/breath margin
  check("retry: +1.5s tail → no retry", !chunkNeedsRetry(slightlyOver, dur));
  const under = mkCaptions(40, dur - 30_000); // transcript covers only 45s of 75s
  check("retry: −30s undershoot → retry", chunkNeedsRetry(under, dur));
  check("retry: undershoot gap is negative", chunkTailGapMs(under, dur) < 0);
  const productionTailGap = mkCaptions(40, 61_600);
  check("retry: production −9.54s spoken tail → retry", chunkNeedsRetry(productionTailGap, 71_140));
  const tailSilence = mkCaptions(40, dur - 8_000); // acoustic analysis proves speech ends here
  check("retry: proven −8s trailing silence → no retry", !chunkNeedsRetry(tailSilence, dur - 8_000));
  check("retry: empty captions → retry", chunkNeedsRetry([], dur));
  check("retry: unknown duration → no retry", !chunkNeedsRetry(ok, 0));
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


// ── ADR 0056: no usable word clock is a warning, not a refusal ───────────────
// The route used to answer 422 word_timing_incomplete whenever the Gemini path
// ended up with zero usable words, which threw away a complete set of caption
// cards. The cards render fine without a word clock — only the editor's
// "แบ่งซับ N คำ" regrouping falls back — so the response now ships them with an
// empty `words` array and the finding attached.
// Mirrors the word-clock branch + response builder of transcribe/route.ts.
function respondFromChunk(chunk: SanitizedChunk, audioDurationMs: number): {
  status: number;
  captions: { text: string; startMs: number; endMs: number }[];
  words: { word: string; startMs: number; endMs: number }[];
  warnings: TranscribeWarning[];
} {
  const warnings: TranscribeWarning[] = [];
  const words = chunk.words
    .map((w) => ({ word: w.word.trim(), startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) }))
    .filter((w) => w.word.length > 0);
  if (words.length === 0) mergeTranscribeWarning(warnings, "word_timing_incomplete");
  const repaired = repairCaptionTiming(chunk.geminiDirectCaptions, audioDurationMs);
  return {
    status: repaired.captions.length > 0 ? 200 : 422,
    captions: repaired.captions,
    words,
    warnings,
  };
}

{
  // Same production shape as case 3 above: 105 caption cards, 108 words whose
  // timeline covers only half the chunk → the word clock is unusable.
  const r = mkChunk(105, 108, CHUNK_MS);
  r.words = mkWords(108, CHUNK_MS / 2 / 1000);
  const response = respondFromChunk(sanitizeChunkTimeline(r, CHUNK_MS), CHUNK_MS);
  check("degenerate word clock → HTTP 200 (was 422 word_timing_incomplete)", response.status === 200);
  check("degenerate word clock → all 105 caption cards kept", response.captions.length === 105);
  check("degenerate word clock → caption text untouched",
    response.captions[0].text === r.geminiDirectCaptions[0].text
    && response.captions[104].text === r.geminiDirectCaptions[104].text);
  check("degenerate word clock → words: []", response.words.length === 0);
  check("degenerate word clock → one warning", response.warnings.length === 1);
  check("degenerate word clock → code word_timing_incomplete",
    response.warnings[0].code === "word_timing_incomplete");
  check("degenerate word clock → repaired captions stay inside the audio",
    response.captions.every((c) => c.startMs >= 0 && c.endMs <= CHUNK_MS));
}

{
  // A healthy word clock produces no finding at all.
  const response = respondFromChunk(sanitizeChunkTimeline(mkChunk(100, 540, CHUNK_MS), CHUNK_MS), CHUNK_MS);
  check("healthy word clock → HTTP 200 with no warning",
    response.status === 200 && response.warnings.length === 0 && response.words.length === 540);
}

console.log(`\n✅ ALL ${passed} WORD-GUARD CHECKS PASSED`);
