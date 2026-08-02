// Locks the SUBTITLE INVARIANT: windowing must never change keywordPopups (the subtitles).
// buildKeywordPopups is the pure extraction of generate-config's inline popup builder.
// run: npx tsx scripts/verify-subtitle-invariant.ts
import { buildKeywordPopups } from "../src/lib/keyword-popups";
import {
  mergeCaptionWithNext,
  regroupCaptions,
  type V2Caption,
} from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const caps = [
  { text: "เช้านี้เริ่มด้วยกาแฟ", startMs: 0, endMs: 1500, tag: "hook" as const },
  { text: "กลิ่นหอมกรุ่น", startMs: 1500, endMs: 3000, tag: "body" as const },
  { text: "ลุยงานต่อ", startMs: 3000, endMs: 4500, tag: "body" as const },
];
const opts = { fps: 30, durationInFrames: 135, subtitleSize: 80, primaryColor: "#FFFFFF", accentColor: "#FFE500", subtitleStylePreset: undefined, subtitlePosition: 82, subtitleFontWeight: 900 };

const a = buildKeywordPopups(caps, opts);
check("one popup per caption", a.length === 3, `${a.length}`);
check("text preserved", a[0].text === "เช้านี้เริ่มด้วยกาแฟ");
check("frames from caption timing (hook 0→45)", a[0].start === 0 && a[0].end === 45, `${a[0].start},${a[0].end}`);
check("hook uses accent color", a[0].color === "#FFE500");
check("body uses primary color", a[1].color === "#FFFFFF");
check("position passed through", a[0].topPercent === 82);

// DETERMINISM: identical input → identical output (the invariant the window flag must keep)
const b = buildKeywordPopups(caps, opts);
check("deterministic / byte-identical", JSON.stringify(a) === JSON.stringify(b));

const thaiSplitAcrossCards: V2Caption[] = [
  { text: "แล้วคอมเมน", startMs: 0, endMs: 800, tag: "hook" },
  { text: "ต์บอกกัน", startMs: 800, endMs: 1500, tag: "body" },
];
const mergedThai = mergeCaptionWithNext(thaiSplitAcrossCards, 0);
check(
  "merge Thai captions without injecting a word-breaking space",
  mergedThai[0].text === "แล้วคอมเมนต์บอกกัน",
  JSON.stringify(mergedThai[0].text),
);

const latinCards: V2Caption[] = [
  { text: "hello", startMs: 0, endMs: 800, tag: "hook" },
  { text: "world", startMs: 800, endMs: 1500, tag: "body" },
];
const mergedLatin = mergeCaptionWithNext(latinCards, 0);
check(
  "merge Latin captions with one separating space",
  mergedLatin[0].text === "hello world",
  JSON.stringify(mergedLatin[0].text),
);

// ── รอยต่อการ์ด: ห้ามมี space นำ/ตาม และห้ามเชื่อมคำไทยด้วย space ────────────────────
const mergeText = (left: string, right: string): string => mergeCaptionWithNext([
  { text: left, startMs: 0, endMs: 800, tag: "hook" },
  { text: right, startMs: 800, endMs: 1500, tag: "body" },
], 0)[0].text;

const joinCases: Array<[string, string, string, string]> = [
  ["empty left card merges without a leading space", "", "บอกกัน", "บอกกัน"],
  ["empty right card keeps the left text as-is", "บอกกัน", "", "บอกกัน"],
  ["whitespace-only left card behaves like an empty card", "   ", "  บอกกัน", "บอกกัน"],
  ["whitespace-only right card behaves like an empty card", "บอกกัน  ", "   ", "บอกกัน"],
  ["two whitespace-only cards merge to empty text", "  ", "   ", ""],
  ["Latin→Thai boundary keeps one space", "Hero", "ครับ", "Hero ครับ"],
  ["Thai→Latin boundary keeps one space", "ครับ", "OK", "ครับ OK"],
  ["digit→Thai boundary keeps one space", "500", "บาท", "500 บาท"],
  ["emoji before Thai does not glue the surrogate pair", "ไปเลย🔥", "ครับ", "ไปเลย🔥 ครับ"],
  ["emoji after Thai does not glue the surrogate pair", "ครับ", "🔥ลุย", "ครับ 🔥ลุย"],
];
for (const [name, left, right, expected] of joinCases) {
  const actual = mergeText(left, right);
  check(name, actual === expected, JSON.stringify(actual));
}

// รวมติดกันหลายรอบ: ช่องว่างต้องไม่สะสม และ endMs ต้องไล่ตามใบสุดท้ายที่ถูกรวม
const chain: V2Caption[] = [
  { text: "แล้วคอมเมน", startMs: 0, endMs: 800, tag: "hook" },
  { text: "ต์บอกกัน", startMs: 800, endMs: 1500, tag: "body" },
  { text: "  ", startMs: 1500, endMs: 2000, tag: "body" },
  { text: "ด้วยนะ", startMs: 2000, endMs: 2600, tag: "body" },
];
let chained = mergeCaptionWithNext(chain, 0);
chained = mergeCaptionWithNext(chained, 0);
chained = mergeCaptionWithNext(chained, 0);
check(
  "repeated merges never accumulate whitespace",
  chained.length === 1 && chained[0].text === "แล้วคอมเมนต์บอกกันด้วยนะ",
  JSON.stringify(chained[0].text),
);
check(
  "merged card spans from the first start to the last end",
  chained[0].startMs === 0 && chained[0].endMs === 2600,
  `${chained[0].startMs}→${chained[0].endMs}`,
);

// รวม "ใบสุดท้าย" (ไม่มีใบถัดไป) = ไม่มีอะไรเปลี่ยน
check(
  "merging the last card is an identity",
  mergeCaptionWithNext(chain, chain.length - 1) === chain
    && mergeCaptionWithNext(chain, -1) === chain,
);

// UI regrouping must stay in lockstep with the server/MCP grouping. Otherwise
// opening a completed MCP job in the editor silently changes its Thai cards.
const naturalText = "และช่วงปิด ให้ซับตรง และนำไปใช้งานจริงได้";
const naturalTokens = ["และ", "ช่วง", "ปิด", "ให้", "ซับ", "ตรง", "และ", "นำ", "ไป", "ใช้", "งาน", "จริง", "ได้"];
let naturalOffset = 0;
const naturalWords = naturalTokens.map((word, index) => {
  const startChar = naturalText.indexOf(word, naturalOffset);
  const endChar = startChar + word.length;
  naturalOffset = endChar;
  return { word, startMs: index * 100, endMs: index * 100 + 90, startChar, endChar };
});
const regroupedNatural = regroupCaptions([], "2", naturalWords, naturalText);
check(
  "editor mode 2 keeps natural Thai phrases in lockstep with MCP",
  regroupedNatural.some((card) => card.text === "และช่วงปิด")
    && regroupedNatural.some((card) => card.text === "ให้ซับตรง")
    && regroupedNatural.some((card) => card.text === "ใช้งานจริงได้"),
  JSON.stringify(regroupedNatural.map((card) => card.text)),
);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll subtitle-invariant checks passed.");
