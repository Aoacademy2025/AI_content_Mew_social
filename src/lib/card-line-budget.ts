// Card Line Budget (CONTEXT.md) — how much Caption text fits on one rendered line at the
// active subtitle size. A word-count Caption ("1"–"4" words) stays within one line; a
// sentence Caption stays within two lines, broken at a Thai word boundary.
//
// Pure leaf module: it imports neither orchestrator nor Remotion code, so the caption
// core (tts-timing, word grouping), the renderer and the QA report can all share it.

/** The subtitle size (px on the 1080×1920 frame) every surface uses until a caller passes
 *  the resolved one. Matches `DEFAULT_STYLE.subtitleSize` and `DEFAULT_V2_SUB.fontSize`. */
export const DEFAULT_CARD_SUBTITLE_SIZE = 80;

/** One rendered line, in base graphemes, at `subtitleSize`. The editor's long-standing
 *  formula (920 px of usable width, ~0.47 em per Thai base glyph), floored at 10. */
export function maxCardCharsFor(subtitleSize: number = DEFAULT_CARD_SUBTITLE_SIZE): number {
  const size = Number.isFinite(subtitleSize) && subtitleSize > 0 ? subtitleSize : DEFAULT_CARD_SUBTITLE_SIZE;
  return Math.max(10, Math.floor((1080 - 160) / (size * 0.47)));
}

const NONSPACING_MARK = /\p{Mn}/u;

/** Characters that take horizontal room: every code point except Unicode Mn (Thai above
 *  and below vowels, tone marks, thanthakhat). "กระจุกอยู่ที่เด็กซึ่ง…" is 46 code units
 *  but 33 base graphemes. */
export function baseGraphemeCount(text: string): number {
  let count = 0;
  for (const char of text.normalize("NFC")) {
    if (!NONSPACING_MARK.test(char)) count += 1;
  }
  return count;
}

/** Word-count modes ("1"–"4") get one line; "sentence" (and an unset mode) gets two. */
export function cardLineCount(mode: string | null | undefined): 1 | 2 {
  return typeof mode === "string" && /^[1-9]\d*$/.test(mode) ? 1 : 2;
}

/** Whether a Caption's displayed text is within its budget, counted in base graphemes on
 *  the text as rendered (whitespace runs collapsed, trimmed). */
export function fitsCardLineBudget(text: string, mode: string | null | undefined, size: number): boolean {
  const displayed = text.replace(/\s+/gu, " ").trim();
  return baseGraphemeCount(displayed) <= cardLineCount(mode) * maxCardCharsFor(size);
}
