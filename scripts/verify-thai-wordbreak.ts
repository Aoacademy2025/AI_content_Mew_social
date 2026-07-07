// Thai loanword word-break: tokenizeWords must keep loanwords ICU mis-splits
// (แอดมิน=>แอ|ดมิน, แชตบอต, คอมเมนต์, แพลตฟอร์ม...) whole, WITHOUT over-merging
// real short Thai words — and the MCP word-count card path (cardsByWordCount)
// must therefore never split a loanword across two cards (the duckyhero
// subMode=4 prod bug). Reproduces from the real duckyhero clip strings.
//   npx tsx scripts/verify-thai-wordbreak.ts
import { tokenizeWords } from "../src/lib/tts-timing";
import { cardsByWordCount } from "../src/lib/mcp/orchestrator-steps";
import { THAI_COMPOUNDS } from "../src/lib/thai-compounds";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// ── T1: each loanword ICU mis-splits must survive as ONE token, in context ──
const LOANWORDS = ["แอดมิน", "แชตบอต", "คอมเมนต์", "คอนเทนต์", "แพลตฟอร์ม", "ฟอลโลว์", "อัลกอริทึม",
  // prod-mined batch (2026-06-15)
  "ไอเดีย", "ครีเอเตอร์", "ซีรีส์", "โปรเจกต์", "ไวรัล", "เรนเดอร์", "สตรีม", "ออร์แกนิก"];
for (const w of LOANWORDS) {
  const text = `วันนี้เขาเป็น${w}ของเรานะ`;
  const toks = tokenizeWords(text).map((t) => t.word);
  assert(toks.includes(w), `tokenizeWords keeps "${w}" whole (got: ${toks.join("|")})`);
}

// ── T2: real short Thai words must NOT be glued together (no over-merge) ──
const shortText = "ที่ไม่ได้อยู่ในของเรา";
const shortToks = tokenizeWords(shortText);
assert(shortToks.length >= 4, `does not over-merge short words (${shortToks.length} tokens: ${shortToks.map((t) => t.word).join("|")})`);

// ── T3: char offsets stay valid + contiguous over fullText (timing safety) ──
{
  const text = "เข้าไปนั่งทำงานแทนแอดมินแล้วครับ";
  const toks = tokenizeWords(text);
  let ok = true;
  for (const t of toks) if (text.slice(t.startChar, t.endChar) !== t.word) ok = false;
  for (let i = 1; i < toks.length; i++) if (toks[i].startChar < toks[i - 1].endChar) ok = false;
  assert(ok, "token startChar/endChar slice back to the exact word and never overlap");
}

// ── T4: end-to-end MCP path — cardsByWordCount(n) never splits a loanword ──
// across card boundaries (this is exactly what subMode=4 produced on prod).
function loanwordSplit(cards: { text: string }[]): string | null {
  for (let i = 0; i < cards.length - 1; i++) {
    const a = cards[i].text, b = cards[i + 1].text;
    for (const w of LOANWORDS) {
      for (let k = 1; k < w.length; k++) {
        if (a.endsWith(w.slice(0, k)) && b.startsWith(w.slice(k))) return `${w} -> ${w.slice(0, k)}|${w.slice(k)}`;
      }
    }
  }
  return null;
}
const SCRIPT =
  "Zuckerberg ส่ง AI เข้าไปนั่งทำงานแทนแอดมินแล้วครับ รอบนี้ไม่ใช่แชตบอตทดลองเหมือนเมื่อก่อน " +
  "ทำงานข้ามสามแพลตฟอร์มของ Meta ไม่ใช่ร้านใหญ่ที่มีทีมแอดมินเยอะ ส่งให้ทีมแอดมินดูได้เลย";
for (const n of [1, 2, 3, 4]) {
  const words = tokenizeWords(SCRIPT).map((t) => ({ word: t.word, startMs: 0, endMs: 1, startChar: t.startChar, endChar: t.endChar }));
  const cards = cardsByWordCount(words, n, SCRIPT);
  const split = loanwordSplit(cards);
  assert(split === null, `subMode=${n}: no loanword split across cards${split ? " (FOUND " + split + ")" : ""}`);
}

// ── T5: curated native COMPOUNDS survive whole through the same machinery ──
// (ขี้เกียจ, เวลางาน, … must stay ONE token — the origin bug was ขี้|เกียจ).
for (const w of THAI_COMPOUNDS) {
  const text = `เขาเป็นคน${w}มากเลยนะ`;
  const toks = tokenizeWords(text).map((t) => t.word);
  assert(toks.includes(w), `tokenizeWords keeps compound "${w}" whole (got: ${toks.join("|")})`);
}

// ── T6: compounds never split across cardsByWordCount cards (all subModes) ──
function compoundSplit(cards: { text: string }[]): string | null {
  for (let i = 0; i < cards.length - 1; i++) {
    const a = cards[i].text, b = cards[i + 1].text;
    for (const w of THAI_COMPOUNDS) {
      for (let k = 1; k < w.length; k++) {
        if (a.endsWith(w.slice(0, k)) && b.startsWith(w.slice(k))) return `${w} -> ${w.slice(0, k)}|${w.slice(k)}`;
      }
    }
  }
  return null;
}
const CSCRIPT = "หัวหน้าบอกว่าเขาขี้เกียจมากช่วงเวลางานที่ผ่านมา เพื่อนร่วมงานเลยต้องไปหาหมอที่โรงพยาบาลแทน";
for (const n of [1, 2, 3, 4]) {
  const words = tokenizeWords(CSCRIPT).map((t) => ({ word: t.word, startMs: 0, endMs: 1, startChar: t.startChar, endChar: t.endChar }));
  const cards = cardsByWordCount(words, n, CSCRIPT);
  const split = compoundSplit(cards);
  assert(split === null, `subMode=${n}: no compound split across cards${split ? " (FOUND " + split + ")" : ""}`);
}

// ── T7: NO false-merge — a compound's fragments in UNRELATED context stay split ──
// The exact compound substring is absent, so the fragments must tokenize normally
// (guards against a bad seed entry gluing across a real word boundary).
{
  // เวลา + งาน present but never adjacent-as-"เวลางาน"
  const t = "ใช้เวลาไปทำงานบ้านทั้งวัน";
  const toks = tokenizeWords(t).map((x) => x.word);
  assert(!toks.includes("เวลางาน"), `no phantom "เวลางาน" when absent (got: ${toks.join("|")})`);
  assert(toks.some((x) => x.includes("เวลา")) && toks.some((x) => x.includes("งาน")), "both fragments still present as separate tokens");
}
{
  // "งาน" in a งาน-compound must not get swallowed by เวลางาน/เพื่อนร่วมงาน
  const t = "งานเลี้ยงคืนนี้สนุกมาก";
  const toks = tokenizeWords(t).map((x) => x.word);
  assert(!toks.some((x) => x.includes("เวลางาน") || x.includes("ร่วมงาน")), `no phantom compound in "งานเลี้ยง…" (got: ${toks.join("|")})`);
}
{
  // short real words around a compound must not over-merge
  const t = "ที่ไม่ได้อยู่ในของเรา";
  assert(tokenizeWords(t).length >= 4, "compounds don't cause over-merge of short words");
}

console.log(`\n${passed} checks passed`);
