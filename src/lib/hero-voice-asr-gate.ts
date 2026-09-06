import { prepareHeroVoiceSpeechText } from "@/lib/hero-voice-speech";

/**
 * ASR content gate for Hero Voice (OmniVoice) chunks.
 *
 * Why: the clone worker generates three candidates and keeps the one whose voice
 * is closest to the reference. That ranking never checks the words, so it can and
 * did (2026-09-06, clip 08C) select a candidate that skipped a whole phrase. The
 * gate compares what an ASR ear heard against the intended speech text and fails
 * the chunk when a run of letters is missing, so the caller can regenerate it with
 * another seed instead of shipping audio with dropped words.
 *
 * Round 5 (2026-09-07) showed the mirror defect: a sentence-final "จริง" read as
 * "จริงๆ". A run of letters that every ear heard but the script never asked for
 * (a repeated word, a stuttered syllable) therefore fails the chunk as well.
 *
 * What it deliberately does NOT judge: accent, tone, pacing. Transcripts are
 * normalized through the same speech normalizer first, so numerals ("1,250 บาท")
 * and reviewed English spellings compare equal to the Thai readings the model was
 * given; passing several ears (a verbatim Thai transcript plus a polished one) and
 * taking the best keeps ASR spelling variance from failing a correct reading.
 */

export interface HeroVoiceTranscriptVerdict {
  pass: boolean;
  /** Longest run of intended letters/digits that no transcript accounted for. */
  droppedRun: number;
  /** Per-transcript dropped runs in the order given. */
  droppedRuns: number[];
  /** Longest run of heard letters/digits that EVERY transcript contains but the script does not. */
  insertedRun: number;
  /** Per-transcript inserted runs in the order given. */
  insertedRuns: number[];
  /** Which limit failed; absent when the verdict passes. A drop outranks an insertion. */
  reason?: "dropped" | "inserted";
}

export const HERO_VOICE_ASR_MAX_DROPPED_RUN = 5;
/** Three letters: long enough for a repeated Thai word (จริง, ครับ, มาก), short enough
 * that a two-letter filler one ear imagines (นะ) never costs a regeneration. Both ears
 * must hear the insertion because the minimum across transcripts is what is judged. */
export const HERO_VOICE_ASR_MAX_INSERTED_RUN = 3;

function letters(text: string): string[] {
  return [...prepareHeroVoiceSpeechText(text).normalize("NFC")].filter((character) => (
    /[\p{Script=Thai}\p{L}\p{N}]/u.test(character) && !/[\p{P}\s]/u.test(character)
  ));
}

/** Longest consecutive run of intended characters absent from the LCS alignment. */
export function droppedLetterRun(intended: string, heard: string): number {
  const a = letters(intended);
  const b = letters(heard);
  if (a.length === 0) return 0;
  if (b.length === 0) return a.length;
  // LCS table (chunks are at most a few hundred characters).
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] = a[i - 1] === b[j - 1]
        ? table[(i - 1) * cols + (j - 1)] + 1
        : Math.max(table[(i - 1) * cols + j], table[i * cols + (j - 1)]);
    }
  }
  const matched = new Array<boolean>(a.length).fill(false);
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matched[i - 1] = true;
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * cols + j] >= table[i * cols + (j - 1)]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  let longest = 0;
  let current = 0;
  for (const hit of matched) {
    current = hit ? 0 : current + 1;
    if (current > longest) longest = current;
  }
  return longest;
}

/** Longest consecutive run of heard characters that the intended text never asked for. */
export function insertedLetterRun(intended: string, heard: string): number {
  return droppedLetterRun(heard, intended);
}

export function evaluateHeroVoiceTranscripts(
  intendedSpeechText: string,
  transcripts: readonly string[],
  options: { maxDroppedRun?: number; maxInsertedRun?: number } = {},
): HeroVoiceTranscriptVerdict {
  const maxDroppedRun = options.maxDroppedRun ?? HERO_VOICE_ASR_MAX_DROPPED_RUN;
  const maxInsertedRun = options.maxInsertedRun ?? HERO_VOICE_ASR_MAX_INSERTED_RUN;
  const droppedRuns = transcripts.map((heard) => droppedLetterRun(intendedSpeechText, heard));
  const insertedRuns = transcripts.map((heard) => insertedLetterRun(intendedSpeechText, heard));
  const droppedRun = droppedRuns.length > 0 ? Math.min(...droppedRuns) : Number.POSITIVE_INFINITY;
  const insertedRun = insertedRuns.length > 0 ? Math.min(...insertedRuns) : Number.POSITIVE_INFINITY;
  const reason = droppedRun >= maxDroppedRun ? "dropped" : insertedRun >= maxInsertedRun ? "inserted" : undefined;
  return { pass: reason === undefined, droppedRun, droppedRuns, insertedRun, insertedRuns, ...(reason ? { reason } : {}) };
}
