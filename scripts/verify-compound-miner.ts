// Native-compound candidate miner (Part 2). mineCompoundCandidates is the exact
// complement of mineLoanwords: it keeps dict words ICU split into ALL-real fragments
// (native compounds) and rejects gibberish-fragment ones (those are loanwords).
// rankCompoundsWithLlm only narrows + never hallucinates + fails open.
//   npx tsx scripts/verify-compound-miner.ts
import { mineCompoundCandidates } from "../src/lib/loanword-mining";
import { buildCompoundRankPrompt, rankCompoundsWithLlm } from "../src/lib/loanword-llm-miner";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// dict: ขี้เกียจ is a native compound (ICU → ขี้|เกียจ, both real); แคปชัน is a loanword
// (ICU → แคป|ชัน, แคป not real). วันนี้ ICU keeps whole (should be ignored).
const dict = new Set(["ขี้เกียจ", "ขี้", "เกียจ", "เวลางาน", "เวลา", "งาน", "วันนี้", "มาก", "แคปชัน", "ชัน"]);
const scripts = ["วันนี้เขาขี้เกียจมาก", "ขี้เกียจจริงๆนะ", "หมดเวลางานแล้ว", "คิดแคปชันไม่ออก"];

const res = mineCompoundCandidates(scripts, dict, new Set(), { minLen: 4, cap: 25 });
const words = res.map((r) => r.word);
assert(words.includes("ขี้เกียจ"), `detects native compound ขี้เกียจ (all fragments real) — got [${words.join(",")}]`);
assert(words.includes("เวลางาน"), "detects native compound เวลางาน");
assert(!words.includes("แคปชัน"), "rejects loanword แคปชัน (has gibberish fragment แคป → not a native compound)");
assert(res.find((r) => r.word === "ขี้เกียจ")!.count === 2, "frequency counts distinct scripts");

// already-known excluded
const res2 = mineCompoundCandidates(scripts, dict, new Set(["ขี้เกียจ"]), { minLen: 4, cap: 25 });
assert(!res2.map((r) => r.word).includes("ขี้เกียจ"), "excludes already-known compound");

// cap limits output
assert(mineCompoundCandidates(scripts, dict, new Set(), { minLen: 4, cap: 1 }).length <= 1, "cap limits results");

// ── LLM ranking (optional noise-reducer, human-gated downstream) ──
assert(buildCompoundRankPrompt(["ขี้เกียจ"]).includes("ขี้เกียจ"), "rank prompt embeds candidates");

(async () => {
  const cands = ["ขี้เกียจ", "เวลางาน", "คนดี"];
  const keep = await rankCompoundsWithLlm(cands, async () => '["ขี้เกียจ","เวลางาน"]');
  assert(keep.length === 2 && keep.includes("ขี้เกียจ") && !keep.includes("คนดี"), "LLM narrows to the genuine subset");

  const noIntro = await rankCompoundsWithLlm(cands, async () => '["สิ่งที่ไม่ได้ส่งไป"]');
  assert(JSON.stringify(noIntro) === JSON.stringify(cands), "never introduces non-candidates; empty valid subset → keep ALL (human gate backstops)");

  const errKeep = await rankCompoundsWithLlm(cands, async () => { throw new Error("boom"); });
  assert(JSON.stringify(errKeep) === JSON.stringify(cands), "LLM throw → fail-open keeps all candidates");

  assert((await rankCompoundsWithLlm([], async () => "[]")).length === 0, "empty candidates → []");

  console.log(`\n${passed} checks passed`);
})();
