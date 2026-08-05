// Regression proof for production long-upload transcription failures.
// Run: npx tsx scripts/verify-transcribe-quality-retry.ts
import assert from "node:assert/strict";
import {
  normalizeGeminiWords,
  runTranscriptionQualityRetries,
  type ChunkResult,
} from "../src/lib/transcribe-timeline";

function result(endMs: number): ChunkResult {
  return {
    words: [],
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
