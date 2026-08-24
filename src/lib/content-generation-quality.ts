export type ContentInputMode = "topic" | "source";

export type GeneratedContentPayload = {
  headline: string;
  subHeadline: string;
  content: string;
  hashtags: string;
  imagePrompt: string;
  visualNotes: string;
};

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "you", "are", "was", "how",
  "ของ", "และ", "ที่", "ให้", "เป็น", "จาก", "กับ", "หรือ", "ใน", "ได้", "มี", "เรา", "คุณ", "เพื่อ",
]);

export function normalizeContentInputMode(
  value: unknown,
  fallbackInput: string,
  hasSourceUrl = false,
): ContentInputMode {
  if (value === "topic" || value === "source") return value;
  if (hasSourceUrl) return "source";
  return fallbackInput.trim().length <= 280 ? "topic" : "source";
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Parse the provider response into the exact API contract before relevance checks. */
export function parseGeneratedContentResponse(raw: string): GeneratedContentPayload | null {
  try {
    const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const value = JSON.parse(clean) as Record<string, unknown>;
    const headline = requiredString(value.headline);
    const subHeadline = requiredString(value.subHeadline ?? value.subheadline);
    const content = requiredString(value.content);
    const hashtags = Array.isArray(value.hashtags)
      ? value.hashtags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())).join(" ")
      : requiredString(value.hashtags);
    const imagePrompt = requiredString(value.imagePrompt);
    const visualNotes = requiredString(value.visualNotes);
    if (!headline || !subHeadline || !content || !hashtags || !imagePrompt || !visualNotes) return null;
    return { headline, subHeadline, content, hashtags, imagePrompt, visualNotes };
  } catch {
    return null;
  }
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  );
}

function trigrams(value: string, maxChars: number): Set<string> {
  const compact = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, maxChars);
  const grams = new Set<string>();
  for (let index = 0; index <= compact.length - 3; index++) grams.add(compact.slice(index, index + 3));
  return grams;
}

function overlapScore(source: Set<string>, output: Set<string>, denominatorCap: number): number {
  if (source.size === 0 || output.size === 0) return 0;
  let shared = 0;
  for (const item of source) if (output.has(item)) shared++;
  return shared / Math.max(1, Math.min(source.size, denominatorCap));
}

/**
 * Deliberately a soft, deterministic floor: it catches total topic drift while
 * allowing paraphrases. Thai text additionally uses character trigrams because
 * it commonly arrives without whitespace word boundaries.
 */
export function generatedContentRelevanceScore(
  inputText: string,
  generated: GeneratedContentPayload,
  inputMode: ContentInputMode,
): number {
  const focus = inputMode === "topic" ? inputText.slice(0, 600) : inputText.slice(0, 4_000);
  const output = `${generated.headline} ${generated.subHeadline} ${generated.content}`;
  const tokenScore = overlapScore(terms(focus), terms(output), inputMode === "topic" ? 8 : 16);
  const gramScore = overlapScore(
    trigrams(focus, inputMode === "topic" ? 600 : 4_000),
    trigrams(output, 5_000),
    inputMode === "topic" ? 30 : 80,
  );
  return Math.max(tokenScore, gramScore);
}

export function generatedContentIsRelevant(
  inputText: string,
  generated: GeneratedContentPayload,
  inputMode: ContentInputMode,
): boolean {
  const score = generatedContentRelevanceScore(inputText, generated, inputMode);
  return score >= (inputMode === "topic" ? 0.12 : 0.06);
}

export async function generateContentWithRelevanceRetry(input: {
  basePrompt: string;
  inputText: string;
  inputMode: ContentInputMode;
  generate: (prompt: string, attempt: number) => Promise<string>;
}): Promise<
  | { ok: true; content: GeneratedContentPayload; attempts: number; relevanceScore: number }
  | { ok: false; reason: "invalid_model_output" | "content_off_topic"; attempts: number }
> {
  let lastReason: "invalid_model_output" | "content_off_topic" = "invalid_model_output";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const correction = attempt === 1
      ? ""
      : `\n\nCORRECTION REQUIRED:\nThe previous answer was invalid or drifted away from the supplied ${input.inputMode === "topic" ? "topic/brief" : "source material"}. Regenerate from scratch. Keep the headline and every main section explicitly grounded in the supplied subject. Return only the required JSON.`;
    const raw = await input.generate(`${input.basePrompt}${correction}`, attempt);
    const parsed = parseGeneratedContentResponse(raw);
    if (!parsed) {
      lastReason = "invalid_model_output";
      continue;
    }
    const relevanceScore = generatedContentRelevanceScore(input.inputText, parsed, input.inputMode);
    if (generatedContentIsRelevant(input.inputText, parsed, input.inputMode)) {
      return { ok: true, content: parsed, attempts: attempt, relevanceScore };
    }
    lastReason = "content_off_topic";
  }
  return { ok: false, reason: lastReason, attempts: 2 };
}
