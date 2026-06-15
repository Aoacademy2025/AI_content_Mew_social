// static ∪ dynamic − denylist merge for loanwords.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-merge.ts
import { THAI_LOANWORDS, setDynamicLoanwords, getActiveLoanwords, loanwordSpans } from "../src/lib/thai-loanwords";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// default: active == static
setDynamicLoanwords([], []);
assert(getActiveLoanwords().length === THAI_LOANWORDS.length, "default active == static list");

// dynamic words are added and deduped against static
setDynamicLoanwords(["สตรีมมิ่ง", "แอดมิน"], []);
const a = getActiveLoanwords();
assert(a.includes("สตรีมมิ่ง"), "dynamic word added");
assert(a.filter((w) => w === "แอดมิน").length === 1, "dynamic dupe of static deduped");

// denylist removes a word even if static
setDynamicLoanwords(["สตรีมมิ่ง"], ["แอดมิน"]);
const b = getActiveLoanwords();
assert(!b.includes("แอดมิน"), "denylist removes a static word");
assert(b.includes("สตรีมมิ่ง"), "dynamic survives denylist of other word");

// loanwordSpans reflects dynamic words
setDynamicLoanwords(["สตรีมมิ่ง"], []);
const spans = loanwordSpans("วันนี้ดูสตรีมมิ่งสนุก");
assert(spans.some((s) => "วันนี้ดูสตรีมมิ่งสนุก".slice(s.start, s.end) === "สตรีมมิ่ง"), "loanwordSpans uses dynamic words");

setDynamicLoanwords([], []); // reset
console.log(`\n${passed} checks passed`);
