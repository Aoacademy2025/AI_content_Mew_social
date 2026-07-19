"use client";

import React from "react";
import { Loader2, Pause, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TtsProvider } from "@/lib/tts-providers";

const VOICE_PREVIEW_TEXT = "สวัสดีครับ นี่คือตัวอย่างเสียงสำหรับวิดีโอของคุณ";

type PreviewResponse = {
  voiceUrl?: string;
  error?: string;
  missingKey?: string;
  code?: string;
};

export function VoicePreviewButton({
  provider,
  geminiVoiceName,
  voiceId,
  omniVoiceId = "voice_01",
  omniPreviewUrl,
  onPlanError,
}: {
  provider: TtsProvider;
  geminiVoiceName: string;
  voiceId: string;
  omniVoiceId?: string;
  omniPreviewUrl?: string;
  onPlanError?: (msg: string) => void;
}) {
  const [loading, setLoading] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState("");
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const voiceKey = provider === "gemini"
    ? geminiVoiceName
    : provider === "omnivoice"
      ? omniVoiceId
      : voiceId.trim();

  React.useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    setPreviewUrl("");
  }, [provider, voiceKey]);

  React.useEffect(() => () => {
    audioRef.current?.pause();
  }, []);

  async function playUrl(url: string) {
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => {
      setPlaying(false);
      toast.error("เล่นเสียงตัวอย่างไม่สำเร็จ");
    };
    setPlaying(true);
    await audio.play().catch(() => {
      setPlaying(false);
      toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองกดอีกครั้ง");
    });
  }

  async function runPreview() {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    if (previewUrl) {
      await playUrl(previewUrl);
      return;
    }
    if (provider === "elevenlabs" && !voiceKey) {
      toast.error("ใส่ ElevenLabs Voice ID ก่อนฟังตัวอย่าง");
      return;
    }
    if (provider === "omnivoice") {
      if (!omniPreviewUrl) {
        toast.error("ยังโหลดเสียงตัวอย่าง OmniVoice ไม่สำเร็จ");
        return;
      }
      setPreviewUrl(omniPreviewUrl);
      await playUrl(omniPreviewUrl);
      return;
    }

    setLoading(true);
    try {
      const endpoint = provider === "gemini"
        ? "/api/videos/tts-gemini"
        : "/api/videos/tts";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider === "gemini"
          ? { preview: true, text: VOICE_PREVIEW_TEXT, voiceName: geminiVoiceName }
          : { preview: true, text: VOICE_PREVIEW_TEXT, voiceId: voiceKey, languageCode: "th" }),
      });
      const data = await res.json().catch(() => ({} as PreviewResponse)) as PreviewResponse;
      if (res.status === 403) {
        onPlanError?.(data.error ?? "ฟีเจอร์นี้ใช้ได้เฉพาะแผน Pro");
        return;
      }
      if (!res.ok || !data.voiceUrl) {
        if (data.missingKey === "gemini" || data.code === "KEY_REQUIRED") toast.error("เพิ่ม Gemini API key ใน Settings ก่อน");
        else if (data.missingKey === "elevenlabs") toast.error("เพิ่ม ElevenLabs API key ใน Settings ก่อน");
        else toast.error(data.error ?? "สร้างเสียงตัวอย่างไม่สำเร็จ");
        return;
      }
      setPreviewUrl(data.voiceUrl);
      await playUrl(data.voiceUrl);
    } catch {
      toast.error("สร้างเสียงตัวอย่างไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={runPreview}
      disabled={loading}
      className={cn(
        "mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-bold transition-colors",
        playing
          ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
          : "border-[#2a2a36] bg-[#1a1a22] text-slate-400 hover:border-violet-500/35 hover:text-violet-300",
        loading && "cursor-wait opacity-70",
      )}
      title="ฟังเสียงตัวอย่าง"
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : playing ? <Pause className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      {loading ? "กำลังสร้าง..." : playing ? "หยุดตัวอย่าง" : "ฟังตัวอย่าง"}
    </button>
  );
}
