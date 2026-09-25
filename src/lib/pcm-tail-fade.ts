// Tail fade for 16-bit mono PCM (Gemini TTS output).
//
// Raw TTS PCM ends abruptly — often mid-waveform near full scale — so stopping
// playback fires a loud broadband pop (the end-of-preview "crack"). This ramps
// the last TTS_TAIL_FADE_MS to exactly zero with a raised-cosine curve. Sample
// count is UNCHANGED, so subtitle timing derived from byte length
// (pcmDurationMs) is untouched. Returns a new Buffer; the input is unmutated.

export const TTS_TAIL_FADE_MS = 120;

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
