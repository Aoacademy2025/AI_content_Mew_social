"use client";

/**
 * คลังอวตาร — modal เลือกอวตารจากบัญชี HeyGen ของผู้ใช้ (เฉพาะที่ผู้ใช้สร้างเอง, ดึงผ่าน
 * useHeygenAvatars ที่ parent). แสดงเป็น section ตามชื่ออวตาร — อวตารที่มีหลาย "look"
 * (เช่น Mew 15 ท่า) จะเห็นทุก look เลือกท่าที่ต้องการได้ · เลือกแล้วปิด modal.
 * พิมพ์ Avatar ID เองอยู่ที่ Step 2 (ทางลัด) — modal นี้ presentation ล้วน.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Search, User, X } from "lucide-react";
import { color, font, radius } from "./tokens";
import { GlassPanel, GroupLabel } from "./ui";
import { groupLooksByAvatar, type HeygenAvatar } from "./avatar-filter";
import type { HeygenAvatarsError } from "../_hooks/useHeygenAvatars";

const ERROR_COPY: Record<HeygenAvatarsError, string> = {
  "no-key": "ยังไม่ได้ตั้ง HeyGen API key — ไปตั้งที่หน้าตั้งค่า แล้วกดโหลดใหม่",
  "not-paid": "คลังอวตารใช้ได้เฉพาะแผน PRO / BUSINESS — อัปเกรดที่หน้าตั้งค่า",
  "bad-key": "HeyGen API key ไม่ถูกต้อง — อัปเดตที่หน้าตั้งค่า แล้วกดโหลดใหม่",
  failed: "โหลดรายชื่ออวตารไม่สำเร็จ ลองใหม่อีกครั้ง",
};

export function AvatarPickerModal({ open, onClose, selectedId, onSelect, avatars, loading, error, stale, onReload }: {
  open: boolean;
  onClose: () => void;
  selectedId: string;
  onSelect: (avatarId: string) => void;
  avatars: HeygenAvatar[];
  loading: boolean;
  error: HeygenAvatarsError | null;
  stale: boolean;
  onReload: () => void;
}) {
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const sections = useMemo(() => groupLooksByAvatar(avatars, q), [avatars, q]);

  if (!open) return null;

  const pick = (id: string) => { onSelect(id); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(6,6,12,.62)" }} onClick={onClose}>
      <GlassPanel className="flex w-[560px] max-w-full flex-col overflow-hidden" style={{ maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
        {/* หัว */}
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <GroupLabel>เลือกอวตารของคุณจาก HeyGen</GroupLabel>
          <button onClick={onClose} aria-label="ปิด" style={{ background: "none", border: "none", color: color.textFaint, cursor: "pointer", padding: 4 }}>
            <X size={15} />
          </button>
        </div>

        {/* ค้นหา */}
        <div className="px-5 pb-3">
          <div className="flex items-center gap-2" style={{ padding: "8px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)" }}>
            <Search size={13} color={color.textFaint} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหาชื่ออวตาร…"
              className="min-w-0 flex-1 bg-transparent outline-none"
              style={{ fontSize: 12.5, color: color.text, fontFamily: font.body }}
            />
          </div>
          {stale && !error && (
            <div className="mt-2 flex items-center justify-between" style={{ fontSize: 10.5, color: color.textFaint }}>
              <span>อาจไม่ใช่รายการล่าสุด</span>
              <button onClick={onReload} style={{ background: "none", border: "none", color: color.link, cursor: "pointer", padding: 0, fontSize: 10.5 }}>โหลดใหม่</button>
            </div>
          )}
        </div>

        {/* เนื้อ */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading && (
            <div className="py-10 text-center" style={{ fontSize: 12, color: color.textFaint }}>กำลังโหลดรายชื่ออวตาร…</div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.7, maxWidth: 360 }}>{ERROR_COPY[error]}</span>
              <div className="flex items-center gap-2">
                <a href="/settings" style={{ fontSize: 12, color: color.primary300, textDecoration: "none", padding: "6px 12px", borderRadius: radius.control, border: `1px solid ${color.selectedBorder}` }}>ไปหน้าตั้งค่า</a>
                <button onClick={onReload} style={{ fontSize: 12, color: color.textSecondary, background: "none", border: `1px solid ${color.cardBorder}`, borderRadius: radius.control, padding: "6px 12px", cursor: "pointer" }}>โหลดใหม่</button>
              </div>
            </div>
          )}

          {!loading && !error && sections.length === 0 && (
            <div className="py-10 text-center" style={{ fontSize: 11.5, color: color.textFaintest, lineHeight: 1.7 }}>
              {q.trim() ? "ไม่พบอวตารที่ค้นหา" : "ยังไม่มีอวตารในบัญชี HeyGen — สร้างที่ heygen.com หรือวาง Avatar ID เองด้านล่าง"}
            </div>
          )}

          {!loading && !error && sections.length > 0 && (
            <div className="flex flex-col gap-4">
              {sections.map((s) => (
                <section key={s.name} className="flex flex-col gap-2">
                  <GroupLabel>{s.name}{s.looks.length > 1 ? ` (${s.looks.length})` : ""}</GroupLabel>
                  <AvatarGrid looks={s.looks} selectedId={selectedId} onPick={pick} />
                </section>
              ))}
            </div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}

function AvatarGrid({ looks, selectedId, onPick }: { looks: HeygenAvatar[]; selectedId: string; onPick: (id: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
      {looks.map((a) => {
        const isSelected = selectedId === a.avatar_id;
        return (
          <button
            key={a.avatar_id}
            onClick={() => onPick(a.avatar_id)}
            aria-label={`เลือก ${a.avatar_name}`}
            className="relative flex items-center justify-center overflow-hidden"
            style={{
              borderRadius: radius.card, aspectRatio: "3 / 4",
              background: "#1C1C2B",
              border: `1.5px solid ${isSelected ? color.primary500 : color.cardBorder}`,
              cursor: "pointer", transition: "all 150ms ease",
            }}
          >
            {a.preview_image_url
              ? // eslint-disable-next-line @next/next/no-img-element
                <img src={a.preview_image_url} alt={a.avatar_name} loading="lazy" className="h-full w-full object-cover" />
              : <User size={20} strokeWidth={1.5} color={color.textFaint} />}
            {isSelected && (
              <span className="absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full" style={{ background: color.primary500 }}>
                <Check size={11} color="#fff" strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
