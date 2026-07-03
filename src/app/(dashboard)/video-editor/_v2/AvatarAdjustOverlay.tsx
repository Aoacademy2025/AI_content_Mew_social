"use client";

/**
 * ปรับตำแหน่ง/สเกลอวตารหลังเรนเดอร์ (spec 07-03 ข้อ 1, ทางเลือก A) — ลากกล่องบน preview +
 * slider ซูม → (1) save preset ต่อ avatar (ครั้งหน้าเรนเดอร์ถูกตั้งแต่แรก) (2) re-composite
 * ฟรีบน base เดิมผ่าน /api/heygen/composite (ไม่เรียก HeyGen ใหม่) (3) PATCH videoUrl ลง job
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Move, RotateCcw } from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnGhost, GroupLabel } from "./ui";
import { normalizedBox, type AvatarLayout } from "@/lib/avatar-layout";

const DEFAULT_LAYOUT: AvatarLayout = { scale: 1, offsetX: 0, offsetY: 0 };

export function AvatarAdjustOverlay({ avatarId, avatarMode, introSecs, tailSecs, avatarVideoUrl, tailAvatarUrl, bgVideoUrl, jobId, onDone, onClose }: {
  avatarId: string;
  avatarMode: string;              // full | bookend | bookend-both
  introSecs: number;
  tailSecs: number;
  avatarVideoUrl: string;
  tailAvatarUrl: string | null;
  bgVideoUrl: string;              // base render ก่อน composite (compositeBaseUrl)
  jobId: string | null;
  onDone: (newVideoUrl: string) => void;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<AvatarLayout>(DEFAULT_LAYOUT);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ค่าเริ่มต้น = preset ที่บันทึกไว้ (ใกล้เคียงค่าที่งานนี้ใช้เรนเดอร์ที่สุด)
  useEffect(() => {
    let alive = true;
    fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.layout) setLayout(d.layout as AvatarLayout); })
      .catch(() => {});
    return () => { alive = false; };
  }, [avatarId]);

  const box = normalizedBox(layout);

  function onBoxPointerDown(e: React.PointerEvent) {
    if (busy) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: layout.offsetX, origY: layout.offsetY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onBoxPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    const frame = frameRef.current;
    if (!d || !frame) return;
    const rect = frame.getBoundingClientRect();
    // ลากเต็มกรอบ = ±200 หน่วย (สเปซเดียวกับ v1 OrderPanel: nx ±1 → ×200) · แกน y บวก = ลง
    const nx = ((e.clientX - d.startX) / rect.width) * 2 * 200;
    const ny = ((e.clientY - d.startY) / rect.height) * 2 * 200;
    setLayout((l) => ({
      ...l,
      offsetX: Math.max(-200, Math.min(200, Math.round(d.origX + nx))),
      offsetY: Math.max(-200, Math.min(200, Math.round(d.origY + ny))),
    }));
  }
  function onBoxPointerUp() { dragRef.current = null; }

  async function apply() {
    if (busy) return;
    setBusy(true);
    try {
      // 1) save preset ก่อน — ต่อให้ composite พังก็ยังได้ประโยชน์รอบหน้า (spec: error handling)
      await fetch(`/api/avatar-presets/${encodeURIComponent(avatarId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      });

      // 2) re-composite ฟรีบน base เดิม (ไม่เรียก HeyGen ใหม่)
      const res = await fetch("/api/heygen/composite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          avatarVideoUrl,
          ...(tailAvatarUrl ? { tailAvatarVideoUrl: tailAvatarUrl } : {}),
          bgVideoUrl,
          mode: "chromakey",
          avatarTiming: avatarMode,
          avatarBookendSecs: introSecs,
          avatarTailSecs: tailSecs,
          avatarLayout: layout,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.videoUrl) throw new Error(d?.error ?? `composite failed (${res.status})`);

      // 3) persist ลง job — resume งานที่ยังไม่ export จะเห็นตำแหน่งใหม่ (best-effort)
      if (jobId) {
        await fetch(`/api/videos/jobs/${encodeURIComponent(jobId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoUrl: d.videoUrl }),
        }).catch(() => {});
      }

      toast.success("ปรับตำแหน่งอวตารแล้ว — บันทึกเป็นค่าเริ่มต้นของอวตารนี้ให้ด้วย");
      onDone(d.videoUrl as string);
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : "re-composite ไม่สำเร็จ"} — ตำแหน่งถูกบันทึกไว้แล้ว จะถูกใช้ในการเรนเดอร์ครั้งหน้า`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col" style={{ borderRadius: radius.cardLg, overflow: "hidden" }}>
      {/* พื้นที่ลาก — ทับ preview ทั้งกรอบ */}
      <div ref={frameRef} className="relative flex-1" style={{ background: "rgba(10,10,16,.35)" }}>
        <div
          onPointerDown={onBoxPointerDown}
          onPointerMove={onBoxPointerMove}
          onPointerUp={onBoxPointerUp}
          className="absolute flex items-center justify-center"
          style={{
            left: `${box.centerXPct}%`, top: `${box.centerYPct}%`,
            width: `${box.widthPct}%`, height: `${box.heightPct}%`,
            transform: "translate(-50%,-50%)",
            border: `1.5px dashed ${color.primary300}`, borderRadius: 10,
            background: "rgba(139,92,246,.10)", cursor: busy ? "wait" : "move",
            touchAction: "none",
          }}
        >
          <span className="flex items-center gap-1" style={{ fontSize: 10.5, color: color.primary300, background: "rgba(10,10,16,.55)", padding: "3px 8px", borderRadius: 8 }}>
            <Move size={11} /> อวตาร — ลากเพื่อย้าย
          </span>
        </div>
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: "rgba(10,10,16,.66)" }}>
            <Loader2 size={22} className="animate-spin" color={color.primary300} />
            <span style={{ fontSize: 11.5, color: color.textSecondary }}>กำลังวางอวตารตำแหน่งใหม่… (~1-2 นาที ไม่คิดค่า HeyGen เพิ่ม)</span>
          </div>
        )}
      </div>

      {/* แถบคุมล่าง */}
      <div className="flex items-center gap-3 px-4 py-3" style={{ background: "rgba(10,10,16,.88)", borderTop: `1px solid ${color.cardBorder}` }}>
        <GroupLabel>ขนาด</GroupLabel>
        <input
          type="range" min={0.1} max={2.5} step={0.05} value={layout.scale}
          disabled={busy}
          onChange={(e) => setLayout((l) => ({ ...l, scale: Number(e.target.value) }))}
          className="flex-1"
          style={{ accentColor: color.primary500 }}
        />
        <span style={{ fontSize: 11, color: color.textSecondary, fontVariantNumeric: "tabular-nums", width: 38 }}>{layout.scale.toFixed(2)}×</span>
        <button onClick={() => setLayout(DEFAULT_LAYOUT)} disabled={busy} title="รีเซ็ต" className="flex items-center gap-1" style={{ background: "none", border: "none", color: color.textSecondary, cursor: "pointer", fontSize: 11 }}>
          <RotateCcw size={11} /> รีเซ็ต
        </button>
        <BtnGhost onClick={onClose} disabled={busy} style={{ padding: "8px 14px" }}>ยกเลิก</BtnGhost>
        <BtnPrimary onClick={() => void apply()} disabled={busy} style={{ padding: "8px 16px", ...(busy ? { opacity: 0.7, cursor: "wait" } : {}) }}>
          {busy ? "กำลังประมวลผล…" : "ใช้ตำแหน่งนี้"}
        </BtnPrimary>
      </div>
    </div>
  );
}
