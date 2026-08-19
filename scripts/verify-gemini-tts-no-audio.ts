import assert from "node:assert/strict";
import type { fetch as UndiciFetch } from "undici";
import {
  callGeminiTts,
  geminiNoAudioFailure,
  GEMINI_TTS_NO_AUDIO,
} from "../src/lib/gemini-tts-provider.server";

async function main() {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    const data = calls === 1
      ? { candidates: [{ content: { parts: [{}] } }] }
      : {
          candidates: [{
            content: {
              parts: [{ inlineData: { data: Buffer.from("pcm").toString("base64"), mimeType: "audio/L16;rate=24000" } }],
            },
          }],
        };
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => "",
    };
  }) as unknown as typeof UndiciFetch;

  const recovered = await callGeminiTts(
    "test-key",
    "ทดสอบเสียง",
    "Kore",
    "gemini-test-tts",
    undefined,
    { fetch: fakeFetch, sleep: async () => undefined, random: () => 0 },
  );
  assert.equal(recovered.ok, true, "HTTP 200 without audio must retry before failing");
  assert.equal(calls, 2, "the same model should be retried after a no-audio response");

  const managedFailure = geminiNoAudioFailure(true);
  assert.equal(managedFailure.status, 503, "managed no-audio is a temporary provider failure");
  assert.equal(managedFailure.body.retryable, true, "managed no-audio must not open the personal-key modal");
  assert.equal(managedFailure.body.provider, "gemini");
  assert.equal(managedFailure.body.reason, "no_audio");
  assert.doesNotMatch(managedFailure.body.error, /API Key|Settings|aistudio/i);

  let exhaustedCalls = 0;
  const alwaysEmptyFetch = (async () => {
    exhaustedCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{}] } }] }),
      text: async () => "",
    };
  }) as unknown as typeof UndiciFetch;
  const exhausted = await callGeminiTts(
    "test-key",
    "ทดสอบเสียง",
    "Kore",
    "gemini-test-tts",
    undefined,
    { fetch: alwaysEmptyFetch, sleep: async () => undefined, random: () => 0 },
  );
  assert.deepEqual(exhausted, { ok: false, status: 503, errBody: GEMINI_TTS_NO_AUDIO });
  assert.equal(exhaustedCalls, 3, "a locked model gets the same bounded retry count as other transient failures");

  console.log("PASS Gemini TTS retries empty HTTP 200 responses and returns managed-safe copy");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
