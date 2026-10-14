import { z } from "zod";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { GEMINI_VOICE_STYLES } from "@/lib/gemini-voice-styles";
import { MCP_BROLL_SOURCES } from "@/lib/mcp/broll-source";
import { V2_QUICK_STYLES } from "@/app/(dashboard)/video-editor/_v2/subtitle-style";
import {
  TARGET_DURATION_SEC_MAX,
  TARGET_DURATION_SEC_MIN,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
} from "@/lib/tts-pace";
import {
  TIGHTEN_MAX_MAX_GAP_MS,
  TIGHTEN_MAX_SPEED,
  TIGHTEN_MIN_MAX_GAP_MS,
  TIGHTEN_MIN_SPEED,
} from "@/lib/presenter-tighten";
import {
  HEADLINE_HOOK_PRESETS,
  MAX_HEADLINE_HOOK_DURATION_MS,
  MIN_HEADLINE_HOOK_DURATION_MS,
} from "@/lib/headline-hook";
import { SFX_MODES } from "@/lib/transition-sfx";
import { MAX_STITCH_CLIPS, MIN_STITCH_CLIPS } from "@/lib/presenter-stitch";

const GEMINI_VOICE_IDS = GEMINI_VOICES.map((voice) => voice.id) as [
  (typeof GEMINI_VOICES)[number]["id"],
  ...(typeof GEMINI_VOICES)[number]["id"][],
];

const GEMINI_VOICE_STYLE_IDS = GEMINI_VOICE_STYLES.map((style) => style.id) as [
  (typeof GEMINI_VOICE_STYLES)[number]["id"],
  ...(typeof GEMINI_VOICE_STYLES)[number]["id"][],
];

// Same catalog the web editor's quick-style buttons use (V2_QUICK_STYLES) — never a
// second hardcoded list (T4, Global Constraints "New MCP inputs").
const SUBTITLE_STYLE_IDS = V2_QUICK_STYLES.map((style) => style.key) as [
  (typeof V2_QUICK_STYLES)[number]["key"],
  ...(typeof V2_QUICK_STYLES)[number]["key"][],
];

const HEADLINE_HOOK_PRESET_IDS = [...HEADLINE_HOOK_PRESETS] as [
  (typeof HEADLINE_HOOK_PRESETS)[number],
  ...(typeof HEADLINE_HOOK_PRESETS)[number][],
];

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** Public create_video_job input contract shared by MCP registration and tests. */
export const createVideoJobInputShape = {
  // T14 (G2): optional in the schema only so a clip-only call can omit it; the server still
  // refuses a call with neither `script` nor a clip (`invalid_input`). Agent-neutral (G13): no
  // oneOf/anyOf — the either/or rules live in the descriptions and are validated server-side.
  script: z.string().min(1).max(20000).optional()
    .describe("สคริปต์ที่จะให้พากย์ — จำเป็นเสมอ ยกเว้นเมื่อส่งคลิปพิธีกร (clipUrl หรือ clipUploadId) ซึ่งใช้เสียงในคลิปเองทำซับ"),
  title: z.string().max(200).optional(),
  voiceProvider: z.enum(["gemini", "elevenlabs"]).optional(),
  voiceId: z.string().optional(),
  geminiVoiceName: z.enum(GEMINI_VOICE_IDS).optional(),
  geminiVoiceStyle: z.enum(GEMINI_VOICE_STYLE_IDS).optional(),
  ttsSpeed: z.number().min(TTS_SPEED_MIN).max(TTS_SPEED_MAX).optional()
    .describe("ความเร็วเสียงพากย์ TTS (0.85–1.25; ค่าเริ่มต้น 1.0) — ใช้เฉพาะงานสร้างจาก script"),
  targetDurationSec: z.number().min(TARGET_DURATION_SEC_MIN).max(TARGET_DURATION_SEC_MAX).optional()
    .describe("เป้าหมายความยาวคลิปเป็นวินาที (5–600) — ระบบคำนวณความเร็ว TTS อัตโนมัติในช่วง 0.85x–1.20x เพื่อให้ใกล้เป้าหมายที่สุดโดยยังฟังเป็นธรรมชาติ"),
  avatarMode: z.enum(["none", "full", "bookend", "bookend-both"]).optional(),
  avatarId: z.string().optional(),
  avatarEngine: z.enum(["avatar_iii", "avatar_iv", "avatar_v"]).optional(),
  avatarIntroSecs: z.number().int().min(1).max(30).optional(),
  avatarTailSecs: z.number().int().min(1).max(30).optional(),
  avatarScale: z.number().min(0.1).max(2.5).optional(),
  avatarOffsetX: z.number().min(-2).max(2).optional(),
  avatarOffsetY: z.number().min(-2).max(2).optional(),
  bgmFile: z.string().optional(),
  bgmVolume: z.number().min(0).max(1).optional(),
  subtitleMode: z.enum(["sentence", "1", "2", "3", "4"]).optional(),
  subtitlePosition: z.enum(["top", "middle", "bottom"]).optional(),
  subtitleSize: z.number().int().min(30).max(160).optional(),
  subtitleStyle: z.enum(SUBTITLE_STYLE_IDS).optional()
    .describe("โทนซับ: viral (เด้งไวรัล) | shadow (เงาเข้ม) | outline (ขอบหนา) | clean (มินิมอล)"),
  subtitleColor: z.string().regex(HEX_COLOR).optional(),
  subtitleAccentColor: z.string().regex(HEX_COLOR).optional(),
  highlightKeywords: z.boolean().optional()
    .describe("true = ไฮไลต์คำสำคัญหรือตัวเลขเด่น 1–2 คำต่อการ์ดซับอัตโนมัติด้วยสีเน้น (accentColor)"),
  statCards: z.boolean().optional()
    .describe("true = แสดงการ์ดอินโฟกราฟิก/สถิติตัวเลขเด่น (เช่น 300%, 10x, ฿990) อัตโนมัติบนซีนที่มีข้อมูลตัวเลข"),
  sfxMode: z.enum(SFX_MODES).optional()
    .describe("เอฟเฟกต์เสียงเปลี่ยนฉาก: none (ปิด ค่าเริ่มต้น) | subtle (เสียง whoosh/pop เบา ๆ -18 dB ตอนตัดสลับภาพโดยไม่กลบเสียงพากย์)"),
  headlineHook: z.string().min(1).max(200).optional()
    .describe("ข้อความพาดหัวฮุค 3 วินาทีแรกด้านบนของคลิป (ไม่เกิน 64 ตัวอักษร 2 บรรทัด — ระบบตัดให้พอดีอัตโนมัติ)"),
  headlineHookSubtext: z.string().max(200).optional()
    .describe("ข้อความรองใต้พาดหัวฮุคเปิดคลิป (ไม่เกิน 90 ตัวอักษร 1 บรรทัด)"),
  headlineHookStyle: z.enum(HEADLINE_HOOK_PRESET_IDS).optional()
    .describe("สไตล์การ์ดพาดหัวเปิดคลิป: banner (แถบพาดหัวเต็มความกว้าง) | stat-burst (ป้ายสถิติ/ตัวเลขเด่น) | question-pill (แคปซูลคำถามชวนคิด) | viral | news | clean"),
  headlineHookDurationMs: z.number().int().min(MIN_HEADLINE_HOOK_DURATION_MS).max(MAX_HEADLINE_HOOK_DURATION_MS).optional()
    .describe("ระยะเวลาแสดงพาดหัวเปิดคลิป (3000–20000 ms; ค่าเริ่มต้น 3500 ms)"),
  visualHook: z.string().min(1).max(200).optional()
    .describe("ชื่อเรียกย่อของ headlineHook — ข้อความฮุคเปิดคลิป 3 วินาทีแรก"),
  visualHookStyle: z.enum(HEADLINE_HOOK_PRESET_IDS).optional()
    .describe("ชื่อเรียกย่อของ headlineHookStyle — สไตล์การ์ดฮุคเปิดคลิป (banner | stat-burst | question-pill | viral | news | clean)"),
  brandProfileId: z.string().max(64).optional()
    .describe("ใช้สไตล์ซับของแบรนด์นี้ — ถ้ามีแบรนด์ active แบรนด์เดียว ระบบเลือกให้อัตโนมัติโดยไม่ต้องระบุ"),
  brollSource: z.enum(MCP_BROLL_SOURCES).optional()
    .describe("stock = วิดีโอสต็อกฟรี (ค่าเริ่มต้น), hero-ai-image = ภาพ AI ทุกช่วง, automix = สต็อกผสมภาพ AI"),
  // T6 (ADR 0064, G2): beta-gated server-side (feature_not_enabled otherwise). Omitted = the
  // existing behaviour, byte-identical.
  exportMode: z.enum(["auto", "hold"]).optional()
    .describe("hold = เรนเดอร์ตัวอย่างแล้วพักไว้ให้ตรวจ/แก้ด้วย get_edit_state + set_caption_text ก่อนสั่ง export_video; auto = ส่งออกอัตโนมัติ (ค่าเริ่มต้น)"),
  // T14 (ADR 0065, G2/G28): a presenter clip the customer already has (e.g. made in HeyGen).
  // Beta-gated server-side (feature_not_enabled otherwise). All three omitted = the existing
  // behaviour, byte-identical.
  clipUrl: z.string().max(4096).optional()
    .describe("ลิงก์ https สาธารณะของคลิปพิธีกรแนวตั้ง (mp4/mov/webm) — ระบบดาวน์โหลดเอง แล้วทำวิดีโอจากเสียงในคลิป (ไม่ต้องมี script). ส่ง clipUrl หรือ clipUploadId อย่างใดอย่างหนึ่งเท่านั้น ห้ามส่งทั้งคู่"),
  clipUploadId: z.string().max(64).optional()
    .describe("uploadId จาก create_upload_url(kind: \"presenter\") หลังจาก PUT ไฟล์คลิปพิธีกรแล้ว — ใช้เมื่อคลิปไม่มีลิงก์สาธารณะ. ส่ง clipUploadId หรือ clipUrl อย่างใดอย่างหนึ่งเท่านั้น ห้ามส่งทั้งคู่"),
  clipUrls: z.array(z.string().max(4096)).min(MIN_STITCH_CLIPS).max(MAX_STITCH_CLIPS).optional()
    .describe("รายการลิงก์ https สาธารณะของคลิปพิธีกรแนวตั้ง (1–10 คลิป) — ระบบนำมาต่อเรียงกัน ปรับความละเอียด 1080×1920 30fps และครอสเฟดเสียง 12 ms อัตโนมัติก่อนถอดซับ"),
  clipUploadIds: z.array(z.string().max(64)).min(MIN_STITCH_CLIPS).max(MAX_STITCH_CLIPS).optional()
    .describe("รายการ uploadId จาก create_upload_url(kind: \"presenter\") (1–10 คลิป) — ระบบนำมาต่อเรียงกันตามลำดับพร้อมครอสเฟดเสียง 12 ms อัตโนมัติก่อนถอดซับ"),
  cutawayLayout: z.enum(["auto", "fillYourself"]).optional()
    .describe("ใช้ได้เฉพาะเมื่อส่งคลิป: auto = ระบบสลับ B-roll เข้าบางช่วงให้ (ค่าเริ่มต้น); fillYourself = ทุกช่วงเป็นพิธีกร ไม่มี B-roll อัตโนมัติ แล้วค่อยใส่ B-roll เองทีละช่วงด้วย replace_broll_window"),
  tighten: z.boolean().optional()
    .describe("ใช้เฉพาะเมื่อส่งคลิปพิธีกร (clipUrl / clipUploadId): true = ตัดช่องว่างเงียบ > 400 ms เหลือ 100 ms พร้อมครอสเฟดเสียง 12 ms และเร่งจังหวะ 1.10x อัตโนมัติก่อนถอดซับ"),
  tightenMaxGapMs: z.number().int().min(TIGHTEN_MIN_MAX_GAP_MS).max(TIGHTEN_MAX_MAX_GAP_MS).optional()
    .describe("ใช้คู่กับคลิปพิธีกร: ความยาวช่องว่างเงียบขั้นต่ำที่จะตัดออก (250–2000 ms; ค่าเริ่มต้น 400 ms)"),
  tightenSpeed: z.number().min(TIGHTEN_MIN_SPEED).max(TIGHTEN_MAX_SPEED).optional()
    .describe("ใช้คู่กับคลิปพิธีกร: ความเร็วคลิปหลังตัดช่องว่างเงียบ (1.0–1.25; ค่าเริ่มต้น 1.10)"),
  punchZoom: z.boolean().optional()
    .describe("true = ซูมสลับจังหวะ 1.00x ↔ 1.15x บนภาพพิธีกรอัตโนมัติตามรอยตัดหรือประโยค โดยไม่กระทบตำแหน่งซับไตเติล"),
  quoteId: z.string().min(1).max(64).optional(),
  idempotencyKey: z.string().max(120).optional(),
} satisfies z.ZodRawShape;

export const createVideoJobInputSchema = z.object(createVideoJobInputShape);
export type CreateVideoJobInput = z.infer<typeof createVideoJobInputSchema>;

/** Preparation supports external before the execution/edit lane is enabled. */
export const prepareVideoJobInputShape = {
  resumeJobId: z.string().min(1).max(64).optional().describe("ขอใบยืนยันเพิ่มเติมใหม่สำหรับงาน confirmation_required ที่บันทึกไว้แล้ว"),
  ...createVideoJobInputShape,
  brollSource: z.enum(MCP_BROLL_SOURCES).optional()
    .describe("stock = สต็อก, hero-ai-image = ภาพ AI, automix = สต็อกผสมภาพ AI, external = นำเข้าสื่อจากเครื่องมือของคุณ ไม่ใช้เครดิต Hero สร้างภาพ"),
} satisfies z.ZodRawShape;
export const prepareVideoJobInputSchema = z.object(prepareVideoJobInputShape);
export type PrepareVideoJobInput = z.infer<typeof prepareVideoJobInputSchema>;
