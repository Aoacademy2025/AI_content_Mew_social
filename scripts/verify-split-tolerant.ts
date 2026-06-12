// Verify partial-acceptance card mapping: one deviating LLM piece costs only
// its own span (sentence-filled), never the whole clip. Run:
// npx tsx scripts/verify-split-tolerant.ts

import { mapCardTextsToRangesTolerant, snapCardsToWordBoundaries, type CardPiece, type ScriptCard } from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function coverage(cards: ScriptCard[], text: string): boolean {
  return cards.map((c) => text.slice(c.startChar, c.endChar)).join("").replace(/\s+/g, "") === text.replace(/\s+/g, "");
}
function ordered(cards: ScriptCard[]): boolean {
  return cards.every((c, i) => c.endChar > c.startChar && (i === 0 || c.startChar >= cards[i - 1].endChar));
}

// Mirrors the structure of the real rejected prod script: curly quotes,
// em dash, numbered list, ๆ — the things LLMs love to normalize.
const SCRIPT = [
  "ซื้อ AI มาให้ทีมใช้ ผ่านไปสามเดือนยังไม่มีใครแตะ",
  "ปัญหาไม่ใช่เครื่องมือไม่ดี — แต่ไม่มีใครรู้ว่ามันช่วยงานตรงไหน",
  "เปิด ChatGPT แล้ววางคำสั่งนี้",
  "‘ช่วยตั้งคำถาม 5 ข้อให้ผมไปถามทีม’",
  "1. งานที่ทำซ้ำทุกสัปดาห์",
  "2. งานที่กินเวลาแต่ไม่ต้องคิดเยอะ",
  "อย่าถามกว้างๆ ให้ถามแบบเจาะจง",
  "เก็บสูตรนี้ไว้ใช้ก่อนประชุมครั้งหน้าครับ",
].join("\n");

// 1) all-verbatim pieces → everything accepted (same as strict)
{
  const pieces: CardPiece[] = [
    { text: "ซื้อ AI มาให้ทีมใช้", tag: "hook" },
    { text: "ผ่านไปสามเดือนยังไม่มีใครแตะ" },
    { text: "ปัญหาไม่ใช่เครื่องมือไม่ดี —" },
    { text: "แต่ไม่มีใครรู้ว่ามันช่วยงานตรงไหน" },
    { text: "เปิด ChatGPT แล้ววางคำสั่งนี้" },
    { text: "‘ช่วยตั้งคำถาม 5 ข้อให้ผมไปถามทีม’" },
    { text: "1. งานที่ทำซ้ำทุกสัปดาห์" },
    { text: "2. งานที่กินเวลาแต่ไม่ต้องคิดเยอะ" },
    { text: "อย่าถามกว้างๆ ให้ถามแบบเจาะจง" },
    { text: "เก็บสูตรนี้ไว้ใช้ก่อนประชุมครั้งหน้าครับ", tag: "cta" },
  ];
  const r = mapCardTextsToRangesTolerant(SCRIPT, pieces, 28);
  check("clean: all accepted", r !== null && r.accepted === 10 && r.rejected === 0);
  check("clean: coverage + order", r !== null && coverage(r.cards, SCRIPT) && ordered(r.cards));
  check("clean: tags survive", r !== null && r.cards[0].tag === "hook" && r.cards.at(-1)!.tag === "cta");
}

// 2) ONE piece normalized (em dash → hyphen) → only its span sentence-filled
{
  const pieces: CardPiece[] = [
    { text: "ซื้อ AI มาให้ทีมใช้", tag: "hook" },
    { text: "ผ่านไปสามเดือนยังไม่มีใครแตะ" },
    { text: "ปัญหาไม่ใช่เครื่องมือไม่ดี - แต่ไม่มีใครรู้ว่ามันช่วยงานตรงไหน" }, // — became -
    { text: "เปิด ChatGPT แล้ววางคำสั่งนี้" },
    { text: "‘ช่วยตั้งคำถาม 5 ข้อให้ผมไปถามทีม’" },
    { text: "1. งานที่ทำซ้ำทุกสัปดาห์" },
    { text: "2. งานที่กินเวลาแต่ไม่ต้องคิดเยอะ" },
    { text: "อย่าถามกว้างๆ ให้ถามแบบเจาะจง" },
    { text: "เก็บสูตรนี้ไว้ใช้ก่อนประชุมครั้งหน้าครับ", tag: "cta" },
  ];
  const r = mapCardTextsToRangesTolerant(SCRIPT, pieces, 28);
  check("emdash: result exists", r !== null);
  if (r) {
    check("emdash: 8 viral kept, 1 rejected", r.accepted === 8 && r.rejected === 1, `a=${r.accepted} r=${r.rejected}`);
    check("emdash: coverage + order intact", coverage(r.cards, SCRIPT) && ordered(r.cards));
    check("emdash: resyncs at next piece (ChatGPT card is viral again)",
      r.cards.some((c) => SCRIPT.slice(c.startChar, c.endChar).includes("ChatGPT")));
    check("emdash: mismatch diagnostic recorded", typeof r.firstMismatch === "string" && r.firstMismatch.includes("expected"));
    check("emdash: snap-compatible", ordered(snapCardsToWordBoundaries(r.cards, SCRIPT)));
  }
}

// 3) numbering dropped from list pieces → those spans filled, rest viral
{
  const pieces: CardPiece[] = [
    { text: "ซื้อ AI มาให้ทีมใช้", tag: "hook" },
    { text: "ผ่านไปสามเดือนยังไม่มีใครแตะ" },
    { text: "ปัญหาไม่ใช่เครื่องมือไม่ดี —" },
    { text: "แต่ไม่มีใครรู้ว่ามันช่วยงานตรงไหน" },
    { text: "เปิด ChatGPT แล้ววางคำสั่งนี้" },
    { text: "'ช่วยตั้งคำถาม 5 ข้อให้ผมไปถามทีม'" }, // curly quotes → straight
    { text: "งานที่ทำซ้ำทุกสัปดาห์" },               // dropped "1."
    { text: "งานที่กินเวลาแต่ไม่ต้องคิดเยอะ" },        // dropped "2."
    { text: "อย่าถามกว้างๆ ให้ถามแบบเจาะจง" },
    { text: "เก็บสูตรนี้ไว้ใช้ก่อนประชุมครั้งหน้าครับ", tag: "cta" },
  ];
  const r = mapCardTextsToRangesTolerant(SCRIPT, pieces, 28);
  check("multi: result exists with majority viral", r !== null && r.accepted >= 6, r ? `a=${r.accepted} r=${r.rejected}` : "null");
  check("multi: coverage + order intact", r !== null && coverage(r.cards, SCRIPT) && ordered(r.cards));
}

// 4) LLM stops early → tail sentence-filled
{
  const pieces: CardPiece[] = [
    { text: "ซื้อ AI มาให้ทีมใช้", tag: "hook" },
    { text: "ผ่านไปสามเดือนยังไม่มีใครแตะ" },
  ];
  const r = mapCardTextsToRangesTolerant(SCRIPT, pieces, 28);
  check("early-stop: tail filled, coverage intact", r !== null && coverage(r.cards, SCRIPT) && ordered(r.cards));
}

// 5) nothing matches → null (caller falls back fully, same as today)
{
  const r = mapCardTextsToRangesTolerant(SCRIPT, [{ text: "ข้อความที่ไม่มีในสคริปต์เลยสักนิด" }], 28);
  check("all-garbage: null", r === null);
}

// 6) invented text mid-stream → rejected, real script continues
{
  const pieces: CardPiece[] = [
    { text: "ซื้อ AI มาให้ทีมใช้" },
    { text: "ขอบคุณผู้สนับสนุนรายการครับ" }, // invented
    { text: "ผ่านไปสามเดือนยังไม่มีใครแตะ" },
    { text: "ปัญหาไม่ใช่เครื่องมือไม่ดี —" },
    { text: "แต่ไม่มีใครรู้ว่ามันช่วยงานตรงไหน" },
    { text: "เปิด ChatGPT แล้ววางคำสั่งนี้" },
    { text: "‘ช่วยตั้งคำถาม 5 ข้อให้ผมไปถามทีม’" },
    { text: "1. งานที่ทำซ้ำทุกสัปดาห์" },
    { text: "2. งานที่กินเวลาแต่ไม่ต้องคิดเยอะ" },
    { text: "อย่าถามกว้างๆ ให้ถามแบบเจาะจง" },
    { text: "เก็บสูตรนี้ไว้ใช้ก่อนประชุมครั้งหน้าครับ" },
  ];
  const r = mapCardTextsToRangesTolerant(SCRIPT, pieces, 28);
  check("invented: skipped without losing real text", r !== null && coverage(r.cards, SCRIPT) && ordered(r.cards) && r.rejected === 1,
    r ? `a=${r.accepted} r=${r.rejected}` : "null");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll tolerant-mapping checks passed ✓");
