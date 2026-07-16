// Verify the orchestrator's degraded TTS-timing fallback (stab-task-2).
//
// Prod bug: a headless VideoJob (editor-v2 background render / MCP) hard-threw
// "ไม่มี subtitle timing จาก TTS" whenever the TTS route produced AUDIO but no
// instrumented `timing` (Gemini's segmented pass falls open to a single
// uninstrumented call → response omits `timing`). The web foreground editor
// recovers via transcribe; the orchestrator has no transcribe path, so it failed
// a completed audio render — and a plain retry rarely cleared it.
//
// Fix: buildDegradedTtsTiming() reconstructs a single-segment clock from the
// EXACT audio duration over the exact spoken text, which captionsFromTtsTiming
// then turns into valid captions. This asserts the reconstruction is sound and
// preserves the iron rule (subtitle text === spoken text), without transcribe and
// without touching timing arithmetic.
//
// Run: npx tsx scripts/verify-orchestrator-timing-fallback.ts

import { captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { buildDegradedTtsTiming, mergeSegmentTiming, splitScriptForTts, type TtsTiming } from "../src/lib/tts-timing";
import { buildDegradedTimingTelemetry } from "../src/lib/mcp/orchestrator-steps";
import type { TelemetryInput } from "../src/lib/telemetry";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const strip = (s: string) => s.replace(/\s+/g, "");
const MAX = 27;

// A pause-heavy multi-sentence script (as the real failing jobs were: 1113–8327
// chars). Leading/trailing whitespace exercises the trim path.
const SHORT = [
  "รู้มั้ยว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่",
  "เพราะเขาเก็บเงินที่เหลือจากการใช้ แทนที่จะใช้เงินที่เหลือจากการเก็บ",
  "ลองสลับลำดับดู… แค่เปลี่ยนนิดเดียวชีวิตเปลี่ยนเลย",
].join("\n");
const SCRIPT_WS = `\n   ${SHORT}\n\n`;
// A long script (~4000 chars) — the input shape that fails most on prod because
// more Gemini segments = higher odds one fails = fail-open = no timing.
const LONG = Array.from({ length: 40 }, (_, i) =>
  `ประโยคที่ ${i + 1} พูดถึงการออมเงินและการลงทุนอย่างมีวินัยในทุก ๆ เดือน`,
).join(" ");

// 0) The bug precondition: a fail-open TTS response carries no `timing`, so the
//    normal bridge returns null → the orchestrator would hard-throw.
check("precondition: missing timing → captionsFromTtsTiming null (would hard-fail)",
  captionsFromTtsTiming(undefined, 42_000, MAX) === null);

// 1) buildDegradedTtsTiming guards: nothing to time → null (fail-open preserved)
check("guard: empty text → null", buildDegradedTtsTiming("gemini", "   \n ", 42_000) === null);
check("guard: zero duration → null", buildDegradedTtsTiming("gemini", SHORT, 0) === null);
check("guard: negative duration → null", buildDegradedTtsTiming("gemini", SHORT, -5) === null);
check("guard: NaN duration → null", buildDegradedTtsTiming("gemini", SHORT, Number.NaN) === null);

// 2) Gemini recovery (the exact prod case): degraded timing → usable captions
{
  const durMs = 42_000;
  const degraded = buildDegradedTtsTiming("gemini", SCRIPT_WS, durMs);
  check("gemini: degraded timing built", degraded !== null);
  check("gemini: iron rule — segment text === spoken (trimmed) text",
    !!degraded && degraded.segments.length === 1 && degraded.segments[0].text === SCRIPT_WS.trim());
  const res = degraded && captionsFromTtsTiming(degraded, durMs, MAX, null);
  check("gemini: captions recovered (was a hard failure)", !!res && res.captions.length > 0);
  if (res) {
    check("gemini: captions cover ALL spoken text (no drift/loss)",
      strip(res.captions.map((c) => c.text).join("")) === strip(SCRIPT_WS.trim()));
    check("gemini: captions monotonic non-overlapping",
      res.captions.every((c, i) => i === 0 || c.startMs >= res.captions[i - 1].endMs));
    check("gemini: words available for word-count modes", res.words.length > 0);
    check("gemini: total duration is the EXACT audio duration",
      res.audioDurationMs === durMs, `${res.audioDurationMs} vs ${durMs}`);
    check("gemini: last caption ends within audio",
      res.captions[res.captions.length - 1].endMs <= durMs);
  }
}

// 3) Long script (the high-segment-count shape that fails most on prod)
{
  const durMs = 300_000;
  const degraded = buildDegradedTtsTiming("gemini", LONG, durMs);
  const res = degraded && captionsFromTtsTiming(degraded, durMs, MAX, null);
  check("long: captions recovered", !!res && res.captions.length > 0);
  if (res) {
    check("long: covers all spoken text", strip(res.captions.map((c) => c.text).join("")) === strip(LONG));
    check("long: monotonic", res.captions.every((c, i) => i === 0 || c.startMs >= res.captions[i - 1].endMs));
    check("long: never split a card past audio end", res.captions.every((c) => c.endMs <= durMs));
  }
}

// 4) ElevenLabs provider path (haveProbes=false also drops timing)
{
  const durMs = 15_000;
  const el = "สวัสดีครับ ผมชื่อมิว วันนี้มาสอนออมเงินแบบง่าย ๆ";
  const degraded = buildDegradedTtsTiming("elevenlabs", el, durMs);
  const res = degraded && captionsFromTtsTiming(degraded, durMs, MAX, null);
  check("elevenlabs: degraded timing recovered", !!res && res.captions.length > 0);
  check("elevenlabs: covers all spoken text",
    !!res && strip(res.captions.map((c) => c.text).join("")) === strip(el));
}

// 5) Durable telemetry marker — mirrors the orchestrator caption-step decision
//    (orchestrator.ts) using the REAL helpers, capturing emitted events. Proves
//    the `tts_timing_degraded` marker is recorded on the degraded path and NOT on
//    the success path, so degraded videos stay identifiable and a systemic
//    regression spikes this event.
function runCaptionStep(realTiming: TtsTiming | undefined, audioDurationMs: number, script: string, jobId: string, provider: "gemini" | "elevenlabs") {
  const events: TelemetryInput[] = [];
  const emit = (e: TelemetryInput) => events.push(e); // fake fire-and-forget sink
  let capRes = captionsFromTtsTiming(realTiming, audioDurationMs, MAX, null);
  if (!capRes || capRes.captions.length === 0) {
    const degraded = buildDegradedTtsTiming(provider, script, audioDurationMs);
    if (degraded) {
      capRes = captionsFromTtsTiming(degraded, audioDurationMs, MAX, null);
      if (capRes && capRes.captions.length > 0) {
        const scriptCharCount = script.trim().length;
        emit(buildDegradedTimingTelemetry({ pipelineRunId: `mcp_${jobId}`, jobId, provider, scriptCharCount, audioDurationMs }));
      }
    }
  }
  return { capRes, events };
}

function goodGeminiTiming(fullText: string): TtsTiming {
  const parts = splitScriptForTts(fullText, 120).map((c) => ({ text: c.text, durationMs: c.text.replace(/\s+/g, "").length * 70 }));
  return { provider: "gemini", segments: mergeSegmentTiming(parts), chars: null };
}

{
  // success path: real timing present → captions built, NO marker
  const ok = runCaptionStep(goodGeminiTiming(SHORT), 42_000, SHORT, "jobOK", "gemini");
  check("marker: success path builds captions", !!ok.capRes && ok.capRes.captions.length > 0);
  check("marker: NOT recorded on success path", ok.events.length === 0);

  // degraded path: no timing → recovered via single-segment clock → EXACTLY one marker
  const deg = runCaptionStep(undefined, 42_000, SCRIPT_WS, "jobDEG", "gemini");
  check("marker: degraded path still builds captions", !!deg.capRes && deg.capRes.captions.length > 0);
  check("marker: recorded exactly once on degraded path", deg.events.length === 1);
  const ev = deg.events[0];
  check("marker: event name is tts_timing_degraded", ev?.name === "tts_timing_degraded");
  check("marker: category=pipeline, source=server", ev?.category === "pipeline" && ev?.source === "server");
  check("marker: carries jobId/provider/scriptCharCount/audioDurationMs",
    ev?.properties?.jobId === "jobDEG" &&
    ev?.properties?.provider === "gemini" &&
    ev?.properties?.scriptCharCount === SCRIPT_WS.trim().length &&
    ev?.properties?.audioDurationMs === 42_000,
    JSON.stringify(ev?.properties));

  // provider is carried through for elevenlabs too
  const el = runCaptionStep(undefined, 15_000, "สวัสดีครับ วันนี้มาสอนออมเงิน", "jobEL", "elevenlabs");
  check("marker: elevenlabs provider recorded", el.events.length === 1 && el.events[0]?.properties?.provider === "elevenlabs");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll orchestrator timing-fallback checks passed ✓");
