// Tail treatment for 16-bit mono PCM (Gemini TTS output).
//
// Two problems, two stages (see finalizeTtsPcm):
//
// 1. gemini-3.8-flash-tts appends an end-of-generation glitch AFTER the speech
//    ends: ~100-200ms near-silence, then ~200ms FULL-SCALE static sustained to
//    the file edge (measured 2026-09-26: buckets -300ms:41, -200ms:32768,
//    -100ms:32752, lastSample=24937). trimTrailingGlitch cuts it: it only cuts
//    when the signature (quiet gap + loud run reaching the edge) is present in
//    the last GLITCH_SCAN_MS, so clean endings (e.g. 2.5-flash) pass through
//    byte-identical. Returns a new Buffer; the input is unmutated.
//
// 2. Whatever remains gets a short raised-cosine ramp to exactly zero so
//    playback never stops mid-waveform (the classic end-pop). Sample count
//    changes ONLY via the trim — callers must derive durations/timing from
//    the FINALIZED bytes, never the raw API bytes (see tts-gemini route).

export const TTS_TAIL_FADE_MS = 120;

// Glitch detector tuning (16-bit peaks, 10ms windows, tail scan only).
const GLITCH_SCAN_MS = 1200;
const GLITCH_QUIET_PEAK = 1000; // window peak below this = quiet
const GLITCH_LOUD_PEAK = 12000; // window peak at/above this = loud
const GLITCH_MIN_QUIET_MS = 60;
const GLITCH_MIN_LOUD_MS = 50;
const GLITCH_KEEP_SILENCE_MS = 80; // room tone kept after speech end

export function withTailFade(pcm: Buffer, sampleRate: number, fadeMs = TTS_TAIL_FADE_MS): Buffer {
  const out = Buffer.from(pcm);
  const totalSamples = Math.floor(out.length / 2);
  if (totalSamples <= 0 || !(sampleRate > 0) || !(fadeMs > 0)) return out;
  const fadeSamples = Math.min(totalSamples, Math.max(1, Math.round((sampleRate * fadeMs) / 1000)));
  for (let i = 0; i < fadeSamples; i++) {
    const idx = totalSamples - fadeSamples + i;
    const t = fadeSamples === 1 ? 1 : i / (fadeSamples - 1);
    const gain = 0.5 * (1 + Math.cos(Math.PI * t));
    const s = out.readInt16LE(idx * 2);
    out.writeInt16LE(Math.round(s * gain), idx * 2);
  }
  return out;
}

/** Cut a trailing end-of-generation glitch (quiet gap + loud run to the edge).
 * No signature → copy unchanged. Never cuts speech: the cut lands at the end
 * of the last above-quiet window plus a short room-tone margin. */
export function trimTrailingGlitch(pcm: Buffer, sampleRate: number): Buffer {
  const total = Math.floor(pcm.length / 2);
  if (total <= 0 || !(sampleRate > 0)) return Buffer.from(pcm);
  const win = Math.max(1, Math.round(sampleRate / 100)); // ~10ms windows
  const scanSamples = Math.min(total, Math.round((sampleRate * GLITCH_SCAN_MS) / 1000));
  const scanStart = total - scanSamples;
  const peaks: number[] = [];
  for (let s = scanStart; s < total; s += win) {
    let m = 0;
    const end = Math.min(s + win, total);
    for (let i = s; i < end; i++) {
      const a = Math.abs(pcm.readInt16LE(i * 2));
      if (a > m) m = a;
    }
    peaks.push(m);
  }
  // Walk back from the edge: loud run, then quiet run.
  let i = peaks.length - 1;
  let loudWindows = 0;
  while (i >= 0 && peaks[i] >= GLITCH_LOUD_PEAK) {
    loudWindows++;
    i--;
  }
  let quietWindows = 0;
  while (i >= 0 && peaks[i] < GLITCH_QUIET_PEAK) {
    quietWindows++;
    i--;
  }
  const msPerWindow = (win / sampleRate) * 1000;
  const loudMs = loudWindows * msPerWindow;
  const quietMs = quietWindows * msPerWindow;
  // Signature needs: loud run to the edge + quiet gap + real content before
  // the gap (i >= 0 with peaks[i] >= QUIET means a speech window precedes).
  if (loudMs < GLITCH_MIN_LOUD_MS || quietMs < GLITCH_MIN_QUIET_MS || i < 0) {
    return Buffer.from(pcm);
  }
  const speechEndSample = scanStart + (i + 1) * win;
  const keepSamples = Math.round((sampleRate * GLITCH_KEEP_SILENCE_MS) / 1000);
  const cutSample = Math.min(total, speechEndSample + keepSamples);
  if (cutSample >= total) return Buffer.from(pcm);
  return Buffer.from(pcm.subarray(0, cutSample * 2));
}

/** Full tail treatment for one TTS call's PCM: trim glitch, then fade. */
export function finalizeTtsPcm(pcm: Buffer, sampleRate: number): Buffer {
  return withTailFade(trimTrailingGlitch(pcm, sampleRate), sampleRate);
}
