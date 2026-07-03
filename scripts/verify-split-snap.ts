// Verify PR-E pure logic: mapCardTextsToRanges (LLM viral cards → exact char
// ranges, zero tolerance for text edits) + snapCaptionsToSilences.
// Run: npx tsx scripts/verify-split-snap.ts

import { mapCardTextsToRanges, snapCaptionsToSilences } from "../src/lib/tts-timing";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1) mapCardTextsToRanges
// ---------------------------------------------------------------------------

const SCRIPT = "รู้มั้ยว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่\nเพราะเขาเก็บเงินที่เหลือจากการใช้ แทนที่จะใช้เงินที่เหลือจากการเก็บ\nกดติดตามไว้ได้เลย";

{
  // exact pieces (LLM reflowed the newlines into spaces — must still map)
  const cards = mapCardTextsToRanges(SCRIPT, [
    { text: "รู้มั้ยว่าทำไมคนส่วนใหญ่", tag: "hook" },
    { text: "ถึงเก็บเงินไม่อยู่" },
    { text: "เพราะเขาเก็บเงินที่เหลือจากการใช้" },
    { text: "แทนที่จะใช้เงินที่เหลือจากการเก็บ", tag: "body" },
    { text: "กดติดตามไว้ได้เลย", tag: "cta" },
  ]);
  check("map: valid cards accepted", cards !== null && cards.length === 5);
  if (cards) {
    check("map: ranges are verbatim slices",
      cards.every((c) => SCRIPT.slice(c.startChar, c.endChar).replace(/\s+/g, "").length > 0));
    check("map: contiguous coverage of all visible chars",
      cards.map((c) => SCRIPT.slice(c.startChar, c.endChar)).join("").replace(/\s+/g, "") === SCRIPT.replace(/\s+/g, ""));
    check("map: tags preserved + pass-through", cards[0].tag === "hook" && cards[4].tag === "cta" && cards[1].tag === undefined);
    check("map: ordered non-overlapping", cards.every((c, i) => i === 0 || c.startChar >= cards[i - 1].endChar));
  }

  // LLM "fixed" a spelling — single visible char differs → reject everything
  check("map: edited char → null", mapCardTextsToRanges(SCRIPT, [
    { text: "รู้ไหมว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่" }, // มั้ย → ไหม
    { text: SCRIPT.slice(42) },
  ]) === null);

  // LLM dropped the tail (กฎ 6 violation) → reject
  check("map: missing tail → null", mapCardTextsToRanges(SCRIPT, [
    { text: "รู้มั้ยว่าทำไมคนส่วนใหญ่ถึงเก็บเงินไม่อยู่" },
  ]) === null);

  // LLM invented text → reject
  check("map: invented text → null", mapCardTextsToRanges(SCRIPT, [
    { text: SCRIPT },
    { text: "ขอบคุณที่รับชมครับ" },
  ]) === null);

  // whitespace-only / junk pieces
  check("map: whitespace-only piece skipped", (mapCardTextsToRanges(SCRIPT, [
    { text: "  \n " },
    { text: SCRIPT },
  ]) ?? []).length === 1);
  check("map: empty array → null", mapCardTextsToRanges(SCRIPT, []) === null);
  check("map: non-string piece → null", mapCardTextsToRanges(SCRIPT, [{ text: 7 as unknown as string }]) === null);
}

// ---------------------------------------------------------------------------
// 2) snapCaptionsToSilences
// ---------------------------------------------------------------------------

{
  const caps = () => [
    { startMs: 0, endMs: 3000 },
    { startMs: 3000, endMs: 6500 },
    { startMs: 6500, endMs: 10000 },
  ];

  // snapCaptionsToSilences takes SilenceInterval[] (since 06-17). A bare midpoint
  // is a degenerate interval {m,m} → onset & midpoint both collapse to m, i.e.
  // exactly the legacy point-based behaviour these checks were written against.
  const at = (...ms: number[]) => ms.map((m) => ({ startMs: m, endMs: m }));

  // silence midpoints near (not at) the boundaries
  const snapped = snapCaptionsToSilences(caps(), at(3400, 6100));
  check("snap: boundary 1 moved to 3400", snapped[0].endMs === 3400 && snapped[1].startMs === 3400);
  check("snap: boundary 2 moved to 6100", snapped[1].endMs === 6100 && snapped[2].startMs === 6100);
  check("snap: outer edges untouched", snapped[0].startMs === 0 && snapped[2].endMs === 10000);

  // beyond the ±1.5s window → no movement
  const far = snapCaptionsToSilences(caps(), at(4800));
  check("snap: silence outside window ignored", far[0].endMs === 3000 && far[1].startMs === 3000);

  // snap that would crush a card below 240ms → refused
  const crush = snapCaptionsToSilences(
    [{ startMs: 0, endMs: 3000 }, { startMs: 3000, endMs: 3300 }],
    at(3200),
  );
  check("snap: refuses to crush a card", crush[1].startMs === 3000, JSON.stringify(crush));

  // no silences / single card → untouched
  check("snap: no silences → unchanged", snapCaptionsToSilences(caps(), [])[0].endMs === 3000);
  check("snap: single card → unchanged", snapCaptionsToSilences([{ startMs: 0, endMs: 5000 }], at(2500))[0].endMs === 5000);

  // monotonicity holds after snapping
  const m = snapCaptionsToSilences(caps(), at(3400, 6100, 9000));
  check("snap: stays monotonic", m.every((c, i) => c.endMs > c.startMs && (i === 0 || c.startMs >= m[i - 1].endMs)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll split/snap checks passed ✓");
