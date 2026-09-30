"use client";

import React from "react";
import { GEMINI_VOICE_STYLES } from "@/lib/gemini-voice-styles";

// The closed control stays on the dark theme. The opened menu is the platform
// popup, which is white, so option text must be dark or it disappears.
const MENU_OPTION_STYLE: React.CSSProperties = {
  backgroundColor: "#ffffff",
  color: "#111827",
};

export const GEMINI_VOICE_STYLE_NOTE =
  "ปกติ ใช้ Gemini 3.8 ล่าสุด · เลือกน้ำเสียงอื่นจะใช้ Gemini 2.5";

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
          <option key={s.id} value={s.id} style={MENU_OPTION_STYLE}>
            {s.label}
          </option>
        ))}
      </select>
      <p style={{ margin: "2px 0 0", maxWidth: 280, fontSize: 11, lineHeight: 1.55, color: "rgba(255,255,255,0.5)" }}>
        {GEMINI_VOICE_STYLE_NOTE}
      </p>
    </>
  );
}
