// Proof of the long-audio chunk planner (2026-06): split long clips at silence so
// each Gemini transcribe stays in its in-sync zone. 06-12 #3 shrank chunks from
// ~2.5min to ~75s: flash timestamps wobble NON-LINEARLY inside a chunk (late mid-
// chunk, early at the tail, different every run), and chunk start offsets are the
// only EXACT anchors we have (ffmpeg slicing) — smaller chunks = anchors twice as
// often = bounded drift. Pure logic — run:
//   npx tsx scripts/verify-transcribe-chunking.ts
import assert from "node:assert/strict";
import {
  TRANSCRIBE_CHUNK_MAX_MS,
  offsetChunkWordsToSourceTimeline,
  planFineTranscriptionRecoveryBoundaries,
  planTranscriptionChunkBoundaries,
  planTranscriptionRecoveryBoundaries,
  runTranscriptionQualityRetries,
  sanitizeChunkTimeline,
  type ChunkCaption,
  type ChunkResult,
} from "../src/lib/transcribe-timeline";
import { repairCaptionTiming } from "../src/lib/mcp/subtitle-quality";
import {
  mergeTranscribeWarning,
  type TranscribeWarning,
} from "../src/lib/transcribe-partial-coverage";

function chunks(totalMs: number, silences: number[]): number[] {
  const cuts = planTranscriptionChunkBoundaries(totalMs, silences);
  const bounds = [0, ...cuts, totalMs];
  return bounds.slice(1).map((b, i) => b - bounds[i]);
}

let passed = 0;
function check(name: string, cond: boolean) { assert.ok(cond, name); console.log("✓ " + name); passed++; }

const everyN = (step: number, total: number) => Array.from({ length: Math.floor(total / step) }, (_, i) => (i + 1) * step);

// ── invariant: every chunk ≤ CHUNK_MAX (the whole point — stay in-sync zone) ──
for (const total of [371_000, 357_000, 329_000, 500_000, 600_000]) {
  const cs = chunks(total, everyN(30_000, total)); // silence every 30s
  check(`${(total/1000).toFixed(0)}s w/silence → all chunks ≤ 110s (${cs.map(c=>(c/1000).toFixed(0)).join("/")})`, cs.every(c => c <= TRANSCRIBE_CHUNK_MAX_MS));
}

// ── 6.18-min clip (Mew's) with silences → many short chunks, each in safe zone ──
const mew = chunks(371_000, everyN(20_000, 371_000));
check("371s (6.18min) → ≥4 chunks", mew.length >= 4);
check("371s → every chunk ≤ 110s", mew.every(c => c <= TRANSCRIBE_CHUNK_MAX_MS));

// ── no detectable silence → balanced hard-cuts, still all ≤ MAX ──
const noSil = chunks(360_000, []);
check("360s no-silence → hard-cut chunks all ≤ 110s", noSil.every(c => c <= TRANSCRIBE_CHUNK_MAX_MS));
check("360s no-silence → five balanced 72s chunks near the 75s anchor target",
  noSil.length === 5 && noSil.every(c => c === 72_000));

// ── every clip above the 110s safe single-call ceiling must split ──
check("245s → ≥2 chunks all ≤ 110s",
  chunks(245_000, everyN(25_000, 245_000)).every(c => c <= TRANSCRIBE_CHUNK_MAX_MS) &&
  chunks(245_000, everyN(25_000, 245_000)).length >= 2);

// ── Production regression (Kapokja, 2026-08-03..05) ─────────────────────
// These uploads were sent as one Gemini request under the old 240s gate. The
// 180.11s clip repeatedly stopped its transcript at 158.5s; the byte-identical
// 200.12s clip failed twice before a later reroll happened to succeed.
for (const total of [180_110, 200_120]) {
  const cs = chunks(total, []);
  check(`${(total / 1000).toFixed(2)}s production clip → split into ≥2 chunks`, cs.length >= 2);
  check(`${(total / 1000).toFixed(2)}s production clip → every chunk ≤ 110s`, cs.every(c => c <= TRANSCRIBE_CHUNK_MAX_MS));
}

// ── non-final chunks respect the 60s minimum (no silence picked closer than +60s) ──
const dense = chunks(400_000, everyN(5_000, 400_000)); // silence every 5s
check("dense silence → no chunk < 60s except possibly last", dense.slice(0, -1).every(c => c >= 60_000));

// Production 2026-08-28: a 196.88s Gemini transcript was cut at 132.855s.
// The final word of chunk 2 extended 102ms beyond that exact ffmpeg boundary,
// while chunk 3's first word began 73ms after it. Both chunks were valid alone,
// but the unbounded offset merge created one 29ms overlap and made the whole
// VideoJob fail subtitle_alignment_overlapping_timing.
const cutMs = 132_855;
const chunkTwo = offsetChunkWordsToSourceTimeline({
  words: [
    { word: "ก่อน", start: 67.598, end: 67.800 },
    { word: "เกินขอบ", start: 67.700, end: 67.800 },
  ],
  offsetMs: 65_157,
  chunkDurationMs: 67_698,
});
const chunkThree = offsetChunkWordsToSourceTimeline({
  words: [{ word: "หลัง", start: 0.073, end: 0.973 }],
  offsetMs: cutMs,
  chunkDurationMs: 64_025,
});
const mergedBoundaryWords = [...chunkTwo, ...chunkThree];
check(
  "chunk merge clips provider word tails to the exact source-audio boundary",
  mergedBoundaryWords[0].end <= cutMs / 1000,
);
check(
  "adjacent chunk words remain monotonic after offset merge",
  mergedBoundaryWords[1].start >= mergedBoundaryWords[0].end,
);
check(
  "provider words wholly beyond the source slice are discarded",
  chunkTwo.length === 1,
);


// ── ADR 0056: a slice that exhausts its retry budget is a WARNING ────────────
// Before 2026-08-30 the chunked merge answered 422 the moment one slice failed
// all its bounded attempts, so an upload whose middle 60s confused Gemini lost
// the 120s that WERE transcribed ("ถอดซับจากคลิปไม่สำเร็จ"). The route now keeps
// what every other slice produced, records the unverified span, and answers 200.
//
// This mirrors the chunk/recovery/fine-recovery NESTING of
// src/app/api/videos/transcribe/route.ts over the REAL planners, retry runner,
// sanitizer, warning merge (mergeTranscribeWarning — the shipped rule, not a copy)
// and timing repair. The route's own 422-freedom is asserted from its source in
// verify-transcribe-quality-retry.

function mkChunkResult(startMs: number, durationMs: number, captionCount: number): ChunkResult {
  const step = durationMs / captionCount;
  const captions: ChunkCaption[] = Array.from({ length: captionCount }, (_, i) => ({
    text: `c@${startMs}#${i}`,
    startMs: Math.round(i * step),
    endMs: Math.round((i + 1) * step),
    timestampMs: Math.round(i * step),
    confidence: 1,
  }));
  const wordCount = captionCount * 4;
  const wordStep = durationMs / 1000 / wordCount;
  return {
    words: Array.from({ length: wordCount }, (_, i) => ({
      word: `w${i}`,
      start: i * wordStep,
      end: (i + 1) * wordStep,
    })),
    segments: captions.map((c) => ({ text: c.text, start: c.startMs / 1000, end: c.endMs / 1000 })),
    geminiDirectCaptions: captions,
    fullText: captions.map((c) => c.text).join(" "),
  };
}

const emptyChunkResult = (): ChunkResult =>
  ({ words: [], segments: [], geminiDirectCaptions: [], fullText: "" });

async function transcribeChunked(
  totalMs: number,
  respond: (span: { startMs: number; durationMs: number }) => ChunkResult,
): Promise<{ status: number; captions: ChunkCaption[]; warnings: TranscribeWarning[] }> {
  const warnings: TranscribeWarning[] = [];
  const pushWarning = (fromMs: number, toMs: number) =>
    mergeTranscribeWarning(warnings, "chunk_recovery_exhausted", fromMs, toMs);
  const merged: ChunkCaption[] = [];
  const append = (result: ChunkResult, durationMs: number, offsetMs: number) => {
    for (const c of sanitizeChunkTimeline(result, durationMs).geminiDirectCaptions) {
      merged.push({ ...c, startMs: c.startMs + offsetMs, endMs: c.endMs + offsetMs, timestampMs: c.timestampMs + offsetMs });
    }
  };
  const attempt = (startMs: number, durationMs: number) => runTranscriptionQualityRetries(
    async () => respond({ startMs, durationMs }),
    durationMs,
    3,
    undefined,
    { requireUsableWords: true },
  );

  const bounds = [0, ...planTranscriptionChunkBoundaries(totalMs, []), totalMs];
  for (let i = 0; i < bounds.length - 1; i++) {
    const chunkStartMs = bounds[i];
    const chunkDurationMs = bounds[i + 1] - chunkStartMs;
    const chunk = await attempt(chunkStartMs, chunkDurationMs);
    if (chunk.accepted) { append(chunk.result, chunkDurationMs, chunkStartMs); continue; }

    const recoveryCuts = planTranscriptionRecoveryBoundaries(chunkDurationMs);
    if (recoveryCuts.length === 0) {
      pushWarning(chunkStartMs, chunkStartMs + chunkDurationMs);
      append(chunk.result, chunkDurationMs, chunkStartMs);
      continue;
    }
    const recoveryBounds = [0, ...recoveryCuts, chunkDurationMs];
    for (let ri = 0; ri < recoveryBounds.length - 1; ri++) {
      const recoveryStartMs = chunkStartMs + recoveryBounds[ri];
      const recoveryDurationMs = recoveryBounds[ri + 1] - recoveryBounds[ri];
      const recovery = await attempt(recoveryStartMs, recoveryDurationMs);
      if (recovery.accepted) { append(recovery.result, recoveryDurationMs, recoveryStartMs); continue; }

      const fineCuts = planFineTranscriptionRecoveryBoundaries(recoveryDurationMs);
      if (fineCuts.length === 0) {
        pushWarning(recoveryStartMs, recoveryStartMs + recoveryDurationMs);
        append(recovery.result, recoveryDurationMs, recoveryStartMs);
        continue;
      }
      const fineBounds = [0, ...fineCuts, recoveryDurationMs];
      for (let fi = 0; fi < fineBounds.length - 1; fi++) {
        const fineStartMs = recoveryStartMs + fineBounds[fi];
        const fineDurationMs = fineBounds[fi + 1] - fineBounds[fi];
        const fine = await attempt(fineStartMs, fineDurationMs);
        if (!fine.accepted) pushWarning(fineStartMs, fineStartMs + fineDurationMs);
        append(fine.result, fineDurationMs, fineStartMs);
      }
    }
  }

  const repaired = repairCaptionTiming(merged, totalMs);
  return { status: repaired.captions.length > 0 ? 200 : 422, captions: repaired.captions, warnings };
}

async function adr0056PartialCoverage() {
  // Production shape: 180.11s upload → three ~60s chunks; the middle one comes
  // back empty on every primary / recovery / fine-recovery attempt.
  const TOTAL_MS = 180_110;
  const [cutA, cutB] = planTranscriptionChunkBoundaries(TOTAL_MS, []);
  const partial = await transcribeChunked(TOTAL_MS, ({ startMs }) =>
    startMs >= cutA && startMs < cutB ? emptyChunkResult() : mkChunkResult(startMs, 60_037, 12));

  check("chunk 2/3 exhausted → HTTP 200 (partial coverage ships)", partial.status === 200);
  check("chunk 2/3 exhausted → one merged warning", partial.warnings.length === 1);
  check("chunk 2/3 exhausted → code chunk_recovery_exhausted",
    partial.warnings[0].code === "chunk_recovery_exhausted");
  check(`chunk 2/3 exhausted → warning span is chunk 2 (${cutA}–${cutB}ms)`,
    partial.warnings[0].fromMs === cutA && partial.warnings[0].toMs === cutB);
  check("chunk 2/3 exhausted → captions kept from chunks 1+3",
    partial.captions.length === 24
    && partial.captions.every((c) => c.text.startsWith("c@0#") || c.text.startsWith(`c@${cutB}#`)));
  check("chunk 2/3 exhausted → no caption from the failed chunk",
    !partial.captions.some((c) => c.text.startsWith(`c@${cutA}#`)));
  check("chunk 2/3 exhausted → merged timeline stays monotonic and inside the audio",
    partial.captions.every((c, i, a) => c.startMs >= 0 && c.endMs <= TOTAL_MS && (i === 0 || c.startMs >= a[i - 1].endMs)));

  // Every slice empty = nothing to show → the ONE blocking case survives.
  const nothing = await transcribeChunked(TOTAL_MS, () => emptyChunkResult());
  check("every chunk empty → 422 (nothing to show is still blocking)", nothing.status === 422);
  check("every chunk empty → zero captions", nothing.captions.length === 0);
}

adr0056PartialCoverage()
  .then(() => { console.log(`\n✅ ALL ${passed} CHUNK-PLANNER CHECKS PASSED`); })
  .catch((error) => { console.error(error); process.exit(1); });
