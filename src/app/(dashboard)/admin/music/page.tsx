"use client";

import { useEffect, useState } from "react";
import { Music, Upload, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MUSIC_MOODS } from "@/lib/style-pack-catalog";
import { MUSIC_MOOD_LABELS, MUSIC_MOOD_UNSPECIFIED_LABEL } from "@/lib/music-mood";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

// Music mood <select> options — "" = ไม่ระบุ (unset) then every MusicMood in catalog order.
const MUSIC_MOOD_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: MUSIC_MOOD_UNSPECIFIED_LABEL },
  ...MUSIC_MOODS.map((mood) => ({ value: mood, label: MUSIC_MOOD_LABELS[mood] })),
];

interface MusicTrack { id: string; title: string; filename: string; duration: number | null; createdAt: string; mood: string | null; }

export default function AdminMusicPage() {
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicUploading, setMusicUploading] = useState(false);
  const [newMusicTitle, setNewMusicTitle] = useState("");
  const [newMusicMood, setNewMusicMood] = useState("");

  async function loadTracks() {
    setMusicLoading(true);
    try {
      const res = await fetch("/api/admin/music");
      const data = await res.json();
      if (data.tracks) setTracks(data.tracks);
    } catch { /* silent — Music table may not exist yet on this environment */ }
    finally { setMusicLoading(false); }
  }

  async function uploadTrack(file: File) {
    const fallbackTitle = file.name.replace(/\.[^.]+$/, "");
    const title = newMusicTitle.trim() || fallbackTitle;
    setMusicUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title);
      if (newMusicMood) fd.append("mood", newMusicMood);
      const res = await fetch("/api/admin/music", { method: "POST", body: fd });
      const data = await res.json();
      if (data.track) {
        setTracks(prev => [data.track, ...prev]);
        setNewMusicTitle("");
        setNewMusicMood("");
        toast.success("อัปโหลดเพลงสำเร็จ");
      } else toast.error(data.error ?? "อัปโหลดไม่สำเร็จ");
    } catch { toast.error("อัปโหลดไม่สำเร็จ"); }
    finally { setMusicUploading(false); }
  }

  async function updateTrackMood(id: string, mood: string) {
    const prevTracks = tracks;
    setTracks(prev => prev.map(t => t.id === id ? { ...t, mood: mood || null } : t));
    try {
      const res = await fetch(`/api/admin/music/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mood: mood || null }),
      });
      const data = await res.json();
      if (data.track) setTracks(prev => prev.map(t => t.id === id ? { ...t, mood: data.track.mood } : t));
      else { setTracks(prevTracks); toast.error(data.error ?? "บันทึกอารมณ์เพลงไม่สำเร็จ"); }
    } catch { setTracks(prevTracks); toast.error("บันทึกอารมณ์เพลงไม่สำเร็จ"); }
  }

  async function deleteTrack(id: string) {
    if (!confirm("ลบเพลงนี้?")) return;
    try {
      await fetch(`/api/admin/music/${id}`, { method: "DELETE" });
      setTracks(prev => prev.filter(t => t.id !== id));
      toast.success("ลบเพลงแล้ว");
    } catch { toast.error("ลบไม่สำเร็จ"); }
  }

  useEffect(() => {
    loadTracks();
  }, []);

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-8">
        <div className="rounded-xl p-5" style={cardStyle}>
          <div className="mb-4 flex items-center gap-2">
            <Music className="h-4 w-4" style={{ color: VIOLET }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>Music Library</h2>
            <span className="ml-auto text-xs" style={{ color: "var(--ui-text-muted)" }}>{tracks.length} เพลง</span>
          </div>

          {/* Upload form */}
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="ชื่อเพลง"
              value={newMusicTitle}
              onChange={e => setNewMusicTitle(e.target.value)}
              className="flex-1 rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
            <select
              value={newMusicMood}
              onChange={e => setNewMusicMood(e.target.value)}
              className="rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            >
              {MUSIC_MOOD_OPTIONS.map(opt => (
                <option key={opt.value || "unset"} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label className={`flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition hover:brightness-110 ${musicUploading ? "opacity-50 pointer-events-none" : ""}`}
              style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}`, color: VIOLET_LIGHT }}>
              {musicUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {musicUploading ? "กำลังอัปโหลด..." : "อัปโหลดเพลง"}
              <input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.m4a" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadTrack(f); e.target.value = ""; }} />
            </label>
          </div>

          {/* Track list */}
          {musicLoading ? null : tracks.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีเพลง — อัปโหลดเพลงแรก</p>
          ) : (
            <div className="space-y-2">
              {tracks.map(t => (
                <div key={t.id} className="rounded-lg px-3 py-2 space-y-1.5" style={cardStyle}>
                  <div className="flex items-center gap-3">
                    <Music className="h-3.5 w-3.5 shrink-0" style={{ color: VIOLET }} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" style={{ color: "var(--ui-text-primary)" }}>{t.title}</p>
                      <p className="truncate text-[10px]" style={{ color: "var(--ui-text-muted)" }}>{t.filename}</p>
                    </div>
                    <select
                      value={t.mood ?? ""}
                      onChange={e => updateTrackMood(t.id, e.target.value)}
                      className="shrink-0 rounded-md border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                    >
                      {MUSIC_MOOD_OPTIONS.map(opt => (
                        <option key={opt.value || "unset"} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <button onClick={() => deleteTrack(t.id)}
                      className="rounded p-1 text-zinc-500 transition hover:bg-red-500/15 hover:text-red-400">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <audio controls src={`/music/${t.filename}`} className="h-8 w-full opacity-80" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
