import { getActiveCompounds } from "@/lib/thai-compounds";

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
  // ── cross-sector loanwords, ICU-validated mis-splits 2026-06-19 ──
  // The daily auto-miner is a dictionary oracle: it can only surface a loanword
  // that already exists in data/words_th.txt but ICU mis-split. ~72% of common
  // transliterations (แคปชัน, คริปโต, ไจโรสโคป, เดลิเวอรี…) are NOT in that dict,
  // so the cron can never reach them — they have to be seeded by hand. Every entry
  // below was confirmed Intl.Segmenter-split mid-word AND not already kept whole
  // (วิตามิน/ฮอร์โมน/คาเฟ่/เอไอ/แคปชั่น were checked and deliberately omitted).
  // finance / investment
  "คริปโต", "บิตคอยน์", "บล็อกเชน", "พอร์ตโฟลิโอ", "ดิวิเดนด์", "รีไฟแนนซ์", "ฟินเทค", "สเตกกิ้ง",
  // health / medical
  "คอลลาเจน", "อัลไซเมอร์", "โปรไบโอติก", "เมตาบอลิซึม",
  // beauty / cosmetics
  "เซรั่ม", "มอยส์เจอไรเซอร์", "รีทินอล", "ไฮยาลูรอน", "เอสเซนส์", "ทรีตเมนต์", "ไพรเมอร์", "คอนซีลเลอร์", "คอนทัวร์",
  // food / cafe
  "เดลิเวอรี", "เบเกอรี", "ครัวซองต์", "ลาเต้", "เอสเพรสโซ", "ทอปปิง", "ฟิวชัน", "ดริป",
  // real estate
  "คอนโด", "เพนต์เฮาส์", "ทาวน์โฮม", "ทาวน์เฮาส์", "ดีเวลลอปเปอร์", "ฟรีโฮลด์", "ลีสโฮลด์", "มอร์เกจ",
  // automotive / drone
  "ไฮบริด", "ทรานสมิชชัน", "แดชบอร์ด", "ไจโรสโคป", "อัลติจูด", "โฮลด์", "โพซิชันนิ่ง",
  // travel
  "รีสอร์ต", "โฮสเทล", "แลนด์มาร์ก", "พาสปอร์ต", "เลย์โอเวอร์", "แบ็กแพ็ก",
  // education
  "เวิร์กช็อป", "เว็บบินาร์", "เซอร์ติฟิเคต", "เลกเชอร์",
  // fitness
  "คาร์ดิโอ", "ครีเอทีน", "สแควต", "เดดลิฟต์",
  // fashion
  "คอลเลกชัน", "สนีกเกอร์", "แอกเซสเซอรี", "เทรนด์", "มินิมอล",
  // gaming / esports
  "เกมเมอร์", "สตรีมเมอร์", "อีสปอร์ต", "ลูทบ็อกซ์", "เมตาเวิร์ส",
  // tech / AI
  "แมชชีนเลิร์นนิง", "นิวรัล", "เอนจิน", "เอพีไอ", "ดาต้าเบส", "อินเทอร์เฟซ",
  // marketing
  "อิมเพรสชัน", "คอนเวอร์ชัน", "ฟันเนล", "รีมาร์เก็ตติ้ง", "แฮชแท็ก", "แคปชัน",
  // logistics
  "โลจิสติกส์", "ซัพพลายเชน", "แวร์เฮาส์", "อินเวนทอรี", "แทร็กกิ้ง",
  // ── big upfront batch, ICU-validated mis-splits 2026-06-19 ──
  // Proactive cross-sector coverage (front-loaded, not from real prod failures
  // yet) — HERO's users span many business verticals. The daily dict-oracle cron
  // (cron-mine-loanwords.ts) keeps catching dict-resident words automatically;
  // this batch covers the ~72% of transliterations that cron can never reach.
  // Every entry confirmed Intl.Segmenter-split mid-word, ≥4 chars, not already
  // seeded; words ICU keeps whole were dropped at generation time.
  // finance / crypto
  "เทรดดิ้ง", "ลีเวอเรจ", "ฟิวเจอร์ส", "โทเคน", "สเตเบิลคอยน์", "แคชแบ็ก", "ทรานแซกชัน", "อินวอยซ์", "บัดเจ็ต",
  // health
  "แอนติออกซิแดนต์", "พรีไบโอติก", "ดีท็อกซ์", "กลูตาไธโอน", "เซโรโทนิน", "โดพามีน", "คอร์ติซอล", "อัลตราซาวด์", "โอเมก้า",
  // beauty
  "คลีนเซอร์", "ไมเซลลาร์", "เอกซ์โฟลิเอต", "พีลิ่ง", "บูสเตอร์", "แอมพูล", "อายไลเนอร์", "ฟาวน์เดชัน", "คุชชัน", "ไนอาซินาไมด์", "เปปไทด์", "เซราไมด์", "บีบีครีม", "โบทอกซ์", "ฟิลเลอร์", "สกินแคร์", "ลิปบาล์ม",
  // food / cafe
  "คาปูชิโน", "อเมริกาโน", "ม็อกค่า", "ฟรัปเป้", "สมูทตี้", "บาริสต้า", "แพทิสเซอรี", "ครีมชีส", "ชีสเค้ก", "บราวนี่", "มาการอง", "แพนเค้ก", "ซาวร์โดว", "กลูเตน", "วีแกน", "ฟู้ดทรัก", "แฟรนไชส์", "สตรีทฟู้ด",
  // real estate
  "ดูเพล็กซ์", "ฟาซิลิตี", "โลเคชัน", "อินทีเรีย", "เลย์เอาต์", "รีโนเวต", "พรีเซล", "เอสโครว์",
  // automotive
  "ซับวูฟเฟอร์", "ซูเปอร์ชาร์จ", "อินเตอร์คูลเลอร์", "ไดชาร์จ", "ชาร์จเจอร์", "ออโตไพลอต", "ครูซคอนโทรล", "แอร์แบ็ก", "ดิฟเฟอเรนเชียล", "แชสซี", "ควอดคอปเตอร์", "จิมบอล", "แบตเตอรี",
  // travel
  "โฮมสเตย์", "เช็คอิน", "เช็คเอาต์", "ทรานสิต", "อิติเนอรารี", "ออลอินคลูซีฟ", "เฟอร์รี", "ลักชัวรี", "บูทีค",
  // education
  "อีเลิร์นนิง", "เคอร์ริคูลัม", "ดิปโลมา", "ทรานสคริปต์", "เมนเทอร์", "แอดมิชชัน", "แอสไซน์เมนต์", "ทูทอเรียล",
  // fitness
  "เคตเทิลเบล", "แพลงก์", "ลันจ์", "เบนช์เพรส", "เวย์โปรตีน", "พรีเวิร์กเอาต์", "พิลาทิส", "ครอสฟิต", "แอโรบิก", "สปรินต์",
  // fashion
  "สตรีทแวร์", "วินเทจ", "โอเวอร์ไซส์", "แพตเทิร์น", "สเวตเตอร์", "ฮู้ดดี้", "แจ็กเก็ต", "เบลเซอร์", "เดนิม", "โลฟเฟอร์", "โทตแบ็ก",
  // gaming
  "แมตช์เมกกิ้ง", "แกดเจ็ต", "จอยสติก", "แกมเพลย์", "สปีดรัน", "ลาเทนซี", "ครอสเพลย์", "แบทเทิลรอยัล", "แซนด์บ็อกซ์",
  // tech / AI
  "ดีปเลิร์นนิง", "บิ๊กดาต้า", "แบ็กเอนด์", "ฟรอนต์เอนด์", "ฟูลสแตก", "ดีพลอย", "คอมไพล์", "เอนคริปต์", "แบนด์วิดท์", "ไมโครเซอร์วิส", "เจเนอเรทีฟ", "แชตจีพีที",
  // marketing
  "รีเทนชัน", "รีทาร์เก็ต", "แลนดิงเพจ", "นิวส์เลตเตอร์", "แบ็กลิงก์", "ฟอลโลเวอร์", "ซับสไครเบอร์", "เพอร์โซนา", "คอลแลบ", "แบรนดิง", "รีแบรนด์", "สปอนเซอร์", "รีลส์", "พอดแคสต์",
  // e-commerce / business ops
  "ดรอปชิป", "ฟูลฟิลเมนต์", "รีสต๊อก", "แคตตาล็อก", "มาร์เก็ตเพลส", "สตาร์ตอัป", "รีฟันด์", "ดิสเคาต์", "แฟลชเซล", "พรีออเดอร์", "เอสเอ็มอี",
];

// Dynamic loanwords (auto-mined daily, stored in SiteConfig) merged on top of the
// static seed at runtime. setDynamicLoanwords is called by the server loader and the
// web editor; getActiveLoanwords is the single list everything else consumes. Cached:
// recomputed only when setDynamicLoanwords runs (loanwordSpans reads it per call).
let _active: string[] = [...THAI_LOANWORDS];
export function setDynamicLoanwords(words: string[], denylist: string[] = []): void {
  const deny = new Set(Array.isArray(denylist) ? denylist : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...THAI_LOANWORDS, ...(Array.isArray(words) ? words : [])]) {
    if (typeof w !== "string" || w.length === 0 || deny.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  _active = out;
}
export function getActiveLoanwords(): string[] {
  return _active;
}

export interface LoanwordSpan { start: number; end: number; }

// All non-overlapping occurrences of any loanword OR curated native compound in
// `text`. Compounds (thai-compounds.ts) flow through this exact same merge so they
// stay whole in wordBoundaries on both the MCP + web paths — see getActiveCompounds.
// When a shorter entry is contained in a longer one at the same place (เอนเกจ ⊂
// เอนเกจเมนต์, or ขี้เกียจ ⊂ a longer span), the longer one wins so we never force a
// cut INSIDE the longer entry.
export function loanwordSpans(text: string): LoanwordSpan[] {
  const raw: LoanwordSpan[] = [];
  for (const w of [...getActiveLoanwords(), ...getActiveCompounds()]) {
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
