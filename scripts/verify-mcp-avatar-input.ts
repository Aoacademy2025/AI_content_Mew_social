// Pure gating for avatar in create_video_job: mode validation, key/avatar requirements,
// avatarId resolution (arg → user default), and intro/tail clamps.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-avatar-input.ts
import { resolveAvatarRequest, clampSecs } from "../src/lib/mcp/avatar-steps";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

const withKey = { heygenKey: "k", heygenAvatarId: "saved-av" };
const noKey = { heygenKey: null, heygenAvatarId: "saved-av" };

assert(resolveAvatarRequest({}, withKey).kind === "none", "no avatarMode → none");
assert(resolveAvatarRequest({ avatarMode: "none" }, withKey).kind === "none", "avatarMode none → none");

const bad = resolveAvatarRequest({ avatarMode: "weird" }, withKey);
assert(bad.kind === "error" && bad.payload.error === "bad_request", "invalid avatarMode → bad_request");

const nok = resolveAvatarRequest({ avatarMode: "full" }, noKey);
assert(nok.kind === "error" && nok.payload.error === "missing_key", "full without heygenKey → missing_key");

const noav = resolveAvatarRequest({ avatarMode: "full" }, { heygenKey: "k", heygenAvatarId: null });
assert(noav.kind === "error" && noav.payload.error === "missing_avatar", "no avatarId anywhere → missing_avatar");

const useSaved = resolveAvatarRequest({ avatarMode: "bookend" }, withKey);
assert(useSaved.kind === "ok" && useSaved.avatarId === "saved-av" && useSaved.avatarMode === "bookend", "falls back to user.heygenAvatarId");

const override = resolveAvatarRequest({ avatarMode: "full", avatarId: "arg-av" }, withKey);
assert(override.kind === "ok" && override.avatarId === "arg-av", "arg avatarId overrides saved");

const secs = resolveAvatarRequest({ avatarMode: "bookend-both", avatarIntroSecs: 0, avatarTailSecs: 999 }, withKey);
assert(secs.kind === "ok" && secs.introSecs === 1 && secs.tailSecs === 30, "intro/tail secs clamped to 1..30");

const def = resolveAvatarRequest({ avatarMode: "bookend-both" }, withKey);
assert(def.kind === "ok" && def.introSecs === 5 && def.tailSecs === 5, "intro/tail default to 5");

assert(clampSecs(undefined, 5) === 5 && clampSecs(0, 5) === 1 && clampSecs(100, 5) === 30 && clampSecs(7, 5) === 7, "clampSecs behaves");

const lay = resolveAvatarRequest({ avatarMode: "full" }, withKey);
assert(lay.kind === "ok" && lay.scale === 1 && lay.offsetX === 0 && lay.offsetY === 0, "default composite layer = scale 1 / 0 / 0");
const lay2 = resolveAvatarRequest({ avatarMode: "full", avatarScale: 1.4, avatarOffsetY: 0.2, avatarOffsetX: 9 }, withKey);
assert(lay2.kind === "ok" && lay2.scale === 1.4 && lay2.offsetY === 0.2 && lay2.offsetX === 2, "scale/offset accepted + clamped (offsetX 9→2)");

console.log(`\n${passed} assertions passed ✅`);
