// Verify the word-boundary guarantee: no card source may split a Thai word
// across two cards ("ธุรกิจ" → "ธุ" | "รกิจ", the duckyhero prod clip bug).
// Run: npx tsx scripts/verify-word-boundaries.ts

import {
  splitSentenceCards,
  splitScriptForTts,
  snapCardsToWordBoundaries,
  mapCardTextsToRanges,
  type ScriptCard,
} from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// Allowed cut positions = full-text segmenter boundaries (the same definition
// the lib uses; recomputed here independently for the assertion).
function boundarySet(text: string): Set<number> {
  const seg = new Intl.Segmenter("th", { granularity: "word" });
  const out = new Set<number>([0, text.length]);
  for (const tok of seg.segment(text)) out.add(tok.index);
  return out;
}

function edgesOnBoundaries(cards: ScriptCard[], text: string): boolean {
  const ok = boundarySet(text);
  return cards.every((c) => ok.has(c.startChar) && ok.has(c.endChar));
}

function coverage(cards: ScriptCard[], text: string): string {
  return cards.map((c) => text.slice(c.startChar, c.endChar)).join("").replace(/\s+/g, "");
}

// The structure from the duckyhero prod clip (subtitle ended "…โมเดลธุ"):
// one long Thai run, no spaces, with compound words mid-stream.
const PROD_CASE = "หลายคนเข้าใจผิดว่าความนิยมต้องมาก่อนโมเดลธุรกิจที่แข็งแรงแต่ความจริงคือต้องสร้างทั้งสองอย่างพร้อมกันถึงจะรอดในระยะยาว";

// 1) sentence splitter: every edge on a word boundary, at every card width
for (const max of [18, 22, 26, 28, 32, 40]) {
  const cards = snapCardsToWordBoundaries(splitSentenceCards(PROD_CASE, max), PROD_CASE);
  check(`sentence max=${max}: edges on word boundaries`, edgesOnBoundaries(cards, PROD_CASE),
    JSON.stringify(cards.map((c) => PROD_CASE.slice(c.startChar, c.endChar))));
  check(`sentence max=${max}: coverage preserved`, coverage(cards, PROD_CASE) === PROD_CASE.replace(/\s+/g, ""));
  check(`sentence max=${max}: no "ธุ|รกิจ" split`,
    !cards.some((c) => /ธุ$/.test(PROD_CASE.slice(c.startChar, c.endChar))));
}

// 2) splitScriptForTts itself now cuts at full-text boundaries (no-whitespace path)
{
  const chunks = splitScriptForTts(PROD_CASE, 28);
  check("splitScriptForTts: concat invariant holds", chunks.map((c) => c.text).join("") === PROD_CASE);
  const ok = boundarySet(PROD_CASE);
  check("splitScriptForTts: interior cuts on word boundaries",
    chunks.slice(0, -1).every((c) => ok.has(c.endChar)),
    JSON.stringify(chunks.map((c) => c.text)));
}

// 3) LLM cards that cut mid-word get snapped (the viral-path hole)
{
  // simulate an LLM that cut "ธุรกิจ" into "...ธุ" | "รกิจ..."
  const text = "โมเดลธุรกิจที่ดีต้องเลี้ยงตัวเองได้";
  const idx = text.indexOf("ธุ") + 1; // inside ธุรกิจ
  const midword: ScriptCard[] = [
    { startChar: 0, endChar: idx + 1, tag: "hook" },
    { startChar: idx + 1, endChar: text.length },
  ];
  const snapped = snapCardsToWordBoundaries(midword, text);
  check("llm: mid-word edge snapped to boundary", edgesOnBoundaries(snapped, text),
    JSON.stringify(snapped.map((c) => text.slice(c.startChar, c.endChar))));
  check("llm: coverage preserved", coverage(snapped, text) === text.replace(/\s+/g, ""));
  check("llm: tag preserved", snapped[0].tag === "hook");
}

// 4) collapsed card donates its range, text never lost
{
  const text = "สวัสดีครับทุกคน";
  const tiny: ScriptCard[] = [
    { startChar: 0, endChar: 7 },   // สวัสดีค (mid-word ครับ)
    { startChar: 7, endChar: 8 },   // ร — will collapse after snapping
    { startChar: 8, endChar: text.length },
  ];
  const snapped = snapCardsToWordBoundaries(tiny, text);
  check("collapse: coverage preserved", coverage(snapped, text) === text.replace(/\s+/g, ""));
  check("collapse: edges on boundaries", edgesOnBoundaries(snapped, text));
}

// 5) mapCardTextsToRanges output flows through the same guarantee
{
  const text = "เริ่มจากแบ่งเงินเดือนทันทีที่เงินเข้า ออมก่อนใช้เสมอ";
  const pieces = [{ text: "เริ่มจากแบ่งเงินเดือน" }, { text: "ทันทีที่เงินเข้า" }, { text: "ออมก่อนใช้เสมอ" }];
  const cards = mapCardTextsToRanges(text, pieces);
  check("pipeline: llm ranges → snap → still valid",
    cards !== null && edgesOnBoundaries(snapCardsToWordBoundaries(cards, text), text));
}

// 6) whitespace-rich text unaffected (cuts already at spaces/newlines)
{
  const text = "บรรทัดหนึ่ง\nบรรทัดสอง\nบรรทัดสาม";
  const cards = snapCardsToWordBoundaries(splitSentenceCards(text, 12), text);
  check("newline text: unchanged behavior", coverage(cards, text) === text.replace(/\s+/g, ""));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll word-boundary checks passed ✓");
