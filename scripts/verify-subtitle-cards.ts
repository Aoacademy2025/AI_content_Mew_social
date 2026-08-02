// Word-count subtitle cards: text is SLICED from the original fullText (exact spacing —
// Thai glued, "ๆ"/script/English spaces preserved), timing untouched (sync unchanged).
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-subtitle-cards.ts
import { cardsByWordCount, POSITION_TOP_PERCENT } from "../src/lib/mcp/orchestrator-steps";
import { setDynamicCompounds } from "../src/lib/thai-compounds";
import { tokenizeWords } from "../src/lib/tts-timing";
let passed = 0; function assert(c: boolean, m: string){ if(!c){console.error("❌ "+m);process.exit(1);} console.log("✓ "+m); passed++; }

// Original text: Thai words run together (no spaces), but a space before "ๆ" and around "HERO".
const fullText = "ดูรายละเอียดในคอมเมนต์ ๆ พิมพ์ HERO ไว้";
const toks = ["ดู","ราย","ละเอียด","ใน","คอมเมนต์","ๆ","พิมพ์","HERO","ไว้"];
let pos = 0;
const words = toks.map((w, i) => { const s = fullText.indexOf(w, pos); const e = s + w.length; pos = e; return { word: w, startMs: i*100, endMs: i*100+100, startChar: s, endChar: e }; });

const c3 = cardsByWordCount(words, 3, fullText);
assert(c3.length === 3, "9 words / 3 per card = 3 cards");
assert(c3[0].text === "ดูรายละเอียด", "Thai words glue WITHOUT spaces (sliced from original, no weird spacing)");
assert(c3[1].text === "ในคอมเมนต์ ๆ", "ๆ keeps its original space (not stuck to the word)");
assert(c3[2].text === "พิมพ์ HERO ไว้", "English/Latin spacing preserved");
assert(c3[0].startMs === 0 && c3[0].endMs === 300, "card timing = first word start → last word end (sync untouched)");

const c4 = cardsByWordCount(words, 4, fullText);
assert(c4.length === 3 && c4[2].text.length > 0, "9/4 = 3 cards, last = non-empty remainder");

assert(POSITION_TOP_PERCENT.top < POSITION_TOP_PERCENT.middle && POSITION_TOP_PERCENT.middle < POSITION_TOP_PERCENT.bottom, "position map ordered top<middle<bottom");

// --- FIX A + FIX B regression: boundary flush across an embedded \n AND sentence-final
// punctuation, PLUS a regular (non-boundary) double-space inside a group's interior.
// fullText layout: "ดู" <2 spaces, non-boundary> "คลิป" "นี้" <.> "ชอบ" "กด" <\n> "ไลค์" "เลย"
const boundaryFullText = "ดู  คลิปนี้.ชอบกด\nไลค์เลย";
const boundaryToks = ["ดู", "คลิป", "นี้", "ชอบ", "กด", "ไลค์", "เลย"];
let bpos = 0;
const boundaryWords = boundaryToks.map((w, i) => {
  const s = boundaryFullText.indexOf(w, bpos);
  const e = s + w.length;
  bpos = e;
  return { word: w, startMs: i * 100, endMs: i * 100 + 100, startChar: s, endChar: e };
});
// n=10 (> word count) so any card split below is caused ONLY by boundary flush (FIX B),
// never by the word-count cap.
const bCards = cardsByWordCount(boundaryWords, 10, boundaryFullText);
assert(bCards.length === 3, "boundary flush splits 7 words into 3 cards at the . and \\n boundaries, ignoring the n=10 word cap");
assert(!bCards.some((c) => c.text.includes("\n")), "FIX A: no card text contains a raw newline");
assert(!bCards.some((c) => /  /.test(c.text)), "FIX A: no card text contains an interior double-space (collapsed to single)");
assert(bCards[0].text === "ดู คลิปนี้", "FIX A: the group-interior double space (non-boundary) collapses to a single space");
// FIX B: the words straddling each boundary must land in DIFFERENT cards.
const cardIndexOfWord = (w: string) => bCards.findIndex((c) => c.text.includes(w));
assert(cardIndexOfWord("นี้") !== cardIndexOfWord("ชอบ"), "FIX B: words either side of the '.' sentence boundary are in different cards");
assert(cardIndexOfWord("กด") !== cardIndexOfWord("ไลค์"), "FIX B: words either side of the '\\n' line-break boundary are in different cards");

// Production MCP QA regressions (duckyhero, 2026-08-03): a hard N-token flush
// produced "เริ่มต้นให้" → "ชัดเจน" and "เกิดในวัน" → "เดียว". A card may
// exceed the requested count by one token when that single token completes a
// natural Thai phrase; exact source slicing and word timing remain unchanged.
function timedWords(fullText: string, tokens: string[]) {
  let offset = 0;
  return tokens.map((word, index) => {
    const startChar = fullText.indexOf(word, offset);
    const endChar = startChar + word.length;
    offset = endChar;
    return { word, startMs: index * 200, endMs: index * 200 + 180, startChar, endChar };
  });
}

const clearText = "เริ่มต้นให้ชัดเจน แล้วลงมือทำทันที";
const clearCards = cardsByWordCount(
  timedWords(clearText, ["เริ่มต้น", "ให้", "ชัดเจน", "แล้ว", "ลงมือ", "ทำ", "ทันที"]),
  2,
  clearText,
);
assert(clearCards[0].text === "เริ่มต้นให้ชัดเจน", "natural grouping keeps ให้ชัดเจน with its leading phrase");

const oneDayText = "ความสำเร็จไม่ได้เกิดในวันเดียว แต่เกิดจากการลงมือทำทุกวัน";
const oneDayCards = cardsByWordCount(
  timedWords(oneDayText, ["ความสำเร็จ", "ไม่", "ได้", "เกิด", "ใน", "วัน", "เดียว", "แต่", "เกิด", "จาก", "การ", "ลงมือ", "ทำ", "ทุก", "วัน"]),
  3,
  oneDayText,
);
assert(
  oneDayCards.some((card) => card.text.includes("วันเดียว"))
    && !oneDayCards.some((card, index) =>
      card.text.endsWith("วัน") && oneDayCards[index + 1]?.text.startsWith("เดียว")),
  "natural grouping never splits วันเดียว across adjacent subtitle cards",
);

// Real mode-2 avatar QA exposed three mechanical boundaries even though the
// transcript/timing release gate passed: "และช่วง | ปิดผ่าน", "ให้ซับ | ตรงเสียง",
// and "ใช้งานจริง | ได้". A ≤2-word card may use bounded extra timed tokens
// when a Thai modifier needs its next word or a closing auxiliary belongs to it.
const avatarQaText = "วันนี้เราจะทดสอบ Video Avatar ช่วงเปิด และช่วงปิดผ่าน MCP ให้ซับตรง เสียงชัด และนำไปใช้งานจริงได้";
const avatarQaWords = timedWords(avatarQaText, [
  "วันนี้", "เรา", "จะ", "ทดสอบ", "Video", "Avatar", "ช่วง", "เปิด",
  "และ", "ช่วง", "ปิด", "ผ่าน", "MCP", "ให้", "ซับ", "ตรง", "เสียง",
  "ชัด", "และ", "นำ", "ไป", "ใช้", "งาน", "จริง", "ได้",
]);
const avatarQaCards = cardsByWordCount(avatarQaWords, 2, avatarQaText);
assert(
  avatarQaCards.some((card) => card.text === "และช่วงปิด"),
  "mode 2 keeps และช่วงปิด as one natural Thai phrase",
);
assert(
  avatarQaCards.some((card) => card.text === "ให้ซับตรง"),
  "mode 2 keeps ให้ซับตรง as one natural Thai phrase",
);
assert(
  avatarQaCards.some((card) => card.text === "ใช้งานจริงได้"),
  "mode 2 never strands final ได้ on its own card",
);

// Production's approved-compound catalog contained overlapping entries
// "นำไปใช้" + "ใช้งาน" + "งานจร". The last occurrence inside "งานจริง"
// ended immediately before ◌ิ, which previously forced the next token/card to
// begin with a combining mark and correctly tripped the release gate.
setDynamicCompounds(["วันนี้", "ใช้งาน", "งานจร", "นำไปใช้"], []);
const productionWords = tokenizeWords(avatarQaText).map((word, index) => ({
  ...word,
  startMs: index * 300,
  endMs: index * 300 + 280,
}));
const productionCards = cardsByWordCount(productionWords, 2, avatarQaText);
assert(
  productionWords.every((word) => !/^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/u.test(word.word)),
  "dynamic compound matches never create a token that starts with a Thai combining mark",
);
assert(
  productionCards.every((card) => !/^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/u.test(card.text)),
  "mode 2 cards remain grapheme-safe with the production compound catalog",
);
assert(
  productionCards.some((card) => card.text === "และนำไปใช้งานจริงได้"),
  "production compound overlap keeps the closing ใช้งานจริงได้ phrase together",
);
setDynamicCompounds([], []);

console.log(`\n${passed} assertions passed ✅`);
