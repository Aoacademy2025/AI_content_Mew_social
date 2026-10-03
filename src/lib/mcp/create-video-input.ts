import { z } from "zod";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { GEMINI_VOICE_STYLES } from "@/lib/gemini-voice-styles";
import { MCP_BROLL_SOURCES } from "@/lib/mcp/broll-source";
import { V2_QUICK_STYLES } from "@/app/(dashboard)/video-editor/_v2/subtitle-style";

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
  cutawayLayout: z.enum(["auto", "fillYourself"]).optional()
    .describe("ใช้ได้เฉพาะเมื่อส่งคลิป: auto = ระบบสลับ B-roll เข้าบางช่วงให้ (ค่าเริ่มต้น); fillYourself = ทุกช่วงเป็นพิธีกร ไม่มี B-roll อัตโนมัติ แล้วค่อยใส่ B-roll เองทีละช่วงด้วย replace_broll_window"),
  idempotencyKey: z.string().max(120).optional(),
} satisfies z.ZodRawShape;

export const createVideoJobInputSchema = z.object(createVideoJobInputShape);
export type CreateVideoJobInput = z.infer<typeof createVideoJobInputSchema>;
