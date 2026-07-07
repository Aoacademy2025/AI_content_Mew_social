// Human-gated compound review store mutations (Part 2). Mined candidates land in
// pendingCompounds (never merged); admin approve → compounds (live merge), reject →
// denylist. parseLoanwordStore round-trips the new fields, fail-open on old/bad JSON.
//   npx tsx scripts/verify-compound-review.ts
import { parseLoanwordStore, addPendingCompounds, approveCompound, rejectCompound, type LoanwordStore } from "../src/lib/thai-loanwords-runtime";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// parse: new fields round-trip; legacy JSON (no compound fields) fails open to []
const parsed = parseLoanwordStore(JSON.stringify({ words: ["แคปชัน"], denylist: ["x"], compounds: ["ขี้เกียจ"], pendingCompounds: ["เวลางาน"] }));
assert(parsed.compounds?.[0] === "ขี้เกียจ" && parsed.pendingCompounds?.[0] === "เวลางาน", "parses compounds + pendingCompounds");
const legacy = parseLoanwordStore(JSON.stringify({ words: ["แคปชัน"], denylist: [] }));
assert((legacy.compounds ?? []).length === 0 && (legacy.pendingCompounds ?? []).length === 0, "legacy store → empty compound fields (fail-open)");

const base: LoanwordStore = { words: ["แคปชัน"], denylist: ["เคยห้าม"], compounds: ["ขี้เกียจ"], pendingCompounds: ["เวลางาน"] };

// addPendingCompounds: appends new, dedups against words/compounds/denylist/pending
let s = addPendingCompounds(base, ["มืออาชีพ", "เวลางาน", "ขี้เกียจ", "แคปชัน", "เคยห้าม"]);
assert(s.pendingCompounds!.includes("มืออาชีพ"), "addPendingCompounds adds a genuinely new candidate");
assert(s.pendingCompounds!.filter((w) => w === "เวลางาน").length === 1, "does not duplicate an existing pending word");
assert(!s.pendingCompounds!.includes("ขี้เกียจ"), "does not re-suggest an already-approved compound");
assert(!s.pendingCompounds!.includes("แคปชัน"), "does not re-suggest a known loanword");
assert(!s.pendingCompounds!.includes("เคยห้าม"), "does not re-suggest a denylisted word");

// approveCompound: pending → compounds; unblocks denylist; clears from pending
s = approveCompound({ words: [], denylist: ["เวลางาน"], compounds: [], pendingCompounds: ["เวลางาน", "มือใหม่"] }, "เวลางาน");
assert(s.compounds!.includes("เวลางาน"), "approve moves candidate into live compounds");
assert(!s.pendingCompounds!.includes("เวลางาน"), "approve removes candidate from pending");
assert(!s.denylist.includes("เวลางาน"), "approve unblocks a previously denied word");
assert(s.pendingCompounds!.includes("มือใหม่"), "approve leaves other pending untouched");
assert(approveCompound(s, "เวลางาน").compounds!.filter((w) => w === "เวลางาน").length === 1, "approve does not duplicate");

// rejectCompound: drop from pending + compounds; add to denylist (blocks merge + re-suggest)
s = rejectCompound({ words: [], denylist: [], compounds: ["ปากหวาน"], pendingCompounds: ["ปากหวาน", "คนดี"] }, "ปากหวาน");
assert(!s.pendingCompounds!.includes("ปากหวาน"), "reject removes from pending");
assert(!s.compounds!.includes("ปากหวาน"), "reject removes from live compounds too");
assert(s.denylist.includes("ปากหวาน"), "reject adds to denylist (never merged/re-suggested)");
assert(s.pendingCompounds!.includes("คนดี"), "reject leaves other pending untouched");
assert(rejectCompound(s, "ปากหวาน").denylist.filter((w) => w === "ปากหวาน").length === 1, "reject does not duplicate denylist");

console.log(`\n${passed} checks passed`);
