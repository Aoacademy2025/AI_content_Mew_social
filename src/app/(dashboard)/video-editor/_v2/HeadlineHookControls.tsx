"use client";

import { Check, Sparkles } from "lucide-react";
import {
  HEADLINE_HOOK_PRESETS,
  MAX_HEADLINE_HOOK_CHARS,
  MAX_HEADLINE_HOOK_DURATION_MS,
  MAX_HEADLINE_HOOK_SUBHEAD_CHARS,
  MIN_HEADLINE_HOOK_DURATION_MS,
  autoHeadlineHookDurationMs,
  type HeadlineHookPreset,
} from "@/lib/headline-hook";
import { normalizeLogoOverlayConfig, type LogoOverlayConfig } from "@/lib/logo-overlay";
import { color, font, radius } from "./tokens";
import { GroupLabel } from "./ui";
import type { PostPhaseEditor } from "./usePostPhaseEditor";

const PRESET_LABELS: Record<HeadlineHookPreset, { label: string; description: string }> = {
  viral: { label: "Viral", description: "ตัวใหญ่ ตัดขอบชัด" },
  news: { label: "News", description: "แถบข่าว อ่านเร็ว" },
  clean: { label: "Clean", description: "เรียบ สุภาพ" },
};

function charCount(value: string) {
  return Array.from(value).length;
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label="แสดงพาดหัวเปิดคลิป"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 42,
        height: 24,
        flex: "none",
        padding: 2,
        borderRadius: 999,
        border: `1px solid ${checked ? "rgba(249,115,22,.72)" : color.cardBorder}`,
        background: checked ? "rgba(249,115,22,.28)" : "rgba(255,255,255,.05)",
        cursor: "pointer",
        transition: "all 150ms ease",
      }}
    >
      <span
        style={{
          display: "block",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: checked ? "#FB923C" : color.textFaint,
          transform: checked ? "translateX(17px)" : "translateX(0)",
          transition: "all 150ms ease",
        }}
      />
    </button>
  );
}

function PresetSample({ preset }: { preset: HeadlineHookPreset }) {
  const isNews = preset === "news";
  const isClean = preset === "clean";
  return (
    <div
      aria-hidden="true"
      className="flex h-12 items-center justify-center overflow-hidden"
      style={{
        borderRadius: 8,
        background: "linear-gradient(135deg,#32444a,#11141b 64%)",
      }}
    >
      <div
        style={{
          maxWidth: "88%",
          padding: isNews ? "5px 8px 5px 10px" : isClean ? "5px 8px" : 0,
          borderLeft: isNews ? "3px solid #FF5A2F" : undefined,
          borderRadius: isClean ? 5 : undefined,
          background: isNews ? "rgba(8,8,13,.9)" : isClean ? "rgba(8,8,13,.55)" : undefined,
          color: "#fff",
          font: `800 9px ${font.heading}`,
          lineHeight: 1.08,
          textAlign: "center",
          textShadow: preset === "viral" ? "0 1px 0 #000,1px 0 0 #000,-1px 0 0 #000" : undefined,
        }}
      >
        ประเด็นสำคัญ
        <div style={{ marginTop: 2, color: "#FFE44D", fontSize: 6.5 }}>รู้เรื่องแม้ปิดเสียง</div>
      </div>
    </div>
  );
}

export function HeadlineHookControls({
  editor,
  logoOverlay,
}: {
  editor: PostPhaseEditor;
  logoOverlay?: LogoOverlayConfig;
}) {
  const hook = editor.headlineHook;
  const autoDuration = autoHeadlineHookDurationMs(editor.totalDurationMs);
  const maxDuration = Math.min(MAX_HEADLINE_HOOK_DURATION_MS, editor.totalDurationMs);
  const minDuration = Math.min(MIN_HEADLINE_HOOK_DURATION_MS, maxDuration);
  const isAutoDuration = hook.durationMs === autoDuration;
  const logo = normalizeLogoOverlayConfig(logoOverlay);
  const overlapsTopLogo = !!(
    hook.enabled
    && hook.topPercent <= 27
    && logo?.enabled
    && logo.position.startsWith("top")
  );

  return (
    <div className="flex flex-col gap-5" aria-label="ตั้งค่าพาดหัวเปิดคลิป">
      <section
        className="flex items-center justify-between gap-4"
        style={{
          padding: "12px 13px",
          borderRadius: radius.card,
          border: "1px solid rgba(249,115,22,.24)",
          background: "linear-gradient(135deg,rgba(249,115,22,.11),rgba(249,115,22,.025))",
        }}
      >
        <div>
          <div style={{ font: `600 13px ${font.heading}`, color: color.text }}>พาดหัวเปิดคลิป</div>
          <div style={{ marginTop: 2, fontSize: 10.5, lineHeight: 1.5, color: color.textSecondary }}>
            ค้างต้นคลิปให้เข้าใจประเด็น แม้ยังไม่เปิดเสียง
          </div>
        </div>
        <Switch checked={hook.enabled} onChange={(enabled) => editor.setHeadlineHook({ enabled })} />
      </section>

      <fieldset className="contents">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <GroupLabel>พาดหัวหลัก</GroupLabel>
            <span style={{ fontSize: 9.5, color: charCount(hook.headline) >= MAX_HEADLINE_HOOK_CHARS ? color.warning : color.textFaint }}>
              {charCount(hook.headline)}/{MAX_HEADLINE_HOOK_CHARS}
            </span>
          </div>
          <textarea
            value={hook.headline}
            rows={2}
            maxLength={MAX_HEADLINE_HOOK_CHARS}
            placeholder="สรุปประเด็นที่คนต้องหยุดดู"
            onChange={(event) => editor.setHeadlineHook({ headline: event.target.value })}
            style={{
              width: "100%",
              resize: "none",
              padding: "10px 11px",
              borderRadius: radius.control,
              border: "1px solid rgba(255,255,255,.11)",
              background: "rgba(255,255,255,.045)",
              color: color.text,
              font: `500 13px/1.55 ${font.body}`,
              outline: "none",
            }}
          />
          {!hook.headline && (
            <span role="alert" style={{ fontSize: 10, color: color.warning }}>ใส่พาดหัวก่อนเปิดใช้งาน</span>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <GroupLabel>บรรทัดเสริม (ไม่บังคับ)</GroupLabel>
            <span style={{ fontSize: 9.5, color: color.textFaint }}>
              {charCount(hook.subheadline ?? "")}/{MAX_HEADLINE_HOOK_SUBHEAD_CHARS}
            </span>
          </div>
          <input
            value={hook.subheadline ?? ""}
            maxLength={MAX_HEADLINE_HOOK_SUBHEAD_CHARS}
            placeholder="ข้อมูลเสริมสั้น ๆ หนึ่งบรรทัด"
            onChange={(event) => editor.setHeadlineHook({ subheadline: event.target.value })}
            style={{
              width: "100%",
              padding: "9px 11px",
              borderRadius: radius.control,
              border: "1px solid rgba(255,255,255,.11)",
              background: "rgba(255,255,255,.045)",
              color: color.text,
              font: `400 12px ${font.body}`,
              outline: "none",
            }}
          />
        </section>

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <GroupLabel>AI ช่วยเขียน 3 แบบ</GroupLabel>
            <button
              type="button"
              onClick={() => void editor.generateHeadlineSuggestions()}
              disabled={!editor.headlineSourceText || editor.headlineSuggestionState === "loading"}
              className="flex items-center gap-1.5"
              style={{
                minHeight: 31,
                padding: "5px 10px",
                borderRadius: 9,
                border: "1px solid rgba(139,92,246,.4)",
                background: "rgba(139,92,246,.1)",
                color: color.primary300,
                font: `500 11px ${font.body}`,
                cursor: editor.headlineSuggestionState === "loading" ? "wait" : "pointer",
              }}
            >
              <Sparkles size={12} className={editor.headlineSuggestionState === "loading" ? "animate-pulse" : undefined} />
              {editor.headlineSuggestionState === "loading" ? "กำลังคิด…" : editor.headlineSuggestions.length ? "เขียนใหม่" : "สร้างตัวเลือก"}
            </button>
          </div>
          {editor.headlineSuggestionError && (
            <span role="alert" style={{ fontSize: 10.5, lineHeight: 1.45, color: color.danger }}>
              {editor.headlineSuggestionError}
            </span>
          )}
          {editor.headlineSuggestions.length > 0 && (
            <div className="flex flex-col gap-2">
              {editor.headlineSuggestions.map((suggestion, index) => {
                const selected = suggestion.headline === hook.headline
                  && (suggestion.subheadline ?? "") === (hook.subheadline ?? "");
                return (
                  <button
                    key={`${index}-${suggestion.headline}`}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => editor.selectHeadlineSuggestion(suggestion)}
                    className="relative text-left"
                    style={{
                      padding: "9px 30px 9px 10px",
                      borderRadius: radius.control,
                      border: `1px solid ${selected ? "rgba(249,115,22,.55)" : color.cardBorder}`,
                      background: selected ? "rgba(249,115,22,.09)" : color.cardBg,
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ display: "block", font: `500 11.5px/1.45 ${font.body}`, color: color.text }}>{suggestion.headline}</span>
                    {suggestion.subheadline && (
                      <span style={{ display: "block", marginTop: 3, fontSize: 9.5, lineHeight: 1.4, color: color.textSecondary }}>{suggestion.subheadline}</span>
                    )}
                    {selected && <Check size={13} color="#FB923C" className="absolute right-2.5 top-2.5" />}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <GroupLabel>ค้างบนจอ</GroupLabel>
            <span style={{ font: `500 11px ${font.heading}`, color: "#FDBA74" }}>{(hook.durationMs / 1_000).toFixed(1)} วิ</span>
          </div>
          <input
            type="range"
            min={minDuration}
            max={maxDuration}
            step={500}
            value={hook.durationMs}
            aria-label="ระยะเวลาพาดหัว"
            onChange={(event) => editor.setHeadlineHook({ durationMs: Number(event.target.value) })}
            style={{ width: "100%", accentColor: "#F97316" }}
          />
          <div className="flex items-center justify-between gap-3">
            <span style={{ fontSize: 9.5, lineHeight: 1.4, color: color.textFaint }}>ซับจะเริ่มแสดงหลังจุดนี้ โดยเสียงและ timing เดิมไม่เปลี่ยน</span>
            <button
              type="button"
              aria-pressed={isAutoDuration}
              onClick={() => editor.setHeadlineHook({ durationMs: autoDuration })}
              style={{
                flex: "none",
                padding: "4px 8px",
                borderRadius: 999,
                border: `1px solid ${isAutoDuration ? "rgba(249,115,22,.5)" : color.cardBorder}`,
                background: isAutoDuration ? "rgba(249,115,22,.1)" : "transparent",
                color: isAutoDuration ? "#FDBA74" : color.textSecondary,
                fontSize: 9.5,
                cursor: "pointer",
              }}
            >
              Auto {Math.round(autoDuration / 1_000)} วิ
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <GroupLabel>รูปแบบพาดหัว</GroupLabel>
          <div className="grid grid-cols-3 gap-2">
            {HEADLINE_HOOK_PRESETS.map((preset) => {
              const selected = preset === hook.preset;
              return (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => editor.setHeadlineHook({ preset })}
                  className="text-left"
                  style={{
                    padding: 5,
                    borderRadius: radius.control,
                    border: `1px solid ${selected ? "rgba(249,115,22,.55)" : color.cardBorder}`,
                    background: selected ? "rgba(249,115,22,.08)" : color.cardBg,
                    cursor: "pointer",
                  }}
                >
                  <PresetSample preset={preset} />
                  <span style={{ display: "block", margin: "6px 3px 0", font: `500 10.5px ${font.heading}`, color: selected ? "#FDBA74" : color.text }}>{PRESET_LABELS[preset].label}</span>
                  <span style={{ display: "block", margin: "2px 3px 3px", fontSize: 8.5, color: color.textFaint }}>{PRESET_LABELS[preset].description}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <GroupLabel>ตำแหน่งแนวตั้ง</GroupLabel>
            <span style={{ fontSize: 10, color: color.textSecondary }}>{hook.topPercent}%</span>
          </div>
          <input
            type="range"
            min={10}
            max={42}
            value={hook.topPercent}
            aria-label="ตำแหน่งแนวตั้งของพาดหัว"
            onChange={(event) => editor.setHeadlineHook({ topPercent: Number(event.target.value) })}
            style={{ width: "100%", accentColor: "#F97316" }}
          />
          <span style={{ fontSize: 9.5, color: color.textFaint }}>ลากพาดหัวบน preview เพื่อจัดตำแหน่งได้เช่นกัน</span>
          {overlapsTopLogo && (
            <span role="note" style={{ padding: "7px 9px", borderRadius: 8, background: "rgba(251,191,36,.08)", color: color.warning, fontSize: 10, lineHeight: 1.45 }}>
              พาดหัวอาจทับโลโก้ด้านบน ลองเลื่อนพาดหัวลงหรือย้ายโลโก้
            </span>
          )}
        </section>
      </fieldset>
    </div>
  );
}
