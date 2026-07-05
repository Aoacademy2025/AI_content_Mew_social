//   npx tsx scripts/verify-avatar-filter.ts
import { groupLooksByAvatar, type HeygenAvatar } from "../src/app/(dashboard)/video-editor/_v2/avatar-filter";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const A = (id: string, name: string): HeygenAvatar =>
  ({ avatar_id: id, avatar_name: name, preview_image_url: "" });

// "Mew" has 3 looks, interleaved with "Emma" — grouping must collect all Mew looks together
const list: HeygenAvatar[] = [
  A("m1", "Mew"), A("e1", "Emma"), A("m2", "Mew"), A("c1", "Cherry"), A("m3", "Mew"),
];

// empty query → one section per avatar, first-seen order, looks grouped
const all = groupLooksByAvatar(list, "");
assert(all.map(s => s.name).join(",") === "Mew,Emma,Cherry", "one section per avatar, first-seen order");
assert(all[0].looks.map(l => l.avatar_id).join(",") === "m1,m2,m3", "all of an avatar's looks grouped in look order");
assert(all[1].looks.length === 1 && all[2].looks.length === 1, "single-look avatars have one look");

// case-insensitive name search
const mew = groupLooksByAvatar(list, "MEW");
assert(mew.length === 1 && mew[0].name === "Mew" && mew[0].looks.length === 3, "'MEW' → only the Mew section with its 3 looks");

// whitespace query = no filter
assert(groupLooksByAvatar(list, "   ").length === 3, "whitespace query = no filter");

// no match → empty
assert(groupLooksByAvatar(list, "zzz").length === 0, "no match → no sections");

// empty list → empty
assert(groupLooksByAvatar([], "x").length === 0, "empty list → empty");

console.log(`\n${passed} checks passed`);
