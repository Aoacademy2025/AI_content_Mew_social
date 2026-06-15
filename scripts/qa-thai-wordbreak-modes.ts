// QA: print subtitle cards for ALL modes (sentence + 4/3/2/1 word) over Thai
// scripts heavy with loanwords, and flag any loanword still split across cards.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/qa-thai-wordbreak-modes.ts
import { tokenizeWords, splitSentenceCards, snapCardsToWordBoundaries } from "../src/lib/tts-timing";
import { cardsByWordCount, maxCardCharsFor } from "../src/lib/mcp/orchestrator-steps";

// loanwords IN the curated list + extras NOT in it (to honestly probe residuals)
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
const PROBE = [...THAI_LOANWORDS, "ไลฟ์", "สตรีม", "รีวิว", "โปรโมชัน", "ดีล", "ออร์แกนิก", "เทรนด์", "ฟีดแบ็ก", "เอนเกจ"];

function sentenceCards(fullText: string): string[] {
  const cards = snapCardsToWordBoundaries(splitSentenceCards(fullText, Math.max(10, maxCardCharsFor())), fullText);
  return cards.map((c) => fullText.slice(c.startChar, c.endChar).trim()).filter(Boolean);
}
function wordCards(fullText: string, n: number): string[] {
  const words = tokenizeWords(fullText).map((t) => ({ word: t.word, startMs: 0, endMs: 1, startChar: t.startChar, endChar: t.endChar }));
  return cardsByWordCount(words, n, fullText).map((c) => c.text);
}
// a loanword is "split" if it sits at the end of one card and the start of the next
function splitsFound(cards: string[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i < cards.length - 1; i++) {
    const a = cards[i], b = cards[i + 1];
    for (const w of PROBE) for (let k = 1; k < w.length; k++)
      if (a.endsWith(w.slice(0, k)) && b.startsWith(w.slice(k))) hits.push(`${w} -> ${w.slice(0, k)}|${w.slice(k)}`);
  }
  return hits;
}

const SCRIPTS: Record<string, string> = {
  "A (duckyhero clip)":
    "Zuckerberg ส่ง AI เข้าไปนั่งทำงานแทนแอดมินแล้วครับ รอบนี้ไม่ใช่แชตบอตทดลองเหมือนเมื่อก่อน " +
    "ทำงานข้ามสามแพลตฟอร์มของ Meta ไม่ใช่ร้านใหญ่ที่มีทีมแอดมินเยอะ ส่งให้ทีมแอดมินดูได้เลย",
  "B (loanwords NOT all listed)":
    "วันนี้มารีวิวฟีเจอร์ใหม่ของแพลตฟอร์มไลฟ์สดและสตรีม คอนเทนต์สายดีลและโปรโมชัน " +
    "อยากให้แอดมินช่วยอัปเดตอัลกอริทึมให้เอนเกจเมนต์กับฟีดแบ็กดีขึ้นแบบออร์แกนิก",
};

for (const [name, text] of Object.entries(SCRIPTS)) {
  console.log("\n" + "=".repeat(70) + "\n# SCRIPT " + name + "  (" + text.length + " chars)\n" + "=".repeat(70));
  const modes: Array<[string, string[]]> = [
    ["sentence", sentenceCards(text)],
    ["4-word", wordCards(text, 4)],
    ["3-word", wordCards(text, 3)],
    ["2-word", wordCards(text, 2)],
    ["1-word", wordCards(text, 1)],
  ];
  for (const [label, cards] of modes) {
    const hits = splitsFound(cards);
    console.log(`\n--- ${label} (${cards.length} cards) --- ${hits.length === 0 ? "✅ no loanword split" : "❌ " + hits.length + " split: " + [...new Set(hits)].join(", ")}`);
    console.log(cards.map((c) => "“" + c + "”").join("  "));
  }
}
