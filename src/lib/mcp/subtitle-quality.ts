import { tokenizeWords, type TimedWord } from "@/lib/tts-timing";

export type SubtitleTimingSource =
  | "provider_alignment"
  | "tts_segment_timing"
  | "forced_alignment"
  | "upload_transcription";

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

/**
 * Attach transcript timestamps to the canonical source tokens used by subtitle regrouping.
 * A mismatch fails closed: guessing offsets would re-introduce the word-splitting drift this
 * quality gate exists to prevent.
 */
export function alignTranscriptWordsToSource(
  fullText: string,
  transcriptWords: TranscriptWord[],
): TimedWord[] | null {
  const sourceWords = tokenizeWords(fullText);
  const usableTranscript = transcriptWords.filter((word) =>
    typeof word?.word === "string"
    && word.word.trim().length > 0
    && Number.isFinite(word.startMs)
    && Number.isFinite(word.endMs)
    && word.startMs >= 0
    && word.endMs > word.startMs,
  );
  if (sourceWords.length === 0 || usableTranscript.length === 0) return null;
  if (usableTranscript.some((word, index) => index > 0 && word.startMs < usableTranscript[index - 1].endMs)) return null;

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
        if (sourceIndex >= sourceWords.length) return null;
        sourceText += tokenText(sourceWords[sourceIndex++].word);
      } else if (transcriptText.length < sourceText.length && sourceText.startsWith(transcriptText)) {
        if (transcriptIndex >= usableTranscript.length) return null;
        transcriptText += tokenText(usableTranscript[transcriptIndex++].word);
      } else {
        return null;
      }
    }

    const sourceGroup = sourceWords.slice(sourceStart, sourceIndex);
    const transcriptGroup = usableTranscript.slice(transcriptStart, transcriptIndex);
    const transcriptLengths = transcriptGroup.map((word) => tokenText(word.word).length);
    const totalChars = transcriptLengths.reduce((sum, length) => sum + length, 0);
    if (totalChars <= 0) return null;

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
    ? aligned
    : null;
}

/**
 * Final, provider-independent subtitle release gate.
 *
 * This validates the exact captions that will be burned, not an earlier draft. Whitespace
 * reflow is allowed because cards intentionally collapse authored line breaks, but every
 * visible character/number/punctuation mark must survive unchanged.
 */
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
