import {
  snapCardsToWordBoundaries,
  splitSentenceCards,
  tokenizeWords,
  type TimedWord,
} from "@/lib/tts-timing";
import { prepareHeroVoiceSpeechText } from "@/lib/hero-voice-speech";

export type SubtitleTimingSource =
  | "provider_alignment"
  | "tts_segment_timing"
  | "forced_alignment"
  | "upload_transcription"
  | "avatar_script_clock";

export type SubtitleQualityReport =
  | {
      status: "passed";
      timingSource: SubtitleTimingSource;
      textExact: true;
      captionCount: number;
      audioDurationMs: number;
    }
  | {
      status: "failed";
      timingSource: SubtitleTimingSource;
      textExact: boolean;
      code:
        | "empty_script"
        | "empty_captions"
        | "text_mismatch"
        | "spacing_mismatch"
        | "unverified_alignment"
        | "invalid_timing"
        | "overlapping_timing"
        | "timing_out_of_bounds"
        | "broken_thai_grapheme"
        | "punctuation_only_card"
        | "card_too_short";
      captionIndex?: number;
    };

export interface SubtitleQualityInput {
  script: string;
  captions: Array<{ text: string; startMs: number; endMs: number }>;
  audioDurationMs: number;
  timingSource: SubtitleTimingSource;
}

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

const THAI_COMBINING_MARK_AT_START = /^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/u;
const PUNCTUATION_OR_SYMBOLS_ONLY = /^[\p{P}\p{S}\s]+$/u;
const MIN_CARD_MS = 240;
const AUDIO_END_TOLERANCE_MS = 250;

function canonicalVisibleText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "");
}

function canonicalCardSpacing(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/**
 * Card boundaries may consume surrounding source whitespace because each card is rendered
 * independently. Whitespace inside a displayed card must remain exact after normalizing a
 * run (including authored line breaks) to one space.
 */
function hasExactInternalSpacing(
  script: string,
  captions: SubtitleQualityInput["captions"],
): { passed: true } | { passed: false; captionIndex: number } {
  const source = script.normalize("NFC");
  const visibleSource: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const char of source) {
    const start = offset;
    offset += char.length;
    if (!/\s/u.test(char)) visibleSource.push({ start, end: offset });
  }

  let visibleCursor = 0;
  for (let captionIndex = 0; captionIndex < captions.length; captionIndex += 1) {
    const caption = captions[captionIndex];
    const visibleLength = Array.from(caption.text.normalize("NFC"))
      .filter((char) => !/\s/u.test(char)).length;
    if (visibleLength === 0) return { passed: false, captionIndex };
    const first = visibleSource[visibleCursor];
    const last = visibleSource[visibleCursor + visibleLength - 1];
    if (!first || !last) return { passed: false, captionIndex };
    const sourceCard = source.slice(first.start, last.end);
    if (canonicalCardSpacing(caption.text) !== canonicalCardSpacing(sourceCard)) {
      return { passed: false, captionIndex };
    }
    visibleCursor += visibleLength;
  }
  return { passed: true };
}

export type TranscriptAlignmentFailureCode =
  | "empty_source"
  | "empty_transcript"
  | "no_usable_words"
  | "overlapping_timing"
  | "implausible_timing_density"
  | "text_mismatch"
  | "numeric_claim_mismatch"
  | "numeric_context_mismatch"
  | "incomplete_alignment";

export type TranscriptAlignmentResult =
  | { status: "aligned"; words: TimedWord[]; method: "exact" | "fuzzy"; similarity: number }
  | { status: "failed"; code: TranscriptAlignmentFailureCode };

const MIN_FUZZY_ALIGNMENT_SIMILARITY = 0.92;
const MAX_FUZZY_ALIGNMENT_CELLS = 12_000_000;
const DENSE_TIMING_WINDOW_WORDS = 5;
const MIN_DENSE_TIMING_WINDOW_MS = 300;

/**
 * Reject a transcript projection that is monotonic but acoustically impossible.
 * Fuzzy text alignment can otherwise map a missing ASR phrase onto a one-digit
 * millisecond span; the captions remain text-exact while flashing unreadably.
 */
export function hasPlausibleAlignedWordTiming(
  words: Array<{ startMs: number; endMs: number }>,
): boolean {
  if (words.length < DENSE_TIMING_WINDOW_WORDS) return true;
  for (let index = 0; index + DENSE_TIMING_WINDOW_WORDS <= words.length; index += 1) {
    const first = words[index];
    const last = words[index + DENSE_TIMING_WINDOW_WORDS - 1];
    if (last.endMs - first.startMs < MIN_DENSE_TIMING_WINDOW_MS) return false;
  }
  return true;
}
const THAI_DIGIT_WORDS = [
  "ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า",
] as const;
const THAI_NUMBER_WORDS = new Set<string>([
  ...THAI_DIGIT_WORDS,
  "เอ็ด", "ยี่", "ยี่สิบ", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน", "จุด", "ลบ", "บวก",
]);
const THAI_NUMBER_SPEECH_PARTS = [...THAI_NUMBER_WORDS].sort((left, right) => right.length - left.length);
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const CONTEXTUAL_DIGIT_SEQUENCE_RE = /(?:เบอร์(?:โทร(?:ศัพท์)?)?|โทรศัพท์|OTP|PIN|รหัส(?:ผ่าน|ยืนยัน|ไปรษณีย์|สินค้า)?|เลขบัญชี|เลขบัตร(?:ประชาชน|เครดิต)?|เลขประจำตัว)(\s*)([\p{N}](?:[\p{N} -]*[\p{N}])?)/giu;

function canonicalSpeechText(value: string): string {
  // TTS and ASR are allowed to use the spoken Thai form of authored numbers
  // and reviewed pronunciations (for example `2026` → `สองพันยี่สิบหก`).
  // Normalize both sides through the same deterministic speech contract before
  // transferring timestamps; displayed caption text still comes only from the
  // untouched source ranges below.
  return prepareHeroVoiceSpeechText(value)
    .normalize("NFC")
    .toLocaleLowerCase("th")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

function sourceWordHasNumericClaim(value: string): boolean {
  const normalized = value.normalize("NFC");
  return /\p{N}/u.test(normalized) || THAI_NUMBER_WORDS.has(canonicalSpeechText(normalized));
}

function containsThaiNumberSpeech(value: string): boolean {
  return THAI_NUMBER_SPEECH_PARTS.some((part) => value.includes(part));
}

function contextualDigitSequenceWordIndexes(
  fullText: string,
  sourceWords: ReturnType<typeof tokenizeWords>,
): Set<number> {
  const indexes = new Set<number>();
  CONTEXTUAL_DIGIT_SEQUENCE_RE.lastIndex = 0;
  for (const match of fullText.matchAll(CONTEXTUAL_DIGIT_SEQUENCE_RE)) {
    const digitSequence = match[2];
    const matchStart = match.index ?? 0;
    const sequenceOffset = match[0].lastIndexOf(digitSequence);
    const sequenceStart = matchStart + Math.max(0, sequenceOffset);
    const sequenceEnd = sequenceStart + digitSequence.length;
    sourceWords.forEach((word, wordIndex) => {
      if (
        sourceWordHasNumericClaim(word.word)
        && word.endChar > sequenceStart
        && word.startChar < sequenceEnd
      ) {
        indexes.add(wordIndex);
      }
    });
  }
  CONTEXTUAL_DIGIT_SEQUENCE_RE.lastIndex = 0;
  return indexes;
}

function canonicalDigitSequenceText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[๐-๙]/gu, (digit) => String(THAI_DIGITS.indexOf(digit)))
    .replace(/\d/gu, (digit) => THAI_DIGIT_WORDS[Number(digit)])
    .replace(/[^\p{L}\p{M}]+/gu, "");
}

type ComparableSourceWords = {
  words: string[];
  hardNumericWordIndexes: Set<number>;
};

function applyPreparedSpeechSpan(
  fullText: string,
  sourceWords: ReturnType<typeof tokenizeWords>,
  comparable: string[],
  hardNumericWordIndexes: Set<number>,
  startChar: number,
  endChar: number,
): void {
  const wordIndexes = sourceWords
    .map((word, wordIndex) => word.endChar > startChar && word.startChar < endChar ? wordIndex : -1)
    .filter((wordIndex) => wordIndex >= 0);
  if (wordIndexes.length === 0) return;
  const speechChars = Array.from(canonicalSpeechText(fullText.slice(startChar, endChar)));
  if (speechChars.length < wordIndexes.length) return;

  let speechCursor = 0;
  let remainingWeight = wordIndexes.reduce(
    (sum, wordIndex) => sum + Math.max(1, Array.from(comparable[wordIndex]).length),
    0,
  );
  wordIndexes.forEach((wordIndex, localIndex) => {
    const remainingWords = wordIndexes.length - localIndex - 1;
    const available = speechChars.length - speechCursor;
    const weight = Math.max(1, Array.from(comparable[wordIndex]).length);
    const take = localIndex === wordIndexes.length - 1
      ? available
      : Math.min(
          available - remainingWords,
          Math.max(1, Math.round((available * weight) / Math.max(1, remainingWeight))),
        );
    comparable[wordIndex] = speechChars.slice(speechCursor, speechCursor + take).join("");
    hardNumericWordIndexes.add(wordIndex);
    speechCursor += take;
    remainingWeight -= weight;
  });
}

function comparableSourceWords(
  fullText: string,
  sourceWords: ReturnType<typeof tokenizeWords>,
  transcriptComparableText: string,
): ComparableSourceWords {
  const comparable = sourceWords.map((word) => canonicalSpeechText(word.word));
  const hardNumericWordIndexes = new Set<number>();
  const digitSequenceWordIndexes = contextualDigitSequenceWordIndexes(fullText, sourceWords);
  digitSequenceWordIndexes.forEach((wordIndex) => {
    comparable[wordIndex] = canonicalDigitSequenceText(sourceWords[wordIndex].word);
    hardNumericWordIndexes.add(wordIndex);
  });

  sourceWords.forEach((word, wordIndex) => {
    if (!/\p{N}/u.test(word.word)) return;
    const previousEnd = wordIndex > 0 ? sourceWords[wordIndex - 1].endChar : 0;
    const prefixGap = fullText.slice(previousEnd, word.startChar);
    const contextualPrefix = prefixGap.match(/([+\-฿$€£])\s*$/u)?.[1];
    let spokenPrefix = "";
    if (contextualPrefix) {
      const signPosition = word.startChar - prefixGap.length + prefixGap.lastIndexOf(contextualPrefix);
      const beforeSign = signPosition > 0 ? fullText[signPosition - 1] : "";
      if (
        "฿$€£".includes(contextualPrefix)
        || !beforeSign
        || !/[\p{L}\p{M}\p{N}]/u.test(beforeSign)
      ) {
        spokenPrefix = contextualPrefix;
        comparable[wordIndex] = canonicalSpeechText(`${contextualPrefix}${word.word}`);
      }
    }

    const next = sourceWords[wordIndex + 1];
    const suffixEnd = next?.startChar ?? fullText.length;
    const suffixGap = fullText.slice(word.endChar, suffixEnd);
    if (/^\s*%/u.test(suffixGap)) {
      comparable[wordIndex] = canonicalSpeechText(`${word.word}%`);
    }

    // Contextual units can change the spoken form of the number itself. Thai
    // baht decimals are the important case: `1.05 บาท` is spoken as
    // `หนึ่งบาทห้าสตางค์`, not `หนึ่งจุดศูนย์ห้าบาท`. Keep a monotonic display
    // projection by assigning the amount prefix to the numeric token and the
    // remaining currency speech to the authored unit token.
    if (next?.word === "บาท") {
      const phrase = fullText.slice(word.startChar, next.endChar);
      const spokenPhrase = canonicalSpeechText(`${spokenPrefix}${phrase}`);
      const bahtIndex = spokenPhrase.indexOf("บาท");
      const satangIndex = spokenPhrase.indexOf("สตางค์");
      const splitAt = bahtIndex > 0 ? bahtIndex : satangIndex > 0 ? satangIndex : -1;
      if (splitAt > 0 && transcriptComparableText.includes(spokenPhrase)) {
        comparable[wordIndex] = spokenPhrase.slice(0, splitAt);
        comparable[wordIndex + 1] = spokenPhrase.slice(splitAt);
      }
    }

    if (next) {
      const contextualPhrase = canonicalSpeechText(
        `${spokenPrefix}${fullText.slice(word.startChar, next.endChar)}`,
      );
      const numericSpeech = comparable[wordIndex];
      if (
        numericSpeech.length > 0
        && contextualPhrase.startsWith(numericSpeech)
        && contextualPhrase.length > numericSpeech.length
        && transcriptComparableText.includes(contextualPhrase)
      ) {
        comparable[wordIndex + 1] = contextualPhrase.slice(numericSpeech.length);
      }
    }
  });

  // Structured numeric expressions are rewritten as a phrase by the speech
  // contract, so no single display token owns all spoken characters. Partition
  // the prepared phrase monotonically across its authored words. Sentence-card
  // timing remains acoustic, and the whole phrase is marked hard so a changed
  // date/time/range can never pass through fuzzy edit distance.
  const structuredPatterns = [
    /วันที่\s+[\p{N}]{1,2}[/-][\p{N}]{1,2}[/-][\p{N}]{4}/giu,
    /(?<![\p{N}])[\p{N}]{4}-[\p{N}]{2}-[\p{N}]{2}(?![\p{N}])/giu,
    /เวลา\s*[\p{N}]{1,2}[:.][\p{N}]{2}(?:\s*น\.)?/giu,
    /[\p{N}]{1,2}[:.][\p{N}]{2}\s*น\./giu,
    /[+-]?[\p{N}][\p{N},]*(?:\.[\p{N}]+)?\s*[–—]\s*[+-]?[\p{N}][\p{N},]*(?:\.[\p{N}]+)?/giu,
    /[+-]?[\p{N}][\p{N},]*(?:\.[\p{N}]+)?\s+-\s+[+-]?[\p{N}][\p{N},]*(?:\.[\p{N}]+)?/giu,
  ];
  const structuredRanges = structuredPatterns.flatMap((pattern) =>
    [...fullText.matchAll(pattern)].flatMap((match) => {
      const prepared = canonicalSpeechText(match[0]);
      return transcriptComparableText.includes(prepared)
        ? [{
            startChar: match.index ?? 0,
            endChar: (match.index ?? 0) + match[0].length,
          }]
        : [];
    }),
  ).sort((left, right) =>
    left.startChar - right.startChar
    || (right.endChar - right.startChar) - (left.endChar - left.startChar),
  );
  const appliedRanges: Array<{ startChar: number; endChar: number }> = [];
  for (const range of structuredRanges) {
    if (appliedRanges.some((applied) =>
      range.startChar < applied.endChar && range.endChar > applied.startChar,
    )) continue;
    applyPreparedSpeechSpan(
      fullText,
      sourceWords,
      comparable,
      hardNumericWordIndexes,
      range.startChar,
      range.endChar,
    );
    appliedRanges.push(range);
  }
  return { words: comparable, hardNumericWordIndexes };
}

function alignTranscriptWordsExactly(
  sourceWords: ReturnType<typeof tokenizeWords>,
  usableTranscript: TranscriptWord[],
): TranscriptAlignmentResult {
  const tokenText = (value: string) => canonicalVisibleText(value.trim());
  const aligned: TimedWord[] = [];
  let sourceIndex = 0;
  let transcriptIndex = 0;
  while (sourceIndex < sourceWords.length && transcriptIndex < usableTranscript.length) {
    const sourceStart = sourceIndex;
    const transcriptStart = transcriptIndex;
    let sourceText = tokenText(sourceWords[sourceIndex++].word);
    let transcriptText = tokenText(usableTranscript[transcriptIndex++].word);

    while (sourceText !== transcriptText) {
      if (sourceText.length < transcriptText.length && transcriptText.startsWith(sourceText)) {
        if (sourceIndex >= sourceWords.length) return { status: "failed", code: "text_mismatch" };
        sourceText += tokenText(sourceWords[sourceIndex++].word);
      } else if (transcriptText.length < sourceText.length && sourceText.startsWith(transcriptText)) {
        if (transcriptIndex >= usableTranscript.length) return { status: "failed", code: "text_mismatch" };
        transcriptText += tokenText(usableTranscript[transcriptIndex++].word);
      } else {
        return { status: "failed", code: "text_mismatch" };
      }
    }

    const sourceGroup = sourceWords.slice(sourceStart, sourceIndex);
    const transcriptGroup = usableTranscript.slice(transcriptStart, transcriptIndex);
    const transcriptLengths = transcriptGroup.map((word) => tokenText(word.word).length);
    const totalChars = transcriptLengths.reduce((sum, length) => sum + length, 0);
    if (totalChars <= 0) return { status: "failed", code: "text_mismatch" };

    const timeAt = (charOffset: number, edge: "start" | "end"): number => {
      let cursor = 0;
      for (let index = 0; index < transcriptGroup.length; index += 1) {
        const word = transcriptGroup[index];
        const length = transcriptLengths[index];
        const next = cursor + length;
        if (charOffset < next || (edge === "end" && charOffset === next)) {
          const ratio = Math.max(0, Math.min(1, (charOffset - cursor) / Math.max(1, length)));
          return word.startMs + (word.endMs - word.startMs) * ratio;
        }
        cursor = next;
      }
      return transcriptGroup[transcriptGroup.length - 1].endMs;
    };

    let sourceCharOffset = 0;
    for (const source of sourceGroup) {
      const length = tokenText(source.word).length;
      const startMs = timeAt(sourceCharOffset, "start");
      sourceCharOffset += length;
      const endMs = timeAt(sourceCharOffset, "end");
      aligned.push({
        word: source.word,
        startMs: Math.round(startMs),
        endMs: Math.max(Math.round(startMs) + 1, Math.round(endMs)),
        startChar: source.startChar,
        endChar: source.endChar,
      });
    }
  }
  return sourceIndex === sourceWords.length && transcriptIndex === usableTranscript.length
    ? { status: "aligned", words: aligned, method: "exact", similarity: 1 }
    : { status: "failed", code: "incomplete_alignment" };
}

/**
 * Recover timestamps from a complete ASR projection that differs from the authored
 * script only by a small spelling/segmentation error. The text that reaches captions
 * still comes exclusively from `sourceWords`; this routine only transfers monotonic
 * acoustic timestamps. Numeric claims are compared through the deterministic
 * speech contract and remain exact across their aligned acoustic span, so fuzzy
 * recovery can accept `5,000` ↔ `ห้าพัน` but never turn 5,000 into 500.
 */
function alignTranscriptWordsFuzzily(
  fullText: string,
  sourceWords: ReturnType<typeof tokenizeWords>,
  usableTranscript: TranscriptWord[],
): TranscriptAlignmentResult {
  const transcriptComparableWords = usableTranscript.map((word) => canonicalSpeechText(word.word));
  const transcriptComparableText = transcriptComparableWords.join("");
  const sourceChars: string[] = [];
  const sourceWordByChar: number[] = [];
  const comparableSource = comparableSourceWords(fullText, sourceWords, transcriptComparableText);
  const sourceComparableWords = comparableSource.words;
  sourceWords.forEach((word, wordIndex) => {
    const comparableWord = sourceComparableWords[wordIndex];
    for (const char of Array.from(comparableWord)) {
      sourceChars.push(char);
      sourceWordByChar.push(wordIndex);
    }
  });

  const transcriptChars: string[] = [];
  const transcriptCharTimes: Array<{ startMs: number; endMs: number }> = [];
  for (let wordIndex = 0; wordIndex < usableTranscript.length; wordIndex += 1) {
    const word = usableTranscript[wordIndex];
    const chars = Array.from(transcriptComparableWords[wordIndex]);
    chars.forEach((char, index) => {
      const startRatio = index / chars.length;
      const endRatio = (index + 1) / chars.length;
      transcriptChars.push(char);
      transcriptCharTimes.push({
        startMs: word.startMs + (word.endMs - word.startMs) * startRatio,
        endMs: word.startMs + (word.endMs - word.startMs) * endRatio,
      });
    });
  }

  const n = sourceChars.length;
  const m = transcriptChars.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_FUZZY_ALIGNMENT_CELLS) {
    return { status: "failed", code: "text_mismatch" };
  }
  // Direction matrix: 1=diagonal, 2=delete source char, 3=insert transcript char.
  // One byte per cell keeps a three-minute Thai script well below worker memory limits.
  const stride = m + 1;
  const directions = new Uint8Array((n + 1) * stride);
  let previous = new Uint32Array(stride);
  let current = new Uint32Array(stride);
  for (let j = 1; j <= m; j += 1) {
    previous[j] = j;
    directions[j] = 3;
  }
  for (let i = 1; i <= n; i += 1) {
    current[0] = i;
    directions[i * stride] = 2;
    for (let j = 1; j <= m; j += 1) {
      const diagonal = previous[j - 1] + (sourceChars[i - 1] === transcriptChars[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      if (diagonal <= deletion && diagonal <= insertion) {
        current[j] = diagonal;
        directions[i * stride + j] = 1;
      } else if (deletion <= insertion) {
        current[j] = deletion;
        directions[i * stride + j] = 2;
      } else {
        current[j] = insertion;
        directions[i * stride + j] = 3;
      }
    }
    [previous, current] = [current, previous];
  }

  const distance = previous[m];
  const similarity = 1 - distance / Math.max(n, m);
  if (similarity < MIN_FUZZY_ALIGNMENT_SIMILARITY) {
    return { status: "failed", code: "text_mismatch" };
  }

  const transcriptCharBySourceChar = new Int32Array(n);
  transcriptCharBySourceChar.fill(-1);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const direction = directions[i * stride + j];
    if (direction === 1) {
      transcriptCharBySourceChar[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (direction === 2) {
      i -= 1;
    } else if (direction === 3) {
      j -= 1;
    } else {
      return { status: "failed", code: "text_mismatch" };
    }
  }

  // A numeric value is a hard content claim. Speech normalization lets an
  // authored value align to its equivalent spoken form, but fuzzy edit distance
  // must never turn one value into another inside an otherwise long script.
  // Require every normalized character of each numeric source token to match a
  // contiguous transcript range, with no inserted speech at either boundary.
  // Thus `5,000` ↔ `ห้าพัน` passes while `5,000` ↔ `ห้าร้อย` and
  // `20` ↔ `ยี่สิบห้า` both fail closed.
  const numericWordIndexSet = new Set<number>(comparableSource.hardNumericWordIndexes);
  sourceWords.forEach((word, wordIndex) => {
    if (!sourceWordHasNumericClaim(word.word)) return;
    numericWordIndexSet.add(wordIndex);
    const nextWord = sourceWords[wordIndex + 1];
    if (
      nextWord
      && sourceComparableWords[wordIndex + 1] !== canonicalSpeechText(nextWord.word)
    ) {
      numericWordIndexSet.add(wordIndex + 1);
    }
  });
  const numericWordIndexes = [...numericWordIndexSet].sort((left, right) => left - right);
  const nearestMappedTranscriptBefore = (sourceCharIndex: number): number => {
    for (let index = sourceCharIndex - 1; index >= 0; index -= 1) {
      const mapped = transcriptCharBySourceChar[index];
      if (mapped >= 0) return mapped;
    }
    return -1;
  };
  const nearestMappedTranscriptAfter = (sourceCharIndex: number): number => {
    for (let index = sourceCharIndex + 1; index < sourceChars.length; index += 1) {
      const mapped = transcriptCharBySourceChar[index];
      if (mapped >= 0) return mapped;
    }
    return transcriptChars.length;
  };
  for (const numericWordIndex of numericWordIndexes) {
    const sourceIndexes: number[] = [];
    for (let sourceCharIndex = 0; sourceCharIndex < sourceWordByChar.length; sourceCharIndex += 1) {
      if (sourceWordByChar[sourceCharIndex] === numericWordIndex) sourceIndexes.push(sourceCharIndex);
    }
    if (sourceIndexes.length === 0) return { status: "failed", code: "numeric_claim_mismatch" };

    let mapped = sourceIndexes.map((sourceCharIndex) => transcriptCharBySourceChar[sourceCharIndex]);
    const isExactContiguousMapping = () => mapped.every((transcriptCharIndex, index) =>
      transcriptCharIndex >= 0
      && transcriptChars[transcriptCharIndex] === sourceChars[sourceIndexes[index]]
      && (index === 0 || transcriptCharIndex === mapped[index - 1] + 1),
    );
    if (!isExactContiguousMapping()) {
      // Global edit distance can assign one character of a correct numeric word
      // to a nearby repeated phrase (prod: authored/ASR both said "ตีสาม", but
      // an inserted sound effect made the final ม map to the following word).
      // Recover only an exact local occurrence near the partial DP anchor. A
      // wholly missing/changed value still has no candidate and remains red.
      const mappedEvidence = mapped.filter((transcriptCharIndex) => transcriptCharIndex >= 0);
      if (mappedEvidence.length === 0) return { status: "failed", code: "numeric_claim_mismatch" };
      const target = sourceIndexes.map((sourceCharIndex) => sourceChars[sourceCharIndex]).join("");
      const anchorStart = Math.min(...mappedEvidence);
      const previousMapped = nearestMappedTranscriptBefore(sourceIndexes[0]);
      const nextMapped = nearestMappedTranscriptAfter(sourceIndexes[sourceIndexes.length - 1]);
      const maxAnchorDistance = Math.max(12, target.length * 2);
      const candidates: number[] = [];
      let candidateStart = transcriptComparableText.indexOf(target);
      while (candidateStart >= 0) {
        const candidateEnd = candidateStart + target.length;
        if (
          Math.abs(candidateStart - anchorStart) <= maxAnchorDistance
          && (previousMapped < 0 || candidateStart > previousMapped)
          && (nextMapped < 0 || candidateEnd <= nextMapped)
        ) {
          candidates.push(candidateStart);
        }
        candidateStart = transcriptComparableText.indexOf(target, candidateStart + 1);
      }
      if (candidates.length === 0) return { status: "failed", code: "numeric_claim_mismatch" };
      const recoveredStart = candidates.sort((left, right) =>
        Math.abs(left - anchorStart) - Math.abs(right - anchorStart),
      )[0];
      const recovered = sourceIndexes.map((_, index) => recoveredStart + index);
      const recoveredSet = new Set(recovered);
      // Do not let an adjacent omitted source word keep borrowing a character
      // that is now proven to belong to the numeric claim. It will correctly
      // surface as incomplete_alignment instead of inventing speech timing.
      transcriptCharBySourceChar.forEach((transcriptCharIndex, sourceCharIndex) => {
        if (!sourceIndexes.includes(sourceCharIndex) && recoveredSet.has(transcriptCharIndex)) {
          transcriptCharBySourceChar[sourceCharIndex] = -1;
        }
      });
      sourceIndexes.forEach((sourceCharIndex, index) => {
        transcriptCharBySourceChar[sourceCharIndex] = recovered[index];
      });
      mapped = recovered;
    }

    const firstSourceIndex = sourceIndexes[0];
    const lastSourceIndex = sourceIndexes[sourceIndexes.length - 1];
    // ASR may omit or misspell the first character of the neighboring word.
    // Bound the context by the nearest acoustic evidence instead of treating an
    // unmapped immediate neighbor as a numeric failure. Any inserted numeric
    // continuation still remains inside this wider gap and is rejected below.
    const previousTranscriptIndex = nearestMappedTranscriptBefore(firstSourceIndex);
    const nextTranscriptIndex = nearestMappedTranscriptAfter(lastSourceIndex);
    const leftGap = transcriptChars.slice(
      firstSourceIndex === 0 ? 0 : Math.max(0, previousTranscriptIndex + 1),
      mapped[0],
    ).join("");
    const rightGap = transcriptChars.slice(
      mapped[mapped.length - 1] + 1,
      lastSourceIndex === sourceChars.length - 1 ? transcriptChars.length : nextTranscriptIndex,
    ).join("");
    const sourcePrefix = sourceChars.slice(0, firstSourceIndex).join("");
    const sourceSuffix = sourceChars.slice(lastSourceIndex + 1).join("");
    const transcriptPrefix = transcriptChars.slice(0, mapped[0]).join("");
    const transcriptSuffix = transcriptChars.slice(mapped[mapped.length - 1] + 1).join("");
    const hasChangedLeftNumericContinuation = THAI_NUMBER_SPEECH_PARTS.some((part) =>
      transcriptPrefix.endsWith(part) && !sourcePrefix.endsWith(part),
    );
    const hasChangedRightNumericContinuation = THAI_NUMBER_SPEECH_PARTS.some((part) =>
      transcriptSuffix.startsWith(part) && !sourceSuffix.startsWith(part),
    );
    // Benign ASR insertions next to a fully proven number must not invalidate
    // that number. Numeric continuations remain fail-closed: 20→25 creates a
    // right gap of "ห้า"; 3→13 creates a left gap of "สิบ".
    if (
      hasChangedLeftNumericContinuation
      || hasChangedRightNumericContinuation
      || containsThaiNumberSpeech(leftGap)
      || containsThaiNumberSpeech(rightGap)
    ) {
      return { status: "failed", code: "numeric_context_mismatch" };
    }
  }

  const mappedCharsByWord = sourceWords.map(() => [] as number[]);
  transcriptCharBySourceChar.forEach((transcriptCharIndex, sourceCharIndex) => {
    if (transcriptCharIndex >= 0) {
      mappedCharsByWord[sourceWordByChar[sourceCharIndex]].push(transcriptCharIndex);
    }
  });
  if (mappedCharsByWord.some((mapped) => mapped.length === 0)) {
    return { status: "failed", code: "incomplete_alignment" };
  }

  const words = sourceWords.map((source, wordIndex): TimedWord => {
    const mapped = mappedCharsByWord[wordIndex];
    const first = transcriptCharTimes[mapped[0]];
    const last = transcriptCharTimes[mapped[mapped.length - 1]];
    const startMs = Math.round(first.startMs);
    return {
      word: source.word,
      startMs,
      endMs: Math.max(startMs + 1, Math.round(last.endMs)),
      startChar: source.startChar,
      endChar: source.endChar,
    };
  });
  if (words.some((word, index) => index > 0 && word.startMs < words[index - 1].endMs)) {
    return { status: "failed", code: "overlapping_timing" };
  }
  return { status: "aligned", words, method: "fuzzy", similarity };
}

/** Attach transcript timestamps to canonical source tokens and retain the
 * exact rejection reason for production diagnosis. */
export function alignTranscriptWordsToSourceDetailed(
  fullText: string,
  transcriptWords: TranscriptWord[],
): TranscriptAlignmentResult {
  const sourceWords = tokenizeWords(fullText);
  if (sourceWords.length === 0) return { status: "failed", code: "empty_source" };
  if (transcriptWords.length === 0) return { status: "failed", code: "empty_transcript" };
  const usableTranscript = transcriptWords.filter((word) =>
    typeof word?.word === "string"
    && word.word.trim().length > 0
    && Number.isFinite(word.startMs)
    && Number.isFinite(word.endMs)
    && word.startMs >= 0
    && word.endMs > word.startMs,
  );
  if (usableTranscript.length === 0) return { status: "failed", code: "no_usable_words" };
  if (usableTranscript.some((word, index) => index > 0 && word.startMs < usableTranscript[index - 1].endMs)) {
    return { status: "failed", code: "overlapping_timing" };
  }

  const exact = alignTranscriptWordsExactly(sourceWords, usableTranscript);
  if (exact.status === "aligned") {
    return hasPlausibleAlignedWordTiming(exact.words)
      ? exact
      : { status: "failed", code: "implausible_timing_density" };
  }
  if (exact.code !== "text_mismatch" && exact.code !== "incomplete_alignment") return exact;
  const fuzzy = alignTranscriptWordsFuzzily(fullText, sourceWords, usableTranscript);
  if (fuzzy.status !== "aligned") return fuzzy;
  return hasPlausibleAlignedWordTiming(fuzzy.words)
    ? fuzzy
    : { status: "failed", code: "implausible_timing_density" };
}

/**
 * Compatibility wrapper for authored-script/forced-alignment callers, where a
 * mismatch must still fail closed.
 */
export function alignTranscriptWordsToSource(
  fullText: string,
  transcriptWords: TranscriptWord[],
): TimedWord[] | null {
  const result = alignTranscriptWordsToSourceDetailed(fullText, transcriptWords);
  return result.status === "aligned" ? result.words : null;
}

export type UploadTranscriptWordResolution = {
  words: TimedWord[];
  regroupingAvailable: boolean;
  failureCode: TranscriptAlignmentFailureCode | null;
};

/**
 * Upload captions are already timestamped from the clip's own audio. Character
 * offsets exist only for the optional "split by word count" editor control, so
 * an ASR text-projection mismatch disables that control without discarding the
 * acoustically aligned captions or failing the whole VideoJob.
 */
export function resolveUploadTranscriptWords(
  fullText: string,
  transcriptWords: TranscriptWord[],
): UploadTranscriptWordResolution {
  const result = alignTranscriptWordsToSourceDetailed(fullText, transcriptWords);
  return result.status === "aligned"
    ? { words: result.words, regroupingAvailable: true, failureCode: null }
    : { words: [], regroupingAvailable: false, failureCode: result.code };
}

export interface CanonicalAlignedCaption {
  text: string;
  startMs: number;
  endMs: number;
  tag: "hook" | "body";
  startChar: number;
  endChar: number;
}

/**
 * Build sentence captions whose timestamps come from a proven transcript-word
 * alignment while every displayed character comes from the canonical script.
 * Forced-alignment providers routinely normalize quotes, ellipses, punctuation
 * and spacing in their display captions; those captions are useful timing hints,
 * but must never replace the exact text that was sent to TTS.
 */
export function buildCanonicalCaptionsFromAlignedWords(
  fullText: string,
  words: TimedWord[],
  maxCardChars: number,
  cardsOverride?: ReturnType<typeof splitSentenceCards>,
  minCardMs = MIN_CARD_MS,
): CanonicalAlignedCaption[] | null {
  if (!fullText.trim() || words.length === 0) return null;
  if (words.some((word, index) =>
    !Number.isInteger(word.startChar)
    || !Number.isInteger(word.endChar)
    || word.startChar < 0
    || word.endChar <= word.startChar
    || word.endChar > fullText.length
    || !Number.isFinite(word.startMs)
    || !Number.isFinite(word.endMs)
    || word.startMs < 0
    || word.endMs <= word.startMs
    || (index > 0 && (
      word.startChar < words[index - 1].endChar
      || word.startMs < words[index - 1].endMs
    )),
  )) return null;

  const cards = snapCardsToWordBoundaries(
    cardsOverride ?? splitSentenceCards(fullText, Math.max(10, maxCardChars)),
    fullText,
  );
  if (cards.length === 0) return null;

  const captions: CanonicalAlignedCaption[] = [];
  let pendingStartChar = cards[0].startChar;
  let wordIndex = 0;
  for (const card of cards) {
    while (wordIndex < words.length && words[wordIndex].endChar <= card.startChar) wordIndex += 1;
    const firstWordIndex = wordIndex;
    while (wordIndex < words.length && words[wordIndex].startChar < card.endChar) wordIndex += 1;
    const firstWord = words[firstWordIndex];
    const lastWord = words[wordIndex - 1];
    if (!firstWord || !lastWord || firstWordIndex >= wordIndex) continue;
    const text = fullText.slice(pendingStartChar, card.endChar).replace(/\s+/gu, " ").trim();
    if (!text) continue;
    captions.push({
      text,
      startMs: firstWord.startMs,
      endMs: lastWord.endMs,
      tag: captions.length === 0 ? "hook" : "body",
      startChar: pendingStartChar,
      endChar: card.endChar,
    });
    pendingStartChar = card.endChar;
  }
  if (captions.length === 0) return null;

  // A punctuation-only tail has no timestamp of its own. Attach it to the last
  // spoken card; its timing remains the timestamp of that card's final word.
  if (pendingStartChar < fullText.length) {
    const last = captions[captions.length - 1];
    last.endChar = fullText.length;
    last.text = fullText.slice(last.startChar, last.endChar).replace(/\s+/gu, " ").trim();
  }

  // Merge a card below the caller's readable minimum into a neighbor using one
  // literal source range. The shared default stays at the 240 ms release floor;
  // Story Film opts into a calmer one-second minimum.
  if (captions.length > 1 && captions[0].endMs - captions[0].startMs < minCardMs) {
    const first = captions.shift()!;
    const next = captions[0];
    next.startChar = first.startChar;
    next.startMs = first.startMs;
    next.tag = "hook";
    next.text = fullText.slice(next.startChar, next.endChar).replace(/\s+/gu, " ").trim();
  }
  const readable: CanonicalAlignedCaption[] = [];
  for (const caption of captions) {
    const previous = readable[readable.length - 1];
    if (previous && caption.endMs - caption.startMs < minCardMs) {
      previous.endChar = caption.endChar;
      previous.endMs = caption.endMs;
      previous.text = fullText.slice(previous.startChar, previous.endChar).replace(/\s+/gu, " ").trim();
    } else {
      readable.push(caption);
    }
  }

  const rendered = readable.map((caption) => caption.text).join("");
  return canonicalVisibleText(rendered) === canonicalVisibleText(fullText) ? readable : null;
}

/**
 * Preserve creator-authored caption card boundaries while replacing an
 * estimated clock with proven acoustic word timestamps. This is used by the
 * legacy export recovery path: text and card styling stay untouched, only
 * start/end times are repaired from the Narration Master.
 */
export function retimeCanonicalCaptionsFromAlignedWords<
  T extends { text: string; startMs: number; endMs: number },
>(
  fullText: string,
  captions: T[],
  words: TimedWord[],
): T[] | null {
  if (!fullText.trim() || captions.length === 0 || words.length === 0) return null;
  if (canonicalVisibleText(captions.map((caption) => caption.text).join("")) !== canonicalVisibleText(fullText)) {
    return null;
  }

  // Word char offsets index the literal TTS source, so never normalize this
  // string before slicing it. Comparison helpers normalize the slices instead.
  const source = fullText;
  const visibleSource: Array<{ start: number; end: number }> = [];
  let sourceOffset = 0;
  for (const char of source) {
    const start = sourceOffset;
    sourceOffset += char.length;
    if (!/\s/u.test(char)) visibleSource.push({ start, end: sourceOffset });
  }

  let visibleCursor = 0;
  const retimed: T[] = [];
  for (const caption of captions) {
    const visibleLength = Array.from(caption.text.normalize("NFC"))
      .filter((char) => !/\s/u.test(char)).length;
    if (visibleLength === 0) return null;
    const firstVisible = visibleSource[visibleCursor];
    const lastVisible = visibleSource[visibleCursor + visibleLength - 1];
    if (!firstVisible || !lastVisible) return null;

    const sourceText = source.slice(firstVisible.start, lastVisible.end);
    if (canonicalCardSpacing(caption.text) !== canonicalCardSpacing(sourceText)) return null;
    const matchingWords = words.filter((word) =>
      word.endChar > firstVisible.start && word.startChar < lastVisible.end,
    );
    const firstWord = matchingWords[0];
    const lastWord = matchingWords[matchingWords.length - 1];
    if (!firstWord || !lastWord) return null;
    retimed.push({
      ...caption,
      startMs: firstWord.startMs,
      endMs: lastWord.endMs,
    });
    visibleCursor += visibleLength;
  }

  if (visibleCursor !== visibleSource.length) return null;
  return retimed.every((caption, index) =>
    Number.isFinite(caption.startMs)
    && Number.isFinite(caption.endMs)
    && caption.startMs >= 0
    && caption.endMs > caption.startMs
    && (index === 0 || caption.startMs >= retimed[index - 1].endMs),
  ) ? retimed : null;
}

/**
 * Final, provider-independent subtitle release gate.
 *
 * This validates the exact captions that will be burned, not an earlier draft. Whitespace
 * reflow is allowed because cards intentionally collapse authored line breaks, but every
 * visible character/number/punctuation mark must survive unchanged.
 */
/** Presentation issues the creator can fix in the Post-phase editor.
 *  These must not fail the VideoJob — the clip still exports, with the report
 *  attached so the editor can surface an inline fix. Timing/empty failures
 *  still block release (unusable or unsynced captions). */
export const INLINE_FIXABLE_SUBTITLE_CODES = [
  "spacing_mismatch",
  "punctuation_only_card",
  "card_too_short",
] as const;

export type InlineFixableSubtitleCode = (typeof INLINE_FIXABLE_SUBTITLE_CODES)[number];

const INLINE_FIXABLE_SUBTITLE_CODE_SET = new Set<string>(INLINE_FIXABLE_SUBTITLE_CODES);

export function isInlineFixableSubtitleCode(code: string | undefined): code is InlineFixableSubtitleCode {
  return Boolean(code && INLINE_FIXABLE_SUBTITLE_CODE_SET.has(code));
}

export function subtitleQualityShouldFailJob(report: SubtitleQualityReport): boolean {
  if (report.status === "passed") return false;
  return !isInlineFixableSubtitleCode(report.code);
}

export function subtitleQualityInlineCopy(code: InlineFixableSubtitleCode): string {
  switch (code) {
    case "spacing_mismatch":
      return "ช่องว่างในซับเพี้ยน — แก้ในการ์ดซับด้านซ้ายได้";
    case "punctuation_only_card":
      return "มีการ์ดที่เป็นเครื่องหมายอย่างเดียว — ลบหรือรวมการ์ดได้";
    case "card_too_short":
      return "มีการ์ดสั้นเกินไป — ยืดเวลาหรือรวมการ์ดได้";
  }
}

export function validateSubtitleQuality(input: SubtitleQualityInput): SubtitleQualityReport {
  const script = input.script.trim();
  if (!script) {
    return { status: "failed", timingSource: input.timingSource, textExact: false, code: "empty_script" };
  }
  if (!Array.isArray(input.captions) || input.captions.length === 0) {
    return { status: "failed", timingSource: input.timingSource, textExact: false, code: "empty_captions" };
  }

  const renderedText = input.captions.map((caption) => caption.text).join("");
  const textExact = canonicalVisibleText(renderedText) === canonicalVisibleText(script);
  if (!textExact) {
    return { status: "failed", timingSource: input.timingSource, textExact, code: "text_mismatch" };
  }
  if (input.timingSource === "tts_segment_timing" || input.timingSource === "avatar_script_clock") {
    return {
      status: "failed",
      timingSource: input.timingSource,
      textExact,
      code: "unverified_alignment",
    };
  }
  const spacing = hasExactInternalSpacing(script, input.captions);
  if (!spacing.passed) {
    return {
      status: "failed",
      timingSource: input.timingSource,
      textExact,
      code: "spacing_mismatch",
      captionIndex: spacing.captionIndex,
    };
  }

  let previousEnd = -1;
  for (let index = 0; index < input.captions.length; index += 1) {
    const caption = input.captions[index];
    const text = caption.text.trim();
    const startMs = Number(caption.startMs);
    const endMs = Number(caption.endMs);
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      return { status: "failed", timingSource: input.timingSource, textExact, code: "invalid_timing", captionIndex: index };
    }
    if (startMs < previousEnd) {
      return { status: "failed", timingSource: input.timingSource, textExact, code: "overlapping_timing", captionIndex: index };
    }
    if (endMs > input.audioDurationMs + AUDIO_END_TOLERANCE_MS) {
      return { status: "failed", timingSource: input.timingSource, textExact, code: "timing_out_of_bounds", captionIndex: index };
    }
    if (THAI_COMBINING_MARK_AT_START.test(text)) {
      return { status: "failed", timingSource: input.timingSource, textExact, code: "broken_thai_grapheme", captionIndex: index };
    }
    if (PUNCTUATION_OR_SYMBOLS_ONLY.test(text)) {
      return { status: "failed", timingSource: input.timingSource, textExact, code: "punctuation_only_card", captionIndex: index };
    }
    if (endMs - startMs < MIN_CARD_MS) {
      return { status: "failed", timingSource: input.timingSource, textExact, code: "card_too_short", captionIndex: index };
    }
    previousEnd = endMs;
  }

  return {
    status: "passed",
    timingSource: input.timingSource,
    textExact: true,
    captionCount: input.captions.length,
    audioDurationMs: input.audioDurationMs,
  };
}
