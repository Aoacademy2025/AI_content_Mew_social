"use client";

/**
 * Editor v2 component kit — Design System v1.1.
 * กฎเหล็ก: 1 จอ = 1 ปุ่ม BtnPrimary เท่านั้น · line icon (Lucide) เท่านั้น ห้าม emoji
 */

import React, { useState } from "react";
import { Check } from "lucide-react";
import { color, radius, shadow, glass, font, fx } from "./tokens";

type DivProps = React.HTMLAttributes<HTMLDivElement>;
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

function mergeStyle(base: React.CSSProperties, style?: React.CSSProperties) {
  return style ? { ...base, ...style } : base;
}

// ─── Buttons (ลำดับ 4 ระดับ) ────────────────────────────────────────────────

/** 1 · Primary — gradient + เงาเรือง · action หลักเดียวของหน้าจอ */
export function BtnPrimary({ style, onMouseEnter, onMouseLeave, ...rest }: BtnProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      {...rest}
      onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
      style={mergeStyle({
        padding: "12px 24px", borderRadius: radius.control + 1, border: "none",
        background: color.gradientPrimary, color: "#fff",
        font: `600 14px ${font.heading}`, cursor: "pointer",
        boxShadow: shadow.primaryBtn, transition: fx.transition,
        filter: hover ? fx.hoverBrightness : undefined,
      }, style)}
    />
  );
}

/** 2 · Secondary — glass · action สำคัญรอง (แชร์, ดูตัวอย่าง) */
export function BtnSecondary({ style, onMouseEnter, onMouseLeave, ...rest }: BtnProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      {...rest}
      onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
      style={mergeStyle({
        padding: "12px 24px", borderRadius: radius.control + 1,
        background: hover ? "rgba(255,255,255,.11)" : "rgba(255,255,255,.07)",
        border: "1px solid rgba(255,255,255,.12)", color: "#E6E6F0",
        font: `500 13.5px ${font.body}`, cursor: "pointer", transition: fx.transition,
      }, style)}
    />
  );
}

/** 3 · Ghost — ขอบบาง · action ย่อยที่ซ้ำหลายจุด (แก้ไข, ยกเลิก) */
export function BtnGhost({ style, onMouseEnter, onMouseLeave, ...rest }: BtnProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      {...rest}
      onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
      style={mergeStyle({
        padding: "12px 24px", borderRadius: radius.control + 1, background: "none",
        border: `1px solid ${hover ? "rgba(255,255,255,.25)" : "rgba(255,255,255,.12)"}`,
        color: hover ? "#E6E6F0" : color.textSecondary,
        font: `400 13px ${font.body}`, cursor: "pointer", transition: fx.transition,
      }, style)}
    />
  );
}

/** 4 · เพิ่ม/ว่าง — เส้นประ · จุดเพิ่มของใหม่ และ empty state */
export function BtnDashed({ style, onMouseEnter, onMouseLeave, ...rest }: BtnProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      {...rest}
      onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
      style={mergeStyle({
        padding: "12px 24px", borderRadius: radius.control + 1, background: "none",
        border: `1px dashed ${hover ? "#A78BFA" : "rgba(255,255,255,.18)"}`,
        color: hover ? color.primary300 : color.textSecondary,
        font: `400 13px ${font.body}`, cursor: "pointer", transition: fx.transition,
      }, style)}
    />
  );
}

/** ปุ่มอันตราย — ขอบแดง ไม่มีพื้นทึบ · ผู้เรียกต้องทำ ยืนยัน 2 ชั้น เอง */
export function BtnDanger({ style, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      style={mergeStyle({
        padding: "6px 12px", borderRadius: 8, background: "none",
        border: `1px solid ${color.danger}`, color: color.danger,
        font: `400 12px ${font.body}`, cursor: "pointer", transition: fx.transition,
      }, style)}
    />
  );
}

// ─── Surfaces ───────────────────────────────────────────────────────────────

/** การ์ดมาตรฐาน — selected = โทนม่วงตามดีไซน์ */
export function Card({ selected = false, style, ...rest }: DivProps & { selected?: boolean }) {
  return (
    <div
      {...rest}
      style={mergeStyle({
        borderRadius: radius.card, padding: "12px 14px",
        background: selected ? color.selectedBg : "rgba(255,255,255,.04)",
        border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
        transition: fx.transition,
      }, style)}
    />
  );
}

/** แผงลอย (liquid glass) — เฉพาะชั้นที่ลอย: แผงเรนเดอร์/modal/dock */
export function GlassPanel({ style, ...rest }: DivProps) {
  return (
    <div
      {...rest}
      style={mergeStyle({
        borderRadius: radius.panel,
        background: glass.background,
        backdropFilter: glass.backdropFilter,
        WebkitBackdropFilter: glass.backdropFilter,
        border: glass.border,
        boxShadow: glass.boxShadow,
      }, style)}
    />
  );
}

/** Icon tile 32–34px สำหรับหัวการ์ด */
export function IconTile({ size = 34, style, ...rest }: DivProps & { size?: number }) {
  return (
    <div
      {...rest}
      style={mergeStyle({
        width: size, height: size, borderRadius: radius.iconTile,
        background: "rgba(255,255,255,.06)", border: `1px solid ${color.cardBorder}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: color.primary300, flex: "none",
      }, style)}
    />
  );
}

// ─── Controls ───────────────────────────────────────────────────────────────

/** ชิป pill — เลือกอยู่ = โทนม่วง */
export function Chip({ selected = false, style, onMouseEnter, onMouseLeave, ...rest }: BtnProps & { selected?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      {...rest}
      onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
      style={mergeStyle({
        padding: "6px 14px", borderRadius: radius.pill,
        background: selected ? color.selectedBg : hover ? "rgba(255,255,255,.07)" : "rgba(255,255,255,.04)",
        border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
        color: selected ? color.primary300 : color.textSecondary,
        font: `${selected ? 500 : 400} 12.5px ${font.body}`,
        cursor: "pointer", transition: fx.transition,
      }, style)}
    />
  );
}

/** Segmented control — เช่น ElevenLabs|Gemini, 1|2|3 ประโยค */
export function Segmented<T extends string>({ options, value, onChange, style, semantics, id, ariaLabel }: {
  options: { value: T; label: string; badge?: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: React.CSSProperties;
  semantics?: "tabs";
  id?: string;
  ariaLabel?: string;
}) {
  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (semantics !== "tabs") return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + options.length) % options.length;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % options.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    onChange(options[nextIndex].value);
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  }

  return (
    <div
      role={semantics === "tabs" ? "tablist" : ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
      aria-orientation={semantics === "tabs" ? "horizontal" : undefined}
      style={mergeStyle({
        display: "inline-flex", gap: 3, padding: 3, borderRadius: radius.control,
        background: "rgba(255,255,255,.04)", border: `1px solid ${color.cardBorder}`,
      }, style)}
    >
      {options.map((o, index) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={semantics === "tabs" ? "tab" : undefined}
            id={semantics === "tabs" && id ? `${id}-${o.value}-tab` : undefined}
            aria-controls={semantics === "tabs" && id ? `${id}-${o.value}-panel` : undefined}
            aria-selected={semantics === "tabs" ? active : undefined}
            aria-pressed={semantics === "tabs" ? undefined : active}
            aria-label={o.badge ? `${o.label} ${o.badge}` : undefined}
            title={o.title}
            disabled={o.disabled}
            tabIndex={semantics === "tabs" ? (active ? 0 : -1) : undefined}
            onClick={() => { if (!o.disabled) onChange(o.value); }}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className="min-h-11 min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 lg:min-h-9"
            style={{
              padding: "6px 14px", borderRadius: radius.control - 3, border: "none",
              background: active ? color.gradientPrimary : "none",
              color: active ? "#fff" : color.textSecondary,
              font: `${active ? 500 : 400} 12.5px ${font.body}`,
              cursor: o.disabled ? "not-allowed" : "pointer", transition: fx.transition,
              opacity: o.disabled ? 0.62 : 1,
              outlineColor: color.primary300,
            }}
          >
            <span className="flex min-w-0 flex-col items-center justify-center leading-tight">
              <span className="max-w-full truncate">{o.label}</span>
              {o.badge && (
                <span className="mt-0.5 text-[9px] font-medium" style={{ color: active ? "#FFF3BF" : color.warning }}>
                  {o.badge}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** สวิตช์เปิด/ปิด */
export function Toggle({ on, onChange, ariaLabel }: { on: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      style={{
        width: 40, height: 23, borderRadius: radius.pill, border: "none", padding: 0,
        background: on ? "linear-gradient(135deg,#A78BFA,#6C4CF4)" : "rgba(255,255,255,.10)",
        position: "relative", cursor: "pointer", transition: fx.transition,
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: on ? 19 : 2, width: 19, height: 19,
        borderRadius: "50%", background: "#fff", transition: "left 150ms ease",
      }} />
    </button>
  );
}

/** ช่องกรอกข้อความ — focus = ขอบม่วง 1.5px + ring */
export function TextInput({ style, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  const [focus, setFocus] = useState(false);
  return (
    <input
      {...rest}
      onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
      onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
      style={mergeStyle({
        padding: "10px 14px", borderRadius: radius.control,
        background: "rgba(255,255,255,.05)",
        border: focus ? `1.5px solid ${color.primary500}` : "1px solid rgba(255,255,255,.10)",
        boxShadow: focus ? shadow.focusRing : undefined,
        fontSize: 13, color: color.text, outline: "none",
        fontFamily: font.body, transition: fx.transition,
      }, style)}
    />
  );
}

/** Label กลุ่มการตั้งค่า — uppercase 10.5px letter-spacing .08em */
export function GroupLabel({ style, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      style={mergeStyle({
        fontSize: 10.5, color: color.textFaint, textTransform: "uppercase",
        letterSpacing: "0.08em", fontFamily: font.body, fontWeight: 500,
      }, style)}
    />
  );
}

// ─── Step indicator (ทุกจอในเฟสตั้งค่า) ────────────────────────────────────

export const V2_STEPS = [
  { num: "01", label: "สคริปต์" },
  { num: "02", label: "องค์ประกอบ" },
  { num: "03", label: "แต่งซับ" },
] as const;

export function StepIndicator({ active = 0, done = [] as number[], onStepClick, compact = false }: {
  active?: number;
  done?: number[];
  /** คลิกย้อนกลับสเต็ปที่ผ่านแล้ว (done) — สเต็ปข้างหน้าคลิกไม่ได้ */
  onStepClick?: (i: number) => void;
  /** ซ่อน label ข้อความ เหลือแต่เลข/เช็ค (จอแคบ <lg) — desktop ไม่ส่ง = เหมือนเดิมทุก px */
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 4, borderRadius: radius.pill,
        padding: 5, background: "rgba(255,255,255,.04)", border: `1px solid ${color.cardBorder}`,
      }}
    >
      {V2_STEPS.map((s, i) => {
        const isActive = i === active;
        const isDone = done.includes(i);
        const clickable = !!onStepClick && isDone && !isActive;
        return (
          <button
            key={s.num}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onStepClick(i)}
            title={clickable ? `กลับไป ${s.label}` : undefined}
            style={{
              display: "flex", alignItems: "center", gap: 6, borderRadius: radius.pill,
              padding: "4px 12px", border: "none",
              background: isActive ? color.gradientPrimary : "none",
              cursor: clickable ? "pointer" : "default",
              transition: fx.transition,
            }}
            onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = "rgba(255,255,255,.07)"; }}
            onMouseLeave={(e) => { if (clickable) e.currentTarget.style.background = "none"; }}
          >
            {isDone ? (
              <Check size={12} strokeWidth={2.5} color={color.success} />
            ) : (
              <span style={{ font: `600 10.5px ${font.heading}`, color: isActive ? "rgba(255,255,255,.75)" : color.textFaintest }}>
                {s.num}
              </span>
            )}
            {!compact && (
              <span style={{ font: `500 12px ${font.heading}`, color: isActive ? "#fff" : isDone ? color.textSecondary : color.textFaintest }}>
                {s.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
