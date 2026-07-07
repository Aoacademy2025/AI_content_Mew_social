// Native-compound merge machinery + SAFETY oracle for the curated seed.
// Compounds (thai-compounds.ts) must flow through the SAME loanwordSpans merge as
// loanwords and stay whole in tokenizeWords, WITHOUT false-merging inside unrelated
// words. Every seed entry is re-vetted here so a future unsafe addition fails CI.
//   npx tsx scripts/verify-thai-compounds.ts
import * as fs from "fs";
import * as path from "path";
import { THAI_COMPOUNDS, setDynamicCompounds, getActiveCompounds } from "../src/lib/thai-compounds";
import { loanwordSpans } from "../src/lib/thai-loanwords";
import { tokenizeWords } from "../src/lib/tts-timing";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const seg = new Intl.Segmenter("th", { granularity: "word" });
const wlFrags = (w: string) => [...seg.segment(w)].filter((t) => (t as { isWordLike?: boolean }).isWordLike).map((t) => t.segment);

// ── 1: every seed entry is actually ICU-mis-split (else adding it is pointless) ──
for (const w of THAI_COMPOUNDS) {
  assert(wlFrags(w).length >= 2, `ICU mis-splits "${w}" (frags ${wlFrags(w).join("|")}) — worth merging`);
}

// ── 2: loanwordSpans (the shared merge) returns each compound as a whole span ──
for (const w of THAI_COMPOUNDS) {
  const text = `ประโยคที่มี${w}อยู่ตรงกลาง`;
  const spans = loanwordSpans(text);
  assert(spans.some((s) => text.slice(s.start, s.end) === w), `loanwordSpans keeps "${w}" whole`);
}

// ── 3: tokenizeWords keeps each compound one token; offsets slice back exactly ──
for (const w of THAI_COMPOUNDS) {
  const text = `คนคนนี้${w}จริงๆ`;
  const toks = tokenizeWords(text);
  assert(toks.some((t) => t.word === w), `tokenizeWords keeps "${w}" whole`);
  assert(toks.every((t) => text.slice(t.startChar, t.endChar) === t.word), `token offsets exact for "${w}"`);
}

// ── 4: dynamic approved-compound channel (mirror of setDynamicLoanwords) ──
setDynamicCompounds([], []);
assert(getActiveCompounds().length === THAI_COMPOUNDS.length, "default active compounds == static seed");
setDynamicCompounds(["คำประสมทดสอบ", "ขี้เกียจ"], []);
assert(getActiveCompounds().includes("คำประสมทดสอบ"), "dynamic approved compound added");
assert(getActiveCompounds().filter((w) => w === "ขี้เกียจ").length === 1, "dynamic dupe of seed deduped");
setDynamicCompounds([], ["ขี้เกียจ"]);
assert(!getActiveCompounds().includes("ขี้เกียจ"), "denylist removes a seed compound");
{
  const spans = loanwordSpans("วันนี้เขาขี้เกียจมาก");
  assert(!spans.some((s) => "วันนี้เขาขี้เกียจมาก".slice(s.start, s.end) === "ขี้เกียจ"), "denylisted compound not merged by loanwordSpans");
}
setDynamicCompounds(["คำประสมทดสอบ"], []);
{
  const t = "นี่คือคำประสมทดสอบของเรา";
  assert(loanwordSpans(t).some((s) => t.slice(s.start, s.end) === "คำประสมทดสอบ"), "loanwordSpans reflects dynamic approved compound");
}
setDynamicCompounds([], []); // reset

// ── 5: SAFETY — no seed entry can false-merge inside a real (common-word) boundary ──
// A dict word W containing C is dangerous only if a COMMON dict word straddles one of
// C's edges in W (forcing C whole would cut that real word). Rare/archaic ≤2-char dict
// entries are ignored as noise. This is the guard that keeps future additions honest.
const dictPath = path.join(process.cwd(), "data/words_th.txt");
if (fs.existsSync(dictPath)) {
  const dict = new Set<string>(); const dictArr: string[] = [];
  for (const raw of fs.readFileSync(dictPath, "utf8").split("\n")) { const w = raw.trim(); if (/^[ก-๙]+$/.test(w)) { dict.add(w); dictArr.push(w); } }
  let maxLen = 2; for (const w of dict) if (w.length > maxLen) maxLen = w.length;
  const COMMONISH = (w: string) => w.length >= 3 || ["ได้","ไป","มา","ให้","ใจ","ราย","งาน","ของ","ค่า","นาย","ตัว","ทำ","คน","ไม่","ที่","การ","มี","จน"].includes(w);
  const straddle = (W: string, p: number, cs: number, ce: number): string | null => {
    if (p <= 0 || p >= W.length) return null;
    for (let a = Math.max(0, p - maxLen); a < p; a++)
      for (let L = p - a + 1; a + L <= W.length && L <= maxLen; L++) {
        const sub = W.substr(a, L);
        if (a + L > p && dict.has(sub) && !(a <= cs && a + L >= ce) && COMMONISH(sub)) return `${sub}@${a}`;
      }
    return null;
  };
  for (const C of THAI_COMPOUNDS) {
    const hits: string[] = [];
    for (const W of dictArr) {
      if (W.length <= C.length) continue;
      let f = 0, idx: number;
      while ((idx = W.indexOf(C, f)) !== -1) {
        const s1 = straddle(W, idx, idx, idx + C.length);
        const s2 = straddle(W, idx + C.length, idx, idx + C.length);
        if (s1) hits.push(`${W}(${s1})`); if (s2) hits.push(`${W}(${s2})`);
        f = idx + 1;
      }
    }
    assert(hits.length === 0, `"${C}" has NO common-word straddle superstring${hits.length ? " — UNSAFE: " + hits.slice(0, 3).join(",") : ""}`);
  }
} else {
  console.log("… (dict file absent — skipping superstring safety oracle)");
}

console.log(`\n${passed} checks passed`);
