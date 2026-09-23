//   npx tsx scripts/verify-heygen-own-avatars.ts
import {
  flattenOwnAvatars,
  getHeyGenOwnAvatars,
  parseOwnAvatarLookPage,
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

// ── v3 private-look contract: completed-only + explicit per-look engines ──
const v3 = parseOwnAvatarLookPage({
  data: [
    { id: "iv", name: "IV", group_id: "g1", status: "completed", preview_image_url: "iv.jpg", supported_api_engines: ["avatar_iii", "avatar_iv"] },
    { id: "v", name: "V", group_id: "g2", status: "completed", preview_image_url: "v.jpg", supported_api_engines: ["avatar_iv", "avatar_v", "future_engine"] },
    { id: "training", name: "Training", status: "processing", supported_api_engines: ["avatar_iv"] },
  ],
  has_more: true,
  next_token: "opaque-next",
});
assert(v3.avatars.map((a) => a.avatar_id).join(",") === "iv,v", "v3 keeps only completed private looks");
assert(v3.avatars[0]?.supported_api_engines.join(",") === "avatar_iii,avatar_iv", "v3 preserves supported III/IV engines");
assert(v3.avatars[1]?.supported_api_engines.join(",") === "avatar_iv,avatar_v", "v3 drops unknown engine names without guessing");
assert(v3.nextToken === "opaque-next", "v3 preserves the opaque pagination cursor");

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

  // ── production v3 loader follows opaque cursors and never merges key rotations ──
  __clearOwnAvatarCache();
  const seenTokens: Array<string | undefined> = [];
  const paged = await getHeyGenOwnAvatars("u-pages", "key-pages", {
    fetchPage: async (_key, token) => {
      seenTokens.push(token);
      return token === undefined
        ? parseOwnAvatarLookPage({
            data: [{ id: "page-1", name: "One", status: "completed", supported_api_engines: ["avatar_iv"] }],
            has_more: true,
            next_token: "opaque-page-2",
          })
        : parseOwnAvatarLookPage({
            data: [{ id: "page-2", name: "Two", status: "completed", supported_api_engines: ["avatar_v"] }],
            has_more: false,
          });
    },
  });
  assert(seenTokens.length === 2 && seenTokens[1] === "opaque-page-2", "v3 loader follows next_token until has_more is false");
  assert(paged.avatars.map((avatar) => avatar.avatar_id).join(",") === "page-1,page-2", "v3 loader combines private look pages in order");

  __clearOwnAvatarCache();
  const rotatedA = await getHeyGenOwnAvatars("u-rotation", "first-key-SAME99", {
    fetchPage: async () => parseOwnAvatarLookPage({ data: [{ id: "first", status: "completed", supported_api_engines: ["avatar_iii"] }] }),
  });
  const rotatedB = await getHeyGenOwnAvatars("u-rotation", "second-key-SAME99", {
    fetchPage: async () => parseOwnAvatarLookPage({ data: [{ id: "second", status: "completed", supported_api_engines: ["avatar_iv"] }] }),
  });
  assert(rotatedA.avatars[0]?.avatar_id === "first" && rotatedB.avatars[0]?.avatar_id === "second", "cache ownership includes the full credential identity across key rotation");

  console.log(`\n✅ ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
