"use client";

/**
 * Editor v2 shell (P0/P2) — โครงตามดีไซน์ handoff (จอ 5a/4a/5b/4b, Design System v1.1)
 * เนื้อแต่ละเฟสมาใน P3/P5/P6 · ตอนนี้ main = kit preview ชั่วคราวไว้ QA design system บน prod
 */

import { useState } from "react";
import { Type, Music, ImagePlus } from "lucide-react";
import { color, font, radius } from "./tokens";
import { v2FontClass } from "./fonts";
import {
  BtnPrimary, BtnSecondary, BtnGhost, BtnDashed, BtnDanger,
  Card, GlassPanel, IconTile, Chip, Segmented, Toggle, TextInput, GroupLabel,
  StepIndicator,
} from "./ui";

export function EditorV2Shell() {
  return (
    <div
      className={`${v2FontClass} flex h-screen flex-col`}
      style={{ background: color.bg0, color: color.text }}
    >
      {/* Topbar 58px */}
      <header
        className="flex h-[58px] shrink-0 items-center justify-between px-4"
        style={{ borderBottom: `1px solid ${color.cardBorder}` }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] text-[15px] font-semibold text-white"
            style={{ background: color.gradientPrimary, fontFamily: font.heading }}
          >
            H
          </div>
          <div className="leading-tight">
            <div style={{ font: `500 13.5px ${font.heading}` }}>New Project</div>
            <div style={{ fontSize: 10.5, color: color.textFaint }}>ยังไม่ได้บันทึก</div>
          </div>
        </div>

        <StepIndicator active={0} />

        <div
          className="h-[30px] w-[30px] rounded-full"
          style={{ background: "#1C1C2B", border: "1px solid rgba(255,255,255,.10)" }}
          aria-label="บัญชีผู้ใช้"
        />
      </header>

      {/* Content — P3 (จอ 5a) มาแทนที่ตรงนี้; ระหว่างนี้ = kit preview ชั่วคราว */}
      <main className="flex-1 overflow-y-auto p-7">
        <KitPreview />
      </main>
    </div>
  );
}

/** ชั่วคราว (ลบตอน P3 ลง): โชว์ทุก component ของ kit ไว้ QA บน prod ผ่าน ?ui=v2 */
function KitPreview() {
  const [seg, setSeg] = useState<"gemini" | "elevenlabs">("gemini");
  const [len, setLen] = useState<"1" | "2" | "3">("1");
  const [on, setOn] = useState(true);
  const [chip, setChip] = useState(0);

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-7">
      <div>
        <div style={{ font: `500 19px ${font.heading}` }}>Editor v2 — Design Kit (P2)</div>
        <div style={{ fontSize: 11.5, color: color.textSecondary, marginTop: 4 }}>
          พรีวิวชั่วคราวสำหรับ QA · จอจริงมาใน P3 · กลับ UI ปัจจุบัน{" "}
          <a href="/video-editor?ui=v1" style={{ color: color.link }}>?ui=v1</a>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <GroupLabel>ปุ่ม 4 ระดับ + อันตราย</GroupLabel>
        <div className="flex flex-wrap items-center gap-3">
          <BtnPrimary>เรนเดอร์วิดีโอ</BtnPrimary>
          <BtnSecondary>ดูตัวอย่าง</BtnSecondary>
          <BtnGhost>แก้ไข</BtnGhost>
          <BtnDashed>+ เพิ่มเซ็กเมนต์</BtnDashed>
          <BtnDanger>ลบโปรเจกต์</BtnDanger>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <GroupLabel>การ์ดเซ็กเมนต์ — เลือกอยู่ vs ปกติ</GroupLabel>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Card selected>
            <div className="flex justify-between" style={{ fontSize: 11 }}>
              <span style={{ color: color.primary300, fontWeight: 600 }}>HOOK</span>
              <span style={{ color: color.textFaint }}>0:00–0:04</span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>
              แดดเมืองไทยโหดขนาดนี้ ยังกล้าออกจากบ้าน...
            </div>
          </Card>
          <Card>
            <div className="flex justify-between" style={{ fontSize: 11 }}>
              <span style={{ color: color.textSecondary, fontWeight: 600 }}>เนื้อหา 1</span>
              <span style={{ color: color.textFaint }}>0:04–0:16</span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 6, color: color.textSecondary }}>
              ตัวนี้ SPF50+ PA++++ เนื้อบางเบามาก...
            </div>
          </Card>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <GroupLabel>Segmented · ชิป · สวิตช์</GroupLabel>
        <div className="flex flex-wrap items-center gap-4">
          <Segmented
            value={seg}
            onChange={setSeg}
            options={[{ value: "gemini", label: "Gemini" }, { value: "elevenlabs", label: "ElevenLabs" }]}
          />
          <Segmented
            value={len}
            onChange={setLen}
            options={[{ value: "1", label: "1 ประโยค" }, { value: "2", label: "2" }, { value: "3", label: "3" }]}
          />
          <Toggle on={on} onChange={setOn} ariaLabel="ตัวอย่างสวิตช์" />
        </div>
        <div className="flex flex-wrap gap-2">
          {["เพลงแนะนำ", "Chill Lo-fi", "เลือกจากคลัง", "ไม่ใส่เพลง"].map((label, i) => (
            <Chip key={label} selected={chip === i} onClick={() => setChip(i)}>{label}</Chip>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <GroupLabel>ช่องกรอก · icon tile</GroupLabel>
        <div className="flex flex-wrap items-center gap-3">
          <TextInput defaultValue="ครีมกันแดดรีวิว EP.4" style={{ width: 240 }} />
          <IconTile><Type size={16} strokeWidth={1.6} /></IconTile>
          <IconTile><Music size={16} strokeWidth={1.6} /></IconTile>
          <IconTile><ImagePlus size={16} strokeWidth={1.6} /></IconTile>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <GroupLabel>Glass panel (เฉพาะชั้นลอย)</GroupLabel>
        <div
          className="flex items-center justify-center p-8"
          style={{ borderRadius: radius.cardLg, background: "radial-gradient(ellipse at center, rgba(139,92,246,.14), transparent 70%)" }}
        >
          <GlassPanel className="flex flex-col items-center gap-2 px-10 py-7">
            <div style={{ font: `600 16px ${font.heading}` }}>กำลังสร้างวิดีโอของคุณ</div>
            <div style={{ fontSize: 11.5, color: color.textSecondary }}>ตัวอย่างแผงเรนเดอร์ (จอ 5b มาใน P5)</div>
          </GlassPanel>
        </div>
      </section>
    </div>
  );
}
