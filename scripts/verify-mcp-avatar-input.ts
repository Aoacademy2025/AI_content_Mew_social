// Pure gating for avatar in create_video_job: mode validation, key/avatar requirements,
// avatarId resolution (arg → user default), and intro/tail clamps.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-avatar-input.ts
import { resolveAvatarRequest, clampSecs } from "../src/lib/mcp/avatar-steps";
import { resolveAvatarLayout, DEFAULT_AVATAR_LAYOUT } from "../src/lib/avatar-preset";

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

// --- resolveAvatarLayout ---
const presetA = { scale: 1.5, offsetX: 0.3, offsetY: -0.2 };

// (a) explicit layout passes through (ignores preset)
const explicitLayout = resolveAvatarLayout({ avatarScale: 1.2, avatarOffsetX: 0.5, avatarOffsetY: 0.1 }, presetA);
assert(explicitLayout.scale === 1.2 && explicitLayout.offsetX === 0.5 && explicitLayout.offsetY === 0.1, "resolveAvatarLayout: explicit args win over preset");

// (b) no explicit + preset → preset values returned
const fromPreset = resolveAvatarLayout({}, presetA);
assert(fromPreset.scale === 1.5 && fromPreset.offsetX === 0.3 && fromPreset.offsetY === -0.2, "resolveAvatarLayout: no args + preset → preset");

// (c) no explicit + null preset → DEFAULT_AVATAR_LAYOUT
const fromDefault = resolveAvatarLayout({}, null);
assert(fromDefault.scale === DEFAULT_AVATAR_LAYOUT.scale && fromDefault.offsetX === DEFAULT_AVATAR_LAYOUT.offsetX && fromDefault.offsetY === DEFAULT_AVATAR_LAYOUT.offsetY, "resolveAvatarLayout: no args + no preset → DEFAULT_AVATAR_LAYOUT");

// partial explicit: only scale set → scale wins, offsetX/Y come from preset (not zeroed)
const partialExplicit = resolveAvatarLayout({ avatarScale: 1.8 }, presetA);
assert(partialExplicit.scale === 1.8 && partialExplicit.offsetX === 0.3 && partialExplicit.offsetY === -0.2, "resolveAvatarLayout: partial explicit (only scale) → scale wins, other axes from preset");

// explicit 0 for offsetX — must NOT fall through to preset (0 != null, so 0 wins)
const zeroOffset = resolveAvatarLayout({ avatarOffsetX: 0 }, { scale: 1.5, offsetX: 99, offsetY: 99 });
assert(zeroOffset.scale === 1.5 && zeroOffset.offsetX === 0 && zeroOffset.offsetY === 99, "resolveAvatarLayout: explicit 0 wins for offsetX (!=null check); scale+Y from preset");

console.log(`\n${passed} assertions passed ✅`);
