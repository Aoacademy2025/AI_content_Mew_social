// Run: npx tsx scripts/verify-avatar-flow.ts
// Locks the editor's avatar-flow decisions (preset clobber guard + pause-for-positioning).
import { shouldApplyLoadedPreset, shouldPauseForPositioning } from "../src/lib/avatar-flow";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: false }) === true, "fresh avatar, untouched → apply preset");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "a", userTouched: false }) === false, "already loaded this avatar → do not re-apply");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: true }) === false, "user already edited → do not clobber");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "b", userTouched: false }) === true, "switched to new avatar → apply its preset");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "", userTouched: false }) === false, "no avatar id → no-op");
ok(shouldPauseForPositioning({ useAvatar: true, isDirect: false, hasSavedPreset: false }) === true, "avatar + no preset → pause for positioning");
ok(shouldPauseForPositioning({ useAvatar: true, isDirect: false, hasSavedPreset: true }) === false, "avatar + saved preset → no pause (auto)");
ok(shouldPauseForPositioning({ useAvatar: false, isDirect: false, hasSavedPreset: false }) === false, "no avatar → no pause");
ok(shouldPauseForPositioning({ useAvatar: true, isDirect: true, hasSavedPreset: false }) === false, "direct-url avatar → no pause (no gen framing)");

console.log(`\n✅ ALL ${p} AVATAR-FLOW CHECKS PASSED`);
