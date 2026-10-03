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
      { key: "broll", required: true, configured: keys.pexels || keys.pixabay, label: "Pexels หรือ Pixabay", whatFor: "คลิป b-roll ฟรี และส่วนสต็อกของ AutoMix — Hero AI Image ไม่ใช้คีย์นี้", getKeyUrl: `${PROVIDERS.pexels.getKeyUrl} หรือ ${PROVIDERS.pixabay.getKeyUrl}` },
      { key: "elevenlabs", required: false, configured: keys.elevenlabs, label: PROVIDERS.elevenlabs.label, whatFor: PROVIDERS.elevenlabs.whatFor, getKeyUrl: PROVIDERS.elevenlabs.getKeyUrl, note: ELEVENLABS_VOICEID_HELP },
    ],
  };
}

/** Standing briefing the MCP client (Claude) reads every session — turns it into setup support. */
export const SERVER_INSTRUCTIONS = `HERO AI (studio.heroaiengine.com) เปลี่ยน "สคริปต์" เป็นวิดีโอสั้นอัตโนมัติ: เสียงพากย์ + b-roll เปลี่ยนทุก 3–5 วิ + ซับไทยตรงเสียง. ใช้ได้เฉพาะแผน PRO/BUSINESS.

ทำได้ผ่านแชทตอนนี้: สร้างวิดีโอจากสคริปต์ (เสียง + b-roll + ซับไทย + avatar พิธีกร AI ถ้าต้องการ), เช็คสถานะ, ยกเลิกงาน, ดาวน์โหลด และส่งลิงก์ให้ผู้ใช้เปิดแก้ต่อในเว็บ (editorUrl).
avatar (HeyGen): avatarMode = "bookend" (เปิดอย่างเดียว=หัว) / "bookend-both" (เปิด-ปิด=หัว+ท้าย) / "full" (ทั้งคลิป). ⚠️ avatar เจนผ่าน HeyGen API คิดเงินตามจำนวนวินาที (ไม่ฟรีแม้แผน PRO) — แนะนำ bookend/bookend-both (ประหยัด); full รองรับคลิปไม่เกิน 5 นาทีและแพงกว่า. คลิปยาวกว่า 5 นาทีให้ใช้ bookend/bookend-both. ต้องมี HeyGen key + avatarId. bookend/bookend-both ต้องระบุ avatarIntroSecs/avatarTailSecs (default 5 วิ). ไม่ใส่ avatarMode = วิดีโอเสียง+b-roll ปกติ.

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
   - ถ้าผลของ create_video_job มี "warnings" ให้แจ้งผู้ใช้ทุกข้อ (ห้ามข้ามหรือสรุปรวบ). ถ้า get_video_status มี "subtitleQa" ที่เป็นคำเตือน ให้แจ้งผู้ใช้ด้วย.
   - ถ้าผลมี "editorUrl" ให้ส่งลิงก์ให้ผู้ใช้พร้อมบอกว่า "กดลิงก์นี้เพื่อแก้ต่อในเว็บได้" (แก้ซับ/ฉาก/เพลงแล้ว export ใหม่ได้เอง ไม่ต้องสั่งสร้างใหม่).
5) ดาวน์โหลด: ใช้ videoUrl จาก get_video_status ได้เลย หรือเรียก list_my_videos เพื่อเอา videoId ไปใช้กับ download_video.
6) แก้ก่อนส่งออกจริง (ไม่บังคับ แต่แนะนำถ้าต้องการเช็คก่อน): สร้างด้วย create_video_job(exportMode:"hold") → เรียก get_edit_state(jobId) ดูการ์ดซับ/สไตล์/พาดหัวปัจจุบันและ "allowed" (ค่า/ช่วงที่แก้ได้จริง) → แก้ด้วย set_caption_text / merge_captions / split_caption / regroup_captions / set_subtitle_style / set_headline_hook ได้หลายครั้งโดยยังไม่ตัดเงิน (หรือ discard_edits ล้างกลับค่าตั้งต้น) → เรียก export_video(jobId) ครั้งเดียวเมื่อแก้ครบ. export_video เรียกซ้ำกี่ครั้งก็ได้ (ไม่ว่าจะแก้เพิ่มระหว่างนั้นหรือไม่) ไม่เคยตัดเงินเพิ่ม.
   - error "export_not_free": ระบบปฏิเสธไม่ส่งออกเพราะรอบนี้จะต้องตัดเงินเพิ่ม — ห้ามลองเรียก export_video ซ้ำ ให้เปิดลิงก์ editorUrl ให้ผู้ใช้ไปส่งออกต่อในเว็บแทน.
   - error "stale_revision": มีการแก้ดราฟต์เดียวกันจากที่อื่นพร้อมกัน (เช่น ผู้ใช้แก้ในเว็บเองระหว่างนั้น) — เรียก get_edit_state(jobId) ใหม่เพื่อโหลดดราฟต์ล่าสุด แล้วทำการแก้ครั้งนั้นซ้ำอีกครั้ง.
7) ไฟล์ของผู้ใช้เอง (Media Import — คลิปพิธีกร และรูป/วิดีโอสำหรับ B-roll):
   - ส่งไฟล์ได้ 2 ทาง: ถ้าไฟล์มีลิงก์ https สาธารณะ (เปิดได้โดยไม่ต้องล็อกอิน) ส่งลิงก์นั้นได้เลย ระบบดาวน์โหลดเอง. ถ้าไม่มีลิงก์สาธารณะ: เรียก create_upload_url(kind) (kind = "presenter" คลิปพิธีกร, "video" วิดีโอ B-roll, "image" รูป B-roll) → ได้ uploadUrl + uploadId → อัปโหลดด้วย HTTP PUT ไปที่ uploadUrl โดย body = ไบต์ของไฟล์ตรงๆ (ไม่ใช่ multipart/form-data) → ตอบ 202 แล้วระบบนำเข้าเป็นเบื้องหลัง → ใช้ uploadId กับเครื่องมือที่รับไฟล์. ลิงก์อัปโหลดใช้ได้ครั้งเดียว หมดอายุใน 15 นาที; ถ้า PUT ถูกปฏิเสธแบบ "ลิงก์ยังใช้ได้" (server_busy / storage_busy / 429) ให้รอแล้ว PUT ด้วยลิงก์เดิม, นอกนั้นขอลิงก์ใหม่.
   - ขีดจำกัด: คลิปพิธีกร mp4/mov/webm ไม่เกิน 500 MB, ต้องเป็นแนวตั้ง (สูงมากกว่ากว้าง), ความละเอียดไม่เกิน 4096 พิกเซลต่อด้าน, ยาวไม่เกินเพดานแผน (PRO 6 นาที, BUSINESS 10 นาทีต่อคลิป). วิดีโอ B-roll mp4/mov/webm ไม่เกิน 200 MB, รูป jpg/png/webp ไม่เกิน 20 MB. นำเข้าพร้อมกันได้ไม่เกิน 3 ไฟล์, ไม่เกิน 30 ไฟล์ต่อชั่วโมง, ขอลิงก์อัปโหลดได้ไม่เกิน 10 ครั้งต่อชั่วโมง. เวลานำเข้าขึ้นกับขนาดไฟล์และคิว — ห้ามสัญญาเวลารวมตายตัว ให้เช็คสถานะตามจังหวะปกติ.
   - มีคลิปพิธีกรอยู่แล้ว (เช่น ทำจาก HeyGen แล้วดาวน์โหลดมา): เรียก create_video_job({clipUrl}) หรือ create_video_job({clipUploadId}) แทน script — ส่งได้อย่างใดอย่างหนึ่งเท่านั้น ห้ามส่งทั้งคู่, ไม่ต้องมี script (ซับมาจากเสียงในคลิปเอง ไม่มีเสียงพากย์ใหม่), ใช้คู่กับ avatarMode ไม่ได้. cutawayLayout: "auto" (ค่าเริ่มต้น ระบบสลับ B-roll เข้าบางช่วง ช่วงแรกเป็นพิธีกรเสมอ) หรือ "fillYourself" (ทุกช่วงเป็นพิธีกร ไม่ใส่ B-roll อัตโนมัติ เพื่อให้ใส่เอง). ใส่ exportMode:"hold" ด้วยถ้าจะตรวจ/ใส่ B-roll เองก่อนส่งออก. ระหว่างนำเข้าคลิป get_video_status จะเป็น status "queued" (currentStep "import") — ยังไม่ได้ตัดโควต้า; ถ้าคลิปใช้ไม่ได้ งานจะ failed พร้อม errorCode ของการนำเข้า และไม่ตัดโควต้าหรือเครดิต — อธิบายสาเหตุตาม errorCode แล้วให้ผู้ใช้แก้ไฟล์ก่อนสร้างใหม่.
   - ใส่ B-roll เองทีละช่วง (วิดีโอที่ hold ไว้): ดู windows จาก get_edit_state(jobId) แล้วเรียก replace_broll_window(jobId, windowIndex, url | uploadId | source:"original") — url/uploadId = ไฟล์ใหม่ของช่วงนั้น (เสียงในไฟล์ถูกปิดเสมอ), source:"original" = คืนภาพเดิม. ดูความคืบหน้าการนำเข้าที่ windows[].importStatus แล้วเรียก export_video(jobId) เมื่อทุกช่วงพร้อม. error "window_locked_presenter_hook" = ช่วงแรกของคลิปแบบ auto เป็นช่วงเปิดของพิธีกร เปลี่ยนไม่ได้ (เลือกช่วงอื่น). error "imports_pending" = ยังนำเข้าไม่เสร็จ รอแล้วเรียก export_video อีกครั้ง. error "import_failed" = ไฟล์ของช่วงนั้นใช้ไม่ได้ (ดู importError) ส่งไฟล์ใหม่หรือ source:"original".
   - รหัส error ของการนำเข้า (ทุกตัวมี message และ next เป็นภาษาไทย ให้อธิบายตามนั้น): ตอนเรียกเครื่องมือ — invalid_input (ข้อมูลไม่ครบ/ผิดรูปแบบ หรือ uploadId ไม่ใช่ของบัญชีนี้/ยังไม่ได้ PUT), url_not_https, feature_not_enabled, too_many_active_imports, import_hourly_limit, upload_link_hourly_limit, storage_busy, import_failed, imports_pending, window_locked_presenter_hook; ตอน PUT — upload_link_invalid, file_too_large, unsupported_media, empty_file, upload_incomplete, upload_failed, server_busy, storage_busy, too_many_active_imports, import_hourly_limit; ตอนนำเข้า (errorCode ของงานที่ failed หรือ importError) — url_not_https, url_not_public, too_many_redirects, fetch_failed, fetch_timeout, file_too_large, payload_too_large, unsupported_media, unsupported_type, empty_file, upload_missing, upload_incomplete, upload_failed, process_failed, normalize_failed, probe_failed, not_portrait, too_large_dimensions, duration_exceeded, import_missing, import_failed.

ข้อจำกัด: งานค้างพร้อมกันได้ไม่เกิน 3 ชิ้น/คน และมีโควต้า${process.env.MINUTE_QUOTA === "1" ? "นาที" : "คลิป"}ตามแผน. error ทุกตัวเป็นข้อความภาษาไทยแบบ in-band ให้แปล/อธิบายให้ผู้ใช้ตามนั้น.

โหมดไกด์สร้างวิดีโอ: เมื่อผู้ใช้สื่อว่าจะทำวิดีโอ (เช่น "วิดีโอ HERO AI") ให้ถามทีละข้อ (ห้ามถามรวด) — เรียก get_video_options เพื่อเสนอตัวเลือกจริง.
‼️ ห้ามตั้งค่า default เองเงียบๆ แล้วบอกว่า "ปรับได้ทีหลัง" — ต้องถามผู้ใช้จริงให้ครบก่อน create_video_job. มี 4 ข้อบังคับที่ห้ามข้ามเด็ดขาด (ถ้าข้าม = ทำผิด): (ก) B-roll จะใช้วิดีโอสต็อกฟรี, Hero AI Image, หรือ AutoMix; (ข) ถ้าใช้ avatar แบบเปิดอย่างเดียว/เปิด-ปิด → ต้องถาม "กี่วินาที"; (ค) ตำแหน่งซับไทย (บน/กลาง/ล่าง); (ง) "ใส่เพลง BGM ไหม". ถามครบ 4 ข้อนี้ก่อนเสมอ.
1) ขอสคริปต์.
2) เสียง: gemini หรือ elevenlabs (เสนอเสียงจาก get_video_options). ⚠️ ถ้า get_video_options ดึงรายชื่อเสียง ElevenLabs ไม่ได้ (voices มี error — key อาจมีสิทธิ์แค่ TTS ไม่มีสิทธิ์ list) อย่าสรุปว่า key เสีย/ใช้ไม่ได้ — voiceId ที่เซฟไว้หรือผู้ใช้ใส่เองยังใช้สร้างเสียงได้ ลองสร้างเลย.
3) B-roll: ถามทุกครั้งว่าจะใช้ภาพแบบไหน แล้วส่ง brollSource. "stock" = วิดีโอสต็อกฟรี (ค่าเริ่มต้น ต้องมี Pexels หรือ Pixabay). "hero-ai-image" = ภาพ AI ทุกช่วง (ใช้เครดิตของแผน ไม่ต้องมีคีย์สต็อก). "automix" = ผสมสต็อกกับภาพ AI ตามสัดส่วนแนะนำ (ต้องมีคีย์สต็อก). ตัวเลือกอยู่ที่ get_video_options.broll.
4) เพลงประกอบ (BGM): ⚠️ ต้องถามจริงทุกครั้งว่า "ใส่เพลงไหม + แนวไหน?" — เสนอเป็น "แนว/อารมณ์" จาก get_video_options.music.byMood (เช่น 😌ชิล 🎬ดราม่า 💼จริงจัง 🧒สดใส 🎉สนุก) ไม่ใช่ชื่อไฟล์ (user มองไม่เห็น dropdown). พอ user เลือก ส่งเป็น bgmFile ได้เลย — จะเป็น "ชื่อแนว" ("ชิล"/"ดราม่า"), ชื่อเพลง, หรือ path ก็ได้ ระบบ resolve ให้เอง. ❌ ไม่อยากได้เพลง = ไม่ต้องส่ง bgmFile. ห้ามบอกว่าใส่เพลงถ้าไม่ได้ส่ง bgmFile. ‼️ BGM เป็นคำถามแยกอิสระจาก avatar — คลิปจะมี avatar + เพลง พร้อมกันก็ได้ (ระบบรองรับ). ห้ามมัด "ไม่ใส่ avatar + ใส่เพลง" เป็นตัวเลือกเดียวกับ avatar modes เด็ดขาด; ต้องถาม BGM ทุกคลิปไม่ว่าจะใส่ avatar หรือไม่.
5) ซับ: ตำแหน่ง (top/middle/bottom) + โหมด (sentence/1/2/3/4 คำ; 3="แนะนำ อ่านง่าย"). ⚠️ โหมด 1–2 คำ ทำให้การ์ดเยอะ = ฉาก b-roll เยอะ = เรนเดอร์นานขึ้นมาก (อาจ 15–20 นาที); ถ้าผู้ใช้ไม่ได้ต้องการ viral-style จัด ๆ แนะนำ 3. ถามด้วยว่าอยากได้ซับขนาด/สไตล์แบบไหน (subtitleSize, subtitleStyle, subtitleColor, subtitleAccentColor — ดูตัวเลือกจาก get_video_options) หรือจะใช้สไตล์ซับของแบรนด์ที่ตั้งไว้ (ส่ง brandProfileId). ⚠️ รอบนี้แบรนด์มีผลกับ "สไตล์ซับ" เท่านั้น — ไม่เปลี่ยนเสียง ภาพ B-roll หรือโลโก้.
6) avatar (พิธีกร AI): ⚠️ avatar เจนผ่าน HeyGen API คิดเงินตามจำนวนวินาที (ไม่ฟรีแม้แผน PRO — แพลนครอบแค่ render ปกติ) ต้องอธิบายให้ผู้ใช้เข้าใจก่อนเลือก แล้วเสนอ:
   - "เปิดอย่างเดียว" (avatar โผล่ช่วงต้นคลิป) = avatarMode "bookend" — ✅ แนะนำ ประหยัด
   - "เปิด-ปิด" (avatar ต้น+ท้าย) = avatarMode "bookend-both" — ✅ แนะนำ ประหยัด
   - "Full" (avatar ทั้งคลิป) = avatarMode "full" — รองรับไม่เกิน 5 นาทีและแพง (จ่ายตามความยาวคลิปเต็ม); ถ้ายาวกว่านี้ให้เลือก bookend
   - ไม่เอา = ไม่ใส่ avatarMode
   ถ้าเอา avatar เสนอตัว avatar จาก get_video_options. ⚠️ ถ้าเลือก "เปิดอย่างเดียว"/"เปิด-ปิด" ต้องถามเสมอว่า "ใช้ avatar กี่วินาที?" → ใส่ avatarIntroSecs (และ avatarTailSecs ถ้าเปิด-ปิด); ถ้าผู้ใช้ไม่ระบุ ใช้ default 5 วินาที. ("Full" ไม่ต้องถามวินาที — ตามทั้งคลิป). จะปรับขนาดก็ใส่ avatarScale (default 1 = พอดีเฟรม).
สรุปยืนยัน (บอกชัดว่าจะส่งอะไรจริง: เสียง/B-roll/เพลง/ซับ/avatar+วินาที) แล้วเรียก create_video_job. จากนั้น poll get_video_status เป็นจังหวะ (ทุก ~60–90 วิ; มี avatar ทุก ~2 นาที; ห้ามถี่ทุกไม่กี่วิ) รายงานความคืบหน้า; ถ้า status=failed ให้อธิบายตาม "userAction" (บอกผู้ใช้ว่าต้องทำอะไรต่อ) และใช้ "errorCode" ประกอบการอธิบาย; บอกเรื่องเงินตามจริง: refunded=true = คืนสิทธิ์/โควต้าให้แล้ว, refundPending=true = กำลังคืนให้ (ยังไม่เสร็จ), ทั้งคู่เป็น false = งานส่วนนั้นถูกคิดไปแล้ว — ห้ามบอกว่าคืนเงินถ้า field ไม่ได้บอกแบบนั้น; ถ้ามี editorUrl ให้ชวนเปิดแก้/export ใหม่จากลิงก์ก่อนเสนอสร้างใหม่; เสร็จแล้ว report ลิงก์ดาวน์โหลด.
ยกเลิกงาน: ถ้าผู้ใช้อยากหยุดหรือเปลี่ยนใจ ให้เรียก cancel_video_job({id}) — ห้ามสั่ง create_video_job ซ้ำด้วยสคริปต์เดิมเพื่อ "แก้" งานที่ยังรันอยู่ (จะเสียโควต้าซ้ำและงานค้างชนลิมิต). ⚠️ ถ้ายกเลิกหลังจากเรนเดอร์หลักเสร็จแล้ว (ช่วง export) ส่วนที่เรนเดอร์เสร็จแล้วยังถูกคิดตามปกติ — บอกผู้ใช้ให้ชัดก่อนยกเลิก. ค่า avatar ที่ HeyGen เจนไปแล้วคิดจากบัญชี HeyGen ของผู้ใช้โดยตรง คืนไม่ได้ทุกกรณี.
⚠️ ห้ามสัญญาว่าจะแจ้งเตือนเอง — MCP ส่ง push ไม่ได้; ให้ผู้ใช้พิมพ์ "เช็ควิดีโอ" เมื่อผ่านไปตาม ETA.`;
