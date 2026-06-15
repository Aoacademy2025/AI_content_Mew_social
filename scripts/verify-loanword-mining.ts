//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-loanword-mining.ts
import { mineLoanwords } from "../src/lib/loanword-mining";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// tiny dict containing a loanword (ไอเดีย) + native words; ICU splits ไอเดีย => ไอ|เดีย
const dict = new Set(["ไอเดีย", "วันนี้", "ดี", "มาก", "ที่", "ไม่"]);
const scripts = ["วันนี้ไอเดียดีมาก", "ไอเดียนี้ดี"]; // ไอเดีย appears in both

const res = mineLoanwords(scripts, dict, new Set(), { minLen: 4, cap: 25 });
assert(res.some((r) => r.word === "ไอเดีย"), "detects loanword ไอเดีย (gibberish ICU fragment)");
assert(!res.some((r) => r.word === "วันนี้"), "skips native compound (fragments are dict words)");
assert(res.find((r) => r.word === "ไอเดีย")!.count === 2, "frequency counts distinct scripts");

// already-known words are excluded
const res2 = mineLoanwords(scripts, dict, new Set(["ไอเดีย"]), { minLen: 4, cap: 25 });
assert(!res2.some((r) => r.word === "ไอเดีย"), "excludes already-known words");

// cap limits output
const many = new Set(["ไอเดีย", "ครีเอเตอร์", "ซีรีส์"]);
const scriptsMany = ["ไอเดียครีเอเตอร์ซีรีส์"];
assert(mineLoanwords(scriptsMany, many, new Set(), { minLen: 4, cap: 1 }).length <= 1, "cap limits results");

console.log(`\n${passed} checks passed`);
