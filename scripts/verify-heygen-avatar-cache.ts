// Proof of the HeyGen avatar-list cache contract: cache successes (fast repeat lookups), NEVER
// cache failures (so the reload button retries), bust on key change / TTL / refresh. Pure logic:
//   npx tsx scripts/verify-heygen-avatar-cache.ts
import {
  getHeyGenAvatarList,
  HeyGenAuthError,
  HEYGEN_AVATAR_TTL_MS,
  HEYGEN_STALE_MAX_MS,
  serializeStale,
  parseStale,
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

  // 7) Success persists to the durable store (saveStale) so it survives process restart
  __clearHeyGenAvatarCache();
  const saved: Array<{ userId: string; key: string; data: HeyGenAvatarList }> = [];
  const saveStale = async (userId: string, key: string, data: HeyGenAvatarList) => { saved.push({ userId, key, data }); };
  const r7 = await getHeyGenAvatarList("u7", "key-EEEEEE", { fetcher: async () => LIST, now: 0, saveStale });
  assert(saved.length === 1 && saved[0].userId === "u7" && saved[0].data.avatars[0].avatar_id === "a1", "success persists list via saveStale");
  assert(!r7.stale, "fresh fetch is NOT marked stale");

  // 8) Fetch fails (non-auth) but durable stale exists → SERVE STALE (no throw), marked stale
  __clearHeyGenAvatarCache();
  const loadStale = async () => LIST;
  let r8: HeyGenAvatarList | null = null, threw8 = false;
  try { r8 = await getHeyGenAvatarList("u8", "key-FFFFFF", { fetcher: async () => { throw new Error("HeyGen slow"); }, now: 0, loadStale }); }
  catch { threw8 = true; }
  assert(!threw8 && !!r8 && r8.avatars[0].avatar_id === "a1", "fetch failure + durable stale → serves stale list (avatar picker/preview still resolves)");
  assert(r8?.stale === true, "served-stale result is flagged stale:true");

  // 9) Fetch fails AND no durable stale (loadStale → null) → still throws (degrade contract preserved)
  __clearHeyGenAvatarCache();
  let threw9 = false;
  try { await getHeyGenAvatarList("u9", "key-GGGGGG", { fetcher: async () => { throw new Error("HeyGen slow"); }, now: 0, loadStale: async () => null }); }
  catch { threw9 = true; }
  assert(threw9, "fetch failure + NO durable stale → propagates (route degrades to unverified)");

  // 10) Auth error (bad/expired key) NEVER serves stale — even if durable stale exists
  __clearHeyGenAvatarCache();
  let auth10: unknown = null;
  try { await getHeyGenAvatarList("u10", "key-HHHHHH", { fetcher: async () => { throw new HeyGenAuthError(401); }, now: 0, loadStale }); }
  catch (e) { auth10 = e; }
  assert(auth10 instanceof HeyGenAuthError, "auth error propagates even when durable stale exists (don't mask a bad key)");

  // 10b) Durable store itself erroring (DB hiccup) must NOT worsen the degrade path → still throws original
  __clearHeyGenAvatarCache();
  let threw10b = false;
  try {
    await getHeyGenAvatarList("u10b", "key-IIIIII", {
      fetcher: async () => { throw new Error("HeyGen slow"); },
      now: 0,
      loadStale: async () => { throw new Error("DB down"); },
    });
  } catch { threw10b = true; }
  assert(threw10b, "loadStale throwing (store error) still degrades to throw — durable store never worsens the path");

  // 11) Durable-store serialize/parse round-trips when the key fingerprint matches
  const blob = serializeStale("key-EEEEEE", LIST);
  const p11 = parseStale(blob, "key-EEEEEE", 1000, 1000 + HEYGEN_STALE_MAX_MS - 1);
  assert(!!p11 && p11.avatars[0].avatar_id === "a1" && p11.talkingPhotos.length === 0, "serializeStale → parseStale round-trips with matching key");

  // 12) Rotated key fingerprint → parseStale returns null (don't serve another key's avatars)
  assert(parseStale(blob, "key-ZZZZZZ", 1000, 2000) === null, "parseStale rejects a different key fingerprint (key rotation busts durable stale)");

  // 13) Too old (beyond HEYGEN_STALE_MAX_MS) → null
  assert(parseStale(blob, "key-EEEEEE", 1000, 1000 + HEYGEN_STALE_MAX_MS + 1) === null, "parseStale rejects a durable blob older than the max age");

  // 14) Malformed / empty durable blob → null (never crash the picker)
  assert(parseStale("{not json", "key-EEEEEE", 1000, 1000) === null, "parseStale returns null on malformed JSON");
  assert(parseStale(null, "key-EEEEEE", 1000, 1000) === null, "parseStale returns null on empty/missing blob");

  console.log(`\n✅ ALL ${passed} HEYGEN AVATAR-CACHE CHECKS PASSED`);
}
main().catch((e) => { console.error(e); process.exit(1); });
