// Proof of the MCP onboarding copy/contracts: missing-key errors are actionable
// (what + where-to-get link + where-to-paste), the per-user setup guide computes
// readiness correctly, and the server instructions carry the key guardrails.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-onboarding.ts
import {
  SETTINGS_URL, SERVER_INSTRUCTIONS, missingKeyError, missingVoiceIdError, buildSetupGuide,
  missingAvatarError,
} from "../src/lib/mcp/onboarding";
import { isInBandError } from "../src/lib/mcp/audit";
import { readFileSync } from "node:fs";

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
assert(guide.avatarViaChat === true, "setup guide flags avatar as available via chat");
assert(guide.steps.find((s) => s.key === "gemini")!.required === true, "gemini step is required");
assert(guide.steps.find((s) => s.key === "elevenlabs")!.required === false, "elevenlabs step is optional");

// --- server instructions carry the guardrails the assistant must honor ---
assert(SERVER_INSTRUCTIONS.includes(SETTINGS_URL), "instructions tell where to set keys");
assert(SERVER_INSTRUCTIONS.includes("ห้าม"), "instructions forbid pasting keys into chat (security)");
assert(SERVER_INSTRUCTIONS.includes("avatarMode"), "instructions describe how to use avatar (avatarMode)");
assert(SERVER_INSTRUCTIONS.includes("get_current_user"), "instructions tell the assistant to check setup first");

// --- HeyGen key + missing avatar (avatar feature) ---
const hg = missingKeyError("heygen");
assert(hg.error === "missing_key" && hg.message.includes("heygen.com") && hg.message.includes(SETTINGS_URL),
  "heygen missing-key links the HeyGen API page and Settings");
const noav = missingAvatarError();
assert(noav.error === "missing_avatar" && noav.message.includes("avatarId"),
  "missing_avatar explains how to set/pass an avatarId");

assert(SERVER_INSTRUCTIONS.includes("get_video_options"), "instructions reference get_video_options (wizard)");
assert(SERVER_INSTRUCTIONS.includes("ห้ามสัญญาว่าจะแจ้งเตือน"), "instructions forbid promising auto-notify");
// batch3: avatar pricing/seconds + easy terms, BGM must-ask, ElevenLabs voices-list note
assert(SERVER_INSTRUCTIONS.includes("คิดเงินตามจำนวนวินาที") && SERVER_INSTRUCTIONS.includes("เปิดอย่างเดียว"), "avatar step: HeyGen per-second pricing + easy terms");
assert(SERVER_INSTRUCTIONS.includes("ใช้ avatar กี่วินาที") && SERVER_INSTRUCTIONS.includes("default 5"), "avatar step: must ask seconds, default 5");
assert(SERVER_INSTRUCTIONS.includes("ต้องถามจริงทุกครั้งว่า") && SERVER_INSTRUCTIONS.includes("ห้ามบอกว่าใส่เพลงถ้าไม่ได้ส่ง bgmFile"), "BGM step: must ask + must actually send bgmFile");
assert(SERVER_INSTRUCTIONS.includes("อย่าสรุปว่า key เสีย"), "elevenlabs: voices-list failure ≠ key broken");
// batch4: forbid silently defaulting — must really ask the 4 mandatory questions
// (pre-existing assertion said "3" but the text was already at 4 ก/ข/ค/ง items — fixed to match.)
assert(SERVER_INSTRUCTIONS.includes("ห้ามตั้งค่า default เองเงียบ") && SERVER_INSTRUCTIONS.includes("4 ข้อบังคับ"), "wizard: forbid silent defaults, 4 mandatory questions");
// batch5: BGM independent of avatar — never bundle "no-avatar + music" as one option
assert(SERVER_INSTRUCTIONS.includes("BGM เป็นคำถามแยกอิสระจาก avatar") && SERVER_INSTRUCTIONS.includes("ห้ามมัด"), "wizard: BGM decoupled from avatar (ask always)");

// --- T11: new fields the assistant must relay (create_video_job warnings, subtitleQa,
// editorUrl, cancel_video_job, errorCode/userAction/refunded/refundPending, cancel charging,
// HeyGen non-refundable, brand = subtitle-only this round) ---------------------------------
assert(SERVER_INSTRUCTIONS.includes('"warnings"') && SERVER_INSTRUCTIONS.includes("ห้ามข้ามหรือสรุปรวบ"),
  "instructions: relay every warnings[] item from create_video_job, never skip/summarize");
assert(SERVER_INSTRUCTIONS.includes('"subtitleQa"') && SERVER_INSTRUCTIONS.includes("เป็นคำเตือน ให้แจ้งผู้ใช้ด้วย"),
  "instructions: relay a subtitleQa warning from get_video_status");
assert(SERVER_INSTRUCTIONS.includes('"editorUrl"') && SERVER_INSTRUCTIONS.includes("กดลิงก์นี้เพื่อแก้ต่อในเว็บได้"),
  "instructions: relay editorUrl with the exact phrase");
assert(SERVER_INSTRUCTIONS.includes("cancel_video_job({id})") && SERVER_INSTRUCTIONS.includes("ห้ามสั่ง create_video_job ซ้ำ"),
  "instructions: stop/change-mind → cancel_video_job, never re-create the same script");
assert(SERVER_INSTRUCTIONS.includes('"errorCode"') && SERVER_INSTRUCTIONS.includes('"userAction"'),
  "instructions: explain a failed job via errorCode + userAction");
assert(SERVER_INSTRUCTIONS.includes("refunded=true") && SERVER_INSTRUCTIONS.includes("refundPending=true")
  && SERVER_INSTRUCTIONS.includes("ห้ามบอกว่าคืนเงินถ้า field ไม่ได้บอกแบบนั้น"),
  "instructions: refunded vs refundPending must be told truthfully, never assumed");
assert(SERVER_INSTRUCTIONS.includes("ส่วนที่เรนเดอร์เสร็จแล้วยังถูกคิดตามปกติ"),
  "instructions: cancelling after the base render keeps that charge");
assert(SERVER_INSTRUCTIONS.includes("HeyGen") && SERVER_INSTRUCTIONS.includes("คืนไม่ได้ทุกกรณี"),
  "instructions: HeyGen avatar spend is never refundable");
assert(SERVER_INSTRUCTIONS.includes("brandProfileId") && SERVER_INSTRUCTIONS.includes('มีผลกับ "สไตล์ซับ" เท่านั้น'),
  "instructions: a brand affects only subtitle style this round, not voice/B-roll/logo");

async function main() {
  // --- MANAGED_GEMINI branches: the polling-cadence rule and the no-API-keys rule must
  // survive in BOTH branches. SERVER_INSTRUCTIONS is a module-level const computed from
  // process.env.MANAGED_GEMINI at import time, so each branch needs its own fresh import
  // (cache-busted via a query string) with the env var set before that import resolves.
  const POLL_RULE = "ห้าม poll รัวทุกไม่กี่วินาที";
  const NO_KEY_RULE = "ห้ามให้ผู้ใช้พิมพ์หรือวาง API key ลงในแชทเด็ดขาด";
  const prevManaged = process.env.MANAGED_GEMINI;

  process.env.MANAGED_GEMINI = "1";
  const managed: typeof import("../src/lib/mcp/onboarding") =
    await import("../src/lib/mcp/onboarding?t11-managed");
  assert(managed.SERVER_INSTRUCTIONS.includes("ระบบจัดการ Gemini ให้"), "sanity: MANAGED_GEMINI=1 branch selected");
  assert(managed.SERVER_INSTRUCTIONS.includes(POLL_RULE), "MANAGED_GEMINI=1 branch: polling-cadence rule present");
  assert(managed.SERVER_INSTRUCTIONS.includes(NO_KEY_RULE), "MANAGED_GEMINI=1 branch: no-API-keys rule present");

  delete process.env.MANAGED_GEMINI;
  const byok: typeof import("../src/lib/mcp/onboarding") =
    await import("../src/lib/mcp/onboarding?t11-byok");
  assert(byok.SERVER_INSTRUCTIONS.includes("BYOK —"), "sanity: BYOK branch selected");
  assert(byok.SERVER_INSTRUCTIONS.includes(POLL_RULE), "BYOK branch: polling-cadence rule present");
  assert(byok.SERVER_INSTRUCTIONS.includes(NO_KEY_RULE), "BYOK branch: no-API-keys rule present");

  if (prevManaged === undefined) delete process.env.MANAGED_GEMINI; else process.env.MANAGED_GEMINI = prevManaged;

  // --- Version + the three tool descriptions (route.ts) -----------------------------------
  const routeSrc = readFileSync(new URL("../src/app/api/[transport]/route.ts", import.meta.url), "utf8");
  assert(routeSrc.includes('version: "0.2.0"'), "serverInfo.version is 0.2.0");
  assert(!routeSrc.includes('version: "0.1.0"'), "serverInfo.version no longer 0.1.0");
  assert(routeSrc.includes("ยกเลิกงานวิดีโอที่ยังไม่เสร็จ") && routeSrc.includes("ค่า HeyGen คืนไม่ได้"),
    "cancel_video_job tool description: base-render charge + non-refundable HeyGen");
  assert(routeSrc.includes("ถ้ามี warnings/subtitleQa ให้แจ้งผู้ใช้") && routeSrc.includes("กดลิงก์นี้เพื่อแก้ต่อในเว็บได้"),
    "get_video_status tool description: warnings/subtitleQa/editorUrl/userAction+refund");
  assert(routeSrc.includes("แจ้งผู้ใช้ทุกข้อใน warnings") && routeSrc.includes("มีผลกับสไตล์ซับเท่านั้น"),
    "create_video_job tool description: warnings + brand=subtitle-only");

  console.log(`\n${passed} assertions passed ✅`);
}

main();
