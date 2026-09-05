import type { TimedWord } from "@/lib/tts-timing";

export const ACOUSTIC_CLOCK_VERSION = "thai-ctc-v1";
export const ACOUSTIC_MODEL_REVISION = "3155938c549b23eee16b1d4b55dcb161b7fe4bcf";

export type AcousticCharacter = {
  startChar: number;
  endChar: number;
  startMs: number;
  endMs: number;
  confidence: number;
};
export type AcousticRange = { startMs: number; endMs: number; startChar: number; endChar: number };
export type AcousticClock = {
  words: TimedWord[];
  uncertainRanges: AcousticRange[];
  verifiedWordCount: number;
  totalWordCount: number;
};
export type AcousticEvidence = {
  status: "aligned" | "partial" | "unavailable" | "timeout" | "skipped";
  version: string;
  modelRevision: string;
  mode: "shadow" | "apply";
  applied: boolean;
  durationMs: number;
  cacheHit?: boolean;
  audioHash?: string;
  textHash?: string;
  verifiedWordCount?: number;
  totalWordCount?: number;
  uncertainRanges?: AcousticRange[];
};

/** Preserve reliable acoustic islands. Missing words get a bounded, explicitly
 * approximate span between their neighbours, never a new whole-clip clock. */
export function projectAcousticClock(args: {
  text: string;
  baselineWords: TimedWord[];
  characters: AcousticCharacter[];
  audioDurationMs: number;
}): AcousticClock | null {
  const { text, baselineWords, characters, audioDurationMs } = args;
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0 || !baselineWords.length || !characters.length) return null;
  if (characters.some((c, i) => !c
    || !Number.isInteger(c.startChar) || !Number.isInteger(c.endChar)
    || c.startChar < 0 || c.endChar <= c.startChar || c.endChar > text.length
    || !Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || !Number.isFinite(c.confidence)
    || c.startMs < 0 || c.endMs <= c.startMs || c.endMs > audioDurationMs
    || c.confidence < 0 || c.confidence > 1
    || (i > 0 && (c.startChar < characters[i - 1].endChar || c.startMs < characters[i - 1].endMs)))) return null;
  if (baselineWords.some((w, i) => !Number.isInteger(w.startChar) || !Number.isInteger(w.endChar)
    || w.startChar < 0 || w.endChar <= w.startChar || w.endChar > text.length
    || text.slice(w.startChar, w.endChar) !== w.word
    || (i > 0 && w.startChar < baselineWords[i - 1].endChar))) return null;

  let characterIndex = 0;
  const words = baselineWords.map((word) => {
    while (characterIndex < characters.length && characters[characterIndex].endChar <= word.startChar) characterIndex++;
    const inside: AcousticCharacter[] = [];
    for (let i = characterIndex; i < characters.length && characters[i].startChar < word.endChar; i++) {
      if (characters[i].startChar >= word.startChar && characters[i].endChar <= word.endChar) inside.push(characters[i]);
    }
    const spokenUnits = [...word.word].filter(c => /[\p{L}\p{M}\p{N}]/u.test(c)).length;
    const meanConfidence = inside.reduce((sum, c) => sum + c.confidence, 0) / Math.max(1, inside.length);
    const weak = inside.filter(c => c.confidence < .2).length;
    // A confident character spike can attach to the previous phrase. A long
    // blank run inside one lexical word is not evidence of its spoken onset.
    // Keep that span approximate instead of promoting the isolated early spike.
    const separatedCharacters = inside.some((c, i) => i > 0 && c.startMs - inside[i - 1].endMs > 500);
    const verified = !separatedCharacters && inside.length >= spokenUnits && spokenUnits > 0
      && meanConfidence >= .8 && weak / inside.length <= .15
      && inside[0].confidence >= .35;
    return {
      ...word,
      ...(verified ? { startMs: inside[0].startMs, endMs: inside[inside.length - 1].endMs } : {}),
      verified,
    };
  });
  const verifiedWordCount = words.filter(w => w.verified).length;
  if (!verifiedWordCount) return null;
  const uncertainRanges: AcousticRange[] = [];
  for (let i = 0; i < words.length;) {
    if (words[i].verified) { i++; continue; }
    const startIndex = i;
    while (i < words.length && !words[i].verified) i++;
    const startMs = startIndex > 0 ? words[startIndex - 1].endMs : 0;
    const endMs = i < words.length ? words[i].startMs : audioDurationMs;
    if (endMs - startMs < i - startIndex) return null;
    const weights = words.slice(startIndex, i).map(w => Math.max(1, [...w.word].length));
    const totalWeight = weights.reduce((sum, n) => sum + n, 0);
    let cursor = startMs;
    let weightCursor = 0;
    for (let j = startIndex; j < i; j++) {
      weightCursor += weights[j - startIndex];
      const end = j === i - 1 ? endMs : Math.min(endMs - (i - j - 1), Math.max(cursor + 1,
        startMs + Math.round((endMs - startMs) * weightCursor / totalWeight)));
      words[j].startMs = cursor;
      words[j].endMs = end;
      cursor = end;
    }
    uncertainRanges.push({ startMs, endMs, startChar: words[startIndex].startChar, endChar: words[i - 1].endChar });
  }
  return { words: words.map(w => ({ word: w.word, startChar: w.startChar, endChar: w.endChar,
    startMs: w.startMs, endMs: w.endMs })), uncertainRanges,
    verifiedWordCount, totalWordCount: words.length };
}

/** Group uncertain word flashes into a phrase. Caption text is concatenated
 * exactly: callers already obtained each slice from the canonical narration. */
export function mergeUncertainCaptionCards<T extends { text: string; startMs: number; endMs: number }>(
  captions: T[], ranges: Array<{ startMs: number; endMs: number }>, sourceText: string, maxChars = 40,
): T[] {
  const source = sourceText.replace(/\s+/gu, " ").trim();
  let result = captions;
  for (const range of ranges) {
    let cursor = 0;
    const spans = result.map(c => {
      const start = source.indexOf(c.text, cursor);
      if (start >= 0) cursor = start + c.text.length;
      return { start, end: cursor };
    });
    if (spans.some(s => s.start < 0)) return captions;
    const start = result.findIndex(c => c.endMs > range.startMs && c.startMs < range.endMs);
    if (start < 0) continue;
    const grouped: T[] = result.slice(0, start);
    let cursorIndex = start;
    while (cursorIndex < result.length && result[cursorIndex].startMs < range.endMs) {
      let end = cursorIndex + 1;
      while (end < result.length && result[end].startMs < range.endMs
        && spans[end].end - spans[cursorIndex].start <= maxChars) end++;
      const last = result[end - 1] as T & { endChar?: number };
      grouped.push({ ...result[cursorIndex], text: source.slice(spans[cursorIndex].start, spans[end - 1].end),
        ...(typeof last.endChar === "number" ? { endChar: last.endChar } : {}),
        endMs: last.endMs });
      cursorIndex = end;
    }
    result = [...grouped, ...result.slice(cursorIndex)];
  }
  return result;
}

/** Resolve the readable minimum by grouping words, not by pushing later
 * acoustic starts forward. The existing repair floor remains a last resort. */
export function mergeShortAcousticCards<T extends { text: string; startMs: number; endMs: number }>(
  captions: T[], sourceText: string, minMs: number,
): T[] {
  let result = captions;
  while (result.length > 1) {
    const short = result.findIndex((c, i) => c.endMs - c.startMs < minMs && (
      i < result.length - 1 ? result[i + 1].startMs - c.startMs < minMs
        : i > 0 && c.startMs - result[i - 1].endMs < minMs
    ));
    if (short < 0) break;
    const neighbour = short < result.length - 1 ? short + 1 : short - 1;
    const first = Math.min(short, neighbour), last = Math.max(short, neighbour);
    const merged = mergeUncertainCaptionCards(result, [{ startMs: result[first].startMs,
      endMs: result[last].endMs }], sourceText, Number.POSITIVE_INFINITY);
    if (merged.length >= result.length) break;
    result = merged;
  }
  return result;
}
