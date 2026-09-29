// Offline regression: decoded audio after a quiet pause is valid speech, not metadata.
import assert from 'node:assert/strict';
import { finalizeTtsPcm, TTS_TAIL_FADE_MS } from '../src/lib/pcm-tail-fade';
import { pcmDurationMs } from '../src/lib/tts-timing';
const rate = 24000;
const pcm = Buffer.alloc(rate * 2 * 1.35);
for (let i = 0; i < pcm.length / 2; i++) {
  const value = i < rate ? 15000 : i < rate * 1.15 ? 40 : 32000;
  pcm.writeInt16LE(i % 2 ? -value : value, i * 2);
}
const original = Buffer.from(pcm);
const final = finalizeTtsPcm(pcm, rate);
assert.equal(final.length, pcm.length, 'a quiet gap followed by loud speech must not be trimmed');
assert.equal(pcmDurationMs(final.length, rate), 1350);
assert.deepEqual(pcm, original, 'finalization must not mutate provider samples');
const fadeStart = final.length - Math.round(rate * TTS_TAIL_FADE_MS / 1000) * 2;
assert.deepEqual(final.subarray(0, fadeStart), pcm.subarray(0, fadeStart));
assert.equal(final.readInt16LE(final.length - 2), 0, 'end fade removes waveform discontinuity');
assert.equal(finalizeTtsPcm(Buffer.alloc(0), rate).length, 0);
assert.equal(finalizeTtsPcm(Buffer.from([1, 0]), rate).readInt16LE(0), 0);
console.log('PASS decoded PCM preserves every sample and duration, with only an end fade');
