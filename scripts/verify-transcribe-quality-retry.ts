// Regression proof for production long-upload transcription failures.
// Run: npx tsx scripts/verify-transcribe-quality-retry.ts
import assert from "node:assert/strict";
import {
  TRANSCRIBE_CHUNK_TARGET_MS,
  chunkTranscriptionReferenceDurationMs,
  normalizeGeminiWords,
  parseTranscriptionSilenceAnalysis,
  planTranscriptionChunkBoundaries,
  planTranscriptionRecoveryBoundaries,
  runTranscriptionQualityRetries,
  type ChunkResult,
} from "../src/lib/transcribe-timeline";

function result(endMs: number, wordCount = 0): ChunkResult {
  return {
    words: Array.from({ length: wordCount }, (_, index) => ({
      word: `คำ${index + 1}`,
      start: (index * endMs) / wordCount / 1_000,
      end: ((index + 1) * endMs) / wordCount / 1_000,
    })),
    segments: [{ text: "ทดสอบ", start: 0, end: endMs / 1000 }],
    geminiDirectCaptions: [{
      text: "ทดสอบ",
      startMs: 0,
      endMs,
      timestampMs: 0,
      confidence: 1,
    }],
    fullText: "ทดสอบ",
  };
}

async function main() {
  // Kapokja production trace: first semantic result stopped 21.61s early.
  // The route must retry the model response itself rather than return retryable:422
  // to a background caller that deliberately does not retry any 4xx.
  const responses = [result(158_500), result(179_900)];
  let calls = 0;
  const recovered = await runTranscriptionQualityRetries(
    async () => responses[calls++],
    180_110,
  );
  assert.equal(calls, 2, "incomplete 180.11s transcript is retried once");
  assert.equal(recovered.accepted, true, "second in-sync response is accepted");
  assert.equal(recovered.result.geminiDirectCaptions.at(-1)?.endMs, 179_900);

  const wordResponses = [result(60_000, 1), result(60_000, 4)];
  calls = 0;
  const wordRecovered = await runTranscriptionQualityRetries(
    async () => wordResponses[calls++],
    60_000,
    3,
    undefined,
    { requireUsableWords: true },
  );
  assert.equal(calls, 2, "a tail-aligned response with degenerate words is retried");
  assert.equal(wordRecovered.accepted, true, "a later response with acoustic word coverage is accepted");
  assert.equal(wordRecovered.result.words.length, 4, "the accepted result keeps the complete word timeline");

  calls = 0;
  const exhausted = await runTranscriptionQualityRetries(
    async () => {
      calls++;
      return result(158_500);
    },
    180_110,
  );
  assert.equal(calls, 3, "persistently incomplete transcript gets three bounded attempts");
  assert.equal(exhausted.accepted, false, "bad result stays rejected after retry exhaustion");
  assert.deepEqual(
    planTranscriptionRecoveryBoundaries(60_037),
    [30_019],
    "a persistently failing 60s primary chunk is recovered as two ~30s slices",
  );
  assert.deepEqual(
    planTranscriptionRecoveryBoundaries(90_000),
    [45_000],
    "recovery slices never exceed the 45s reliability ceiling",
  );

  // Exact production failure on 2026-08-09: the balanced planner regressed the
  // old ~75s anchor target into two 90.055s calls. All three Gemini attempts for
  // chunk 2 stopped captions 13.1s early. Keep long-upload calls near the proven
  // target instead: this 180.11s source must become three ~60s chunks.
  assert.equal(TRANSCRIBE_CHUNK_TARGET_MS, 75_000);
  const productionCuts = planTranscriptionChunkBoundaries(180_110, []);
  assert.deepEqual(productionCuts, [60_037, 120_073]);

  // ffmpeg on the retained production upload proved only 3.687s of silence at
  // EOF (176.324–180.011), not the whole 13.1s caption shortfall. Recognize the
  // closed-at-EOF interval and shorten only the final chunk's speech reference.
  const silence = parseTranscriptionSilenceAnalysis(
    [
      "[silencedetect] silence_start: 0",
      "[silencedetect] silence_end: 0.762417 | silence_duration: 0.762417",
      "[silencedetect] silence_start: 176.324",
      "[silencedetect] silence_end: 180.011 | silence_duration: 3.68712",
    ].join("\n"),
    180_110,
  );
  assert.equal(silence.trailingSilenceStartMs, 176_324);
  const finalChunkReferenceMs = chunkTranscriptionReferenceDurationMs({
    chunkStartMs: 120_073,
    chunkDurationMs: 60_037,
    totalDurationMs: 180_110,
    trailingSilenceStartMs: silence.trailingSilenceStartMs,
  });
  assert.equal(finalChunkReferenceMs, 56_251);
  calls = 0;
  const trailingSilenceAccepted = await runTranscriptionQualityRetries(
    async () => {
      calls++;
      return result(56_200);
    },
    finalChunkReferenceMs,
  );
  assert.equal(calls, 1, "known trailing silence is not re-transcribed three times");
  assert.equal(trailingSilenceAccepted.accepted, true, "speech-complete final chunk is accepted");

  // Production trace: a 135.11s upload reported 135,000,000ms because Gemini
  // returned word start/end in milliseconds while the legacy parser assumed seconds.
  const explicitMs = normalizeGeminiWords(
    [{ word: "จบ", startMs: 134_500, endMs: 135_000 }],
    135_110,
  );
  assert.equal(explicitMs.words[0]?.end, 135);

  const legacySeconds = normalizeGeminiWords(
    [{ word: "จบ", start: 134.5, end: 135 }],
    135_110,
  );
  assert.equal(legacySeconds.words[0]?.end, 135);

  const legacyButMilliseconds = normalizeGeminiWords(
    [{ word: "จบ", start: 134_500, end: 135_000 }],
    135_110,
  );
  assert.equal(legacyButMilliseconds.words[0]?.end, 135);
  assert.equal(legacyButMilliseconds.detectedUnit, "milliseconds");

  const impossible = normalizeGeminiWords(
    [{ word: "จบ", start: 134_500_000, end: 135_000_000 }],
    135_110,
  );
  assert.deepEqual(impossible.words, [], "unrecoverable word units are dropped, not allowed to poison rawMaxMs");

  console.log("✅ TRANSCRIBE QUALITY RETRY + UNIT REGRESSIONS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
