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
  const text = wordCount > 0
    ? Array.from({ length: wordCount }, (_, index) => `คำ${index + 1}`).join(" ")
    : "ทดสอบ";
  return {
    words: Array.from({ length: wordCount }, (_, index) => ({
      word: `คำ${index + 1}`,
      start: (index * endMs) / wordCount / 1_000,
      end: ((index + 1) * endMs) / wordCount / 1_000,
    })),
    segments: [{ text, start: 0, end: endMs / 1000 }],
    geminiDirectCaptions: [{
      text,
      startMs: 0,
      endMs,
      timestampMs: 0,
      confidence: 1,
    }],
    fullText: text,
  };
}

function productionGeminiRatioResult(): ChunkResult {
  const wordCount = 36;
  const captionCount = 19;
  const durationMs = 60_000;
  const words = Array.from({ length: wordCount }, (_, index) => ({
    word: `คำ${index + 1}`,
    start: (index * durationMs) / wordCount / 1_000,
    end: ((index + 1) * durationMs) / wordCount / 1_000,
  }));
  const captions = Array.from({ length: captionCount }, (_, index) => {
    const from = Math.round((index * wordCount) / captionCount);
    const to = Math.round(((index + 1) * wordCount) / captionCount);
    return {
      text: words.slice(from, to).map((word) => word.word).join(" "),
      startMs: Math.round((from * durationMs) / wordCount),
      endMs: Math.round((to * durationMs) / wordCount),
      timestampMs: Math.round((from * durationMs) / wordCount),
      confidence: 1,
    };
  });
  return {
    words,
    segments: captions.map((caption) => ({
      text: caption.text,
      start: caption.startMs / 1_000,
      end: caption.endMs / 1_000,
    })),
    geminiDirectCaptions: captions,
    fullText: words.map((word) => word.word).join(" "),
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

  const truncatedWordResult = result(60_000, 1);
  truncatedWordResult.words[0].end = 20;
  const wordResponses = [truncatedWordResult, result(60_000, 4)];
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

  // Production 2026-08-29: caption evidence covered the 71.14s audio, but the
  // aligned word clock ended at 61.60s. The old 85% ratio accepted 86.6%
  // coverage, then canonical caption projection made subtitles progressively
  // early and left the final 9.54s of speech uncovered.
  const progressiveUndershoot = result(71_140, 20);
  progressiveUndershoot.words = progressiveUndershoot.words.map((word) => ({
    ...word,
    start: word.start * (61_600 / 71_140),
    end: word.end * (61_600 / 71_140),
  }));
  calls = 0;
  const progressiveRecovered = await runTranscriptionQualityRetries(
    async () => calls++ === 0 ? progressiveUndershoot : result(71_140, 20),
    71_140,
    3,
    undefined,
    { requireUsableWords: true },
  );
  assert.equal(calls, 2, "a 9.54s word-tail undershoot is retried despite exceeding 85% ratio coverage");
  assert.equal(progressiveRecovered.accepted, true, "complete retry evidence replaces the progressive undershoot");

  // Production 2026-08-27: Gemini returned a complete, monotonic 60s timeline
  // with 19 caption cards / 36 timed word-or-phrase items. Item count is a
  // provider segmentation choice, not proof of missing acoustic timing.
  calls = 0;
  const providerPhraseSegmentation = await runTranscriptionQualityRetries(
    async () => {
      calls++;
      return productionGeminiRatioResult();
    },
    60_000,
    3,
    undefined,
    { requireUsableWords: true },
  );
  assert.equal(calls, 1, "complete 19-caption/36-word evidence is accepted without retries");
  assert.equal(providerPhraseSegmentation.accepted, true, "provider phrase segmentation is not a false failure");

  const alternateAsrProjection = productionGeminiRatioResult();
  alternateAsrProjection.fullText = "อีกการแบ่งประโยคหนึ่งจากผล ASR เดียวกัน";
  const projectionAccepted = await runTranscriptionQualityRetries(
    async () => alternateAsrProjection,
    60_000,
    1,
    undefined,
    { requireUsableWords: true },
  );
  assert.equal(
    projectionAccepted.accepted,
    true,
    "ASR text projection differences do not override complete acoustic timing evidence",
  );

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
