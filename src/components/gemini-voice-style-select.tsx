"use client";

import React from "react";
import { GEMINI_VOICE_STYLES } from "@/lib/gemini-voice-styles";

// Shared Gemini speaking-emotion preset picker. Rendered only for the internal
// beta cohort (callers gate on tts38Beta) — default "neutral" is today's
// behavior exactly, so omitting it changes nothing.
export function GeminiVoiceStyleSelect({
  value,
  onChange,
  id = "gemini-voice-style",
  label = "น้ำเสียง",
  selectClassName = "",
  selectStyle,
  labelClassName = "",
}: {
  value: string;
  onChange: (id: string) => void;
  id?: string;
  label?: string;
  selectClassName?: string;
  selectStyle?: React.CSSProperties;
  labelClassName?: string;
}) {
  return (
    <>
      {label ? <p className={labelClassName}>{label}</p> : null}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClassName}
        style={selectStyle}
      >
        {GEMINI_VOICE_STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </>
  );
}
