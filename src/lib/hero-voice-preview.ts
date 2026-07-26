import type { OmniVoiceInfo } from "@/lib/tts-providers";
import voiceManifest from "../../services/omnivoice-runpod/assets/voices/voices.json";

export type RunpodHeroVoicePreview = {
  voiceId: string;
  desc: string;
  instruct: string;
  filename: string;
  previewText: string;
};

export const RUNPOD_HERO_VOICE_PREVIEWS: readonly RunpodHeroVoicePreview[] = voiceManifest.map((voice) => ({
  voiceId: voice.id,
  desc: voice.desc,
  instruct: voice.instruct,
  filename: voice.ref_audio,
  previewText: voice.preview_text,
}));

const previewByVoiceId = new Map<string, RunpodHeroVoicePreview>(
  RUNPOD_HERO_VOICE_PREVIEWS.map((voice) => [voice.voiceId, voice]),
);

export const RUNPOD_HERO_VOICES: readonly OmniVoiceInfo[] = RUNPOD_HERO_VOICE_PREVIEWS.map((voice) => ({
  voice_id: voice.voiceId,
  desc: voice.desc,
  instruct: voice.instruct,
  preview_url: `/api/omnivoice/preview/${encodeURIComponent(voice.voiceId)}`,
}));

/** Resolve only server-owned filenames from the fixed voice catalog. */
export function runpodHeroVoicePreviewFilename(voiceId: string): string | null {
  return previewByVoiceId.get(voiceId)?.filename ?? null;
}
