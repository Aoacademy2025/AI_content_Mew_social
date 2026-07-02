"use client";

/**
 * สเต็ป 2 — องค์ประกอบ (จอ 4a): 4 กลุ่ม (บีโรล/เสียง/เพลง/อวตาร) + rail สรุป + CTA เรนเดอร์
 * ทุกกลุ่มมี "ตั้งค่าขั้นสูง" (นโยบาย: ฟีเจอร์เดิมย้ายมาซ่อนตรงนี้ ไม่ตัดทิ้ง — เนื้อจริงมากับ P4/P6)
 * ปุ่มเรนเดอร์จริง = P4 (VideoJob preview mode) — ตอนนี้เป็น stub แจ้งชัด
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Shuffle, Film, ImagePlus, Sparkles, ChevronDown, User, UserX, Music2,
} from "lucide-react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import { color, font, radius } from "./tokens";
import { BtnPrimary, Card, Chip, IconTile, Segmented, GroupLabel } from "./ui";
import { VoicePreviewButton } from "../_components/VoicePreviewButton";
import { estimateScriptDurationSec } from "../_lib/estimate-duration";
import { useBgm } from "../_hooks/useBgm";
import type { V2Project, V2BrollSource } from "./useV2Project";

const BROLL_OPTIONS: { value: V2BrollSource; title: string; desc: string; icon: React.ReactNode; badge?: string; pro?: boolean }[] = [
  { value: "automix", title: "AutoMix", desc: "วิดีโอ + ภาพ ผสมอัตโนมัติ", icon: <Shuffle size={16} strokeWidth={1.6} />, badge: "แนะนำ" },
  { value: "stock", title: "วิดีโอสต็อก", desc: "Pexels · Pixabay", icon: <Film size={16} strokeWidth={1.6} /> },
  { value: "kie-image", title: "ภาพ AI", desc: "เจนภาพตามเนื้อหา", icon: <ImagePlus size={16} strokeWidth={1.6} /> },
  { value: "kie-video", title: "วิดีโอ AI", desc: "เจนวิดีโอตามเนื้อหา", icon: <Sparkles size={16} strokeWidth={1.6} />, pro: true },
];

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Step2Elements({ p, onBack }: { p: V2Project; onBack: () => void }) {
  const bgm = useBgm();
  const estSec = useMemo(() => estimateScriptDurationSec(p.script), [p.script]);
  const estMin = Math.max(1, Math.ceil(estSec / 60));
  const geminiVoice = GEMINI_VOICES.find(v => v.id === p.geminiVoiceName) ?? GEMINI_VOICES[0];

  function renderStub() {
    toast("การเรนเดอร์ผ่าน Editor v2 กำลังมาใน P4", {
      description: "ตอนนี้เรนเดอร์ได้ที่ UI ปัจจุบัน (?ui=v1) — การตั้งค่าหน้านี้ยังไม่ถูกบันทึก",
    });
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── เนื้อหาซ้าย: 4 กลุ่ม ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-7 py-6">
        <button onClick={onBack} className="self-start" style={{ fontSize: 12, color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
          ← กลับไปแก้สคริปต์
        </button>

        {/* 1 · บีโรล */}
        <Group title="บีโรล" desc="ภาพประกอบที่สลับทุก 3–5 วิ ระหว่างเสียงพูด">
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {BROLL_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => p.setBrollSource(o.value)}
                className="relative flex flex-col items-start gap-2 text-left"
                style={{
                  borderRadius: radius.card, padding: "12px 14px",
                  background: p.brollSource === o.value ? color.selectedBg : color.cardBg,
                  border: `1px solid ${p.brollSource === o.value ? color.selectedBorder : color.cardBorder}`,
                  cursor: "pointer", transition: "all 150ms ease",
                }}
              >
                {o.badge && (
                  <span className="absolute right-2.5 top-2" style={{ fontSize: 10, color: color.primary300, fontWeight: 500 }}>{o.badge}</span>
                )}
                {o.pro && (
                  <span className="absolute right-2.5 top-2 rounded-full px-1.5" style={{ fontSize: 9.5, color: color.textSecondary, border: `1px solid ${color.cardBorder}` }}>PRO</span>
                )}
                <IconTile size={32}>{o.icon}</IconTile>
                <span className="flex flex-col">
                  <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{o.title}</span>
                  <span style={{ fontSize: 10.5, color: color.textFaint }}>{o.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <Advanced note="แหล่งภาพ Auto Mix · โมเดลภาพ AI · จำนวนคลิป (auto/กำหนดเอง)" />
        </Group>

        {/* 2 · เสียงพากย์ */}
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
                {p.voiceEngine === "gemini" ? geminiVoice.label : "เสียงโคลนของฉัน"}
              </span>
              <span style={{ fontSize: 10.5, color: color.textFaint }}>
                {p.voiceEngine === "gemini"
                  ? `${geminiVoice.gender} · ${geminiVoice.style}`
                  : (p.voiceId ? `Voice ID: ${p.voiceId.slice(0, 12)}…` : "ยังไม่ได้ตั้ง Voice ID — ตั้งได้ที่ขั้นสูง")}
              </span>
            </span>
            <VoicePreviewButton provider={p.voiceEngine} geminiVoiceName={p.geminiVoiceName} voiceId={p.voiceId} />
          </Card>
          <Advanced note="เลือกเสียง Gemini ทั้งหมด · ElevenLabs Voice ID">
            {p.voiceEngine === "gemini" && (
              <select
                value={p.geminiVoiceName}
                onChange={(e) => p.setGeminiVoiceName(e.target.value)}
                className="mt-2 w-full max-w-[280px]"
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
            )}
            {p.voiceEngine === "elevenlabs" && (
              <input
                value={p.voiceId}
                onChange={(e) => p.setVoiceId(e.target.value)}
                placeholder="วาง ElevenLabs Voice ID"
                className="mt-2 w-full max-w-[280px]"
                style={{
                  padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                  background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                  color: color.text, fontFamily: font.body, outline: "none",
                }}
              />
            )}
          </Advanced>
        </Group>

        {/* 3 · เพลงประกอบ */}
        <Group title="เพลงประกอบ" desc="เพลงเบา ๆ ใต้เสียงพูด (ลดเสียงอัตโนมัติ)">
          <div className="flex flex-wrap gap-2">
            {bgm.systemTracks.slice(0, 6).map((t, i) => (
              <Chip
                key={t.id}
                selected={p.musicTrack === t.filename}
                onClick={() => p.setMusicTrack(t.filename)}
              >
                {t.title}{i === 0 ? " · แนะนำ" : ""}
              </Chip>
            ))}
            <Chip
              selected={p.musicTrack === null}
              onClick={() => p.setMusicTrack(null)}
              style={{ borderStyle: "dashed" }}
            >
              ไม่ใส่เพลง
            </Chip>
          </div>
          <Advanced note="อัปโหลดเพลงของคุณ · คลังทั้งหมด · ระดับเสียง" />
        </Group>

        {/* 4 · อวตารพิธีกร */}
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
          <Advanced note="Avatar ID · โหมด Full/Intro/Intro+Outro · วินาที intro/outro · ตำแหน่ง/สเกล (WYSIWYG)" />
        </Group>
      </div>

      {/* ── Right rail 372px ── */}
      <aside
        className="flex w-[372px] shrink-0 flex-col gap-4 overflow-y-auto px-5 py-5"
        style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}
      >
        {/* Preview 9:16 (196×348) */}
        <div className="flex justify-center">
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
          <SummaryRow label="สคริปต์" value={`${p.script.split("\n").filter(l => l.trim()).length} เซ็กเมนต์ · ~${fmtTime(estSec)}`} />
          <SummaryRow label="บีโรล" value={BROLL_OPTIONS.find(o => o.value === p.brollSource)?.title ?? "-"} />
          <SummaryRow label="เสียง" value={p.voiceEngine === "gemini" ? `Gemini · ${geminiVoice.label}` : "ElevenLabs"} />
          <SummaryRow label="เพลง" value={p.musicTrack === null ? "ไม่ใส่" : (bgm.systemTracks.find(t => t.filename === p.musicTrack)?.title ?? "ยังไม่เลือก")} />
          <SummaryRow label="อวตาร" value={p.useAvatar ? (p.avatarInfo?.name || p.avatarId || "ยังไม่ตั้ง") : "Faceless"} last />
        </div>

        {/* CTA เดียว */}
        <div className="flex flex-col gap-2">
          <BtnPrimary className="w-full" onClick={renderStub}>เรนเดอร์วิดีโอ</BtnPrimary>
          <span style={{ fontSize: 10.5, color: color.textFaint, textAlign: "center", lineHeight: 1.6 }}>
            ~{estMin} นาที
            {p.usage?.minutes ? ` · ใช้ ${estMin} จาก ${p.usage.minutes.remaining} นาทีที่เหลือ` : ""}
            {" "}· แก้ทุกอย่างได้ทีหลัง
          </span>
        </div>
      </aside>
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
        <div className="mt-2 px-3 py-2.5" style={{ borderRadius: radius.control, border: `1px dashed rgba(255,255,255,.12)` }}>
          <span style={{ fontSize: 11, color: color.textFaintest, lineHeight: 1.7 }}>
            จะอยู่ตรงนี้: {note} <span style={{ color: color.textFaintest }}>(เชื่อมจริงใน P4/P6)</span>
          </span>
          {children}
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
