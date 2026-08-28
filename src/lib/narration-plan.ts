export const NARRATION_PLAN_VERSION = 1 as const;

export interface NarrationPlanSegment {
  sourceStart: number;
  sourceEnd: number;
  displayStart: number;
  displayEnd: number;
  speechStart: number;
  speechEnd: number;
}

export interface NarrationPlanV1 {
  version: typeof NARRATION_PLAN_VERSION;
  sourceText: string;
  displayText: string;
  speechText: string;
  segments: NarrationPlanSegment[];
}

const STRUCTURAL_SEPARATOR_RE = /(?:\r\n?|\n|[\u200B\u2060\uFEFF])+/gu;
const INLINE_WHITESPACE_RE = /\s+/gu;

function normalizeTechnicalPunctuation(value: string): string {
  return value
    .replace(/…+/gu, "...")
    .replace(/\.{4,}/gu, "...")
    .replace(/!{2,}/gu, "!")
    .replace(/\?{2,}/gu, "?");
}

function normalizeNarrationPart(value: string): string {
  return normalizeTechnicalPunctuation(
    value.normalize("NFC").replace(INLINE_WHITESPACE_RE, " ").trim(),
  );
}

/**
 * Compile authored text into the one deterministic text contract consumed by
 * TTS and caption alignment. The authored source is immutable; only technical
 * separators are canonicalized, and no external model is involved.
 */
export function compileNarrationPlan(sourceText: string): NarrationPlanV1 {
  const parts: Array<{ sourceStart: number; sourceEnd: number; text: string }> = [];
  let sourceCursor = 0;

  for (const separator of sourceText.matchAll(STRUCTURAL_SEPARATOR_RE)) {
    const separatorStart = separator.index ?? 0;
    if (separatorStart > sourceCursor) {
      parts.push({
        sourceStart: sourceCursor,
        sourceEnd: separatorStart,
        text: normalizeNarrationPart(sourceText.slice(sourceCursor, separatorStart)),
      });
    }
    sourceCursor = separatorStart + separator[0].length;
  }
  if (sourceCursor < sourceText.length) {
    parts.push({
      sourceStart: sourceCursor,
      sourceEnd: sourceText.length,
      text: normalizeNarrationPart(sourceText.slice(sourceCursor)),
    });
  }

  let compiledText = "";
  const segments = parts.flatMap((part) => {
    if (!part.text) return [];
    if (compiledText) compiledText += " ";
    const start = compiledText.length;
    compiledText += part.text;
    const end = compiledText.length;
    return [{
      sourceStart: part.sourceStart,
      sourceEnd: part.sourceEnd,
      displayStart: start,
      displayEnd: end,
      speechStart: start,
      speechEnd: end,
    }];
  });

  return {
    version: NARRATION_PLAN_VERSION,
    sourceText,
    displayText: compiledText,
    speechText: compiledText,
    segments,
  };
}

/** Accept only the exact server-persisted v1 contract for this authored source. */
export function parseNarrationPlan(
  value: unknown,
  sourceText: string,
): NarrationPlanV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<NarrationPlanV1>;
  if (
    candidate.version !== NARRATION_PLAN_VERSION
    || candidate.sourceText !== sourceText
    || typeof candidate.displayText !== "string"
    || typeof candidate.speechText !== "string"
    || candidate.displayText !== candidate.speechText
    || !Array.isArray(candidate.segments)
  ) return null;

  let previousSourceEnd = 0;
  let previousDisplayEnd = 0;
  for (const segment of candidate.segments) {
    if (
      !segment
      || typeof segment !== "object"
      || !Number.isInteger(segment.sourceStart)
      || !Number.isInteger(segment.sourceEnd)
      || !Number.isInteger(segment.displayStart)
      || !Number.isInteger(segment.displayEnd)
      || !Number.isInteger(segment.speechStart)
      || !Number.isInteger(segment.speechEnd)
      || segment.sourceStart < previousSourceEnd
      || segment.sourceEnd <= segment.sourceStart
      || segment.sourceEnd > sourceText.length
      || segment.displayStart < previousDisplayEnd
      || segment.displayEnd <= segment.displayStart
      || segment.displayEnd > candidate.displayText.length
      || segment.speechStart !== segment.displayStart
      || segment.speechEnd !== segment.displayEnd
    ) return null;
    previousSourceEnd = segment.sourceEnd;
    previousDisplayEnd = segment.displayEnd;
  }
  if (!candidate.displayText && candidate.segments.length > 0) return null;
  return candidate as NarrationPlanV1;
}
