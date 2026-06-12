// Verify the pure logic behind the segmented tts-gemini route (PR-B):
// retryDelay parsing + the chunk→duration→guard orchestration the route runs.
// Run: npx tsx scripts/verify-tts-gemini-segmented.ts

import { parseRetryDelayMs } from "../src/lib/gemini-errors";
import {
  splitScriptForTts,
  mergeSegmentTiming,
  charsPerSecGuard,
  pcmDurationMs,
  chooseChunkChars,
} from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1) parseRetryDelayMs — Google 429 RetryInfo hint
// ---------------------------------------------------------------------------

const QUOTA_429 = `{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"18s"}]}}`;

check("retryDelay: 18s → 18000ms", parseRetryDelayMs(QUOTA_429) === 18000);
check("retryDelay: fractional 0.8s → 800ms", parseRetryDelayMs(`"retryDelay": "0.8s"`) === 800);
check("retryDelay: capped at 30s", parseRetryDelayMs(`"retryDelay":"55s"`) === 30_000);
check("retryDelay: custom cap", parseRetryDelayMs(`"retryDelay":"55s"`, 10_000) === 10_000);
check("retryDelay: absent → null", parseRetryDelayMs(`{"error":{"code":429}}`) === null);
check("retryDelay: garbage → null", parseRetryDelayMs("Too Many Requests") === null);

// ---------------------------------------------------------------------------
// 2) Simulated segmented run — exactly the math the route performs
// ---------------------------------------------------------------------------

const SCRIPT = Array.from({ length: 10 }, (_, i) =>
  `ประโยคที่${i + 1} เล่าเรื่องการออมเงินและการลงทุนให้เข้าใจง่ายในไม่กี่วินาที`
).join("\n");

{
  const chunks = splitScriptForTts(SCRIPT, 120);
  check("plan: multiple chunks for a long script", chunks.length > 3, `got ${chunks.length}`);
  check("plan: concat === fullText (iron rule)", chunks.map((c) => c.text).join("") === SCRIPT);

  // Simulate Gemini returning PCM at ~14 chars/sec (24kHz s16le mono):
  // bytes = seconds * 48000
  const SAMPLE_RATE = 24000;
  const pcmBytesFor = (text: string, cps: number) =>
    Math.round((text.replace(/\s+/g, "").length / cps) * SAMPLE_RATE * 2);

  const durations = chunks.map((c) => Math.round(pcmDurationMs(pcmBytesFor(c.text, 14), SAMPLE_RATE)));
  const segs = chunks.map((c, i) => ({ text: c.text, durationMs: durations[i] }));

  check("plan: healthy run → guard silent", charsPerSecGuard(segs).length === 0,
    `flagged ${JSON.stringify(charsPerSecGuard(segs))}`);

  // Segment 4's audio comes back truncated (model spoke ~40% of the text):
  // duration collapses, cps explodes → guard must flag exactly that index.
  const broken = segs.map((s, i) => (i === 4 ? { ...s, durationMs: Math.round(s.durationMs * 0.4) } : s));
  check("plan: truncated segment flagged", JSON.stringify(charsPerSecGuard(broken)) === "[4]",
    `got ${JSON.stringify(charsPerSecGuard(broken))}`);

  // After "regenerating" segment 4 (route's guard retry), timeline is exact:
  const timeline = mergeSegmentTiming(segs);
  const total = durations.reduce((a, b) => a + b, 0);
  check("plan: offsets are exact arithmetic",
    timeline.every((s, i) => s.startMs === durations.slice(0, i).reduce((a, b) => a + b, 0)));
  check("plan: total duration = sum of segments",
    timeline.at(-1)!.startMs + timeline.at(-1)!.durationMs === total);
}

// ---------------------------------------------------------------------------
// 3) Free-tier call budget — the adaptive dial keeps short clips cheap
// ---------------------------------------------------------------------------

{
  // ~1 minute of Thai speech ≈ 850 chars → must stay ≤ 2 calls
  const oneMinute = "ก".repeat(840);
  check("budget: ~1min script ≤ 2 calls",
    splitScriptForTts(oneMinute, chooseChunkChars(oneMinute.length)).length <= 2);

  // ~2 minutes ≈ 1600 chars → still big chunks (free-tier friendly)
  const twoMinutes = "ข".repeat(1600);
  check("budget: ~2min script ≤ 3 calls",
    splitScriptForTts(twoMinutes, chooseChunkChars(twoMinutes.length)).length <= 3);

  // ~6 minutes ≈ 5000 chars → standard chunks for in-chunk accuracy
  const sixMinutes = "ค".repeat(5000);
  const n = splitScriptForTts(sixMinutes, chooseChunkChars(sixMinutes.length)).length;
  check("budget: ~6min script uses standard chunks (≥12 calls)", n >= 12, `got ${n}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll tts-gemini segmented checks passed ✓");
