// Curated NATIVE THAI COMPOUNDS that Intl.Segmenter("th",{granularity:"word"})
// mis-splits — e.g. it breaks "ขี้เกียจ" => "ขี้|เกียจ", "เวลางาน" => "เวลา|งาน".
// Distinct in KIND from loanwords (thai-loanwords.ts = transliterations ICU doesn't
// know): a native compound splits into fragments that are THEMSELVES real Thai words,
// which is exactly why the daily loanword miner rejects them and why they can never be
// auto-applied — deciding "real fixed compound" vs "two words written together" is
// subjective. So this list is CURATED BY HAND (Part 1) and the mined long-tail is
// HUMAN-APPROVED (Part 2, store.pendingCompounds → store.compounds).
//
// They flow through the SAME span-merge as loanwords: loanwordSpans() consumes
// getActiveCompounds() alongside the loanword active set, so wordBoundaries() keeps each
// compound ONE token on BOTH the MCP worker and web-editor paths automatically.
//
// SAFETY — matching in loanwordSpans is an indexOf SUBSTRING scan, so a bad entry can
// FALSE-MERGE inside an unrelated word (worse than a missed split). Every entry here was
// vetted (scripts/verify-thai-compounds.ts asserts it) so that:
//   (i)  Intl.Segmenter actually splits it (else it's pointless), and
//   (ii) it is a genuine fixed lexical compound whose EDGE fragments are not hyper-common
//        function words, so it can't straddle a real word boundary in running text, and no
//        dictionary word contains it across a real (common-word) boundary.
// When unsure, LEAVE IT OUT — the miner + /admin/loanwords review handle the long tail.
export const THAI_COMPOUNDS: string[] = [
  // ── ขี้ + trait (personality) — "ขี้" is a bound prefix; each tail is a content word ──
  // (all confirmed ICU-split; ขี้เกียจ is the origin QA case)
  "ขี้เกียจ", "ขี้อาย", "ขี้โกง", "ขี้ลืม", "ขี้เหนียว", "ขี้กลัว", "ขี้บ่น", "ขี้สงสาร",
  "ขี้ระแวง", "ขี้หึง", "ขี้น้อยใจ", "ขี้แง", "ขี้เมา", "ขี้ขลาด", "ขี้อิจฉา", "ขี้งอน",
  "ขี้เล่น", "ขี้เกรงใจ", "ขี้สงสัย", "ขี้ตกใจ",
  // ── work / everyday fixed compounds (edge fragments are NOT hyper-common) ──
  // เวลางาน is the second origin QA case. (เงินเดือน/ค่าจ้าง/รายได้/ที่ทำงาน were
  // deliberately OMITTED — their edge is a hyper-common word => running-text merge risk.)
  "เวลางาน", "เวลาว่าง", "ชั่วโมงทำงาน", "เพื่อนร่วมงาน", "เพื่อนบ้าน", "เพื่อนสนิท",
  "โรงพยาบาล", "มืออาชีพ", "โทรศัพท์มือถือ",
];
// NOTE: the section-5 safety oracle (scripts/verify-thai-compounds.ts) only checks
// DICTIONARY-superstring collisions — it does NOT catch cross-word-boundary coincidences
// in free running text. "มือใหม่" passed that oracle yet still false-merged in ordinary
// text (e.g. "ล้างมือใหม่ๆทุกเช้า" => wrongly "มือ"+"ใหม่" merged into "มือใหม่") because
// both edge fragments (มือ, ใหม่) are hyper-common — removed 2026-07-07. New entries must
// avoid hyper-common edge fragments (มือ/ใหม่/ได้/ราย/เงิน/ความ/ที่/ค่า/ของ/ใจ…) even if
// the oracle is green.

// Dynamic APPROVED compounds (admin-approved out of the mined pending bucket, stored in
// SiteConfig) merged on top of the static seed at runtime — same pattern/semantics as
// thai-loanwords.ts setDynamicLoanwords. The shared denylist removes an entry (static or
// approved) from the active set. loanwordSpans reads getActiveCompounds() per call.
let _activeCompounds: string[] = [...THAI_COMPOUNDS];
export function setDynamicCompounds(approved: string[] = [], denylist: string[] = []): void {
  const deny = new Set(Array.isArray(denylist) ? denylist : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...THAI_COMPOUNDS, ...(Array.isArray(approved) ? approved : [])]) {
    if (typeof w !== "string" || w.length === 0 || deny.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  _activeCompounds = out;
}
export function getActiveCompounds(): string[] {
  return _activeCompounds;
}
