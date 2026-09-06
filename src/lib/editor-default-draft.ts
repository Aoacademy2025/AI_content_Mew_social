// editor-default-draft.ts — the editor v2 project draft defaults, in ONE place.
//
// This object used to be a private `DEFAULT_PROJECT` const inside the client
// hook `_v2/useV2Project.ts`. It moved here (unchanged) when Hero Script's
// "ส่งไปตัดต่อ" handoff started creating EditorProjects on the SERVER: the
// handoff must seed the exact same draft shape the editor seeds for a brand-new
// project, and a hand-rolled copy would silently drift from the editor's own
// defaults the first time one of them changes.
//
// Keep this module free of React/`"use client"` — it is imported by both the
// client hook and server code (src/lib/hero-script.server.ts).

import type { AutoMixImageProvider, KieImageModel } from "@/app/(dashboard)/video-editor/_components/types";
import { DEFAULT_AUTO_MIX_PROVIDERS } from "@/app/(dashboard)/video-editor/_components/types";
import type { MixPreset } from "@/app/(dashboard)/video-editor/_v2/mix-presets";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import type { LogoOverlayConfig } from "@/lib/logo-overlay";
import type { MusicMood, PacingLevel } from "@/lib/style-pack-catalog";
import {
  DEFAULT_EDITOR_LAYER_VISIBILITY,
  type EditorLayerVisibility,
} from "@/lib/editor-layer-visibility";
import { scriptTargetDuration } from "@/lib/hero-script-duration";
import type { TtsProvider } from "@/lib/tts-providers";

/** Editor step-1 mode: write a script vs upload your own clip. Mirrors V2Mode. */
export type EditorDraftMode = "script" | "upload";
export type EditorNarrativeSourceKind = "ai-script" | "creator-script" | "upload-transcript";
export type EditorDraftAvatarMode = "bookend" | "bookend-both" | "full";

export interface EditorDefaultDraft {
  projectTitle: string;
  mode: EditorDraftMode;
  narrativeSourceKind: EditorNarrativeSourceKind;
  script: string;
  clipUrl: string;
  clipDurationSec: number;
  /** Narration target from Hero Script; independent of uploaded media duration. */
  scriptTargetDurationSec?: number | null;
  voiceEngine: TtsProvider;
  geminiVoiceName: string;
  voiceId: string;
  omniVoiceId: string;
  musicTrack: string | null;
  musicTrackKind: "system" | "user";
  bgmVolume: number;
  useAvatar: boolean;
  avatarId: string;
  targetClipCount: number;
  avatarMode: EditorDraftAvatarMode;
  avatarIntroSecs: number;
  avatarTailSecs: number;
  kieModel: KieImageModel | "";
  autoMixProviders: AutoMixImageProvider[];
  mixPreset: MixPreset;
  brollRegionPreference: BrollRegionPreference;
  brollVisualStyle: BrollVisualStyle;
  logoOverlay?: LogoOverlayConfig;
  /** Project-level defaults a pinned Brand Revision may carry (ADR 0058).
   * Absent on a draft no Brand Revision has been applied to. */
  pacing?: PacingLevel;
  musicMoodDefault?: MusicMood | null;
  layerVisibility: EditorLayerVisibility;
}

export const EDITOR_DEFAULT_DRAFT: EditorDefaultDraft = {
  projectTitle: "New Project",
  mode: "script",
  narrativeSourceKind: "creator-script",
  script: "",
  clipUrl: "",
  clipDurationSec: 0,
  voiceEngine: "gemini",
  geminiVoiceName: "Aoede",
  voiceId: "",
  omniVoiceId: "voice_01",
  musicTrack: "",
  musicTrackKind: "system",
  bgmVolume: 0.12,
  useAvatar: false,
  avatarId: "",
  targetClipCount: 0,
  avatarMode: "bookend",
  avatarIntroSecs: 5,
  avatarTailSecs: 5,
  kieModel: "",
  autoMixProviders: DEFAULT_AUTO_MIX_PROVIDERS,
  mixPreset: "free",
  brollRegionPreference: "auto",
  brollVisualStyle: "auto",
  layerVisibility: { ...DEFAULT_EDITOR_LAYER_VISIBILITY },
};

/** The account-level voice/avatar defaults the editor applies to a NEW project
 *  (client: loadAccountVideoDefaults() over /api/user/video-settings). Server
 *  callers read the same four User columns. */
export interface EditorAccountVideoDefaults {
  voiceEngine?: TtsProvider;
  geminiVoiceName?: string;
  voiceId?: string;
  avatarId?: string;
}

/** Build the draft for a script handed off from Hero Script: the editor's own
 *  defaults + step-1 script mode + the assembled script text (+ the account's
 *  saved voice/avatar defaults, exactly like the editor's own new-project seed).
 *
 *  `script` must already be normalized (no blank lines) — the editor turns 1
 *  line into 1 Segment. */
export function buildScriptHandoffDraft(params: {
  script: string;
  targetDurationSec?: number;
  projectTitle: string;
  accountDefaults?: EditorAccountVideoDefaults;
  logoOverlay?: LogoOverlayConfig;
}): EditorDefaultDraft {
  const { script, projectTitle, accountDefaults, logoOverlay } = params;
  const target = scriptTargetDuration(params.targetDurationSec);
  return {
    ...EDITOR_DEFAULT_DRAFT,
    autoMixProviders: [...EDITOR_DEFAULT_DRAFT.autoMixProviders],
    projectTitle,
    mode: "script",
    narrativeSourceKind: "ai-script",
    ...(target ? { scriptTargetDurationSec: target } : {}),
    script,
    voiceEngine: accountDefaults?.voiceEngine ?? EDITOR_DEFAULT_DRAFT.voiceEngine,
    geminiVoiceName: accountDefaults?.geminiVoiceName ?? EDITOR_DEFAULT_DRAFT.geminiVoiceName,
    voiceId: accountDefaults?.voiceId ?? EDITOR_DEFAULT_DRAFT.voiceId,
    avatarId: accountDefaults?.avatarId ?? EDITOR_DEFAULT_DRAFT.avatarId,
    ...(logoOverlay ? { logoOverlay: { ...logoOverlay } } : {}),
  };
}
