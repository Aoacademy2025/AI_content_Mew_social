//   npx tsx scripts/verify-loanword-miner.ts
import { buildMinerPrompt, parseMinerResponse, icuMisSplits, hasGibberishFragment, validateCandidates, mineWithLlm } from "../src/lib/loanword-llm-miner";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// fake dict: contains some real fragments but NOT the loanword pieces
const dict = new Set(["ชัน", "กิน", "ทำ", "วัน", "นี้", "คิด", "แล้ว"]);
const scripts = ["วันนี้คิดแคปชันแล้วเทรดคริปโตกับเดลิเวอรี"];

assert(buildMinerPrompt(scripts).includes(scripts[0]), "prompt embeds the scripts");

assert(JSON.stringify(parseMinerResponse('```json\n["แคปชัน","คริปโต"]\n```')) === '["แคปชัน","คริปโต"]', "parses fenced JSON array");
assert(parseMinerResponse("not json at all").length === 0, "bad output → [] (fail-open)");

assert(icuMisSplits("แคปชัน") === true, "ICU mis-splits แคปชัน");
assert(icuMisSplits("กิน") === false, "single real word not flagged");

assert(hasGibberishFragment("แคปชัน", dict) === true, "แคปชัน has a non-dict fragment (แคป)");

// guard suite: covered, length, non-Thai, not-verbatim, all-dict-fragments
const v = validateCandidates(["แคปชัน", "คริปโต", "กิน", "AI", "ก", "เดลิเวอรี", "ฟันเทียม"], scripts, new Set(["คริปโต"]), dict);
assert(v.includes("แคปชัน") && v.includes("เดลิเวอรี"), "keeps real verbatim ICU-mis-splits");
assert(!v.includes("คริปโต"), "drops already-covered");
assert(!v.includes("กิน"), "drops not-verbatim / single word");
assert(!v.includes("AI"), "drops non-Thai");
assert(!v.includes("ก"), "drops <4 chars");
assert(!v.includes("ฟันเทียม"), "drops word not present verbatim in scripts");

(async () => {
  const fakeLlm = async () => '["แคปชัน","กิน","คริปโต","เดลิเวอรี"]';
  const got = await mineWithLlm(scripts, new Set(["คริปโต"]), dict, fakeLlm);
  assert(got.length === 2 && got.includes("แคปชัน") && got.includes("เดลิเวอรี"), "mineWithLlm end-to-end with injected LLM");
  const errLlm = async () => { throw new Error("boom"); };
  assert((await mineWithLlm(scripts, new Set(), dict, errLlm)).length === 0, "LLM throw → [] (fail-open)");
  console.log(`\n${passed} checks passed`);
})();
