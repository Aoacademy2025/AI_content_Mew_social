// Pause insertion for Hero Voice (omnivoice) chunk concatenation. The model
// reads straight through sentence ends, so we insert a short silence at chunk
// boundaries that look like sentence/phrase breaks. Callers must add the gap
// to that chunk's durationMs so subtitle timing stays byte-exact with the PCM.

const SENTENCE_GAP_MS = 300;
const PHRASE_GAP_MS = 150;

/**
 * Silence to insert AFTER a chunk, judged from how the chunk's display text
 * ends: newline or sentence punctuation → full pause; other whitespace (Thai
 * phrase break) → short pause; mid-sentence cut (no whitespace) → none, so a
 * long sentence split only by the provider char limit is never broken up.
 */
export function heroVoiceGapMsAfterChunk(chunkText: string, isLastChunk: boolean): number {
  if (isLastChunk) return 0;
  if (/\n\s*$/.test(chunkText)) return SENTENCE_GAP_MS;
  const trimmed = chunkText.trimEnd();
  if (/[.!?…]$/.test(trimmed)) return SENTENCE_GAP_MS;
  if (/\s$/.test(chunkText)) return PHRASE_GAP_MS;
  return 0;
}

/** Zero-filled mono 16-bit PCM of the given duration. */
export function heroVoiceSilencePcm(sampleRate: number, ms: number): Buffer {
  const samples = Math.max(0, Math.round((sampleRate * ms) / 1000));
  return Buffer.alloc(samples * 2);
}
