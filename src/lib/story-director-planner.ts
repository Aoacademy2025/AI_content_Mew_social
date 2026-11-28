/**
 * Shared AI Story Director Planner (`src/lib/story-director-planner.ts`).
 *
 * Supports BOTH:
 *   1. Vision-directed plans (`buildStoryDirectorPlanFromVisionSelection`) produced by
 *      `Gemini 4 Neon` / `Gemini 3.8 Flash` on Web — or by the customer's own MCP agent
 *      (e.g. `Claude Opus 5.5`) after inspecting 1fps Timestamped Contact Sheets!
 *   2. Deterministic fallback plans (`buildStoryDirectorPlan`) when no vision LLM is invoked.
 *
 * Also supports two narration styles (`StoryVoiceMode`):
 *   - `"real-moments"` (default TikTok Vlog style): NO robotic AI narrator talking over the
 *     whole video — uses real clip speech/cheers (`keepClipAudio`), upbeat music, SFX, and
 *     punchy action-matched Thai reaction captions on each shot!
 *   - `"tts"`: Synthesizes concise Thai AI voiceover synced to the Storyboard.
 */

import {
  DEFAULT_STORY_BPM,
  planBeatSyncedStoryCuts,
  type StoryCandidateClip,
} from "@/lib/beat-sync-plan";
import {
  faceBoxesFromVisionZone,
  type FaceBox,
  type VisionFaceZone,
} from "@/lib/face-safe-placement";
import { trimPhraseAtWordBoundary } from "@/lib/motion-broll-catalog";
import { normalizeStoryOverlays, type StoryOverlayItem } from "@/lib/story-overlays";
import {
  isActiveStylePackId,
  stylePack,
  type ActiveStylePackId,
  type StoryDirectorPackRecipe,
} from "@/lib/style-pack-catalog";
import type { BrollVideo } from "@/remotion/types";

export type StoryVoiceMode = "real-moments" | "tts";
export type StoryDirectorModelTier = "neon" | "flash";

export interface StoryMomentCaption {
  text: string;
  startMs: number;
  endMs: number;
  tag?: "hook" | "body" | "cta";
}

export interface AnalyzedFootageItem {
  id?: string;
  src: string;
  filename?: string;
  durationSec: number;
  stillImage?: boolean;
  hasAudio?: boolean;
  hasSpeechOrCheer?: boolean;
  isLivePhotoCadence?: boolean;
  sourceFps?: number | null;
  faceBoxes?: FaceBox[];
  transcriptSnippet?: string;
  bestOffsetSec?: number;
}

export interface StoryboardCardSummary {
  index: number;
  badge: string;
  timeLabel: string;
  title: string;
  detail: string;
}

export interface VisionSelectedShot {
  clipIndex: number;
  inSec: number;
  outSec: number;
  role?: "cold-open" | "hero-freeze" | "mission-1" | "mission-2" | "slow-mo-peak" | "blooper" | "body";
  keepClipAudio?: boolean;
  slowMo?: boolean;
  heroFreeze?: boolean;
  captionText?: string;
  visualCheck?: string;
  /** Optional Vision AI portrait face vertical region for this shot (`inSec..outSec`). */
  faceZone?: VisionFaceZone;
}

export interface VisionDirectorSelection {
  templateId?: string | null;
  protagonistSummary?: string;
  headline?: string;
  subheadline?: string;
  shots: VisionSelectedShot[];
  checklistTitle?: string;
  checklistItems?: string[];
  mission1Label?: string;
  mission2Label?: string;
  peakSticker?: string;
  blooperTitle?: string;
  narrationSentences?: string[];
}

export interface StoryDirectorPlan {
  templateId: ActiveStylePackId;
  thaiTemplateLabel: string;
  voiceMode: StoryVoiceMode;
  modelUsed?: string;
  creditsCharged?: number;
  bpm: number;
  targetDurationSec: number;
  headline: string;
  subheadline: string;
  scriptLines: string[];
  script: string;
  momentCaptions: StoryMomentCaption[];
  bgVideos: BrollVideo[];
  storyOverlays: StoryOverlayItem[];
  storyboardCards: StoryboardCardSummary[];
  dualTikTokExport: boolean;
}

const DEFAULT_RECIPE: StoryDirectorPackRecipe = {
  beatSync: true,
  defaultBpm: DEFAULT_STORY_BPM,
  keepColdOpenAudio: true,
  heroFreezeIntro: true,
  chapterPills: true,
  checklistPop: true,
  slowMoPeakShot: true,
  blooperTail: true,
  dualTikTokExportDefault: true,
};

function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function extractBriefClauses(brief: string): string[] {
  const cleaned = brief
    .replace(/\r/g, "\n")
    .split(/(?:\n|[+•·|]|แล้วก็|พร้อมกับ|ส่วนอีกช่วง)/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return cleaned.length > 0 ? cleaned : ["เก็บไฮไลต์โมเมนต์สำคัญแบบจัดเต็ม"];
}

/**
 * Strips redundant leading chapter/mission prefixes (e.g. `"ภารกิจ 1:"`, `"ภารกิจที่ 2 - "`)
 * before trimming at a safe Thai word boundary so `chapter-pill` never renders
 * `"ภารกิจ 2/2 | ภารกิจ 2: แข่งวิ่งผลัดใส"`!
 */
function cleanChapterSubtitle(raw: string, maxBaseGraphemes = 22): string {
  const stripped = raw
    .trim()
    .replace(/^(?:ภารกิจ(?:ที่)?|ช่วง(?:ที่)?|mission|step)\s*\d+(?:\s*\/\s*\d+)?\s*[:·•\-–—]?\s*/iu, "")
    .trim();
  return trimPhraseAtWordBoundary(stripped || raw.trim(), maxBaseGraphemes);
}

export function isStoryVoiceMode(value: unknown): value is StoryVoiceMode {
  return value === "real-moments" || value === "tts";
}

export function isStoryDirectorModelTier(value: unknown): value is StoryDirectorModelTier {
  return value === "neon" || value === "flash";
}

export function inferBestStoryTemplateId(brief: string, explicitId?: string | null): ActiveStylePackId {
  if (explicitId && isActiveStylePackId(explicitId)) return explicitId;
  const text = brief.toLowerCase();
  if (/(ขาย|สินค้า|รีวิว|โปร|เปิดตัวแบรนด์|unbox|ของมันต้องมี)/u.test(text)) {
    return "product-beat-showcase";
  }
  if (/(ภูมิใจ|ประทับใจ|รับรางวัล|เหรียญ|สำเร็จ|กอด|อบอุ่น)/u.test(text) && !/(ภารกิจ|mission)/u.test(text)) {
    return "proud-moment-highlight";
  }
  return "event-mission-vlog";
}

/**
 * Converts a Vision AI (Gemini 4 Neon / 3.8 Flash / MCP Agent) shot-by-shot selection
 * into a guaranteed-valid `StoryDirectorPlan` with clamped timestamps, clean transitions,
 * face-safe zones, synchronized overlays, and per-shot `momentCaptions`.
 */
export function buildStoryDirectorPlanFromVisionSelection(input: {
  brief?: string;
  voiceMode?: StoryVoiceMode;
  templateId?: string | null;
  targetDurationSec?: number;
  clips: readonly AnalyzedFootageItem[];
  selection: VisionDirectorSelection;
  modelUsed?: string;
  creditsCharged?: number;
}): StoryDirectorPlan {
  const rawBrief = (input.brief ?? "").trim() || "รวมไฮไลต์โมเมนต์สำคัญวันนี้";
  const voiceMode: StoryVoiceMode = input.voiceMode ?? "real-moments";
  const templateId = inferBestStoryTemplateId(
    rawBrief,
    input.templateId ?? input.selection.templateId ?? null,
  );
  const pack = stylePack(templateId);
  const recipe: StoryDirectorPackRecipe = pack.storyDirector ?? DEFAULT_RECIPE;
  const accentColor = pack.subtitle.accentColor || pack.palette[2] || "#FFE500";

  const validClips = input.clips.filter((c) => Boolean(c.src) && c.durationSec > 0);
  if (validClips.length === 0 || !Array.isArray(input.selection.shots) || input.selection.shots.length === 0) {
    return buildStoryDirectorPlan({
      brief: rawBrief,
      voiceMode,
      templateId,
      clips: validClips,
    });
  }

  const bgVideos: BrollVideo[] = [];
  const momentCaptions: StoryMomentCaption[] = [];
  const shotRoles: Array<{
    role: NonNullable<VisionSelectedShot["role"]>;
    startSec: number;
    endSec: number;
    captionText: string;
    visualCheck: string;
    keepClipAudio: boolean;
    slowMo: boolean;
  }> = [];

  let timelineCursorSec = 0;
  let usedSlowMo = false;
  let usedHeroFreeze = false;

  for (let idx = 0; idx < input.selection.shots.length && idx < 16; idx++) {
    const rawShot = input.selection.shots[idx]!;
    const clipIdx = Math.max(0, Math.min(validClips.length - 1, Math.floor(Number(rawShot.clipIndex) || 0)));
    const clip = validClips[clipIdx]!;
    const maxDur = Math.max(1.2, clip.durationSec);

    let inSec = Math.max(0, Math.min(maxDur - 0.8, Number(rawShot.inSec) || 0));
    let outSec = Math.max(inSec + 1.4, Math.min(maxDur, Number(rawShot.outSec) || inSec + 2.8));
    if (clip.stillImage) {
      inSec = 0;
      outSec = Math.min(4.0, Math.max(2.2, Number(rawShot.outSec) - Number(rawShot.inSec) || 2.8));
    } else if (outSec - inSec < 1.5 && maxDur >= 1.8) {
      inSec = Math.max(0, Math.min(inSec, maxDur - 1.8));
      outSec = Math.min(maxDur, inSec + 2.2);
    }

    const role = rawShot.role ?? (idx === 0 ? "cold-open" : "body");
    const wantSlowMo = !usedSlowMo && !clip.stillImage && (rawShot.slowMo === true || role === "slow-mo-peak");
    if (wantSlowMo) usedSlowMo = true;

    const wantHeroFreeze = !usedHeroFreeze && !wantSlowMo && (rawShot.heroFreeze === true || role === "hero-freeze");
    if (wantHeroFreeze) usedHeroFreeze = true;

    // Note: for slow-mo shots, if we stretch source [inSec..outSec] by 1/0.62x on timeline,
    // timeline duration is longer while keeping motion smooth when pre-interpolated!
    const rawSourceSpan = Math.max(1.4, outSec - inSec);
    const segDurSec = wantSlowMo
      ? Number(Math.min(4.0, Math.max(2.4, rawSourceSpan * 1.45)).toFixed(2))
      : Number(Math.min(5.2, Math.max(1.8, rawSourceSpan)).toFixed(2));

    const startSec = Number(timelineCursorSec.toFixed(2));
    const endSec = Number((startSec + segDurSec).toFixed(2));
    timelineCursorSec = endSec;

    const keepClipAudio = Boolean(
      !clip.stillImage
      && clip.hasAudio
      && !wantSlowMo
      && (rawShot.keepClipAudio === true || role === "cold-open" || role === "blooper"),
    );

    const shotFaceBoxes = faceBoxesFromVisionZone(rawShot.faceZone) ?? clip.faceBoxes;

    bgVideos.push({
      src: clip.src,
      start: startSec,
      end: endSec,
      clipOffset: Number(inSec.toFixed(2)),
      clipDuration: clip.durationSec,
      brollEnabled: true,
      provider: "upload",
      stillImage: Boolean(clip.stillImage),
      fit: "cover",
      transition: role === "cold-open" || role === "hero-freeze" || role === "blooper" ? "cut" : pack.brollTransition,
      ...(keepClipAudio ? { keepClipAudio: true, clipAudioVolume: role === "cold-open" ? 1.05 : 0.95 } : {}),
      ...(wantSlowMo ? { playbackRate: 0.65 } : {}),
      ...(wantHeroFreeze ? { freezeAtEndFrames: 18 } : {}),
      ...(shotFaceBoxes?.length ? { faceBoxes: shotFaceBoxes } : {}),
    });

    const cleanCaption = trimPhraseAtWordBoundary((rawShot.captionText ?? "").trim(), 38);
    if (cleanCaption) {
      momentCaptions.push({
        text: cleanCaption,
        startMs: Math.round(startSec * 1000 + 100),
        endMs: Math.round(endSec * 1000 - 80),
        tag: idx === 0 ? "hook" : idx === input.selection.shots.length - 1 ? "cta" : "body",
      });
    }

    shotRoles.push({
      role,
      startSec,
      endSec,
      captionText: cleanCaption || clip.filename || `ช็อต ${idx + 1}`,
      visualCheck: (rawShot.visualCheck ?? "").trim(),
      keepClipAudio,
      slowMo: wantSlowMo,
    });
  }

  const totalDurationSec = Math.max(8, Math.round(timelineCursorSec));
  const targetDurationSec = input.targetDurationSec ?? totalDurationSec;
  const totalDurationMs = Math.round(timelineCursorSec * 1000);
  const clauses = extractBriefClauses(rawBrief);
  const headline = trimPhraseAtWordBoundary(
    input.selection.headline?.trim() || clauses[0] || pack.thaiLabel,
    44,
  );
  const subheadline = trimPhraseAtWordBoundary(
    input.selection.subheadline?.trim() || clauses[1] || pack.tagline,
    58,
  );

  // Build synchronized Story Overlays matched to the exact Vision-selected shots!
  const rawOverlays: StoryOverlayItem[] = [];
  const heroIdx = shotRoles.findIndex((s) => s.role === "hero-freeze");
  const heroTarget = heroIdx >= 0 ? shotRoles[heroIdx] : shotRoles[Math.min(1, shotRoles.length - 1)];
  if (heroTarget && recipe.heroFreezeIntro) {
    rawOverlays.push({
      kind: "hero-freeze-card",
      startMs: Math.round(heroTarget.startSec * 1000 + 120),
      endMs: Math.round(Math.min(heroTarget.endSec, heroTarget.startSec + 2.4) * 1000),
      badge: templateId === "product-beat-showcase" ? "HIGHLIGHT" : "HERO SPOTLIGHT",
      title: headline,
      subtitle: subheadline,
      accentColor,
    });
  }

  const blooperShot = shotRoles.find((s) => s.role === "blooper");
  const bodyStartSec = heroTarget ? heroTarget.endSec : (shotRoles[0]?.endSec ?? 2.4);
  const bodyEndSec = blooperShot ? blooperShot.startSec : timelineCursorSec;
  const bodySpanSec = bodyEndSec - bodyStartSec;

  if (recipe.chapterPills && bodySpanSec >= 5.0) {
    const m2First = shotRoles.find((s) => s.role === "mission-2");
    const splitSec = m2First && m2First.startSec > bodyStartSec + 1.5
      ? m2First.startSec
      : Number((bodyStartSec + bodySpanSec * 0.5).toFixed(2));
    rawOverlays.push({
      kind: "chapter-pill",
      startMs: Math.round(bodyStartSec * 1000 + 80),
      endMs: Math.round(splitSec * 1000 - 80),
      title: "ภารกิจ 1/2",
      subtitle: cleanChapterSubtitle(input.selection.mission1Label || clauses[0] || "ช่วงเปิดภารกิจ", 22),
      accentColor,
      position: "top-left",
    });
    rawOverlays.push({
      kind: "chapter-pill",
      startMs: Math.round(splitSec * 1000),
      endMs: Math.round(bodyEndSec * 1000 - 100),
      title: "ภารกิจ 2/2",
      subtitle: cleanChapterSubtitle(input.selection.mission2Label || clauses[1] || "ไฮไลต์สำคัญ", 22),
      accentColor,
      position: "top-left",
    });
  }

  if (recipe.checklistPop && bodySpanSec >= 4.0) {
    const checkItems = (input.selection.checklistItems?.filter(Boolean) ?? clauses)
      .slice(0, 3)
      .map((t, i) => ({
        text: trimPhraseAtWordBoundary(t.trim(), 26),
        appearOffsetMs: i * 480,
      }));
    if (checkItems.length >= 2) {
      const checkStartMs = Math.round(bodyStartSec * 1000 + 250);
      rawOverlays.push({
        kind: "checklist-pop",
        startMs: checkStartMs,
        endMs: Math.min(Math.round(bodyEndSec * 1000 - 200), checkStartMs + 2600),
        title: trimPhraseAtWordBoundary(input.selection.checklistTitle?.trim() || "เช็กลิสต์วันนี้", 22),
        items: checkItems,
        accentColor,
      });
    }
  }

  const peakShot = shotRoles.find((s) => s.slowMo || s.role === "slow-mo-peak");
  if (peakShot) {
    rawOverlays.push({
      kind: "callout-sticker",
      startMs: Math.round(peakShot.startSec * 1000 + 120),
      endMs: Math.round(peakShot.endSec * 1000 - 100),
      badge: "🔥",
      title: trimPhraseAtWordBoundary(input.selection.peakSticker?.trim() || "ช็อตพีคสุดมันส์!", 24),
      accentColor,
      position: "auto",
    });
  }

  if (blooperShot) {
    rawOverlays.push({
      kind: "blooper-end",
      startMs: Math.round(blooperShot.startSec * 1000),
      endMs: Math.round(blooperShot.endSec * 1000),
      badge: "เบื้องหลัง",
      title: trimPhraseAtWordBoundary(
        input.selection.blooperTitle?.trim() || blooperShot.captionText || "ช็อตเรียลหลังกล้อง!",
        28,
      ),
      accentColor,
    });
  }

  const storyOverlays = normalizeStoryOverlays(rawOverlays, totalDurationMs);

  const scriptLines = (
    input.selection.narrationSentences?.map((s) => s.trim()).filter(Boolean)
    ?? momentCaptions.map((c) => c.text)
  ).slice(0, 8);
  const script = scriptLines.join("\n");

  const storyboardCards: StoryboardCardSummary[] = shotRoles.slice(0, 6).map((s, idx) => ({
    index: idx + 1,
    badge:
      s.role === "cold-open" ? (s.keepClipAudio ? "เปิดตัว · เสียงจริง" : "ช็อตเปิดคลิป")
      : s.role === "hero-freeze" ? "แนะนำตัวเอก"
      : s.slowMo ? "ช็อตพีค · Slow-Mo"
      : s.role === "blooper" ? "เบื้องหลัง · เสียงจริง"
      : `ช็อตที่ ${idx + 1}`,
    timeLabel: `${fmtSec(s.startSec)}–${fmtSec(s.endSec)}`,
    title: s.captionText,
    detail: s.visualCheck || (s.keepClipAudio ? "ดึงเสียงพูด/เสียงเชียร์จริงจากคลิป + หรี่เพลงให้อัตโนมัติ" : "คัดเฉพาะช่วงภาพนิ่งชัด ไม่ติดคนเดินบัง"),
  }));

  return {
    templateId,
    thaiTemplateLabel: pack.thaiLabel,
    voiceMode,
    ...(input.modelUsed ? { modelUsed: input.modelUsed } : {}),
    ...(input.creditsCharged !== undefined ? { creditsCharged: input.creditsCharged } : {}),
    bpm: recipe.defaultBpm,
    targetDurationSec,
    headline,
    subheadline,
    scriptLines,
    script,
    momentCaptions,
    bgVideos,
    storyOverlays,
    storyboardCards,
    dualTikTokExport: recipe.dualTikTokExportDefault,
  };
}

export function buildStoryDirectorPlan(input: {
  brief?: string;
  voiceMode?: StoryVoiceMode;
  templateId?: string | null;
  clips: readonly AnalyzedFootageItem[];
  targetDurationSec?: number;
  authoredScriptLines?: readonly string[] | null;
  authoredHeadline?: string | null;
  authoredSubheadline?: string | null;
}): StoryDirectorPlan {
  const rawBrief = (input.brief ?? "").trim() || "รวมไฮไลต์กิจกรรมสนุกและโมเมนต์ประทับใจวันนี้";
  const voiceMode: StoryVoiceMode = input.voiceMode ?? "real-moments";
  const templateId = inferBestStoryTemplateId(rawBrief, input.templateId);
  const pack = stylePack(templateId);
  const recipe: StoryDirectorPackRecipe = pack.storyDirector ?? DEFAULT_RECIPE;

  const clips: StoryCandidateClip[] = input.clips
    .filter((c) => Boolean(c.src) && c.durationSec > 0)
    .map((c, idx) => ({
      src: c.src,
      durationSec: c.durationSec,
      stillImage: c.stillImage,
      hasAudio: c.hasAudio,
      hasSpeechOrCheer: c.hasSpeechOrCheer || Boolean(c.transcriptSnippet && c.transcriptSnippet.trim().length > 2),
      bestOffsetSec: c.bestOffsetSec ?? 0,
      faceBoxes: c.faceBoxes,
      label: c.filename || `ช็อต ${idx + 1}`,
    }));

  const autoTargetDur = Math.min(
    32,
    Math.max(14, clips.length <= 2 ? 15 : clips.length <= 4 ? 20 : 24),
  );
  const targetDurationSec = input.targetDurationSec && Number.isFinite(input.targetDurationSec)
    ? Math.max(8, Math.min(90, Math.round(input.targetDurationSec)))
    : autoTargetDur;

  const edl = planBeatSyncedStoryCuts({
    clips,
    targetDurationSec,
    bpm: recipe.defaultBpm,
    keepColdOpenAudio: recipe.keepColdOpenAudio,
    heroFreezeIntro: recipe.heroFreezeIntro,
    slowMoPeakShot: recipe.slowMoPeakShot,
    blooperTail: recipe.blooperTail,
  });

  const clauses = extractBriefClauses(rawBrief);
  const heroTitle = trimPhraseAtWordBoundary(clauses[0]!, 34);
  const mission2 = clauses[1] ? trimPhraseAtWordBoundary(clauses[1], 34) : "ลุยเต็มที่ทุกวินาที";
  const coldOpenClip = input.clips.find((c) => c.transcriptSnippet?.trim());

  const defaultScriptLines = [
    coldOpenClip?.transcriptSnippet
      ? `เปิดมาด้วยเสียงจริงสุดน่ารัก ${heroTitle}`
      : `วันนี้พามาดูไฮไลต์จัดเต็ม ${heroTitle}`,
    clauses.length >= 2
      ? `เริ่มภารกิจแรกแบบตั้งใจสุดพลัง ทุกจังหวะคือเต็มร้อยไม่มีกั๊ก`
      : `บรรยากาศจริงหน้างานคือคึกคักและเต็มไปด้วยพลังสุด ๆ`,
    clauses.length >= 2
      ? `ไปต่อกันที่ ${mission2} ลุ้นกันช็อตต่อช็อตตามจังหวะเพลง`
      : `คัดเฉพาะช็อตเด็ดมาตัดเข้าจังหวะให้ดูเพลินตั้งแต่ต้นจนจบ`,
    recipe.blooperTail && edl.blooperRangeSec
      ? `ปิดท้ายด้วยรอยยิ้มความภูมิใจ แถมช็อตเบื้องหลังเรียล ๆ ท้ายคลิป`
      : `เป็นอีกหนึ่งโมเมนต์น่าจดจำที่ดูซ้ำกี่รอบก็ยิ้มตามได้ทันที`,
  ];

  const scriptLines = (input.authoredScriptLines?.map((l) => l.trim()).filter(Boolean) ?? defaultScriptLines).slice(0, 8);
  const script = scriptLines.join("\n");
  const headline = trimPhraseAtWordBoundary(input.authoredHeadline?.trim() || heroTitle, 44);
  const subheadline = trimPhraseAtWordBoundary(
    input.authoredSubheadline?.trim()
      || (clauses.length >= 2 ? mission2 : pack.thaiLabel),
    58,
  );

  const momentCaptions: StoryMomentCaption[] = edl.bgVideos.map((seg, idx) => ({
    text:
      idx === 0 && coldOpenClip?.transcriptSnippet
        ? trimPhraseAtWordBoundary(coldOpenClip.transcriptSnippet, 34)
        : trimPhraseAtWordBoundary(scriptLines[Math.min(idx, scriptLines.length - 1)]!, 34),
    startMs: Math.round(seg.start * 1000 + 100),
    endMs: Math.round(seg.end * 1000 - 80),
    tag: idx === 0 ? "hook" : idx === edl.bgVideos.length - 1 ? "cta" : "body",
  }));

  const accentColor = pack.subtitle.accentColor || pack.palette[2] || "#FFE500";
  const rawOverlays: StoryOverlayItem[] = [];
  const totalDurationMs = targetDurationSec * 1000;

  if (edl.heroFreezeRangeSec) {
    rawOverlays.push({
      kind: "hero-freeze-card",
      startMs: Math.round(edl.heroFreezeRangeSec.startSec * 1000 + 180),
      endMs: Math.round(edl.heroFreezeRangeSec.endSec * 1000),
      badge: templateId === "product-beat-showcase" ? "HIGHLIGHT" : "HERO SPOTLIGHT",
      title: headline,
      subtitle: subheadline,
      accentColor,
    });
  }

  const bodyStartMs = Math.round(
    ((edl.heroFreezeRangeSec?.endSec ?? edl.coldOpenEndSec) || 2.5) * 1000 + 120,
  );
  const bodyEndMs = Math.round(((edl.blooperRangeSec?.startSec ?? targetDurationSec) - 0.3) * 1000);
  const bodySpanMs = Math.max(2000, bodyEndMs - bodyStartMs);

  if (recipe.chapterPills && bodySpanMs >= 5000) {
    const midBodyMs = Math.round(bodyStartMs + bodySpanMs * 0.5);
    rawOverlays.push({
      kind: "chapter-pill",
      startMs: bodyStartMs,
      endMs: midBodyMs - 120,
      title: clauses.length >= 2 ? "ภารกิจ 1/2" : "ช่วงที่ 1 · เปิดตัว",
      subtitle: cleanChapterSubtitle(clauses[0]!, 20),
      accentColor,
      position: "top-left",
    });
    rawOverlays.push({
      kind: "chapter-pill",
      startMs: midBodyMs,
      endMs: bodyEndMs,
      title: clauses.length >= 2 ? "ภารกิจ 2/2" : "ช่วงที่ 2 · ไฮไลต์พีค",
      subtitle: cleanChapterSubtitle(clauses[1] ?? "ช็อตสำคัญ", 20),
      accentColor,
      position: "top-left",
    });
  }

  if (recipe.checklistPop && bodySpanMs >= 4200) {
    const checkStartMs = Math.round(bodyStartMs + bodySpanMs * 0.14);
    const checkItems = clauses.length >= 2
      ? clauses.slice(0, 3).map((c, idx) => ({ text: trimPhraseAtWordBoundary(c, 26), appearOffsetMs: idx * 520 }))
      : [
          { text: "เตรียมตัวพร้อมลุยเต็มร้อย", appearOffsetMs: 0 },
          { text: "เก็บช็อตสำคัญครบทุกมุม", appearOffsetMs: 520 },
        ];
    rawOverlays.push({
      kind: "checklist-pop",
      startMs: checkStartMs,
      endMs: Math.min(bodyEndMs, checkStartMs + 2600),
      title: "เช็กลิสต์ไฮไลต์",
      items: checkItems,
      accentColor,
    });
  }

  if (edl.peakSlowMoIndex !== null && edl.bgVideos[edl.peakSlowMoIndex]) {
    const peakSeg = edl.bgVideos[edl.peakSlowMoIndex]!;
    rawOverlays.push({
      kind: "callout-sticker",
      startMs: Math.round(peakSeg.start * 1000 + 120),
      endMs: Math.round(peakSeg.end * 1000 - 80),
      badge: "⚡",
      title: templateId === "product-beat-showcase" ? "ดีเทลชัดเป๊ะ!" : "ช็อตพีคสโลว์โมชัน!",
      accentColor,
      position: "auto",
    });
  }

  if (edl.blooperRangeSec) {
    rawOverlays.push({
      kind: "blooper-end",
      startMs: Math.round(edl.blooperRangeSec.startSec * 1000),
      endMs: Math.round(edl.blooperRangeSec.endSec * 1000),
      badge: "เบื้องหลัง",
      title: "ช็อตเรียลหลังกล้อง!",
      accentColor,
    });
  }

  const storyOverlays = normalizeStoryOverlays(rawOverlays, totalDurationMs);

  const storyboardCards: StoryboardCardSummary[] = [];
  if (edl.coldOpenEndSec > 0) {
    storyboardCards.push({
      index: storyboardCards.length + 1,
      badge: "Cold Open · เสียงจริง",
      timeLabel: `${fmtSec(0)}–${fmtSec(edl.coldOpenEndSec)}`,
      title: coldOpenClip?.transcriptSnippet
        ? `"${coldOpenClip.transcriptSnippet.slice(0, 36)}"`
        : "เปิดด้วยเสียงบรรยากาศจริงจากคลิป",
      detail: "หรี่เสียงเพลงอัตโนมัติ (Auto-Duck) ให้เสียงในคลิปเด่นชัด",
    });
  }
  if (edl.heroFreezeRangeSec) {
    storyboardCards.push({
      index: storyboardCards.length + 1,
      badge: "Hero Freeze + Shutter",
      timeLabel: `${fmtSec(edl.heroFreezeRangeSec.startSec)}–${fmtSec(edl.heroFreezeRangeSec.endSec)}`,
      title: headline,
      detail: `หยุดเฟรมจังหวะเท่ + แฟลชชัตเตอร์และป้าย "${subheadline}"`,
    });
  }
  storyboardCards.push({
    index: storyboardCards.length + 1,
    badge: `Beat Sync · ${edl.bpm} BPM`,
    timeLabel: `${fmtSec(bodyStartMs / 1000)}–${fmtSec(bodyEndMs / 1000)}`,
    title: `ตัดสลับไวตามจังหวะเพลง (${edl.bgVideos.length} ช็อต)`,
    detail: edl.peakSlowMoIndex !== null
      ? "ผสมช็อต Slow-Mo จังหวะพีค + เช็กลิสต์เด้งตามบีต + ซับหลบใบหน้าอัตโนมัติ"
      : "ตัดสลับเข้าบีต + เช็กลิสต์เด้งตามจังหวะ + ซับหลบใบหน้าอัตโนมัติ",
  });
  if (edl.blooperRangeSec) {
    storyboardCards.push({
      index: storyboardCards.length + 1,
      badge: "Blooper ท้ายคลิป",
      timeLabel: `${fmtSec(edl.blooperRangeSec.startSec)}–${fmtSec(edl.blooperRangeSec.endSec)}`,
      title: "เฟดหลอก + เสียงแผ่นเสียงสแครชเข้าช็อตเบื้องหลัง",
      detail: "เก็บโมเมนต์เรียลน่ารักท้ายคลิปเพิ่มอัตราดูจบและคอมเมนต์",
    });
  }

  return {
    templateId,
    thaiTemplateLabel: pack.thaiLabel,
    voiceMode,
    bpm: edl.bpm,
    targetDurationSec,
    headline,
    subheadline,
    scriptLines,
    script,
    momentCaptions,
    bgVideos: edl.bgVideos,
    storyOverlays,
    storyboardCards,
    dualTikTokExport: recipe.dualTikTokExportDefault,
  };
}
