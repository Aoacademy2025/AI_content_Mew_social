// Run: npx tsx scripts/verify-heygen-avatar-details.ts
// Proves the single-avatar lookup contract: GET /v3/avatars/looks/{id} first (HeyGen v1/v2
// sunset 2026-10-31), then the legacy /v2/avatar/{id}/details and /v2/photo_avatar/{id} for
// IDs v3 does not know. Auth errors from v3 surface; a retired v2 endpoint answering 401/403
// after v3 already accepted the key must NOT be reported as a bad key. Not found → null.
import { getHeyGenAvatarDetails, HeyGenAuthError } from "../src/lib/heygen-avatars";

let p = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; }

async function main() {
  // 1) look found on /v3/avatars/looks/{id} (first URL, single call)
  const calls1: string[] = [];
  const ok = async (url: string) => {
    calls1.push(url);
    return { status: 200, ok: true, data: { name: "Mew Social", preview_image_url: "IMG", preview_video_url: "VID" } };
  };
  const r1 = await getHeyGenAvatarDetails("av1", "key", { fetcher: ok });
  assert(!!r1 && r1.name === "Mew Social" && r1.previewImageUrl === "IMG" && r1.previewVideoUrl === "VID", "avatar details → name + preview image/video");
  assert(calls1.length === 1 && calls1[0].includes("/v3/avatars/looks/av1"), "hits /v3/avatars/looks/{id} first (no v2 call when v3 answers)");

  // 2) auth error on v3 surfaces as HeyGenAuthError without touching v2
  const calls2: string[] = [];
  const auth = async (url: string) => { calls2.push(url); return { status: 401, ok: false, data: null }; };
  let threw = false;
  try { await getHeyGenAvatarDetails("av2", "key", { fetcher: auth }); } catch (e) { threw = e instanceof HeyGenAuthError; }
  assert(threw, "401/403 from v3 → HeyGenAuthError (bad/expired key surfaces)");
  assert(calls2.length === 1, "a rejected key stops at v3");

  // 3) v3 404 → legacy /v2/avatar/{id}/details; found there
  const calls3: string[] = [];
  const legacy = async (url: string) => {
    calls3.push(url);
    if (url.includes("/v3/")) return { status: 404, ok: false, data: null };
    return { status: 200, ok: true, data: { name: "Legacy Avatar", preview_image_url: "LIMG", preview_video_url: "" } };
  };
  const r3 = await getHeyGenAvatarDetails("av3", "key", { fetcher: legacy });
  assert(!!r3 && r3.name === "Legacy Avatar" && r3.previewImageUrl === "LIMG", "v3 404 → v2 avatar details fallback");
  assert(calls3.length === 2 && calls3[1].includes("/v2/avatar/av3/details"), "fallback hits /v2/avatar/{id}/details second");

  // 4) v3 404, v2 avatar 404 → /v2/photo_avatar/{id}
  const calls4: string[] = [];
  const photo = async (url: string) => {
    calls4.push(url);
    if (!url.includes("/v2/photo_avatar/")) return { status: 404, ok: false, data: null };
    return { status: 200, ok: true, data: { name: "Emmie Photo", preview_image_url: "PIMG", preview_video_url: "" } };
  };
  const r4 = await getHeyGenAvatarDetails("av4", "key", { fetcher: photo });
  assert(!!r4 && r4.name === "Emmie Photo" && r4.previewImageUrl === "PIMG", "photo_avatar fallback returns the photo details");
  assert(calls4.length === 3 && calls4[2].includes("/v2/photo_avatar/av4"), "photo fallback is the last call");

  // 5) 404 everywhere → null (route degrades to unverified, still renderable)
  const none = async () => ({ status: 404, ok: false, data: null });
  assert((await getHeyGenAvatarDetails("av5", "key", { fetcher: none })) === null, "not found anywhere → null");

  // 6) v1/v2 sunset: v3 accepted the key (404) but the retired v2 endpoints answer 401/403
  const sunset = async (url: string) => url.includes("/v3/")
    ? { status: 404, ok: false, data: null }
    : { status: 403, ok: false, data: null };
  let sunsetThrew = false;
  let r6: unknown = "unset";
  try { r6 = await getHeyGenAvatarDetails("av6", "key", { fetcher: sunset }); } catch { sunsetThrew = true; }
  assert(!sunsetThrew && r6 === null, "retired v2 401/403 after v3 accepted the key → null, not a bad-key error");

  // 7) talking_photo_name field is honoured for naming
  const tp = async (url: string) => url.includes("/v2/photo_avatar/")
    ? { status: 200, ok: true, data: { talking_photo_name: "TP Name", preview_image_url: "TPIMG" } }
    : { status: 404, ok: false, data: null };
  const r7 = await getHeyGenAvatarDetails("av7", "key", { fetcher: tp });
  assert(!!r7 && r7.name === "TP Name", "talking_photo_name used when name/avatar_name absent");

  console.log(`\n✅ ALL ${p} HEYGEN AVATAR-DETAILS CHECKS PASSED`);
}
main().catch((e) => { console.error(e); process.exit(1); });
