import {
  snapCardsToWordBoundaries,
  splitSentenceCards,
  tokenizeWords,
  type TimedWord,
} from "@/lib/tts-timing";

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
  | "text_mismatch"
  | "incomplete_alignment";

export type TranscriptAlignmentResult =
  | { status: "aligned"; words: TimedWord[] }
  | { status: "failed"; code: TranscriptAlignmentFailureCode };

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
    ? { status: "aligned", words: aligned }
    : { status: "failed", code: "incomplete_alignment" };
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
    splitSentenceCards(fullText, Math.max(10, maxCardChars)),
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

  // The release gate requires a readable 240 ms minimum. Merge an exceptionally
  // short forced-aligned card into a neighbor using one literal source range.
  if (captions.length > 1 && captions[0].endMs - captions[0].startMs < MIN_CARD_MS) {
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
    if (previous && caption.endMs - caption.startMs < MIN_CARD_MS) {
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
