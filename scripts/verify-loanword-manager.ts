//   npx tsx scripts/verify-loanword-manager.ts
import { denyWord, restoreWord, addWord, editWord } from "../src/lib/thai-loanwords-runtime";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const base = { words: ["แคปชัน", "คอมมูฯ"], denylist: ["ผิด"] };

// deny: word leaves `words`, joins denylist
let s = denyWord(base, "คอมมูฯ");
assert(!s.words.includes("คอมมูฯ") && s.denylist.includes("คอมมูฯ"), "deny moves word → denylist");
assert(denyWord(base, "คอมมูฯ").denylist.filter((w) => w === "คอมมูฯ").length === 1, "deny does not duplicate");

// restore: word leaves denylist
s = restoreWord(base, "ผิด");
assert(!s.denylist.includes("ผิด"), "restore removes from denylist");

// add: into words, and unblock if it was denied
s = addWord(base, "คริปโต");
assert(s.words.includes("คริปโต"), "add inserts new word");
assert(addWord(base, "แคปชัน").words.filter((w) => w === "แคปชัน").length === 1, "add does not duplicate existing");
s = addWord({ words: [], denylist: ["เคยห้าม"] }, "เคยห้าม");
assert(s.words.includes("เคยห้าม") && !s.denylist.includes("เคยห้าม"), "add unblocks a denylisted word");

// edit: replace spelling in words
s = editWord(base, "คอมมูฯ", "คอมมูนิตี้");
assert(!s.words.includes("คอมมูฯ") && s.words.includes("คอมมูนิตี้"), "edit swaps old → new");

console.log(`\n${passed} checks passed`);
