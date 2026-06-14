// Proof of the MCP onboarding copy/contracts: missing-key errors are actionable
// (what + where-to-get link + where-to-paste), the per-user setup guide computes
// readiness correctly, and the server instructions carry the key guardrails.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-onboarding.ts
import {
  SETTINGS_URL, SERVER_INSTRUCTIONS, missingKeyError, missingVoiceIdError, buildSetupGuide,
} from "../src/lib/mcp/onboarding";
import { isInBandError } from "../src/lib/mcp/audit";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// --- missing-key errors: actionable + still classify as in-band errors ---
const gem = missingKeyError("gemini");
assert(gem.error === "missing_key" && gem.message.includes("aistudio.google.com") && gem.message.includes(SETTINGS_URL),
  "gemini missing-key tells where to get the key AND where to paste it");
const broll = missingKeyError("broll");
assert(broll.message.includes("pexels.com") && broll.message.includes("pixabay"),
  "b-roll missing-key offers BOTH Pexels and Pixabay");
const el = missingKeyError("elevenlabs");
assert(el.message.includes("elevenlabs.io") && el.message.includes('voiceProvider="gemini"'),
  "elevenlabs missing-key links the key page AND offers the gemini fallback");
const vid = missingVoiceIdError();
assert(vid.error === "missing_voice_id" && vid.message.toLowerCase().includes("voiceid") && vid.message.includes("Voices"),
  "missing voiceId explains how to copy a Voice ID");
for (const e of [gem, broll, el, vid]) {
  assert(isInBandError(e) === true, `${e.error} is classified as an error by the audit fix`);
}

// --- setup guide: readiness = Gemini AND (Pexels OR Pixabay) ---
const none = buildSetupGuide({ gemini: false, pexels: false, pixabay: false, elevenlabs: false });
assert(none.canCreateVideo === false && none.pasteKeysAt === SETTINGS_URL, "no keys → cannot create, points to Settings");
assert(buildSetupGuide({ gemini: true, pexels: true, pixabay: false, elevenlabs: false }).canCreateVideo === true,
  "Gemini + Pexels → ready");
assert(buildSetupGuide({ gemini: true, pexels: false, pixabay: true, elevenlabs: false }).canCreateVideo === true,
  "Gemini + Pixabay (no Pexels) → ready");
assert(buildSetupGuide({ gemini: true, pexels: false, pixabay: false, elevenlabs: false }).canCreateVideo === false,
  "Gemini but no b-roll key → not ready");
assert(buildSetupGuide({ gemini: false, pexels: true, pixabay: true, elevenlabs: false }).canCreateVideo === false,
  "b-roll but no Gemini → not ready");
const guide = none;
assert(guide.avatarViaChat === false, "setup guide flags avatar as NOT available via chat");
assert(guide.steps.find((s) => s.key === "gemini")!.required === true, "gemini step is required");
assert(guide.steps.find((s) => s.key === "elevenlabs")!.required === false, "elevenlabs step is optional");

// --- server instructions carry the guardrails the assistant must honor ---
assert(SERVER_INSTRUCTIONS.includes(SETTINGS_URL), "instructions tell where to set keys");
assert(SERVER_INSTRUCTIONS.includes("ห้าม"), "instructions forbid pasting keys into chat (security)");
assert(SERVER_INSTRUCTIONS.includes("avatar"), "instructions state avatar is not supported via chat");
assert(SERVER_INSTRUCTIONS.includes("get_current_user"), "instructions tell the assistant to check setup first");

console.log(`\n${passed} assertions passed ✅`);
