/** Shared by editor regrouping and pipeline captions. Offsets reference the
 * authoritative narration text; grouping never estimates a new word clock. */
export interface CaptionTimedWord {
  word: string;
  startChar: number;
  endChar: number;
  startMs: number;
  endMs: number;
}
const SENTENCE_BOUNDARY_RE = /[\n,.!?…ฯ;:，；：]/;
const THAI_BINDS_NEXT = new Set([
  "ไม่", "ได้", "จะ", "กำลัง", "ต้อง", "ควร", "อยาก", "ให้", "ใน", "จาก",
  "ของ", "กับ", "เพื่อ", "โดย", "เพราะ", "ถ้า", "เมื่อ", "คือ", "เป็น", "อย่าง", "ทุก",
  "ช่วง", "ซับ", "นำ", "งาน",
]);
const THAI_BINDS_PREVIOUS = new Set([
  "เดียว", "แล้ว", "อยู่", "ไว้", "มาก", "ขึ้น", "ลง", "ก่อน", "หลัง", "ทันที", "เสมอ", "จริง", "ได้",
]);

export function groupTimedCaptionWords(words: readonly CaptionTimedWord[], n: number, fullText: string) {
  const out: {text: string; startMs: number; endMs: number}[] = [];
  let group: CaptionTimedWord[] = [];
  let textCursor = 0;
  const flush = (endChar: number) => {
    if (!group.length) return;
    // Keep closing/sentence separators with the preceding group. Slicing only to the final
    // word's end dropped ?, periods and the colon in 08:30 from exported cards.
    const text = fullText.slice(textCursor, endChar).replace(/\s+/g, " ").trim();
    if (text) out.push({text, startMs: group[0].startMs, endMs: group[group.length - 1].endMs});
    textCursor = endChar;
    group = [];
  };
  for (const word of words) {
    if (group.length) {
      const previous = group[group.length - 1];
      const gap = fullText.slice(previous.endChar, word.startChar);
      // Times, decimals, dates and grouped numbers are one readable value.
      const numericJoin = /^[.,:/-]$/.test(gap)
        && /[0-9๐-๙]$/.test(previous.word) && /^[0-9๐-๙]/.test(word.word);
      const repetition = word.word.trim() === "ๆ" && !/[\n.!?]/.test(gap);
      const hardBoundary = !numericJoin && SENTENCE_BOUNDARY_RE.test(gap);
      const natural = n <= 3 && group.length === n
        && (THAI_BINDS_NEXT.has(previous.word) || THAI_BINDS_PREVIOUS.has(word.word));
      const closing = n <= 2 && group.length === n + 1 && word.word === "ได้";
      if (hardBoundary || (group.length >= n && !numericJoin && !repetition && !natural && !closing)) {
        // Opening delimiters belong to the following word; a straight quote
        // alternates between opening and closing in the authoritative text.
        const opening = /["“‘«(\[{]\s*$/u.exec(gap);
        let edge = word.startChar;
        if (opening) {
          const candidate = previous.endChar + opening.index;
          const opens = opening[0][0] !== '"'
            || fullText.slice(0, candidate).split('"').length % 2 === 1;
          if (opens) edge = candidate;
        }
        flush(edge);
      }
    }
    group.push(word);
  }
  flush(fullText.length);
  return out;
}
