"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  CirclePause,
  CirclePlay,
  Clapperboard,
  Clock3,
  Download,
  Film,
  Image as ImageIcon,
  Images,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
  UserRound,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import type {
  StoryFilmDecisionKind,
  StoryFilmPresentationMode,
  StoryFilmProjectView,
  StoryFilmStage,
} from "@/lib/story-film.server";

const STAGES: ReadonlyArray<{ id: StoryFilmStage; short: string }> = [
  { id: "setup", short: "Setup" },
  { id: "narration", short: "เสียง" },
  { id: "storyboard", short: "เรื่อง" },
  { id: "character_look", short: "ลุค" },
  { id: "keyframes", short: "ภาพ" },
  { id: "videos", short: "วิดีโอ" },
  { id: "music", short: "เพลง" },
  { id: "final_render", short: "Render" },
];

type ApiError = { error?: string; message?: string; current?: StoryFilmProjectView };

type StoryboardScene = {
  sceneKey: string;
  sequence: number;
  startMs: number;
  endMs: number;
  sourceExcerpt: string;
  subject: string;
  action: string;
  setting: string;
  emotion: string;
  mediaPlan: "video" | "image_with_motion";
  visualOwner: "broll" | "presenter";
};

type StoryboardDocument = {
  version: string;
  narrationDurationMs: number;
  dominantNarrativeMode: string;
  suggestedTreatment?: { rationale?: string };
  scenes: StoryboardScene[];
};

type CharacterProfile = {
  id: string;
  name: string;
  identityNotes: string | null;
  activeReferenceSetVersion: number;
  references: Array<{
    id: string;
    url: string;
    originalName: string;
    viewLabel: string | null;
  }>;
};

type ReviewArtifact = {
  id: string;
  kind: string;
  sceneKey: string | null;
  storageUrl: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

type NarrationVoiceOption = {
  key: string;
  provider: "hero_voice" | "elevenlabs";
  voiceId: string;
  label: string;
  previewUrl?: string | null;
};

type MusicCandidate = {
  source: "user" | "system";
  trackId: string;
  title: string;
  url: string;
  durationMs: number | null;
};

function apiMessage(data: ApiError, fallback: string) {
  return data.message || fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusCopy(project: StoryFilmProjectView) {
  if (project.status === "paused") return "พักงานไว้";
  if (project.status === "rendering") return "กำลังเรนเดอร์";
  if (project.status === "completed") return "เสร็จแล้ว";
  if (project.status === "needs_attention") return "ต้องให้มิวจัดการ";
  if (project.awaitingApproval) return "รอมิวตรวจ";
  return "รอระบบเตรียมงาน";
}

function clock(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String((seconds % 60).toFixed(1)).padStart(4, "0")}`;
}

function storyboardArtifactUrl(project: StoryFilmProjectView | null) {
  if (!project || project.stage !== "storyboard" || !project.awaitingApproval) return null;
  const artifacts = project.stageData.artifacts;
  if (!Array.isArray(artifacts)) return null;
  const artifact = artifacts.find((item) => item
    && typeof item === "object"
    && (item as Record<string, unknown>).mimeType === "application/json");
  const url = artifact && typeof artifact === "object"
    ? (artifact as Record<string, unknown>).storageUrl
    : null;
  return typeof url === "string" ? url : null;
}

function reviewArtifacts(project: StoryFilmProjectView): ReviewArtifact[] {
  const artifacts = project.stageData.artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.storageUrl !== "string" || typeof value.mimeType !== "string") return [];
    return [{
      id: value.id,
      kind: typeof value.kind === "string" ? value.kind : "artifact",
      sceneKey: typeof value.sceneKey === "string" ? value.sceneKey : null,
      storageUrl: value.storageUrl,
      mimeType: value.mimeType,
      width: typeof value.width === "number" ? value.width : null,
      height: typeof value.height === "number" ? value.height : null,
      durationMs: typeof value.durationMs === "number" ? value.durationMs : null,
    }];
  });
}

function ArtifactReview({ project }: { project: StoryFilmProjectView }) {
  const artifacts = reviewArtifacts(project);
  if (project.stageData.skipped === true) {
    return <div className="mt-7 border border-dashed border-[oklch(42%_0.05_300)] p-6 text-sm leading-6 text-[oklch(76%_0.025_300)]">{typeof project.stageData.reason === "string" ? project.stageData.reason : "ขั้นนี้ไม่ต้องสร้าง asset"}</div>;
  }
  if (artifacts.length === 0) return <div className="mt-7 border border-dashed border-amber-500/40 p-6 text-sm text-amber-100">ไม่พบไฟล์ฉบับตรวจของ revision นี้</div>;
  return (
    <div className="mt-7 grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
      {artifacts.map((artifact, index) => (
        <figure key={artifact.id} className="overflow-hidden border border-[oklch(32%_0.03_300)] bg-[oklch(17%_0.02_300)]">
          <div className="aspect-[9/16] bg-black">
            {artifact.mimeType.startsWith("image/")
              ? <img src={artifact.storageUrl} alt={artifact.sceneKey || `ภาพฉบับตรวจ ${index + 1}`} className="h-full w-full object-contain" />
              : artifact.mimeType.startsWith("video/")
                ? <video src={artifact.storageUrl} controls playsInline preload="metadata" className="h-full w-full object-contain" />
                : <div className="flex h-full items-center justify-center text-xs text-[oklch(65%_0.025_300)]">{artifact.mimeType}</div>}
          </div>
          <figcaption className="flex items-center justify-between gap-3 border-t border-[oklch(30%_0.025_300)] px-3 py-3 text-xs">
            <span className="font-medium">{artifact.sceneKey || (project.stage === "character_look" ? "ลุคหลัก" : `Asset ${index + 1}`)}</span>
            <span className="text-[oklch(62%_0.025_300)]">{artifact.durationMs ? clock(artifact.durationMs) : artifact.width && artifact.height ? `${artifact.width}×${artifact.height}` : artifact.kind}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function CompletedFilm({ project }: { project: StoryFilmProjectView }) {
  if (!project.finalRenderUrl) return null;
  return (
    <div className="mt-7 grid gap-5 border-y border-[oklch(30%_0.025_300)] py-6 md:grid-cols-[220px_minmax(0,1fr)] md:items-center">
      <div className="aspect-[9/16] overflow-hidden bg-black">
        <video src={project.finalRenderUrl} controls playsInline preload="metadata" className="h-full w-full object-contain" />
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(72%_0.11_75)]">Master approved</p>
        <h4 className="mt-2 text-2xl font-semibold">Hero Story Film พร้อมใช้งาน</h4>
        <p className="mt-3 max-w-[55ch] text-sm leading-6 text-[oklch(69%_0.025_300)]">ไฟล์เดียวสำหรับ Facebook, Instagram, YouTube Shorts และ TikTok ในสัดส่วน 9:16</p>
        <a
          href={project.finalRenderUrl}
          download
          className="mt-6 inline-flex min-h-12 items-center gap-2 bg-[oklch(63%_0.2_300)] px-5 text-sm font-semibold hover:bg-[oklch(68%_0.19_300)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-300"
        >
          <Download className="h-4 w-4" />ดาวน์โหลด MP4
        </a>
      </div>
    </div>
  );
}

function musicCandidates(project: StoryFilmProjectView | null): MusicCandidate[] {
  if (!project || project.stage !== "music" || !Array.isArray(project.stageData.candidates)) return [];
  return project.stageData.candidates.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if ((value.source !== "user" && value.source !== "system")
      || typeof value.trackId !== "string"
      || typeof value.title !== "string"
      || typeof value.url !== "string") return [];
    return [{
      source: value.source,
      trackId: value.trackId,
      title: value.title,
      url: value.url,
      durationMs: typeof value.durationMs === "number" ? value.durationMs : null,
    }];
  });
}

function MusicReview({
  candidates,
  selectedKey,
  onSelect,
}: {
  candidates: MusicCandidate[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="mt-7 space-y-3">
      <div className="mb-5 border-y border-[oklch(30%_0.025_300)] py-4"><p className="text-sm font-medium">เลือกเพลงที่มีอยู่ก่อน</p><p className="mt-1 text-xs leading-5 text-[oklch(66%_0.025_300)]">เพลงหนึ่งเพลง reuse ได้หลายคลิป ระบบจะไม่ใช้ vidIQ credit เพิ่มเมื่อเพลงเดิมเหมาะกับเรื่อง</p></div>
      {candidates.map((track) => {
        const key = `${track.source}:${track.trackId}`;
        const selected = key === selectedKey;
        return <label key={key} className="grid cursor-pointer gap-3 border p-4 sm:grid-cols-[24px_minmax(0,1fr)_auto] sm:items-center" style={{ borderColor: selected ? "oklch(68% 0.16 300)" : "oklch(34% 0.03 300)", background: selected ? "oklch(22% 0.04 300)" : "oklch(17% 0.02 300)" }}><input type="radio" name="story-film-music" value={key} checked={selected} onChange={() => onSelect(key)} className="accent-violet-500" /><div><p className="text-sm font-medium">{track.title}</p><p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[oklch(60%_0.035_300)]">{track.source === "user" ? "เพลงของมิว" : "เพลงกลาง"}{track.durationMs ? ` · ${clock(track.durationMs)}` : ""}</p></div><audio controls preload="none" src={track.url} className="h-9 w-full sm:w-56" /></label>;
      })}
    </div>
  );
}

function StoryboardReview({ document }: { document: StoryboardDocument }) {
  return (
    <div className="mt-7">
      <div className="mb-6 grid gap-4 border-y border-[oklch(30%_0.025_300)] py-5 sm:grid-cols-[1fr_auto]">
        <div>
          <p className="text-sm font-medium text-[oklch(90%_0.02_300)]">{document.dominantNarrativeMode}</p>
          {document.suggestedTreatment?.rationale && <p className="mt-2 text-xs leading-5 text-[oklch(68%_0.025_300)]">{document.suggestedTreatment.rationale}</p>}
        </div>
        <div className="flex items-center gap-2 text-xs tabular-nums text-[oklch(75%_0.08_75)]"><Clock3 className="h-4 w-4" />{clock(document.narrationDurationMs)} · {document.scenes.length} ฉาก</div>
      </div>
      <ol className="space-y-3">
        {document.scenes.map((scene) => (
          <li key={scene.sceneKey} className="grid overflow-hidden border border-[oklch(32%_0.03_300)] bg-[oklch(18%_0.02_300)] md:grid-cols-[92px_minmax(0,1fr)]">
            <div className="flex min-h-24 flex-col justify-between bg-[oklch(22%_0.045_300)] p-4">
              <span className="text-2xl font-semibold tabular-nums text-[oklch(85%_0.08_300)]">{String(scene.sequence + 1).padStart(2, "0")}</span>
              <span className="text-[10px] tabular-nums text-[oklch(66%_0.035_300)]">{clock(scene.startMs)}–{clock(scene.endMs)}</span>
            </div>
            <div className="p-4 md:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-[70ch] text-sm font-medium leading-6 text-[oklch(91%_0.015_300)]">{scene.sourceExcerpt}</p>
                <span className="inline-flex shrink-0 items-center gap-1.5 border border-[oklch(40%_0.05_300)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[oklch(75%_0.08_75)]">
                  {scene.visualOwner === "presenter"
                    ? <UserRound className="h-3.5 w-3.5" />
                    : scene.mediaPlan === "video"
                      ? <Video className="h-3.5 w-3.5" />
                      : <ImageIcon className="h-3.5 w-3.5" />}
                  {scene.visualOwner === "presenter"
                    ? "Presenter"
                    : scene.mediaPlan === "video" ? "AI Video" : "Image + Motion"}
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-[oklch(76%_0.025_300)]"><span className="text-[oklch(57%_0.025_300)]">ภาพ</span> · {scene.subject} — {scene.action}</p>
              <p className="mt-1 text-xs leading-5 text-[oklch(61%_0.025_300)]">{scene.setting} · {scene.emotion}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RevisionTargetSelect({
  stage,
  sceneKeys,
  value,
  onChange,
}: {
  stage: StoryFilmStage;
  sceneKeys: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (stage !== "keyframes" && stage !== "videos") return null;
  return (
    <div className="mb-3">
      <label htmlFor="revision-scene" className="mb-2 block text-xs font-medium">เลือกฉากที่ต้องแก้</label>
      <select
        id="revision-scene"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30"
      >
        <option value="">เลือก Scene</option>
        {sceneKeys.map((sceneKey) => <option key={sceneKey} value={sceneKey}>{sceneKey}</option>)}
      </select>
    </div>
  );
}

async function inspectVideo(file: File): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const finish = () => URL.revokeObjectURL(url);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const result = {
        durationMs: Math.round(video.duration * 1_000),
        width: video.videoWidth,
        height: video.videoHeight,
      };
      finish();
      resolve(result);
    };
    video.onerror = () => {
      finish();
      reject(new Error("อ่านข้อมูลวิดีโอไม่ได้ กรุณาเลือกไฟล์ mp4, mov หรือ webm ใหม่"));
    };
    video.src = url;
  });
}

export default function StoryFilmWorkbench({ initialProjectId }: { initialProjectId: string | null }) {
  const [projects, setProjects] = useState<StoryFilmProjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [presentationMode, setPresentationMode] = useState<StoryFilmPresentationMode>("presenter_led");
  const [sourcePackage, setSourcePackage] = useState("");
  const [narrativeSource, setNarrativeSource] = useState("");
  const [presenterFile, setPresenterFile] = useState<File | null>(null);
  const [changeBrief, setChangeBrief] = useState("");
  const [storyboardDocument, setStoryboardDocument] = useState<StoryboardDocument | null>(null);
  const [storyboardLoading, setStoryboardLoading] = useState(false);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [characterProfileId, setCharacterProfileId] = useState("");
  const [characterLookBrief, setCharacterLookBrief] = useState("");
  const [addingCharacter, setAddingCharacter] = useState(false);
  const [characterName, setCharacterName] = useState("มิว");
  const [characterIdentityNotes, setCharacterIdentityNotes] = useState("");
  const [characterFiles, setCharacterFiles] = useState<File[]>([]);
  const [characterSaving, setCharacterSaving] = useState(false);
  const [voices, setVoices] = useState<NarrationVoiceOption[]>([]);
  const [narrationProvider, setNarrationProvider] = useState<"hero_voice" | "elevenlabs">("hero_voice");
  const [narrationVoiceId, setNarrationVoiceId] = useState("");
  const [narrationVoiceSpeed, setNarrationVoiceSpeed] = useState(1);
  const [selectedMusicKey, setSelectedMusicKey] = useState("");
  const [revisionSceneKey, setRevisionSceneKey] = useState("");

  const selected = projects.find((project) => project.id === selectedId) ?? null;
  const storyboardUrl = storyboardArtifactUrl(selected);
  const selectedCharacter = characters.find((character) => character.id === characterProfileId) ?? null;
  const availableMusic = musicCandidates(selected);
  const selectedNarrationVoice = voices.find(
    (voice) => voice.provider === narrationProvider && voice.voiceId === narrationVoiceId,
  ) ?? null;
  const revisionSceneKeys = selected
    ? [...new Set(reviewArtifacts(selected).flatMap((artifact) => artifact.sceneKey ? [artifact.sceneKey] : []))]
    : [];

  const loadProjects = useCallback(async (preferredId?: string | null) => {
    const response = await fetch("/api/ai-studio/story-films", { cache: "no-store" });
    const data = await response.json() as { projects?: StoryFilmProjectView[] } & ApiError;
    if (!response.ok) throw new Error(apiMessage(data, "โหลด Hero Story Film ไม่สำเร็จ"));
    const next = data.projects ?? [];
    setProjects(next);
    setSelectedId((current) => {
      const target = preferredId ?? current ?? initialProjectId;
      return next.some((project) => project.id === target) ? target! : next[0]?.id ?? null;
    });
  }, [initialProjectId]);

  const loadCharacters = useCallback(async (preferredId?: string | null) => {
    const response = await fetch("/api/ai-studio/story-film-characters", { cache: "no-store" });
    const data = await response.json() as { characters?: CharacterProfile[] } & ApiError;
    if (!response.ok) throw new Error(apiMessage(data, "โหลด Character Library ไม่สำเร็จ"));
    const next = data.characters ?? [];
    setCharacters(next);
    if (preferredId) setCharacterProfileId(preferredId);
  }, []);

  const loadVoices = useCallback(async () => {
    const [heroResponse, elevenResponse] = await Promise.all([
      fetch("/api/omnivoice/voices", { cache: "no-store" }),
      fetch("/api/elevenlabs/voices", { cache: "no-store" }),
    ]);
    const heroData = await heroResponse.json() as Array<{ voice_id: string; desc?: string; preview_url?: string }> | ApiError;
    const elevenData = await elevenResponse.json() as {
      voices?: Array<{ voice_id: string; name: string; preview_url?: string | null }>;
      defaultVoiceId?: string | null;
    } & ApiError;
    const heroVoices: NarrationVoiceOption[] = heroResponse.ok && Array.isArray(heroData)
      ? heroData.map((voice) => ({
          key: `hero_voice:${voice.voice_id}`,
          provider: "hero_voice",
          voiceId: voice.voice_id,
          label: `${voice.desc || voice.voice_id} · Hero Voice`,
          previewUrl: voice.preview_url,
        }))
      : [];
    const elevenVoices: NarrationVoiceOption[] = elevenResponse.ok && Array.isArray(elevenData.voices)
      ? elevenData.voices.map((voice) => ({
          key: `elevenlabs:${voice.voice_id}`,
          provider: "elevenlabs",
          voiceId: voice.voice_id,
          label: `${voice.name || voice.voice_id} · ElevenLabs v3`,
          previewUrl: voice.preview_url,
        }))
      : [];
    const options = [...elevenVoices, ...heroVoices];
    if (options.length === 0) {
      throw new Error(apiMessage(
        (elevenResponse.ok ? heroData : elevenData) as ApiError,
        "ยังไม่มีเสียงบรรยายที่พร้อมใช้",
      ));
    }
    const accountDefault = elevenData.defaultVoiceId
      ? elevenVoices.find((voice) => voice.voiceId === elevenData.defaultVoiceId)
      : null;
    const preferred = accountDefault ?? options[0];
    setVoices(options);
    setNarrationProvider(preferred.provider);
    setNarrationVoiceId(preferred.voiceId);
  }, []);

  useEffect(() => {
    Promise.all([loadProjects(), loadCharacters(), loadVoices()])
      .catch((error) => toast.error(error instanceof Error ? error.message : "โหลดโปรเจกต์ไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, [loadCharacters, loadProjects, loadVoices]);

  useEffect(() => {
    if (!selectedId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("project", selectedId);
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  useEffect(() => {
    setStoryboardDocument(null);
    if (!storyboardUrl) return;
    let active = true;
    setStoryboardLoading(true);
    fetch(storyboardUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("โหลด storyboard ไม่สำเร็จ");
        return response.json() as Promise<StoryboardDocument>;
      })
      .then((document) => {
        if (!Array.isArray(document.scenes)) throw new Error("storyboard ไม่สมบูรณ์");
        if (active) setStoryboardDocument(document);
      })
      .catch((error) => {
        if (active) toast.error(error instanceof Error ? error.message : "โหลด storyboard ไม่สำเร็จ");
      })
      .finally(() => { if (active) setStoryboardLoading(false); });
    return () => { active = false; };
  }, [storyboardUrl]);

  useEffect(() => {
    const keys = selected
      ? [...new Set(reviewArtifacts(selected).flatMap((artifact) => artifact.sceneKey ? [artifact.sceneKey] : []))]
      : [];
    setRevisionSceneKey((current) => keys.includes(current) ? current : keys[0] ?? "");
  }, [selected]);

  useEffect(() => {
    if (selected?.stage !== "music" || !selected.awaitingApproval) {
      setSelectedMusicKey("");
      return;
    }
    const candidates = musicCandidates(selected);
    setSelectedMusicKey((current) => candidates.some((track) => `${track.source}:${track.trackId}` === current)
      ? current
      : candidates[0] ? `${candidates[0].source}:${candidates[0].trackId}` : "");
  }, [selected?.id, selected?.revision, selected?.stage, selected?.awaitingApproval]);

  const stageIndex = useMemo(
    () => selected?.stage === "completed"
      ? STAGES.length
      : selected ? STAGES.findIndex((stage) => stage.id === selected.stage) : -1,
    [selected],
  );

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || narrativeSource.trim().length < 10) return;
    if (presentationMode === "presenter_led" && !presenterFile) {
      toast.error("แบบมีพิธีกรต้องเลือกวิดีโอ lipsync ก่อนสร้างโปรเจกต์");
      return;
    }
    if (presentationMode === "faceless" && !narrationVoiceId) {
      toast.error("แบบ Faceless ต้องเลือกเสียงบรรยาย");
      return;
    }
    if (presentationMode === "faceless" && narrationProvider === "elevenlabs" && narrativeSource.trim().length > 5_000) {
      toast.error("ElevenLabs v3 รับสคริปต์ได้ไม่เกิน 5,000 ตัวอักษร");
      return;
    }
    setSaving(true);
    try {
      let presenterAssetId: string | null = null;
      if (presentationMode === "presenter_led" && presenterFile) {
        if (presenterFile.size > 500 * 1024 * 1024) throw new Error("วิดีโอใหญ่เกิน 500 MB");
        const metadata = await inspectVideo(presenterFile);
        if (metadata.durationMs > 180_000) throw new Error("วิดีโอยาวเกิน 3 นาที กรุณาตัดให้สั้นลงก่อน");
        if (Math.abs(metadata.width / metadata.height - 9 / 16) > 0.03) {
          throw new Error("วิดีโอต้องเป็นแนวตั้ง 9:16");
        }
        const form = new FormData();
        form.append("video", presenterFile);
        const upload = await fetch("/api/ai-studio/story-films/upload-presenter", { method: "POST", body: form });
        const uploaded = await upload.json() as {
          asset?: { id: string; url: string; durationMs: number };
          error?: string;
          message?: string;
        };
        if (!upload.ok || !uploaded.asset) {
          throw new Error(uploaded.message || uploaded.error || "อัปโหลดวิดีโอไม่สำเร็จ");
        }
        presenterAssetId = uploaded.asset.id;
      }

      const response = await fetch("/api/ai-studio/story-films", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          idempotencyKey: `studio:${crypto.randomUUID()}`,
          presentationMode,
          sourcePackage,
          narrativeSource,
          presenterAssetId,
          narrationProvider: presentationMode === "faceless" ? narrationProvider : null,
          narrationVoiceId: presentationMode === "faceless" ? narrationVoiceId : null,
          narrationVoiceSpeed: presentationMode === "faceless" ? narrationVoiceSpeed : null,
          characterProfileId: characterProfileId || null,
          characterLookBrief: characterProfileId ? characterLookBrief : null,
          aspectRatio: "9:16",
        }),
      });
      const data = await response.json() as { project?: StoryFilmProjectView } & ApiError;
      if (!response.ok || !data.project) throw new Error(apiMessage(data, "สร้างโปรเจกต์ไม่สำเร็จ"));
      await loadProjects(data.project.id);
      setCreating(false);
      setTitle("");
      setSourcePackage("");
      setNarrativeSource("");
      setPresenterFile(null);
      toast.success("สร้าง Hero Story Film Project แล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "สร้างโปรเจกต์ไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function saveCharacter() {
    if (!characterName.trim() || characterFiles.length === 0) return;
    if (characterFiles.length > 8) {
      toast.error("Reference Set หนึ่งชุดใส่ได้ไม่เกิน 8 ภาพ");
      return;
    }
    setCharacterSaving(true);
    try {
      const response = await fetch("/api/ai-studio/story-film-characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: characterName, identityNotes: characterIdentityNotes }),
      });
      const data = await response.json() as { character?: CharacterProfile } & ApiError;
      if (!response.ok || !data.character) throw new Error(apiMessage(data, "สร้าง Character Profile ไม่สำเร็จ"));
      for (let index = 0; index < characterFiles.length; index += 1) {
        const file = characterFiles[index];
        if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} ใหญ่เกิน 25 MB`);
        const form = new FormData();
        form.set("image", file);
        form.set("viewLabel", `reference ${index + 1}`);
        const upload = await fetch(`/api/ai-studio/story-film-characters/${encodeURIComponent(data.character.id)}/references`, {
          method: "POST",
          body: form,
        });
        const uploaded = await upload.json() as ApiError;
        if (!upload.ok) throw new Error(apiMessage(uploaded, `อัปโหลด ${file.name} ไม่สำเร็จ`));
      }
      await loadCharacters(data.character.id);
      setAddingCharacter(false);
      setCharacterFiles([]);
      setCharacterIdentityNotes("");
      toast.success("บันทึก Identity Reference Set แล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "บันทึก Character ไม่สำเร็จ");
      await loadCharacters().catch(() => {});
    } finally {
      setCharacterSaving(false);
    }
  }

  async function decide(decision: StoryFilmDecisionKind, instruction?: string, target?: Record<string, unknown>) {
    if (!selected) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/ai-studio/story-films/${encodeURIComponent(selected.id)}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedStage: selected.stage,
          expectedRevision: selected.revision,
          decision,
          instruction,
          target,
          idempotencyKey: `studio:${crypto.randomUUID()}`,
        }),
      });
      const data = await response.json() as { project?: StoryFilmProjectView } & ApiError;
      if (!response.ok || !data.project) {
        if (data.current) await loadProjects(data.current.id);
        throw new Error(apiMessage(data, "บันทึกการตัดสินใจไม่สำเร็จ"));
      }
      setProjects((current) => current
        .map((project) => project.id === data.project!.id ? data.project! : project)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setChangeBrief("");
      toast.success(decision === "approve" ? "อนุมัติขั้นนี้แล้ว" : decision === "render" ? "อนุมัติ Final Render แล้ว" : "บันทึกการตัดสินใจแล้ว");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto bg-[oklch(15%_0.018_300)] text-[oklch(96%_0.01_80)]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[oklch(74%_0.13_300)]" />
      <main className="mx-auto max-w-[1500px] px-4 pb-20 pt-5 md:px-7 md:pt-8">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-5">
          <div>
            <Link href="/ai-studio" className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm text-[oklch(76%_0.035_300)] transition-colors hover:text-[oklch(94%_0.02_300)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-400">
              <ArrowLeft className="h-4 w-4" /> กลับ AI Studio
            </Link>
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[oklch(78%_0.14_75)]" />
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[oklch(78%_0.04_75)]">Internal production board</p>
            </div>
            <h1 className="mt-3 text-[clamp(2.25rem,5vw,4.75rem)] font-bold leading-[0.95] tracking-[-0.045em]" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif" }}>
              Hero Story Film
            </h1>
            <p className="mt-4 max-w-[62ch] text-base leading-7 text-[oklch(76%_0.025_300)]">
              หนังสั้นแนวตั้งหนึ่งเรื่อง ตั้งแต่เสียงบรรยายถึงเรนเดอร์ โดยทุกขั้นรอการตัดสินใจจากมิว
            </p>
          </div>
          <button type="button" onClick={() => setCreating(true)} className="flex min-h-12 items-center gap-2 bg-[oklch(63%_0.2_300)] px-5 text-sm font-semibold text-[oklch(98%_0.01_300)] transition-[transform,background-color] duration-150 hover:-translate-y-0.5 hover:bg-[oklch(68%_0.19_300)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[oklch(82%_0.12_300)] active:translate-y-0 disabled:opacity-50">
            <Plus className="h-4 w-4" /> สร้างโปรเจกต์
          </button>
        </header>

        <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-t border-[oklch(31%_0.025_300)] pt-5 lg:border-r lg:border-t-0 lg:pr-6 lg:pt-0">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-semibold">โปรเจกต์</p>
              <button type="button" onClick={() => void loadProjects()} aria-label="รีเฟรชโปรเจกต์" className="flex h-11 w-11 items-center justify-center text-[oklch(70%_0.03_300)] hover:text-white focus-visible:outline-2 focus-visible:outline-violet-400"><RefreshCw className="h-4 w-4" /></button>
            </div>
            {loading ? (
              <div className="space-y-3" aria-label="กำลังโหลดโปรเจกต์"><div className="h-20 animate-pulse bg-[oklch(22%_0.02_300)]" /><div className="h-20 animate-pulse bg-[oklch(22%_0.02_300)]" /></div>
            ) : projects.length ? (
              <div className="space-y-px">
                {projects.map((project) => (
                  <button key={project.id} type="button" onClick={() => { setSelectedId(project.id); setCreating(false); }} className="group w-full min-h-[76px] border-b border-[oklch(28%_0.02_300)] px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-violet-400" style={{ background: selectedId === project.id ? "oklch(24% 0.04 300)" : "transparent" }}>
                    <span className="line-clamp-1 block text-sm font-semibold text-[oklch(94%_0.015_300)]">{project.title}</span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-xs text-[oklch(68%_0.025_300)]"><span>{project.stageLabel}</span><span>r{project.revision}</span></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-[oklch(38%_0.035_300)] p-5">
                <Film className="mb-3 h-5 w-5 text-[oklch(72%_0.13_300)]" />
                <p className="text-sm font-medium">ยังไม่มีหนังเรื่องแรก</p>
                <p className="mt-2 text-xs leading-5 text-[oklch(70%_0.025_300)]">สร้างโปรเจกต์เพื่อเริ่มล็อกเสียงและสตอรี่บอร์ด</p>
              </div>
            )}
          </aside>

          <section className="min-w-0">
            {creating || (!selected && !loading) ? (
              <form onSubmit={createProject} className="max-w-4xl">
                <div className="mb-8 flex items-end justify-between gap-4 border-b border-[oklch(31%_0.025_300)] pb-5">
                  <div><p className="text-xs uppercase tracking-[0.18em] text-[oklch(73%_0.11_75)]">New production</p><h2 className="mt-2 text-2xl font-semibold">ตั้งต้นเรื่อง</h2></div>
                  {selected && <button type="button" onClick={() => setCreating(false)} className="min-h-11 text-sm text-[oklch(72%_0.03_300)] hover:text-white">กลับโปรเจกต์เดิม</button>}
                </div>

                <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_240px]">
                  <div className="space-y-6">
                    <div><label htmlFor="story-title" className="mb-2 block text-sm font-semibold">ชื่อโปรเจกต์</label><input id="story-title" value={title} onChange={(event) => setTitle(event.target.value.slice(0, 120))} required className="min-h-12 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-4 text-base outline-none focus:border-[oklch(68%_0.16_300)] focus:ring-2 focus:ring-[oklch(68%_0.16_300/0.3)]" placeholder="เช่น วันที่ AI เริ่มทำงานแทนทั้งทีม" /></div>
                    <fieldset><legend className="mb-3 text-sm font-semibold">รูปแบบการเล่า</legend><div className="grid gap-3 sm:grid-cols-2">{([{"id":"presenter_led","title":"มีพิธีกร","body":"ใช้วิดีโอ lipsync ของมิวเป็น A-roll และเสียงหลัก"},{"id":"faceless","title":"Faceless","body":"เล่าด้วยเสียงและภาพเต็มจอ ไม่มี talking head"}] as const).map((item) => <label key={item.id} className="cursor-pointer border p-4" style={{ borderColor: presentationMode === item.id ? "oklch(68% 0.16 300)" : "oklch(35% 0.03 300)", background: presentationMode === item.id ? "oklch(23% 0.04 300)" : "transparent" }}><input type="radio" name="presentationMode" value={item.id} checked={presentationMode === item.id} onChange={() => setPresentationMode(item.id)} className="sr-only" /><span className="block text-sm font-semibold">{item.title}</span><span className="mt-2 block text-xs leading-5 text-[oklch(71%_0.025_300)]">{item.body}</span></label>)}</div></fieldset>
                    <div><label htmlFor="source-package" className="mb-2 block text-sm font-semibold">โฟลเดอร์ต้นทาง <span className="font-normal text-[oklch(65%_0.025_300)]">ไม่บังคับ</span></label><input id="source-package" value={sourcePackage} onChange={(event) => setSourcePackage(event.target.value.slice(0, 500))} className="min-h-12 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-4 text-base outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30" placeholder="content/2026-08-28-topic" /></div>
                    <div><div className="mb-2 flex items-center justify-between"><label htmlFor="narrative-source" className="text-sm font-semibold">Narrative Source</label><span className="text-xs text-[oklch(65%_0.025_300)]">{narrativeSource.length.toLocaleString("th-TH")}/12,000</span></div><textarea id="narrative-source" value={narrativeSource} onChange={(event) => setNarrativeSource(event.target.value.slice(0, 12_000))} required minLength={10} rows={12} className="w-full resize-y border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-4 py-3 text-base leading-7 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30" placeholder="วาง tts.md หรือสคริปต์ที่อนุมัติแล้ว" /></div>
                    {presentationMode === "presenter_led" && <div><label htmlFor="presenter-file" className="mb-2 block text-sm font-semibold">วิดีโอพิธีกร lipsync</label><label htmlFor="presenter-file" className="flex min-h-24 cursor-pointer items-center gap-4 border border-dashed border-[oklch(46%_0.05_300)] px-4 hover:border-violet-400"><span className="flex h-11 w-11 items-center justify-center bg-[oklch(25%_0.05_300)]"><Upload className="h-5 w-5 text-violet-300" /></span><span><span className="block text-sm font-medium">{presenterFile?.name ?? "เลือก mp4, mov หรือ webm"}</span><span className="mt-1 block text-xs text-[oklch(67%_0.025_300)]">9:16 · ไม่เกิน 3 นาที · สูงสุด 500 MB</span></span></label><input id="presenter-file" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={(event) => setPresenterFile(event.target.files?.[0] ?? null)} className="sr-only" /></div>}
                    {presentationMode === "faceless" && <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_150px]"><div><label htmlFor="narration-voice" className="mb-2 block text-sm font-semibold">เสียงสำหรับ Narration Master</label><select id="narration-voice" value={selectedNarrationVoice?.key ?? ""} onChange={(event) => { const next = voices.find((voice) => voice.key === event.target.value); if (next) { setNarrationProvider(next.provider); setNarrationVoiceId(next.voiceId); if (next.provider === "elevenlabs") setNarrationVoiceSpeed((speed) => Math.min(1.2, speed)); } }} required className="min-h-12 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-3 text-sm outline-none focus:border-violet-400"><option value="">เลือกเสียง</option>{voices.map((voice) => <option key={voice.key} value={voice.key}>{voice.label}</option>)}</select>{selectedNarrationVoice?.previewUrl && <audio controls preload="none" className="mt-3 h-9 w-full" src={selectedNarrationVoice.previewUrl} />}</div><div><label htmlFor="narration-speed" className="mb-2 block text-sm font-semibold">ความเร็ว {narrationVoiceSpeed.toFixed(1)}×</label><input id="narration-speed" type="range" min="0.7" max={narrationProvider === "elevenlabs" ? "1.2" : "1.3"} step="0.1" value={narrationVoiceSpeed} onChange={(event) => setNarrationVoiceSpeed(Number(event.target.value))} className="mt-3 w-full accent-violet-500" /></div></div>}
                    <div className="border-t border-[oklch(31%_0.025_300)] pt-6">
                      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold">ตัวละครที่ต้องรักษาหน้า <span className="font-normal text-[oklch(65%_0.025_300)]">ไม่บังคับ</span></p><p className="mt-1 text-xs leading-5 text-[oklch(67%_0.025_300)]">Identity Reference ใช้ซ้ำได้ ส่วนเสื้อผ้าและลุคกำหนดใหม่ในแต่ละคลิป</p></div><button type="button" onClick={() => setAddingCharacter((value) => !value)} className="min-h-11 border border-[oklch(40%_0.04_300)] px-3 text-xs hover:border-violet-400"><UserRound className="mr-1.5 inline h-3.5 w-3.5" />{addingCharacter ? "ปิด" : "เพิ่ม Character"}</button></div>
                      {addingCharacter && <div className="mt-4 space-y-4 border border-[oklch(34%_0.035_300)] bg-[oklch(17%_0.018_300)] p-4"><div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor="character-name" className="mb-1.5 block text-xs font-medium">ชื่อภายในระบบ</label><input id="character-name" value={characterName} onChange={(event) => setCharacterName(event.target.value.slice(0, 100))} className="min-h-11 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(20%_0.02_300)] px-3 text-sm outline-none focus:border-violet-400" /></div><div><label htmlFor="character-notes" className="mb-1.5 block text-xs font-medium">จุดที่ต้องคงเดิม</label><input id="character-notes" value={characterIdentityNotes} onChange={(event) => setCharacterIdentityNotes(event.target.value.slice(0, 1_000))} className="min-h-11 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(20%_0.02_300)] px-3 text-sm outline-none focus:border-violet-400" placeholder="เช่น รูปหน้า ทรงผม ไฝ" /></div></div><label htmlFor="character-files" className="flex min-h-20 cursor-pointer items-center gap-3 border border-dashed border-[oklch(43%_0.05_300)] px-4 hover:border-violet-400"><Images className="h-5 w-5 text-violet-300" /><span><span className="block text-sm">{characterFiles.length ? `${characterFiles.length} ภาพ` : "เลือกรูปหน้า/ครึ่งตัว/เต็มตัว 1–8 ภาพ"}</span><span className="mt-1 block text-xs text-[oklch(63%_0.025_300)]">ไม่ต้องเจน character sheet ใหม่ ถ้ามี ref หลายมุมที่ชัดอยู่แล้ว</span></span></label><input id="character-files" type="file" multiple accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={(event) => setCharacterFiles(Array.from(event.target.files ?? []).slice(0, 8))} className="sr-only" /><button type="button" disabled={characterSaving || !characterName.trim() || characterFiles.length === 0} onClick={() => void saveCharacter()} className="flex min-h-11 items-center justify-center gap-2 bg-[oklch(55%_0.14_300)] px-4 text-sm font-semibold disabled:opacity-40">{characterSaving && <Loader2 className="h-4 w-4 animate-spin" />}บันทึก Reference Set</button></div>}
                      <div className="mt-4"><label htmlFor="character-profile" className="mb-2 block text-xs font-medium">Character Profile ของคลิปนี้</label><select id="character-profile" value={characterProfileId} onChange={(event) => setCharacterProfileId(event.target.value)} className="min-h-12 w-full border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-3 text-sm outline-none focus:border-violet-400"><option value="">ไม่ใช้ตัวละครประจำ</option>{characters.map((character) => <option key={character.id} value={character.id} disabled={character.references.length === 0}>{character.name} · ref set v{character.activeReferenceSetVersion} · {character.references.length} ภาพ</option>)}</select></div>
                      {selectedCharacter && <div className="mt-4"><div className="mb-3 flex gap-2 overflow-x-auto pb-1">{selectedCharacter.references.map((reference) => <div key={reference.id} className="h-20 w-16 shrink-0 overflow-hidden border border-[oklch(38%_0.035_300)] bg-[oklch(22%_0.02_300)]"><img src={reference.url} alt={reference.viewLabel || reference.originalName} className="h-full w-full object-cover" /></div>)}</div><label htmlFor="character-look" className="mb-2 block text-xs font-medium">ลุคสำหรับคลิปนี้</label><textarea id="character-look" value={characterLookBrief} onChange={(event) => setCharacterLookBrief(event.target.value.slice(0, 1_000))} rows={3} className="w-full resize-y border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-3 py-2 text-sm leading-6 outline-none focus:border-violet-400" placeholder="เช่น แจ็กเก็ตหนังดำ เสื้อยืดขาว ทรงผมเดิม โทนหนังสืบสวน" /></div>}
                    </div>
                  </div>

                  <aside className="border-t border-[oklch(31%_0.025_300)] pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <div className="sticky top-5"><div className="mx-auto aspect-[9/16] w-28 border border-[oklch(48%_0.07_300)] bg-[oklch(21%_0.025_300)] p-2"><div className="flex h-full flex-col justify-between border border-dashed border-[oklch(38%_0.04_300)] p-2"><span className="text-[9px] uppercase tracking-widest text-[oklch(69%_0.12_75)]">9:16</span><Clapperboard className="mx-auto h-6 w-6 text-[oklch(62%_0.08_300)]" /><span className="text-center text-[9px] text-[oklch(62%_0.025_300)]">≤ 03:00</span></div></div><ul className="mt-6 space-y-3 text-xs leading-5 text-[oklch(72%_0.025_300)]"><li>หนึ่งโปรเจกต์ = หนึ่งคลิป</li><li>ยังไม่ใช้ Grok ในขั้นนี้</li><li>ทุก approval ผูก revision</li></ul><button type="submit" disabled={saving || !title.trim() || narrativeSource.trim().length < 10 || (presentationMode === "presenter_led" && !presenterFile) || (presentationMode === "faceless" && !narrationVoiceId)} className="mt-7 flex min-h-12 w-full items-center justify-center gap-2 bg-[oklch(63%_0.2_300)] px-4 text-sm font-semibold transition-colors hover:bg-[oklch(68%_0.19_300)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-300 disabled:cursor-not-allowed disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}สร้าง Story Film</button></div>
                  </aside>
                </div>
              </form>
            ) : selected ? (
              <div>
                <div className="mb-8 flex flex-wrap items-start justify-between gap-5 border-b border-[oklch(31%_0.025_300)] pb-6">
                  <div><div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[oklch(70%_0.09_75)]"><span>{selected.presentationModeLabel}</span><span>·</span><span>9:16</span><span>·</span><span>r{selected.revision}</span></div><h2 className="text-2xl font-semibold md:text-3xl">{selected.title}</h2><p className="mt-2 text-sm text-[oklch(69%_0.025_300)]">อัปเดต {formatDate(selected.updatedAt)}</p></div>
                  <span className="inline-flex min-h-10 items-center gap-2 border border-[oklch(42%_0.05_300)] px-3 text-xs font-medium"><span className="h-2 w-2 rounded-full" style={{ background: selected.awaitingApproval ? "oklch(78% 0.14 75)" : "oklch(65% 0.12 300)" }} />{statusCopy(selected)}</span>
                </div>

                <ol className="mb-10 grid grid-cols-4 gap-x-2 gap-y-4 md:grid-cols-8" aria-label="ขั้นตอน Hero Story Film">{STAGES.map((stage, index) => { const done = index < stageIndex; const active = index === stageIndex; return <li key={stage.id} className="relative"><div className="mb-2 h-1" style={{ background: done || active ? "oklch(65% 0.17 300)" : "oklch(29% 0.025 300)" }} /><div className="flex items-center gap-1.5 text-[11px]" style={{ color: active ? "oklch(94% 0.02 300)" : done ? "oklch(72% 0.09 300)" : "oklch(58% 0.02 300)" }}>{done ? <Check className="h-3 w-3" /> : <span className="tabular-nums">{index + 1}</span>}<span>{stage.short}</span></div></li>; })}</ol>

                <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
                  <article className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.18em] text-[oklch(70%_0.11_75)]">Current gate</p>
                    <h3 className="mt-2 text-2xl font-semibold">{selected.stageLabel}</h3>
                    {selected.stage === "completed" && selected.finalRenderUrl ? <CompletedFilm project={selected} /> : selected.stage === "setup" ? <dl className="mt-7 divide-y divide-[oklch(30%_0.025_300)] border-y border-[oklch(30%_0.025_300)] text-sm"><div className="grid gap-2 py-4 sm:grid-cols-[180px_1fr]"><dt className="text-[oklch(65%_0.025_300)]">รูปแบบ</dt><dd>{selected.presentationModeLabel}</dd></div><div className="grid gap-2 py-4 sm:grid-cols-[180px_1fr]"><dt className="text-[oklch(65%_0.025_300)]">ต้นทาง</dt><dd>{selected.sourcePackage || "วางสคริปต์โดยตรง"}</dd></div><div className="grid gap-2 py-4 sm:grid-cols-[180px_1fr]"><dt className="text-[oklch(65%_0.025_300)]">Narration Master</dt><dd>{selected.narrationMasterUrl ? `${Math.round((selected.narrationDurationMs ?? 0) / 100) / 10} วินาที` : selected.narrationVoiceId ? `${selected.narrationProvider === "elevenlabs" ? "ElevenLabs v3" : "Hero Voice"} · ${selected.narrationVoiceId}` : "จะสร้างเสียงในขั้นถัดไป"}</dd></div><div className="grid gap-2 py-4 sm:grid-cols-[180px_1fr]"><dt className="text-[oklch(65%_0.025_300)]">Character</dt><dd>{selected.characterProfileId ? `Reference Set v${selected.characterReferenceSetVersion}` : "ไม่ใช้ตัวละครประจำ"}</dd></div></dl> : selected.stage === "narration" ? <div className="mt-7 whitespace-pre-wrap border-y border-[oklch(30%_0.025_300)] py-6 text-base leading-8 text-[oklch(86%_0.02_300)]">{selected.narrativeSource}</div> : selected.stage === "storyboard" && selected.awaitingApproval ? storyboardLoading ? <div className="mt-7 flex min-h-40 items-center justify-center border-y border-[oklch(30%_0.025_300)]"><Loader2 className="h-5 w-5 text-violet-300" /></div> : storyboardDocument ? <StoryboardReview document={storyboardDocument} /> : <div className="mt-7 border border-dashed border-amber-500/40 p-6 text-sm text-amber-100">ยังเปิดไฟล์ storyboard ไม่ได้ กดรีเฟรชโปรเจกต์แล้วลองอีกครั้ง</div> : selected.awaitingApproval && ["character_look", "keyframes", "videos", "final_render"].includes(selected.stage) ? <ArtifactReview project={selected} /> : selected.stage === "music" && selected.awaitingApproval && availableMusic.length > 0 ? <MusicReview candidates={availableMusic} selectedKey={selectedMusicKey} onSelect={setSelectedMusicKey} /> : !selected.awaitingApproval ? <div className="mt-7 border border-dashed border-[oklch(42%_0.05_300)] p-7"><Loader2 className="mb-4 h-5 w-5 text-violet-300" /><p className="font-medium">Control Plane พร้อมแล้ว</p><p className="mt-2 max-w-[60ch] text-sm leading-6 text-[oklch(69%_0.025_300)]">ขั้น {selected.stageLabel} กำลังรอ Generation Adapter ส่งงานฉบับตรวจเข้ามา ระบบจะยังไม่ให้ approve จนมี artifact จริง</p></div> : <pre className="mt-7 overflow-auto border-y border-[oklch(30%_0.025_300)] py-6 text-sm leading-6 text-[oklch(80%_0.025_300)]">{JSON.stringify(selected.stageData, null, 2)}</pre>}
                  </article>

                  <aside className="border-t border-[oklch(31%_0.025_300)] pt-6 xl:border-l xl:border-t-0 xl:pl-7 xl:pt-0">
                    <p className="text-sm font-semibold">การตัดสินใจ</p>
                    <p className="mt-2 text-xs leading-5 text-[oklch(66%_0.025_300)]">ทุกคำสั่งจะผูกกับ {selected.stageLabel} revision {selected.revision} เท่านั้น</p>
                    {selected.status === "completed" ? (
                      <div className="mt-6 border border-[oklch(42%_0.08_145)] bg-[oklch(20%_0.035_145)] p-4 text-sm leading-6 text-[oklch(83%_0.07_145)]">
                        อนุมัติ Master แล้ว ดาวน์โหลดไฟล์จากแผงด้านซ้ายได้เลย
                      </div>
                    ) : selected.awaitingApproval ? (
                      <div className="mt-6 space-y-5">
                        <button
                          type="button"
                          disabled={saving || (selected.stage === "music" && !selectedMusicKey)}
                          onClick={() => {
                            const chosenMusic = selected.stage === "music"
                              ? availableMusic.find((track) => `${track.source}:${track.trackId}` === selectedMusicKey)
                              : null;
                            void decide(
                              selected.stage === "final_render" ? "render" : "approve",
                              undefined,
                              chosenMusic ? { musicSource: chosenMusic.source, musicTrackId: chosenMusic.trackId } : undefined,
                            );
                          }}
                          className="flex min-h-12 w-full items-center justify-center gap-2 bg-[oklch(63%_0.2_300)] px-4 text-sm font-semibold hover:bg-[oklch(68%_0.19_300)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-violet-300 disabled:opacity-40"
                        >
                          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          {selected.stage === "final_render" ? "อนุมัติ Final Render" : `อนุมัติ ${selected.stageLabel}`}
                        </button>
                        {["storyboard", "keyframes", "videos"].includes(selected.stage)
                          || (selected.stage === "character_look" && selected.characterProfileId) ? (
                            <div>
                              <RevisionTargetSelect
                                stage={selected.stage}
                                sceneKeys={revisionSceneKeys}
                                value={revisionSceneKey}
                                onChange={setRevisionSceneKey}
                              />
                              <label htmlFor="change-brief" className="mb-2 block text-xs font-medium">หรือระบุสิ่งที่ต้องแก้</label>
                              <textarea
                                id="change-brief"
                                value={changeBrief}
                                onChange={(event) => setChangeBrief(event.target.value.slice(0, 2_000))}
                                rows={4}
                                className="w-full resize-y border border-[oklch(38%_0.035_300)] bg-[oklch(19%_0.02_300)] px-3 py-2 text-sm leading-6 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30"
                                placeholder="เช่น เปลี่ยนเสื้อเป็นแจ็กเก็ตดำ แต่คงหน้าตาและ continuity เดิม"
                              />
                              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                <button
                                  type="button"
                                  disabled={saving || !changeBrief.trim() || (["keyframes", "videos"].includes(selected.stage) && !revisionSceneKey)}
                                  onClick={() => void decide(
                                    "revise",
                                    changeBrief,
                                    revisionSceneKey ? { sceneKey: revisionSceneKey } : undefined,
                                  )}
                                  className="min-h-11 border border-[oklch(42%_0.05_300)] px-3 text-sm hover:bg-[oklch(23%_0.03_300)] focus-visible:outline-2 focus-visible:outline-violet-300 disabled:opacity-40"
                                >แก้ตามคำสั่ง</button>
                                <button
                                  type="button"
                                  disabled={saving || !changeBrief.trim() || (["keyframes", "videos"].includes(selected.stage) && !revisionSceneKey)}
                                  onClick={() => void decide(
                                    "reroll",
                                    changeBrief,
                                    revisionSceneKey ? { sceneKey: revisionSceneKey } : undefined,
                                  )}
                                  className="min-h-11 border border-[oklch(42%_0.05_300)] px-3 text-sm hover:bg-[oklch(23%_0.03_300)] focus-visible:outline-2 focus-visible:outline-violet-300 disabled:opacity-40"
                                >สร้างทางเลือกใหม่</button>
                              </div>
                            </div>
                          ) : null}
                      </div>
                    ) : <div className="mt-6 flex items-start gap-3 border border-[oklch(35%_0.035_300)] p-4"><Video className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" /><p className="text-xs leading-5 text-[oklch(70%_0.025_300)]">ยังไม่มีงานให้ตัดสินใจ ระบบจะเปิดปุ่มเมื่อ revision ฉบับตรวจมาถึง</p></div>}
                    <div className="mt-7 border-t border-[oklch(31%_0.025_300)] pt-5">{selected.status === "paused" ? <button type="button" disabled={saving} onClick={() => void decide("resume")} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm text-[oklch(79%_0.08_75)] hover:bg-[oklch(22%_0.025_300)]"><CirclePlay className="h-4 w-4" />ทำงานต่อ</button> : !["completed", "rendering"].includes(selected.status) ? <button type="button" disabled={saving} onClick={() => void decide("pause")} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm text-[oklch(67%_0.025_300)] hover:bg-[oklch(22%_0.025_300)]"><CirclePause className="h-4 w-4" />พักโปรเจกต์</button> : null}</div>
                  </aside>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}
