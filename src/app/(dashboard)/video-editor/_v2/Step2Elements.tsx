"use client";

/**
 * สเต็ป 2 — องค์ประกอบ (จอ 4a): 4 กลุ่ม (บีโรล/เสียง/เพลง/อวตาร) + rail สรุป + CTA เรนเดอร์
 * ทุกกลุ่มมี "ตั้งค่าขั้นสูง" (นโยบาย: ฟีเจอร์เดิมย้ายมาซ่อนตรงนี้ ไม่ตัดทิ้ง — เนื้อจริงมากับ P4/P6)
 * ปุ่มเรนเดอร์จริง = P4 (VideoJob preview mode) — ตอนนี้เป็น stub แจ้งชัด
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Shuffle, Film, ImagePlus, Sparkles, ChevronDown, User, UserX, Music2,
  Play, Pause,
} from "lucide-react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { KIE_IMAGE_MODEL_OPTIONS, PRICED_KIE_MODEL_OPTIONS, AUTO_MIX_PROVIDER_OPTIONS } from "../_components/types";
import { color, font, radius } from "./tokens";
import { BtnPrimary, Card, IconTile, Segmented, GroupLabel } from "./ui";
import { VoicePreviewButton } from "../_components/VoicePreviewButton";
import { estimateClipSecV2 } from "./estimate";
import { useBgm } from "../_hooks/useBgm";
import { MusicLibraryModal } from "./MusicLibraryModal";
import type { V2Project, V2BrollSource } from "./useV2Project";
import type { MixPreset } from "./mix-presets";

// Mix Preset (D5.1) — non-admin b-roll AI mix. Copy = brief verbatim (ห้ามแปลใหม่).
const MIX_PRESETS: { key: MixPreset; label: string; sub: string; badge?: string }[] = [
  { key: "free", label: "ฟรีล้วน", sub: "สต็อกฟรีทั้งหมด · 0 เครดิต" },
  { key: "recommended", label: "ผสม AI แนะนำ", sub: "สต็อก + ภาพ AI แทรก · ~6–9 เครดิต/คลิป", badge: "แนะนำ" },
  { key: "full", label: "AI เต็มที่", sub: "ภาพ AI ทุกช่วง · ~25–45 เครดิต/คลิป" },
];
const MIX_PRESET_LABEL: Record<MixPreset, string> = {
  free: "ฟรีล้วน", recommended: "ผสม AI แนะนำ", full: "AI เต็มที่",
};

// ลำดับตามความสำคัญจริง (review 07-03): สต็อกฟรี = default · ที่เหลือ Beta (admin) · วิดีโอ AI ยังไม่เปิด
const BROLL_OPTIONS: { value: V2BrollSource; title: string; desc: string; icon: React.ReactNode; badge?: string; beta?: boolean; comingSoon?: boolean }[] = [
  { value: "stock", title: "วิดีโอสต็อก", desc: "Pexels · Pixabay", icon: <Film size={16} strokeWidth={1.6} />, badge: "ฟรี · แนะนำ" },
  { value: "kie-image", title: "ภาพ AI", desc: "เจนภาพตามเนื้อหา", icon: <ImagePlus size={16} strokeWidth={1.6} />, beta: true },
  { value: "kie-video", title: "วิดีโอ AI", desc: "เร็ว ๆ นี้", icon: <Sparkles size={16} strokeWidth={1.6} />, beta: true, comingSoon: true },
  { value: "automix", title: "AutoMix", desc: "วิดีโอ + ภาพ ผสมอัตโนมัติ", icon: <Shuffle size={16} strokeWidth={1.6} />, beta: true },
];

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Step2Elements({ p, onRender }: { p: V2Project; onRender: () => Promise<void> }) {
  const bgm = useBgm();
  const estSec = useMemo(() => estimateClipSecV2(p.script), [p.script]);
  const estMin = Math.max(1, Math.ceil(estSec / 60));
  const geminiVoice = GEMINI_VOICES.find(v => v.id === p.geminiVoiceName) ?? GEMINI_VOICES[0];
  // ชื่อเสียง ElevenLabs ที่ตรงกับ voiceId ปัจจุบัน (โชว์ชื่อแทน ID เมื่อ resolve ได้)
  const elevenVoice = p.voiceEngine === "elevenlabs"
    ? p.elevenVoices?.find(v => v.voice_id === p.voiceId.trim())
    : undefined;
  const [submitting, setSubmitting] = useState(false);
  const [musicLibOpen, setMusicLibOpen] = useState(false);
  // chips = 6 เพลงแรกของระบบ · ถ้าเพลงที่เลือกไม่อยู่ในนั้น (ระบบตัวท้าย ๆ / ของผู้ใช้) เอามาโชว์หน้าสุด
  const baseChips = bgm.systemTracks.slice(0, 6).map((t) => ({ ...t, kind: "system" as const }));
  const selectedTrack = p.musicTrack
    ? (p.musicTrackKind === "user"
        ? bgm.userTracks.find((t) => t.filename === p.musicTrack)
        : bgm.systemTracks.find((t) => t.filename === p.musicTrack))
    : null;
  const selectedInChips = p.musicTrackKind === "system" && baseChips.some((t) => t.filename === p.musicTrack);
  const chipTracks = selectedTrack && !selectedInChips
    ? [{ id: selectedTrack.id, title: selectedTrack.title, filename: selectedTrack.filename, kind: p.musicTrackKind }, ...baseChips.slice(0, 5)]
    : baseChips;

  async function handleRender() {
    if (submitting) return;
    setSubmitting(true);
    try { await onRender(); } finally { setSubmitting(false); }
  }

  // CTA เดียว — ใช้ทั้งใน rail (desktop) และ sticky footer (mobile), ไม่ให้ logic แยกกัน
  const primaryCta = (
    <BtnPrimary
      className="w-full"
      onClick={() => void handleRender()}
      disabled={submitting}
      style={submitting ? { opacity: 0.6, cursor: "wait" } : undefined}
    >
      {submitting ? "กำลังส่งงาน…" : "เรนเดอร์วิดีโอ"}
    </BtnPrimary>
  );

  return (
    <>
    <div className="flex min-h-0 flex-1 max-lg:flex-col">
      {/* ── เนื้อหาซ้าย: 4 กลุ่ม ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-7 py-6">
        {/* ย้อนกลับ = คลิก step pill บน topbar (ตัดปุ่มเล็กซ้ำซ้อนออก 07-03) */}

        {/* 1 · บีโรล */}
        <Group title="บีโรล" desc="ภาพประกอบที่สลับทุก 3–5 วิ ระหว่างเสียงพูด">
          {/* Non-admins get the 3 mix presets (D5.1); admins keep the raw source cards +
              provider checkboxes + model picker (in Advanced) unchanged. */}
          {p.isAdmin ? (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {BROLL_OPTIONS.map((o) => {
              // Beta = admin เสมอ · paid (managed-kie) ปลดล็อกภาพ AI/AutoMix · วิดีโอ AI (comingSoon) ยังไม่เปิดให้ใคร
              const locked = o.comingSoon || (o.beta && !p.isAdmin && !p.isPaidManagedKie);
              return (
                <button
                  key={o.value}
                  disabled={locked}
                  onClick={() => !locked && p.setBrollSource(o.value)}
                  className="relative flex flex-col items-start gap-2 text-left"
                  style={{
                    borderRadius: radius.card, padding: "12px 14px",
                    background: p.brollSource === o.value ? color.selectedBg : color.cardBg,
                    border: `1px solid ${p.brollSource === o.value ? color.selectedBorder : color.cardBorder}`,
                    cursor: locked ? "not-allowed" : "pointer",
                    opacity: locked ? 0.55 : 1,
                    transition: "all 150ms ease",
                  }}
                >
                  {o.badge && (
                    <span className="absolute right-2.5 top-2" style={{ fontSize: 10, color: color.primary300, fontWeight: 500 }}>{o.badge}</span>
                  )}
                  {o.beta && (
                    <span className="absolute right-2.5 top-2 rounded-full px-1.5" style={{ fontSize: 9.5, color: color.warning, border: `1px solid rgba(251,191,36,.35)` }}>Beta</span>
                  )}
                  <IconTile size={32}>{o.icon}</IconTile>
                  <span className="flex flex-col">
                    <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{o.title}</span>
                    <span style={{ fontSize: 10.5, color: color.textFaint }}>{o.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
          ) : (
            <MixPresetButtons p={p} />
          )}
          <Advanced note="สลับคลิป/แก้จังหวะรายช่วง (มากับ timeline)">
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2" style={{ fontSize: 11.5, color: color.textSecondary }}>
                จำนวนคลิปบีโรล:
                <Segmented
                  value={p.targetClipCount > 0 ? "custom" : "auto"}
                  onChange={(v) => p.setTargetClipCount(v === "auto" ? 0 : Math.max(1, p.targetClipCount || 8))}
                  options={[{ value: "auto", label: "Auto" }, { value: "custom", label: "กำหนดเอง" }]}
                />
                {p.targetClipCount > 0 && (
                  <input
                    type="number" min={1} max={60} value={p.targetClipCount}
                    onChange={(e) => p.setTargetClipCount(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                    className="w-[64px]"
                    style={{ padding: "6px 8px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }}
                  />
                )}
              </label>
              {(p.isAdmin || p.isPaidManagedKie) && (p.brollSource === "kie-image" || p.brollSource === "automix") && (
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>
                    {p.isAdmin ? "โมเดลภาพ AI (Beta)" : "โมเดลภาพ AI (คิดเครดิตต่อภาพ)"}
                  </span>
                  <select
                    // Paid users have no "system default" ("") option, so surface the
                    // priced default (gpt-image-2) when unset — matches the server's coercion.
                    value={p.isAdmin ? p.kieModel : (p.kieModel || "gpt-image-2-text-to-image")}
                    onChange={(e) => p.setKieModel(e.target.value as typeof p.kieModel)}
                    className="w-full max-w-[280px]"
                    style={{ padding: "8px 10px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }}
                  >
                    {/* Admins get the "system default" escape hatch + all 8 models;
                        paid users get only the 3 priced models (server coerces anything else). */}
                    {p.isAdmin && <option value="" style={{ background: color.bg1 }}>ค่าเริ่มต้นของระบบ</option>}
                    {(p.isAdmin ? KIE_IMAGE_MODEL_OPTIONS : PRICED_KIE_MODEL_OPTIONS).map((m) => (
                      <option key={m.value} value={m.value} style={{ background: color.bg1 }}>{m.label}</option>
                    ))}
                  </select>
                </label>
              )}
              {p.isAdmin && p.brollSource === "automix" && (
                <div className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>แหล่งภาพ Auto Mix (Beta)</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {AUTO_MIX_PROVIDER_OPTIONS.map((o) => (
                      <label key={o.value} className="flex cursor-pointer items-center gap-1.5" style={{ fontSize: 11, color: color.textSecondary }}>
                        <input
                          type="checkbox"
                          checked={p.autoMixProviders.includes(o.value)}
                          onChange={(e) => p.setAutoMixProviders(
                            e.target.checked
                              ? [...p.autoMixProviders, o.value]
                              : p.autoMixProviders.filter((x) => x !== o.value),
                          )}
                          style={{ accentColor: color.primary500 }}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Advanced>
        </Group>

        {/* โหมดอัปคลิปเอง: เสียง/เพลง/อวตาร ไม่เกี่ยว (เสียงมาจากคลิป) */}
        {p.mode === "upload" && (
          <div className="px-3 py-2.5" style={{ borderRadius: radius.card, border: `1px dashed rgba(255,255,255,.14)`, fontSize: 11.5, color: color.textFaint, lineHeight: 1.7 }}>
            โหมดใช้คลิปของคุณ: เสียงพูดมาจากคลิปโดยตรง — ระบบข้ามเสียงพากย์ / เพลง / อวตารให้อัตโนมัติ
          </div>
        )}

        {/* 2 · เสียงพากย์ */}
        {p.mode !== "upload" && (
        <Group title="เสียงพากย์" desc="เสียง AI อ่านสคริปต์ของคุณ">
          <Segmented
            value={p.voiceEngine}
            onChange={p.setVoiceEngine}
            options={[{ value: "gemini", label: "Gemini" }, { value: "elevenlabs", label: "ElevenLabs" }]}
          />
          <Card selected className="flex items-center gap-3" style={{ display: "flex" }}>
            <span
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full"
              style={{ background: "linear-gradient(135deg,#F472B6,#8B5CF6)", color: "#fff" }}
            >
              <Music2 size={15} strokeWidth={1.8} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span style={{ font: `500 13px ${font.heading}` }}>
                {p.voiceEngine === "gemini" ? geminiVoice.label : (elevenVoice?.name || "เสียงโคลนของฉัน")}
              </span>
              <span style={{ fontSize: 10.5, color: color.textFaint }}>
                {p.voiceEngine === "gemini"
                  ? `${geminiVoice.gender} · ${geminiVoice.style}`
                  : (p.voiceId ? `Voice ID: ${p.voiceId.slice(0, 12)}…` : "ยังไม่ได้ตั้ง Voice ID — ตั้งได้ที่ขั้นสูง")}
              </span>
            </span>
            {/* ปุ่มมี w-full+mt-2 ภายใน — คุมความกว้างเองกัน layout ระเบิด */}
            <span className="w-[132px] shrink-0" style={{ marginTop: -8 }}>
              <VoicePreviewButton provider={p.voiceEngine} geminiVoiceName={p.geminiVoiceName} voiceId={p.voiceId} />
            </span>
          </Card>
          <Advanced note="ปรับความเร็ว/อารมณ์เสียง">
            {p.voiceEngine === "gemini" ? (
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 11, color: color.textFaint }}>เลือกเสียง Gemini</span>
                <select
                  value={p.geminiVoiceName}
                  onChange={(e) => p.setGeminiVoiceName(e.target.value)}
                  className="w-full max-w-[280px]"
                  style={{
                    padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                    background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                    color: color.text, fontFamily: font.body,
                  }}
                >
                  {GEMINI_VOICES.map(v => (
                    <option key={v.id} value={v.id} style={{ background: color.bg1 }}>
                      {v.label} — {v.gender} · {v.style}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="flex flex-col gap-3">
                {p.elevenVoices && p.elevenVoices.length > 0 && (
                  <label className="flex flex-col gap-1.5">
                    <span style={{ fontSize: 11, color: color.textFaint }}>เลือกเสียงจากบัญชี ElevenLabs ของคุณ</span>
                    <select
                      value={elevenVoice ? elevenVoice.voice_id : ""}
                      onChange={(e) => { if (e.target.value) p.setVoiceId(e.target.value); }}
                      className="w-full max-w-[280px]"
                      style={{
                        padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                        background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                        color: color.text, fontFamily: font.body,
                      }}
                    >
                      <option value="" style={{ background: color.bg1 }}>— เลือกจากรายชื่อ หรือวาง ID ด้านล่าง —</option>
                      {p.elevenVoices.map(v => (
                        <option key={v.voice_id} value={v.voice_id} style={{ background: color.bg1 }}>
                          {v.name}{v.category ? ` — ${v.category}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>ElevenLabs Voice ID</span>
                  <input
                    value={p.voiceId}
                    onChange={(e) => p.setVoiceId(e.target.value)}
                    placeholder="วาง ElevenLabs Voice ID"
                    className="w-full max-w-[280px]"
                    style={{
                      padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                      background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                      color: color.text, fontFamily: font.body, outline: "none",
                    }}
                  />
                  {p.voiceId.trim() !== "" && p.elevenVoices && p.elevenVoices.length > 0 && !elevenVoice && (
                    <span style={{ fontSize: 10.5, color: color.textFaint }}>
                      ID นี้ไม่อยู่ในรายชื่อเสียงของบัญชีคุณ — ถ้าเป็นเสียง public/shared ก็ยังใช้เรนเดอร์ได้
                    </span>
                  )}
                </label>
              </div>
            )}
          </Advanced>
        </Group>
        )}

        {/* 3 · เพลงประกอบ */}
        {p.mode !== "upload" && (
        <Group title="เพลงประกอบ" desc="เพลงเบา ๆ ใต้เสียงพูด (ลดเสียงอัตโนมัติ) · กดไอคอนเพื่อฟังตัวอย่าง">
          <MusicChips p={p} tracks={chipTracks} />
          <button
            onClick={() => setMusicLibOpen(true)}
            className="self-start"
            style={{ fontSize: 11.5, color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            คลังเพลงทั้งหมด ({bgm.systemTracks.length + bgm.userTracks.length}) · อัปโหลดเพลงของคุณ
          </button>
          <MusicLibraryModal
            open={musicLibOpen}
            onClose={() => setMusicLibOpen(false)}
            systemTracks={bgm.systemTracks}
            userTracks={bgm.userTracks}
            onUploaded={(t) => bgm.setUserTracks([t, ...bgm.userTracks])}
            selected={p.musicTrack}
            selectedKind={p.musicTrackKind}
            onSelect={(filename, kind) => { p.setMusicTrack(filename); p.setMusicTrackKind(kind); }}
          />
          <Advanced note="ระดับเสียงเพลง" />
        </Group>
        )}

        {/* 4 · อวตารพิธีกร */}
        {p.mode !== "upload" && (
        <Group title="อวตารพิธีกร" desc="พิธีกร AI อ่านสคริปต์ให้ (คิดค่า HeyGen ตามวินาที)">
          <Segmented
            value={p.useAvatar ? "avatar" : "faceless"}
            onChange={(v) => p.setUseAvatar(v === "avatar")}
            options={[{ value: "avatar", label: "มีอวตาร" }, { value: "faceless", label: "Faceless" }]}
          />
          {p.useAvatar && (
            <div className="flex items-center gap-3">
              <div
                className="flex h-[66px] w-[50px] items-center justify-center overflow-hidden"
                style={{
                  borderRadius: 10,
                  outline: `1.5px solid ${color.primary500}`, outlineOffset: 2,
                  background: "#1C1C2B",
                }}
              >
                {p.avatarInfo?.previewUrl
                  ? // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.avatarInfo.previewUrl} alt="avatar" className="h-full w-full object-cover" />
                  : <User size={20} strokeWidth={1.5} color={color.textFaint} />}
              </div>
              <div className="flex flex-col">
                <span style={{ font: `500 12.5px ${font.heading}`, color: color.primary300 }}>
                  {p.avatarInfo?.name || (p.avatarId ? p.avatarId : "ยังไม่ได้ตั้งอวตาร")}
                </span>
                <span style={{ fontSize: 10.5, color: color.textFaint }}>
                  {p.avatarId ? "อวตารที่บันทึกไว้ของคุณ" : "ตั้ง Avatar ID ได้ที่ขั้นสูง"}
                </span>
              </div>
            </div>
          )}
          {!p.useAvatar && (
            <div className="flex items-center gap-2" style={{ fontSize: 11.5, color: color.textFaint }}>
              <UserX size={14} strokeWidth={1.6} /> วิดีโอเสียง + บีโรล ไม่มีพิธีกร
            </div>
          )}
          <Advanced note="ตำแหน่ง/สเกล WYSIWYG (ใช้ preset ที่บันทึกไว้ไปก่อน)">
            {p.useAvatar && (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>HeyGen Avatar ID</span>
                  <input
                    value={p.avatarId}
                    onChange={(e) => p.setAvatarId(e.target.value)}
                    placeholder="วาง HeyGen Avatar ID"
                    className="w-full max-w-[280px]"
                    style={{
                      padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                      background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                      color: color.text, fontFamily: font.body, outline: "none",
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>โหมดพิธีกร (HeyGen คิดเงินตามวินาทีที่เจน)</span>
                  <Segmented
                    value={p.avatarMode}
                    onChange={p.setAvatarMode}
                    options={[
                      { value: "bookend", label: "เปิดคลิป" },
                      { value: "bookend-both", label: "เปิด+ปิด" },
                      { value: "full", label: "ทั้งคลิป" },
                    ]}
                  />
                </label>
                {p.avatarMode !== "full" && (
                  <div className="flex items-center gap-3" style={{ fontSize: 11.5, color: color.textSecondary }}>
                    <label className="flex items-center gap-1.5">
                      เปิด
                      <input type="number" min={1} max={30} value={p.avatarIntroSecs}
                        onChange={(e) => p.setAvatarIntroSecs(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
                        className="w-[52px]" style={{ padding: "5px 7px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }} />
                      วิ
                    </label>
                    {p.avatarMode === "bookend-both" && (
                      <label className="flex items-center gap-1.5">
                        ปิด
                        <input type="number" min={1} max={30} value={p.avatarTailSecs}
                          onChange={(e) => p.setAvatarTailSecs(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
                          className="w-[52px]" style={{ padding: "5px 7px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }} />
                        วิ
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
          </Advanced>
        </Group>
        )}
      </div>

      {/* ── Right rail 372px ── */}
      <aside
        className="flex flex-col gap-4 overflow-y-auto px-5 py-5 lg:w-[372px] lg:shrink-0 max-lg:w-full max-lg:shrink"
        style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}
      >
        {/* Preview 9:16 (196×348) — พรีวิวจริงมีแค่หลังเรนเดอร์ ซ่อนบนมือถือเพื่อประหยัดที่ */}
        <div className="flex justify-center max-lg:hidden">
          <div
            className="flex h-[348px] w-[196px] flex-col items-center justify-center gap-2"
            style={{ borderRadius: 16, background: "#0A0A12", border: `1px solid ${color.cardBorder}` }}
          >
            <Film size={22} strokeWidth={1.4} color={color.textFaintest} />
            <span style={{ fontSize: 10.5, color: color.textFaintest, textAlign: "center", lineHeight: 1.6 }}>
              พรีวิวจะแสดงหลังเรนเดอร์<br />(9:16)
            </span>
          </div>
        </div>

        {/* สรุปการตั้งค่า */}
        <div style={{ borderRadius: radius.card, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}>
          <div className="px-4 pt-3 pb-1"><GroupLabel>สรุปการตั้งค่า</GroupLabel></div>
          {p.mode === "upload" ? (
            <>
              <SummaryRow label="ที่มา" value="คลิปที่อัปโหลดเอง" />
              <SummaryRow label="บีโรล" value={`${p.isAdmin ? (BROLL_OPTIONS.find(o => o.value === p.brollSource)?.title ?? "-") : MIX_PRESET_LABEL[p.mixPreset]} · แทรก cutaway`} />
              <SummaryRow label="เสียง" value="จากคลิปของคุณ (ต่อเนื่อง)" />
              <SummaryRow label="ซับไทย" value="ถอดจากเสียงอัตโนมัติ" last />
            </>
          ) : (
            <>
              <SummaryRow label="สคริปต์" value={`${p.script.split("\n").filter(l => l.trim()).length} เซ็กเมนต์ · คลิปยาว ~${fmtTime(estSec)}`} />
              <SummaryRow label="บีโรล" value={p.isAdmin ? (BROLL_OPTIONS.find(o => o.value === p.brollSource)?.title ?? "-") : MIX_PRESET_LABEL[p.mixPreset]} />
              <SummaryRow label="เสียง" value={p.voiceEngine === "gemini" ? `Gemini · ${geminiVoice.label}` : `ElevenLabs${elevenVoice ? ` · ${elevenVoice.name}` : ""}`} />
              <SummaryRow label="เพลง" value={p.musicTrack === null ? "ไม่ใส่" : (selectedTrack?.title ?? "ยังไม่เลือก")} />
              <SummaryRow label="อวตาร" value={p.useAvatar ? (p.avatarInfo?.name || p.avatarId || "ยังไม่ตั้ง") : "Faceless"} last />
            </>
          )}
        </div>

        {/* CTA เดียว — ปุ่มซ่อนบนมือถือ (ย้ายไป sticky footer), แต่ caption ยังโชว์เหนือ footer */}
        <div className="flex flex-col gap-2">
          <div className="max-lg:hidden">{primaryCta}</div>
          <span style={{ fontSize: 10.5, color: color.textFaint, textAlign: "center", lineHeight: 1.6 }}>
            คลิปยาว ~{fmtTime(estSec)}
            {p.usage?.minutes ? ` · ใช้ ~${estMin} จาก ${p.usage.minutes.remaining} นาทีที่เหลือ` : ""}
            {" "}· แก้ทุกอย่างได้ทีหลัง
          </span>
        </div>
      </aside>
    </div>

    {/* Sticky bottom CTA — มือถือเท่านั้น, ใช้ handler/label เดียวกับปุ่มใน rail */}
    <div
      className="lg:hidden sticky bottom-0 z-10"
      style={{
        background: color.bg0,
        borderTop: `1px solid ${color.cardBorder}`,
        padding: "12px 14px calc(12px + env(safe-area-inset-bottom))",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {primaryCta}
    </div>
    </>
  );
}

/** Mix Preset (D5.1) — 3 ปุ่มเลือกสัดส่วน AI ในบีโรล (แทนบล็อก checkbox ของ admin สำหรับ
 *  ผู้ใช้ทั่วไป). FREE (ไม่ paid) เลือกได้แค่ "ฟรีล้วน"; อีก 2 ปุ่มถูก disable.
 *  Task 7 badge: ก่อนเปิดตัวฟีเจอร์ (managedKieOn=false) locked-copy = "เร็ว ๆ นี้" (ไม่ใช่
 *  ข้อความชวนอัปเกรด เพราะผู้ใช้ paid ก็ยังใช้ไม่ได้ — ฟีเจอร์ยังไม่เปิด ไม่ใช่เพราะเขาไม่จ่าย);
 *  หลังเปิดตัว (managedKieOn=true) แต่ยังไม่ paid → กลับไปใช้ "อัปเกรดเพื่อใช้ภาพ AI" เดิม.
 *  เลือก preset → p.setMixPreset ขับ brollSource/providers/weights. */
function MixPresetButtons({ p }: { p: V2Project }) {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      {MIX_PRESETS.map((pr) => {
        // FREE/feature-off users: only "ฟรีล้วน" is selectable (AI presets locked).
        // Formula unchanged from pre-Task-7 — only the LOCKED-STATE COPY branches below.
        const locked = pr.key !== "free" && !p.isPaidManagedKie;
        // Sub-reason for the lock, copy-only: not launched yet vs. launched-but-not-paid.
        const comingSoon = locked && !p.managedKieOn;
        const selected = p.mixPreset === pr.key;
        return (
          <button
            key={pr.key}
            disabled={locked}
            title={locked ? (comingSoon ? "เร็ว ๆ นี้ — กำลังเตรียมเปิดให้ใช้งาน" : "อัปเกรดเพื่อใช้ภาพ AI") : undefined}
            onClick={() => { if (!locked) p.setMixPreset(pr.key); }}
            className="relative flex flex-col items-start gap-1.5 text-left"
            style={{
              borderRadius: radius.card, padding: "12px 14px",
              background: selected ? color.selectedBg : color.cardBg,
              border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
              cursor: locked ? "not-allowed" : "pointer",
              opacity: locked ? 0.55 : 1,
              transition: "all 150ms ease",
            }}
          >
            {comingSoon ? (
              <span className="absolute right-2.5 top-2 rounded-full px-1.5" style={{ fontSize: 9.5, color: color.warning, border: "1px solid rgba(251,191,36,.35)" }}>เร็ว ๆ นี้</span>
            ) : pr.badge && (
              <span className="absolute right-2.5 top-2" style={{ fontSize: 10, color: color.primary300, fontWeight: 500 }}>{pr.badge}</span>
            )}
            <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{pr.label}</span>
            <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.5 }}>{pr.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

/** ชิปเพลง + ปุ่มฟังตัวอย่างในตัว (logic เดียวกับ toggleMusicPreview ของ OrderPanel, URL = /api/music/<filename>) */
function MusicChips({ p, tracks }: { p: V2Project; tracks: { id: string; title: string; filename: string; kind: "system" | "user" }[] }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState("");

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewing("");
  }
  useEffect(() => () => stopPreview(), []);

  async function togglePreview(filename: string) {
    if (previewing === filename) { stopPreview(); return; }
    stopPreview();
    const audio = new Audio(`/api/music/${filename}`);
    audio.volume = 0.5;
    audio.preload = "auto";
    audioRef.current = audio;
    setPreviewing(filename);
    audio.onended = () => { if (audioRef.current === audio) stopPreview(); };
    audio.onerror = () => { if (audioRef.current === audio) { stopPreview(); toast.error("เล่นเพลงตัวอย่างไม่สำเร็จ"); } };
    try { await audio.play(); } catch { if (audioRef.current === audio) { stopPreview(); toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองกดอีกครั้ง"); } }
  }

  const chipStyle = (selected: boolean, dashed = false): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "6px 10px 6px 14px", borderRadius: radius.pill,
    background: selected ? color.selectedBg : "rgba(255,255,255,.04)",
    border: `1px ${dashed ? "dashed" : "solid"} ${selected ? color.selectedBorder : color.cardBorder}`,
    color: selected ? color.primary300 : color.textSecondary,
    font: `${selected ? 500 : 400} 12.5px ${font.body}`,
    cursor: "pointer", transition: "all 150ms ease",
  });

  return (
    <div className="flex flex-wrap gap-2">
      {tracks.map((t, i) => (
        <span
          key={t.id}
          role="button"
          tabIndex={0}
          onClick={() => { p.setMusicTrack(t.filename); p.setMusicTrackKind(t.kind); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { p.setMusicTrack(t.filename); p.setMusicTrackKind(t.kind); } }}
          style={chipStyle(p.musicTrack === t.filename)}
        >
          {t.title}{i === 0 ? " · แนะนำ" : ""}
          <span
            role="button"
            aria-label={previewing === t.filename ? "หยุดตัวอย่าง" : "ฟังตัวอย่าง"}
            onClick={(e) => { e.stopPropagation(); void togglePreview(t.filename); }}
            className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
            style={{
              background: previewing === t.filename ? "rgba(52,211,153,.15)" : "rgba(255,255,255,.07)",
              color: previewing === t.filename ? color.success : color.textSecondary,
            }}
          >
            {previewing === t.filename
              ? <Pause size={9} strokeWidth={2} />
              : <Play size={9} strokeWidth={2} style={{ marginLeft: 1 }} />}
          </span>
        </span>
      ))}
      <span
        role="button"
        tabIndex={0}
        onClick={() => { stopPreview(); p.setMusicTrack(null); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { stopPreview(); p.setMusicTrack(null); } }}
        style={{ ...chipStyle(p.musicTrack === null, true), padding: "6px 14px" }}
      >
        ไม่ใส่เพลง
      </span>
    </div>
  );
}

function Group({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <div style={{ font: `500 13.5px ${font.heading}` }}>{title}</div>
        <div style={{ fontSize: 11, color: color.textFaint }}>{desc}</div>
      </div>
      {children}
    </section>
  );
}

/** ตั้งค่าขั้นสูง — จุดพักของฟีเจอร์เดิมทั้งหมด (นโยบาย "ย้าย ไม่ตัด") */
function Advanced({ note, children }: { note: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1"
        style={{ fontSize: 11, color: color.textFaint, background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        <ChevronDown size={12} strokeWidth={1.8} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 150ms ease" }} />
        ตั้งค่าขั้นสูง
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 px-3 py-2.5" style={{ borderRadius: radius.control, border: `1px dashed rgba(255,255,255,.12)` }}>
          {children}
          <span style={{ fontSize: 11, color: color.textFaintest, lineHeight: 1.7, display: "block" }}>
            {children ? "กำลังตามมา: " : "จะอยู่ตรงนี้: "}{note}
          </span>
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2.5"
      style={{ borderBottom: last ? "none" : `1px solid ${color.cardBorder}` }}
    >
      <span style={{ fontSize: 11.5, color: color.textFaint }}>{label}</span>
      <span style={{ fontSize: 12, color: color.text, textAlign: "right", maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
