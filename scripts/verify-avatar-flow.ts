// Run: npx tsx scripts/verify-avatar-flow.ts
// Locks the editor's avatar-flow decisions (preset clobber guard + the gen-vs-composite
// signature that stops position tweaks from re-paying HeyGen).
import { shouldApplyLoadedPreset, avatarGenSignature, nextAvatarAction } from "../src/lib/avatar-flow";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: false }) === true, "fresh avatar, untouched → apply preset");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "a", userTouched: false }) === false, "already loaded this avatar → do not re-apply");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "a", userTouched: true }) === false, "user already edited → do not clobber");
ok(shouldApplyLoadedPreset({ loadedFor: "a", avatarId: "b", userTouched: false }) === true, "switched to new avatar → apply its preset");
ok(shouldApplyLoadedPreset({ loadedFor: null, avatarId: "", userTouched: false }) === false, "no avatar id → no-op");

// ── gen signature: changes ONLY when an input that affects the HeyGen output changes ──
// (avatarId / voice-or-script audio / timing mode / intro+tail secs / input mode+url).
// Scale/offset/chroma are NOT inputs here → adjusting them can never change the signature.
const baseGen = { inputMode: "generate", avatarId: "av1", directUrl: "", voiceUrl: "https://v/1.mp3", timing: "bookend", bookendSecs: 5, tailSecs: 5 };
ok(avatarGenSignature(baseGen) === avatarGenSignature({ ...baseGen }), "same gen-inputs → same signature");
ok(avatarGenSignature(baseGen) !== avatarGenSignature({ ...baseGen, avatarId: "av2" }), "different avatarId → different signature (re-gen)");
ok(avatarGenSignature(baseGen) !== avatarGenSignature({ ...baseGen, voiceUrl: "https://v/2.mp3" }), "different voice/script audio → different signature (re-gen)");
ok(avatarGenSignature(baseGen) !== avatarGenSignature({ ...baseGen, timing: "full" }), "different timing mode → different signature (re-gen)");
ok(avatarGenSignature(baseGen) !== avatarGenSignature({ ...baseGen, bookendSecs: 8 }), "different bookend secs → different signature (re-gen)");
ok(avatarGenSignature(baseGen) !== avatarGenSignature({ ...baseGen, tailSecs: 8 }), "different tail secs → different signature (re-gen)");
ok(avatarGenSignature(baseGen) !== avatarGenSignature({ ...baseGen, inputMode: "direct", directUrl: "https://x.mp4" }), "different input mode/url → different signature (re-gen)");

// ── next action: the primary button decides gen vs composite-only (the bug fix) ──
const sig = avatarGenSignature(baseGen);
const sigChanged = avatarGenSignature({ ...baseGen, voiceUrl: "https://v/2.mp3" });
ok(nextAvatarAction({ hasGreen: false, lastGenSig: null, currentSig: sig }) === "gen", "no green yet → gen (first run)");
ok(nextAvatarAction({ hasGreen: true, lastGenSig: sig, currentSig: sig }) === "composite", "green exists + gen-inputs unchanged (only scale/pos changed) → composite-only, NO re-gen");
ok(nextAvatarAction({ hasGreen: true, lastGenSig: sig, currentSig: sigChanged }) === "gen", "green exists but script/voice changed → re-gen (no stale avatar)");
ok(nextAvatarAction({ hasGreen: true, lastGenSig: null, currentSig: sig }) === "gen", "green exists but provenance unknown → gen (conservative)");

console.log(`\n✅ ALL ${p} AVATAR-FLOW CHECKS PASSED`);
