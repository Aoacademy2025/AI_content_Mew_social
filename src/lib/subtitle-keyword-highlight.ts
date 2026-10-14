import { baseGraphemeCount } from "./card-line-budget";

/**
 * EP5/S2 Backlog #2 — Auto-Highlight Keywords in Subtitles (`highlightKeywords: boolean`).
 *
 * Pure, deterministic keyword selector shared by the Remotion subtitle renderer
 * (`renderSubtitle.tsx`) and the browser preview (`V2CaptionOverlay`).
 *
 * Rules:
 * - Highlights at most 1–2 salient word-like tokens per caption card using `accentColor`
 *   so key numbers, stats, power words, or primary content words pop without turning the
 *   entire card into a wall of accent color.
 * - Priority 1: Numeric / stat / currency / percentage / multiplier tokens (`3`, `10x`, `50%`, `฿990`, Thai digits).
 * - Priority 2: High-impact Thai/English power & emphasis words (`ฟรี`, `ลับ`, `ด่วน`, `สำคัญ`, `ห้าม`, `ต้อง`, `หยุด`, `ระวัง`, `เพิ่ม`, `ลด`, `รวย`, `พัง`, `ไวรัล`, `ทะลุ`, `ล้าน`, `เท่า`, `ทันที`, `ง่าย`, `จริง`, `AI`, etc.) or English acronyms/loanwords (`/[A-Za-z]{2,}/`).
 * - Priority 3: Longest content word (`baseGraphemeCount >= 3`) that is not a common Thai function/stop word.
 * - Short cards (≤ 2 word-like tokens total) highlight at most 1 token so the card keeps contrast.
 */

export type HighlightableToken = {
  text: string;
  isWordLike: boolean;
};

const THAI_STOP_WORDS = new Set([
  "ครับ",
  "ค่ะ",
  "คะ",
  "นะ",
  "นะครับ",
  "นะคะ",
  "ที่",
  "และ",
  "หรือ",
  "ของ",
  "ใน",
  "การ",
  "ความ",
  "ให้",
  "ได้",
  "มี",
  "เป็น",
  "จะ",
  "ก็",
  "มา",
  "ไป",
  "กัน",
  "ว่า",
  "กับ",
  "แต่",
  "จาก",
  "ถึง",
  "แล้ว",
  "อยู่",
  "คือ",
  "ไม่",
  "นี้",
  "นั้น",
  "โน้น",
  "เรา",
  "คุณ",
  "ผม",
  "ฉัน",
  "เขา",
  "มัน",
  "ด้วย",
  "เลย",
  "มาก",
  "กว่า",
  "เมื่อ",
  "เพราะ",
  "ถ้า",
  "จึง",
  "ต้อง",
  "แบบ",
  "เรื่อง",
  "อย่าง",
  "ทำ",
  "คน",
  "ตัว",
  "อัน",
  "สิ่ง",
  "ตอน",
  "วัน",
  "the",
  "and",
  "for",
  "with",
  "to",
  "in",
  "of",
  "is",
  "on",
  "at",
  "by",
  "or",
  "as",
  "be",
  "an",
  "a",
  "it",
  "this",
  "that",
  "from",
  "are",
  "was",
  "were",
]);

const POWER_WORDS = new Set([
  "ฟรี",
  "ลับ",
  "ความลับ",
  "ด่วน",
  "สำคัญ",
  "ห้าม",
  "หยุด",
  "ระวัง",
  "เตือน",
  "เพิ่ม",
  "ลด",
  "รวย",
  "พัง",
  "ไวรัล",
  "ทะลุ",
  "ล้าน",
  "แสน",
  "หมื่น",
  "พัน",
  "เปอร์เซ็นต์",
  "เท่า",
  "ทันที",
  "ง่าย",
  "จริง",
  "กำไร",
  "ขาดทุน",
  "ยอดขาย",
  "ยอดวิว",
  "เทคนิค",
  "วิธี",
  "สรุป",
  "จบ",
  "ครบ",
  "คุ้ม",
  "เร็ว",
  "ไว",
  "ฟรีๆ",
  "เปลี่ยน",
  "สำเร็จ",
  "พลาด",
]);

const NUMERIC_TOKEN_RE = /[\d\u0E50-\u0E59]+(?:[.,][\d\u0E50-\u0E59]+)*(?:%|x|X|เท่า|บาท|วิ|วินาที|นาที|ชั่วโมง|วัน|ปี|เดือน|คน|ข้อ|แบบ|ล้าน|แสน|หมื่น|พัน)?|[฿$€¥]\s*[\d\u0E50-\u0E59]+/u;
const LATIN_ACRONYM_OR_TERM_RE = /^[A-Za-z][A-Za-z0-9+-]{1,}$/u;

function cleanToken(raw: string): string {
  return raw.replace(/^[^\p{L}\p{M}\p{N}฿$€¥%]+|[^\p{L}\p{M}\p{N}%]+$/gu, "").trim();
}

export function scoreSubtitleTokenForHighlight(rawToken: string): number {
  const token = cleanToken(rawToken);
  if (!token) return 0;

  if (NUMERIC_TOKEN_RE.test(token)) {
    return 100 + Math.min(15, baseGraphemeCount(token));
  }

  const lower = token.toLowerCase();
  if (POWER_WORDS.has(token) || POWER_WORDS.has(lower)) {
    return 85 + Math.min(10, baseGraphemeCount(token));
  }

  if (THAI_STOP_WORDS.has(token) || THAI_STOP_WORDS.has(lower)) {
    return 0;
  }

  if (LATIN_ACRONYM_OR_TERM_RE.test(token) && token.length >= 2) {
    return 75 + Math.min(10, token.length);
  }

  const graphemes = baseGraphemeCount(token);
  if (graphemes < 3) return 0;

  return 30 + Math.min(25, graphemes * 3);
}

/**
 * Given the word-segmented tokens of a caption card (where `tokenIdx` counts only
 * `isWordLike` tokens in reading order), returns the set of `tokenIdx` values (0-based
 * among word-like tokens) that should be highlighted with `accentColor`.
 */
export function selectHighlightedTokenIndices(
  tokens: readonly (HighlightableToken | string)[],
  maxHighlights = 2,
): Set<number> {
  const wordTokens: { wordIdx: number; text: string; score: number }[] = [];
  let wordIdx = 0;
  for (const rawPart of tokens) {
    const part: HighlightableToken = typeof rawPart === "string"
      ? { text: rawPart, isWordLike: rawPart.trim().length > 0 }
      : rawPart;
    if (!part.isWordLike) continue;
    const score = scoreSubtitleTokenForHighlight(part.text);
    wordTokens.push({ wordIdx, text: part.text, score });
    wordIdx += 1;
  }

  if (wordTokens.length === 0 || maxHighlights <= 0) {
    return new Set();
  }

  // If the card only has 1 token, don't highlight it unless it's a number/power word,
  // and for 2-token cards highlight at most 1 token so the card retains contrast.
  const effectiveCap = wordTokens.length <= 2
    ? 1
    : Math.min(maxHighlights, Math.max(1, Math.floor(wordTokens.length / 2)));

  const candidates = wordTokens
    .filter((item) => item.score > 0 && (wordTokens.length > 1 || item.score >= 75))
    .sort((a, b) => b.score - a.score || a.wordIdx - b.wordIdx);

  const chosen = new Set<number>();
  for (const candidate of candidates) {
    if (chosen.size >= effectiveCap) break;
    chosen.add(candidate.wordIdx);
  }

  return chosen;
}

/**
 * Merges adjacent currency/sign prefixes (`+`, `฿`, `$`, `€`, `¥`) and percentage suffixes (`%`)
 * into numeric word-like tokens so `Intl.Segmenter("th", { granularity: "word" })` keeps
 * `+300%` or `฿990` as a single highlightable unit without losing any characters.
 */
export function mergeNumericAffixTokens(parts: readonly HighlightableToken[]): HighlightableToken[] {
  const merged: HighlightableToken[] = [];
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    const next = parts[i + 1];
    if (
      !cur.isWordLike
      && /^[+$฿€¥]+$/u.test(cur.text)
      && next?.isWordLike
      && /^[\d\u0E50-\u0E59]/u.test(next.text)
    ) {
      let combinedText = cur.text + next.text;
      let skip = 1;
      const afterNext = parts[i + 2];
      if (afterNext && !afterNext.isWordLike && /^%$/u.test(afterNext.text)) {
        combinedText += afterNext.text;
        skip = 2;
      }
      merged.push({ text: combinedText, isWordLike: true });
      i += skip;
      continue;
    }
    if (
      cur.isWordLike
      && /[\d\u0E50-\u0E59]$/u.test(cur.text)
      && next
      && !next.isWordLike
      && /^%$/u.test(next.text)
    ) {
      merged.push({ text: cur.text + next.text, isWordLike: true });
      i += 1;
      continue;
    }
    merged.push({ ...cur });
  }
  return merged;
}

/**
 * Convenience helper for tests and previews: segments a caption string using `Intl.Segmenter("th", { granularity: "word" })`
 * and returns the 1–2 highlighted keyword strings in reading order.
 */
export function extractHighlightedKeywords(text: string, maxHighlights = 2): string[] {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];

  let rawParts: HighlightableToken[] = [];
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    const seg = new Seg("th", { granularity: "word" });
    for (const item of seg.segment(trimmed)) {
      rawParts.push({
        text: item.segment,
        isWordLike: item.isWordLike === true && item.segment.trim().length > 0,
      });
    }
  } else {
    const matches = trimmed.match(/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]+/gu) ?? [];
    rawParts = matches.map((m) => ({
      text: m,
      isWordLike: /[\p{L}\p{N}]/u.test(m),
    }));
  }

  const parts = mergeNumericAffixTokens(rawParts);
  const indices = selectHighlightedTokenIndices(parts, maxHighlights);
  const words = parts.filter((p) => p.isWordLike);
  return words
    .filter((_, idx) => indices.has(idx))
    .map((w) => w.text.trim());
}
