import type { BrollTransition } from "@/lib/broll-window-style";
import {
  normalizeSubtitleStylePresetConfig,
  type SubtitleCardLen,
  type SubtitleStylePresetConfig,
} from "@/lib/editor-style-preset-contract";
import type { GeminiVoiceStyleId } from "@/lib/gemini-voice-styles";
import {
  applyHeadlineHookPatchWithFallback,
  createDefaultHeadlineHook,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
  type HeadlineHookPreset,
} from "@/lib/headline-hook";
import {
  activeStylePacks,
  isActiveStylePackId,
  stylePack,
  stylePackSubtitlePreset,
  type ActiveStylePackId,
  type MusicMood,
  type PacingLevel,
  type StockMood,
  type StylePack,
} from "@/lib/style-pack-catalog";
import type { SfxMode } from "@/lib/transition-sfx";

export const TEMPLATE_VOICE_STYLE_BY_ID: Record<ActiveStylePackId, GeminiVoiceStyleId> = {
  "thai-ghost": "serious",
  "thai-history": "warm",
  "life-drama": "warm",
  "finance-clear": "serious",
  "news-fast": "excited",
  "health-simple": "warm",
  "premium-product": "warm",
  "comic-story": "excited",
  "shop-review": "cheerful",
  "listicle-fast": "excited",
  "ai-tech-doc": "serious",
  "true-crime": "serious",
  "self-growth": "warm",
};

export const TEMPLATE_TTS_SPEED_BY_PACING: Record<PacingLevel, number> = {
  slow: 0.94,
  normal: 1,
  fast: 1.08,
};

export type Step1TemplateDefaults = {
  templateId: ActiveStylePackId;
  thaiLabel: string;
  tagline: string;
  palette: [string, string, string];
  pacing: PacingLevel;
  ttsSpeed: number;
  geminiVoiceStyle: GeminiVoiceStyleId;
  musicMood: MusicMood;
  stockMood: StockMood;
  subtitleDefault: SubtitleStylePresetConfig;
  headlineHookPreset: HeadlineHookPreset;
  headlineHook?: HeadlineHookConfig;
  highlightKeywords: boolean;
  statCards: boolean;
  sfxMode: SfxMode;
  punchZoom: boolean;
  brollTransition: BrollTransition;
};

export function resolveStep1TemplateDefaults(
  templateId: ActiveStylePackId,
  options?: {
    currentHeadlineHook?: HeadlineHookConfig | null;
    scriptText?: string;
    estimatedDurationMs?: number;
  },
): Step1TemplateDefaults {
  const pack = stylePack(templateId);
  const rawSubtitle = stylePackSubtitlePreset(pack);
  const subtitleDefault = normalizeSubtitleStylePresetConfig(rawSubtitle) ?? rawSubtitle;
  const durationMs = Math.max(1_000, options?.estimatedDurationMs ?? 60_000);
  const existingHook = options?.currentHeadlineHook ?? null;
  const sourceText = options?.scriptText?.trim() ?? "";

  let headlineHook: HeadlineHookConfig | undefined;
  if (existingHook && existingHook.headline.trim().length > 0) {
    headlineHook = normalizeHeadlineHook(
      { ...existingHook, preset: pack.headlineHookPreset, enabled: true },
      durationMs,
      subtitleDefault.verticalPos,
    ) ?? undefined;
  } else if (sourceText.length > 0) {
    const seeded = applyHeadlineHookPatchWithFallback(
      createDefaultHeadlineHook(sourceText, durationMs),
      { preset: pack.headlineHookPreset, enabled: true },
      sourceText,
      durationMs,
    );
    headlineHook = normalizeHeadlineHook(seeded, durationMs, subtitleDefault.verticalPos) ?? undefined;
  }

  return {
    templateId,
    thaiLabel: pack.thaiLabel,
    tagline: pack.tagline,
    palette: pack.palette,
    pacing: pack.pacing,
    ttsSpeed: TEMPLATE_TTS_SPEED_BY_PACING[pack.pacing],
    geminiVoiceStyle: TEMPLATE_VOICE_STYLE_BY_ID[templateId],
    musicMood: pack.musicMood,
    stockMood: pack.stockMood,
    subtitleDefault,
    headlineHookPreset: pack.headlineHookPreset,
    ...(headlineHook ? { headlineHook } : {}),
    highlightKeywords: pack.highlightKeywords,
    statCards: pack.statCards,
    sfxMode: pack.sfxMode,
    punchZoom: pack.punchZoom,
    brollTransition: pack.brollTransition,
  };
}

export type PostTemplateResolution = {
  pack: StylePack;
  templateId: ActiveStylePackId;
  subtitlePreset: SubtitleStylePresetConfig;
  subtitleConfig: Omit<SubtitleStylePresetConfig, "cardLen">;
  cardLen: SubtitleCardLen;
  headlineHook: HeadlineHookConfig | null;
  highlightKeywords: boolean;
  statCards: boolean;
  sfxMode: SfxMode;
  punchZoom: boolean;
  brollTransition: BrollTransition;
  musicMood: MusicMood;
};

/**
 * Pure post-render template transformation shared by Web `usePostPhaseEditor` and
 * MCP `apply_video_template`. Preserves existing headline hook text when present, or
 * seeds from `headlineSourceText` when available so the template's hook card renders.
 */
export function resolveTemplatePostEdit(input: {
  templateId: ActiveStylePackId;
  currentHeadlineHook?: HeadlineHookConfig | null;
  headlineSourceText?: string;
  totalDurationMs: number;
}): PostTemplateResolution {
  const pack = stylePack(input.templateId);
  const rawPreset = stylePackSubtitlePreset(pack);
  const subtitlePreset = normalizeSubtitleStylePresetConfig(rawPreset) ?? rawPreset;
  const { cardLen, ...subtitleConfig } = subtitlePreset;
  const durationMs = Math.max(1_000, input.totalDurationMs || 60_000);
  const sourceText = input.headlineSourceText?.trim() ?? "";
  const existing = input.currentHeadlineHook ?? null;

  const baseHook = existing && existing.headline.trim().length > 0
    ? existing
    : createDefaultHeadlineHook(sourceText, durationMs);
  const patchedHook = applyHeadlineHookPatchWithFallback(
    baseHook,
    { preset: pack.headlineHookPreset, enabled: true },
    sourceText,
    durationMs,
  );
  const headlineHook = normalizeHeadlineHook(
    patchedHook,
    durationMs,
    subtitleConfig.verticalPos,
  );

  return {
    pack,
    templateId: input.templateId,
    subtitlePreset,
    subtitleConfig,
    cardLen,
    headlineHook,
    highlightKeywords: pack.highlightKeywords,
    statCards: pack.statCards,
    sfxMode: pack.sfxMode,
    punchZoom: pack.punchZoom,
    brollTransition: pack.brollTransition,
    musicMood: pack.musicMood,
  };
}

import type { MotionThemeId } from "@/lib/motion-broll-catalog";

export type FlagshipMotionStep1Preset = {
  id: string;
  motionThemeId: MotionThemeId;
  templateId: ActiveStylePackId;
  thaiLabel: string;
  shortLabel: string;
  tagline: string;
  palette: [string, string, string];
  sampleScript: string;
};

/**
 * HERO-133: Flagship 60fps Motion B-Roll presets surfaced directly inside Step 1
 * Styled Templates & Empty-State Starter Strip (0 AI credits, no stock keys required).
 */
export const FLAGSHIP_MOTION_STEP1_PRESETS: readonly FlagshipMotionStep1Preset[] = [
  {
    id: "motion-paper-cutout",
    motionThemeId: "paper-cutout-doc",
    templateId: "news-fast",
    thaiLabel: "Paper Cutout · ข่าวเจาะลึก",
    shortLabel: "Paper Cutout",
    tagline: "โมชันกระดาษตัดแปะ 60fps · 0 เครดิต",
    palette: ["#1A1917", "#F3EFE6", "#E63946"],
    sampleScript: [
      "ทำไมคนทำคลิปสั้นยุคนี้ถึงเลิกตัดภาพประกอบทีละซีนเองแล้ว",
      "เหตุผลแรกคือคนดูตัดสินใจใน 2 วินาทีแรก ถ้าภาพนิ่งเกินไปคนปัดผ่านทันที",
      "เหตุผลที่สองคือกราฟิกสไตล์กระดาษตัดแปะช่วยให้เรื่องยากเข้าใจง่ายขึ้นทันที",
      "และสุดท้ายคือระบบจัดจังหวะตัวเลขกับไฮไลต์คำสำคัญให้ตรงเสียงพูดอัตโนมัติ",
      "ลองแก้หัวข้อนี้เป็นเรื่องของคุณ แล้วกดถัดไปเพื่อดูตัวอย่างคลิปได้เลย",
    ].join("\n"),
  },
  {
    id: "motion-social-chat",
    motionThemeId: "social-chat-sim",
    templateId: "shop-review",
    thaiLabel: "Social Chat · แชตรีวิวไวรัล",
    shortLabel: "Social Chat",
    tagline: "จำลองแชตเด้งโต้ตอบ 60fps · 0 เครดิต",
    palette: ["#0F172A", "#38BDF8", "#F472B6"],
    sampleScript: [
      "ลูกค้าทักมาถามบ่อยมากว่าเริ่มต้นใช้งานยังไงให้เห็นผลไวที่สุด",
      "ขั้นตอนแรก เลือกปัญหาที่คนดูเจอบ่อยที่สุดมาเปิดประโยคแรกให้ตรงจุด",
      "ขั้นตอนที่สอง ยกตัวอย่างผลลัพธ์จริงที่เข้าใจได้ในประโยคเดียว",
      "ขั้นตอนที่สาม ปิดท้ายด้วยทางเลือกง่าย ๆ ที่ทำตามได้ทันทีวันนี้",
      "พิมพ์สคริปต์ของคุณแทนที่ข้อความนี้ แล้วกดสร้างคลิปได้เลย",
    ].join("\n"),
  },
  {
    id: "motion-apple-bento",
    motionThemeId: "apple-bento-glass",
    templateId: "ai-tech-doc",
    thaiLabel: "Apple Bento · สรุปตัวเลขพรีเมียม",
    shortLabel: "Apple Bento",
    tagline: "การ์ดกระจกสรุปสถิติ 60fps · 0 เครดิต",
    palette: ["#090D16", "#60A5FA", "#A78BFA"],
    sampleScript: [
      "สรุป 3 ตัวชี้วัดสำคัญที่ทำให้คลิปความรู้มียอดดูจนจบเพิ่มขึ้นเท่าตัว",
      "ข้อที่ 1 เปิดด้วยตัวเลขหรือผลลัพธ์ที่ชัดเจนตั้งแต่วินาทีแรก",
      "ข้อที่ 2 แบ่งเนื้อหาเป็นการ์ดสั้น ๆ ประโยคละหนึ่งประเด็นไม่ยืดเยื้อ",
      "ข้อที่ 3 ใช้ภาพกราฟิกสรุปข้อมูลแทนการพูดลอย ๆ เพื่อให้คนจดจำได้ทันที",
      "ปรับตัวเลขและเนื้อหาให้ตรงกับธุรกิจของคุณ แล้วกดถัดไปได้เลย",
    ].join("\n"),
  },
];

export function findFlagshipMotionPreset(
  motionThemeId: string | null | undefined,
): FlagshipMotionStep1Preset | null {
  if (!motionThemeId) return null;
  return FLAGSHIP_MOTION_STEP1_PRESETS.find((p) => p.motionThemeId === motionThemeId) ?? null;
}

export { activeStylePacks, isActiveStylePackId };
