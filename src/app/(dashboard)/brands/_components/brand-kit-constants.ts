import type { BrandDefaultBrollSource } from "@/lib/brand-profile-seed";
import type { HeadlineHookPreset } from "@/lib/headline-hook";
import type { MotionMascotId, MotionThemeId } from "@/lib/motion-broll-catalog";
import { ACTIVE_STYLE_PACK_IDS, type MusicMood, type PacingLevel, type StylePackId } from "@/lib/style-pack-catalog";
import type { SubPreset, SubTextEffect } from "@/app/(dashboard)/video-editor/_components/types";

export const MOTION_THEME_META: Record<
  MotionThemeId,
  { shortLabel: string; tagline: string; bestFor: string }
> = {
  "apple-bento-glass": {
    shortLabel: "Apple Bento",
    tagline: "การ์ดกระจกใส + ตัวเลขวิ่ง 60fps",
    bestFor: "เทค · สรุปฟีเจอร์ · เปรียบเทียบ",
  },
  "paper-cutout-doc": {
    shortLabel: "Paper Cutout",
    tagline: "ตัดแปะสารคดี + ปากกาไฮไลต์สด",
    bestFor: "ข่าว · สารคดี · เจาะลึก",
  },
  "social-chat-sim": {
    shortLabel: "Social Chat",
    tagline: "แชตเด้ง + แจ้งเตือนไวรัล",
    bestFor: "รีวิว · Q&A · เล่าเรื่องแชต",
  },
  "doodle-explainer": {
    shortLabel: "Doodle Explainer",
    tagline: "การ์ตูนหัวขาวเดินเรื่อง + เช็กลิสต์",
    bestFor: "ความรู้ · ฮาวทู · เล่าเรื่องเพลิน",
  },
  "cue-step-board": {
    shortLabel: "Cue Step Board",
    tagline: "บอร์ดสเต็ปมืด + ไฮไลต์นีออน",
    bestFor: "ขั้นตอน 1-2-3 · โค้ด · เวิร์กโฟลว์",
  },
  "hyperframe-kinetic": {
    shortLabel: "HyperFrames Kinetic",
    tagline: "กราฟิกตัวเลขและโฟลว์ความเร็วสูง",
    bestFor: "สถิติ · ธุรกิจ · การเงิน",
  },
};

export const MOTION_THEME_DISPLAY_ORDER: readonly MotionThemeId[] = [
  "apple-bento-glass",
  "paper-cutout-doc",
  "social-chat-sim",
  "doodle-explainer",
  "cue-step-board",
  "hyperframe-kinetic",
] as const;

export const MOTION_MASCOT_META: readonly {
  id: MotionMascotId;
  label: string;
  desc: string;
}[] = [
  { id: "stickman-scarf", label: "ผ้าพันคอ", desc: "สีตาม Brand CI" },
  { id: "stickman-glasses", label: "แว่นตา", desc: "สายอธิบาย/กูรู" },
  { id: "stickman-cap", label: "หมวกแก๊ป", desc: "สายสตรีท/ไวรัล" },
  { id: "ai-bot", label: "หุ่น AI", desc: "สายเทค/ระบบอัตโนมัติ" },
] as const;

export const VISUAL_MODE_OPTIONS: readonly {
  id: BrandDefaultBrollSource;
  title: string;
  badge: string;
  desc: string;
  proOnly?: boolean;
}[] = [
  {
    id: "motion",
    title: "Motion B-Roll",
    badge: "ฟรี · 0 เครดิต",
    desc: "กราฟิก 60fps คุมสีแบรนด์อัตโนมัติ 6 ธีม",
  },
  {
    id: "stock",
    title: "สต็อก & AutoMix",
    badge: `${ACTIVE_STYLE_PACK_IDS.length} ชุดสไตล์`,
    desc: "วิดีโอสต็อกฟรี หรือผสมภาพ AI อัตโนมัติ",
  },
  {
    id: "kie-image",
    title: "ภาพ AI แบรนด์",
    badge: "PRO",
    desc: "สร้างภาพ AI เฉพาะแบรนด์ทุกฉาก",
    proOnly: true,
  },
] as const;

export const CURATED_BRAND_SWATCHES: readonly string[] = [
  "#0B0F1A",
  "#18181B",
  "#F6F1E3",
  "#FFFFFF",
  "#8B5CF6",
  "#EF4444",
  "#F43F5E",
  "#FB923C",
  "#FACC15",
  "#10B981",
  "#0EA5E9",
  "#A3E635",
] as const;

export const PALETTE_SLOT_LABELS = [
  { role: "สีพื้นหลัง", hint: "โทนพื้นและบรรยากาศหลัก" },
  { role: "สีหลัก (Brand CI)", hint: "สีเด่นประจำช่องและกราฟิก" },
  { role: "สีไฮไลต์", hint: "สีเน้นคำสำคัญและตัวเลข" },
] as const;

export const MUSIC_MOOD_LABELS: Record<MusicMood, string> = {
  calm: "สบาย ๆ อ่านเพลิน",
  upbeat: "สดใส มีพลัง",
  lounge: "พรีเมียม เรียบหรู",
  emotional: "อบอุ่น ดราม่า",
  epic: "ยิ่งใหญ่ น่าติดตาม",
  serious: "จริงจัง น่าเชื่อถือ",
  tense: "ตึงเครียด ชวนลุ้น",
  ominous: "ลึกลับ กดดัน",
  eerie: "หลอน สยองขวัญ",
  traditional: "ไทยร่วมสมัย",
};

export const HEADLINE_HOOK_PRESET_META: Record<
  HeadlineHookPreset,
  { label: string; desc: string }
> = {
  viral: { label: "ไวรัลเด่น", desc: "ป้ายสีเน้นดึงสายตา 3 วิแรก" },
  news: { label: "ข่าวด่วน", desc: "แถบข่าวคมชัด น่าเชื่อถือ" },
  clean: { label: "มินิมอล", desc: "โปร่งสะอาด อ่านง่าย" },
  banner: { label: "แบนเนอร์", desc: "แถบคาดหัวชัดเต็มเฟรม" },
  "stat-burst": { label: "ตัวเลขพุ่ง", desc: "เน้นสถิติและตัวเลขสำคัญ" },
  "question-pill": { label: "คำถามชวนหยุด", desc: "แคปซูลคำถามกระตุ้นความอยากรู้" },
};

export const BRAND_SUBTITLE_QUICK_STYLES: readonly {
  key: string;
  label: string;
  desc: string;
  preset: SubPreset;
  effect: SubTextEffect;
  textColor: string;
  accentColor: string;
  shadow: boolean;
  outline: boolean;
}[] = [
  {
    key: "viral",
    label: "เด้งไวรัล",
    desc: "ขอบคม + เด้งตามคำพูด",
    preset: "stroke",
    effect: "bounce",
    textColor: "#FFFFFF",
    accentColor: "#FFE500",
    shadow: true,
    outline: false,
  },
  {
    key: "hormozi",
    label: "Hormozi",
    desc: "ไฮไลต์สลับสีพลังสูง",
    preset: "hormozi",
    effect: "pop",
    textColor: "#FFFFFF",
    accentColor: "#FFE500",
    shadow: true,
    outline: false,
  },
  {
    key: "shadow",
    label: "เงาเข้ม",
    desc: "เงาละมุน อ่านง่ายทุกฉาก",
    preset: "bold-shadow",
    effect: "fade",
    textColor: "#FFFFFF",
    accentColor: "#FACC15",
    shadow: true,
    outline: false,
  },
  {
    key: "clean",
    label: "มินิมอล",
    desc: "กล่องมนสะอาดตา",
    preset: "box-rounded",
    effect: "fade",
    textColor: "#FFFFFF",
    accentColor: "#8B5CF6",
    shadow: false,
    outline: false,
  },
  {
    key: "karaoke",
    label: "คาราโอเกะกล่อง",
    desc: "แถบสีวิ่งตามคำพูด",
    preset: "karaoke-box",
    effect: "pop",
    textColor: "#FFFFFF",
    accentColor: "#8B5CF6",
    shadow: true,
    outline: false,
  },
  {
    key: "news",
    label: "ข่าว & รีวิว",
    desc: "แถบคมชัดสไตล์ข่าวสั้น",
    preset: "news",
    effect: "quick",
    textColor: "#FFFFFF",
    accentColor: "#0EA5E9",
    shadow: true,
    outline: false,
  },
] as const;

export const BRAND_SUBTITLE_FONTS = [
  { value: "Kanit", label: "Kanit", note: "หนา คม ชัด" },
  { value: "Prompt", label: "Prompt", note: "โมเดิร์น สะอาด" },
  { value: "Sarabun", label: "Sarabun", note: "อ่านสบายตา" },
  { value: "Mitr", label: "Mitr", note: "โค้ง เป็นกันเอง" },
  { value: "Noto Sans Thai", label: "Noto Sans", note: "เรียบมาตรฐาน" },
] as const;

export const PACING_BADGE_LABELS: Record<PacingLevel, string> = {
  fast: "ตัดไว",
  normal: "จังหวะกำลังดี",
  slow: "เนิบซึ้ง",
};

/** Visual metadata rendered on each Video Style Poster Card so creators immediately
 * recognize the video genre, subtitle energy, and trending status. */
export const STYLE_PACK_CARD_META: Partial<
  Record<StylePackId, { badge?: string; badgeTone?: "trending" | "new" | "popular"; sampleCaption: string; accentWord: string }>
> = {
  "shop-review": {
    badge: "ฮิต · ปักตะกร้า",
    badgeTone: "trending",
    sampleCaption: "ของมันต้องมี",
    accentWord: "คุ้มจริง!",
  },
  "listicle-fast": {
    badge: "ไวรัล · ตัดไว",
    badgeTone: "trending",
    sampleCaption: "3 ข้อลับที่",
    accentWord: "คนพลาด",
  },
  "ai-tech-doc": {
    badge: "ใหม่ · เทรนด์ AI",
    badgeTone: "new",
    sampleCaption: "AI เปลี่ยนโลก",
    accentWord: "ในปีนี้",
  },
  "true-crime": {
    badge: "ใหม่ · ยอดวิวพุ่ง",
    badgeTone: "new",
    sampleCaption: "เงื่อนงำลับ",
    accentWord: "คืนเกิดเหตุ",
  },
  "self-growth": {
    badge: "ใหม่ · ลงทุกวัน",
    badgeTone: "new",
    sampleCaption: "เริ่มวันนี้",
    accentWord: "อย่ารอพร้อม",
  },
  "comic-story": {
    badge: "แชร์สูง",
    badgeTone: "popular",
    sampleCaption: "จุดหักมุมที่",
    accentWord: "ไม่มีใครคาด",
  },
  "thai-ghost": {
    badge: "ดูจนจบสูง",
    badgeTone: "popular",
    sampleCaption: "เสียงเคาะตอน",
    accentWord: "ตีสาม...",
  },
  "life-drama": {
    badge: "ยอดนิยม",
    badgeTone: "popular",
    sampleCaption: "เรื่องจริงที่",
    accentWord: "กระทบใจ",
  },
  "finance-clear": {
    sampleCaption: "สูตรออมเงิน",
    accentWord: "+300%",
  },
  "news-fast": {
    sampleCaption: "สรุปด่วนใน",
    accentWord: "30 วิ",
  },
  "health-simple": {
    sampleCaption: "แค่ปรับเรื่องนี้",
    accentWord: "หลับสนิท",
  },
  "thai-history": {
    sampleCaption: "บันทึกเก่าที่",
    accentWord: "หลายคนไม่รู้",
  },
  "premium-product": {
    sampleCaption: "นิยามใหม่ของ",
    accentWord: "ความเรียบหรู",
  },
};

export const TTS_SPEED_OPTIONS = [
  { value: 0.9, label: "0.9x", note: "ช้าลง" },
  { value: 1, label: "1.0x", note: "ปกติ" },
  { value: 1.1, label: "1.1x", note: "กระชับ" },
  { value: 1.15, label: "1.15x", note: "ไว" },
  { value: 1.2, label: "1.2x", note: "เร็วมาก" },
] as const;

export function resolveEffectiveBrollSource(
  visual: { defaultBrollSource?: BrandDefaultBrollSource | null; motionThemeId?: MotionThemeId | null },
  subtitleConfig?: Record<string, string | number | boolean | null> | null,
): BrandDefaultBrollSource {
  if (visual.defaultBrollSource === "motion" || visual.defaultBrollSource === "stock" || visual.defaultBrollSource === "automix" || visual.defaultBrollSource === "kie-image") {
    return visual.defaultBrollSource;
  }
  const hasMotion = Boolean(visual.motionThemeId) || (typeof subtitleConfig?.motionThemeId === "string" && subtitleConfig.motionThemeId.length > 0);
  return hasMotion ? "motion" : "stock";
}
