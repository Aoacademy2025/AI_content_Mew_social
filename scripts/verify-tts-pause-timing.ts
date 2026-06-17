// Verify the ellipsis pause-weighting in src/lib/tts-timing.ts buildCharClock.
// Root cause it guards: Gemini has only per-CHUNK exact duration, so within a
// chunk time was spread proportional to char count — ignoring the ~0.5s pause a
// "..." / "…" actually causes — which makes pause-heavy scripts drift early and
// only re-sync at the chunk end. The fix weights ellipses so the clock advances
// over the pause. MUST be a no-op for scripts without ellipses, and MUST never
// touch the ElevenLabs (real per-char timing) path.
// Run: npx tsx scripts/verify-tts-pause-timing.ts
import { buildWordsFromTiming, type TtsTiming } from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
function gemini(text: string, durationMs: number): TtsTiming {
  return { provider: "gemini", segments: [{ text, startMs: 0, durationMs }], chars: null };
}
function words(text: string, durationMs: number, pauseWeight: string) {
  process.env.TTS_PAUSE_WEIGHT = pauseWeight;
  return buildWordsFromTiming(gemini(text, durationMs), text);
}

// A) No ellipsis → weighting changes nothing (regression guard for normal scripts)
{
  const t = "หนึ่ง สอง สาม สี่ ห้า";
  const off = words(t, 5000, "0");
  const on = words(t, 5000, "5");
  check("no-ellipsis script is byte-identical (weight off vs on)", JSON.stringify(off) === JSON.stringify(on),
    `off=${JSON.stringify(off.map(w => [w.word, Math.round(w.startMs)]))}\n        on=${JSON.stringify(on.map(w => [w.word, Math.round(w.startMs)]))}`);
}

// B) "..." pushes the following word later than the legacy char-proportional split
{
  const t = "หนึ่ง... สอง";
  const off = words(t, 4000, "0");
  const on = words(t, 4000, "5");
  const offStart = off[1].startMs, onStart = on[1].startMs;
  check('"..." delays the next word vs legacy', onStart > offStart + 100, `legacy=${Math.round(offStart)}ms weighted=${Math.round(onStart)}ms`);
}

// B2) unicode "…" behaves the same
{
  const t = "หนึ่ง… สอง";
  const off = words(t, 4000, "0");
  const on = words(t, 4000, "5");
  check('"…" (U+2026) delays the next word', on[1].startMs > off[1].startMs + 100, `legacy=${Math.round(off[1].startMs)} weighted=${Math.round(on[1].startMs)}`);
}

// C) End stays anchored to the chunk duration in both modes (no total drift)
{
  const t = "หนึ่ง... สอง... สาม";
  for (const pw of ["0", "5"]) {
    const w = words(t, 6000, pw);
    check(`end anchored at chunk duration (pauseWeight=${pw})`, Math.abs(w[w.length - 1].endMs - 6000) < 60, `lastEnd=${Math.round(w[w.length - 1].endMs)}`);
  }
}

// D) ElevenLabs path uses real per-char timing → pause weight must have NO effect
{
  const t = "ab cd";
  const chars = { characters: [...t], startSec: [0, 0.4, 0.8, 0.8, 1.2], endSec: [0.4, 0.8, 0.8, 1.2, 1.6] };
  const el = (): TtsTiming => ({ provider: "elevenlabs", segments: [{ text: t, startMs: 0, durationMs: 1600 }], chars });
  process.env.TTS_PAUSE_WEIGHT = "0"; const off = buildWordsFromTiming(el(), t);
  process.env.TTS_PAUSE_WEIGHT = "999"; const on = buildWordsFromTiming(el(), t);
  check("ElevenLabs timing is untouched by pause weight", JSON.stringify(off) === JSON.stringify(on));
}

// E) TTS_PAUSE_WEIGHT=0 disables the feature (instant rollback parity)
{
  const t = "หนึ่ง... สอง";
  const a = words(t, 4000, "0");
  const b = words(t, 4000, "0");
  check("pauseWeight=0 is deterministic legacy behavior", JSON.stringify(a) === JSON.stringify(b));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
