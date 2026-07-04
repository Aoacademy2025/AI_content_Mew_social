//   npx tsx scripts/verify-avatar-filter.ts
import { partitionAvatars, type HeygenAvatar } from "../src/app/(dashboard)/video-editor/_v2/avatar-filter";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const A = (id: string, name: string, pub: boolean): HeygenAvatar =>
  ({ avatar_id: id, avatar_name: name, preview_image_url: "", gender: "unknown", is_public: pub });

const list: HeygenAvatar[] = [
  A("own1", "My Presenter", false),
  A("pub1", "HeyGen Anna", true),
  A("own2", "Studio Mew", false),
  A("pub2", "HeyGen Public Bob", true),
];

// empty query → split by is_public, input order preserved
const all = partitionAvatars(list, "");
assert(all.own.length === 2 && all.own[0].avatar_id === "own1" && all.own[1].avatar_id === "own2", "own = non-public, input order");
assert(all.publicOnes.length === 2 && all.publicOnes[0].avatar_id === "pub1", "publicOnes = public, input order");

// search filters across both sections, case-insensitive substring on name
const mew = partitionAvatars(list, "mew");
assert(mew.own.length === 1 && mew.own[0].avatar_id === "own2", "'mew' matches own 'Studio Mew'");
assert(mew.publicOnes.length === 0, "'mew' matches no public");

const heygen = partitionAvatars(list, "HEYGEN");
assert(heygen.own.length === 0 && heygen.publicOnes.length === 2, "'HEYGEN' (upper) matches both public");

// whitespace-only query behaves like empty
const ws = partitionAvatars(list, "   ");
assert(ws.own.length === 2 && ws.publicOnes.length === 2, "whitespace query = no filter");

// no match → both empty, never throws
const none = partitionAvatars(list, "zzz-nope");
assert(none.own.length === 0 && none.publicOnes.length === 0, "no match → empty");

// empty list → empty result
const e = partitionAvatars([], "x");
assert(e.own.length === 0 && e.publicOnes.length === 0, "empty list → empty");

console.log(`\n${passed} checks passed`);
