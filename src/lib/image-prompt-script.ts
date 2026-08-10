/** Writing-system guard for text that is about to become an image prompt.
 *
 * ADR 0007 permits English lettering in a generated image and forbids Thai: the
 * 2026-08-10 probe rendered a nine-word English sentence correctly and rendered
 * Thai as authentic-looking glyphs that spell nothing, which a Thai viewer reads
 * as broken. The model this system renders on (`z-image-turbo`) is positive-only
 * on both of its routes, so there is no negative-prompt channel to suppress a
 * writing system with — the only enforcement available is to not put it in the
 * prompt.
 *
 * The planner prompts already ask Gemini to write every beat field in English.
 * This is the backstop for when it does not, and for the paths that bypass the
 * planner entirely (a fallback brief built straight from Thai narration).
 *
 * Deliberately NOT applied to text a person typed as their own request — an
 * AI Studio prompt written in Thai is intent, not a leak, and stripping it would
 * leave the caller with no subject at all. That path needs translation, which is
 * a separate feature.
 */

/** Characters outside the Latin script and the script-neutral set (digits,
 * punctuation, spaces, currency signs). Thai, CJK, Cyrillic, Arabic, Hebrew,
 * Devanagari and Hangul all fall outside it. */
const NON_LATIN_CHARACTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+/gu;
/** Same class without `g`, so `.test()` carries no `lastIndex` state between
 * calls — a global regex would answer differently on every other call. */
const NON_LATIN_MARKER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * Strip non-Latin writing from a prompt fragment.
 *
 * Returns `""` when nothing readable survives, so a caller can fall back to its
 * own English default rather than emit a fragment of stray punctuation — which
 * a diffusion text encoder would still try to render.
 */
export function latinLetteringOnly(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (!NON_LATIN_MARKER.test(value)) return value;
  const stripped = value
    .replace(NON_LATIN_CHARACTER, " ")
    // Punctuation left orphaned by the removal reads as noise, not as writing.
    .replace(/\s+([,.;:!?)\]}])/g, "$1")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/([,;:]\s*){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:!?)\]}"'`—–-]+/, "")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
  return LATIN_LETTER.test(stripped) ? stripped : "";
}

/** True when a value carries writing this system will not send to an image
 * model. Used by verification and by callers that want to log the substitution
 * rather than silently swallow it. */
export function hasNonLatinLettering(value: string | null | undefined): boolean {
  return typeof value === "string" && NON_LATIN_MARKER.test(value);
}
