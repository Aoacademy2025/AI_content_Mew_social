// Run: npx tsx scripts/verify-heygen-avatar-details.ts
// Proves the single-avatar lookup contract: GET /v2/avatar/{id}/details (fast, no full list),
// fall back to /v2/photo_avatar/{id}, auth errors surface, not-found → null (route degrades).
import { getHeyGenAvatarDetails, HeyGenAuthError } from "../src/lib/heygen-avatars";

let p = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; }

async function main() {
  // 1) standard avatar found on /v2/avatar/{id}/details (first URL)
  const calls1: string[] = [];
  const ok = async (url: string) => {
    calls1.push(url);
    return { status: 200, ok: true, data: { name: "Mew Social", preview_image_url: "IMG", preview_video_url: "VID" } };
  };
  const r1 = await getHeyGenAvatarDetails("av1", "key", { fetcher: ok });
  assert(!!r1 && r1.name === "Mew Social" && r1.previewImageUrl === "IMG" && r1.previewVideoUrl === "VID", "avatar details → name + preview image/video");
  assert(calls1.length === 1 && calls1[0].includes("/v2/avatar/av1/details"), "hits /v2/avatar/{id}/details first (single, not the full list)");

  // 2) auth error (401/403) surfaces as HeyGenAuthError
  const auth = async () => ({ status: 401, ok: false, data: null });
  let threw = false;
  try { await getHeyGenAvatarDetails("av2", "key", { fetcher: auth }); } catch (e) { threw = e instanceof HeyGenAuthError; }
  assert(threw, "401/403 → HeyGenAuthError (bad/expired key surfaces)");

  // 3) 404 on avatar → falls back to /v2/photo_avatar/{id}; found there
  const calls3: string[] = [];
  const photo = async (url: string) => {
    calls3.push(url);
    if (url.includes("/v2/avatar/")) return { status: 404, ok: false, data: null };
    return { status: 200, ok: true, data: { name: "Emmie Photo", preview_image_url: "PIMG", preview_video_url: "" } };
  };
  const r3 = await getHeyGenAvatarDetails("av3", "key", { fetcher: photo });
  assert(!!r3 && r3.name === "Emmie Photo" && r3.previewImageUrl === "PIMG", "404 on avatar → photo_avatar fallback returns the photo details");
  assert(calls3.length === 2 && calls3[1].includes("/v2/photo_avatar/av3"), "fallback hits /v2/photo_avatar/{id}");

  // 4) 404 on BOTH → null (route degrades to unverified, still renderable)
  const none = async () => ({ status: 404, ok: false, data: null });
  const r4 = await getHeyGenAvatarDetails("av4", "key", { fetcher: none });
  assert(r4 === null, "not found in either → null (caller degrades to unverified, not a hard block)");

  // 5) talking_photo_name field is honoured for naming
  const tp = async (url: string) => url.includes("/v2/avatar/")
    ? { status: 404, ok: false, data: null }
    : { status: 200, ok: true, data: { talking_photo_name: "TP Name", preview_image_url: "TPIMG" } };
  const r5 = await getHeyGenAvatarDetails("av5", "key", { fetcher: tp });
  assert(!!r5 && r5.name === "TP Name", "talking_photo_name used when name/avatar_name absent");

  console.log(`\n✅ ALL ${p} HEYGEN AVATAR-DETAILS CHECKS PASSED`);
}
main().catch((e) => { console.error(e); process.exit(1); });
