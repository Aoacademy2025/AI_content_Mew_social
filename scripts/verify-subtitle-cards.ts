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
console.log(`\n${passed} assertions passed ✅`);
