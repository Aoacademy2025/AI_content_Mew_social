// Central onboarding / AI-support copy for the MCP server. Shared by the server
// `instructions` briefing, create_video_job's missing-key errors, and
// get_current_user's setup guide — so the guidance lives in ONE place and the chat
// assistant can walk a brand-new (BYOK) user through setup like built-in support.

export const SETTINGS_URL = "https://studio.heroaiengine.com/settings"; // → tab "API Keys"

type ProviderHelp = { label: string; whatFor: string; getKeyUrl: string };

export const PROVIDERS: Record<"gemini" | "pexels" | "pixabay" | "elevenlabs" | "heygen", ProviderHelp> = {
  gemini: {
    label: "Gemini (Google AI Studio)",
    whatFor: "เสียงพากย์ (TTS) + คีย์เวิร์ด b-roll + คอนฟิกวิดีโอ — จำเป็นเสมอ",
    getKeyUrl: "https://aistudio.google.com/app/apikey",
  },
  pexels: { label: "Pexels", whatFor: "คลิป b-roll (ฟรี)", getKeyUrl: "https://www.pexels.com/api/" },
  pixabay: { label: "Pixabay", whatFor: "คลิป b-roll (ฟรี) — ใช้แทนหรือเสริม Pexels", getKeyUrl: "https://pixabay.com/api/docs/" },
  elevenlabs: {
    label: "ElevenLabs",
    whatFor: "เสียงโคลนคุณภาพสูง (ไม่บังคับ — ถ้าไม่ใส่ ใช้เสียง Gemini ได้)",
    getKeyUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  heygen: {
    label: "HeyGen",
    whatFor: "avatar พิธีกร AI (ต้องมีตอนสั่งวิดีโอแบบมี avatar)",
    getKeyUrl: "https://app.heygen.com/settings?nav=API",
  },
};

export const ELEVENLABS_VOICEID_HELP =
  "วิธีเอา voiceId: เข้า elevenlabs.io → เมนู Voices → เลือกเสียงที่ต้องการ → Copy Voice ID (เป็นโค้ดยาว เช่น 21m00Tcm4TlvDq8ikWAM)";

function howTo(p: ProviderHelp): string {
  return `${p.whatFor}. ขอ key ที่ ${p.getKeyUrl} แล้วนำไปวางที่ ${SETTINGS_URL} (แท็บ API Keys)`;
}

/** Actionable missing-key error returned by create_video_job (key=value tells runTool it's an error). */
export function missingKeyError(which: "gemini" | "broll" | "elevenlabs" | "heygen") {
  if (which === "gemini") return { error: "missing_key", message: `ยังไม่ได้ตั้งค่า Gemini key — ${howTo(PROVIDERS.gemini)}` };
  if (which === "elevenlabs")
    return {
      error: "missing_key",
      message: `เลือกใช้เสียง ElevenLabs แต่ยังไม่ได้ตั้งค่า ElevenLabs key — ${howTo(PROVIDERS.elevenlabs)} (หรือเปลี่ยนไปใช้ voiceProvider="gemini")`,
    };
  if (which === "heygen") return { error: "missing_key", message: `ยังไม่ได้ตั้งค่า HeyGen key — ${howTo(PROVIDERS.heygen)}` };
  return {
    error: "missing_key",
    message: `ยังไม่มี key สำหรับ b-roll — ต้องมี Pexels หรือ Pixabay อย่างน้อย 1 ตัว. Pexels: ${PROVIDERS.pexels.getKeyUrl} · Pixabay: ${PROVIDERS.pixabay.getKeyUrl} แล้วนำไปวางที่ ${SETTINGS_URL} (แท็บ API Keys)`,
  };
}

/** Using ElevenLabs but no voiceId anywhere — guide how to get one instead of failing downstream. */
export function missingVoiceIdError() {
  return {
    error: "missing_voice_id",
    message: `ใช้เสียง ElevenLabs ต้องระบุ voiceId ด้วย. ${ELEVENLABS_VOICEID_HELP}. ส่ง voiceId มากับ create_video_job หรือบันทึกเสียงเริ่มต้นไว้ที่ ${SETTINGS_URL}`,
  };
}

/** Using avatar but no avatarId resolvable — guide the user to set one. */
export function missingAvatarError() {
  return {
    error: "missing_avatar",
    message: `ยังไม่ได้ตั้ง Avatar — ตั้งค่า Avatar (heygenAvatarId) ที่ ${SETTINGS_URL} หรือส่ง avatarId มากับคำสั่ง create_video_job`,
  };
}

/** Per-user setup checklist embedded in get_current_user so the assistant can onboard step-by-step. */
export function buildSetupGuide(keys: { gemini: boolean; pexels: boolean; pixabay: boolean; elevenlabs: boolean }) {
  return {
    pasteKeysAt: SETTINGS_URL,
    canCreateVideo: keys.gemini && (keys.pexels || keys.pixabay),
    avatarViaChat: false, // avatar (HeyGen) ยังไม่รองรับผ่าน MCP — สั่งได้แค่ เสียง + b-roll + ซับไทย
    steps: [
      { key: "gemini", required: true, configured: keys.gemini, label: PROVIDERS.gemini.label, whatFor: PROVIDERS.gemini.whatFor, getKeyUrl: PROVIDERS.gemini.getKeyUrl },
      { key: "broll", required: true, configured: keys.pexels || keys.pixabay, label: "Pexels หรือ Pixabay", whatFor: PROVIDERS.pexels.whatFor, getKeyUrl: `${PROVIDERS.pexels.getKeyUrl} หรือ ${PROVIDERS.pixabay.getKeyUrl}` },
      { key: "elevenlabs", required: false, configured: keys.elevenlabs, label: PROVIDERS.elevenlabs.label, whatFor: PROVIDERS.elevenlabs.whatFor, getKeyUrl: PROVIDERS.elevenlabs.getKeyUrl, note: ELEVENLABS_VOICEID_HELP },
    ],
  };
}

/** Standing briefing the MCP client (Claude) reads every session — turns it into setup support. */
export const SERVER_INSTRUCTIONS = `HERO AI (studio.heroaiengine.com) เปลี่ยน "สคริปต์" เป็นวิดีโอสั้นอัตโนมัติ: เสียงพากย์ + b-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง. ใช้ได้เฉพาะแผน PRO/BUSINESS.

ทำได้ผ่านแชทตอนนี้: สร้างวิดีโอจากสคริปต์ (เสียง + b-roll + ซับไทย), เช็คสถานะ, ดาวน์โหลด.
ยังไม่รองรับผ่านแชท: avatar (พิธีกร AI / HeyGen) — ถ้าผู้ใช้อยากได้ avatar ให้แนะนำไปทำบนหน้าเว็บ video-creator.

BYOK — ผู้ใช้ใช้ API key ของตัวเอง:
- ตั้ง key ทั้งหมดที่ ${SETTINGS_URL} แท็บ "API Keys".
- ⚠️ ห้ามให้ผู้ใช้พิมพ์หรือวาง API key ลงในแชทเด็ดขาด (ไม่ปลอดภัย คีย์จะค้างใน transcript) — ให้พาไปวางที่หน้า Settings เสมอ.
- key ที่จำเป็น: Gemini (เสมอ) และ Pexels หรือ Pixabay (อย่างน้อย 1 สำหรับ b-roll). ElevenLabs จำเป็นเฉพาะถ้าจะใช้เสียงโคลน.

ทำตัวเป็นผู้ช่วยตั้งค่า:
1) ก่อนสั่งงานครั้งแรก เรียก get_current_user ดู field "setup" ว่าขาด key ตัวไหน.
2) ถ้าขาด key จำเป็น อธิบายว่าแต่ละตัวคืออะไร + ส่งลิงก์ไปขอ + บอกให้นำไปวางที่ Settings แท็บ API Keys แล้วรอผู้ใช้ยืนยันว่าใส่แล้วค่อยลองใหม่ (อย่าเดาว่าใส่แล้ว).
3) เลือกเสียง: voiceProvider="gemini" (ค่าเริ่มต้น ใช้แค่ Gemini key) หรือ "elevenlabs" (ต้องมี ElevenLabs key + voiceId). ${ELEVENLABS_VOICEID_HELP}.
4) create_video_job → ได้ jobId → poll get_video_status({id: jobId}) เป็นระยะจนกว่า status="done" (ผลของ poll ตอนเสร็จจะมี videoUrl กลับมาเลย).
5) ดาวน์โหลด: ใช้ videoUrl จาก get_video_status ได้เลย หรือเรียก list_my_videos เพื่อเอา videoId ไปใช้กับ download_video.

ข้อจำกัด: งานค้างพร้อมกันได้ไม่เกิน 3 ชิ้น/คน และมีโควต้าคลิปตามแผน. error ทุกตัวเป็นข้อความภาษาไทยแบบ in-band ให้แปล/อธิบายให้ผู้ใช้ตามนั้น.`;
