//   npx tsx scripts/verify-heygen-own-avatars.ts
import {
  flattenOwnAvatars,
  getHeyGenOwnAvatars,
  __clearOwnAvatarCache,
  type RawGroup,
  type RawLook,
} from "../src/lib/heygen-own-avatars";
import { HeyGenAuthError } from "../src/lib/heygen-avatars";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const groups: RawGroup[] = [
  { id: "g1", name: "Mew", group_type: "PHOTO" },
  { id: "g2", name: "Emma", group_type: "PHOTO" },
  { id: "g3", name: "  ", group_type: "PRIVATE" }, // blank name → fallback label
];
const looksByGroup: Record<string, RawLook[]> = {
  g1: [
    { id: "m1", image_url: "u1", status: "completed" },
    { id: "m2", image_url: "u2", status: "training" },   // skipped (not completed)
    { id: "m3", image_url: "u3" },                        // no status → kept
  ],
  g2: [{ id: "e1", image_url: "eu1", status: "COMPLETED" }], // case-insensitive
  g3: [{ image_url: "x", status: "completed" }],             // no id → skipped
};

// ── flattenOwnAvatars (pure) ──
const flat = flattenOwnAvatars(groups, looksByGroup);
assert(flat.map(a => a.avatar_id).join(",") === "m1,m3,e1", "keeps completed/no-status looks with an id, group then look order");
assert(flat.every(a => a.avatar_name !== "" ), "every avatar has a name");
assert(flat.find(a => a.avatar_id === "m1")!.avatar_name === "Mew", "look inherits its group name");
assert(flat.find(a => a.avatar_id === "e1")!.avatar_name === "Emma", "case-insensitive 'COMPLETED' kept");
assert(!flat.some(a => a.avatar_id === "m2"), "explicit non-completed (training) look is skipped");
assert(flattenOwnAvatars([], {}).length === 0, "empty groups → empty");
assert(flattenOwnAvatars([{ id: "gz", name: "Z" }], {}).length === 0, "group with no looks → contributes nothing");

async function main() {
  // ── getHeyGenOwnAvatars: fan-out + cache ──
  __clearOwnAvatarCache();
  let gCalls = 0, lCalls = 0;
  const fetchGroups = async () => { gCalls++; return groups; };
  const fetchLooks = async (gid: string) => { lCalls++; return looksByGroup[gid] ?? []; };
  const r1 = await getHeyGenOwnAvatars("u1", "key-AAAAAA", { fetchGroups, fetchLooks, now: 0 });
  assert(r1.avatars.length === 3 && gCalls === 1 && lCalls === 3, "fetches group list once + looks per group (fan-out)");

  // cached within TTL → no refetch
  const r2 = await getHeyGenOwnAvatars("u1", "key-AAAAAA", { fetchGroups, fetchLooks, now: 1000 });
  assert(r2.avatars.length === 3 && gCalls === 1 && lCalls === 3, "cached within TTL → no refetch");

  // refresh bypasses cache
  await getHeyGenOwnAvatars("u1", "key-AAAAAA", { fetchGroups, fetchLooks, now: 2000, refresh: true });
  assert(gCalls === 2, "refresh=true forces a refetch");

  // ── one group's look-fetch failing is tolerated (that group drops, others survive) ──
  __clearOwnAvatarCache();
  const flakyLooks = async (gid: string) => { if (gid === "g1") throw new Error("HeyGen blip"); return looksByGroup[gid] ?? []; };
  const r3 = await getHeyGenOwnAvatars("u3", "key-CCCCCC", { fetchGroups: async () => groups, fetchLooks: flakyLooks, now: 0 });
  assert(r3.avatars.map(a => a.avatar_id).join(",") === "e1", "a group's look-fetch failing drops only that group, not all");

  // ── group-list auth error propagates (bad key must surface) ──
  __clearOwnAvatarCache();
  let threwAuth = false;
  try {
    await getHeyGenOwnAvatars("u4", "key-DDDDDD", { fetchGroups: async () => { throw new HeyGenAuthError(401); }, fetchLooks, now: 0 });
  } catch (e) { threwAuth = e instanceof HeyGenAuthError; }
  assert(threwAuth, "group-list HeyGenAuthError propagates (bad/expired key surfaces)");

  console.log(`\n✅ ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
