// Central onboarding / AI-support copy for the MCP server. Shared by the server
// `instructions` briefing, create_video_job's missing-key errors, and
// get_current_user's setup guide — so the guidance lives in ONE place and the chat
// assistant can walk a brand-new (BYOK) user through setup like built-in support.

export const SETTINGS_URL = "https://studio.heroaiengine.com/settings"; // → tab "API Keys"

type ProviderHelp = { label: string; whatFor: string; getKeyUrl: string };

export const PROVIDERS: Record<"gemini" | "pexels" | "pixabay" | "elevenlabs" | "heygen", ProviderHelp> = {
  gemini: {
    label: "Gemini (Google AI Studio)",
    whatFor: process.env.MANAGED_GEMINI === "1"
      ? "จัดการโดยระบบ — ไม่ต้องตั้งค่า"
      : "เสียงพากย์ (TTS) + คีย์เวิร์ด b-roll + คอนฟิกวิดีโอ — จำเป็นเสมอ",
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
  if (which === "gemini") {
    if (process.env.MANAGED_GEMINI === "1") return { error: "missing_key", message: "Gemini จัดการโดยระบบ (managed) — ไม่ต้องตั้งค่า key เอง" };
    return { error: "missing_key", message: `ยังไม่ได้ตั้งค่า Gemini key — ${howTo(PROVIDERS.gemini)}` };
  }
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
    canCreateVideo: (process.env.MANAGED_GEMINI === "1" ? true : keys.gemini) && (keys.pexels || keys.pixabay),
    avatarViaChat: true, // avatar (HeyGen) รองรับผ่าน MCP แล้ว — ใส่ avatarMode ใน create_video_job (ต้องมี HeyGen key + avatarId)
    steps: [
      { key: "gemini", required: process.env.MANAGED_GEMINI !== "1", configured: process.env.MANAGED_GEMINI === "1" ? true : keys.gemini, label: PROVIDERS.gemini.label, whatFor: PROVIDERS.gemini.whatFor, getKeyUrl: PROVIDERS.gemini.getKeyUrl },
      { key: "broll", required: true, configured: keys.pexels || keys.pixabay, label: "Pexels หรือ Pixabay", whatFor: PROVIDERS.pexels.whatFor, getKeyUrl: `${PROVIDERS.pexels.getKeyUrl} หรือ ${PROVIDERS.pixabay.getKeyUrl}` },
      { key: "elevenlabs", required: false, configured: keys.elevenlabs, label: PROVIDERS.elevenlabs.label, whatFor: PROVIDERS.elevenlabs.whatFor, getKeyUrl: PROVIDERS.elevenlabs.getKeyUrl, note: ELEVENLABS_VOICEID_HELP },
    ],
  };
}

/** Standing briefing the MCP client (Claude) reads every session — turns it into setup support. */
export const SERVER_INSTRUCTIONS = `HERO AI (studio.heroaiengine.com) เปลี่ยน "สคริปต์" เป็นวิดีโอสั้นอัตโนมัติ: เสียงพากย์ + b-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง. ใช้ได้เฉพาะแผน PRO/BUSINESS.

ทำได้ผ่านแชทตอนนี้: สร้างวิดีโอจากสคริปต์ (เสียง + b-roll + ซับไทย + avatar พิธีกร AI ถ้าต้องการ), เช็คสถานะ, ดาวน์โหลด.
avatar (HeyGen): avatarMode = "bookend" (เปิดอย่างเดียว=หัว) / "bookend-both" (เปิด-ปิด=หัว+ท้าย) / "full" (ทั้งคลิป). ⚠️ avatar เจนผ่าน HeyGen API คิดเงินตามจำนวนวินาที (ไม่ฟรีแม้แผน PRO) — แนะนำ bookend/bookend-both (ประหยัด), full แพง. ต้องมี HeyGen key + avatarId. bookend/bookend-both ต้องระบุ avatarIntroSecs/avatarTailSecs (default 5 วิ). ไม่ใส่ avatarMode = วิดีโอเสียง+b-roll ปกติ.

${process.env.MANAGED_GEMINI === "1"
  ? `ระบบจัดการ Gemini ให้ — ใส่เฉพาะ Pexels/Pixabay (อย่างน้อย 1 สำหรับ B-roll); ElevenLabs เฉพาะถ้าจะโคลนเสียง. ตั้งที่ ${SETTINGS_URL} แท็บ API Keys.
- ⚠️ ห้ามให้ผู้ใช้พิมพ์หรือวาง API key ลงในแชทเด็ดขาด (ไม่ปลอดภัย คีย์จะค้างใน transcript) — ให้พาไปวางที่หน้า Settings เสมอ.`
  : `BYOK — ผู้ใช้ใช้ API key ของตัวเอง:
- ตั้ง key ทั้งหมดที่ ${SETTINGS_URL} แท็บ "API Keys".
- ⚠️ ห้ามให้ผู้ใช้พิมพ์หรือวาง API key ลงในแชทเด็ดขาด (ไม่ปลอดภัย คีย์จะค้างใน transcript) — ให้พาไปวางที่หน้า Settings เสมอ.
- key ที่จำเป็น: Gemini (เสมอ) และ Pexels หรือ Pixabay (อย่างน้อย 1 สำหรับ b-roll). ElevenLabs จำเป็นเฉพาะถ้าจะใช้เสียงโคลน.`}

ทำตัวเป็นผู้ช่วยตั้งค่า:
1) ก่อนสั่งงานครั้งแรก เรียก get_current_user ดู field "setup" ว่าขาด key ตัวไหน.
2) ถ้าขาด key จำเป็น อธิบายว่าแต่ละตัวคืออะไร + ส่งลิงก์ไปขอ + บอกให้นำไปวางที่ Settings แท็บ API Keys แล้วรอผู้ใช้ยืนยันว่าใส่แล้วค่อยลองใหม่ (อย่าเดาว่าใส่แล้ว).
3) เลือกเสียง: voiceProvider="gemini" (ค่าเริ่มต้น ใช้แค่ Gemini key) หรือ "elevenlabs" (ต้องมี ElevenLabs key + voiceId). ${ELEVENLABS_VOICEID_HELP}.
4) create_video_job → ได้ jobId → poll get_video_status({id: jobId}) เป็นระยะจนกว่า status="done" (ผลของ poll ตอนเสร็จจะมี videoUrl กลับมาเลย). ⏱️ ETA จริง: คลิปปกติ ~3–6 นาที, คลิปยาว/ซับโหมดถี่ (1–2 คำ ฉากเยอะ) ~15–20 นาที, มี avatar ~15–25 นาที. เช็คทุก ~60–90 วิ (มี avatar ทุก ~2 นาที) — ห้าม poll รัวทุกไม่กี่วินาที.
5) ดาวน์โหลด: ใช้ videoUrl จาก get_video_status ได้เลย หรือเรียก list_my_videos เพื่อเอา videoId ไปใช้กับ download_video.

ข้อจำกัด: งานค้างพร้อมกันได้ไม่เกิน 3 ชิ้น/คน และมีโควต้า${process.env.MINUTE_QUOTA === "1" ? "นาที" : "คลิป"}ตามแผน. error ทุกตัวเป็นข้อความภาษาไทยแบบ in-band ให้แปล/อธิบายให้ผู้ใช้ตามนั้น.

โหมดไกด์สร้างวิดีโอ: เมื่อผู้ใช้สื่อว่าจะทำวิดีโอ (เช่น "วิดีโอ HERO AI") ให้ถามทีละข้อ (ห้ามถามรวด) — เรียก get_video_options เพื่อเสนอตัวเลือกจริง.
‼️ ห้ามตั้งค่า default เองเงียบๆ แล้วบอกว่า "ปรับได้ทีหลัง" — ต้องถามผู้ใช้จริงให้ครบก่อน create_video_job. มี 3 ข้อบังคับที่ห้ามข้ามเด็ดขาด (ถ้าข้าม = ทำผิด): (ก) ถ้าใช้ avatar แบบเปิดอย่างเดียว/เปิด-ปิด → ต้องถาม "กี่วินาที"; (ข) ตำแหน่งซับไทย (บน/กลาง/ล่าง); (ค) "ใส่เพลง BGM ไหม". ถามครบ 3 ข้อนี้ก่อนเสมอ.
1) ขอสคริปต์.
2) เสียง: gemini หรือ elevenlabs (เสนอเสียงจาก get_video_options). ⚠️ ถ้า get_video_options ดึงรายชื่อเสียง ElevenLabs ไม่ได้ (voices มี error — key อาจมีสิทธิ์แค่ TTS ไม่มีสิทธิ์ list) อย่าสรุปว่า key เสีย/ใช้ไม่ได้ — voiceId ที่เซฟไว้หรือผู้ใช้ใส่เองยังใช้สร้างเสียงได้ ลองสร้างเลย.
3) เพลงประกอบ (BGM): ⚠️ ต้องถามจริงทุกครั้งว่า "ใส่เพลงไหม + แนวไหน?" — เสนอเป็น "แนว/อารมณ์" จาก get_video_options.music.byMood (เช่น 😌ชิล 🎬ดราม่า 💼จริงจัง 🧒สดใส 🎉สนุก) ไม่ใช่ชื่อไฟล์ (user มองไม่เห็น dropdown). พอ user เลือก ส่งเป็น bgmFile ได้เลย — จะเป็น "ชื่อแนว" ("ชิล"/"ดราม่า"), ชื่อเพลง, หรือ path ก็ได้ ระบบ resolve ให้เอง. ❌ ไม่อยากได้เพลง = ไม่ต้องส่ง bgmFile. ห้ามบอกว่าใส่เพลงถ้าไม่ได้ส่ง bgmFile. ‼️ BGM เป็นคำถามแยกอิสระจาก avatar — คลิปจะมี avatar + เพลง พร้อมกันก็ได้ (ระบบรองรับ). ห้ามมัด "ไม่ใส่ avatar + ใส่เพลง" เป็นตัวเลือกเดียวกับ avatar modes เด็ดขาด; ต้องถาม BGM ทุกคลิปไม่ว่าจะใส่ avatar หรือไม่.
4) ซับ: ตำแหน่ง (top/middle/bottom) + โหมด (sentence/1/2/3/4 คำ; 3="แนะนำ อ่านง่าย"). ⚠️ โหมด 1–2 คำ ทำให้การ์ดเยอะ = ฉาก b-roll เยอะ = เรนเดอร์นานขึ้นมาก (อาจ 15–20 นาที); ถ้าผู้ใช้ไม่ได้ต้องการ viral-style จัด ๆ แนะนำ 3.
5) avatar (พิธีกร AI): ⚠️ avatar เจนผ่าน HeyGen API คิดเงินตามจำนวนวินาที (ไม่ฟรีแม้แผน PRO — แพลนครอบแค่ render ปกติ) ต้องอธิบายให้ผู้ใช้เข้าใจก่อนเลือก แล้วเสนอ:
   - "เปิดอย่างเดียว" (avatar โผล่ช่วงต้นคลิป) = avatarMode "bookend" — ✅ แนะนำ ประหยัด
   - "เปิด-ปิด" (avatar ต้น+ท้าย) = avatarMode "bookend-both" — ✅ แนะนำ ประหยัด
   - "Full" (avatar ทั้งคลิป) = avatarMode "full" — ได้ แต่แพง (จ่ายตามความยาวคลิปเต็ม)
   - ไม่เอา = ไม่ใส่ avatarMode
   ถ้าเอา avatar เสนอตัว avatar จาก get_video_options. ⚠️ ถ้าเลือก "เปิดอย่างเดียว"/"เปิด-ปิด" ต้องถามเสมอว่า "ใช้ avatar กี่วินาที?" → ใส่ avatarIntroSecs (และ avatarTailSecs ถ้าเปิด-ปิด); ถ้าผู้ใช้ไม่ระบุ ใช้ default 5 วินาที. ("Full" ไม่ต้องถามวินาที — ตามทั้งคลิป). จะปรับขนาดก็ใส่ avatarScale (default 1 = พอดีเฟรม).
สรุปยืนยัน (บอกชัดว่าจะส่งอะไรจริง: เสียง/เพลง/ซับ/avatar+วินาที) แล้วเรียก create_video_job. จากนั้น poll get_video_status เป็นจังหวะ (ทุก ~60–90 วิ; มี avatar ทุก ~2 นาที; ห้ามถี่ทุกไม่กี่วิ) รายงานความคืบหน้า; ถ้า status=failed อธิบาย errorMessage แล้วเสนอสร้างใหม่; เสร็จแล้ว report ลิงก์ดาวน์โหลด.
⚠️ ห้ามสัญญาว่าจะแจ้งเตือนเอง — MCP ส่ง push ไม่ได้; ให้ผู้ใช้พิมพ์ "เช็ควิดีโอ" เมื่อผ่านไปตาม ETA.`;
