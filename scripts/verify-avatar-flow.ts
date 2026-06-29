// Run: npx tsx scripts/verify-avatar-flow.ts
// Locks the editor's avatar-flow decisions (preset clobber guard + pause-for-positioning).
import { shouldApplyLoadedPreset } from "../src/lib/avatar-flow";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: false }) === true, "fresh avatar, untouched → apply preset");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "a", userTouched: false }) === false, "already loaded this avatar → do not re-apply");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: true }) === false, "user already edited → do not clobber");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "b", userTouched: false }) === true, "switched to new avatar → apply its preset");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "", userTouched: false }) === false, "no avatar id → no-op");

console.log(`\n✅ ALL ${p} AVATAR-FLOW CHECKS PASSED`);
