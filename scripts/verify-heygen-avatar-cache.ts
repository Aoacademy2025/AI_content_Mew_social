// Proof of the HeyGen avatar-list cache contract: cache successes (fast repeat lookups), NEVER
// cache failures (so the reload button retries), bust on key change / TTL / refresh. Pure logic:
//   npx tsx scripts/verify-heygen-avatar-cache.ts
import {
  getHeyGenAvatarList,
  HeyGenAuthError,
  HEYGEN_AVATAR_TTL_MS,
  __clearHeyGenAvatarCache,
  type HeyGenAvatarList,
} from "../src/lib/heygen-avatars";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const LIST: HeyGenAvatarList = { avatars: [{ avatar_id: "a1", avatar_name: "A1" }], talkingPhotos: [] };

async function main() {
  // 1) Success is cached → second call (same user+key) does NOT re-fetch
  __clearHeyGenAvatarCache();
  let calls = 0;
  const ok = async () => { calls++; return LIST; };
  const r1 = await getHeyGenAvatarList("u1", "key-AAAAAA", { fetcher: ok, now: 0 });
  await getHeyGenAvatarList("u1", "key-AAAAAA", { fetcher: ok, now: 1000 });
  assert(calls === 1, "success cached → 2nd call within TTL does not re-fetch");
  assert(r1.avatars[0].avatar_id === "a1", "returns the fetched list");

  // 2) refresh=true bypasses the cache
  await getHeyGenAvatarList("u1", "key-AAAAAA", { fetcher: ok, now: 2000, refresh: true });
  assert(calls === 2, "refresh=true forces a re-fetch (reload button)");

  // 3) Failure is NOT cached → next call retries (this is the whole point: reload must work)
  __clearHeyGenAvatarCache();
  let calls2 = 0;
  const flaky = async () => { calls2++; if (calls2 === 1) throw new Error("HeyGen slow"); return LIST; };
  let threw = false;
  try { await getHeyGenAvatarList("u2", "key-BBBBBB", { fetcher: flaky, now: 0 }); } catch { threw = true; }
  assert(threw, "fetch failure propagates to caller (route degrades to unverified)");
  const r3 = await getHeyGenAvatarList("u2", "key-BBBBBB", { fetcher: flaky, now: 10 });
  assert(calls2 === 2 && r3.avatars.length === 1, "failure was NOT cached → next call re-fetches and succeeds");

  // 4) Different key fingerprint → separate cache entry (rotating key busts cache)
  __clearHeyGenAvatarCache();
  let calls3 = 0;
  const ok3 = async () => { calls3++; return LIST; };
  await getHeyGenAvatarList("u3", "key-OLD111", { fetcher: ok3, now: 0 });
  await getHeyGenAvatarList("u3", "key-NEW222", { fetcher: ok3, now: 0 });
  assert(calls3 === 2, "different heygenKey → cache miss (no stale list after key rotation)");

  // 5) TTL expiry → re-fetch after the window
  __clearHeyGenAvatarCache();
  let calls4 = 0;
  const ok4 = async () => { calls4++; return LIST; };
  await getHeyGenAvatarList("u4", "key-CCCCCC", { fetcher: ok4, now: 0 });
  await getHeyGenAvatarList("u4", "key-CCCCCC", { fetcher: ok4, now: HEYGEN_AVATAR_TTL_MS - 1 });
  assert(calls4 === 1, "within TTL → still cached");
  await getHeyGenAvatarList("u4", "key-CCCCCC", { fetcher: ok4, now: HEYGEN_AVATAR_TTL_MS + 1 });
  assert(calls4 === 2, "after TTL → re-fetches");

  // 6) Auth error propagates and is not cached
  __clearHeyGenAvatarCache();
  let calls5 = 0;
  const auth = async () => { calls5++; throw new HeyGenAuthError(401); };
  let authThrew = false;
  try { await getHeyGenAvatarList("u5", "key-DDDDDD", { fetcher: auth, now: 0 }); }
  catch (e) { authThrew = e instanceof HeyGenAuthError; }
  assert(authThrew, "HeyGenAuthError propagates (route returns the key error)");
  try { await getHeyGenAvatarList("u5", "key-DDDDDD", { fetcher: auth, now: 0 }); } catch { /* expected */ }
  assert(calls5 === 2, "auth error not cached");

  console.log(`\n✅ ALL ${passed} HEYGEN AVATAR-CACHE CHECKS PASSED`);
}
main().catch((e) => { console.error(e); process.exit(1); });
