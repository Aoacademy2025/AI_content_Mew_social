"use client";
import { Loader2, Music2, Upload, X } from "lucide-react";
import { toast } from "sonner";

interface SystemTrack { id: string; title: string; filename: string; }

interface Props {
  bgmEnabled: boolean;
  setBgmEnabled: (v: boolean | ((prev: boolean) => boolean)) => void;
  bgmVolume: number;
  setBgmVolume: (v: number) => void;
  bgmFile: string;
  setBgmFile: (v: string) => void;
  bgmUploading: boolean;
  setBgmUploading: (v: boolean) => void;
  systemTracks: SystemTrack[];
}

export function MusicPanel({ bgmEnabled, setBgmEnabled, bgmVolume, setBgmVolume, bgmFile, setBgmFile, bgmUploading, setBgmUploading, systemTracks }: Props) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "var(--sv-card)", border: "1px solid hsl(270 60% 40% / 0.2)" }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid hsl(270 60% 40% / 0.12)" }}>
        <div className="flex items-center gap-2">
          <Music2 className="h-3.5 w-3.5 text-purple-400/70" />
          <p className="text-[10px] font-bold uppercase tracking-widest text-purple-400/60">Background Music</p>
        </div>
        <button onClick={() => setBgmEnabled(v => !v)}
          className={`relative h-5 w-9 rounded-full transition-colors ${bgmEnabled ? "bg-purple-500" : "bg-white/15"}`}>
          <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${bgmEnabled ? "translate-x-4" : "translate-x-0"}`} />
        </button>
      </div>
      {bgmEnabled && (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/35 w-16 shrink-0">Volume</span>
            <input type="range" min={0} max={1} step={0.01} value={bgmVolume}
              onChange={e => setBgmVolume(Number(e.target.value))}
              className="flex-1 accent-purple-400 h-1" />
            <span className="text-[10px] font-mono text-purple-400 w-8 text-right">{Math.round(bgmVolume * 100)}%</span>
          </div>

          {systemTracks.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[9px] font-bold uppercase tracking-widest text-white/25">System Tracks</p>
              <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
                {systemTracks.map(t => (
                  <button key={t.id} onClick={() => setBgmFile(bgmFile === `/music/${t.filename}` ? "" : `/music/${t.filename}`)}
                    className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all"
                    style={bgmFile === `/music/${t.filename}`
                      ? { background: "hsl(270 60% 35% / 0.25)", border: "1px solid hsl(270 60% 40% / 0.4)", color: "#c084fc" }
                      : { background: "var(--sv-input)", border: "1px solid var(--sv-border2)", color: "rgba(255,255,255,0.5)" }}>
                    <Music2 className="h-3 w-3 shrink-0" />
                    <span className="text-[11px] font-medium truncate">{t.title}</span>
                    {bgmFile === `/music/${t.filename}` && <span className="ml-auto text-[9px] text-purple-400">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-white/25">Upload Your Track</p>
            <label className={`flex items-center justify-center gap-2 rounded-lg py-2 cursor-pointer transition-colors ${bgmUploading ? "opacity-50 pointer-events-none" : ""}`}
              style={{ background: "var(--sv-input)", border: "1px dashed hsl(270 60% 40% / 0.3)" }}>
              <input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.m4a" className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setBgmUploading(true);
                  try {
                    const fd = new FormData();
                    fd.append("file", f);
                    const res = await fetch("/api/music/upload", { method: "POST", body: fd });
                    const data = await res.json();
                    if (data.url) { setBgmFile(data.url); toast.success("Track uploaded"); }
                    else toast.error(data.error ?? "Upload failed");
                  } catch { toast.error("Upload failed"); }
                  finally { setBgmUploading(false); e.target.value = ""; }
                }} />
              {bgmUploading
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" /><span className="text-[10px] text-white/35">Uploading...</span></>
                : <><Upload className="h-3.5 w-3.5 text-purple-400/50" /><span className="text-[10px] text-white/35">Choose audio file (mp3 / wav / m4a)</span></>}
            </label>
            {bgmFile && !systemTracks.some(t => `/music/${t.filename}` === bgmFile) && (
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ background: "hsl(270 60% 35% / 0.15)", border: "1px solid hsl(270 60% 40% / 0.25)" }}>
                <Music2 className="h-3 w-3 text-purple-400/60 shrink-0" />
                <span className="text-[10px] text-purple-300 truncate flex-1">{bgmFile.split("/").pop()}</span>
                <button onClick={() => setBgmFile("")} className="text-white/30 hover:text-white/60"><X className="h-3 w-3" /></button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
