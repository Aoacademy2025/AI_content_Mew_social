"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2, Play, XCircle, Trash2, Download,
  Plus, Filter, ArrowUpDown, HardDrive, Cpu, Film,
  RefreshCw, Clock, FolderOpen, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useVideoPlaybackTelemetry } from "@/lib/use-video-playback-telemetry";
import {
  filterProjectMenuItems,
  projectStatusLabel,
  type ProjectMenuItem,
} from "../video-editor/_v2/project-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveVideoDisplayName, resolveVideoDownloadFilename } from "@/lib/video-export-name";

interface VideoItem {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  avatarModel: string;
  voiceModel: string;
  sceneCount: number;
  videoUrl: string | null;
  previewVideoUrl?: string | null;
  previewFallbackVideoUrl?: string | null;
  previewStatus?: "ready" | "queued" | "unavailable";
  avatarVideoUrl: string | null;
  audioUrl: string | null;
  script: string | null;
  thumbnail: string | null;
  createdAt: string;
  expiresAt: string | null;
  content?: { headline: string | null } | null;
  project?: { title: string } | null;
}

type NavigatorConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

type StatusFilter = "all" | "ready" | "rendering" | "failed" | "drafts";

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "ทั้งหมด",
  ready: "เสร็จแล้ว",
  rendering: "กำลังเรนเดอร์",
  failed: "ล้มเหลว",
  drafts: "ฉบับร่าง",
};

function matchesStatusFilter(video: VideoItem, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return video.status === "COMPLETED";
  if (filter === "rendering") return video.status === "PROCESSING" || video.status === "PENDING";
  if (filter === "drafts") return false;
  return video.status === "FAILED";
}

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts)
const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";

// Semantic status hues (tokens.ts): success / info / danger / warning
const STATUS_SUCCESS = "#34D399";
const STATUS_INFO = "#38BDF8";
const STATUS_DANGER = "#F87171";
const STATUS_WARNING = "#FBBF24";

// .ve-card / .ve-rise now live in globals.css (Editor v2 house utilities).

function connectionPrefersFallbackPreview() {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    connection?: NavigatorConnection;
    mozConnection?: NavigatorConnection;
    webkitConnection?: NavigatorConnection;
  };
  const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

function chooseGalleryPreviewUrl(video: VideoItem) {
  if (connectionPrefersFallbackPreview() && video.previewFallbackVideoUrl) {
    return video.previewFallbackVideoUrl;
  }
  return video.previewVideoUrl || video.previewFallbackVideoUrl || video.videoUrl || video.avatarVideoUrl;
}

export default function VideosGalleryPage() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [projects, setProjects] = useState<ProjectMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [sortLatest, setSortLatest] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const closePreview = useCallback(() => {
    setPreviewUrl(null);
    setPreviewVideoId(null);
  }, []);

  useVideoPlaybackTelemetry(previewVideoRef, {
    enabled: Boolean(previewUrl),
    page: "gallery",
    videoUrl: previewUrl,
    videoId: previewVideoId,
    sourceKind: "gallery_modal",
  });

  const fetchVideos = useCallback(() => {
    setLoading(true);
    fetch("/api/videos")
      .then(r => r.json())
      .then(d => setVideos(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }, []);

  const fetchProjects = useCallback(() => {
    setProjectsLoading(true);
    fetch("/api/editor-projects", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => setProjects(Array.isArray(d?.projects) ? d.projects : []))
      .finally(() => setProjectsLoading(false));
  }, []);

  useEffect(() => { fetchVideos(); fetchProjects(); }, [fetchVideos, fetchProjects]);
  useEffect(() => {
    if (!videos.some(video => video.previewStatus === "queued")) return;
    const timer = window.setTimeout(fetchVideos, 12_000);
    return () => window.clearTimeout(timer);
  }, [fetchVideos, videos]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") closePreview();
      if (e.key === " " && previewUrl) {
        const v = previewVideoRef.current;
        if (!v) return;
        e.preventDefault();
        if (v.paused || v.ended) void v.play();
        else v.pause();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [closePreview, previewUrl]);

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/videos/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setVideos(p => p.filter(v => v.id !== id));
      toast.success("Video deleted");
    } catch { toast.error("Failed to delete"); }
    finally { setDeleteId(null); }
  }

  async function handleDeleteProject(id: string) {
    try {
      const res = await fetch(`/api/editor-projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setProjects(p => p.filter(project => project.id !== id));
      toast.success("ลบฉบับร่างแล้ว");
    } catch { toast.error("ลบฉบับร่างไม่สำเร็จ"); }
    finally { setDeleteProjectId(null); }
  }

  const sorted = videos
    .filter(video => matchesStatusFilter(video, statusFilter))
    .sort((a, b) =>
      sortLatest
        ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  const draftProjects = filterProjectMenuItems(projects, "draft");
  const showingDrafts = statusFilter === "drafts";

  const totalSize = videos.length * 47;

  function daysLeft(expiresAt: string | null): number | null {
    if (!expiresAt) return null;
    const diff = new Date(expiresAt).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24)); // negative = already expired
  }

  const btnStyle: React.CSSProperties = {
    background: "var(--ui-card-bg)",
    border: "1px solid var(--ui-card-border)",
  };

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12">
        <div className="space-y-6">

          {/* ── Page header ── */}
          <div className="ve-rise flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
                Gallery · Recent Renders
              </p>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight"
                style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
                Recent{" "}
                <span style={{
                  backgroundImage: "linear-gradient(135deg,#B9A6FF,#8B66F8)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}>Generations</span>
              </h1>
              <p className="mt-2 text-sm" style={{ color: "var(--ui-text-secondary)" }}>Manage and download your AI-crafted cinematic shorts.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { fetchVideos(); fetchProjects(); }}
                disabled={loading || projectsLoading}
                className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs transition-colors"
                style={{ ...btnStyle, color: "var(--ui-text-muted)", minHeight: 44 }}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", (loading || projectsLoading) && "animate-spin")} />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm transition-colors"
                    style={{
                      ...btnStyle,
                      color: statusFilter !== "all" ? VIOLET_LIGHT : "var(--ui-text-muted)",
                      borderColor: statusFilter !== "all" ? VIOLET_TILE_BORDER : undefined,
                      minHeight: 44,
                    }}
                  >
                    <Filter className="h-3.5 w-3.5" />
                    {statusFilter === "all" ? "Filter" : `Filter · ${STATUS_FILTER_LABEL[statusFilter]}`}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
                >
                  {(Object.keys(STATUS_FILTER_LABEL) as StatusFilter[]).map(key => (
                    <DropdownMenuItem
                      key={key}
                      onClick={() => setStatusFilter(key)}
                      style={{ color: statusFilter === key ? VIOLET_LIGHT : "var(--ui-text-primary)" }}
                    >
                      {STATUS_FILTER_LABEL[key]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                onClick={() => setSortLatest(p => !p)}
                className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm transition-colors"
                style={{ ...btnStyle, color: VIOLET_LIGHT, minHeight: 44 }}
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
                {sortLatest ? "Latest" : "Oldest"}
              </button>
            </div>
          </div>

          {/* ── Expiry notice ── */}
          <div className="ve-rise" style={{ animationDelay: "40ms" }}>
            <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.30)" }} className="flex items-center gap-2.5 rounded-xl px-4 py-3 w-full">
              <Clock className="h-4 w-4 shrink-0" style={{ color: STATUS_WARNING }} />
              <p className="text-xs" style={{ color: "var(--ui-text-secondary)" }}>
                วิดีโอในแกลเลอรีจะหมดอายุอัตโนมัติตามแพ็กเกจ <span className="font-semibold" style={{ color: "var(--ui-text-primary)" }}>Free 3 วัน · Pro 7 วัน · Business 14 วัน</span> — ดาวน์โหลดไว้ก่อนหมดอายุ
              </p>
            </div>
          </div>

          {/* ── Grid ── */}
          {showingDrafts ? (
            projectsLoading ? null : draftProjects.length === 0 ? (
              <div className="ve-rise flex flex-col items-center justify-center gap-2 rounded-2xl py-16 text-center"
                style={{ border: "1px dashed var(--ui-card-border)" }}>
                <FolderOpen className="h-6 w-6" style={{ color: "var(--ui-text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีฉบับร่าง</p>
                <Link href="/video-editor?ui=v2" className="mt-1 rounded-xl px-4 py-2 text-xs font-semibold text-white transition-all hover:brightness-110"
                  style={{ background: "linear-gradient(180deg,#8B66F8,#6C4CF4)" }}>
                  เริ่มโปรเจกต์ใหม่
                </Link>
              </div>
            ) : (
              <div className="ve-rise grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" style={{ animationDelay: "80ms" }}>
                {draftProjects.map(project => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    deleteConfirm={deleteProjectId === project.id}
                    onDelete={() => setDeleteProjectId(project.id)}
                    onDeleteConfirm={() => handleDeleteProject(project.id)}
                    onDeleteCancel={() => setDeleteProjectId(null)}
                  />
                ))}
                <Link href="/video-editor?ui=v2">
                  <div
                    className="group flex aspect-3/4 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl transition-all hover:border-violet-500/40 hover:bg-violet-500/5"
                    style={{ border: "2px dashed var(--ui-card-border)" }}
                  >
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-full transition-all group-hover:scale-110"
                      style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)" }}
                    >
                      <Plus className="h-5 w-5 transition-colors group-hover:text-violet-400" style={{ color: "var(--ui-text-muted)" }} />
                    </div>
                    <span className="text-sm transition-colors group-hover:text-violet-400" style={{ color: "var(--ui-text-muted)" }}>New Project</span>
                  </div>
                </Link>
              </div>
            )
          ) : loading ? null : sorted.length === 0 && videos.length > 0 ? (
            <div className="ve-rise flex flex-col items-center justify-center gap-2 rounded-2xl py-16 text-center"
              style={{ border: "1px dashed var(--ui-card-border)" }}>
              <Filter className="h-6 w-6" style={{ color: "var(--ui-text-muted)" }} />
              <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ไม่มีวิดีโอในสถานะนี้</p>
            </div>
          ) : (
            <div className="ve-rise grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" style={{ animationDelay: "80ms" }}>
              {sorted.map(video => (
                <VideoCard
                  key={video.id}
                  video={video}
                  daysLeft={daysLeft(video.expiresAt)}
                  onPreview={() => {
                    // Prefer the sharp optimized gallery preview; fall back to 540p only on data-saver/2G.
                    const url = chooseGalleryPreviewUrl(video);
                    if (url) {
                      setPreviewVideoId(video.id);
                      setPreviewUrl(url);
                    }
                  }}
                  onDelete={() => setDeleteId(video.id)}
                  deleteConfirm={deleteId === video.id}
                  onDeleteConfirm={() => handleDelete(video.id)}
                  onDeleteCancel={() => setDeleteId(null)}
                />
              ))}

              {/* New Video card */}
              <Link href="/video-creator">
                <div
                  className="group flex aspect-3/4 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl transition-all hover:border-violet-500/40 hover:bg-violet-500/5"
                  style={{ border: "2px dashed var(--ui-card-border)" }}
                >
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-full transition-all group-hover:scale-110"
                    style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-btn-border)" }}
                  >
                    <Plus className="h-5 w-5 transition-colors group-hover:text-violet-400" style={{ color: "var(--ui-text-muted)" }} />
                  </div>
                  <span className="text-sm transition-colors group-hover:text-violet-400" style={{ color: "var(--ui-text-muted)" }}>New Video</span>
                </div>
              </Link>
            </div>
          )}

          {/* ── Bottom stats ── */}
          <div className="ve-rise grid gap-4 sm:grid-cols-3" style={{ animationDelay: "120ms" }}>
            {[
              { icon: Cpu,       label: "GPU CREDITS",       value: videos.length * 4,             suffix: `/ ${videos.length * 4 + 5000}` },
              { icon: HardDrive, label: "STORAGE USED",      value: (totalSize / 1024).toFixed(1), suffix: "GB" },
              { icon: Film,      label: "TOTAL GENERATIONS", value: videos.length,                 suffix: "" },
            ].map(({ icon: Icon, label, value, suffix }) => (
              <div key={label} className="ve-card flex items-center gap-4 rounded-xl p-5">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}
                >
                  <Icon className="h-5 w-5" style={{ color: VIOLET }} strokeWidth={2.1} />
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: "var(--ui-text-muted)" }}>{label}</p>
                  <p className="text-2xl font-bold leading-none" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
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
            onClick={closePreview}
          >
            <div
              className="relative overflow-hidden rounded-2xl shadow-2xl"
              // Width derives from the 9:16 box but is capped to the viewport so a phone never gets a
              // 427px-wide modal on a 390px screen (#328/#329); dvh keeps it above the iOS toolbar.
              style={{ width: "min(100vw, calc(90dvh * 9 / 16))", maxHeight: "90dvh", aspectRatio: "9/16" }}
              onClick={e => e.stopPropagation()}
            >
              <video
                ref={previewVideoRef}
                src={previewUrl}
                controls
                autoPlay
                playsInline
                className="absolute inset-0 h-full w-full object-contain bg-black"
              />
              <button
                onClick={closePreview}
                aria-label="ปิด"
                className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full text-white text-sm"
                style={{ background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.15)" }}
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Project Card ── */
function ProjectCard({
  project, onDelete, deleteConfirm, onDeleteConfirm, onDeleteCancel,
}: {
  project: ProjectMenuItem;
  onDelete: () => void;
  deleteConfirm: boolean;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  const updatedAt = project.lastOpenedAt || project.updatedAt || project.createdAt;
  const editHref = `/video-editor?ui=v2&projectId=${encodeURIComponent(project.id)}`;
  const router = useRouter();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(editHref)}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(editHref); } }}
      className="group relative aspect-3/4 cursor-pointer overflow-hidden rounded-2xl transition-all hover:scale-[1.02] hover:shadow-xl"
      style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" }}
    >
      <div className="absolute inset-0 p-4">
        <div className="flex h-full flex-col">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-xl"
            style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}` }}
          >
            <FolderOpen className="h-5 w-5" style={{ color: VIOLET }} strokeWidth={2.1} />
          </div>
          <div className="mt-4">
            <span
              className="rounded-md px-2 py-0.5 text-[10px] font-bold"
              style={{ background: "rgba(139,92,246,.14)", color: VIOLET_LIGHT, border: `1px solid ${VIOLET_TILE_BORDER}` }}
            >
              {projectStatusLabel(project.status)}
            </span>
          </div>
          <div className="mt-auto">
            <p className="line-clamp-3 text-base font-semibold leading-snug" style={{ color: "var(--ui-text-primary)" }}>
              {project.title || "New Project"}
            </p>
            <p className="mt-2 flex items-center gap-1 text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
              <Clock className="h-2.5 w-2.5" />
              {updatedAt ? new Date(updatedAt).toLocaleDateString("th-TH", { month: "short", day: "numeric" }) : "ยังไม่เคยเปิด"}
            </p>
          </div>
        </div>
      </div>

      {/* Desktop: hover overlay (pointer devices only). Touch devices get the always-visible action row below. */}
      <div className="absolute inset-0 hidden items-center justify-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 md:flex"
        style={{ background: "rgba(0,0,0,0.54)" }} onClick={e => e.stopPropagation()}>
        <Link href={editHref}
          className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-all hover:scale-110"
          style={{ background: "rgba(139,92,246,.35)", border: `1px solid ${VIOLET_TILE_BORDER}` }}
          title="เปิดฉบับร่าง">
          <Pencil className="h-4 w-4" />
        </Link>
        {deleteConfirm ? (
          <div className="flex items-center gap-1.5 rounded-xl px-3 py-1.5"
            style={{ background: "rgba(0,0,0,0.8)", border: `1px solid ${STATUS_DANGER}66` }}>
            <span className="text-xs" style={{ color: STATUS_DANGER }}>Delete?</span>
            <button onClick={onDeleteConfirm} className="text-xs transition-colors" style={{ color: STATUS_DANGER }}>Yes</button>
            <button onClick={onDeleteCancel} className="text-xs text-white/50 transition-colors hover:text-white/80">No</button>
          </div>
        ) : (
          <button onClick={onDelete}
            className="flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-all hover:scale-110 hover:text-red-400"
            style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)" }}
            title="ลบฉบับร่าง">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Touch: always-visible action row (tap on the card itself opens the draft). */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 px-2 pb-2 md:hidden"
        onClick={e => e.stopPropagation()}>
        {deleteConfirm ? (
          <div className="flex items-center gap-2 rounded-xl px-3 py-2"
            style={{ background: "rgba(0,0,0,0.85)", border: `1px solid ${STATUS_DANGER}66` }}>
            <span className="text-xs" style={{ color: STATUS_DANGER }}>ลบฉบับร่าง?</span>
            <button onClick={onDeleteConfirm} className="min-h-11 px-2 text-xs font-semibold" style={{ color: STATUS_DANGER }}>ลบ</button>
            <button onClick={onDeleteCancel} className="min-h-11 px-2 text-xs text-white/60">ยกเลิก</button>
          </div>
        ) : (
          <button onClick={onDelete} aria-label="ลบฉบับร่าง"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/80"
            style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.2)" }}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
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
  const nameInput = {
    projectTitle: video.project?.title,
    headline: video.content?.headline,
    script: video.script,
  };
  const title = resolveVideoDisplayName(nameInput);
  const downloadFilename = resolveVideoDownloadFilename(nameInput);
  const previewSrc = video.previewVideoUrl || video.previewFallbackVideoUrl || video.videoUrl || video.avatarVideoUrl;
  const downloadSrc = video.videoUrl || video.avatarVideoUrl;
  const posterHue = posterHueFor(video.id);
  // A thumbnail file can be swept off disk while the record survives — fall back to the
  // gradient placeholder on load error instead of showing a broken-image icon.
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = !!video.thumbnail && !thumbFailed;

  const canPreview = isReady && !!previewSrc;
  return (
    <div
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
      onClick={canPreview ? onPreview : undefined}
      onKeyDown={canPreview ? (e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPreview(); } }) : undefined}
      className="group relative aspect-3/4 cursor-pointer overflow-hidden rounded-2xl transition-all hover:scale-[1.02] hover:shadow-xl"
      style={{ background: "var(--ui-card-bg-2)", border: "1px solid var(--ui-card-border)" }}
    >
      {/* Thumbnail / background */}
      {showThumb ? (
        <img
          src={video.thumbnail!}
          alt={title}
          loading="lazy"
          decoding="async"
          onError={() => setThumbFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : previewSrc ? (
        // Thumbnail stopgap: no generated thumbnail yet, so paint the video's first
        // frame as a poster. muted + no autoplay + preload=metadata → browser decodes
        // just enough to draw frame 1 without actually playing (avoids N videos
        // playing at once across the grid).
        <video
          src={`${previewSrc}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          aria-hidden="true"
          tabIndex={-1}
          className="absolute inset-0 h-full w-full object-cover pointer-events-none"
          style={{ background: `hsl(${posterHue} 40% 10%)` }}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3"
          style={{ background: "var(--ui-card-bg-2)" }}>
          {isRendering && (
            <>
              <div className="relative flex h-14 w-14 items-center justify-center">
                <div className="absolute inset-0 rounded-full" style={{ border: `2px solid ${STATUS_INFO}33` }} />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent" style={{ borderTopColor: STATUS_INFO }} />
                <div className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{ background: "var(--ui-spinner-bg)" }}>
                  <div className="h-3 w-3 rounded-sm" style={{ background: `${STATUS_INFO}99` }} />
                </div>
              </div>
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: `${STATUS_INFO}b3` }}>Rendering</p>
            </>
          )}
          {isFailed && <XCircle className="h-8 w-8" style={{ color: `${STATUS_DANGER}80` }} />}
        </div>
      )}

      {/* Gradient overlay (bottom) — only on media cards */}
      {(showThumb || previewSrc) && (
        <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/10 to-transparent" />
      )}

      {/* Status badge */}
      <div className="absolute top-2.5 right-2.5">
        {isReady && (
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: "rgba(52,211,153,.16)", color: STATUS_SUCCESS, border: `1px solid ${STATUS_SUCCESS}66` }}>
            Ready
          </span>
        )}
        {isRendering && (
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: "rgba(56,189,248,.12)", color: STATUS_INFO, border: `1px solid ${STATUS_INFO}40` }}>
            Rendering
          </span>
        )}
        {isFailed && (
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: "rgba(248,113,113,.10)", color: STATUS_DANGER, border: `1px solid ${STATUS_DANGER}40` }}>
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
            <p className={`text-[10px] font-semibold flex items-center gap-0.5 ${daysLeft <= 0 ? "text-red-400" : daysLeft <= 3 ? "text-orange-400" : "text-white/40"}`}>
              <Clock className="h-2.5 w-2.5" />
              {daysLeft <= 0 ? "หมดอายุแล้ว" : daysLeft === 1 ? "หมดวันนี้" : `${daysLeft}ว`}
            </p>
          )}
        </div>
      </div>

      {/* Desktop hover actions (pointer devices only). On touch the centred overlay caught the first tap and
          fired the Download anchor (#328) — phones get the bottom action row instead. */}
      <div className="absolute inset-0 hidden items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity md:flex"
        style={{ background: "rgba(0,0,0,0.5)" }} onClick={e => e.stopPropagation()}>
        {isReady && previewSrc && (
          <>
            <button onClick={onPreview}
              className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-all hover:scale-110"
              style={{ background: "rgba(139,92,246,.35)", border: `1px solid ${VIOLET_TILE_BORDER}` }}>
              <Play className="h-4 w-4 fill-white ml-0.5" />
            </button>
            {downloadSrc && (
              <a href={downloadSrc} download={downloadFilename} rel="noreferrer" onClick={e => e.stopPropagation()}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-all hover:scale-110"
                style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)" }}>
                <Download className="h-4 w-4" />
              </a>
            )}
          </>
        )}
        {isRendering && (
          <Link href={`/video-editor?resume=${video.id}`}
            className="flex items-center gap-1 rounded-full px-3 h-10 text-xs font-semibold text-white transition-all hover:scale-105"
            style={{ background: "rgba(251,191,36,.25)", border: `1px solid ${STATUS_WARNING}8c` }}
            title="เปิดในเอดิเตอร์เพื่อทำต่อ (เช่น Burn ซับ)">
            <RefreshCw className="h-3.5 w-3.5" /> ทำต่อ
          </Link>
        )}
        {deleteConfirm ? (
          <div className="flex items-center gap-1.5 rounded-xl px-3 py-1.5"
            style={{ background: "rgba(0,0,0,0.8)", border: `1px solid ${STATUS_DANGER}66` }}>
            <span className="text-xs" style={{ color: STATUS_DANGER }}>Delete?</span>
            <button onClick={onDeleteConfirm} className="text-xs transition-colors" style={{ color: STATUS_DANGER }}>Yes</button>
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

      {/* Touch: always-visible action row. Tap on the card = preview; download/delete are explicit. */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 px-2 pb-2 md:hidden"
        onClick={e => e.stopPropagation()}>
        {isRendering && (
          <Link href={`/video-editor?resume=${video.id}`}
            className="flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-semibold text-white"
            style={{ background: "rgba(251,191,36,.35)", border: `1px solid ${STATUS_WARNING}8c` }}>
            <RefreshCw className="h-3.5 w-3.5" /> ทำต่อ
          </Link>
        )}
        {isReady && downloadSrc && (
          <a href={downloadSrc} download={downloadFilename} aria-label="ดาวน์โหลด"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white"
            style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.2)" }}>
            <Download className="h-4 w-4" />
          </a>
        )}
        {deleteConfirm ? (
          <div className="flex items-center gap-2 rounded-xl px-3 py-2"
            style={{ background: "rgba(0,0,0,0.85)", border: `1px solid ${STATUS_DANGER}66` }}>
            <span className="text-xs" style={{ color: STATUS_DANGER }}>ลบคลิป?</span>
            <button onClick={onDeleteConfirm} className="min-h-11 px-2 text-xs font-semibold" style={{ color: STATUS_DANGER }}>ลบ</button>
            <button onClick={onDeleteCancel} className="min-h-11 px-2 text-xs text-white/60">ยกเลิก</button>
          </div>
        ) : (
          <button onClick={onDelete} aria-label="ลบคลิป"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/80"
            style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.2)" }}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function posterHueFor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return 170 + (hash % 90);
}
