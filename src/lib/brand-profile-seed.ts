import type { TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import type { VisualFormatId } from "@/lib/brand-visual-system";
import { parseTtsProvider, type TtsProvider } from "@/lib/tts-providers";

export type BrandProfileSeed = {
  schemaVersion: 1;
  name: string;
  niche: string;
  audience: string;
  script: {
    styleId: string | null;
    tone: string;
    bannedWords: string[];
    ctaStyle: string;
    language: string;
    analysisNotes?: string | null;
    sampleText?: string | null;
  };
  voice: { provider: string; voiceId: string | null };
  subtitle: { presetId: string | null; config: Record<string, string | number | boolean | null> };
  brandMark: { assetId: string | null; enabled: boolean; position: string; sizePct: number; opacity: number };
  visual: {
    primaryVisualFormatId: VisualFormatId;
    treatmentPolicy: "adaptive" | "locked";
    lockedTreatmentPresetId: TreatmentPresetId | null;
    languageMode: "defined" | "none";
    palette: string[];
    personality: string;
    visualNotes: string;
    defaultTreatment: string;
    /** Retired scene inputs (ADR 0006 — a Brand controls rendering, never the
     * scene). Neither field is authored or seeded any more; they stay on the
     * type purely so a payload restored from a pinned revision, or carried over
     * from a completed clip's visual context, round-trips unchanged. */
    peopleAndSetting?: string;
    memorableCues?: string[];
  };
};

export type CurrentBrandDefaults = {
  script: { styleId: string | null; tone: string; analysisNotes: string | null; sampleText: string | null };
  voice: { provider: TtsProvider; voiceId: string | null };
  subtitle: { presetId: string | null; config: Record<string, string | number | boolean | null> };
  brandMark: {
    assetId: string | null;
    assetName?: string | null;
    enabled: boolean;
    position: string;
    sizePct: number;
    opacity: number;
  };
};

/** Account voice fields are provider-specific. Never reinterpret an id from
 * one provider as another provider's voice when seeding an explicit import. */
export function currentBrandVoiceDefaults(input: {
  ttsProvider: string | null | undefined;
  elevenlabsVoiceId: string | null | undefined;
  geminiVoiceName: string | null | undefined;
}): CurrentBrandDefaults["voice"] {
  const provider = parseTtsProvider(input.ttsProvider);
  // omnivoice has no account-level saved voice id (Hero Voice is picked per-project,
  // no User.omniVoiceId column) — null is correct there, same as before this change.
  const voiceId = provider === "gemini"
    ? input.geminiVoiceName || null
    : provider === "elevenlabs"
      ? input.elevenlabsVoiceId || null
      : null;
  return { provider, voiceId };
}

/** A new identity begins neutral. The Mewsocial brief is Quality Gate evidence,
 * never a product default and never an inferred cross-channel match. */
export function createBlankBrandProfileSeed(): BrandProfileSeed {
  return {
    schemaVersion: 1,
    name: "",
    niche: "",
    audience: "",
    script: {
      styleId: null,
      tone: "ชัดเจน เป็นธรรมชาติ และเหมาะกับผู้ชมของแบรนด์",
      bannedWords: [],
      ctaStyle: "follow",
      language: "th",
      analysisNotes: null,
      sampleText: null,
    },
    voice: { provider: "gemini", voiceId: null },
    subtitle: { presetId: null, config: {} },
    brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "clear-infographic",
      treatmentPolicy: "adaptive",
      lockedTreatmentPresetId: null,
      languageMode: "defined",
      palette: ["#2B2926", "#F5F1E8", "#A8A29E"],
      personality: "สมดุล ชัดเจน และปรับให้เข้ากับแบรนด์ได้",
      visualNotes: "",
      defaultTreatment: "ชัดเจน สมดุล และอ่านเรื่องได้ทันที",
    },
  };
}

/** Importing account defaults is an explicit creator action. Only persisted
 * writing/voice/subtitle/mark settings are copied; visual identity stays
 * neutral because V1 has no authoritative legacy visual-language mapping. */
export function createBrandProfileSeedFromCurrentDefaults(
  defaults: CurrentBrandDefaults,
): BrandProfileSeed {
  const seed = createBlankBrandProfileSeed();
  return {
    ...seed,
    script: {
      ...seed.script,
      styleId: defaults.script.styleId,
      tone: defaults.script.tone || seed.script.tone,
      analysisNotes: defaults.script.analysisNotes,
      sampleText: defaults.script.sampleText,
    },
    voice: { ...defaults.voice },
    subtitle: { presetId: defaults.subtitle.presetId, config: { ...defaults.subtitle.config } },
    brandMark: {
      assetId: defaults.brandMark.assetId,
      enabled: defaults.brandMark.enabled,
      position: defaults.brandMark.position,
      sizePct: defaults.brandMark.sizePct,
      opacity: defaults.brandMark.opacity,
    },
  };
}
