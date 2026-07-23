"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, Pause, Search, Volume2, X } from "lucide-react";
import { toast } from "sonner";
import type { OmniVoiceInfo } from "@/lib/tts-providers";
import { HERO_VOICE_NAME } from "@/lib/hero-voice-brand";
import { color, font } from "./tokens";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("th");
}

export function HeroVoicePicker({
  voices,
  value,
  onChange,
}: {
  voices: OmniVoiceInfo[];
  value: string;
  onChange: (voiceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [loadingVoiceId, setLoadingVoiceId] = useState("");
  const [previewingVoiceId, setPreviewingVoiceId] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inputId = useId();
  const resultsId = useId();
  const search = normalized(query);
  const filtered = useMemo(() => voices.filter((voice) => (
    !search || normalized(`${voice.desc} ${voice.instruct} ${voice.voice_id}`).includes(search)
  )), [search, voices]);
  const selectedIsVisible = filtered.some((voice) => voice.voice_id === value);

  function handleRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % filtered.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + filtered.length) % filtered.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = filtered.length - 1;
    if (nextIndex === null || !filtered[nextIndex]) return;

    event.preventDefault();
    const next = filtered[nextIndex];
    onChange(next.voice_id);
    const radioButtons = event.currentTarget.closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radioButtons?.[nextIndex]?.focus();
  }

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  async function togglePreview(voice: OmniVoiceInfo) {
    if (previewingVoiceId === voice.voice_id && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setPreviewingVoiceId("");
      return;
    }

    audioRef.current?.pause();
    setPreviewingVoiceId("");
    const audio = new Audio(voice.preview_url);
    audioRef.current = audio;
    audio.onended = () => {
      if (audioRef.current === audio) setPreviewingVoiceId("");
    };
    audio.onerror = () => {
      if (audioRef.current !== audio) return;
      setLoadingVoiceId("");
      setPreviewingVoiceId("");
      toast.error("เล่นเสียงตัวอย่างไม่สำเร็จ");
    };

    setLoadingVoiceId(voice.voice_id);
    try {
      await audio.play();
      if (audioRef.current === audio) setPreviewingVoiceId(voice.voice_id);
    } catch {
      if (audioRef.current === audio) {
        setPreviewingVoiceId("");
        toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองกดอีกครั้ง");
      }
    } finally {
      if (audioRef.current === audio) setLoadingVoiceId("");
    }
  }

  return (
    <div className="flex w-full max-w-[520px] flex-col gap-2.5">
      <label htmlFor={inputId} style={{ fontSize: 12, color: color.textSecondary }}>
        ค้นหาเสียง {HERO_VOICE_NAME}
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          style={{ color: color.textSecondary }}
        />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-controls={resultsId}
          placeholder="ค้นหาจากโทนเสียงหรือช่วงวัย"
          className="min-h-11 w-full rounded-[11px] py-2 pl-9 pr-11 text-[13px] outline-none transition-colors placeholder:text-[#8B8BA4] focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            background: "rgba(255,255,255,.05)",
            border: `1px solid ${color.cardBorder}`,
            color: color.text,
            fontFamily: font.body,
            outlineColor: color.primary300,
          }}
        />
        {query && (
          <button
            type="button"
            aria-label="ล้างคำค้นหาเสียง"
            onClick={() => setQuery("")}
            className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-[11px] focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: color.textSecondary, outlineColor: color.primary300 }}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3" style={{ fontSize: 11, color: color.textSecondary }}>
        <span>{filtered.length > 0 ? `พบ ${filtered.length} เสียง` : "ไม่พบเสียงที่ค้นหา"}</span>
        <span>{voices.length} เสียงทั้งหมด</span>
      </div>

      {filtered.length > 0 ? (
        <div
          id={resultsId}
          role="radiogroup"
          aria-label={`เลือกเสียง ${HERO_VOICE_NAME}`}
          className="max-h-[236px] space-y-1 overflow-y-auto pr-1"
        >
          {filtered.map((voice, index) => {
            const selected = voice.voice_id === value;
            const loading = loadingVoiceId === voice.voice_id;
            const previewing = previewingVoiceId === voice.voice_id;
            return (
              <div
                key={voice.voice_id}
                className="flex min-h-11 w-full items-stretch overflow-hidden rounded-[10px] transition-colors"
                style={{
                  background: selected ? color.selectedBg : "rgba(255,255,255,.035)",
                  border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
                  color: selected ? color.text : color.textSecondary,
                  fontFamily: font.body,
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected || (!selectedIsVisible && index === 0) ? 0 : -1}
                  onClick={() => onChange(voice.voice_id)}
                  onKeyDown={(event) => handleRadioKeyDown(event, index)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                  style={{ outlineColor: color.primary300 }}
                >
                  <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-5">{voice.desc || voice.voice_id}</span>
                  {selected && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: color.primary300 }}>
                      <Check className="h-3.5 w-3.5" aria-hidden="true" /> เลือกแล้ว
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`${previewing ? "หยุดเสียงตัวอย่าง" : "ฟังเสียงตัวอย่าง"} ${voice.desc || voice.voice_id}`}
                  aria-busy={loading}
                  aria-pressed={previewing}
                  disabled={loading}
                  onClick={() => void togglePreview(voice)}
                  className="flex w-11 shrink-0 items-center justify-center border-l transition-colors hover:bg-white/[.06] focus-visible:outline-2 focus-visible:outline-offset-[-2px] disabled:cursor-wait"
                  style={{
                    borderColor: selected ? color.selectedBorder : color.cardBorder,
                    color: previewing ? color.primary300 : color.textSecondary,
                    outlineColor: color.primary300,
                  }}
                  title={previewing ? "หยุดเสียงตัวอย่าง" : `ฟังตัวอย่าง ${voice.desc || voice.voice_id}`}
                >
                  {loading
                    ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : previewing
                      ? <Pause className="h-4 w-4" aria-hidden="true" />
                      : <Volume2 className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          id={resultsId}
          role="status"
          className="rounded-[10px] border border-dashed px-3 py-4 text-center text-[12px]"
          style={{ borderColor: color.cardBorder, color: color.textSecondary }}
        >
          ลองค้นหาคำอื่น เช่น “ผู้หญิง”, “วัยรุ่น” หรือ “โทนต่ำ”
        </div>
      )}
    </div>
  );
}
