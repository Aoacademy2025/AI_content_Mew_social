"use client";

/**
 * สเต็ป 1 — สคริปต์ (จอ 5a): การ์ดเลือกโหมด 2 ใบ + กล่องสคริปต์ + rail เซ็กเมนต์ (ลากเรียงได้)
 * กติกา: 1 บรรทัด = 1 เซ็กเมนต์ · เลือกคลิปเอง = ข้ามเสียง/อวตาร ไปทำ B-roll + ซับ (cutaway)
 */

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PenLine, Clapperboard, GripVertical } from "lucide-react";
import { DirectAvatarUpload } from "../_components/DirectAvatarUpload";
import { color, font, radius } from "./tokens";
import { BtnPrimary, Card, IconTile } from "./ui";
import { estimateClipSecV2, countWordsV2 } from "./estimate";
import type { V2Project } from "./useV2Project";

const CLIP_CUTAWAY_ON = process.env.NEXT_PUBLIC_CLIP_CUTAWAY === "1";

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function segLabel(i: number, total: number) {
  if (i === 0) return "HOOK";
  if (total > 2 && i === total - 1) return "CTA";
  return `เนื้อหา ${i}`;
}

export function Step1Script({ p, onNext }: { p: V2Project; onNext: () => void }) {
  const lines = useMemo(() => p.script.split("\n").filter(l => l.trim().length > 0), [p.script]);
  // นับจากข้อความที่ clean แล้ว (ตรงกับที่ TTS จะอ่านจริง) — สูตรความยาว calibrate ใน estimate.ts
  const totalSec = useMemo(() => estimateClipSecV2(p.script), [p.script]);
  const wordCount = useMemo(() => countWordsV2(p.script), [p.script]);
  const [selectedSeg, setSelectedSeg] = useState(0);
  const dragIdx = useRef<number | null>(null);

  // เวลาโดยประมาณต่อเซ็กเมนต์ — แบ่งตามสัดส่วนความยาวตัวอักษรของแต่ละบรรทัด
  const segTimes = useMemo(() => {
    const weights = lines.map(l => Math.max(1, estimateClipSecV2(l)));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return lines.map((_, i) => {
      const start = acc;
      acc += (weights[i] / sum) * totalSec;
      return { start, end: acc };
    });
  }, [lines, totalSec]);

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...lines];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    p.setScript(next.join("\n"));
    setSelectedSeg(to);
  }

  // CTA เดียว — ใช้ทั้งใน rail (desktop) และ sticky footer (mobile), ไม่ให้ logic แยกกัน
  const ctaDisabled = p.mode === "upload" ? !p.clipUrl : !lines.length;
  const primaryCta = (
    <BtnPrimary
      className="w-full"
      disabled={ctaDisabled}
      style={ctaDisabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
      onClick={onNext}
    >
      ถัดไป: เลือกองค์ประกอบ →
    </BtnPrimary>
  );

  return (
    <>
    <div className="flex min-h-0 flex-1 max-lg:flex-col max-lg:overflow-y-auto">
      {/* ── เนื้อหาซ้าย ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 lg:overflow-y-auto max-lg:overflow-visible px-7 py-6">
        {/* การ์ดเลือกโหมด 2 ใบ */}
        <div className="grid grid-cols-2 gap-2.5 max-lg:grid-cols-1">
          <ModeCard
            selected={p.mode === "script"}
            onClick={() => p.setMode("script")}
            icon={<PenLine size={17} strokeWidth={1.6} />}
            title="พิมพ์สคริปต์"
            desc="ระบบสร้างเสียง + บีโรล + ซับให้ทั้งหมด"
          />
          <ModeCard
            selected={p.mode === "upload"}
            disabled={!CLIP_CUTAWAY_ON}
            onClick={() => CLIP_CUTAWAY_ON && p.setMode("upload")}
            icon={<Clapperboard size={17} strokeWidth={1.6} />}
            title="ใช้คลิปที่ถ่ายเอง"
            desc={CLIP_CUTAWAY_ON ? "อัปคลิปแนวตั้ง → ซับ + บีโรลอัตโนมัติ" : "เร็ว ๆ นี้"}
          />
        </div>

        {/* โหมดอัปคลิปเอง (cutaway) */}
        {p.mode === "upload" ? (
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6"
            style={{ borderRadius: 13, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}
          >
            {p.clipUrl ? (
              <>
                <video
                  src={p.clipUrl}
                  controls
                  playsInline
                  className="max-h-[46vh]"
                  style={{ borderRadius: 12, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16" }}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth > v.videoHeight) {
                      toast.error("ต้องเป็นคลิปแนวตั้ง (9:16) — คลิปแนวนอนยังไม่รองรับ");
                      p.setClipUrl("");
                    }
                  }}
                />
                <button onClick={() => p.setClipUrl("")} style={{ fontSize: 12, color: color.link, background: "none", border: "none", cursor: "pointer" }}>
                  เปลี่ยนคลิป
                </button>
              </>
            ) : (
              <div className="w-full max-w-[420px]">
                <DirectAvatarUpload onUrl={(u) => p.setClipUrl(u)} />
                <p style={{ fontSize: 11, color: color.textFaint, marginTop: 10, lineHeight: 1.7, textAlign: "center" }}>
                  อัปคลิปแนวตั้งที่มีเสียงพูดของคุณ — ระบบจะถอดซับไทยจากเสียง
                  แล้วแทรกบีโรลให้อัตโนมัติ (เสียงเดิมต่อเนื่องทั้งคลิป)
                </p>
              </div>
            )}
          </div>
        ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{ borderRadius: 13, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}
        >
          <div className="flex items-center justify-between px-4 pt-3.5">
            <span style={{ font: `500 13.5px ${font.heading}` }}>สคริปต์ของคุณ</span>
            <span style={{ fontSize: 10.5, color: color.textFaint }}>Enter = ขึ้นเซ็กเมนต์ใหม่</span>
          </div>
          <textarea
            value={p.script}
            onChange={(e) => p.setScript(e.target.value)}
            placeholder={"พิมพ์สคริปต์ที่นี่…\nขึ้นบรรทัดใหม่ = แยกเซ็กเมนต์"}
            className="min-h-[220px] flex-1 resize-none bg-transparent px-4 py-3 outline-none"
            style={{ fontSize: 14, lineHeight: 1.7, color: color.text, fontFamily: font.body }}
          />
          <div
            className="flex items-center justify-end px-4 py-3"
            style={{ borderTop: `1px solid ${color.cardBorder}` }}
          >
            <span style={{ fontSize: 11, color: color.textFaint }}>
              {wordCount} คำ · {lines.length} เซ็กเมนต์ · คลิปยาว ~{fmtTime(totalSec)} นาที
            </span>
          </div>
        </div>
        )}
      </div>

      {/* ── Right rail 372px ── */}
      <aside
        className="flex flex-col lg:w-[372px] lg:shrink-0 max-lg:w-full max-lg:shrink"
        style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}
      >
        <div className="px-5 pt-5 pb-3">
          <div style={{ font: `500 13.5px ${font.heading}` }}>
            {p.mode === "upload" ? "โหมดใช้คลิปของคุณ" : lines.length ? "ระบบแบ่งเซ็กเมนต์ให้แล้ว" : "เซ็กเมนต์จะขึ้นที่นี่"}
          </div>
          <div style={{ fontSize: 11, color: color.textFaint, marginTop: 2 }}>
            {p.mode === "upload" ? "ซับ + บีโรลจะถูกสร้างจากเสียงในคลิปหลังกดเรนเดอร์" : "ลากการ์ดเพื่อสลับลำดับ"}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 lg:overflow-y-auto max-lg:overflow-visible px-5 pb-3">
          {lines.map((line, i) => (
            <div
              key={`${i}-${line.slice(0, 12)}`}
              draggable
              onDragStart={() => { dragIdx.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIdx.current != null) reorder(dragIdx.current, i); dragIdx.current = null; }}
              onClick={() => setSelectedSeg(i)}
              style={{ cursor: "grab" }}
            >
              <Card selected={i === selectedSeg}>
                <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
                  <span style={{ color: i === selectedSeg ? color.primary300 : color.textSecondary, fontWeight: 600 }}>
                    {segLabel(i, lines.length)}
                  </span>
                  <span className="flex items-center gap-1.5" style={{ color: color.textFaint }}>
                    {fmtTime(segTimes[i]?.start ?? 0)}–{fmtTime(segTimes[i]?.end ?? 0)}
                    <GripVertical size={12} strokeWidth={1.6} />
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5, lineHeight: 1.55, marginTop: 6,
                    color: i === selectedSeg ? color.text : color.textSecondary,
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                  }}
                >
                  {line}
                </div>
              </Card>
            </div>
          ))}
          {!lines.length && (
            <div
              className="flex flex-1 items-center justify-center text-center"
              style={{ fontSize: 12, color: color.textFaintest, borderRadius: radius.card, border: `1px dashed rgba(255,255,255,.12)`, minHeight: 120 }}
            >
              {p.mode === "upload"
                ? <>อัปโหลดคลิปทางซ้าย<br />แล้วกด &quot;ถัดไป&quot; เพื่อเลือกบีโรล</>
                : <>เริ่มพิมพ์สคริปต์ทางซ้าย<br />ระบบจะแบ่งเซ็กเมนต์ให้อัตโนมัติ</>}
            </div>
          )}
        </div>

        {/* CTA เดียว — ซ่อนบนมือถือ (ย้ายไป sticky footer ด้านล่างแทน) */}
        <div className="px-5 pb-5 pt-2 max-lg:hidden">
          {primaryCta}
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

function ModeCard({ selected, disabled, onClick, icon, title, desc }: {
  selected: boolean; disabled?: boolean; onClick: () => void;
  icon: React.ReactNode; title: string; desc: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 text-left"
      style={{
        borderRadius: 13, padding: "13px 16px",
        background: selected ? color.selectedBg : color.cardBg,
        border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 150ms ease",
      }}
    >
      <IconTile size={34}>{icon}</IconTile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span style={{ font: `500 13px ${font.heading}`, color: color.text }}>{title}</span>
        <span style={{ fontSize: 10.5, color: color.textFaint }}>{desc}</span>
      </span>
      {/* radio 15px */}
      <span
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
        style={{ border: `1.5px solid ${selected ? color.primary500 : "rgba(255,255,255,.25)"}` }}
      >
        {selected && <span className="h-[7px] w-[7px] rounded-full" style={{ background: color.primary500 }} />}
      </span>
    </button>
  );
}
