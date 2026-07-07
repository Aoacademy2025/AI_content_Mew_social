// Word-count subtitle cards: text is SLICED from the original fullText (exact spacing —
// Thai glued, "ๆ"/script/English spaces preserved), timing untouched (sync unchanged).
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-subtitle-cards.ts
import { cardsByWordCount, POSITION_TOP_PERCENT } from "../src/lib/mcp/orchestrator-steps";
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

console.log(`\n${passed} assertions passed ✅`);
