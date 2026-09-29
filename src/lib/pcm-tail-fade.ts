// Short end fade for decoded mono s16le PCM. Container metadata is removed at
// the provider boundary, never by inspecting the waveform: a pause followed by
// loud audio can be real speech. Preserve every sample and the original duration.
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

/** Finalize one decoded TTS segment without truncating valid audio. */
export function finalizeTtsPcm(pcm: Buffer, sampleRate: number): Buffer {
  return withTailFade(pcm, sampleRate);
}
