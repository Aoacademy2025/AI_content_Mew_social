"use client";

import { useState, useEffect, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  Loader2, Play, XCircle, Trash2, Download,
  Plus, Filter, ArrowUpDown, HardDrive, Cpu, Film,
  RefreshCw, Clock,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface VideoItem {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  avatarModel: string;
  voiceModel: string;
  sceneCount: number;
  videoUrl: string | null;
  avatarVideoUrl: string | null;
  audioUrl: string | null;
  script: string | null;
  thumbnail: string | null;
  createdAt: string;
  expiresAt: string | null;
  content?: { headline: string | null } | null;
}

export default function VideosGalleryPage() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sortLatest, setSortLatest] = useState(true);

  const fetchVideos = useCallback(() => {
    setLoading(true);
    fetch("/api/videos")
      .then(r => r.json())
      .then(d => setVideos(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchVideos(); }, [fetchVideos]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setPreviewUrl(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/videos/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setVideos(p => p.filter(v => v.id !== id));
      toast.success("Video deleted");
    } catch { toast.error("Failed to delete"); }
    finally { setDeleteId(null); }
  }

  const sorted = [...videos].sort((a, b) =>
    sortLatest
      ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const totalSize = videos.length * 47;

  function daysLeft(expiresAt: string | null): number | null {
    if (!expiresAt) return null;
    const diff = new Date(expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  const btnStyle: React.CSSProperties = {
    background: "var(--ui-card-bg)",
    border: "1px solid var(--ui-card-border)",
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)" }}>Recent Generations</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--ui-text-muted)" }}>Manage and download your AI-crafted cinematic shorts.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchVideos}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs transition-colors"
              style={{ ...btnStyle, color: "var(--ui-text-muted)" }}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
            <button
              className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm transition-colors"
              style={{ ...btnStyle, color: "var(--ui-text-muted)" }}
            >
              <Filter className="h-3.5 w-3.5" /> Filter
            </button>
            <button
              onClick={() => setSortLatest(p => !p)}
              className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm transition-colors"
              style={{ ...btnStyle, color: "hsl(190 100% 50%)" }}
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
              {sortLatest ? "Latest" : "Oldest"}
            </button>
          </div>
        </div>

        {/* ── Expiry notice ── */}
        <div className="flex items-center gap-2.5 rounded-xl px-4 py-3"
          style={{ background: "hsl(38 90% 50% / 0.08)", border: "1px solid hsl(38 90% 50% / 0.25)" }}>
          <Clock className="h-4 w-4 shrink-0" style={{ color: "hsl(38 90% 60%)" }} />
          <p className="text-xs" style={{ color: "hsl(38 90% 70%)" }}>
            วิดีโอในแกลเลอรีจะ<span className="font-semibold">หมดอายุและถูกลบอัตโนมัติภายใน 7 วัน</span>หลังจากสร้าง — ดาวน์โหลดไว้ก่อนหมดอายุ
          </p>
        </div>

        {/* ── Grid ── */}
        {loading ? (
          <div className="flex items-center justify-center py-32">
            <Loader2 className="h-7 w-7 animate-spin text-cyan-500/30" />
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {sorted.map(video => (
              <VideoCard
                key={video.id}
                video={video}
                daysLeft={daysLeft(video.expiresAt)}
                onPreview={() => {
                  const url = video.videoUrl || video.avatarVideoUrl;
                  if (url) setPreviewUrl(url);
                }}
                onDelete={() => setDeleteId(video.id)}
                deleteConfirm={deleteId === video.id}
                onDeleteConfirm={() => handleDelete(video.id)}
                onDeleteCancel={() => setDeleteId(null)}
              />
            ))}

            {/* New Video card */}
            <Link href="/short-video">
              <div
                className="group flex aspect-3/4 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl transition-all hover:border-cyan-500/40 hover:bg-cyan-500/5"
                style={{ border: "2px dashed var(--ui-card-border)" }}
              >
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-full transition-all group-hover:scale-110"
                  style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)" }}
                >
                  <Plus className="h-5 w-5 transition-colors group-hover:text-cyan-500" style={{ color: "var(--ui-text-muted)" }} />
                </div>
                <span className="text-sm transition-colors group-hover:text-cyan-500" style={{ color: "var(--ui-text-muted)" }}>New Video</span>
              </div>
            </Link>
          </div>
        )}

        {/* ── Bottom stats ── */}
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { icon: Cpu,       label: "GPU CREDITS",       value: videos.length * 4,             suffix: `/ ${videos.length * 4 + 5000}`, color: "hsl(190 100% 50%)" },
            { icon: HardDrive, label: "STORAGE USED",      value: (totalSize / 1024).toFixed(1), suffix: "GB",                            color: "hsl(271 91% 65%)" },
            { icon: Film,      label: "TOTAL GENERATIONS", value: videos.length,                 suffix: "",                              color: "hsl(190 100% 50%)" },
          ].map(({ icon: Icon, label, value, suffix, color }) => (
            <div
              key={label}
              className="flex items-center gap-4 rounded-2xl p-5"
              style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
            >
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                style={{ background: color + "22", border: `1px solid ${color}44` }}
              >
                <Icon className="h-5 w-5" style={{ color }} />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                <p className="text-2xl font-bold leading-none" style={{ color: "var(--ui-text-primary)" }}>
                  {typeof value === "number" ? value.toLocaleString() : value}
                  {suffix && <span className="ml-1 text-sm font-normal" style={{ color: "var(--ui-text-muted)" }}>{suffix}</span>}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Preview modal ── */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
          style={{ background: "var(--ui-overlay-bg)" }}
          onClick={() => setPreviewUrl(null)}
        >
          <div
            className="relative overflow-hidden rounded-2xl shadow-2xl"
            style={{ height: "90vh", aspectRatio: "9/16" }}
            onClick={e => e.stopPropagation()}
          >
            <video
              src={previewUrl}
              controls
              autoPlay
              className="absolute inset-0 h-full w-full object-contain bg-black"
            />
            <button
              onClick={() => setPreviewUrl(null)}
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-white text-sm"
              style={{ background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              ✕
            </button>
          </div>
        </div>
      )}


    </DashboardLayout>
  );
}

/* ── Video Card ── */
function VideoCard({
  video, daysLeft, onPreview, onDelete, deleteConfirm, onDeleteConfirm, onDeleteCancel,
}: {
  video: VideoItem;
  daysLeft: number | null;
  onPreview: () => void;
  onDelete: () => void;
  deleteConfirm: boolean;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  const isReady = video.status === "COMPLETED";
  const isRendering = video.status === "PROCESSING" || video.status === "PENDING";
  const isFailed = video.status === "FAILED";
  const title = video.content?.headline || (video.script ? video.script.slice(0, 40) + "..." : "Untitled");
  const previewSrc = video.videoUrl || video.avatarVideoUrl;
  const downloadSrc = video.videoUrl || video.avatarVideoUrl;

  return (
    <div
      className="group relative aspect-3/4 cursor-pointer overflow-hidden rounded-2xl transition-all hover:scale-[1.02] hover:shadow-xl"
      style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" }}
    >
      {/* Thumbnail / background */}
      {video.thumbnail ? (
        <img src={video.thumbnail} alt={title} className="absolute inset-0 h-full w-full object-cover" />
      ) : previewSrc ? (
        <video src={previewSrc} className="absolute inset-0 h-full w-full object-cover" muted playsInline />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3"
          style={{ background: "var(--ui-card-bg-2)" }}>
          {isRendering && (
            <>
              <div className="relative flex h-14 w-14 items-center justify-center">
                <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20" />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-cyan-400" />
                <div className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{ background: "var(--ui-spinner-bg)" }}>
                  <div className="h-3 w-3 rounded-sm" style={{ background: "hsl(190 100% 50% / 0.6)" }} />
                </div>
              </div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500/70">Rendering</p>
            </>
          )}
          {isFailed && <XCircle className="h-8 w-8 text-red-400/50" />}
        </div>
      )}

      {/* Gradient overlay (bottom) — only on media cards */}
      {(video.thumbnail || previewSrc) && (
        <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/10 to-transparent" />
      )}

      {/* Status badge */}
      <div className="absolute top-2.5 right-2.5">
        {isReady && (
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: "hsl(142 72% 29%)", color: "hsl(142 72% 85%)", border: "1px solid hsl(142 72% 40% / 0.5)" }}>
            Ready
          </span>
        )}
        {isRendering && (
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400"
            style={{ background: "hsl(190 100% 50% / 0.12)", border: "1px solid hsl(190 100% 50% / 0.25)" }}>
            Rendering
          </span>
        )}
        {isFailed && (
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-400"
            style={{ background: "hsl(0 84% 60% / 0.1)", border: "1px solid hsl(0 84% 60% / 0.25)" }}>
            Failed
          </span>
        )}
      </div>

      {/* Title (bottom) — always white because it's over gradient/video */}
      <div className="absolute bottom-0 inset-x-0 p-3">
        <p className="text-sm font-semibold text-white line-clamp-2 leading-snug">{title}</p>
        <div className="flex items-center justify-between mt-0.5">
          <p className="text-[10px] text-white/50">
            {new Date(video.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </p>
          {daysLeft !== null && (
            <p className={`text-[10px] font-semibold flex items-center gap-0.5 ${daysLeft <= 1 ? "text-red-400" : daysLeft <= 3 ? "text-orange-400" : "text-white/40"}`}>
              <Clock className="h-2.5 w-2.5" />
              {daysLeft === 0 ? "หมดวันนี้" : `${daysLeft}ว`}
            </p>
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: "rgba(0,0,0,0.5)" }}>
        {isReady && previewSrc && (
          <>
            <button onClick={onPreview}
              className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-all hover:scale-110"
              style={{ background: "hsl(190 100% 50% / 0.3)", border: "1px solid hsl(190 100% 50% / 0.5)" }}>
              <Play className="h-4 w-4 fill-white ml-0.5" />
            </button>
            {downloadSrc && (
              <a href={downloadSrc} download target="_blank" rel="noreferrer"
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-all hover:scale-110"
                style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)" }}>
                <Download className="h-4 w-4" />
              </a>
            )}
          </>
        )}
        {deleteConfirm ? (
          <div className="flex items-center gap-1.5 rounded-xl px-3 py-1.5"
            style={{ background: "rgba(0,0,0,0.8)", border: "1px solid hsl(0 84% 60% / 0.4)" }}>
            <span className="text-xs text-red-400">Delete?</span>
            <button onClick={onDeleteConfirm} className="text-xs text-red-400 hover:text-red-300 transition-colors">Yes</button>
            <button onClick={onDeleteCancel} className="text-xs text-white/50 hover:text-white/80 transition-colors">No</button>
          </div>
        ) : (
          <button onClick={onDelete}
            className="flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-all hover:scale-110 hover:text-red-400"
            style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)" }}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
