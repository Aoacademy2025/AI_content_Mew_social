"use client";

/**
 * คลังเพลงเต็ม (spec ข้อ 2) — modal: ค้นหา + แท็บ เพลงระบบ/เพลงของฉัน + ฟังตัวอย่าง +
 * อัปโหลด (แผน Pro ขึ้นไป — server เช็คเอง) · เลือกแล้วปิด modal, chip ใน step 2 อัปเดต
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Crown, Pause, Play, Search, Upload, X } from "lucide-react";
import { color, font, radius } from "./tokens";
import { GlassPanel, GroupLabel, Segmented } from "./ui";
import type { SystemTrack, UserMusicTrack } from "../_hooks/useBgm";

export function MusicLibraryModal({ open, onClose, systemTracks, userTracks, canUpload, onUploaded, selected, selectedKind, onSelect }: {
  open: boolean;
  onClose: () => void;
  systemTracks: SystemTrack[];
  userTracks: UserMusicTrack[];
  canUpload: boolean;
  /** เพลงอัปโหลดใหม่ — parent ต้อง setUserTracks เพิ่มเอง */
  onUploaded: (track: UserMusicTrack) => void;
  selected: string | null; // filename · "" = ยังไม่เลือก · null = ไม่ใส่เพลง
  selectedKind: "system" | "user";
  onSelect: (filename: string, kind: "system" | "user") => void;
}) {
  const [tab, setTab] = useState<"system" | "user">("system");
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewing("");
  }
  useEffect(() => { if (!open) stopPreview(); }, [open]);
  useEffect(() => () => stopPreview(), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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

  async function handleUpload(file: File) {
    if (!canUpload) {
      toast.error("อัปโหลดเพลงส่วนตัวใช้ได้เฉพาะแผน Pro ขึ้นไป");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/music/upload", { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.track) { toast.error(d?.message ?? d?.error ?? "อัปโหลดเพลงไม่สำเร็จ"); return; }
      onUploaded(d.track as UserMusicTrack);
      onSelect((d.track as UserMusicTrack).filename, "user");
      toast.success("อัปโหลดแล้ว — เลือกเพลงนี้ให้เลย");
      onClose();
    } catch {
      toast.error("อัปโหลดเพลงไม่สำเร็จ");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const list = useMemo(() => {
    const src = tab === "system" ? systemTracks : userTracks;
    const needle = q.trim().toLowerCase();
    return needle ? src.filter((t) => t.title.toLowerCase().includes(needle)) : src;
  }, [tab, q, systemTracks, userTracks]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(6,6,12,.62)" }} onClick={onClose}>
      <GlassPanel className="flex w-[520px] max-w-full flex-col overflow-hidden" style={{ maxHeight: "78vh" }} onClick={(e) => e.stopPropagation()}>
        {/* หัว */}
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <GroupLabel>คลังเพลงทั้งหมด ({systemTracks.length + userTracks.length})</GroupLabel>
          <button onClick={onClose} aria-label="ปิด" style={{ background: "none", border: "none", color: color.textFaint, cursor: "pointer", padding: 4 }}>
            <X size={15} />
          </button>
        </div>

        {/* ค้นหา + แท็บ + อัปโหลด */}
        <div className="flex items-center gap-2 px-5 pb-3">
          <div className="flex min-w-0 flex-1 items-center gap-2" style={{ padding: "8px 12px", borderRadius: radius.control, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)" }}>
            <Search size={13} color={color.textFaint} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหาชื่อเพลง…"
              className="min-w-0 flex-1 bg-transparent outline-none"
              style={{ fontSize: 12.5, color: color.text, fontFamily: font.body }}
            />
          </div>
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as "system" | "user")}
            options={[{ value: "system", label: `ระบบ (${systemTracks.length})` }, { value: "user", label: `ของฉัน (${userTracks.length})` }]}
          />
        </div>

        {/* ลิสต์เพลง */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {tab === "user" && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".mp3,.wav,.ogg,.aac,.m4a,audio/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); }}
                disabled={!canUpload || uploading}
              />
              <button
                onClick={() => { if (canUpload) fileRef.current?.click(); }}
                disabled={uploading || !canUpload}
                className="mb-2 flex w-full items-center justify-center gap-2"
                style={{
                  padding: "10px 0", borderRadius: radius.card, background: "none",
                  border: `1px dashed ${canUpload ? "rgba(255,255,255,.18)" : "rgba(251,191,36,.24)"}`,
                  color: canUpload ? color.textSecondary : color.warning,
                  fontSize: 12, cursor: uploading ? "wait" : canUpload ? "pointer" : "not-allowed",
                  opacity: canUpload ? 1 : 0.85,
                }}
              >
                {canUpload ? <Upload size={13} /> : <Crown size={13} />}
                {uploading ? "กำลังอัปโหลด…" : canUpload ? "อัปโหลดเพลงของคุณ (mp3/wav/m4a ≤50MB)" : "อัปโหลดเพลงส่วนตัวใช้ได้ใน Pro"}
              </button>
            </>
          )}
          {list.length === 0 && (
            <div className="py-8 text-center" style={{ fontSize: 11.5, color: color.textFaintest }}>
              {q.trim()
                ? "ไม่พบเพลงที่ค้นหา"
                : tab === "user"
                  ? canUpload ? "ยังไม่มีเพลงของคุณ — อัปโหลดได้เลย" : "แผน Free ยังเลือกเพลงระบบได้ ส่วนอัปโหลดเพลงส่วนตัวใช้ได้ใน Pro"
                  : "ยังไม่มีเพลงในระบบ"}
            </div>
          )}
          {list.map((t) => {
            const isSelected = selected === t.filename && selectedKind === tab;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => { stopPreview(); onSelect(t.filename, tab); onClose(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { stopPreview(); onSelect(t.filename, tab); onClose(); } }}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5"
                style={{
                  borderRadius: radius.card,
                  background: isSelected ? color.selectedBg : "none",
                  border: `1px solid ${isSelected ? color.selectedBorder : "transparent"}`,
                }}
              >
                <button
                  aria-label={previewing === t.filename ? "หยุดตัวอย่าง" : "ฟังตัวอย่าง"}
                  onClick={(e) => { e.stopPropagation(); void togglePreview(t.filename); }}
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: previewing === t.filename ? "rgba(52,211,153,.15)" : "rgba(255,255,255,.07)",
                    border: `1px solid ${color.cardBorder}`,
                    color: previewing === t.filename ? color.success : color.textSecondary,
                    cursor: "pointer",
                  }}
                >
                  {previewing === t.filename ? <Pause size={11} strokeWidth={2} /> : <Play size={11} strokeWidth={2} style={{ marginLeft: 1 }} />}
                </button>
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, color: isSelected ? color.primary300 : color.text }}>
                  {t.title}
                </span>
                {isSelected && <Check size={13} color={color.primary300} strokeWidth={2.5} />}
              </div>
            );
          })}
        </div>
      </GlassPanel>
    </div>
  );
}
