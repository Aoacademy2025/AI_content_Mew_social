import type { OmniVoiceInfo } from "@/lib/tts-providers";

export type RunpodHeroVoicePreview = {
  voiceId: string;
  desc: string;
  instruct: string;
  filename: string;
  previewText: string;
};

export const RUNPOD_HERO_VOICE_PREVIEWS = [
  {
    voiceId: "voice_01",
    desc: "เสียงผู้ชาย โทนปกติ",
    instruct: "male",
    filename: "voice_01.wav",
    previewText: "สวัสดีครับ นี่คือตัวอย่างเสียงสำหรับวิดีโอของคุณ",
  },
  {
    voiceId: "voice_02",
    desc: "เสียงผู้หญิง โทนปกติ",
    instruct: "female",
    filename: "voice_02.wav",
    previewText: "สวัสดีค่ะ นี่คือตัวอย่างเสียงสำหรับวิดีโอของคุณ",
  },
  {
    voiceId: "voice_03",
    desc: "เสียงผู้ชาย โทนสูง สดใส",
    instruct: "male, high pitch",
    filename: "voice_03.wav",
    previewText: "สวัสดีครับ นี่คือตัวอย่างเสียงสำหรับวิดีโอของคุณ",
  },
] as const satisfies readonly RunpodHeroVoicePreview[];

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
