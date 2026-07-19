"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Check, Search, X } from "lucide-react";
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
    const radioButtons = event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radioButtons?.[nextIndex]?.focus();
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
            return (
              <button
                key={voice.voice_id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected || (!selectedIsVisible && index === 0) ? 0 : -1}
                onClick={() => onChange(voice.voice_id)}
                onKeyDown={(event) => handleRadioKeyDown(event, index)}
                className="flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  background: selected ? color.selectedBg : "rgba(255,255,255,.035)",
                  border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
                  color: selected ? color.text : color.textSecondary,
                  fontFamily: font.body,
                  outlineColor: color.primary300,
                }}
              >
                <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-5">{voice.desc || voice.voice_id}</span>
                {selected && (
                  <span className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: color.primary300 }}>
                    <Check className="h-3.5 w-3.5" aria-hidden="true" /> เลือกแล้ว
                  </span>
                )}
              </button>
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
