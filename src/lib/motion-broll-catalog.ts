/**
 * Motion B-Roll & HyperFrames Scene Catalog (Phase 1: Theme-locked Motion Style + Brand CI).
 *
 * Pure, deterministic, zero-I/O module shared by:
 * - Remotion renderer (`src/remotion/MotionBrollScene.tsx`, `ShortVideoComposition.tsx`)
 * - B-roll coverage & re-render validation (`broll-coverage.ts`, `broll-rerender.ts`)
 * - Studio Editor V2 (`BrollWindowInspector.tsx`, `StagedBrollPreview.tsx`)
 * - MCP tools (`create_video_job`, `replace_broll_window`, `get_edit_state`, `get_video_options`)
 *
 * Every motion scene uses a canonical virtual URI `motion://<templateId>` in `BrollVideo.src`
 * plus structured `motionTemplate` metadata (`templateId`, `themeId`, `brandCi`, `props`).
 * Because `motion://` is procedural (rendered live in React/Canvas/SVG frame-by-frame),
 * it requires zero external stock/AI calls and zero local `.mp4` probing.
 */

export const MOTION_URI_PREFIX = "motion://";

export const MOTION_THEME_IDS = [
  "doodle-explainer",
  "cue-step-board",
  "hyperframe-kinetic",
] as const;

export type MotionThemeId = (typeof MOTION_THEME_IDS)[number];

export const MOTION_ARCHETYPE_IDS = [
  "hook-character",
  "step-checklist",
  "three-cards-progression",
  "flow-diagram",
  "chart-vs-reality",
  "before-after-split",
  "screen-showcase",
  "price-slash-cta",
] as const;

export type MotionArchetypeId = (typeof MOTION_ARCHETYPE_IDS)[number];

export const MOTION_TEMPLATE_IDS = [
  "doodle.hook-character",
  "doodle.step-checklist",
  "doodle.three-cards-progression",
  "doodle.flow-diagram",
  "doodle.chart-vs-reality",
  "doodle.before-after-split",
  "doodle.screen-showcase",
  "doodle.price-slash-cta",
  "cue.step-checklist",
  "cue.before-after-split",
  "cue.chart-vs-reality",
  "cue.price-slash-cta",
  "hyperframe.kinetic-stat",
  "hyperframe.flow-diagram",
] as const;

export type MotionTemplateId = (typeof MOTION_TEMPLATE_IDS)[number];

export const MOTION_MASCOT_IDS = [
  "stickman-scarf",
  "stickman-glasses",
  "stickman-cap",
  "ai-bot",
] as const;

export type MotionMascotId = (typeof MOTION_MASCOT_IDS)[number];

export type MotionBrandCi = {
  /** Primary brand color (e.g. character scarf, primary stroke/fill accent, main CTA button). */
  primaryColor: string;
  /** Secondary highlight color (e.g. karaoke word highlight, price tag, active badge). */
  accentColor: string;
  /** Background surface color (e.g. warm cream paper, dark navy board). */
  backgroundColor: string;
  /** Brand typography family (e.g. Kanit, Prompt, Sarabun). */
  fontFamily: string;
};

export const CUE_BOARD_STYLES = [
  "terminal-spec",
  "script-table",
  "pronounce-map",
  "audio-waveform",
  "code-editor",
  "lufs-meter",
  "contact-sheet-qa",
  "comment-cta",
] as const;

export type CueBoardStyle = (typeof CUE_BOARD_STYLES)[number];

export type MotionSceneProps = {
  /** Top pill / card header text (<= 48 chars). */
  headerText?: string;
  /** Main title or focal label inside the canvas/card. */
  title?: string;
  /** Subtitle or secondary note (e.g. file path `scout.md` or `voice/script.json`). */
  subtitle?: string;
  /** Bullet items, steps, or flow nodes (up to 6 items). */
  items?: string[];
  /** Left-side comparison or "before / old price" value. */
  leftText?: string;
  /** Right-side comparison or "after / new price" value. */
  rightText?: string;
  /** Highlight badge or callout pill (e.g. "หมดไฟ", "100 เล่มแรก", "STEP 1/9"). */
  badgeText?: string;
  /** Cumulative step labels stacked on the bottom-right of Cue Step Board (e.g. ["ไอเดีย", "บท", "VO"]). */
  stackLabels?: string[];
  /** Specialized rich board layout for Cue Step Board / HyperFrames. */
  boardStyle?: CueBoardStyle;
  /** Optional code/terminal lines for `terminal-spec` / `code-editor` boards. */
  codeLines?: string[];
  /** Background variant within the theme ("sky-desert" | "cream-dots" | "dark-grid"). */
  backgroundVariant?: "sky-desert" | "cream-dots" | "dark-grid";
  /** Character mascot variation ("stickman-scarf" | "stickman-glasses" | "stickman-cap" | "ai-bot"). */
  mascot?: MotionMascotId;
  /** Optional custom HTML/SVG/GSAP snippet for HyperFrames adapter scenes. */
  hyperframeCode?: string;
};

export type MotionTemplateConfig = {
  templateId: MotionTemplateId;
  themeId: MotionThemeId;
  archetypeId?: MotionArchetypeId;
  brandCi?: Partial<MotionBrandCi>;
  props?: MotionSceneProps;
  headerText?: string;
  title?: string;
  subtitle?: string;
  items?: string[];
  leftText?: string;
  rightText?: string;
  badgeText?: string;
  stackLabels?: string[];
  boardStyle?: CueBoardStyle;
  codeLines?: string[];
  backgroundVariant?: "sky-desert" | "cream-dots" | "dark-grid";
  mascot?: MotionMascotId;
  hyperframeCode?: string;
};

export type MotionThemeCatalogEntry = {
  id: MotionThemeId;
  thaiLabel: string;
  englishLabel: string;
  description: string;
};

export const MOTION_THEMES: readonly MotionThemeCatalogEntry[] = [
  {
    id: "doodle-explainer",
    thaiLabel: "การ์ตูนหัวขาวเดินเรื่อง (Doodle Explainer)",
    englishLabel: "Doodle Stickman Explainer",
    description: "ฉากวาดเส้นการ์ตูนหัวขาว ผ้าพันคอสีแบรนด์ ป้ายหัวข้อ และอินโฟกราฟิกขยับตามจังหวะพูด",
  },
  {
    id: "cue-step-board",
    thaiLabel: "กระดานสเต็ปมืด + ไฮไลต์นีออน (Cue Step Board)",
    englishLabel: "Cue Dark Step Board",
    description: "กระดานเอียงโทนเข้ม ป้าย STEP 1..N เช็กลิสต์ กราฟคลื่นเสียง และกล่องคอมเมนต์ CTA",
  },
  {
    id: "hyperframe-kinetic",
    thaiLabel: "กราฟิกตัวเลขและโฟลว์ความเร็วสูง (HyperFrames Kinetic)",
    englishLabel: "HyperFrames Kinetic Canvas",
    description: "โมชันกราฟิก 60fps เน้นตัวเลขสถิติขนาดใหญ่และแผนผังโฟลว์เรืองแสงตามสี Brand CI",
  },
] as const;

export type MotionTemplateCatalogEntry = {
  id: MotionTemplateId;
  themeId: MotionThemeId;
  archetypeId: MotionArchetypeId;
  archetype?: MotionArchetypeId;
  thaiLabel: string;
  description: string;
  defaultBackgroundVariant: "sky-desert" | "cream-dots" | "dark-grid";
  defaultProps: Required<Pick<MotionSceneProps, "headerText" | "title">> & MotionSceneProps;
};

export const DEFAULT_THEME_BRAND_CI: Record<MotionThemeId, MotionBrandCi> = {
  "doodle-explainer": {
    primaryColor: "#EF4444",
    accentColor: "#FACC15",
    backgroundColor: "#FDF8EC",
    fontFamily: "Kanit",
  },
  "cue-step-board": {
    primaryColor: "#A3E635",
    accentColor: "#FACC15",
    backgroundColor: "#0F172A",
    fontFamily: "Kanit",
  },
  "hyperframe-kinetic": {
    primaryColor: "#38BDF8",
    accentColor: "#F43F5E",
    backgroundColor: "#090D16",
    fontFamily: "Kanit",
  },
};

export const MOTION_TEMPLATE_CATALOG: readonly MotionTemplateCatalogEntry[] = [
  {
    id: "doodle.hook-character",
    themeId: "doodle-explainer",
    archetypeId: "hook-character",
    thaiLabel: "การ์ตูนเดินเรื่อง + นาฬิกา/คำถาม",
    description: "ตัวละครหัวขาวเดินบนพื้นทราย พร้อมนาฬิกาเด้งนับเวลาและเครื่องหมายคำถาม",
    defaultBackgroundVariant: "sky-desert",
    defaultProps: {
      headerText: "ทำไมคนดูจนจบ?",
      title: "10 นาที",
      subtitle: "คนดูตามตัวละครที่เดินเรื่อง",
      badgeText: "?",
      backgroundVariant: "sky-desert",
    },
  },
  {
    id: "doodle.three-cards-progression",
    themeId: "doodle-explainer",
    archetypeId: "three-cards-progression",
    thaiLabel: "การ์ด 3 ช่วง (ไฟค่อยๆ หมด)",
    description: "การ์ด 3 ใบเรียงลำดับ ตอน 1, 2, 3 แสดงการเปรียบเทียบหรืออาการหมดไฟ",
    defaultBackgroundVariant: "cream-dots",
    defaultProps: {
      headerText: "ทำเองแล้วหมดไฟ?",
      title: "ทำเองทีละตอน",
      items: ["ตอน 1", "ตอน 2", "ตอน 3"],
      badgeText: "หมดไฟ",
      backgroundVariant: "cream-dots",
    },
  },
  {
    id: "doodle.chart-vs-reality",
    themeId: "doodle-explainer",
    archetypeId: "chart-vs-reality",
    thaiLabel: "กราฟกากบาท vs เช็กลิสต์ทำซ้ำ",
    description: "เปรียบเทียบกราฟที่ถูกกากบาททับ กับกล่องเช็กลิสต์ที่ติ๊กถูกทีละข้อ",
    defaultBackgroundVariant: "sky-desert",
    defaultProps: {
      headerText: "ผลงานจริง",
      title: "วิธีที่ทำซ้ำได้จริง",
      leftText: "สัญญายอดวิว",
      rightText: "ทำซ้ำทุกสัปดาห์",
      items: ["วางโครงเรื่อง", "คุมตัวละคร", "ซับตรงคำพูด", "ตรวจทุกเฟรม"],
      backgroundVariant: "sky-desert",
    },
  },
  {
    id: "doodle.step-checklist",
    themeId: "doodle-explainer",
    archetypeId: "step-checklist",
    thaiLabel: "หนังสือ/คู่มือ + เช็กลิสต์ 4 ข้อ",
    description: "ไอคอนหนังสือหรือคู่มือด้านซ้าย พร้อมรายการติ๊กถูกสีแดงทีละข้อตามจังหวะพูด",
    defaultBackgroundVariant: "cream-dots",
    defaultProps: {
      headerText: "E-book + Agent Skill",
      title: "Doodle Guide",
      items: ["วางซีรีส์", "ตัวละครประจำช่อง", "สูตร Hook", "โครงตอน 8-15 นาที"],
      backgroundVariant: "cream-dots",
    },
  },
  {
    id: "doodle.flow-diagram",
    themeId: "doodle-explainer",
    archetypeId: "flow-diagram",
    thaiLabel: "แผนผัง Flow ลูกศร 4 ขั้น",
    description: "วงกลมไอคอน 4 จุด พร้อมลูกศรโค้งวาดเชื่อมกันตามลำดับขั้นตอน",
    defaultBackgroundVariant: "cream-dots",
    defaultProps: {
      headerText: "ระบบทำงานยังไง?",
      title: "4 ขั้นตอนอัตโนมัติ",
      items: ["บท", "เสียง", "ฉาก", "คลิปยาว + Shorts"],
      backgroundVariant: "cream-dots",
    },
  },
  {
    id: "doodle.before-after-split",
    themeId: "doodle-explainer",
    archetypeId: "before-after-split",
    thaiLabel: "เปรียบเทียบ ซ้าย → ขวา",
    description: "จับคู่เปรียบเทียบแบบเดิม vs แบบใหม่ หรือคำอ่านซ้ายไปขวา",
    defaultBackgroundVariant: "cream-dots",
    defaultProps: {
      headerText: "เปรียบเทียบชัดๆ",
      title: "เปลี่ยนวิธีทำงาน",
      leftText: "ทำมือทั้งวัน",
      rightText: "ใช้เทมเพลตอัตโนมัติ",
      items: ["เขียนโค้ดเอง → เลือกเทมเพลต", "แก้ทีละเฟรม → ระบบซิงค์คำพูด"],
      backgroundVariant: "cream-dots",
    },
  },
  {
    id: "doodle.screen-showcase",
    themeId: "doodle-explainer",
    archetypeId: "screen-showcase",
    thaiLabel: "กรอบจอทีวี / โชว์ผลงาน",
    description: "กรอบจอภาพขนาดใหญ่ตรงกลาง พร้อมตัวละครยืนชี้และป้ายคำอธิบาย",
    defaultBackgroundVariant: "sky-desert",
    defaultProps: {
      headerText: "ดูเพลินเหมือนการ์ตูน",
      title: "วาดด้วยโค้ดทุกเฟรม",
      subtitle: "ดูบนจอทีวีและมือถือได้คมชัด",
      badgeText: "8:00+",
      backgroundVariant: "sky-desert",
    },
  },
  {
    id: "doodle.price-slash-cta",
    themeId: "doodle-explainer",
    archetypeId: "price-slash-cta",
    thaiLabel: "ป้ายลดราคา + ปุ่มสั่งซื้อ/คอมเมนต์",
    description: "ป้ายราคาสีเหลือง ขีดฆ่าราคาเดิม เด้งราคาพิเศษ พร้อมปุ่มกดสั่งซื้อ/คอมเมนต์",
    defaultBackgroundVariant: "cream-dots",
    defaultProps: {
      headerText: "ราคาพิเศษ",
      title: "สั่งซื้อ / คอมเมนต์",
      leftText: "990",
      rightText: "450.-",
      badgeText: "100 เล่มแรก",
      backgroundVariant: "cream-dots",
    },
  },
  {
    id: "cue.step-checklist",
    themeId: "cue-step-board",
    archetypeId: "step-checklist",
    thaiLabel: "บอร์ดขั้นตอนมืด + เช็กลิสต์นีออน",
    description: "การ์ดโค้ดโทนมืดพร้อมแถบ STEP ด้านบนและรายการติ๊กถูกสีเขียวนีออน (สไตล์คลิป Ref 2)",
    defaultBackgroundVariant: "dark-grid",
    defaultProps: {
      headerText: "STEP 1/9",
      title: "เรื่องที่คนอยากรู้คำตอบ",
      items: ["บ้านฉันจะจมไหม?", "เลขจากต้นทาง", "ตรวจข้อมูลจริง"],
      badgeText: "ไอเดีย",
      backgroundVariant: "dark-grid",
    },
  },
  {
    id: "cue.before-after-split",
    themeId: "cue-step-board",
    archetypeId: "before-after-split",
    thaiLabel: "บอร์ดจับคู่คำอ่าน / เปรียบเทียบ",
    description: "การ์ดจับคู่ซ้าย-ขวา พร้อมลูกศรสีเขียวนีออนชี้ทีละบรรทัด",
    defaultBackgroundVariant: "dark-grid",
    defaultProps: {
      headerText: "STEP 3/9",
      title: "ทำรายการคำอ่าน",
      items: ["ChatGPT → แชตจีพีที", "Claude → คลอด", "Gemini → เจมีไน"],
      badgeText: "คำอ่าน",
      backgroundVariant: "dark-grid",
    },
  },
  {
    id: "cue.chart-vs-reality",
    themeId: "cue-step-board",
    archetypeId: "chart-vs-reality",
    thaiLabel: "บอร์ดวัดระดับเสียง / กราฟคลื่น",
    description: "การ์ดแสดงตัวเลขสถิติขนาดใหญ่ พร้อมแถบ Progress Bar และคลื่นเสียง",
    defaultBackgroundVariant: "dark-grid",
    defaultProps: {
      headerText: "STEP 8/9",
      title: "เพลงเบากว่าเสียงพูด",
      leftText: "-15.4 LUFS",
      rightText: "เพลง -10 dB",
      items: ["เสียงพูดชัดสุด", "เอฟเฟกต์ลงตรงจังหวะ"],
      badgeText: "มิกซ์",
      backgroundVariant: "dark-grid",
    },
  },
  {
    id: "cue.price-slash-cta",
    themeId: "cue-step-board",
    archetypeId: "price-slash-cta",
    thaiLabel: "บอร์ดพิมพ์คอมเมนต์ CTA อัตโนมัติ",
    description: "การ์ดสีเขียวนีออนพร้อมช่องค้นหา/คอมเมนต์ที่พิมพ์ข้อความทีละตัวอักษร",
    defaultBackgroundVariant: "dark-grid",
    defaultProps: {
      headerText: "คอมเมนต์รับรายละเอียด",
      title: "พิมพ์คำว่า CUE ใต้คลิป",
      rightText: "cue",
      badgeText: "ส่งให้ในแชต",
      backgroundVariant: "dark-grid",
    },
  },
  {
    id: "hyperframe.kinetic-stat",
    themeId: "hyperframe-kinetic",
    archetypeId: "chart-vs-reality",
    thaiLabel: "HyperFrames Kinetic Stat Card",
    description: "การ์ดตัวเลขพุ่งขึ้นสไตล์โมเดิร์น HTML+GSAP พร้อมกราฟเรืองแสงตามสีแบรนด์",
    defaultBackgroundVariant: "dark-grid",
    defaultProps: {
      headerText: "KINETIC DATA",
      title: "+340%",
      subtitle: "อัตราการดูจนจบเพิ่มขึ้นเมื่อใช้ Motion B-Roll",
      items: ["Frame-accurate", "Brand CI Synced", "Zero Stock Cost"],
      badgeText: "HYPERFRAME",
      backgroundVariant: "dark-grid",
    },
  },
  {
    id: "hyperframe.flow-diagram",
    themeId: "hyperframe-kinetic",
    archetypeId: "flow-diagram",
    thaiLabel: "HyperFrames Timeline Flow",
    description: "แผนผังขั้นตอนโมเดิร์นเรียงการ์ดพร้อมเส้นแสงวิ่งเชื่อมตามจังหวะพูด",
    defaultBackgroundVariant: "dark-grid",
    defaultProps: {
      headerText: "WORKFLOW ENGINE",
      title: "Brand + Motion Pipeline",
      items: ["เลือกธีมช่อง", "AI แปลงบทเป็นฉาก", "ซิงค์สีแบรนด์", "เรนเดอร์ 9:16"],
      badgeText: "AUTO",
      backgroundVariant: "dark-grid",
    },
  },
] as const;

export const MOTION_TEMPLATES: readonly (MotionTemplateCatalogEntry & { archetype: MotionArchetypeId })[] =
  MOTION_TEMPLATE_CATALOG.map((entry) => ({
    ...entry,
    archetype: entry.archetypeId,
  }));

const CATALOG_BY_ID = new Map<MotionTemplateId, MotionTemplateCatalogEntry & { archetype: MotionArchetypeId }>(
  MOTION_TEMPLATES.map((entry) => [entry.id, entry]),
);

export function isMotionThemeId(value: unknown): value is MotionThemeId {
  return typeof value === "string" && (MOTION_THEME_IDS as readonly string[]).includes(value);
}

export function isMotionMascotId(value: unknown): value is MotionMascotId {
  return typeof value === "string" && (MOTION_MASCOT_IDS as readonly string[]).includes(value);
}

export function isMotionTemplateId(value: unknown): value is MotionTemplateId {
  return typeof value === "string" && (MOTION_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function motionTemplateEntry(id: MotionTemplateId): MotionTemplateCatalogEntry & { archetype: MotionArchetypeId } {
  const found = CATALOG_BY_ID.get(id);
  if (!found) {
    throw new Error(`Unknown MotionTemplateId: ${id}`);
  }
  return found;
}

export function motionTemplate(id: unknown): (MotionTemplateCatalogEntry & { archetype: MotionArchetypeId }) | null {
  if (!isMotionTemplateId(id)) return null;
  return CATALOG_BY_ID.get(id) ?? null;
}

export function motionTemplatesForTheme(
  themeId?: MotionThemeId,
): readonly (MotionTemplateCatalogEntry & { archetype: MotionArchetypeId })[] {
  if (!themeId) return MOTION_TEMPLATES;
  return MOTION_TEMPLATES.filter((entry) => entry.themeId === themeId);
}

export function toMotionBrollUri(templateId: MotionTemplateId): string {
  return `${MOTION_URI_PREFIX}${templateId}`;
}

export const buildMotionBrollUri = toMotionBrollUri;

export function isMotionBrollUri(src: unknown): src is `motion://${MotionTemplateId}` {
  if (typeof src !== "string" || !src.startsWith(MOTION_URI_PREFIX)) return false;
  const id = src.slice(MOTION_URI_PREFIX.length).trim();
  return isMotionTemplateId(id);
}

export function parseMotionTemplateIdFromUri(src: unknown): MotionTemplateId | null {
  if (typeof src !== "string" || !src.startsWith(MOTION_URI_PREFIX)) return null;
  const id = src.slice(MOTION_URI_PREFIX.length).trim();
  return isMotionTemplateId(id) ? id : null;
}

function cleanShortString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringArray(value: unknown, maxItems = 6, maxLen = 80): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const cleaned = cleanShortString(item, maxLen);
    if (cleaned) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function normalizeMotionBrandCi(
  raw: unknown,
  themeId: MotionThemeId = "doodle-explainer",
): MotionBrandCi {
  const defaults = DEFAULT_THEME_BRAND_CI[themeId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...defaults };
  const obj = raw as Record<string, unknown>;
  const primaryColor = typeof obj.primaryColor === "string" && HEX_COLOR_RE.test(obj.primaryColor.trim())
    ? obj.primaryColor.trim()
    : defaults.primaryColor;
  const accentColor = typeof obj.accentColor === "string" && HEX_COLOR_RE.test(obj.accentColor.trim())
    ? obj.accentColor.trim()
    : defaults.accentColor;
  const backgroundColor = typeof obj.backgroundColor === "string" && HEX_COLOR_RE.test(obj.backgroundColor.trim())
    ? obj.backgroundColor.trim()
    : defaults.backgroundColor;
  const fontFamily = cleanShortString(obj.fontFamily, 60) ?? defaults.fontFamily;
  return { primaryColor, accentColor, backgroundColor, fontFamily };
}

/** Derive MotionBrandCi automatically from a Brand Profile / StylePack palette & font. */
export function resolveMotionBrandCiFromPalette(input: {
  themeId: MotionThemeId;
  palette?: readonly string[] | null;
  fontFamily?: string | null;
  accentColor?: string | null;
}): MotionBrandCi {
  const defaults = DEFAULT_THEME_BRAND_CI[input.themeId];
  const validColors = (input.palette ?? []).filter(
    (c): c is string => typeof c === "string" && HEX_COLOR_RE.test(c.trim()),
  );
  // For doodle-explainer, palette[1] is typically the vivid primary accent (e.g. #EF4444) and palette[2] is warm paper
  if (input.themeId === "doodle-explainer") {
    return {
      primaryColor: validColors[1] ?? validColors[0] ?? defaults.primaryColor,
      accentColor: (input.accentColor && HEX_COLOR_RE.test(input.accentColor) ? input.accentColor : null) ?? defaults.accentColor,
      backgroundColor: validColors[2] ?? defaults.backgroundColor,
      fontFamily: cleanShortString(input.fontFamily, 60) ?? defaults.fontFamily,
    };
  }
  return {
    primaryColor: validColors[1] ?? defaults.primaryColor,
    accentColor: (input.accentColor && HEX_COLOR_RE.test(input.accentColor) ? input.accentColor : null) ?? validColors[2] ?? defaults.accentColor,
    backgroundColor: validColors[0] ?? defaults.backgroundColor,
    fontFamily: cleanShortString(input.fontFamily, 60) ?? defaults.fontFamily,
  };
}

export function normalizeMotionSceneProps(
  raw: unknown,
  templateId: MotionTemplateId,
): MotionSceneProps {
  const entry = motionTemplateEntry(templateId);
  const defaults = entry.defaultProps;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...defaults };
  }
  const obj = raw as Record<string, unknown>;
  const nested =
    obj.props && typeof obj.props === "object" && !Array.isArray(obj.props)
      ? (obj.props as Record<string, unknown>)
      : null;
  const pick = (key: string) => (nested && nested[key] !== undefined ? nested[key] : obj[key]);

  const headerText = cleanShortString(pick("headerText"), 64) ?? defaults.headerText;
  const title = cleanShortString(pick("title"), 80) ?? defaults.title;
  const subtitle = cleanShortString(pick("subtitle"), 140) ?? defaults.subtitle;
  const items = cleanStringArray(pick("items"), 6, 80) ?? defaults.items;
  const leftText = cleanShortString(pick("leftText"), 64) ?? defaults.leftText;
  const rightText = cleanShortString(pick("rightText"), 64) ?? defaults.rightText;
  const badgeText = cleanShortString(pick("badgeText"), 40) ?? defaults.badgeText;
  const stackLabels = cleanStringArray(pick("stackLabels"), 10, 28) ?? defaults.stackLabels;
  const boardStyleRaw = pick("boardStyle");
  const boardStyle = CUE_BOARD_STYLES.includes(boardStyleRaw as CueBoardStyle)
    ? (boardStyleRaw as CueBoardStyle)
    : defaults.boardStyle;
  const codeLines = cleanStringArray(pick("codeLines"), 8, 80) ?? defaults.codeLines;
  const bgRaw = pick("backgroundVariant");
  const backgroundVariant =
    bgRaw === "sky-desert" || bgRaw === "cream-dots" || bgRaw === "dark-grid"
      ? bgRaw
      : entry.defaultBackgroundVariant;
  const mascotRaw = pick("mascot");
  const mascot = isMotionMascotId(mascotRaw) ? mascotRaw : defaults.mascot;
  const hyperframeCode = cleanShortString(pick("hyperframeCode"), 4000);

  return {
    ...(headerText ? { headerText } : {}),
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(items ? { items } : {}),
    ...(leftText ? { leftText } : {}),
    ...(rightText ? { rightText } : {}),
    ...(badgeText ? { badgeText } : {}),
    ...(stackLabels ? { stackLabels } : {}),
    ...(boardStyle ? { boardStyle } : {}),
    ...(codeLines ? { codeLines } : {}),
    backgroundVariant,
    ...(mascot ? { mascot } : {}),
    ...(hyperframeCode ? { hyperframeCode } : {}),
  };
}

export function normalizeMotionTemplateConfig(
  raw: unknown,
  fallbackTemplateId?: MotionTemplateId,
): MotionTemplateConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (!fallbackTemplateId) return null;
    const entry = motionTemplateEntry(fallbackTemplateId);
    const props = normalizeMotionSceneProps(entry.defaultProps, entry.id);
    return {
      templateId: entry.id,
      themeId: entry.themeId,
      archetypeId: entry.archetypeId,
      brandCi: DEFAULT_THEME_BRAND_CI[entry.themeId],
      props,
      ...props,
    };
  }
  const obj = raw as Record<string, unknown>;
  const templateId = isMotionTemplateId(obj.templateId)
    ? obj.templateId
    : fallbackTemplateId;
  if (!templateId) return null;
  const entry = motionTemplateEntry(templateId);
  const themeId = isMotionThemeId(obj.themeId) ? obj.themeId : entry.themeId;
  const props = normalizeMotionSceneProps(obj, entry.id);
  return {
    templateId: entry.id,
    themeId,
    archetypeId: entry.archetypeId,
    brandCi: normalizeMotionBrandCi(obj.brandCi, themeId),
    props,
    ...props,
  };
}

const THAI_WORD_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("th", { granularity: "word" })
    : null;

/** Trim a Thai/English string at a clean word boundary without cutting words or combining marks. */
export function trimPhraseAtWordBoundary(raw: string, maxChars: number): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  if (THAI_WORD_SEGMENTER) {
    let acc = "";
    for (const seg of THAI_WORD_SEGMENTER.segment(cleaned)) {
      if (acc.length + seg.segment.length > maxChars) break;
      acc += seg.segment;
    }
    const trimmed = acc.trim();
    if (trimmed.length >= Math.min(6, maxChars)) return trimmed;
  }
  const spaceCut = cleaned.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return spaceCut.length >= 6 ? spaceCut : cleaned.slice(0, maxChars).trim();
}

function stripLeadingConjunction(s: string): string {
  return s
    .replace(/^(?:เพราะว่า|เพราะ|แต่ว่า|แต่|แทนที่จะ|จน|แล้ว|ส่วน|และ|หรือ|วันนี้ที่ช่อง|วันนี้|ทำไมช่องของ|ทำไม)\s*/, "")
    .trim();
}

function splitMeaningfulPhrases(text: string, maxItems = 4, maxItemChars = 24): string[] {
  const body = text.replace(/^(?:\d+[.)]\s*|ข้อ(?:ที่)?\s*(?:หนึ่ง|สอง|สาม|สี่|\d+)\s*)/, "").trim();
  const explicitClauses = body
    .split(/[\n·•,|]+|(?:\s+(?:แต่|เพราะ|แทนที่จะ|จน|แล้ว|ส่วน|และ|หรือ)\s+)|(?:\s{2,})/)
    .map((s) => stripLeadingConjunction(s.trim()))
    .filter((s) => s.length >= 3);
  if (explicitClauses.length >= 2) {
    return explicitClauses.slice(0, maxItems).map((c) => trimPhraseAtWordBoundary(c, maxItemChars));
  }
  const spaceParts = body
    .split(/\s+/)
    .map((s) => stripLeadingConjunction(s.trim()))
    .filter((s) => s.length >= 3 && !/^\d+[.)]?$/.test(s));
  if (spaceParts.length >= 2) {
    return spaceParts.slice(0, maxItems).map((c) => trimPhraseAtWordBoundary(c, maxItemChars));
  }
  return [];
}

const DEFAULT_CUE_STEP_STACK = [
  "ไอเดีย",
  "บท",
  "คำอ่าน",
  "VO",
  "ฉาก",
  "ซับ",
  "มิกซ์",
  "QA",
  "โพสต์",
] as const;

/**
 * Deterministic Script-to-Motion-Scene Planner:
 * Inspects each window's Thai/English spoken text, numbers, keywords, and position
 * (hook, body, CTA) to pick the best-fitting MotionTemplateId within the chosen theme
 * and synthesize non-redundant visual cues (never copy-pasting the full subtitle sentence).
 */
export function planMotionSceneForWindow(input: {
  themeId: MotionThemeId;
  windowIndex: number;
  totalWindows: number;
  spokenText?: string;
  captionText?: string;
  clipTitle?: string;
  keyword?: string;
  brandCi?: Partial<MotionBrandCi>;
  mascot?: MotionMascotId;
  propsOverride?: Partial<MotionSceneProps>;
}): MotionTemplateConfig {
  const { themeId, windowIndex, totalWindows } = input;
  const text = (input.spokenText ?? input.captionText ?? "").trim();
  const headerSource = (input.clipTitle ?? input.keyword ?? "").trim();
  const isFirst = windowIndex === 0;
  const isLast = totalWindows > 1 && windowIndex === totalWindows - 1;

  const hasPriceOrCta = /ราคา|บาท|ลดเหลือ|โปรโมชัน|สั่งซื้อ|คอมเมนต์|ทักแชต|พิมพ์คำว่า|พิเศษ|ส่งให้ในแชต/.test(text);
  const hasComparison = /แต่|แทนที่จะ|เทียบกับ|ต่างจาก|เปลี่ยนจาก|ไม่ใช่|vs|→|->/.test(text);
  const hasChartOrStat = /%|เปอร์เซ็นต์|ยอดวิว|กราฟ|สถิติ|เท่า|dB|LUFS|พุ่ง|ตก/.test(text);
  const hasFlowOrSteps = /ตั้งแต่|ขั้นตอน|สเต็ป|step|1\.|2\.|3\.|จาก.*ไป|ระบบ/.test(text.toLowerCase());
  const hasBurnoutOrThree = /หมดไฟ|เหนื่อย|ตอนแรก|ตอนที่|คลิปที่\s*3|สาม/.test(text);
  const hasScreenOrTv = /จอ|ทีวี|youtube|ยูทูบ|มือถือ|เทมเพลต|เฟรม|โค้ด/.test(text.toLowerCase());

  let templateId: MotionTemplateId;

  if (themeId === "doodle-explainer") {
    if (isFirst) {
      templateId = "doodle.hook-character";
    } else if (isLast || hasPriceOrCta) {
      templateId = "doodle.price-slash-cta";
    } else if (hasBurnoutOrThree) {
      templateId = "doodle.three-cards-progression";
    } else if (hasChartOrStat) {
      templateId = "doodle.chart-vs-reality";
    } else if (hasFlowOrSteps) {
      templateId = "doodle.flow-diagram";
    } else if (hasComparison) {
      templateId = "doodle.before-after-split";
    } else if (hasScreenOrTv) {
      templateId = "doodle.screen-showcase";
    } else {
      const rotation: MotionTemplateId[] = [
        "doodle.step-checklist",
        "doodle.flow-diagram",
        "doodle.chart-vs-reality",
        "doodle.screen-showcase",
        "doodle.three-cards-progression",
      ];
      templateId = rotation[windowIndex % rotation.length];
    }
  } else if (themeId === "cue-step-board") {
    if (isLast || hasPriceOrCta) {
      templateId = "cue.price-slash-cta";
    } else if (hasComparison) {
      templateId = "cue.before-after-split";
    } else if (hasChartOrStat) {
      templateId = "cue.chart-vs-reality";
    } else {
      templateId = "cue.step-checklist";
    }
  } else {
    templateId = windowIndex % 2 === 0 ? "hyperframe.kinetic-stat" : "hyperframe.flow-diagram";
  }

  const entry = motionTemplateEntry(templateId);
  const extractedPhrases = splitMeaningfulPhrases(text, 4, 22);

  // Synthesize a concise 2-4 word visual headline (distinct from full spoken sentence)
  const cleanHeader = headerSource.replace(/^STEP\s*\d+\/\d+\s*[·•-]?\s*/i, "").trim();
  const shortTitle =
    cleanHeader ||
    trimPhraseAtWordBoundary(extractedPhrases[0] ?? stripLeadingConjunction(text), 20) ||
    entry.defaultProps.title;

  const numUnitMatch = text.match(/\d[\d,.]*\s*(?:วินาทีแรก|วินาที|นาที|บาท|%|เท่า|ข้อ|ขั้น|ตอน|เล่ม|วิว|วัน|dB|LUFS)/i);
  const numOnlyMatch = text.match(/\d[\d,.]+/);
  const extractedBadge = hasPriceOrCta
    ? "ส่งรายละเอียดในแชต"
    : numUnitMatch
      ? numUnitMatch[0].replace(/\s+/g, " ").trim().slice(0, 18)
      : numOnlyMatch
        ? numOnlyMatch[0].trim().slice(0, 14)
        : entry.defaultProps.badgeText;

  const ctaKeywordMatch =
    text.match(/(?:คอมเมนต์คำว่า|พิมพ์คำว่า|คำว่า)\s*["'“”]?([A-Za-z0-9ก-๙_-]{2,14})["'“”]?/) ??
    text.match(/(?:พิมพ์|คอมเมนต์)\s*["'“”]?([A-Za-z0-9_-]{2,14})["'“”]?/);
  const ctaKeyword = ctaKeywordMatch ? ctaKeywordMatch[1] : undefined;

  const stepHeader =
    themeId === "cue-step-board"
      ? `STEP ${windowIndex + 1}/${Math.max(1, totalWindows)}`
      : trimPhraseAtWordBoundary(cleanHeader || entry.defaultProps.headerText, 24);

  // Pick a specialized rich board layout for Cue Step Board so every window looks like a real app/tool view
  const cueBoardRotation: CueBoardStyle[] = [
    "terminal-spec",
    "script-table",
    "pronounce-map",
    "audio-waveform",
    "code-editor",
    "lufs-meter",
    "contact-sheet-qa",
  ];
  const autoBoardStyle: CueBoardStyle | undefined =
    themeId === "cue-step-board" || themeId === "hyperframe-kinetic"
      ? isLast || hasPriceOrCta
        ? "comment-cta"
        : /เสียง|พากย์|vo|waveform|หายใจ/i.test(text)
          ? "audio-waveform"
          : /lufs|db|เดซิเบล|เพลง|มิกซ์/i.test(text)
            ? "lufs-meter"
            : /โค้ด|เทมเพลต|remotion|hyperframe|brand ci/i.test(text)
              ? "code-editor"
              : /คำอ่าน|เพี้ยน|ออกเสียง/i.test(text)
                ? "pronounce-map"
                : /ตรวจ|เฟรม|ล้นขอบ|qa/i.test(text)
                  ? "contact-sheet-qa"
                  : cueBoardRotation[windowIndex % cueBoardRotation.length]
      : undefined;

  const stackCount = Math.min(DEFAULT_CUE_STEP_STACK.length, Math.max(1, windowIndex + 1));
  const autoStackLabels =
    themeId === "cue-step-board"
      ? DEFAULT_CUE_STEP_STACK.slice(0, stackCount)
      : undefined;

  // Alternate Doodle background between sky-desert and cream-dots for visual rhythm
  const autoBgVariant: "sky-desert" | "cream-dots" | "dark-grid" =
    themeId === "doodle-explainer"
      ? isFirst || isLast || windowIndex % 3 === 0
        ? "sky-desert"
        : "cream-dots"
      : entry.defaultBackgroundVariant;

  const items =
    extractedPhrases.length >= 2
      ? extractedPhrases
      : entry.defaultProps.items;

  const leftText =
    entry.archetypeId === "before-after-split" && extractedPhrases.length >= 2
      ? trimPhraseAtWordBoundary(extractedPhrases[0], 16)
      : entry.defaultProps.leftText;
  const rightText =
    entry.archetypeId === "price-slash-cta" && ctaKeyword
      ? ctaKeyword
      : entry.archetypeId === "before-after-split" && extractedPhrases.length >= 2
        ? trimPhraseAtWordBoundary(extractedPhrases[1], 16)
        : entry.defaultProps.rightText;

  const props = normalizeMotionSceneProps(
    {
      ...entry.defaultProps,
      headerText: stepHeader,
      title: shortTitle,
      subtitle:
        autoBoardStyle === "terminal-spec"
          ? "scout.md · hook-check"
          : autoBoardStyle === "script-table"
            ? "voice/mewsocial-script.json"
            : autoBoardStyle === "pronounce-map"
              ? "brand.json · style-lock"
              : autoBoardStyle === "audio-waveform"
                ? "voice/mewsocial-voice.wav"
                : autoBoardStyle === "code-editor"
                  ? "remotion/MotionBrollScene.tsx"
                  : autoBoardStyle === "lufs-meter"
                    ? "ffmpeg · ebur128 (-15.4 LUFS)"
                    : autoBoardStyle === "contact-sheet-qa"
                      ? "qa · contact-sheet"
                      : trimPhraseAtWordBoundary(text, 60),
      items,
      leftText,
      rightText,
      badgeText: extractedBadge,
      backgroundVariant: autoBgVariant,
      ...(autoStackLabels ? { stackLabels: [...autoStackLabels] } : {}),
      ...(autoBoardStyle ? { boardStyle: autoBoardStyle } : {}),
      ...(input.mascot ? { mascot: input.mascot } : {}),
      ...(input.propsOverride ?? {}),
    },
    templateId,
  );

  return {
    templateId,
    themeId,
    archetypeId: entry.archetypeId,
    brandCi: normalizeMotionBrandCi(input.brandCi, themeId),
    props,
    ...props,
  };
}
