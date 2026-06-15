//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-store.ts
import { parseLoanwordStore, mergeStore } from "../src/lib/thai-loanwords-runtime";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

assert(parseLoanwordStore(null).words.length === 0, "null → empty store");
assert(parseLoanwordStore("not json").denylist.length === 0, "bad json → empty store (fail-open)");
const s = parseLoanwordStore(JSON.stringify({ words: ["ไอเดีย"], denylist: ["x"], lastRunAt: "t" }));
assert(s.words[0] === "ไอเดีย" && s.denylist[0] === "x", "parses valid store");

const merged = mergeStore({ words: ["ไอเดีย"], denylist: [] }, ["ไอเดีย", "ครีเอเตอร์"]);
assert(merged.words.length === 2 && merged.words.includes("ครีเอเตอร์"), "mergeStore adds new, dedupes existing");

console.log(`\n${passed} checks passed`);
