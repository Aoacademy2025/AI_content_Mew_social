// Thai loanwords / transliterations that Intl.Segmenter("th",{granularity:"word"})
// mis-splits because ICU's Thai dictionary doesn't contain them — e.g. it breaks
// "แอดมิน" => "แอ|ดมิน", "คอมเมนต์" => "คอม|เมน|ต์", "แพลตฟอร์ม"/"แชตบอต"/… mid-word.
// Those broken fragments then become separate subtitle cards in word-count mode
// (MCP cardsByWordCount / web splitCaptionsByMode) and separate line-wrap points
// at render. This list lets tokenizeWords()/wordBoundaries() force each entry to
// stay ONE token. Keep entries: real loanwords ICU mis-splits, ≥3 chars, that are
// unlikely to appear as a substring of an unrelated Thai word. Extend from real
// prod failures (grep worker logs / re-run scripts/verify-thai-wordbreak.ts).
export const THAI_LOANWORDS: string[] = [
  // social / chat / admin
  "แอดมิน", "แชตบอต", "แชตบอท", "คอมเมนต์", "คอนเทนต์", "คอนเท็นต์", "โพสต์",
  "ฟอลโลว์", "โปรไฟล์", "เอนเกจเมนต์", "เอนเกจ", "อินฟลูเอนเซอร์", "สตอรี่",
  // platform / tech
  "แพลตฟอร์ม", "อัลกอริทึม", "แอปพลิเคชัน", "ดิจิทัล", "ฟีเจอร์", "ดีไซน์",
  "อัปเดต", "อัปโหลด", "ดาวน์โหลด", "สมาร์ตโฟน", "โน้ตบุ๊ก", "ซอฟต์แวร์", "ฮาร์ดแวร์",
  // business / marketing
  "แคมเปญ", "มาร์เก็ตติ้ง", "อีคอมเมิร์ซ", "โมเดลธุรกิจ", "โมเดล", "แบรนด์", "บิสิเนส",
  // mined from real prod scripts 2026-06-15 (all businesses, via dict-oracle diff vs
  // Intl.Segmenter — see scripts/mine-thai-loanwords.ts). Each was ICU-split mid-word.
  "ไอเดีย", "ครีเอเตอร์", "ซีรีส์", "สเตตัส", "แคสต์", "โปรเจกต์", "พรีเซนเตอร์",
  "ไวรัล", "ช้อปปิ้ง", "ไตเติ้ล", "เรนเดอร์", "คลาวด์", "สึนามิ",
  // surfaced by QA across content/tech/e-commerce scripts
  "สตรีม", "ฟีดแบ็ก", "ออร์แกนิก",
];

export interface LoanwordSpan { start: number; end: number; }

// All non-overlapping occurrences of any loanword in `text`. When a shorter
// entry is contained in a longer one at the same place (เอนเกจ ⊂ เอนเกจเมนต์),
// the longer one wins so we never force a cut INSIDE the longer loanword.
export function loanwordSpans(text: string): LoanwordSpan[] {
  const raw: LoanwordSpan[] = [];
  for (const w of THAI_LOANWORDS) {
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(w, from)) !== -1) {
      raw.push({ start: idx, end: idx + w.length });
      from = idx + w.length;
    }
  }
  // longest-at-a-position first, then drop spans fully contained in a kept one
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: LoanwordSpan[] = [];
  for (const s of raw) {
    const last = spans[spans.length - 1];
    if (last && s.start >= last.start && s.end <= last.end) continue; // contained → skip
    if (last && s.start < last.end) { if (s.end > last.end) last.end = s.end; continue; } // overlap → extend
    spans.push({ ...s });
  }
  return spans;
}
