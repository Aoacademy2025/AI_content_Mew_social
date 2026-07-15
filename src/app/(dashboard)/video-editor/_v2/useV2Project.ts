"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fetchMe } from "@/lib/use-me";
import { DEFAULT_AUTO_MIX_PROVIDERS, type AutoMixImageProvider, type KieImageModel } from "../_components/types";
import { PRESET_PROVIDERS, presetBrollSource, type MixPreset } from "./mix-presets";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import type { ProjectMediaState } from "@/lib/media-retention";
import { editorProjectSaveQueue } from "@/lib/editor-project-save-queue";
import {
  createEditorProjectAutosaveCandidate,
  createEditorProjectAutosaveSnapshot,
  decideEditorProjectAutosaveObservation,
  type EditorProjectAutosaveCandidate,
  type EditorProjectAutosaveSnapshot,
} from "@/lib/editor-project-autosave-lineage";
import {
  decideEditorProjectBootstrap,
  isEditorProjectRecoveryDraft,
} from "@/lib/editor-project-bootstrap";
import {
  clearEditorProjectRecoveryJournal,
  parseEditorProjectRecoveryJournal,
  readEditorProjectRecoveryJournal,
  writeEditorProjectRecoveryJournal,
} from "@/lib/editor-project-recovery-journal";
import {
  canonicalizeDraftLogoOverlay,
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

export type RecoveryCandidate = {
  draft: Record<string, unknown>;
  revision: number | null;
  updatedAt: string | null;
  trusted: boolean;
};

export type EditorProjectRecoveryState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "load-error"; message: string }
  | {
      status: "conflict";
      local: RecoveryCandidate;
      server: RecoveryCandidate;
      resolving: false | "local" | "server" | "refresh";
      requiresServerRefresh: boolean;
      error: string | null;
    };

type AutosaveLineageTracker = {
  projectId: string;
  confirmed: EditorProjectAutosaveCandidate;
  issued: Map<number, EditorProjectAutosaveSnapshot>;
  latestLocal: EditorProjectAutosaveCandidate | null;
  blocked: boolean;
  generation: number;
};

type EditorProjectDraftAttemptResult =
  | {
      kind: "saved";
      candidate: EditorProjectAutosaveCandidate;
      project: Record<string, unknown>;
    }
  | {
      kind: "conflict";
      server: EditorProjectAutosaveCandidate;
    }
  | { kind: "ambiguous" }
  | { kind: "error" };

type SetState<T> = Dispatch<SetStateAction<T>>;

function useUserDraftState<T>(initial: T, markUserMutation: () => void): [T, SetState<T>, SetState<T>] {
  const [value, setRaw] = useState(initial);
  const setFromUser = useCallback<SetState<T>>((next) => {
    markUserMutation();
    setRaw(next);
  }, [markUserMutation]);
  return [value, setFromUser, setRaw];
}

function freezeRecoveryValue<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeRecoveryValue(child);
  return Object.freeze(value);
}

export function createRecoveryCandidate(input: {
  projectId: string;
  draft: unknown;
  revision: number | null;
  updatedAt: string | null;
  trusted: boolean;
}): RecoveryCandidate | null {
  if (
    input.revision !== null
    && (!Number.isSafeInteger(input.revision) || input.revision < 0)
  ) return null;
  const materialized = parseEditorProjectRecoveryJournal({
    version: 1,
    projectId: input.projectId,
    baseRevision: input.revision ?? 0,
    editedAt: "1970-01-01T00:00:00.000Z",
    draft: input.draft,
  }, input.projectId);
  if (!materialized) return null;
  const draft = canonicalizeDraftLogoOverlay(materialized.draft);
  return freezeRecoveryValue({
    draft,
    revision: input.revision,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
    trusted: input.trusted,
  });
}

export function buildLocalConflictPatchBody(
  conflict: { local: RecoveryCandidate; server: RecoveryCandidate },
  revision: number,
): Record<string, unknown> {
  if (conflict.server.revision === null) throw new Error("server revision is required");
  return {
    draft: conflict.local.draft,
    draftRevision: revision,
    expectedDraftRevision: conflict.server.revision,
    touchLastOpened: true,
  };
}

export function isLatestSavedProjectRevision(
  event: { projectId: string; revision: number; status: string },
  latest: { projectId: string | null; revision: number | null },
): boolean {
  return event.status === "saved"
    && event.projectId === latest.projectId
    && event.revision === latest.revision;
}

function browserStorage() {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function loadDraft(): V2Draft | null {
  try {
    const storage = browserStorage();
    const raw = storage?.getItem(DRAFT_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isEditorProjectRecoveryDraft(value) ? value as V2Draft : null;
  } catch { return null; }
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

function autosaveCandidateFromProject(
  projectId: string,
  project: Record<string, unknown>,
): EditorProjectAutosaveCandidate | null {
  if (project.id !== projectId) return null;
  const revision = typeof project.draftRevision === "number" ? project.draftRevision : null;
  if (revision === null) return null;
  const rawDraft = project.draft === undefined || project.draft === null
    ? typeof project.title === "string" ? { projectTitle: project.title } : {}
    : project.draft;
  const recoveryCandidate = createRecoveryCandidate({
    projectId,
    draft: rawDraft,
    revision,
    updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : null,
    trusted: true,
  });
  if (!recoveryCandidate) return null;
  return createEditorProjectAutosaveCandidate({
    projectId,
    revision,
    draft: recoveryCandidate.draft,
  });
}

async function saveEditorProjectDraft(
  snapshot: EditorProjectAutosaveSnapshot,
  signal: AbortSignal,
): Promise<EditorProjectDraftAttemptResult> {
  try {
    const res = await fetch(`/api/editor-projects/${encodeURIComponent(snapshot.projectId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: (snapshot.draft as V2Draft).projectTitle,
        draft: snapshot.draft,
        draftRevision: snapshot.revision,
        expectedDraftRevision: snapshot.expectedDraftRevision,
        touchLastOpened: true,
      }),
      signal,
    });
    if (signal.aborted) return { kind: "ambiguous" };
    const payload = await res.json().catch(() => null);
    if (signal.aborted) return { kind: "ambiguous" };
    const project = payload?.project as Record<string, unknown> | null | undefined;
    const candidate = project
      ? autosaveCandidateFromProject(snapshot.projectId, project)
      : null;
    if (res.status === 409) {
      return candidate
        ? { kind: "conflict", server: candidate }
        : { kind: "ambiguous" };
    }
    if (!res.ok) return { kind: "error" };
    if (
      !candidate
      || candidate.revision !== snapshot.revision
      || candidate.fingerprint !== snapshot.fingerprint
    ) return { kind: "ambiguous" };
    return { kind: "saved", candidate, project: project! };
  } catch {
    return { kind: "ambiguous" };
  }
}

async function loadAuthoritativeEditorProjectDraft(
  projectId: string,
  signal: AbortSignal,
): Promise<{
  candidate: EditorProjectAutosaveCandidate;
  project: Record<string, unknown>;
} | null> {
  try {
    const response = await fetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok || signal.aborted) return null;
    const payload = await response.json().catch(() => null);
    if (signal.aborted) return null;
    const project = payload?.project as Record<string, unknown> | null | undefined;
    const candidate = project ? autosaveCandidateFromProject(projectId, project) : null;
    return candidate && project ? { candidate, project } : null;
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
  const accountDraftDefaultsAllowedRef = useRef(true);
  const trustedResumeDraftRef = useRef<V2Draft | null>(null);
  const bootstrapGenerationRef = useRef(0);
  const bootstrapAbortControllerRef = useRef<AbortController | null>(null);
  const userDraftMutationTokenRef = useRef(0);
  const markUserDraftMutation = useCallback(() => {
    accountDraftDefaultsAllowedRef.current = false;
    trustedResumeDraftRef.current = null;
    userDraftMutationTokenRef.current += 1;
  }, []);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectReady, setProjectReady] = useState(false);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>("draft");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeExportJobId, setActiveExportJobId] = useState<string | null>(null);
  const [latestVideoId, setLatestVideoId] = useState<string | null>(null);
  const [previewMediaState, setPreviewMediaState] = useState<ProjectMediaState | null>(null);

  // ── Step 1 ──
  const [projectTitle, setProjectTitle, setProjectTitleRaw] = useUserDraftState(d.projectTitle ?? DEFAULT_PROJECT.projectTitle, markUserDraftMutation);
  const [mode, setMode, setModeRaw] = useUserDraftState<V2Mode>(d.mode ?? "script", markUserDraftMutation);
  const [script, setScript, setScriptRaw] = useUserDraftState(d.script ?? "", markUserDraftMutation);
  /** URL คลิปที่อัปโหลด (โหมดใช้คลิปที่ถ่ายเอง) */
  const [clipUrlState, setClipUrlStateFromUser, setClipUrlStateRaw] = useUserDraftState(d.clipUrl ?? "", markUserDraftMutation);
  const [clipDurationSecState, setClipDurationSecStateFromUser, setClipDurationSecStateRaw] = useUserDraftState(
    typeof d.clipDurationSec === "number" && Number.isFinite(d.clipDurationSec) && d.clipDurationSec > 0
      ? d.clipDurationSec
      : 0,
    markUserDraftMutation,
  );
  const setClipDurationSec = useCallback((sec: number) => {
    setClipDurationSecStateFromUser(Number.isFinite(sec) && sec > 0 ? sec : 0);
  }, [setClipDurationSecStateFromUser]);
  const setClipUrl = useCallback((url: string) => {
    setClipUrlStateFromUser(url);
    if (!url) setClipDurationSecStateRaw(0);
  }, [setClipDurationSecStateFromUser, setClipUrlStateFromUser]);
  const clipUrl = clipUrlState;
  const clipDurationSec = clipDurationSecState;

  // ── Step 2 ──
  // default = วิดีโอสต็อก (ฟรี) — AutoMix/ภาพ AI ยัง Beta (admin เท่านั้น), วิดีโอ AI ยังไม่เปิด
  const [brollSource, setBrollSource, setBrollSourceRaw] = useUserDraftState<V2BrollSource>(d.brollSource ?? "stock", markUserDraftMutation);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaidManagedKie, setIsPaidManagedKie] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  /** Task 7 badge: server launch-state signal (MANAGED_KIE && CREDITS_LIVE), independent
   *  of plan — lets locked AI-image UI show "เร็ว ๆ นี้" (not launched) instead of the
   *  "อัปเกรดเพื่อใช้ภาพ AI" upsell when the feature simply isn't live yet. */
  const [managedKieOn, setManagedKieOn] = useState(false);
  const [voiceEngine, setVoiceEngine, setVoiceEngineRaw] = useUserDraftState<V2VoiceEngine>(d.voiceEngine ?? "gemini", markUserDraftMutation);
  const [geminiVoiceName, setGeminiVoiceName, setGeminiVoiceNameRaw] = useUserDraftState(d.geminiVoiceName ?? "Aoede", markUserDraftMutation);
  const [voiceId, setVoiceId, setVoiceIdRaw] = useUserDraftState(d.voiceId ?? "", markUserDraftMutation);
  /** filename ของ system track ที่เลือก · "" = ยังไม่เลือก · null = ไม่ใส่เพลง */
  const [musicTrack, setMusicTrack, setMusicTrackRaw] = useUserDraftState<string | null>(d.musicTrack === undefined ? "" : d.musicTrack, markUserDraftMutation);
  /** เพลงที่เลือกเป็นของระบบหรือของผู้ใช้ — ใช้เลือก path bgmFile ตอน submit */
  const [musicTrackKind, setMusicTrackKind, setMusicTrackKindRaw] = useUserDraftState<"system" | "user">(d.musicTrackKind ?? "system", markUserDraftMutation);
  /** ระดับเสียงเพลง 0–1 · default 0.12 (ตรงกับ pipeline + editor v1) — ใต้เสียงพูด */
  const [bgmVolume, setBgmVolume, setBgmVolumeRaw] = useUserDraftState(d.bgmVolume ?? 0.12, markUserDraftMutation);
  const [useAvatar, setUseAvatar, setUseAvatarRaw] = useUserDraftState(d.useAvatar ?? false, markUserDraftMutation);
  const [avatarId, setAvatarId, setAvatarIdRaw] = useUserDraftState(d.avatarId ?? "", markUserDraftMutation);

  // ── ขั้นสูง (P6c) ──
  const [targetClipCount, setTargetClipCount, setTargetClipCountRaw] = useUserDraftState(d.targetClipCount ?? 0, markUserDraftMutation); // 0 = auto
  const [avatarMode, setAvatarMode, setAvatarModeRaw] = useUserDraftState<V2AvatarMode>(d.avatarMode ?? "bookend", markUserDraftMutation);
  const [avatarIntroSecs, setAvatarIntroSecs, setAvatarIntroSecsRaw] = useUserDraftState(d.avatarIntroSecs ?? 5, markUserDraftMutation);
  const [avatarTailSecs, setAvatarTailSecs, setAvatarTailSecsRaw] = useUserDraftState(d.avatarTailSecs ?? 5, markUserDraftMutation);
  const [kieModel, setKieModel, setKieModelRaw] = useUserDraftState<KieImageModel | "">((d.kieModel as KieImageModel | undefined) ?? "", markUserDraftMutation);
  const [autoMixProviders, setAutoMixProviders, setAutoMixProvidersRaw] = useUserDraftState<AutoMixImageProvider[]>(d.autoMixProviders ?? DEFAULT_AUTO_MIX_PROVIDERS, markUserDraftMutation);
  const [brollRegionPreference, setBrollRegionPreference, setBrollRegionPreferenceRaw] = useUserDraftState<BrollRegionPreference>(d.brollRegionPreference ?? "auto", markUserDraftMutation);
  const [brollVisualStyle, setBrollVisualStyle, setBrollVisualStyleRaw] = useUserDraftState<BrollVisualStyle>(d.brollVisualStyle ?? "auto", markUserDraftMutation);
  const [logoOverlay, setLogoOverlay, setLogoOverlayRaw] = useUserDraftState<LogoOverlayConfig | undefined>(d.logoOverlay, markUserDraftMutation);
  // ── Mix preset (D5.1) — non-admin b-roll AI mix. FREE users are forced to "free";
  // paid (isPaidManagedKie) default to "recommended" (applied in the fetchMe effect
  // once plan is known). Draft value wins if the user already chose one. ──
  const [mixPreset, setMixPresetFromUser, setMixPresetRaw] = useUserDraftState<MixPreset>(d.mixPreset ?? "free", markUserDraftMutation);
  /** เลือก preset → ขับ mixPreset + brollSource + autoMixProviders ให้สอดคล้องกัน
   *  (preset ≠ ฟรีล้วน ⇒ automix + provider set รวม kie-ai). weights ที่ส่งไป server
   *  มาจาก PRESET_WEIGHTS ใน useV2Job. */
  const setMixPreset = useCallback((preset: MixPreset) => {
    setMixPresetFromUser(preset);
    setBrollSourceRaw(presetBrollSource(preset));
    const provs = PRESET_PROVIDERS[preset];
    if (provs) setAutoMixProvidersRaw(provs);
  }, [setAutoMixProvidersRaw, setBrollSourceRaw, setMixPresetFromUser]);

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
    if (next.projectTitle !== undefined) setProjectTitleRaw(next.projectTitle || DEFAULT_PROJECT.projectTitle);
    if (next.mode) setModeRaw(next.mode);
    if (next.script !== undefined) setScriptRaw(next.script);
    if (next.clipUrl !== undefined) setClipUrlStateRaw(next.clipUrl);
    if (next.clipDurationSec !== undefined) {
      setClipDurationSecStateRaw(Number.isFinite(next.clipDurationSec) && next.clipDurationSec > 0
        ? next.clipDurationSec
        : 0);
    }
    if (next.brollSource) setBrollSourceRaw(next.brollSource);
    if (next.voiceEngine) setVoiceEngineRaw(next.voiceEngine);
    if (next.geminiVoiceName !== undefined) setGeminiVoiceNameRaw(next.geminiVoiceName);
    if (next.voiceId !== undefined) setVoiceIdRaw(next.voiceId);
    if (next.musicTrack !== undefined) setMusicTrackRaw(next.musicTrack);
    if (next.musicTrackKind) setMusicTrackKindRaw(next.musicTrackKind);
    if (next.bgmVolume !== undefined) setBgmVolumeRaw(next.bgmVolume);
    if (next.useAvatar !== undefined) setUseAvatarRaw(next.useAvatar);
    if (next.avatarId !== undefined) setAvatarIdRaw(next.avatarId);
    if (next.targetClipCount !== undefined) setTargetClipCountRaw(next.targetClipCount);
    if (next.avatarMode) setAvatarModeRaw(next.avatarMode);
    if (next.avatarIntroSecs !== undefined) setAvatarIntroSecsRaw(next.avatarIntroSecs);
    if (next.avatarTailSecs !== undefined) setAvatarTailSecsRaw(next.avatarTailSecs);
    if (next.kieModel !== undefined) setKieModelRaw(next.kieModel as KieImageModel | "");
    if (next.autoMixProviders) setAutoMixProvidersRaw(next.autoMixProviders);
    if (next.mixPreset) setMixPresetRaw(next.mixPreset);
    if (next.brollRegionPreference) setBrollRegionPreferenceRaw(next.brollRegionPreference);
    if (next.brollVisualStyle) setBrollVisualStyleRaw(next.brollVisualStyle);
    setLogoOverlayRaw(normalizeLogoOverlayConfig(next.logoOverlay) ?? undefined);
  }

  // ── Autosave status (topbar hint) — observes the debounced persist effect below;
  //    "idle" until the first user-driven change, then "saving" → "saved". ──
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveRevision, setSaveRevision] = useState(0);
  const [bootstrapRetryRevision, setBootstrapRetryRevision] = useState(0);
  const [recovery, setRecovery] = useState<EditorProjectRecoveryState>({ status: "none" });
  const recoveryRef = useRef<EditorProjectRecoveryState>(recovery);
  const setRecoveryState = useCallback((next: EditorProjectRecoveryState) => {
    recoveryRef.current = next;
    setRecovery(next);
  }, []);
  const projectReadyRef = useRef(projectReady);
  projectReadyRef.current = projectReady;
  const autosaveGenerationRef = useRef(0);
  const autosaveLineageRef = useRef<AutosaveLineageTracker | null>(null);
  const latestDraftRef = useRef<EditorProjectAutosaveCandidate | null>(null);
  const localChoiceGenerationRef = useRef(0);
  const localChoiceAbortControllerRef = useRef<AbortController | null>(null);
  const lastPersistedUserMutationTokenRef = useRef(0);
  const lastHandledSaveRevisionRef = useRef(0);
  const latestQueuedSaveRef = useRef<{ projectId: string | null; revision: number | null }>({
    projectId: null,
    revision: null,
  });
  const retryProjectBootstrap = useCallback(() => {
    if (recoveryRef.current.status === "load-error") {
      setBootstrapRetryRevision((value) => value + 1);
    }
  }, []);
  const retryProjectSave = useCallback(() => {
    if (projectReadyRef.current) setSaveRevision((revision) => revision + 1);
  }, []);
  const mountedRef = useRef(false);
  const currentProjectIdRef = useRef<string | null>(projectId);
  currentProjectIdRef.current = projectId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      autosaveGenerationRef.current += 1;
      autosaveLineageRef.current = null;
      latestDraftRef.current = null;
      localChoiceGenerationRef.current += 1;
      localChoiceAbortControllerRef.current?.abort();
      localChoiceAbortControllerRef.current = null;
      bootstrapGenerationRef.current += 1;
      bootstrapAbortControllerRef.current?.abort();
      bootstrapAbortControllerRef.current = null;
    };
  }, []);

  // ── Read-only wiring ──
  const [usage, setUsage] = useState<V2Usage | null>(null);
  const [avatarInfo, setAvatarInfo] = useState<V2AvatarInfo | null>(null);
  /** รายชื่อเสียง ElevenLabs ของผู้ใช้ (แสดงชื่อแทน Voice ID) · null = ยังไม่โหลด/โหลดไม่ได้ */
  const [elevenVoices, setElevenVoices] = useState<V2ElevenVoice[] | null>(null);
  const canUploadOwnMedia = plan === "PRO" || plan === "BUSINESS";
  const logoEligible = plan === "PRO" || plan === "BUSINESS";

  function clearProjectRecoveryData(clearProjectId: string): void {
    const storage = browserStorage();
    clearEditorProjectRecoveryJournal(storage, clearProjectId);
    try {
      if (storage?.getItem(PROJECT_ID_KEY) === clearProjectId) storage.removeItem(DRAFT_KEY);
    } catch { /* legacy cleanup is best-effort */ }
  }

  function applyServerProjectMetadata(project: Record<string, unknown>): void {
    setProjectStatus(typeof project.status === "string" ? project.status as ProjectStatus : "draft");
    setActiveJobId(typeof project.activeJobId === "string" ? project.activeJobId : null);
    setActiveExportJobId(typeof project.activeExportJobId === "string" ? project.activeExportJobId : null);
    setLatestVideoId(typeof project.latestVideoId === "string" ? project.latestVideoId : null);
    setPreviewMediaState((project.previewMediaState as ProjectMediaState | null | undefined) ?? null);
  }

  function serverCandidateForProject(
    expectedProjectId: string,
    project: Record<string, unknown>,
  ): RecoveryCandidate | null {
    if (project.id !== expectedProjectId) return null;
    const revision = typeof project.draftRevision === "number" ? project.draftRevision : null;
    const draft = project.draft === undefined || project.draft === null
      ? typeof project.title === "string" ? { projectTitle: project.title } : {}
      : project.draft && typeof project.draft === "object" && !Array.isArray(project.draft)
        ? project.draft
        : null;
    if (!draft) return null;
    return createRecoveryCandidate({
      projectId: expectedProjectId,
      draft,
      revision,
      updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : null,
      trusted: true,
    });
  }

  const invalidateAutosaveLineage = useCallback(() => {
    autosaveGenerationRef.current += 1;
    autosaveLineageRef.current = null;
    latestDraftRef.current = null;
  }, []);

  const invalidateLocalChoiceRequest = useCallback(() => {
    localChoiceGenerationRef.current += 1;
    localChoiceAbortControllerRef.current?.abort();
    localChoiceAbortControllerRef.current = null;
  }, []);

  const initializeAutosaveLineage = useCallback((
    nextProjectId: string,
    server: RecoveryCandidate,
  ): AutosaveLineageTracker | null => {
    if (server.revision === null) return null;
    const confirmed = createEditorProjectAutosaveCandidate({
      projectId: nextProjectId,
      revision: server.revision,
      draft: server.draft,
    });
    if (!confirmed) return null;
    const generation = autosaveGenerationRef.current + 1;
    autosaveGenerationRef.current = generation;
    const tracker: AutosaveLineageTracker = {
      projectId: nextProjectId,
      confirmed,
      issued: new Map(),
      latestLocal: null,
      blocked: false,
      generation,
    };
    autosaveLineageRef.current = tracker;
    latestDraftRef.current = null;
    editorProjectSaveQueue.seedRevision(nextProjectId, confirmed.revision);
    return tracker;
  }, []);

  const ownsAutosaveLineage = useCallback((
    tracker: AutosaveLineageTracker,
    generation: number,
  ): boolean => mountedRef.current
    && currentProjectIdRef.current === tracker.projectId
    && autosaveLineageRef.current === tracker
    && tracker.generation === generation
    && autosaveGenerationRef.current === generation, []);

  const acknowledgeAutosaveCandidate = useCallback((
    tracker: AutosaveLineageTracker,
    candidate: EditorProjectAutosaveCandidate,
  ): void => {
    tracker.confirmed = candidate;
    editorProjectSaveQueue.seedRevision(tracker.projectId, candidate.revision);
  }, []);

  const materializeAutosaveConflict = useCallback((input: {
    tracker: AutosaveLineageTracker;
    generation: number;
    server: EditorProjectAutosaveCandidate;
    requiresServerRefresh: boolean;
  }): boolean => {
    const { tracker, generation, server, requiresServerRefresh } = input;
    if (!ownsAutosaveLineage(tracker, generation)) return false;
    tracker.blocked = true;
    const latestLocal = tracker.latestLocal;
    const localCandidate = latestLocal
      ? createRecoveryCandidate({
          projectId: tracker.projectId,
          draft: latestLocal.draft,
          revision: latestLocal.revision,
          updatedAt: null,
          trusted: true,
        })
      : null;
    const serverCandidate = createRecoveryCandidate({
      projectId: tracker.projectId,
      draft: server.draft,
      revision: server.revision,
      updatedAt: null,
      trusted: true,
    });
    setProjectReady(false);
    setSaveStatus("error");
    if (!localCandidate || !serverCandidate) {
      setRecoveryState({
        status: "load-error",
        message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่",
      });
      return false;
    }
    setRecoveryState({
      status: "conflict",
      local: localCandidate,
      server: serverCandidate,
      resolving: false,
      requiresServerRefresh,
      error: requiresServerRefresh
        ? "ยังยืนยันเวอร์ชันล่าสุดไม่ได้ กรุณาตรวจสอบอีกครั้ง"
        : null,
    });
    return true;
  }, [ownsAutosaveLineage, setRecoveryState]);

  const createServerProject = useCallback(async (
    draft: V2Draft,
    options: { isCurrent?: () => boolean; signal?: AbortSignal } = {},
  ) => {
    const isCurrent = options.isCurrent ?? (() => true);
    try {
      const res = await fetch("/api/editor-projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.projectTitle ?? DEFAULT_PROJECT.projectTitle, draft }),
        signal: options.signal,
      });
      if (!isCurrent()) return null;
      if (!res.ok) return null;
      const data = await res.json();
      if (!isCurrent()) return null;
      const id = typeof data?.project?.id === "string" ? data.project.id : null;
      if (id) {
        const createdProject = data.project as Record<string, unknown>;
        const serverCandidate = serverCandidateForProject(id, createdProject);
        if (!serverCandidate || !initializeAutosaveLineage(id, serverCandidate)) return null;
        setProjectId(id);
        setProjectReady(true);
        setRecoveryState({ status: "none" });
        if (typeof data?.project?.status === "string") setProjectStatus(data.project.status as ProjectStatus);
        setActiveJobId(typeof data?.project?.activeJobId === "string" ? data.project.activeJobId : null);
        setActiveExportJobId(typeof data?.project?.activeExportJobId === "string" ? data.project.activeExportJobId : null);
        setLatestVideoId(typeof data?.project?.latestVideoId === "string" ? data.project.latestVideoId : null);
        setPreviewMediaState((data?.project?.previewMediaState as ProjectMediaState | null | undefined) ?? null);
        try {
          const storage = browserStorage();
          storage?.setItem(PROJECT_ID_KEY, id);
          storage?.removeItem(DRAFT_KEY);
        } catch {}
      }
      return id;
    } catch {
      return null;
    }
  }, [initializeAutosaveLineage, setRecoveryState]);

  const resetProject = useCallback(async () => {
    invalidateLocalChoiceRequest();
    invalidateAutosaveLineage();
    const resetGeneration = bootstrapGenerationRef.current + 1;
    bootstrapGenerationRef.current = resetGeneration;
    bootstrapAbortControllerRef.current?.abort();
    const resetController = new AbortController();
    bootstrapAbortControllerRef.current = resetController;
    const isCurrentReset = () => mountedRef.current
      && bootstrapGenerationRef.current === resetGeneration
      && bootstrapAbortControllerRef.current === resetController
      && !resetController.signal.aborted;
    accountDraftDefaultsAllowedRef.current = false;
    trustedResumeDraftRef.current = null;
    const accountDefault = await loadAccountLogoDefault();
    if (!isCurrentReset()) return;
    const nextPreset = isPaidManagedKie ? "recommended" : DEFAULT_PROJECT.mixPreset;
    const inherited = logoOverlayForNewProject({
      hasExistingDraft: false,
      accountDefault,
    });
    const nextDraft: V2Draft = {
      ...DEFAULT_PROJECT,
      autoMixProviders: [...DEFAULT_PROJECT.autoMixProviders],
      mixPreset: nextPreset,
      ...(inherited ? { logoOverlay: inherited } : {}),
    };
    draftRef.current = nextDraft;
    lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
    lastHandledSaveRevisionRef.current = saveRevision;
    latestQueuedSaveRef.current = { projectId: null, revision: null };
    if (projectId) clearProjectRecoveryData(projectId);
    setProjectId(null);
    setProjectReady(false);
    setRecoveryState({ status: "none" });
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

    setModeRaw(DEFAULT_PROJECT.mode);
    setProjectTitleRaw(DEFAULT_PROJECT.projectTitle);
    setScriptRaw(DEFAULT_PROJECT.script);
    setClipUrlStateRaw(DEFAULT_PROJECT.clipUrl);
    setClipDurationSecStateRaw(DEFAULT_PROJECT.clipDurationSec);
    setVoiceEngineRaw(DEFAULT_PROJECT.voiceEngine);
    setGeminiVoiceNameRaw(DEFAULT_PROJECT.geminiVoiceName);
    setVoiceIdRaw(DEFAULT_PROJECT.voiceId);
    setMusicTrackRaw(DEFAULT_PROJECT.musicTrack);
    setMusicTrackKindRaw(DEFAULT_PROJECT.musicTrackKind);
    setBgmVolumeRaw(DEFAULT_PROJECT.bgmVolume);
    setUseAvatarRaw(DEFAULT_PROJECT.useAvatar);
    setAvatarIdRaw(DEFAULT_PROJECT.avatarId);
    setAvatarInfo(null);
    setTargetClipCountRaw(DEFAULT_PROJECT.targetClipCount);
    setAvatarModeRaw(DEFAULT_PROJECT.avatarMode);
    setAvatarIntroSecsRaw(DEFAULT_PROJECT.avatarIntroSecs);
    setAvatarTailSecsRaw(DEFAULT_PROJECT.avatarTailSecs);
    setKieModelRaw(DEFAULT_PROJECT.kieModel);
    setAutoMixProvidersRaw([...(PRESET_PROVIDERS[nextPreset] ?? DEFAULT_PROJECT.autoMixProviders)]);
    setBrollSourceRaw(presetBrollSource(nextPreset));
    setBrollRegionPreferenceRaw(DEFAULT_PROJECT.brollRegionPreference);
    setBrollVisualStyleRaw(DEFAULT_PROJECT.brollVisualStyle);
    setMixPresetRaw(nextPreset);
    setLogoOverlayRaw(inherited);
    setSaveStatus("idle");
    await createServerProject(nextDraft, {
      isCurrent: isCurrentReset,
      signal: resetController.signal,
    });
  }, [createServerProject, invalidateAutosaveLineage, invalidateLocalChoiceRequest, isPaidManagedKie, projectId, saveRevision, setRecoveryState]);

  useEffect(() => {
    let alive = true;
    invalidateLocalChoiceRequest();
    invalidateAutosaveLineage();
    const generation = bootstrapGenerationRef.current + 1;
    bootstrapGenerationRef.current = generation;
    bootstrapAbortControllerRef.current?.abort();
    const controller = new AbortController();
    bootstrapAbortControllerRef.current = controller;
    const isCurrentBootstrap = () => alive
      && mountedRef.current
      && bootstrapGenerationRef.current === generation
      && bootstrapAbortControllerRef.current === controller
      && !controller.signal.aborted;
    async function ensureServerProject() {
      const storage = browserStorage();
      const storedLocalDraft = loadDraft();
      const urlProjectId = new URLSearchParams(window.location.search).get("projectId");
      let storedProjectId: string | null = null;
      try { storedProjectId = storage?.getItem(PROJECT_ID_KEY) ?? null; } catch {}
      const existingProjectId = urlProjectId || storedProjectId;

      if (existingProjectId) {
        accountDraftDefaultsAllowedRef.current = false;
        trustedResumeDraftRef.current = null;
        setRecoveryState({ status: "loading" });
        setProjectId(existingProjectId);
        setProjectReady(false);
        setSaveStatus("idle");
        await editorProjectSaveQueue.whenIdle(existingProjectId);
        if (!isCurrentBootstrap()) return;
        let response: Response | null = null;
        try {
          response = await fetch(
            `/api/editor-projects/${encodeURIComponent(existingProjectId)}`,
            { cache: "no-store", signal: controller.signal },
          );
        } catch { /* handled by the fail-closed branch */ }
        if (!isCurrentBootstrap()) return;
        if (!response || !response.ok) {
          setProjectReady(false);
          setSaveStatus("error");
          setRecoveryState({
            status: "load-error",
            message: response?.status === 404
              ? "ไม่พบโปรเจกต์นี้ กรุณาตรวจสอบลิงก์หรือลองใหม่"
              : "โหลดโปรเจกต์ไม่สำเร็จ กรุณาลองใหม่",
          });
          return;
        }
        const data = await response.json().catch(() => null);
        if (!isCurrentBootstrap()) return;
        const project = data?.project as Record<string, unknown> | null | undefined;
        if (
          !project
          || project.id !== existingProjectId
          || typeof project.draftRevision !== "number"
          || !Number.isSafeInteger(project.draftRevision)
          || project.draftRevision < 0
          || project.draftRevision > 2_147_483_647
        ) {
          setProjectReady(false);
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
          return;
        }
        const journal = readEditorProjectRecoveryJournal(storage, existingProjectId);
        const legacyLocalDraft = storedProjectId === existingProjectId && storedLocalDraft
          ? canonicalizeDraftLogoOverlay(storedLocalDraft)
          : null;
        const decision = decideEditorProjectBootstrap({
          projectId: existingProjectId,
          serverRevision: project.draftRevision,
          revisionWatermark: editorProjectSaveQueue.revisionWatermark(existingProjectId),
          journal,
          legacyLocalDraft,
        });
        const serverCandidate = serverCandidateForProject(existingProjectId, project);
        if (!serverCandidate) {
          setProjectReady(false);
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
          return;
        }
        editorProjectSaveQueue.seedRevision(project.id as string, project.draftRevision);
        const tracker = initializeAutosaveLineage(existingProjectId, serverCandidate);
        if (!tracker) {
          setProjectReady(false);
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
          return;
        }
        setProjectId(project.id as string);
        applyServerProjectMetadata(project);
        try { storage?.setItem(PROJECT_ID_KEY, project.id as string); } catch {}

        if (decision.kind === "server") {
          trustedResumeDraftRef.current = null;
          applyDraft(serverCandidate.draft as V2Draft);
          clearProjectRecoveryData(existingProjectId);
          lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
          setRecoveryState({ status: "none" });
          setProjectReady(true);
          setSaveStatus("idle");
          return;
        }
        if (decision.kind === "resume-local") {
          const localCandidate = createRecoveryCandidate({
            projectId: existingProjectId,
            draft: decision.journal.draft,
            revision: decision.journal.baseRevision,
            updatedAt: decision.journal.editedAt,
            trusted: true,
          });
          if (!localCandidate) {
            setProjectReady(false);
            setSaveStatus("error");
            setRecoveryState({ status: "load-error", message: "ข้อมูลกู้คืนไม่สมบูรณ์ กรุณาลองใหม่" });
            return;
          }
          trustedResumeDraftRef.current = localCandidate.draft as V2Draft;
          tracker.latestLocal = createEditorProjectAutosaveCandidate({
            projectId: existingProjectId,
            revision: tracker.confirmed.revision,
            draft: localCandidate.draft,
          });
          applyDraft(localCandidate.draft as V2Draft);
          lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
          setRecoveryState({ status: "none" });
          setProjectReady(true);
          setSaveStatus("saving");
          setSaveRevision((value) => value + 1);
          return;
        }
        if (decision.kind === "conflict") {
          trustedResumeDraftRef.current = null;
          const localCandidate = createRecoveryCandidate({
            projectId: existingProjectId,
            draft: decision.local.draft,
            revision: journal?.baseRevision ?? null,
            updatedAt: decision.local.editedAt,
            trusted: decision.local.trusted,
          });
          setProjectReady(false);
          tracker.blocked = true;
          if (!localCandidate) {
            setSaveStatus("error");
            setRecoveryState({ status: "load-error", message: "ข้อมูลกู้คืนไม่สมบูรณ์ กรุณาลองใหม่" });
            return;
          }
          setRecoveryState({
            status: "conflict",
            local: localCandidate,
            server: serverCandidate,
            resolving: false,
            requiresServerRefresh: false,
            error: null,
          });
          return;
        }
        if (decision.kind === "locked-error") {
          setProjectReady(false);
          setSaveStatus("error");
          setRecoveryState({
            status: "load-error",
            message: "ข้อมูลโปรเจกต์ยังไม่สอดคล้องกัน กรุณาลองใหม่",
          });
          return;
        }
      }

      await Promise.resolve();
      if (!isCurrentBootstrap()) return;
      const localDraft = urlProjectId && urlProjectId !== storedProjectId
        ? null
        : storedLocalDraft;
      const hasLocalDraft = localDraft !== null;
      const seedDraft = hasLocalDraft ? localDraft : buildDraft();
      if (!hasLocalDraft) {
        const accountDefault = await loadAccountLogoDefault();
        if (!isCurrentBootstrap()) return;
        const inherited = logoOverlayForNewProject({ hasExistingDraft: false, accountDefault });
        if (inherited) seedDraft.logoOverlay = inherited;
      }
      const canonicalSeedDraft = canonicalizeDraftLogoOverlay(seedDraft);
      if (!isCurrentBootstrap()) return;
      applyDraft(canonicalSeedDraft);
      trustedResumeDraftRef.current = null;
      lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
      const id = await createServerProject(canonicalSeedDraft, {
        isCurrent: isCurrentBootstrap,
        signal: controller.signal,
      });
      if (!isCurrentBootstrap() || !id) return;
      try { storage?.setItem(PROJECT_ID_KEY, id); } catch {}
    }
    void ensureServerProject();
    return () => {
      alive = false;
      controller.abort();
      if (bootstrapGenerationRef.current === generation) bootstrapGenerationRef.current += 1;
    };
    // Server project bootstrap should run once. Subsequent field autosaves are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createServerProject, bootstrapRetryRevision, invalidateAutosaveLineage, invalidateLocalChoiceRequest]);

  const refreshConflictAfterAmbiguousWrite = useCallback(async (
    projectId: string,
    conflict: Extract<EditorProjectRecoveryState, { status: "conflict" }>,
    ownership: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
  ) => {
    const stillResolvingThisConflict = ownership.isCurrent ?? (() => mountedRef.current
      && currentProjectIdRef.current === projectId
      && recoveryRef.current.status === "conflict"
      && recoveryRef.current.local === conflict.local);
    try {
      const response = await fetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
        cache: "no-store",
        signal: ownership.signal,
      });
      if (!stillResolvingThisConflict()) return;
      const payload = response.ok ? await response.json().catch(() => null) : null;
      if (!stillResolvingThisConflict()) return;
      const currentProject = payload?.project as Record<string, unknown> | null | undefined;
      const server = currentProject
        ? serverCandidateForProject(projectId, currentProject)
        : null;
      if (!stillResolvingThisConflict()) return;
      if (!response.ok || !server || server.revision === null) {
        setRecoveryState({
          status: "conflict",
          local: conflict.local,
          server: conflict.server,
          resolving: false,
          requiresServerRefresh: true,
          error: "ตรวจสอบเวอร์ชันล่าสุดไม่สำเร็จ กรุณาตรวจสอบอีกครั้ง",
        });
        return;
      }
      applyServerProjectMetadata(currentProject!);
      setRecoveryState({
        status: "conflict",
        local: conflict.local,
        server,
        resolving: false,
        requiresServerRefresh: false,
        error: "ตรวจสอบข้อมูลล่าสุดแล้ว กรุณาเลือกเวอร์ชันที่ต้องการอีกครั้ง",
      });
    } catch {
      if (!stillResolvingThisConflict()) return;
      setRecoveryState({
        status: "conflict",
        local: conflict.local,
        server: conflict.server,
        resolving: false,
        requiresServerRefresh: true,
        error: "ตรวจสอบเวอร์ชันล่าสุดไม่สำเร็จ กรุณาตรวจสอบอีกครั้ง",
      });
    }
  }, [setRecoveryState]);

  const chooseLocalProjectDraft = useCallback(async () => {
    const conflict = recoveryRef.current;
    const projectId = currentProjectIdRef.current;
    if (
      conflict.status !== "conflict"
      || conflict.resolving
      || conflict.requiresServerRefresh
      || !projectId
    ) return;
    const expected = conflict.server.revision;
    if (expected === null) {
      setRecoveryState({ ...conflict, error: "ไม่พบเลขเวอร์ชันบนระบบ กรุณาลองใหม่" });
      return;
    }
    invalidateLocalChoiceRequest();
    setRecoveryState({ ...conflict, resolving: "local", error: null });
    let revision: number;
    try {
      revision = editorProjectSaveQueue.reserveRevisionAbove(projectId, expected);
    } catch {
      setRecoveryState({
        ...conflict,
        resolving: false,
        error: "ไม่สามารถสร้างเลขเวอร์ชันใหม่ได้ กรุณาลองใหม่",
      });
      return;
    }
    const patchBody = buildLocalConflictPatchBody(conflict, revision);
    const choiceSnapshot = createEditorProjectAutosaveSnapshot({
      projectId,
      expectedDraftRevision: expected,
      revision,
      draft: patchBody.draft,
    });
    if (!choiceSnapshot) {
      setRecoveryState({
        ...conflict,
        resolving: false,
        error: "ข้อมูลฉบับที่เลือกไม่สมบูรณ์ กรุณาลองใหม่",
      });
      return;
    }
    const requestGeneration = localChoiceGenerationRef.current + 1;
    localChoiceGenerationRef.current = requestGeneration;
    const controller = new AbortController();
    localChoiceAbortControllerRef.current = controller;
    const stillCurrentChoice = () => mountedRef.current
      && currentProjectIdRef.current === projectId
      && localChoiceGenerationRef.current === requestGeneration
      && localChoiceAbortControllerRef.current === controller
      && !controller.signal.aborted
      && recoveryRef.current.status === "conflict"
      && recoveryRef.current.local === conflict.local
      && recoveryRef.current.server === conflict.server
      && recoveryRef.current.resolving === "local";
    try {
      const res = await fetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...patchBody,
          draft: choiceSnapshot.draft,
          draftRevision: choiceSnapshot.revision,
          expectedDraftRevision: choiceSnapshot.expectedDraftRevision,
        }),
        signal: controller.signal,
      });
      if (!stillCurrentChoice()) return;
      const payload = await res.json().catch(() => null);
      if (!stillCurrentChoice()) return;
      if (res.status === 409) {
        const currentProject = payload?.project as Record<string, unknown> | null | undefined;
        const server = currentProject
          ? serverCandidateForProject(projectId, currentProject)
          : null;
        if (!stillCurrentChoice()) return;
        if (server && server.revision !== null) {
          applyServerProjectMetadata(currentProject!);
          setRecoveryState({
            status: "conflict",
            local: conflict.local,
            server: server,
            resolving: false,
            requiresServerRefresh: false,
            error: "ข้อมูลบนระบบมีการเปลี่ยนแปลง กรุณาเลือกอีกครั้ง",
          });
        } else {
          if (!stillCurrentChoice()) return;
          await refreshConflictAfterAmbiguousWrite(projectId, conflict, {
            signal: controller.signal,
            isCurrent: stillCurrentChoice,
          });
        }
        return;
      }
      const savedProject = payload?.project as Record<string, unknown> | null | undefined;
      const savedCandidate = res.ok && savedProject
        ? serverCandidateForProject(projectId, savedProject)
        : null;
      const savedAutosaveCandidate = res.ok && savedProject
        ? autosaveCandidateFromProject(projectId, savedProject)
        : null;
      const isExactAcknowledgement = savedCandidate
        && savedAutosaveCandidate
        && savedAutosaveCandidate.revision === choiceSnapshot.revision
        && savedAutosaveCandidate.fingerprint === choiceSnapshot.fingerprint;
      if (!isExactAcknowledgement) {
        if (!stillCurrentChoice()) return;
        await refreshConflictAfterAmbiguousWrite(projectId, conflict, {
          signal: controller.signal,
          isCurrent: stillCurrentChoice,
        });
        return;
      }
      if (!stillCurrentChoice()) return;
      applyDraft(savedCandidate.draft as V2Draft);
      trustedResumeDraftRef.current = null;
      applyServerProjectMetadata(savedProject!);
      if (!initializeAutosaveLineage(projectId, savedCandidate)) {
        setRecoveryState({ ...conflict, resolving: false, error: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
        return;
      }
      lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
      latestQueuedSaveRef.current = { projectId: null, revision: null };
      clearProjectRecoveryData(projectId);
      setProjectReady(true);
      setSaveStatus("saved");
      setRecoveryState({ status: "none" });
      if (localChoiceAbortControllerRef.current === controller) {
        localChoiceAbortControllerRef.current = null;
      }
    } catch {
      if (!stillCurrentChoice()) return;
      await refreshConflictAfterAmbiguousWrite(projectId, conflict, {
        signal: controller.signal,
        isCurrent: stillCurrentChoice,
      });
    }
  }, [initializeAutosaveLineage, invalidateLocalChoiceRequest, refreshConflictAfterAmbiguousWrite, setRecoveryState]);

  const chooseServerProjectDraft = useCallback(() => {
    const conflict = recoveryRef.current;
    const projectId = currentProjectIdRef.current;
    if (
      conflict.status !== "conflict"
      || conflict.resolving
      || conflict.requiresServerRefresh
      || !projectId
    ) return;
    invalidateLocalChoiceRequest();
    setRecoveryState({ ...conflict, resolving: "server", error: null });
    applyDraft(conflict.server.draft as V2Draft);
    trustedResumeDraftRef.current = null;
    if (!initializeAutosaveLineage(projectId, conflict.server)) return;
    lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
    latestQueuedSaveRef.current = { projectId: null, revision: null };
    clearProjectRecoveryData(projectId);
    setProjectReady(true);
    setSaveStatus("idle");
    setRecoveryState({ status: "none" });
  }, [initializeAutosaveLineage, invalidateLocalChoiceRequest, setRecoveryState]);

  const retryConflictServerRefresh = useCallback(async () => {
    const conflict = recoveryRef.current;
    const projectId = currentProjectIdRef.current;
    if (
      conflict.status !== "conflict"
      || conflict.resolving
      || !conflict.requiresServerRefresh
      || !projectId
    ) return;
    invalidateLocalChoiceRequest();
    setRecoveryState({ ...conflict, resolving: "refresh", error: null });
    await refreshConflictAfterAmbiguousWrite(projectId, conflict);
  }, [invalidateLocalChoiceRequest, refreshConflictAfterAmbiguousWrite, setRecoveryState]);

  // ค่า default จริงของผู้ใช้ (เหมือน init ของ legacy editor) — ไม่ทับค่าที่ draft จำไว้
  useEffect(() => {
    fetch("/api/user/video-settings").then(r => r.json()).then(s => {
      if (!accountDraftDefaultsAllowedRef.current) return;
      const hadDraft = Object.keys(draftRef.current).length > 0;
      if (!hadDraft) {
        if (s.heygenAvatarId) setAvatarIdRaw(s.heygenAvatarId);
        if (s.elevenlabsVoiceId) setVoiceIdRaw(s.elevenlabsVoiceId);
        if (s.ttsProvider === "gemini" || s.ttsProvider === "elevenlabs") setVoiceEngineRaw(s.ttsProvider);
        if (s.geminiVoiceName) setGeminiVoiceNameRaw(s.geminiVoiceName);
      } else {
        // เติมเฉพาะช่องที่ draft ไม่มีค่า
        if (s.heygenAvatarId && !draftRef.current.avatarId) setAvatarIdRaw(s.heygenAvatarId);
        if (s.elevenlabsVoiceId && !draftRef.current.voiceId) setVoiceIdRaw(s.elevenlabsVoiceId);
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
      if (!admin && accountDraftDefaultsAllowedRef.current) {
        const defaultPreset = !paid ? "free" : !draftRef.current.mixPreset ? "recommended" : null;
        if (defaultPreset) {
          setMixPresetRaw(defaultPreset);
          setBrollSourceRaw(presetBrollSource(defaultPreset));
          const providers = PRESET_PROVIDERS[defaultPreset];
          if (providers) setAutoMixProvidersRaw(providers);
        }
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist draft (debounce 1s) — จำการตั้งค่าโปรเจกต์ข้ามเซสชัน.
  // Only an explicit public setter advances the user token. Programmatic hydration,
  // defaults, conflict choices, and reset therefore cannot create recovery provenance.
  useEffect(() => {
    if (!projectReady || !projectId) return;
    const hasUserMutation = userDraftMutationTokenRef.current
      > lastPersistedUserMutationTokenRef.current;
    const hasSaveRetry = saveRevision > lastHandledSaveRevisionRef.current;
    if (!hasUserMutation && !hasSaveRetry) return;
    const tracker = autosaveLineageRef.current;
    if (!tracker || tracker.projectId !== projectId || tracker.blocked) return;
    const draft = trustedResumeDraftRef.current
      ?? canonicalizeDraftLogoOverlay(buildDraft()) as V2Draft;
    const latestLocal = createEditorProjectAutosaveCandidate({
      projectId,
      revision: tracker.confirmed.revision,
      draft,
    });
    if (!latestLocal) {
      tracker.blocked = true;
      setProjectReady(false);
      setSaveStatus("error");
      setRecoveryState({
        status: "load-error",
        message: "ข้อมูลฉบับแก้ไขไม่สมบูรณ์ กรุณาลองโหลดโปรเจกต์อีกครั้ง",
      });
      return;
    }
    tracker.latestLocal = latestLocal;
    latestDraftRef.current = latestLocal;
    const generation = tracker.generation;
    setSaveStatus("saving");
    const t = setTimeout(() => {
      const saveProjectId = projectId;
      if (!ownsAutosaveLineage(tracker, generation) || tracker.blocked) return;
      const capturedLatestLocal = latestDraftRef.current;
      if (!capturedLatestLocal || capturedLatestLocal !== latestLocal) return;
      if (userDraftMutationTokenRef.current > lastPersistedUserMutationTokenRef.current) {
        const journalWritten = writeEditorProjectRecoveryJournal(browserStorage(), {
          version: 1,
          projectId: saveProjectId,
          baseRevision: tracker.confirmed.revision,
          editedAt: new Date().toISOString(),
          draft: capturedLatestLocal.draft,
        });
        if (!journalWritten) clearEditorProjectRecoveryJournal(browserStorage(), saveProjectId);
        lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
      }
      lastHandledSaveRevisionRef.current = saveRevision;
      let attempt: EditorProjectAutosaveSnapshot | null = null;
      const revision = editorProjectSaveQueue.enqueue({
        projectId: saveProjectId,
        save: async ({ revision: queuedRevision, signal }) => {
          if (
            signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
            || tracker.blocked
          ) return { kind: "blocked" };
          const expectedDraftRevision = tracker.confirmed.revision;
          const snapshot = createEditorProjectAutosaveSnapshot({
            projectId: saveProjectId,
            expectedDraftRevision,
            revision: queuedRevision,
            draft: capturedLatestLocal.draft,
          });
          if (!snapshot) {
            materializeAutosaveConflict({
              tracker,
              generation,
              server: tracker.confirmed,
              requiresServerRefresh: true,
            });
            return { kind: "blocked" };
          }
          attempt = snapshot;
          tracker.issued.set(snapshot.revision, snapshot);
          const result = await saveEditorProjectDraft(snapshot, signal);
          if (signal.aborted || !ownsAutosaveLineage(tracker, generation)) {
            return { kind: "blocked" };
          }
          if (result.kind === "saved") {
            acknowledgeAutosaveCandidate(tracker, result.candidate);
            applyServerProjectMetadata(result.project);
            return { kind: "saved" };
          }
          if (result.kind === "conflict") {
            materializeAutosaveConflict({
              tracker,
              generation,
              server: result.server,
              requiresServerRefresh: false,
            });
            return { kind: "blocked" };
          }
          return result.kind === "ambiguous"
            ? { kind: "ambiguous" }
            : { kind: "error" };
        },
        reconcile: async ({ signal }) => {
          const currentAttempt = attempt;
          if (
            !currentAttempt
            || signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
            || tracker.blocked
          ) return { kind: "blocked" };
          const observation = await loadAuthoritativeEditorProjectDraft(saveProjectId, signal);
          if (signal.aborted || !ownsAutosaveLineage(tracker, generation)) {
            return { kind: "blocked" };
          }
          const observedProject = observation?.project;
          const observed = observation?.candidate;
          if (
            signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
          ) return { kind: "blocked" };
          if (!observed || !observedProject) {
            materializeAutosaveConflict({
              tracker,
              generation,
              server: tracker.confirmed,
              requiresServerRefresh: true,
            });
            return { kind: "blocked" };
          }
          const decision = decideEditorProjectAutosaveObservation({
            attempt: currentAttempt,
            confirmed: tracker.confirmed,
            issued: tracker.issued,
            observed,
          });
          if (decision.kind === "saved") {
            acknowledgeAutosaveCandidate(tracker, decision.confirmed);
            applyServerProjectMetadata(observedProject);
            return { kind: "saved" };
          }
          if (decision.kind === "conflict") {
            materializeAutosaveConflict({
              tracker,
              generation,
              server: decision.server,
              requiresServerRefresh: false,
            });
            return { kind: "blocked" };
          }
          acknowledgeAutosaveCandidate(tracker, decision.confirmed);
          const retrySnapshot = createEditorProjectAutosaveSnapshot({
            projectId: saveProjectId,
            expectedDraftRevision: decision.confirmed.revision,
            revision: currentAttempt.revision,
            draft: currentAttempt.draft,
          });
          if (!retrySnapshot) {
            materializeAutosaveConflict({
              tracker,
              generation,
              server: observed,
              requiresServerRefresh: true,
            });
            return { kind: "blocked" };
          }
          attempt = retrySnapshot;
          tracker.issued.set(retrySnapshot.revision, retrySnapshot);
          const retryResult = await saveEditorProjectDraft(retrySnapshot, signal);
          if (signal.aborted || !ownsAutosaveLineage(tracker, generation)) {
            return { kind: "blocked" };
          }
          if (retryResult.kind === "saved") {
            acknowledgeAutosaveCandidate(tracker, retryResult.candidate);
            applyServerProjectMetadata(retryResult.project);
            return { kind: "saved" };
          }
          materializeAutosaveConflict({
            tracker,
            generation,
            server: retryResult.kind === "conflict" ? retryResult.server : observed,
            requiresServerRefresh: retryResult.kind !== "conflict",
          });
          return { kind: "blocked" };
        },
        onBlocked: () => {
          if (!tracker.blocked) {
            materializeAutosaveConflict({
              tracker,
              generation,
              server: tracker.confirmed,
              requiresServerRefresh: true,
            });
          }
        },
        isActive: () => ownsAutosaveLineage(tracker, generation),
        onStatus: (event) => {
          const { status } = event;
          setSaveStatus(status);
          if (isLatestSavedProjectRevision(event, latestQueuedSaveRef.current)) {
            trustedResumeDraftRef.current = null;
            clearProjectRecoveryData(event.projectId);
          }
        },
      });
      latestQueuedSaveRef.current = { projectId: saveProjectId, revision };
    }, 1000);
    return () => { clearTimeout(t); };
  }, [mode, projectTitle, script, clipUrl, clipDurationSec, brollSource, voiceEngine, geminiVoiceName, voiceId, musicTrack, musicTrackKind, bgmVolume, useAvatar, avatarId,
      targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs, kieModel, autoMixProviders, mixPreset, brollRegionPreference, brollVisualStyle, logoOverlay, projectId, projectReady,
      acknowledgeAutosaveCandidate, materializeAutosaveConflict, ownsAutosaveLineage, setRecoveryState, saveRevision]);

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
    recovery, retryProjectBootstrap, chooseLocalProjectDraft, chooseServerProjectDraft, retryConflictServerRefresh,
  };
}

export type V2Project = ReturnType<typeof useV2Project>;
