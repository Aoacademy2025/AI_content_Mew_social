"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe } from "@/lib/use-me";
import { DEFAULT_AUTO_MIX_PROVIDERS, type AutoMixImageProvider, type KieImageModel } from "../_components/types";
import { PRESET_PROVIDERS, presetBrollSource, type MixPreset } from "./mix-presets";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import type { ProjectMediaState } from "@/lib/media-retention";
import {
  logoOverlayForNewProject,
  normalizeLogoOverlayConfig,
  type LogoOverlayConfig,
} from "@/lib/logo-overlay";

const DRAFT_KEY = "editor-v2-project";
const PROJECT_ID_KEY = "editor-v2-project-id";

interface V2Draft {
  projectTitle?: string;
  mode?: V2Mode; script?: string; clipUrl?: string; clipDurationSec?: number; brollSource?: V2BrollSource;
  voiceEngine?: V2VoiceEngine; geminiVoiceName?: string; voiceId?: string;
  musicTrack?: string | null; musicTrackKind?: "system" | "user"; bgmVolume?: number; useAvatar?: boolean; avatarId?: string;
  targetClipCount?: number; avatarMode?: V2AvatarMode; avatarIntroSecs?: number; avatarTailSecs?: number;
  kieModel?: string; autoMixProviders?: AutoMixImageProvider[]; mixPreset?: MixPreset;
  brollRegionPreference?: BrollRegionPreference; brollVisualStyle?: BrollVisualStyle;
  logoOverlay?: LogoOverlayConfig;
}

type ProjectStatus = "draft" | "rendering" | "post" | "exporting" | "exported" | "archived";

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

function loadDraft(): V2Draft {
  try {
    const storage = browserStorage();
    const raw = storage?.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as V2Draft) : {};
  } catch { return {}; }
}

async function loadAccountLogoDefault(): Promise<LogoOverlayConfig | null> {
  try {
    const res = await fetch("/api/user/brand-assets", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeLogoOverlayConfig(data?.defaultLogo?.config);
  } catch {
    return null;
  }
}

/**
 * Editor v2 project state (เฟสตั้งค่า สเต็ป 1–2) — ตาม state model ในแผน:
 * project: { script, mode, brollSource, voiceEngine, voiceId, musicTrack, avatarId|null }
 *
 * P3 = state + read-only wiring (โหลดค่า default จริงจาก /api/user/video-settings,
 * โควตาจาก /api/videos/usage, ข้อมูลอวตารจาก /api/heygen/avatar-info).
 * การเรนเดอร์จริง + persist draft มาใน P4 (VideoJob preview mode).
 */

export type V2Mode = "script" | "upload";
export type V2BrollSource = "automix" | "stock" | "kie-image" | "kie-video";
export type V2VoiceEngine = "gemini" | "elevenlabs";
export type V2AvatarMode = "bookend" | "bookend-both" | "full";

export interface V2Usage {
  plan?: string;
  minutes?: { used: number; limit: number; remaining: number };
}

export interface V2AvatarInfo {
  name?: string;
  previewUrl?: string;
}

export interface V2ElevenVoice {
  voice_id: string;
  name: string;
  category?: string;
}

const DEFAULT_PROJECT = {
  projectTitle: "New Project",
  mode: "script" as V2Mode,
  script: "",
  clipUrl: "",
  clipDurationSec: 0,
  voiceEngine: "gemini" as V2VoiceEngine,
  geminiVoiceName: "Aoede",
  voiceId: "",
  musicTrack: "" as string | null,
  musicTrackKind: "system" as const,
  bgmVolume: 0.12,
  useAvatar: false,
  avatarId: "",
  targetClipCount: 0,
  avatarMode: "bookend" as V2AvatarMode,
  avatarIntroSecs: 5,
  avatarTailSecs: 5,
  kieModel: "" as KieImageModel | "",
  autoMixProviders: DEFAULT_AUTO_MIX_PROVIDERS,
  mixPreset: "free" as MixPreset,
  brollRegionPreference: "auto" as BrollRegionPreference,
  brollVisualStyle: "auto" as BrollVisualStyle,
};

export function useV2Project() {
  // Keep the first client render byte-compatible with SSR. Local/server drafts are
  // applied after mount in ensureServerProject(); reading localStorage here causes
  // hydration text mismatches when a previous draft exists.
  const draftRef = useRef<V2Draft>({});
  const d = draftRef.current;
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectReady, setProjectReady] = useState(false);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>("draft");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeExportJobId, setActiveExportJobId] = useState<string | null>(null);
  const [latestVideoId, setLatestVideoId] = useState<string | null>(null);
  const [previewMediaState, setPreviewMediaState] = useState<ProjectMediaState | null>(null);

  // ── Step 1 ──
  const [projectTitle, setProjectTitle] = useState(d.projectTitle ?? DEFAULT_PROJECT.projectTitle);
  const [mode, setMode] = useState<V2Mode>(d.mode ?? "script");
  const [script, setScript] = useState(d.script ?? "");
  /** URL คลิปที่อัปโหลด (โหมดใช้คลิปที่ถ่ายเอง) */
  const [clipUrlState, setClipUrlState] = useState(d.clipUrl ?? "");
  const [clipDurationSecState, setClipDurationSecState] = useState(
    typeof d.clipDurationSec === "number" && Number.isFinite(d.clipDurationSec) && d.clipDurationSec > 0
      ? d.clipDurationSec
      : 0,
  );
  const setClipDurationSec = useCallback((sec: number) => {
    setClipDurationSecState(Number.isFinite(sec) && sec > 0 ? sec : 0);
  }, []);
  const setClipUrl = useCallback((url: string) => {
    setClipUrlState(url);
    if (!url) setClipDurationSecState(0);
  }, []);
  const clipUrl = clipUrlState;
  const clipDurationSec = clipDurationSecState;

  // ── Step 2 ──
  // default = วิดีโอสต็อก (ฟรี) — AutoMix/ภาพ AI ยัง Beta (admin เท่านั้น), วิดีโอ AI ยังไม่เปิด
  const [brollSource, setBrollSource] = useState<V2BrollSource>(d.brollSource ?? "stock");
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaidManagedKie, setIsPaidManagedKie] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  /** Task 7 badge: server launch-state signal (MANAGED_KIE && CREDITS_LIVE), independent
   *  of plan — lets locked AI-image UI show "เร็ว ๆ นี้" (not launched) instead of the
   *  "อัปเกรดเพื่อใช้ภาพ AI" upsell when the feature simply isn't live yet. */
  const [managedKieOn, setManagedKieOn] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState<V2VoiceEngine>(d.voiceEngine ?? "gemini");
  const [geminiVoiceName, setGeminiVoiceName] = useState(d.geminiVoiceName ?? "Aoede");
  const [voiceId, setVoiceId] = useState(d.voiceId ?? "");
  /** filename ของ system track ที่เลือก · "" = ยังไม่เลือก · null = ไม่ใส่เพลง */
  const [musicTrack, setMusicTrack] = useState<string | null>(d.musicTrack === undefined ? "" : d.musicTrack);
  /** เพลงที่เลือกเป็นของระบบหรือของผู้ใช้ — ใช้เลือก path bgmFile ตอน submit */
  const [musicTrackKind, setMusicTrackKind] = useState<"system" | "user">(d.musicTrackKind ?? "system");
  /** ระดับเสียงเพลง 0–1 · default 0.12 (ตรงกับ pipeline + editor v1) — ใต้เสียงพูด */
  const [bgmVolume, setBgmVolume] = useState(d.bgmVolume ?? 0.12);
  const [useAvatar, setUseAvatar] = useState(d.useAvatar ?? false);
  const [avatarId, setAvatarId] = useState(d.avatarId ?? "");

  // ── ขั้นสูง (P6c) ──
  const [targetClipCount, setTargetClipCount] = useState(d.targetClipCount ?? 0); // 0 = auto
  const [avatarMode, setAvatarMode] = useState<V2AvatarMode>(d.avatarMode ?? "bookend");
  const [avatarIntroSecs, setAvatarIntroSecs] = useState(d.avatarIntroSecs ?? 5);
  const [avatarTailSecs, setAvatarTailSecs] = useState(d.avatarTailSecs ?? 5);
  const [kieModel, setKieModel] = useState<KieImageModel | "">((d.kieModel as KieImageModel | undefined) ?? "");
  const [autoMixProviders, setAutoMixProviders] = useState<AutoMixImageProvider[]>(d.autoMixProviders ?? DEFAULT_AUTO_MIX_PROVIDERS);
  const [brollRegionPreference, setBrollRegionPreference] = useState<BrollRegionPreference>(d.brollRegionPreference ?? "auto");
  const [brollVisualStyle, setBrollVisualStyle] = useState<BrollVisualStyle>(d.brollVisualStyle ?? "auto");
  const [logoOverlay, setLogoOverlay] = useState<LogoOverlayConfig | undefined>(d.logoOverlay);
  // ── Mix preset (D5.1) — non-admin b-roll AI mix. FREE users are forced to "free";
  // paid (isPaidManagedKie) default to "recommended" (applied in the fetchMe effect
  // once plan is known). Draft value wins if the user already chose one. ──
  const [mixPreset, setMixPresetState] = useState<MixPreset>(d.mixPreset ?? "free");
  /** เลือก preset → ขับ mixPreset + brollSource + autoMixProviders ให้สอดคล้องกัน
   *  (preset ≠ ฟรีล้วน ⇒ automix + provider set รวม kie-ai). weights ที่ส่งไป server
   *  มาจาก PRESET_WEIGHTS ใน useV2Job. */
  const setMixPreset = useCallback((preset: MixPreset) => {
    setMixPresetState(preset);
    setBrollSource(presetBrollSource(preset));
    const provs = PRESET_PROVIDERS[preset];
    if (provs) setAutoMixProviders(provs);
  }, []);

  function buildDraft(): V2Draft {
    return {
      mode, script, clipUrl, clipDurationSec, brollSource, voiceEngine, geminiVoiceName, voiceId,
      projectTitle,
      musicTrack, musicTrackKind, bgmVolume, useAvatar, avatarId,
      targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs,
      kieModel, autoMixProviders, mixPreset, brollRegionPreference, brollVisualStyle, logoOverlay,
    };
  }

  function applyDraft(next: V2Draft) {
    draftRef.current = next;
    if (next.projectTitle !== undefined) setProjectTitle(next.projectTitle || DEFAULT_PROJECT.projectTitle);
    if (next.mode) setMode(next.mode);
    if (next.script !== undefined) setScript(next.script);
    if (next.clipUrl !== undefined) setClipUrl(next.clipUrl);
    if (next.clipDurationSec !== undefined) setClipDurationSec(next.clipDurationSec);
    if (next.brollSource) setBrollSource(next.brollSource);
    if (next.voiceEngine) setVoiceEngine(next.voiceEngine);
    if (next.geminiVoiceName !== undefined) setGeminiVoiceName(next.geminiVoiceName);
    if (next.voiceId !== undefined) setVoiceId(next.voiceId);
    if (next.musicTrack !== undefined) setMusicTrack(next.musicTrack);
    if (next.musicTrackKind) setMusicTrackKind(next.musicTrackKind);
    if (next.bgmVolume !== undefined) setBgmVolume(next.bgmVolume);
    if (next.useAvatar !== undefined) setUseAvatar(next.useAvatar);
    if (next.avatarId !== undefined) setAvatarId(next.avatarId);
    if (next.targetClipCount !== undefined) setTargetClipCount(next.targetClipCount);
    if (next.avatarMode) setAvatarMode(next.avatarMode);
    if (next.avatarIntroSecs !== undefined) setAvatarIntroSecs(next.avatarIntroSecs);
    if (next.avatarTailSecs !== undefined) setAvatarTailSecs(next.avatarTailSecs);
    if (next.kieModel !== undefined) setKieModel(next.kieModel as KieImageModel | "");
    if (next.autoMixProviders) setAutoMixProviders(next.autoMixProviders);
    if (next.mixPreset) setMixPresetState(next.mixPreset);
    if (next.brollRegionPreference) setBrollRegionPreference(next.brollRegionPreference);
    if (next.brollVisualStyle) setBrollVisualStyle(next.brollVisualStyle);
    setLogoOverlay(normalizeLogoOverlayConfig(next.logoOverlay) ?? undefined);
  }

  // ── Autosave status (topbar hint) — observes the debounced persist effect below;
  //    "idle" until the first user-driven change, then "saving" → "saved". ──
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveRevision, setSaveRevision] = useState(0);
  const retryProjectSave = useCallback(() => setSaveRevision((revision) => revision + 1), []);
  const firstPersistRun = useRef(true);

  // ── Read-only wiring ──
  const [usage, setUsage] = useState<V2Usage | null>(null);
  const [avatarInfo, setAvatarInfo] = useState<V2AvatarInfo | null>(null);
  /** รายชื่อเสียง ElevenLabs ของผู้ใช้ (แสดงชื่อแทน Voice ID) · null = ยังไม่โหลด/โหลดไม่ได้ */
  const [elevenVoices, setElevenVoices] = useState<V2ElevenVoice[] | null>(null);
  const canUploadOwnMedia = plan === "PRO" || plan === "BUSINESS";
  const logoEligible = plan === "PRO" || plan === "BUSINESS";

  const createServerProject = useCallback(async (draft: V2Draft) => {
    try {
      const res = await fetch("/api/editor-projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.projectTitle ?? DEFAULT_PROJECT.projectTitle, draft }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const id = typeof data?.project?.id === "string" ? data.project.id : null;
      if (id) {
        setProjectId(id);
        setProjectReady(true);
        if (typeof data?.project?.status === "string") setProjectStatus(data.project.status as ProjectStatus);
        setActiveJobId(typeof data?.project?.activeJobId === "string" ? data.project.activeJobId : null);
        setActiveExportJobId(typeof data?.project?.activeExportJobId === "string" ? data.project.activeExportJobId : null);
        setLatestVideoId(typeof data?.project?.latestVideoId === "string" ? data.project.latestVideoId : null);
        setPreviewMediaState((data?.project?.previewMediaState as ProjectMediaState | null | undefined) ?? null);
        try { browserStorage()?.setItem(PROJECT_ID_KEY, id); } catch {}
      }
      return id;
    } catch {
      return null;
    }
  }, []);

  const resetProject = useCallback(async () => {
    const accountDefault = await loadAccountLogoDefault();
    const inherited = logoOverlayForNewProject({
      hasExistingDraft: false,
      accountDefault,
    });
    const nextDraft: V2Draft = {
      ...DEFAULT_PROJECT,
      autoMixProviders: [...DEFAULT_PROJECT.autoMixProviders],
      mixPreset: isPaidManagedKie ? "recommended" : DEFAULT_PROJECT.mixPreset,
      ...(inherited ? { logoOverlay: inherited } : {}),
    };
    draftRef.current = nextDraft;
    setProjectId(null);
    setProjectReady(false);
    setProjectStatus("draft");
    setActiveJobId(null);
    setActiveExportJobId(null);
    setLatestVideoId(null);
    setPreviewMediaState(null);
    try {
      const storage = browserStorage();
      storage?.removeItem(DRAFT_KEY);
      storage?.removeItem(PROJECT_ID_KEY);
    } catch {}

    setMode(DEFAULT_PROJECT.mode);
    setProjectTitle(DEFAULT_PROJECT.projectTitle);
    setScript(DEFAULT_PROJECT.script);
    setClipUrl(DEFAULT_PROJECT.clipUrl);
    setClipDurationSec(DEFAULT_PROJECT.clipDurationSec);
    setVoiceEngine(DEFAULT_PROJECT.voiceEngine);
    setGeminiVoiceName(DEFAULT_PROJECT.geminiVoiceName);
    setVoiceId(DEFAULT_PROJECT.voiceId);
    setMusicTrack(DEFAULT_PROJECT.musicTrack);
    setMusicTrackKind(DEFAULT_PROJECT.musicTrackKind);
    setBgmVolume(DEFAULT_PROJECT.bgmVolume);
    setUseAvatar(DEFAULT_PROJECT.useAvatar);
    setAvatarId(DEFAULT_PROJECT.avatarId);
    setAvatarInfo(null);
    setTargetClipCount(DEFAULT_PROJECT.targetClipCount);
    setAvatarMode(DEFAULT_PROJECT.avatarMode);
    setAvatarIntroSecs(DEFAULT_PROJECT.avatarIntroSecs);
    setAvatarTailSecs(DEFAULT_PROJECT.avatarTailSecs);
    setKieModel(DEFAULT_PROJECT.kieModel);
    setAutoMixProviders([...DEFAULT_PROJECT.autoMixProviders]);
    setBrollRegionPreference(DEFAULT_PROJECT.brollRegionPreference);
    setBrollVisualStyle(DEFAULT_PROJECT.brollVisualStyle);
    setMixPreset(isPaidManagedKie ? "recommended" : DEFAULT_PROJECT.mixPreset);
    setLogoOverlay(inherited);
    setSaveStatus("idle");
    await createServerProject(nextDraft);
  }, [createServerProject, isPaidManagedKie, setMixPreset]);

  useEffect(() => {
    let alive = true;
    async function ensureServerProject() {
      const storage = browserStorage();
      const localDraft = loadDraft();
      const urlProjectId = new URLSearchParams(window.location.search).get("projectId");
      const storedProjectId = storage?.getItem(PROJECT_ID_KEY) ?? null;
      const existingProjectId = urlProjectId || storedProjectId;

      if (existingProjectId) {
        try {
          const res = await fetch(`/api/editor-projects/${encodeURIComponent(existingProjectId)}`, { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            const project = data?.project;
            if (!alive || typeof project?.id !== "string") return;
            setProjectId(project.id);
            setProjectReady(true);
            setProjectStatus(typeof project.status === "string" ? project.status as ProjectStatus : "draft");
            setActiveJobId(typeof project.activeJobId === "string" ? project.activeJobId : null);
            setActiveExportJobId(typeof project.activeExportJobId === "string" ? project.activeExportJobId : null);
            setLatestVideoId(typeof project.latestVideoId === "string" ? project.latestVideoId : null);
            setPreviewMediaState((project.previewMediaState as ProjectMediaState | null | undefined) ?? null);
            storage?.setItem(PROJECT_ID_KEY, project.id);
            if (project.draft && typeof project.draft === "object") {
              applyDraft(project.draft as V2Draft);
            } else if (typeof project.title === "string") {
              setProjectTitle(project.title);
            }
            return;
          }
        } catch {
          // Fall back to local draft + create a fresh server project below.
        }
      }

      const hasLocalDraft = Object.keys(localDraft).length > 0;
      const seedDraft = hasLocalDraft ? localDraft : buildDraft();
      if (!hasLocalDraft) {
        const accountDefault = await loadAccountLogoDefault();
        const inherited = logoOverlayForNewProject({ hasExistingDraft: false, accountDefault });
        if (inherited) seedDraft.logoOverlay = inherited;
      }
      applyDraft(seedDraft);
      const id = await createServerProject(seedDraft);
      if (!alive || !id) return;
      storage?.setItem(PROJECT_ID_KEY, id);
    }
    void ensureServerProject();
    return () => { alive = false; };
    // Server project bootstrap should run once. Subsequent field autosaves are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createServerProject]);

  // ค่า default จริงของผู้ใช้ (เหมือน init ของ legacy editor) — ไม่ทับค่าที่ draft จำไว้
  useEffect(() => {
    const hadDraft = Object.keys(draftRef.current).length > 0;
    fetch("/api/user/video-settings").then(r => r.json()).then(s => {
      if (!hadDraft) {
        if (s.heygenAvatarId) setAvatarId(s.heygenAvatarId);
        if (s.elevenlabsVoiceId) setVoiceId(s.elevenlabsVoiceId);
        if (s.ttsProvider === "gemini" || s.ttsProvider === "elevenlabs") setVoiceEngine(s.ttsProvider);
        if (s.geminiVoiceName) setGeminiVoiceName(s.geminiVoiceName);
      } else {
        // เติมเฉพาะช่องที่ draft ไม่มีค่า
        if (s.heygenAvatarId && !draftRef.current.avatarId) setAvatarId(s.heygenAvatarId);
        if (s.elevenlabsVoiceId && !draftRef.current.voiceId) setVoiceId(s.elevenlabsVoiceId);
      }
    }).catch(() => {});
    fetch("/api/videos/usage").then(r => (r.ok ? r.json() : null)).then(u => {
      if (u) setUsage(u);
    }).catch(() => {});
    fetchMe().then(m => {
      const admin = m?.role === "ADMIN";
      setPlan(typeof m?.plan === "string" ? m.plan : "FREE");
      // Managed-kie: paid (PRO/BUSINESS) users un-gated for AI image sources when
      // the flags are on. Server (fetch-stock) is authoritative; this is UX only.
      const paid = !!m?.kiePaidUnlocked;
      setIsAdmin(admin);
      setIsPaidManagedKie(paid);
      setManagedKieOn(!!m?.managedKieOn);
      // Preset default/enforcement (non-admins only — admins use the raw controls):
      //   FREE / feature-off → forced "ฟรีล้วน" (the AI presets are disabled in the UI);
      //   paid → default "ผสม AI แนะนำ" unless the user already picked a preset (draft).
      // setMixPreset also re-drives brollSource/autoMixProviders so submit stays consistent.
      if (!admin) {
        if (!paid) setMixPreset("free");
        else if (!draftRef.current.mixPreset) setMixPreset("recommended");
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist draft (debounce 1s) — จำการตั้งค่าโปรเจกต์ข้ามเซสชัน.
  // saveStatus only OBSERVES this effect: the write itself is unchanged. The initial
  // mount run (restoring the draft) is skipped for the status so the topbar shows a
  // calm "บันทึกอัตโนมัติ" hint until the user's first real edit.
  useEffect(() => {
    const isFirst = firstPersistRun.current;
    firstPersistRun.current = false;
    if (!isFirst) setSaveStatus("saving");
    let active = true;
    const t = setTimeout(() => {
      const draft = buildDraft();
      try {
        browserStorage()?.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch { /* quota/private mode */ }
      if (projectReady && projectId) {
        fetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: draft.projectTitle, draft, touchLastOpened: true }),
        })
          .then((res) => {
            if (!isFirst && active) setSaveStatus(res.ok ? "saved" : "error");
          })
          .catch(() => { if (!isFirst && active) setSaveStatus("error"); });
      } else if (!isFirst) {
        setSaveStatus("saved");
      }
    }, 1000);
    return () => { active = false; clearTimeout(t); };
  }, [mode, projectTitle, script, clipUrl, clipDurationSec, brollSource, voiceEngine, geminiVoiceName, voiceId, musicTrack, musicTrackKind, bgmVolume, useAvatar, avatarId,
      targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs, kieModel, autoMixProviders, mixPreset, brollRegionPreference, brollVisualStyle, logoOverlay, projectId, projectReady, saveRevision]);

  // ข้อมูลอวตาร (ชื่อ + thumbnail) เมื่อมี avatarId — debounce กันยิง HeyGen ทุก keystroke
  useEffect(() => {
    if (!avatarId.trim()) { setAvatarInfo(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      fetch(`/api/heygen/avatar-info?avatarId=${encodeURIComponent(avatarId.trim())}`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (alive && d) setAvatarInfo({ name: d.name, previewUrl: d.previewImageUrl || d.previewUrl }); })
        .catch(() => { if (alive) setAvatarInfo(null); });
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [avatarId]);

  // รายชื่อเสียง ElevenLabs — โหลดครั้งเดียวเมื่อผู้ใช้เลือก engine นี้ (fail เงียบ = ใช้ช่อง ID เดิม)
  useEffect(() => {
    if (voiceEngine !== "elevenlabs" || elevenVoices !== null) return;
    let alive = true;
    fetch("/api/elevenlabs/voices")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && Array.isArray(d?.voices)) setElevenVoices(d.voices); })
      .catch(() => {});
    return () => { alive = false; };
  }, [voiceEngine, elevenVoices]);

  return {
    projectTitle, setProjectTitle,
    mode, setMode,
    script, setScript,
    clipUrl, setClipUrl, clipDurationSec, setClipDurationSec,
    brollSource, setBrollSource,
    voiceEngine, setVoiceEngine,
    geminiVoiceName, setGeminiVoiceName,
    voiceId, setVoiceId,
    musicTrack, setMusicTrack,
    musicTrackKind, setMusicTrackKind,
    bgmVolume, setBgmVolume,
    useAvatar, setUseAvatar,
    avatarId, setAvatarId,
    targetClipCount, setTargetClipCount,
    avatarMode, setAvatarMode,
    avatarIntroSecs, setAvatarIntroSecs,
    avatarTailSecs, setAvatarTailSecs,
    kieModel, setKieModel,
    autoMixProviders, setAutoMixProviders,
    brollRegionPreference, setBrollRegionPreference,
    brollVisualStyle, setBrollVisualStyle,
    logoOverlay, setLogoOverlay,
    mixPreset, setMixPreset,
    usage, avatarInfo, elevenVoices, isAdmin, isPaidManagedKie, managedKieOn,
    plan, canUploadOwnMedia, canUseLogoOverlay: logoEligible, projectId, projectReady, projectStatus, activeJobId, activeExportJobId, latestVideoId, previewMediaState, resetProject,
    saveStatus, retryProjectSave,
  };
}

export type V2Project = ReturnType<typeof useV2Project>;
