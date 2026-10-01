// Run: npx tsx scripts/verify-subtitle-balanced-break.ts
//
// T2 — Display-time balanced line break (the reported defect). renderSubtitle draws a
// Caption with `whiteSpace: "pre-line"`, so Chromium's own line-breaker decides where a
// too-wide Caption wraps. That algorithm is not Thai-balance-aware (ตัดคำ/เว้นวรรคผิด).
// This script tests the display-only `\n` chooser that replaces it: `chooseBalancedLineBreak`
// (the raw boundary pick) and `applyDisplayLineBreak` (the text transform renderSubtitle
// calls), both exported from renderSubtitle.tsx — plus the fixture + karaoke/highlight/
// typewriter integration the plan requires.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyDisplayLineBreak,
  chooseBalancedLineBreak,
  renderSubtitle,
} from "../src/remotion/renderSubtitle";
import { baseGraphemeCount, maxCardCharsFor } from "../src/lib/card-line-budget";
import { cardCutBoundaries, enforceCardLineBudget } from "../src/lib/tts-timing";

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message);
  console.log(`✓ ${message}`);
}

function widthOf(value: string): number {
  return baseGraphemeCount(value.replace(/\s+/gu, " ").trim());
}

function stripSpaces(value: string): string {
  return value.replace(/\s+/gu, "");
}

// ── A) The reported defect's own fixture cards (plan T2 checklist) ─────────────────
const REPORTED_CARDS = [
  "กระจุกอยู่ที่เด็กซึ่งทำการบ้านเสร็จเร็วผิดปกติ", // 33 base graphemes
  "ผลสำรวจของ Rocket Media Lab", // 27 base graphemes
  "กับมูลนิธิแพธทูเฮลท์ พบว่า", // 19 base graphemes — already fits at 80/60
];

for (const size of [80, 60] as const) {
  const budget = maxCardCharsFor(size);
  for (const text of REPORTED_CARDS) {
    const broken = applyDisplayLineBreak(text, size);
    const total = widthOf(text);

    if (total <= budget) {
      check(broken === text, `size ${size}: a card already within budget is left untouched (${JSON.stringify(text)})`);
      continue;
    }

    check(broken.includes("\n"), `size ${size}: an over-budget card gets a display break (${JSON.stringify(text)})`);
    const lines = broken.split("\n");
    check(lines.length === 2, `size ${size}: at most one forced break — exactly two lines (${JSON.stringify(text)})`);
    const [line1, line2] = lines;
    check(
      widthOf(line1) <= budget && widthOf(line2) <= budget,
      `size ${size}: both lines fit the one-line budget (${widthOf(line1)}/${widthOf(line2)} vs ${budget}) for ${JSON.stringify(text)}`,
    );
    check(line1 === line1.trimEnd() && line2 === line2.trimStart(), `size ${size}: no stray whitespace at the break (${JSON.stringify(text)})`);
    check(stripSpaces(line1) + stripSpaces(line2) === stripSpaces(text), `size ${size}: the break drops no character (${JSON.stringify(text)})`);

    const cut = chooseBalancedLineBreak(text, budget);
    check(cut !== null && cardCutBoundaries(text).includes(cut), `size ${size}: the chosen break is a cardCutBoundaries word-boundary index (${JSON.stringify(text)})`);
  }
}

// ── B) Protected spans: a break must never land inside a protectSubtitleWordBreaks span.
// "อัลลัน" (Allan) is the repo's own canonical ICU-fragile short name: space-delimited,
// <=8 graphemes, and the word segmenter splits it into two word-like parts ("อัล"+"ลัน"),
// so `protectSubtitleWordBreaks` guards it. That interior split is also the mathematically
// PERFECT balance point (diff 0) for "นาย อัลลัน ครับ" — proving the span filter is load
// bearing, not just coincidentally unused: without it, the chooser would pick boundary 7.
{
  const text = "นาย อัลลัน ครับ";
  const nameStart = text.indexOf("อัลลัน");
  const nameInteriorCut = nameStart + 3; // the อัล|ลัน split ICU offers
  for (const budget of [1, 4, 6, 8, 11]) {
    const cut = chooseBalancedLineBreak(text, budget);
    check(cut !== nameInteriorCut, `budget ${budget}: the balanced break never splits a protected short name (got ${cut})`);
  }
  const allowedCuts = cardCutBoundaries(text).filter((b) => b !== nameInteriorCut);
  check(
    allowedCuts.includes(chooseBalancedLineBreak(text, 6) as number),
    "the chooser falls back to one of the name's own (unprotected) edges instead of its perfect-balance interior split",
  );
}

// ── C) No usable boundary: a single unbreakable token (one loanword/Latin run, no
// interior word boundary) never gets a forced break — natural wrap must handle it.
{
  // One Latin token with no space, hyphen or punctuation inside it: Intl.Segmenter("word")
  // never places an interior boundary, so cardCutBoundaries(word) is empty — exactly T1's
  // "a single unbreakable word... stays as one over-budget card" case (open concern #7).
  const unbreakable = "Pneumonoultramicroscopicsilicovolcanoconiosis";
  check(cardCutBoundaries(unbreakable).length === 0, "the fixture word truly has no interior word boundary");
  check(widthOf(unbreakable) > maxCardCharsFor(80), "the unbreakable fixture is over budget at size 80");
  check(chooseBalancedLineBreak(unbreakable, maxCardCharsFor(80)) === null, "a single unbreakable token gets no forced break");
  check(applyDisplayLineBreak(unbreakable, 80) === unbreakable, "applyDisplayLineBreak leaves an unbreakable token unchanged");
}

// ── D) Cannot fit two lines (old job / user-typed card): still gets the most balanced
// SINGLE forced break, even though one side still overflows — natural wrap then handles
// the remainder, and no second forced break is ever added.
{
  const longSentence = "เรื่องนี้มาจากคำฟ้องของบรูกส์ และความสัมพันธ์ก็ได้รับผลกระทบแล้ว เมื่อคุยนานต่อเนื่องเราอาจเห็นด้วยกับเขาทุกเรื่อง";
  const tinyBudget = 15; // smaller than either natural half, so neither line can fit
  const cut = chooseBalancedLineBreak(longSentence, tinyBudget);
  check(cut !== null, "a long sentence still gets a single forced break even when no side fits the tiny budget");
  if (cut !== null) {
    check(
      widthOf(longSentence.slice(0, cut)) > tinyBudget || widthOf(longSentence.slice(cut)) > tinyBudget,
      "this fixture genuinely cannot fit two lines at the tiny budget (sanity check on the fixture itself)",
    );
  }
  const broken = applyDisplayLineBreak(longSentence, 160); // maxCardCharsFor(160) is tiny too
  check((broken.match(/\n/g) ?? []).length <= 1, "never more than one forced break, however small the budget");
}

// ── E) Manual newlines are left alone (old jobs, user-typed multi-line cards) — same
// fail-open rule `enforceCardLineBudget` (T1) applies, never a second break on top.
{
  const manual = "บรรทัดแรกที่ยาวมากจนเกินบรรทัดเดียวอย่างแน่นอนที่สุด\nบรรทัดสอง";
  check(applyDisplayLineBreak(manual, 80) === manual, "a caption with a manual newline is never touched");
}

// ── F) Full fixture sweep (mcp-48-cards.json) at sizes 80 and 60: every invariant holds
// on every card, exactly as the T1 Card Line Budget invariants do.
const fixture = JSON.parse(readFileSync("scripts/fixtures/mcp-48-cards.json", "utf8")) as {
  captions: { text: string }[];
};
check(fixture.captions.length === 48, "the MCP fixture still has 48 captions");

for (const size of [80, 60] as const) {
  const budget = maxCardCharsFor(size);
  let sawOverBudgetCard = false;
  for (const caption of fixture.captions) {
    const text = caption.text;
    const broken = applyDisplayLineBreak(text, size);
    check(stripSpaces(broken) === stripSpaces(text), `size ${size}: fixture card text is preserved (${JSON.stringify(text)})`);

    if (!broken.includes("\n")) continue; // untouched: either fits, or no usable boundary
    sawOverBudgetCard = true;
    const lines = broken.split("\n");
    check(lines.length === 2, `size ${size}: fixture card gets at most one forced break (${JSON.stringify(text)})`);
    const [line1, line2] = lines;
    check(widthOf(line1) <= budget || widthOf(line2) <= budget, `size ${size}: at least one line respects the budget after the break (${JSON.stringify(text)})`);

    // The break chooser is deterministic and pure, so re-running it on the same
    // original text recovers the exact index used — check it against cardCutBoundaries.
    const rawCut = chooseBalancedLineBreak(text, budget);
    check(rawCut !== null && cardCutBoundaries(text).includes(rawCut), `size ${size}: fixture card break is a real word boundary (${JSON.stringify(text)})`);
  }
  check(sawOverBudgetCard, `size ${size}: at least one fixture card actually exercises the break (sanity check on the fixture+budget pair)`);
}

// ── G) Karaoke / highlight / typewriter must handle the inserted break via tokenLines /
// grapheme reveal. Reuses the `textContent` pattern from verify-subtitle-render-text.ts.
function textContent(markup: string): string {
  return markup
    .replace(/<br\s*\/?\s*>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/⁠/gu, "");
}

const overBudgetCard = REPORTED_CARDS[0]; // 33 base graphemes, over budget at 80
for (const effect of ["karaoke", "highlight"] as const) {
  const markup = renderToStaticMarkup(renderSubtitle(
    overBudgetCard, "#FFFFFF", 80, false, "shadow", "Kanit", 900, 0, 45, effect, "#F87171", { shadow: true },
  ));
  check(markup.includes("<br"), `${effect} renders the display break as an explicit line break`);
  check(textContent(markup) === applyDisplayLineBreak(overBudgetCard, 80), `${effect} markup text matches the display-broken source, incl. the \\n`);
}

{
  const withBreak = applyDisplayLineBreak(overBudgetCard, 80);
  check(withBreak.includes("\n"), "typewriter's own source text carries the inserted break");
  const graphemeSegmenter = new Intl.Segmenter("th", { granularity: "grapheme" });
  const totalGraphemes = Array.from(graphemeSegmenter.segment(withBreak)).length;
  // At the final frame, typewriter has revealed every grapheme, including the \n — the
  // revealed span's text (whole-source slice at full reveal) must equal withBreak itself,
  // so the break the user sees is the same one chosen above, not Chromium's own wrap.
  const finalMarkup = renderToStaticMarkup(renderSubtitle(
    overBudgetCard, "#fff", 80, false, "stroke", "Kanit", 900, totalGraphemes, totalGraphemes, "typewriter", "#FFE500",
  ));
  const revealed = finalMarkup.match(/<span style="color:#fff">([^<]*)<\/span>/)?.[1]?.replace(/⁠/gu, "");
  check(revealed === withBreak, `typewriter fully reveals the display-broken text, including its \\n (got ${JSON.stringify(revealed)})`);
}

// ── H) Fix round 1 (coordinator-blocking): a legal ICU word boundary is not good enough —
// never break right after a bound Thai nominalizing/compound prefix (การ, ความ, ผู้, นัก,
// ชาว, ช่าง, เครื่อง) when the next segment is Thai script with no space, in BOTH T2's
// display break and T1's own card cuts (A9: one shared definition, cardCutBoundaries).
{
  // H1) The plan's own cited defect card: Intl.Segmenter("th") gives "ทำการ" (index 21-26,
  // one ICU segment meaning "operate") then "บ้าน" (26-30, "house") as its own segment —
  // ICU does NOT keep "การบ้าน" together; the boundary at 26 is a genuine, bare segmenter
  // boundary. But "ทำการ" itself still ENDS in the bound prefix "การ", so cutting there
  // reads line 1 as ending in "ทำการ" (wrong word) instead of continuing into "การบ้าน"
  // (homework) — exactly the ตัดคำผิด defect reported. Must never happen at any size.
  const card1 = REPORTED_CARDS[0];
  const compoundCut = card1.indexOf("บ้าน"); // = 26: the boundary between การ and บ้าน
  check(!cardCutBoundaries(card1).includes(compoundCut), "H1: cardCutBoundaries never offers the การ|บ้าน split, even though it is a bare ICU segment boundary");
  for (const size of [80, 60] as const) {
    const broken = applyDisplayLineBreak(card1, size);
    check(!broken.includes("ทำการ\nบ้าน"), `H1 size ${size}: the display break never splits ทำการ|บ้าน (got ${JSON.stringify(broken)})`);
  }

  // H2) A T1 card-cut case with a ความ/การ compound: here ICU gives "ความ" (22-26) as its
  // OWN exact segment, then "สัมพันธ์" (26-34, "relation") — same defect shape, this time
  // an exact-segment prefix rather than a trailing substring of a longer one. Exercised
  // through enforceCardLineBudget itself (T1's public card-splitter), not just the raw
  // boundary list, so both consumers of cardCutBoundaries are proven, not just one.
  const compoundSentence = "เรื่องนี้ส่งผลกระทบต่อความสัมพันธ์ของทั้งสองฝ่ายอย่างมาก";
  const comboundCut = compoundSentence.indexOf("สัมพันธ์");
  check(!cardCutBoundaries(compoundSentence).includes(comboundCut), "H2: cardCutBoundaries never offers the ความ|สัมพันธ์ split either");
  const split = enforceCardLineBudget(
    [{ text: compoundSentence, startMs: 0, endMs: 5000 }],
    null,
    compoundSentence,
    "sentence",
    80,
  );
  check(split.length > 1, "H2: the compound sentence is long enough to actually exercise a card split (sanity check on the fixture)");
  check(
    split.every((piece) => !piece.text.endsWith("ความ") && !piece.text.startsWith("สัมพันธ์")),
    `H2: enforceCardLineBudget (T1) never orphans ความ from สัมพันธ์ across a card edge (got ${JSON.stringify(split.map((p) => p.text))})`,
  );

  // H3) Two more real examples (นัก|วิจัย, ผู้|บริหาร) from the production fixture's own
  // vocabulary, confirming the rule generalizes beyond this one card.
  const moreCases: Array<[string, string]> = [
    ["นักวิจัยรายงานว่าความเสียหายรุนแรงกว่าที่คาดไว้มาก", "วิจัย"], // นัก|วิจัย
    ["ผู้บริหารต้องตัดสินใจเรื่องงบประมาณภายในสัปดาห์นี้อย่างรอบคอบ", "บริหาร"], // ผู้|บริหาร
  ];
  for (const [text, afterPrefix] of moreCases) {
    const cut = text.indexOf(afterPrefix);
    check(!cardCutBoundaries(text).includes(cut), `H3: cardCutBoundaries never splits right before ${JSON.stringify(afterPrefix)} in ${JSON.stringify(text)}`);
  }

  // H4) ที่ is deliberately NOT in the blocked-prefix list (it's a free function word, not a
  // bound prefix) — card 1 itself has "...อยู่ที่เด็ก..." where breaking around ที่ must
  // stay available to the chooser; this just confirms the exclusion didn't silently vanish.
  check(cardCutBoundaries(card1).includes(card1.indexOf("ที่") + "ที่".length), "H4: ที่ is NOT treated as a blocked bound prefix (boundary right after it stays offered)");
}

// ── I) Tie-break (fix round 1): among near-balanced candidates, prefer a boundary at a
// space, then the later one. "ผลสำรวจของ Rocket Media Lab" has two Latin-run boundaries
// near the balance point; the chosen one must land at the space before "Rocket", keeping
// the proper noun "Rocket Media Lab" whole on line 2, not orphaning "Lab" alone.
{
  const text = "ผลสำรวจของ Rocket Media Lab";
  const broken = applyDisplayLineBreak(text, 80);
  check(broken === "ผลสำรวจของ\nRocket Media Lab", `I: tie-break prefers the space boundary that keeps "Rocket Media Lab" whole (got ${JSON.stringify(broken)})`);
}

console.log("\n✅ SUBTITLE BALANCED LINE BREAK CHECKS PASSED");
