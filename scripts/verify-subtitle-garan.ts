// Thai garan/combining clusters (e.g. "ต์" in "คอมเมนต์") must never be orphaned onto their own card.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-subtitle-garan.ts
import { splitSentenceCards } from "../src/lib/tts-timing";
let passed = 0; function assert(c: boolean, m: string){ if(!c){console.error("❌ "+m);process.exit(1);} console.log("✓ "+m); passed++; }
const text = "ดูรายละเอียดได้ในคอมเมนต์ หรือพิมพ์ HERO ไว้ใต้คอมเมนต์ครับ";
for (const limit of [10, 12, 14, 16, 18, 20, 24, 28]) {
  const cards = splitSentenceCards(text, limit);
  const texts = cards.map((c) => text.slice(c.startChar, c.endChar));
  assert(texts.join("") === text, `limit ${limit}: cards concat to exactly fullText (contiguous, non-empty)`);
  assert(cards.every((c) => c.endChar > c.startChar), `limit ${limit}: no empty card`);
  // no card may START with a garan cluster (consonant + ◌์) or a bare combining mark
  const orphan = texts.find((t) => /^\s*[ก-ฮ]?์/.test(t) || /^\s*[ัำ-ฺ็-๎]/.test(t));
  assert(!orphan, `limit ${limit}: no card orphans a garan/combining cluster (got "${orphan}")`);
}
console.log(`\n${passed} assertions passed ✅`);
