import type { BrandProfilePayload } from "@/lib/brand-profile-library.server";
import { createBlankBrandProfileSeed } from "@/lib/brand-profile-seed";
import { TREATMENT_PRESET_IDS, type TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import { isMotionMascotId, isMotionThemeId } from "@/lib/motion-broll-catalog";
import {
  STYLE_PACKS,
  isActiveStylePackId,
  isStylePackId,
  stylePack,
  stylePackSubtitlePreset,
  type StylePack,
} from "@/lib/style-pack-catalog";
import {
  TEMPLATE_TTS_SPEED_BY_PACING,
  TEMPLATE_VOICE_STYLE_BY_ID,
} from "@/lib/video-template-apply";

/** A pack is a one-tap layer over the EXISTING Brand Profile axes (ADR 0058):
 * it resolves Visual Format, narrative treatment, palette, personality,
 * subtitle and script tone onto the payload the creator already had. It adds
 * no new rendering path — pinning, revisions and the compilers stay untouched. */

/** Customer-visible Thai copy. A pack still awaiting the Treatment
 * Qualification Benchmark (ADR 0010) is never selectable (ADR 0058). */
export const STYLE_PACK_UNAVAILABLE_MESSAGE = "ชุดสไตล์นี้ยังไม่เปิดให้ใช้";

function qualifiedTreatmentPresetId(pack: StylePack): TreatmentPresetId {
  // Wave 2 packs name treatments that do not exist in the closed catalog yet.
  // Their `pending-benchmark` status already blocks them above; this keeps the
  // payload honest if a catalog edit ever activates a pack before its treatment.
  if (!(TREATMENT_PRESET_IDS as readonly string[]).includes(pack.treatmentPresetId)) {
    throw new Error(STYLE_PACK_UNAVAILABLE_MESSAGE);
  }
  return pack.treatmentPresetId as TreatmentPresetId;
}

let packOwnedTones: Set<string> | null = null;

/** A tone nobody authored: the blank-seed default, or the tone some pack put
 * there. Every other pack-resolved field is replaced on every apply, so tone
 * must be too — otherwise the second pack a creator taps keeps speaking in the
 * first pack's voice. Pending packs count as well: what matters is that the
 * words came from the catalog, not from the creator. Anything else is their
 * writing and is kept, no matter how many packs are tried on top. */
function isPackOwnedTone(tone: string): boolean {
  if (!packOwnedTones) {
    packOwnedTones = new Set<string>([
      createBlankBrandProfileSeed().script.tone,
      ...STYLE_PACKS.map((pack) => pack.scriptTone),
    ]);
  }
  return packOwnedTones.has(tone);
}

/** Apply one pack onto a Brand Profile payload. Pure: the caller's payload is
 * never mutated. Creator-authored choices win over the pack: a saved subtitle
 * style (`subtitle.presetId`), a tone the creator wrote themselves (anything
 * `isPackOwnedTone` does not recognise), and any configured Motion B-Roll
 * theme/mascot (so swapping Style Packs never wipes Motion B-Roll). */
export function applyStylePackToPayload(
  payload: BrandProfilePayload,
  pack: StylePack,
): BrandProfilePayload {
  if (pack.status !== "active") throw new Error(STYLE_PACK_UNAVAILABLE_MESSAGE);
  const lockedTreatmentPresetId = qualifiedTreatmentPresetId(pack);
  const keepsOwnSubtitle = Boolean(payload.subtitle.presetId);
  const keepsOwnTone = !isPackOwnedTone(payload.script.tone);
  const existingConfig = payload.subtitle.config ?? {};
  const preservedMotionTheme = isMotionThemeId(payload.visual.motionThemeId)
    ? payload.visual.motionThemeId
    : isMotionThemeId(existingConfig.motionThemeId)
      ? existingConfig.motionThemeId
      : null;
  const preservedMotionMascot = isMotionMascotId(payload.visual.motionMascot)
    ? payload.visual.motionMascot
    : isMotionMascotId(existingConfig.motionMascot)
      ? existingConfig.motionMascot
      : null;
  const preservedMotionConfig: Record<string, string> = {};
  if (preservedMotionTheme) preservedMotionConfig.motionThemeId = preservedMotionTheme;
  if (preservedMotionMascot) preservedMotionConfig.motionMascot = preservedMotionMascot;
  const packSubtitle = stylePackSubtitlePreset(pack);
  const activeVoiceStyle = isActiveStylePackId(pack.id)
    ? TEMPLATE_VOICE_STYLE_BY_ID[pack.id]
    : undefined;
  const packTtsSpeed = TEMPLATE_TTS_SPEED_BY_PACING[pack.pacing];
  return {
    ...payload,
    script: {
      ...payload.script,
      tone: keepsOwnTone ? payload.script.tone : pack.scriptTone,
    },
    voice: {
      ...payload.voice,
      ...(activeVoiceStyle && !payload.voice.geminiVoiceStyle ? { geminiVoiceStyle: activeVoiceStyle } : {}),
      ...(payload.voice.ttsSpeed == null && packTtsSpeed !== 1 ? { ttsSpeed: packTtsSpeed } : {}),
    },
    subtitle: keepsOwnSubtitle
      ? { ...payload.subtitle, config: { ...existingConfig, ...preservedMotionConfig } }
      : { ...payload.subtitle, config: { ...packSubtitle, ...preservedMotionConfig } },
    videoDefaults: {
      ...payload.videoDefaults,
      musicMood: pack.musicMood,
      headlineHookEnabled: true,
      headlineHookPreset: pack.headlineHookPreset,
      highlightKeywords: pack.highlightKeywords,
      statCards: pack.statCards,
      sfxMode: pack.sfxMode,
      punchZoom: pack.punchZoom,
      brollTransition: pack.brollTransition,
    },
    visual: {
      ...payload.visual,
      stylePackId: pack.id,
      stylePackVersion: pack.version,
      primaryVisualFormatId: pack.visualFormatId,
      treatmentPolicy: "locked",
      lockedTreatmentPresetId,
      palette: [...pack.palette],
      personality: pack.personality,
      ...(preservedMotionTheme ? { motionThemeId: preservedMotionTheme } : {}),
      ...(preservedMotionMascot ? { motionMascot: preservedMotionMascot } : {}),
    },
  };
}

/** Unlink the pack while keeping everything it resolved: the look the creator
 * is looking at does not change, it simply becomes their own custom look. */
export function clearStylePack(payload: BrandProfilePayload): BrandProfilePayload {
  return {
    ...payload,
    visual: { ...payload.visual, stylePackId: null, stylePackVersion: null },
  };
}

/** The pack a payload is currently linked to, or null for a custom look. */
export function stylePackOfPayload(payload: BrandProfilePayload): StylePack | null {
  const id = payload.visual.stylePackId;
  return id && isStylePackId(id) ? stylePack(id) : null;
}
