"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { fetchMe, resolveBrandLibraryClientAccess, resolveBrandVisualClientAccess, type MeData } from "@/lib/use-me";
import { DEFAULT_AUTO_MIX_PROVIDERS, type AutoMixImageProvider, type KieImageModel } from "../_components/types";
import { PRESET_PROVIDERS, presetBrollSource, type MixPreset } from "./mix-presets";
import { EDITOR_DEFAULT_DRAFT } from "@/lib/editor-default-draft";
import type { MusicMood } from "@/lib/style-pack-catalog";
import { pickDefaultMusicTrack, decideMusicMoodHintCarry, type MusicTrackForMoodPick } from "@/lib/music-mood";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import type { ProjectStylePack } from "./project-style-pack";
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
import {
  normalizeEditorLayerVisibility,
  type EditorLayerVisibility,
} from "@/lib/editor-layer-visibility";
import {
  parseTtsProvider,
  visibleTtsProvider,
  type OmniVoiceInfo,
  type TtsProvider,
} from "@/lib/tts-providers";
import { useOmniVoiceAvailability } from "../_hooks/useOmniVoiceAvailability";
import {
  saveVideoAccountDefaults,
  type VideoAccountDefaultsPatch,
} from "@/lib/video-account-defaults";
import { fetchClientJson } from "@/lib/client-request-cache";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import {
  normalizeSubtitleStylePresetConfig,
  type SubtitleStylePresetConfig,
} from "@/lib/editor-style-preset-contract";
import {
  headlineHookDraftFragment,
  normalizeHeadlineHook,
  type HeadlineHookConfig,
} from "@/lib/headline-hook";

const DRAFT_KEY = "editor-v2-project";
const PROJECT_ID_KEY = "editor-v2-project-id";
const PROJECT_ACCOUNT_KEY = "editor-v2-project-account";

function scopedProjectIdKey(accountId: string | null): string {
  return accountId ? `${PROJECT_ID_KEY}:${accountId}` : PROJECT_ID_KEY;
}

interface V2Draft {
  projectTitle?: string; narrativeSourceKind?: V2NarrativeSourceKind;
  mode?: V2Mode; script?: string; clipUrl?: string; clipDurationSec?: number; brollSource?: V2BrollSource;
  voiceEngine?: V2VoiceEngine; geminiVoiceName?: string; voiceId?: string; omniVoiceId?: string;
  musicTrack?: string | null; musicTrackKind?: "system" | "user"; bgmVolume?: number; useAvatar?: boolean; avatarId?: string;
  /** Project-level default a pinned Brand Revision's Style Pack may carry (ADR 0058) —
   *  consumed once in applyDraft() to pick a default system track; never itself persisted
   *  back out by buildDraft(). */
  musicMoodDefault?: MusicMood | null;
  targetClipCount?: number; avatarMode?: V2AvatarMode; avatarIntroSecs?: number; avatarTailSecs?: number;
  kieModel?: string; autoMixProviders?: AutoMixImageProvider[]; mixPreset?: MixPreset;
  brollRegionPreference?: BrollRegionPreference; brollVisualStyle?: BrollVisualStyle;
  logoOverlay?: LogoOverlayConfig;
  brandSubtitleDefault?: SubtitleStylePresetConfig;
  layerVisibility?: EditorLayerVisibility;
  headlineHook?: HeadlineHookConfig;
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

function pruneIssuedAutosaveSnapshotsThrough(
  tracker: AutosaveLineageTracker,
  confirmedRevision: number,
): void {
  for (const revision of tracker.issued.keys()) {
    if (revision <= confirmedRevision) tracker.issued.delete(revision);
  }
}

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

function withUserDraftField<T>(
  draft: V2Draft,
  field: keyof V2Draft,
  value: T,
): V2Draft {
  if (value !== undefined) return { ...draft, [field]: value };
  const next = { ...draft };
  delete next[field];
  return next;
}

function rebasePendingUserDraft(
  base: V2Draft,
  pending: V2Draft,
  authoritative: V2Draft,
): V2Draft {
  const rebased = { ...authoritative } as Record<string, unknown>;
  const baseRecord = base as Record<string, unknown>;
  const pendingRecord = pending as Record<string, unknown>;
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(pendingRecord)]);
  for (const key of keys) {
    const baseHasKey = Object.hasOwn(baseRecord, key);
    const pendingHasKey = Object.hasOwn(pendingRecord, key);
    const changedByUser = baseHasKey !== pendingHasKey
      || JSON.stringify(baseRecord[key]) !== JSON.stringify(pendingRecord[key]);
    if (!changedByUser) continue;
    if (pendingHasKey) rebased[key] = pendingRecord[key];
    else delete rebased[key];
  }
  return rebased as V2Draft;
}

function useUserDraftState<T>(
  initial: T,
  field: keyof V2Draft,
  effectiveDraftRef: MutableRefObject<V2Draft>,
  canAcceptUserMutation: () => boolean,
  markUserMutation: () => void,
): [T, SetState<T>, SetState<T>] {
  const [value, setRaw] = useState(initial);
  const valueRef = useRef(value);
  const initializedFieldRef = useRef(false);
  if (!initializedFieldRef.current) {
    initializedFieldRef.current = true;
    effectiveDraftRef.current = withUserDraftField(effectiveDraftRef.current, field, value);
  }
  const setSynchronized = useCallback<SetState<T>>((next) => {
    const resolved = typeof next === "function"
      ? (next as (current: T) => T)(valueRef.current)
      : next;
    valueRef.current = resolved;
    effectiveDraftRef.current = withUserDraftField(effectiveDraftRef.current, field, resolved);
    setRaw(resolved);
  }, [effectiveDraftRef, field]);
  const setFromUser = useCallback<SetState<T>>((next) => {
    if (!canAcceptUserMutation()) return;
    setSynchronized(next);
    markUserMutation();
  }, [canAcceptUserMutation, markUserMutation, setSynchronized]);
  return [value, setFromUser, setSynchronized];
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
  const res = await authenticatedFetch("/api/user/brand-assets", { cache: "no-store" });
  if (!res.ok) throw new Error("account defaults unavailable");
  const data = await res.json();
  return normalizeLogoOverlayConfig(data?.defaultLogo?.config);
}

type AccountVideoDefaults = {
  voiceEngine: V2VoiceEngine;
  geminiVoiceName: string;
  voiceId: string;
  avatarId: string;
};

async function loadAccountVideoDefaults(): Promise<AccountVideoDefaults> {
  const res = await authenticatedFetch("/api/user/video-settings", { cache: "no-store" });
  if (!res.ok) throw new Error("account video defaults unavailable");
  const data = await res.json();
  return {
    voiceEngine: visibleTtsProvider(data?.ttsProvider),
    geminiVoiceName: typeof data?.geminiVoiceName === "string" && data.geminiVoiceName.trim()
      ? data.geminiVoiceName.trim()
      : "Aoede",
    voiceId: typeof data?.elevenlabsVoiceId === "string" ? data.elevenlabsVoiceId.trim() : "",
    avatarId: typeof data?.heygenAvatarId === "string" ? data.heygenAvatarId.trim() : "",
  };
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
    const res = await authenticatedFetch(`/api/editor-projects/${encodeURIComponent(snapshot.projectId)}`, {
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
    const response = await authenticatedFetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
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
export type V2NarrativeSourceKind = "ai-script" | "creator-script" | "upload-transcript";
export type V2BrollSource = "automix" | "stock" | "kie-image" | "kie-video";
export type V2VoiceEngine = TtsProvider;
export type V2AvatarMode = "bookend" | "bookend-both" | "full";

export type ProjectInitializationState =
  | "loading-defaults"
  | "creating-project"
  | "empty"
  | "ready"
  | "error";

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

export type V2OmniVoice = OmniVoiceInfo;

/** The new-project defaults. Lives in @/lib/editor-default-draft so the Hero
 *  Script "ส่งไปตัดต่อ" handoff (which creates EditorProjects on the server)
 *  seeds the exact same draft this hook does — same object, no second copy. */
const DEFAULT_PROJECT = EDITOR_DEFAULT_DRAFT;

export function useV2Project() {
  // Keep the first client render byte-compatible with SSR. Local/server drafts are
  // applied after mount in ensureServerProject(); reading localStorage here causes
  // hydration text mismatches when a previous draft exists.
  const draftRef = useRef<V2Draft>({});
  const effectiveDraftRef = useRef<V2Draft>({});
  const d = draftRef.current;
  const accountDraftDefaultsAllowedRef = useRef(true);
  const trustedResumeDraftRef = useRef<V2Draft | null>(null);
  const projectIdStorageKeyRef = useRef(PROJECT_ID_KEY);
  const bootstrapGenerationRef = useRef(0);
  const bootstrapAbortControllerRef = useRef<AbortController | null>(null);
  const userDraftMutationTokenRef = useRef(0);
  const stagedUserDraftMutationTokenRef = useRef(0);
  const stageExplicitUserDraftMutationRef = useRef<() => void>(() => {});
  const markUserDraftMutation = useCallback(() => {
    accountDraftDefaultsAllowedRef.current = false;
    trustedResumeDraftRef.current = null;
    userDraftMutationTokenRef.current += 1;
    stageExplicitUserDraftMutationRef.current();
  }, []);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [brandContentPreflightId, setBrandContentPreflightId] = useState<string | null>(null);
  const [hasPersistedVisualPin, setHasPersistedVisualPin] = useState(false);
  // ADR 0059 amendment + wave 1b (D1): a pin alone no longer says anything
  // about AI images — every plan can own one. This mirrors the render-time
  // predicate (`hasAdmittedPersistedPin`) exactly, so the Editor never offers
  // an AI-image action the render would refuse. NOT implied by (and does not
  // imply) `hasPersistedVisualPin` — see the comment on the server response
  // shape in `editor-projects.ts`.
  const [hasAdmittedVisualPin, setHasAdmittedVisualPin] = useState(false);
  const [projectReady, setProjectReadyRaw] = useState(false);
  const projectReadyRef = useRef(false);
  const setProjectReady = useCallback((next: boolean) => {
    projectReadyRef.current = next;
    setProjectReadyRaw(next);
  }, []);
  const [projectInitialization, setProjectInitializationRaw] =
    useState<ProjectInitializationState>("loading-defaults");
  const projectInitializationRef = useRef<ProjectInitializationState>("loading-defaults");
  const setProjectInitialization = useCallback((next: ProjectInitializationState) => {
    projectInitializationRef.current = next;
    setProjectInitializationRaw(next);
  }, []);
  const [recovery, setRecoveryRaw] = useState<EditorProjectRecoveryState>({ status: "none" });
  const recoveryRef = useRef<EditorProjectRecoveryState>({ status: "none" });
  const setRecoveryState = useCallback((next: EditorProjectRecoveryState) => {
    recoveryRef.current = next;
    setRecoveryRaw(next);
  }, []);
  const canRunProjectOperation = useCallback(
    () => projectInitializationRef.current === "ready"
      && projectReadyRef.current
      && recoveryRef.current.status === "none",
    [],
  );
  const canAcceptUserMutation = useCallback(
    () => canRunProjectOperation(),
    [canRunProjectOperation],
  );
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>("draft");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeExportJobId, setActiveExportJobId] = useState<string | null>(null);

  useEffect(() => {
    setBrandContentPreflightId(null);
    setHasPersistedVisualPin(false);
    setHasAdmittedVisualPin(false);
  }, [projectId]);
  const [latestVideoId, setLatestVideoId] = useState<string | null>(null);
  const [previewMediaState, setPreviewMediaState] = useState<ProjectMediaState | null>(null);

  // ── Step 1 ──
  const [projectTitle, setProjectTitle, setProjectTitleRaw] = useUserDraftState(
    d.projectTitle ?? DEFAULT_PROJECT.projectTitle, "projectTitle", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [mode, setMode, setModeRaw] = useUserDraftState<V2Mode>(
    d.mode ?? "script", "mode", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [narrativeSourceKind, , setNarrativeSourceKindRaw] = useUserDraftState<V2NarrativeSourceKind>(
    d.narrativeSourceKind ?? (d.mode === "upload" ? "upload-transcript" : "creator-script"),
    "narrativeSourceKind",
    effectiveDraftRef,
    canAcceptUserMutation,
    markUserDraftMutation,
  );
  const [script, setScript, setScriptRaw] = useUserDraftState(
    d.script ?? "", "script", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  /** URL คลิปที่อัปโหลด (โหมดใช้คลิปที่ถ่ายเอง) */
  const [clipUrlState, setClipUrlStateFromUser, setClipUrlStateRaw] = useUserDraftState(
    d.clipUrl ?? "", "clipUrl", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [clipDurationSecState, setClipDurationSecStateFromUser, setClipDurationSecStateRaw] = useUserDraftState(
    typeof d.clipDurationSec === "number" && Number.isFinite(d.clipDurationSec) && d.clipDurationSec > 0
      ? d.clipDurationSec
      : 0,
    "clipDurationSec",
    effectiveDraftRef,
    canAcceptUserMutation,
    markUserDraftMutation,
  );
  const setClipDurationSec = useCallback((sec: number) => {
    setClipDurationSecStateFromUser(Number.isFinite(sec) && sec > 0 ? sec : 0);
  }, [setClipDurationSecStateFromUser]);
  const setClipUrl = useCallback((url: string) => {
    if (!canAcceptUserMutation()) return;
    if (!url) setClipDurationSecStateRaw(0);
    setClipUrlStateFromUser(url);
  }, [canAcceptUserMutation, setClipDurationSecStateRaw, setClipUrlStateFromUser]);
  const clipUrl = clipUrlState;
  const clipDurationSec = clipDurationSecState;

  // ── Step 2 ──
  // default = วิดีโอสต็อก (ฟรี) — AutoMix/ภาพ AI ยัง Beta (admin เท่านั้น), วิดีโอ AI ยังไม่เปิด
  const [brollSource, setBrollSource, setBrollSourceRaw] = useUserDraftState<V2BrollSource>(
    d.brollSource ?? "stock", "brollSource", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [internalAiTester, setInternalAiTester] = useState(false);
  const [heroAiBeta, setHeroAiBeta] = useState(false);
  // Server-authoritative Hero AI Image admission. The API resolves internal,
  // Paid-Equivalent, and bounded Conversion Trial sources; the browser only
  // uses this projection for disclosure UX.
  const [heroAiImageEligible, setHeroAiImageEligible] = useState(false);
  const [heroAiImageAccess, setHeroAiImageAccess] = useState<
    NonNullable<NonNullable<MeData["featureAccess"]>["heroAiImage"]> | null
  >(null);
  const [brandVisualAllowed, setBrandVisualAllowed] = useState(false);
  // The LIBRARY capability (ADR 0059, wave 1b D1): pinning a Brand or a
  // ชุดสไตล์ is open to every plan. `brandVisualAllowed` stays the gate for
  // AI-image actions alone — see `resolveBrandLibraryClientAccess`.
  const [brandLibraryAllowed, setBrandLibraryAllowed] = useState(false);
  // The Style Pack pinned to this project, as reported by the visual-context
  // endpoint (a snapshot, never re-resolved from the catalog). Server state, so
  // it is NOT part of the saved draft: Step 2 only reads it, and the per-window
  // search sends the same mood back so the creator searches with exactly the
  // style the read-only line promised them.
  const [projectStylePack, setProjectStylePack] = useState<ProjectStylePack | null>(null);
  const [brandVisualCohort, setBrandVisualCohort] = useState<NonNullable<MeData["brandVisualCohort"]>>("off");
  const [brandVisualRolloutBucket, setBrandVisualRolloutBucket] = useState<number | null>(null);
  const [starterAiImageAllowance, setStarterAiImageAllowance] = useState<MeData["starterAiImageAllowance"]>(null);
  const [isActiveTrial, setIsActiveTrial] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaidManagedKie, setIsPaidManagedKie] = useState(false);
  const [recommendedAutoMixDefault, setRecommendedAutoMixDefault] = useState(false);
  const [plan, setPlan] = useState<string | null>(null);
  /** Task 7 badge: server launch-state signal (MANAGED_KIE && CREDITS_LIVE), independent
   *  of plan — lets locked AI-image UI show "เร็ว ๆ นี้" (not launched) instead of the
   *  "อัปเกรดเพื่อใช้ภาพ AI" upsell when the feature simply isn't live yet. */
  const [managedKieOn, setManagedKieOn] = useState(false);
  /** MANAGED_STOCK (#297): show the "bring your own stock key" nudge in Step 2.
   *  Server-computed (flag + eligibility + first export done); false otherwise. */
  const [managedStockKeyHint, setManagedStockKeyHint] = useState(false);
  const [voiceEngine, setVoiceEngine, setVoiceEngineRaw] = useUserDraftState<V2VoiceEngine>(
    parseTtsProvider(d.voiceEngine), "voiceEngine", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [geminiVoiceName, setGeminiVoiceName, setGeminiVoiceNameRaw] = useUserDraftState(
    d.geminiVoiceName ?? "Aoede", "geminiVoiceName", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [voiceId, setVoiceId, setVoiceIdRaw] = useUserDraftState(
    d.voiceId ?? "", "voiceId", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [omniVoiceId, setOmniVoiceId, setOmniVoiceIdRaw] = useUserDraftState(
    d.omniVoiceId ?? "voice_01", "omniVoiceId", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  /** filename ของ system track ที่เลือก · "" = ยังไม่เลือก · null = ไม่ใส่เพลง */
  const [musicTrack, setMusicTrack, setMusicTrackRaw] = useUserDraftState<string | null>(
    d.musicTrack === undefined ? "" : d.musicTrack, "musicTrack", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  /** เพลงที่เลือกเป็นของระบบหรือของผู้ใช้ — ใช้เลือก path bgmFile ตอน submit */
  const [musicTrackKind, setMusicTrackKind, setMusicTrackKindRaw] = useUserDraftState<"system" | "user">(
    d.musicTrackKind ?? "system", "musicTrackKind", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  // ── Style Pack default track (Task 6, ADR 0058; hint-carry fix round 1) ──
  // applyDraft() stashes the pack's suggested mood here whenever an applied draft
  // has no chosen musicTrack yet; this hook loads the system track list itself
  // (independent of Step2Elements' own useBgm()) purely to resolve that one pick.
  //
  // `musicMoodDefaultHint` is real draft STATE (unlike the two refs below) so
  // buildDraft() can include it in every autosave while the pick is still
  // pending — otherwise a debounced autosave firing between applyDraft() and
  // the /api/music fetch resolving would persist musicTrack:"" with the hint
  // gone, permanently losing the retry. decideMusicMoodHintCarry() is the pure
  // decision of whether to keep carrying it; it drops once a track exists
  // (auto-picked or creator-chosen) and keeps carrying otherwise, even after a
  // "no match" attempt, so a later admin mood-tag can still be picked up.
  const [musicMoodDefaultHint, , setMusicMoodDefaultHintRaw] = useUserDraftState<MusicMood | null>(
    d.musicMoodDefault ?? null, "musicMoodDefault", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  // Refs (not state) so a stale-closure applyDraft call still sees the latest data.
  const musicMoodTracksRef = useRef<MusicTrackForMoodPick[] | null>(null);
  const pendingMusicMoodDefaultRef = useRef<MusicMood | null>(null);
  const applyMusicMoodDefaultIfPending = useCallback(() => {
    const mood = pendingMusicMoodDefaultRef.current;
    if (!mood) return;
    const tracks = musicMoodTracksRef.current;
    if (!tracks) return; // system track list not loaded yet — retried once it is
    pendingMusicMoodDefaultRef.current = null;
    // Never override a track the creator already chose (incl. an explicit "no music") —
    // and if one now exists (a race with the creator's own pick), the hint is consumed.
    const current = effectiveDraftRef.current.musicTrack;
    if (current !== undefined && current !== "") {
      setMusicMoodDefaultHintRaw(null);
      return;
    }
    const picked = pickDefaultMusicTrack(tracks, mood);
    if (picked) {
      setMusicTrackRaw(picked);
      setMusicTrackKindRaw("system");
      setMusicMoodDefaultHintRaw(null); // consumed — a track is now chosen
    }
    // else: no match found — leave the hint carrying so a future load can retry.
  }, [setMusicTrackRaw, setMusicTrackKindRaw, setMusicMoodDefaultHintRaw]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/music").then(r => r.json()).then(data => {
      if (cancelled) return;
      musicMoodTracksRef.current = Array.isArray(data?.tracks) ? data.tracks : [];
      applyMusicMoodDefaultIfPending();
    }).catch(() => {
      if (!cancelled) musicMoodTracksRef.current = [];
    });
    return () => { cancelled = true; };
  }, [applyMusicMoodDefaultIfPending]);
  /** ระดับเสียงเพลง 0–1 · default 0.12 (ตรงกับ pipeline + editor v1) — ใต้เสียงพูด */
  const [bgmVolume, setBgmVolume, setBgmVolumeRaw] = useUserDraftState(
    d.bgmVolume ?? 0.12, "bgmVolume", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [useAvatar, setUseAvatar, setUseAvatarRaw] = useUserDraftState(
    d.useAvatar ?? false, "useAvatar", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [avatarId, setAvatarId, setAvatarIdRaw] = useUserDraftState(
    d.avatarId ?? "", "avatarId", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );

  // ── ขั้นสูง (P6c) ──
  const [targetClipCount, setTargetClipCount, setTargetClipCountRaw] = useUserDraftState(
    d.targetClipCount ?? 0, "targetClipCount", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  ); // 0 = auto
  // Hero AI Image default-8 guard (Task 5 fast-follow): plain session-only state (NOT
  // useUserDraftState — no server persistence needed) so a fresh page load always starts
  // untouched. Set true only by the count Segmented/number input itself; the Hero
  // AI Image selection handlers that apply the default-8 count must NEVER set this,
  // otherwise the programmatic default would look like a user edit and stop being
  // idempotent on repeated re-selection (see Step2Elements.tsx callers).
  const [heroCountTouched, setHeroCountTouched] = useState(false);
  const [avatarMode, setAvatarMode, setAvatarModeRaw] = useUserDraftState<V2AvatarMode>(
    d.avatarMode ?? "bookend", "avatarMode", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [avatarIntroSecs, setAvatarIntroSecs, setAvatarIntroSecsRaw] = useUserDraftState(
    d.avatarIntroSecs ?? 5, "avatarIntroSecs", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [avatarTailSecs, setAvatarTailSecs, setAvatarTailSecsRaw] = useUserDraftState(
    d.avatarTailSecs ?? 5, "avatarTailSecs", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [kieModel, setKieModel, setKieModelRaw] = useUserDraftState<KieImageModel | "">(
    (d.kieModel as KieImageModel | undefined) ?? "", "kieModel", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [autoMixProviders, setAutoMixProviders, setAutoMixProvidersRaw] = useUserDraftState<AutoMixImageProvider[]>(
    d.autoMixProviders ?? DEFAULT_AUTO_MIX_PROVIDERS, "autoMixProviders", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [brollRegionPreference, setBrollRegionPreference, setBrollRegionPreferenceRaw] = useUserDraftState<BrollRegionPreference>(
    d.brollRegionPreference ?? "auto", "brollRegionPreference", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [brollVisualStyle, setBrollVisualStyle, setBrollVisualStyleRaw] = useUserDraftState<BrollVisualStyle>(
    d.brollVisualStyle ?? "auto", "brollVisualStyle", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [logoOverlay, setLogoOverlay, setLogoOverlayRaw] = useUserDraftState<LogoOverlayConfig | undefined>(
    d.logoOverlay, "logoOverlay", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  const [brandSubtitleDefault, setBrandSubtitleDefault, setBrandSubtitleDefaultRaw] = useUserDraftState<SubtitleStylePresetConfig | undefined>(
    normalizeSubtitleStylePresetConfig(d.brandSubtitleDefault) ?? undefined,
    "brandSubtitleDefault",
    effectiveDraftRef,
    canAcceptUserMutation,
    markUserDraftMutation,
  );
  const [layerVisibility, setLayerVisibility, setLayerVisibilityRaw] = useUserDraftState<EditorLayerVisibility>(
    normalizeEditorLayerVisibility(d.layerVisibility),
    "layerVisibility",
    effectiveDraftRef,
    canAcceptUserMutation,
    markUserDraftMutation,
  );
  const [headlineHook, setHeadlineHook, setHeadlineHookRaw] = useUserDraftState<HeadlineHookConfig | undefined>(
    normalizeHeadlineHook(d.headlineHook) ?? undefined,
    "headlineHook",
    effectiveDraftRef,
    canAcceptUserMutation,
    markUserDraftMutation,
  );
  // ── Mix preset (D5.1) — persisted project choices remain authoritative. A brand-new
  // paid project is seeded as "recommended" before its POST (see bootstrap below),
  // independently from the legacy internal managed-KIE gate. ──
  const [mixPreset, setMixPresetFromUser, setMixPresetRaw] = useUserDraftState<MixPreset>(
    d.mixPreset ?? "free", "mixPreset", effectiveDraftRef, canAcceptUserMutation, markUserDraftMutation,
  );
  /** เลือก preset → ขับ mixPreset + brollSource + autoMixProviders ให้สอดคล้องกัน
   *  (preset ≠ ฟรีล้วน ⇒ automix + provider set รวม kie-ai). weights ที่ส่งไป server
   *  มาจาก PRESET_WEIGHTS ใน useV2Job. */
  const setMixPreset = useCallback((preset: MixPreset) => {
    if (!canAcceptUserMutation()) return;
    setBrollSourceRaw(presetBrollSource(preset));
    const provs = PRESET_PROVIDERS[preset];
    if (provs) setAutoMixProvidersRaw(provs);
    setMixPresetFromUser(preset);
  }, [canAcceptUserMutation, setAutoMixProvidersRaw, setBrollSourceRaw, setMixPresetFromUser]);

  function buildDraft(): V2Draft {
    return {
      mode, narrativeSourceKind, script, clipUrl, clipDurationSec, brollSource, voiceEngine, geminiVoiceName, voiceId, omniVoiceId,
      projectTitle,
      musicTrack, musicTrackKind, bgmVolume, useAvatar, avatarId,
      musicMoodDefault: musicMoodDefaultHint,
      targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs,
      kieModel, autoMixProviders, mixPreset, brollRegionPreference, brollVisualStyle,
      logoOverlay, brandSubtitleDefault, layerVisibility,
      ...headlineHookDraftFragment(headlineHook),
    };
  }

  function applyDraft(next: V2Draft) {
    draftRef.current = next;
    if (next.projectTitle !== undefined) setProjectTitleRaw(next.projectTitle || DEFAULT_PROJECT.projectTitle);
    if (next.mode) setModeRaw(next.mode);
    if (next.narrativeSourceKind) setNarrativeSourceKindRaw(next.narrativeSourceKind);
    if (next.script !== undefined) setScriptRaw(next.script);
    if (next.clipUrl !== undefined) setClipUrlStateRaw(next.clipUrl);
    if (next.clipDurationSec !== undefined) {
      setClipDurationSecStateRaw(Number.isFinite(next.clipDurationSec) && next.clipDurationSec > 0
        ? next.clipDurationSec
        : 0);
    }
    if (next.brollSource) setBrollSourceRaw(next.brollSource);
    if (next.voiceEngine) setVoiceEngineRaw(parseTtsProvider(next.voiceEngine));
    if (next.geminiVoiceName !== undefined) setGeminiVoiceNameRaw(next.geminiVoiceName);
    if (next.voiceId !== undefined) setVoiceIdRaw(next.voiceId);
    if (next.omniVoiceId !== undefined) setOmniVoiceIdRaw(next.omniVoiceId);
    if (next.musicTrack !== undefined) setMusicTrackRaw(next.musicTrack);
    if (next.musicTrackKind) setMusicTrackKindRaw(next.musicTrackKind);
    // Style Pack default track: decideMusicMoodHintCarry() is the single pure
    // decision of whether this draft's mood hint is still "pending" (a hint
    // exists and no track is chosen yet — "" or absent; never `null`, which is
    // an explicit "no music" the creator already decided). While pending, the
    // hint is mirrored into state (musicMoodDefaultHint) so every subsequent
    // buildDraft()/autosave keeps carrying it until a pick actually lands —
    // fixing the race where an early autosave could otherwise drop the hint
    // for good. Resolves immediately if the system track list is already
    // loaded, else the fetch effect resolves it once it lands.
    const moodHintDecision = decideMusicMoodHintCarry({
      musicMoodDefault: next.musicMoodDefault,
      musicTrack: next.musicTrack,
    });
    if (moodHintDecision.carry) {
      setMusicMoodDefaultHintRaw(moodHintDecision.mood);
      pendingMusicMoodDefaultRef.current = moodHintDecision.mood;
      applyMusicMoodDefaultIfPending();
    } else {
      setMusicMoodDefaultHintRaw(null);
      pendingMusicMoodDefaultRef.current = null;
    }
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
    setBrandSubtitleDefaultRaw(normalizeSubtitleStylePresetConfig(next.brandSubtitleDefault) ?? undefined);
    setLayerVisibilityRaw(normalizeEditorLayerVisibility(next.layerVisibility));
    setHeadlineHookRaw(normalizeHeadlineHook(next.headlineHook) ?? undefined);
  }

  // ── Autosave status (topbar hint) — observes the debounced persist effect below;
  //    "idle" until the first user-driven change, then "saving" → "saved". ──
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveRevision, setSaveRevision] = useState(0);
  const [bootstrapRetryRevision, setBootstrapRetryRevision] = useState(0);
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
    if (canRunProjectOperation()) setSaveRevision((revision) => revision + 1);
  }, [canRunProjectOperation]);
  const mountedRef = useRef(false);
  const currentProjectIdRef = useRef<string | null>(projectId);
  currentProjectIdRef.current = projectId;
  const projectDraftFlushWaitersRef = useRef<Array<{
    projectId: string;
    resolve: (saved: boolean) => void;
  }>>([]);

  function projectDraftIsDurable(expectedProjectId: string): boolean {
    const tracker = autosaveLineageRef.current;
    return currentProjectIdRef.current === expectedProjectId
      && projectReadyRef.current
      && recoveryRef.current.status === "none"
      && tracker?.projectId === expectedProjectId
      && !tracker.blocked
      && (
        !tracker.latestLocal
        || tracker.latestLocal.fingerprint === tracker.confirmed.fingerprint
      );
  }

  function settleProjectDraftFlushWaiters(projectId: string | null, saved: boolean): void {
    const pending = projectDraftFlushWaitersRef.current;
    projectDraftFlushWaitersRef.current = [];
    for (const waiter of pending) {
      if (projectId !== null && waiter.projectId !== projectId) {
        projectDraftFlushWaitersRef.current.push(waiter);
      } else {
        waiter.resolve(saved);
      }
    }
  }

  const flushPendingProjectDraft = useCallback(async (): Promise<boolean> => {
    const flushProjectId = currentProjectIdRef.current;
    if (!flushProjectId || !canRunProjectOperation()) return false;
    await editorProjectSaveQueue.whenIdle(flushProjectId);
    if (
      currentProjectIdRef.current !== flushProjectId
      || !canRunProjectOperation()
    ) return false;
    if (projectDraftIsDurable(flushProjectId)) return true;
    return new Promise<boolean>((resolve) => {
      projectDraftFlushWaitersRef.current.push({ projectId: flushProjectId, resolve });
      setSaveStatus("saving");
      setSaveRevision((revision) => revision + 1);
    });
  }, [canRunProjectOperation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settleProjectDraftFlushWaiters(null, false);
      autosaveLineageRef.current?.issued.clear();
      autosaveGenerationRef.current += 1;
      autosaveLineageRef.current = null;
      latestDraftRef.current = null;
      stagedUserDraftMutationTokenRef.current = 0;
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
  /** รายชื่อเสียง OmniVoice · null = ยังไม่โหลด, [] = โหลดไม่สำเร็จ */
  const [omniVoices, setOmniVoices] = useState<V2OmniVoice[] | null>(null);
  const omniVoiceAvailability = useOmniVoiceAvailability();
  const omniVoiceEnabled = omniVoiceAvailability === true;
  const canUploadOwnMedia = plan === "PRO" || plan === "BUSINESS";
  // Brand Visual sells production capacity and profile count, not the ability
  // to express the profile. Treatment Free accounts may therefore inherit and
  // override their Brand Mark just like paid accounts. R12: the logo overlay
  // stays a PRO/BUSINESS-plan feature, so this reads the ADMITTED pin — every
  // plan can now pin without funding it, and a bare pin must not widen the
  // logo gate (mirrors `projectHasAdmittedPersistedPin` on the server).
  const logoEligible = brandVisualAllowed || hasAdmittedVisualPin || plan === "PRO" || plan === "BUSINESS";

  function clearProjectRecoveryData(clearProjectId: string): void {
    const storage = browserStorage();
    clearEditorProjectRecoveryJournal(storage, clearProjectId);
    try {
      const pointerKeys = new Set([PROJECT_ID_KEY, projectIdStorageKeyRef.current]);
      if ([...pointerKeys].some((key) => storage?.getItem(key) === clearProjectId)) {
        storage?.removeItem(DRAFT_KEY);
      }
    } catch { /* legacy cleanup is best-effort */ }
  }

  function applyServerProjectMetadata(project: Record<string, unknown>): void {
    setProjectStatus(typeof project.status === "string" ? project.status as ProjectStatus : "draft");
    setActiveJobId(typeof project.activeJobId === "string" ? project.activeJobId : null);
    setActiveExportJobId(typeof project.activeExportJobId === "string" ? project.activeExportJobId : null);
    setLatestVideoId(typeof project.latestVideoId === "string" ? project.latestVideoId : null);
    setPreviewMediaState((project.previewMediaState as ProjectMediaState | null | undefined) ?? null);
    setHasPersistedVisualPin(project.hasPersistedVisualPin === true);
    setHasAdmittedVisualPin(project.hasAdmittedVisualPin === true);
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
    settleProjectDraftFlushWaiters(null, false);
    autosaveLineageRef.current?.issued.clear();
    autosaveGenerationRef.current += 1;
    autosaveLineageRef.current = null;
    latestDraftRef.current = null;
    stagedUserDraftMutationTokenRef.current = 0;
  }, []);

  const invalidateLocalChoiceRequest = useCallback(() => {
    localChoiceGenerationRef.current += 1;
    localChoiceAbortControllerRef.current?.abort();
    localChoiceAbortControllerRef.current = null;
  }, []);

  const completeArchivedProject = useCallback((archivedProjectId: string): boolean => {
    if (!archivedProjectId || currentProjectIdRef.current !== archivedProjectId) return false;
    invalidateLocalChoiceRequest();
    invalidateAutosaveLineage();
    bootstrapGenerationRef.current += 1;
    bootstrapAbortControllerRef.current?.abort();
    bootstrapAbortControllerRef.current = null;
    trustedResumeDraftRef.current = null;
    clearProjectRecoveryData(archivedProjectId);
    currentProjectIdRef.current = null;
    setProjectId(null);
    setProjectReady(false);
    setRecoveryState({ status: "none" });
    setProjectInitialization("loading-defaults");
    try {
      const storage = browserStorage();
      storage?.removeItem(projectIdStorageKeyRef.current);
      storage?.removeItem(PROJECT_ID_KEY);
      storage?.removeItem(DRAFT_KEY);
    } catch {}
    return true;
  }, [invalidateAutosaveLineage, invalidateLocalChoiceRequest, setProjectInitialization, setRecoveryState]);

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
    autosaveLineageRef.current?.issued.clear();
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
    stagedUserDraftMutationTokenRef.current = 0;
    editorProjectSaveQueue.seedRevision(nextProjectId, confirmed.revision);
    return tracker;
  }, []);

  /** Adopt a server mutation that atomically changed both project semantics
   * and draft defaults (for example a Brand Revision pin). Rebase the local
   * autosave lineage before another debounced write can replay the stale draft
   * over that transaction. */
  function acceptAuthoritativeProjectSnapshot(project: Record<string, unknown>): boolean {
    const currentId = currentProjectIdRef.current;
    if (!currentId || project.id !== currentId) return false;
    const candidate = serverCandidateForProject(currentId, project);
    if (!candidate || candidate.revision === null) return false;
    const previousTracker = autosaveLineageRef.current;
    const pendingLocal = previousTracker
      && previousTracker.projectId === currentId
      && !previousTracker.blocked
      && previousTracker.latestLocal
      && previousTracker.latestLocal.fingerprint !== previousTracker.confirmed.fingerprint
      ? previousTracker.latestLocal
      : null;
    const rebasedLocal = pendingLocal && previousTracker
      ? createEditorProjectAutosaveCandidate({
          projectId: currentId,
          revision: candidate.revision,
          draft: rebasePendingUserDraft(
            previousTracker.confirmed.draft as V2Draft,
            pendingLocal.draft as V2Draft,
            candidate.draft as V2Draft,
          ),
        })
      : null;
    if (pendingLocal && !rebasedLocal) return false;
    invalidateLocalChoiceRequest();
    trustedResumeDraftRef.current = null;
    applyDraft((rebasedLocal?.draft ?? candidate.draft) as V2Draft);
    const tracker = initializeAutosaveLineage(currentId, candidate);
    if (!tracker) return false;
    if (rebasedLocal) {
      tracker.latestLocal = rebasedLocal;
      latestDraftRef.current = rebasedLocal;
      stagedUserDraftMutationTokenRef.current = userDraftMutationTokenRef.current;
      writeEditorProjectRecoveryJournal(browserStorage(), {
        version: 1,
        projectId: currentId,
        baseRevision: candidate.revision,
        editedAt: new Date().toISOString(),
        draft: rebasedLocal.draft,
      });
    } else {
      lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
    }
    latestQueuedSaveRef.current = { projectId: null, revision: null };
    applyServerProjectMetadata(project);
    if (!rebasedLocal) clearProjectRecoveryData(currentId);
    setProjectReady(true);
    setProjectInitialization("ready");
    setSaveStatus(rebasedLocal ? "saving" : "saved");
    setRecoveryState({ status: "none" });
    if (rebasedLocal) setSaveRevision((revision) => revision + 1);
    return true;
  }

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
    pruneIssuedAutosaveSnapshotsThrough(tracker, candidate.revision);
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
    tracker.issued.clear();
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

  const stageExplicitUserDraftMutation = useCallback((): void => {
    const projectId = currentProjectIdRef.current;
    const tracker = autosaveLineageRef.current;
    if (
      !mountedRef.current
      || !projectReadyRef.current
      || recoveryRef.current.status !== "none"
      || !projectId
      || !tracker
      || tracker.projectId !== projectId
      || tracker.blocked
    ) return;
    let latestLocal: EditorProjectAutosaveCandidate | null = null;
    try {
      latestLocal = createEditorProjectAutosaveCandidate({
        projectId,
        revision: tracker.confirmed.revision,
        draft: canonicalizeDraftLogoOverlay(effectiveDraftRef.current),
      });
    } catch {
      latestLocal = null;
    }
    if (!latestLocal) {
      tracker.blocked = true;
      tracker.issued.clear();
      tracker.latestLocal = null;
      latestDraftRef.current = null;
      stagedUserDraftMutationTokenRef.current = userDraftMutationTokenRef.current;
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
    stagedUserDraftMutationTokenRef.current = userDraftMutationTokenRef.current;
    const journalWritten = writeEditorProjectRecoveryJournal(browserStorage(), {
      version: 1,
      projectId,
      baseRevision: tracker.confirmed.revision,
      editedAt: new Date().toISOString(),
      draft: latestLocal.draft,
    });
    if (!journalWritten) clearEditorProjectRecoveryJournal(browserStorage(), projectId);
  }, [setRecoveryState]);
  stageExplicitUserDraftMutationRef.current = stageExplicitUserDraftMutation;

  const createServerProject = useCallback(async (
    draft: V2Draft,
    options: { isCurrent?: () => boolean; signal?: AbortSignal } = {},
  ) => {
    const isCurrent = options.isCurrent ?? (() => true);
    const failOwnedCreation = () => {
      if (!isCurrent() || options.signal?.aborted) return;
      setProjectReady(false);
      setProjectInitialization("error");
      setSaveStatus("error");
      setRecoveryState({ status: "load-error", message: "สร้างโปรเจกต์ไม่สำเร็จ กรุณาลองใหม่" });
    };
    try {
      const res = await authenticatedFetch("/api/editor-projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.projectTitle ?? DEFAULT_PROJECT.projectTitle, draft }),
        signal: options.signal,
      });
      if (!isCurrent()) return null;
      if (!res.ok) {
        failOwnedCreation();
        return null;
      }
      const data = await res.json();
      if (!isCurrent()) return null;
      const id = typeof data?.project?.id === "string" ? data.project.id : null;
      if (!id) {
        failOwnedCreation();
        return null;
      }
      const createdProject = data.project as Record<string, unknown>;
      const serverCandidate = serverCandidateForProject(id, createdProject);
      if (!serverCandidate || !initializeAutosaveLineage(id, serverCandidate)) {
        failOwnedCreation();
        return null;
      }
      setProjectId(id);
      setProjectReady(true);
      setProjectInitialization("ready");
      setRecoveryState({ status: "none" });
      if (typeof data?.project?.status === "string") setProjectStatus(data.project.status as ProjectStatus);
      setActiveJobId(typeof data?.project?.activeJobId === "string" ? data.project.activeJobId : null);
      setActiveExportJobId(typeof data?.project?.activeExportJobId === "string" ? data.project.activeExportJobId : null);
      setLatestVideoId(typeof data?.project?.latestVideoId === "string" ? data.project.latestVideoId : null);
      setPreviewMediaState((data?.project?.previewMediaState as ProjectMediaState | null | undefined) ?? null);
      try {
        const storage = browserStorage();
        storage?.setItem(projectIdStorageKeyRef.current, id);
        if (projectIdStorageKeyRef.current !== PROJECT_ID_KEY) storage?.removeItem(PROJECT_ID_KEY);
        storage?.removeItem(DRAFT_KEY);
      } catch {}
      return id;
    } catch {
      failOwnedCreation();
      return null;
    }
  }, [initializeAutosaveLineage, setProjectInitialization, setRecoveryState]);

  const resetProject = useCallback(async (): Promise<string | null> => {
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
    setProjectReady(false);
    setProjectInitialization("loading-defaults");
    let accountDefault: LogoOverlayConfig | null;
    let accountVideoDefaults: AccountVideoDefaults;
    try {
      [accountDefault, accountVideoDefaults] = await Promise.all([
        loadAccountLogoDefault(),
        loadAccountVideoDefaults(),
      ]);
    } catch {
      if (!isCurrentReset()) return null;
      setProjectInitialization("error");
      setSaveStatus("error");
      setRecoveryState({ status: "load-error", message: "โหลดค่าเริ่มต้นไม่สำเร็จ กรุณาลองใหม่" });
      return null;
    }
    if (!isCurrentReset()) return null;
    setProjectInitialization("creating-project");
    const nextPreset = recommendedAutoMixDefault ? "recommended" : DEFAULT_PROJECT.mixPreset;
    const inherited = logoOverlayForNewProject({
      hasExistingDraft: false,
      accountDefault,
    });
    const nextDraft: V2Draft = {
      ...DEFAULT_PROJECT,
      autoMixProviders: [...(PRESET_PROVIDERS[nextPreset] ?? DEFAULT_PROJECT.autoMixProviders)],
      brollSource: presetBrollSource(nextPreset),
      mixPreset: nextPreset,
      voiceEngine: accountVideoDefaults.voiceEngine,
      geminiVoiceName: accountVideoDefaults.geminiVoiceName,
      voiceId: accountVideoDefaults.voiceId,
      omniVoiceId: DEFAULT_PROJECT.omniVoiceId,
      avatarId: accountVideoDefaults.avatarId,
      ...(inherited ? { logoOverlay: inherited } : {}),
    };
    draftRef.current = nextDraft;
    lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
    lastHandledSaveRevisionRef.current = saveRevision;
    latestQueuedSaveRef.current = { projectId: null, revision: null };
    if (projectId) clearProjectRecoveryData(projectId);
    setProjectId(null);
    setRecoveryState({ status: "none" });
    setProjectStatus("draft");
    setActiveJobId(null);
    setActiveExportJobId(null);
    setLatestVideoId(null);
    setPreviewMediaState(null);
    try {
      const storage = browserStorage();
      storage?.removeItem(DRAFT_KEY);
      storage?.removeItem(projectIdStorageKeyRef.current);
      storage?.removeItem(PROJECT_ID_KEY);
    } catch {}

    setModeRaw(DEFAULT_PROJECT.mode);
    setProjectTitleRaw(DEFAULT_PROJECT.projectTitle);
    setScriptRaw(DEFAULT_PROJECT.script);
    setClipUrlStateRaw(DEFAULT_PROJECT.clipUrl);
    setClipDurationSecStateRaw(DEFAULT_PROJECT.clipDurationSec);
    setVoiceEngineRaw(accountVideoDefaults.voiceEngine);
    setGeminiVoiceNameRaw(accountVideoDefaults.geminiVoiceName);
    setVoiceIdRaw(accountVideoDefaults.voiceId);
    setOmniVoiceIdRaw(DEFAULT_PROJECT.omniVoiceId);
    setMusicTrackRaw(DEFAULT_PROJECT.musicTrack);
    setMusicTrackKindRaw(DEFAULT_PROJECT.musicTrackKind);
    setBgmVolumeRaw(DEFAULT_PROJECT.bgmVolume);
    setUseAvatarRaw(DEFAULT_PROJECT.useAvatar);
    setAvatarIdRaw(accountVideoDefaults.avatarId);
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
    setBrandSubtitleDefaultRaw(undefined);
    setLayerVisibilityRaw(normalizeEditorLayerVisibility(nextDraft.layerVisibility));
    setHeadlineHookRaw(undefined);
    setSaveStatus("idle");
    return await createServerProject(nextDraft, {
      isCurrent: isCurrentReset,
      signal: resetController.signal,
    });
  }, [createServerProject, invalidateAutosaveLineage, invalidateLocalChoiceRequest, projectId, recommendedAutoMixDefault, saveRevision, setProjectInitialization, setRecoveryState]);

  useEffect(() => {
    let alive = true;
    invalidateLocalChoiceRequest();
    invalidateAutosaveLineage();
    const generation = bootstrapGenerationRef.current + 1;
    bootstrapGenerationRef.current = generation;
    bootstrapAbortControllerRef.current?.abort();
    const controller = new AbortController();
    bootstrapAbortControllerRef.current = controller;
    setProjectReady(false);
    setProjectInitialization("loading-defaults");
    const isCurrentBootstrap = () => alive
      && mountedRef.current
      && bootstrapGenerationRef.current === generation
      && bootstrapAbortControllerRef.current === controller
      && !controller.signal.aborted;
    async function ensureServerProject() {
      const storage = browserStorage();
      try {
        const rememberedAccountId = storage?.getItem(PROJECT_ACCOUNT_KEY) ?? null;
        projectIdStorageKeyRef.current = scopedProjectIdKey(rememberedAccountId);
      } catch {}
      const storedLocalDraft = loadDraft();
      const searchParams = new URLSearchParams(window.location.search);
      const urlProjectId = searchParams.get("projectId");
      if (searchParams.get("empty") === "1" && !urlProjectId) {
        accountDraftDefaultsAllowedRef.current = false;
        trustedResumeDraftRef.current = null;
        setProjectId(null);
        setProjectReady(false);
        setProjectStatus("draft");
        setActiveJobId(null);
        setActiveExportJobId(null);
        setLatestVideoId(null);
        setPreviewMediaState(null);
        setSaveStatus("idle");
        setRecoveryState({ status: "none" });
        setProjectInitialization("empty");
        try {
          storage?.removeItem(PROJECT_ID_KEY);
          storage?.removeItem(projectIdStorageKeyRef.current);
          storage?.removeItem(DRAFT_KEY);
        } catch {}
        return;
      }
      let storedProjectId: string | null = null;
      try {
        storedProjectId = storage?.getItem(projectIdStorageKeyRef.current)
          ?? storage?.getItem(PROJECT_ID_KEY)
          ?? null;
      } catch {}
      let existingProjectId = urlProjectId || storedProjectId;

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
          response = await authenticatedFetch(
            `/api/editor-projects/${encodeURIComponent(existingProjectId)}`,
            { cache: "no-store", signal: controller.signal },
          );
        } catch { /* handled by the fail-closed branch */ }
        if (!isCurrentBootstrap()) return;
        // A 404 from an implicit browser pointer is stale local state, not a broken
        // account. Clear only that pointer, then recover to the most recent active
        // project. Explicit URL links remain fail-closed and 5xx/network errors retain
        // the pointer so Retry targets the same project.
        if (response?.status === 404 && !urlProjectId && storedProjectId === existingProjectId) {
          const staleProjectId = existingProjectId;
          let listResponse: Response | null = null;
          try {
            listResponse = await authenticatedFetch("/api/editor-projects", {
              cache: "no-store",
              signal: controller.signal,
            });
          } catch { /* visible load error below */ }
          if (!isCurrentBootstrap()) return;
          const listPayload = listResponse?.ok
            ? await listResponse.json().catch(() => null)
            : null;
          if (!isCurrentBootstrap()) return;
          if (listResponse?.ok) {
            // Only forget the stale pointer once the authoritative list is available.
            // If listing itself is down, keeping it gives Retry deterministic provenance
            // instead of falling through and auto-creating an unrelated project.
            clearEditorProjectRecoveryJournal(storage, staleProjectId);
            try {
              for (const key of new Set([PROJECT_ID_KEY, projectIdStorageKeyRef.current])) {
                if (storage?.getItem(key) === staleProjectId) storage.removeItem(key);
              }
              storage?.removeItem(DRAFT_KEY);
            } catch {}

            const fallbackIds = Array.isArray(listPayload?.projects)
              ? listPayload.projects.flatMap((item: unknown) => (
                  !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
                    ? [(item as { id: string }).id]
                    : []
                ))
              : [];
            let selectedFallback = false;
            let retryFallback = false;
            for (const fallbackId of fallbackIds) {
              let candidateResponse: Response | null = null;
              try {
                candidateResponse = await authenticatedFetch(
                  `/api/editor-projects/${encodeURIComponent(fallbackId)}`,
                  { cache: "no-store", signal: controller.signal },
                );
              } catch { candidateResponse = null; }
              if (!isCurrentBootstrap()) return;
              if (candidateResponse?.ok) {
                existingProjectId = fallbackId;
                response = candidateResponse;
                selectedFallback = true;
                break;
              }
              if (!candidateResponse || candidateResponse.status !== 404) {
                // The list says this project is active, but its detail endpoint is
                // temporarily unavailable. Retain it as the exact Retry target.
                existingProjectId = fallbackId;
                response = candidateResponse;
                retryFallback = true;
                try { storage?.setItem(projectIdStorageKeyRef.current, fallbackId); } catch {}
                break;
              }
            }
            if (selectedFallback || retryFallback) {
              setProjectId(existingProjectId);
            } else {
              currentProjectIdRef.current = null;
              setProjectId(null);
              setProjectReady(false);
              setProjectStatus("draft");
              setActiveJobId(null);
              setActiveExportJobId(null);
              setLatestVideoId(null);
              setPreviewMediaState(null);
              setSaveStatus("idle");
              setRecoveryState({ status: "none" });
              setProjectInitialization("empty");
              return;
            }
          }
        }
        if (!response || !response.ok) {
          setProjectReady(false);
          setProjectInitialization("error");
          setSaveStatus("error");
          setRecoveryState({
            status: "load-error",
            message: response?.status === 404
              ? "ไม่พบโปรเจกต์นี้ กรุณาตรวจสอบลิงก์หรือลองใหม่"
              : "โหลดโปรเจกต์ไม่สำเร็จ กรุณาลองใหม่",
          });
          return;
        }
        if (!existingProjectId) return;
        const resolvedProjectId = existingProjectId;
        const data = await response.json().catch(() => null);
        if (!isCurrentBootstrap()) return;
        const project = data?.project as Record<string, unknown> | null | undefined;
        if (
          !project
          || project.id !== resolvedProjectId
          || typeof project.draftRevision !== "number"
          || !Number.isSafeInteger(project.draftRevision)
          || project.draftRevision < 0
          || project.draftRevision > 2_147_483_647
        ) {
          setProjectReady(false);
          setProjectInitialization("error");
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
          return;
        }
        const journal = readEditorProjectRecoveryJournal(storage, resolvedProjectId);
        const legacyLocalDraft = storedProjectId === resolvedProjectId && storedLocalDraft
          ? canonicalizeDraftLogoOverlay(storedLocalDraft)
          : null;
        const decision = decideEditorProjectBootstrap({
          projectId: resolvedProjectId,
          serverRevision: project.draftRevision,
          revisionWatermark: editorProjectSaveQueue.revisionWatermark(resolvedProjectId),
          journal,
          legacyLocalDraft,
        });
        const serverCandidate = serverCandidateForProject(resolvedProjectId, project);
        if (!serverCandidate) {
          setProjectReady(false);
          setProjectInitialization("error");
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
          return;
        }
        editorProjectSaveQueue.seedRevision(project.id as string, project.draftRevision);
        const tracker = initializeAutosaveLineage(resolvedProjectId, serverCandidate);
        if (!tracker) {
          setProjectReady(false);
          setProjectInitialization("error");
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "ข้อมูลโปรเจกต์ไม่สมบูรณ์ กรุณาลองใหม่" });
          return;
        }
        setProjectId(project.id as string);
        applyServerProjectMetadata(project);
        try {
          storage?.setItem(projectIdStorageKeyRef.current, project.id as string);
          if (projectIdStorageKeyRef.current !== PROJECT_ID_KEY) storage?.removeItem(PROJECT_ID_KEY);
        } catch {}

        if (decision.kind === "server") {
          trustedResumeDraftRef.current = null;
          applyDraft(serverCandidate.draft as V2Draft);
          clearProjectRecoveryData(resolvedProjectId);
          lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
          setRecoveryState({ status: "none" });
          setProjectReady(true);
          setProjectInitialization("ready");
          setSaveStatus("idle");
          return;
        }
        if (decision.kind === "resume-local") {
          const localCandidate = createRecoveryCandidate({
            projectId: resolvedProjectId,
            draft: decision.journal.draft,
            revision: decision.journal.baseRevision,
            updatedAt: decision.journal.editedAt,
            trusted: true,
          });
          if (!localCandidate) {
            setProjectReady(false);
            setProjectInitialization("error");
            setSaveStatus("error");
            setRecoveryState({ status: "load-error", message: "ข้อมูลกู้คืนไม่สมบูรณ์ กรุณาลองใหม่" });
            return;
          }
          trustedResumeDraftRef.current = localCandidate.draft as V2Draft;
          tracker.latestLocal = createEditorProjectAutosaveCandidate({
            projectId: resolvedProjectId,
            revision: tracker.confirmed.revision,
            draft: localCandidate.draft,
          });
          applyDraft(localCandidate.draft as V2Draft);
          lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
          setRecoveryState({ status: "none" });
          setProjectReady(true);
          setProjectInitialization("ready");
          setSaveStatus("saving");
          setSaveRevision((value) => value + 1);
          return;
        }
        if (decision.kind === "conflict") {
          trustedResumeDraftRef.current = null;
          const localCandidate = createRecoveryCandidate({
            projectId: resolvedProjectId,
            draft: decision.local.draft,
            revision: journal?.baseRevision ?? null,
            updatedAt: decision.local.editedAt,
            trusted: decision.local.trusted,
          });
          setProjectReady(false);
          setProjectInitialization("ready");
          tracker.blocked = true;
          if (!localCandidate) {
            setProjectInitialization("error");
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
          setProjectInitialization("error");
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
      if (hasLocalDraft) accountDraftDefaultsAllowedRef.current = false;
      const seedDraft = hasLocalDraft ? localDraft : buildDraft();
      if (!hasLocalDraft) {
        let accountDefault: LogoOverlayConfig | null;
        let accountVideoDefaults: AccountVideoDefaults;
        let account: MeData | null;
        try {
          [accountDefault, accountVideoDefaults, account] = await Promise.all([
            loadAccountLogoDefault(),
            loadAccountVideoDefaults(),
            fetchMe(),
          ]);
        } catch {
          if (!isCurrentBootstrap()) return;
          setProjectReady(false);
          setProjectInitialization("error");
          setSaveStatus("error");
          setRecoveryState({ status: "load-error", message: "โหลดค่าเริ่มต้นไม่สำเร็จ กรุณาลองใหม่" });
          return;
        }
        if (!isCurrentBootstrap()) return;
        seedDraft.voiceEngine = accountVideoDefaults.voiceEngine;
        seedDraft.geminiVoiceName = accountVideoDefaults.geminiVoiceName;
        seedDraft.voiceId = accountVideoDefaults.voiceId;
        seedDraft.avatarId = accountVideoDefaults.avatarId;
        const initialPreset = account?.recommendedAutoMixDefault === true
          ? "recommended"
          : DEFAULT_PROJECT.mixPreset;
        seedDraft.mixPreset = initialPreset;
        seedDraft.brollSource = presetBrollSource(initialPreset);
        seedDraft.autoMixProviders = [
          ...(PRESET_PROVIDERS[initialPreset] ?? DEFAULT_PROJECT.autoMixProviders),
        ];
        const inherited = logoOverlayForNewProject({ hasExistingDraft: false, accountDefault });
        if (inherited) seedDraft.logoOverlay = inherited;
      }
      const canonicalSeedDraft = canonicalizeDraftLogoOverlay(seedDraft);
      if (!isCurrentBootstrap()) return;
      applyDraft(canonicalSeedDraft);
      trustedResumeDraftRef.current = null;
      lastPersistedUserMutationTokenRef.current = userDraftMutationTokenRef.current;
      setProjectInitialization("creating-project");
      const id = await createServerProject(canonicalSeedDraft, {
        isCurrent: isCurrentBootstrap,
        signal: controller.signal,
      });
      if (!isCurrentBootstrap() || !id) return;
      try {
        storage?.setItem(projectIdStorageKeyRef.current, id);
        if (projectIdStorageKeyRef.current !== PROJECT_ID_KEY) storage?.removeItem(PROJECT_ID_KEY);
      } catch {}
    }
    void ensureServerProject();
    return () => {
      alive = false;
      controller.abort();
      if (bootstrapGenerationRef.current === generation) bootstrapGenerationRef.current += 1;
    };
    // Server project bootstrap should run once. Subsequent field autosaves are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createServerProject, bootstrapRetryRevision, invalidateAutosaveLineage, invalidateLocalChoiceRequest, setProjectInitialization]);

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
      const response = await authenticatedFetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
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
      const res = await authenticatedFetch(`/api/editor-projects/${encodeURIComponent(projectId)}`, {
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
      if (res.status === 422 && payload?.error === "brand_asset_unavailable") {
        setRecoveryState({
          ...conflict,
          resolving: false,
          error: "ไม่พบไฟล์โลโก้เดิม กรุณาอัปโหลดโลโก้ใหม่แล้วเลือกอีกครั้ง",
        });
        return;
      }
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
    const requestGeneration = localChoiceGenerationRef.current + 1;
    localChoiceGenerationRef.current = requestGeneration;
    const controller = new AbortController();
    localChoiceAbortControllerRef.current = controller;
    const stillCurrentRefresh = () => mountedRef.current
      && currentProjectIdRef.current === projectId
      && localChoiceGenerationRef.current === requestGeneration
      && localChoiceAbortControllerRef.current === controller
      && !controller.signal.aborted
      && recoveryRef.current.status === "conflict"
      && recoveryRef.current.local === conflict.local
      && recoveryRef.current.server === conflict.server
      && recoveryRef.current.resolving === "refresh"
      && recoveryRef.current.requiresServerRefresh;
    setRecoveryState({ ...conflict, resolving: "refresh", error: null });
    await refreshConflictAfterAmbiguousWrite(projectId, conflict, {
      signal: controller.signal,
      isCurrent: stillCurrentRefresh,
    });
    if (localChoiceAbortControllerRef.current === controller) {
      localChoiceAbortControllerRef.current = null;
    }
  }, [invalidateLocalChoiceRequest, refreshConflictAfterAmbiguousWrite, setRecoveryState]);

  // ค่า default จริงของผู้ใช้ (เหมือน init ของ legacy editor) — ไม่ทับค่าที่ draft จำไว้
  useEffect(() => {
    authenticatedFetch("/api/user/video-settings").then(r => r.json()).then(s => {
      if (!accountDraftDefaultsAllowedRef.current) return;
      const hadDraft = Object.keys(draftRef.current).length > 0;
      if (!hadDraft) {
        if (s.heygenAvatarId) setAvatarIdRaw(s.heygenAvatarId);
        if (s.elevenlabsVoiceId) setVoiceIdRaw(s.elevenlabsVoiceId);
        setVoiceEngineRaw(visibleTtsProvider(s.ttsProvider));
        if (s.geminiVoiceName) setGeminiVoiceNameRaw(s.geminiVoiceName);
      } else {
        // เติมเฉพาะช่องที่ draft ไม่มีค่า
        if (s.heygenAvatarId && !draftRef.current.avatarId) setAvatarIdRaw(s.heygenAvatarId);
        if (s.elevenlabsVoiceId && !draftRef.current.voiceId) setVoiceIdRaw(s.elevenlabsVoiceId);
      }
    }).catch(() => {});
    fetchClientJson<V2Usage>("/api/videos/usage").then(r => r.ok ? r.data : null).then(u => {
      if (u) setUsage(u);
    }).catch(() => {});
    fetchMe().then(m => {
      const accountId = typeof m?.id === "string" && m.id ? m.id : null;
      if (accountId) {
        const storage = browserStorage();
        projectIdStorageKeyRef.current = scopedProjectIdKey(accountId);
        try {
          storage?.setItem(PROJECT_ACCOUNT_KEY, accountId);
          if (projectReadyRef.current && currentProjectIdRef.current) {
            storage?.setItem(projectIdStorageKeyRef.current, currentProjectIdRef.current);
            storage?.removeItem(PROJECT_ID_KEY);
          }
        } catch {}
      }
      const admin = m?.role === "ADMIN";
      const internalTester = m?.internalAiTester === true;
      const heroBeta = m?.heroAiBeta === true;
      const heroImageEligible = m?.heroAiImageEligible === true;
      const trialEndMs = typeof m?.trialEndsAt === "string" ? Date.parse(m.trialEndsAt) : Number.NaN;
      const internalAdmin = admin && internalTester;
      setInternalAiTester(internalTester);
      setHeroAiBeta(heroBeta);
      setHeroAiImageEligible(heroImageEligible);
      setHeroAiImageAccess(m?.featureAccess?.heroAiImage ?? null);
      setBrandVisualAllowed(resolveBrandVisualClientAccess(m));
      setBrandLibraryAllowed(resolveBrandLibraryClientAccess(m));
      setBrandVisualCohort(m?.brandVisualCohort ?? "off");
      setBrandVisualRolloutBucket(typeof m?.brandVisualRolloutBucket === "number" ? m.brandVisualRolloutBucket : null);
      setStarterAiImageAllowance(m?.starterAiImageAllowance ?? null);
      setIsActiveTrial(Number.isFinite(trialEndMs) && trialEndMs > Date.now());
      setPlan(typeof m?.plan === "string" ? m.plan : "FREE");
      // Managed-kie: paid (PRO/BUSINESS) users un-gated for AI image sources when
      // the flags are on. Server (fetch-stock) is authoritative; this is UX only.
      const paid = !!m?.kiePaidUnlocked;
      const recommendedDefault = m?.recommendedAutoMixDefault === true;
      // `isAdmin` in the v2 editor controls private AI/AutoMix options, so an
      // administrator outside the internal tester group must remain locked too.
      setIsAdmin(internalAdmin);
      setIsPaidManagedKie(paid);
      setRecommendedAutoMixDefault(recommendedDefault);
      setManagedKieOn(!!m?.managedKieOn);
      setManagedStockKeyHint(m?.managedStock?.brollKeyHint === true);
      // Defensive fallback for a legacy blank draft. Fresh projects already receive
      // this product default before their POST in ensureServerProject; existing
      // project choices are protected by accountDraftDefaultsAllowedRef.
      if (!internalAdmin && accountDraftDefaultsAllowedRef.current) {
        const defaultPreset = recommendedDefault ? "recommended" : null;
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
    const stagedLocal = hasUserMutation
      && stagedUserDraftMutationTokenRef.current === userDraftMutationTokenRef.current
      && latestDraftRef.current?.projectId === projectId
      ? latestDraftRef.current
      : null;
    const draft = stagedLocal?.draft
      ?? trustedResumeDraftRef.current
      ?? canonicalizeDraftLogoOverlay(buildDraft()) as V2Draft;
    const latestLocal = createEditorProjectAutosaveCandidate({
      projectId,
      revision: tracker.confirmed.revision,
      draft,
    });
    if (!latestLocal) {
      tracker.blocked = true;
      tracker.issued.clear();
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
          if (
            signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
            || tracker.blocked
          ) {
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
          if (result.kind === "error") tracker.issued.delete(snapshot.revision);
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
          if (
            signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
            || tracker.blocked
          ) {
            return { kind: "blocked" };
          }
          const observedProject = observation?.project;
          const observed = observation?.candidate;
          if (
            signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
            || tracker.blocked
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
          if (
            signal.aborted
            || !ownsAutosaveLineage(tracker, generation)
            || tracker.blocked
          ) {
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
          const isLatestQueuedRevision = event.projectId === latestQueuedSaveRef.current.projectId
            && event.revision === latestQueuedSaveRef.current.revision;
          if (
            status === "saved"
            && isLatestQueuedRevision
            && projectDraftIsDurable(event.projectId)
          ) {
            settleProjectDraftFlushWaiters(event.projectId, true);
          } else if (status === "error" && isLatestQueuedRevision) {
            settleProjectDraftFlushWaiters(event.projectId, false);
          }
          if (
            isLatestSavedProjectRevision(event, latestQueuedSaveRef.current)
            && userDraftMutationTokenRef.current === lastPersistedUserMutationTokenRef.current
          ) {
            trustedResumeDraftRef.current = null;
            clearProjectRecoveryData(event.projectId);
          }
        },
      });
      latestQueuedSaveRef.current = { projectId: saveProjectId, revision };
    }, 1000);
    return () => { clearTimeout(t); };
  }, [mode, projectTitle, script, clipUrl, clipDurationSec, brollSource, voiceEngine, geminiVoiceName, voiceId, omniVoiceId, musicTrack, musicTrackKind, bgmVolume, useAvatar, avatarId,
      targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs, kieModel, autoMixProviders, mixPreset, brollRegionPreference, brollVisualStyle, logoOverlay, brandSubtitleDefault, layerVisibility, headlineHook, projectId, projectReady,
      acknowledgeAutosaveCandidate, materializeAutosaveConflict, ownsAutosaveLineage, setRecoveryState, saveRevision]);

  // ข้อมูลอวตาร (ชื่อ + thumbnail) เมื่อมี avatarId — debounce กันยิง HeyGen ทุก keystroke
  useEffect(() => {
    if (!avatarId.trim()) { setAvatarInfo(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      authenticatedFetch(`/api/heygen/avatar-info?avatarId=${encodeURIComponent(avatarId.trim())}`)
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
    authenticatedFetch("/api/elevenlabs/voices")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && Array.isArray(d?.voices)) setElevenVoices(d.voices); })
      .catch(() => {});
    return () => { alive = false; };
  }, [voiceEngine, elevenVoices]);

  useEffect(() => {
    if (!omniVoiceEnabled || voiceEngine !== "omnivoice" || omniVoices !== null) return;
    let alive = true;
    authenticatedFetch("/api/omnivoice/voices")
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data) => { if (alive) setOmniVoices(Array.isArray(data) ? data : []); })
      .catch(() => { if (alive) setOmniVoices([]); });
    return () => { alive = false; };
  }, [omniVoiceEnabled, voiceEngine, omniVoices]);

  const retryOmniVoices = useCallback(() => setOmniVoices(null), []);
  const saveAccountVideoDefaults = useCallback(
    (patch: VideoAccountDefaultsPatch) => saveVideoAccountDefaults(patch),
    [],
  );

  return {
    projectTitle, setProjectTitle,
    mode, setMode, narrativeSourceKind,
    script, setScript,
    clipUrl, setClipUrl, clipDurationSec, setClipDurationSec,
    brollSource, setBrollSource,
    voiceEngine, setVoiceEngine,
    geminiVoiceName, setGeminiVoiceName,
    voiceId, setVoiceId,
    omniVoiceId, setOmniVoiceId,
    musicTrack, setMusicTrack,
    musicTrackKind, setMusicTrackKind,
    bgmVolume, setBgmVolume,
    useAvatar, setUseAvatar,
    avatarId, setAvatarId,
    targetClipCount, setTargetClipCount,
    heroCountTouched, setHeroCountTouched,
    avatarMode, setAvatarMode,
    avatarIntroSecs, setAvatarIntroSecs,
    avatarTailSecs, setAvatarTailSecs,
    kieModel, setKieModel,
    autoMixProviders, setAutoMixProviders,
    brollRegionPreference, setBrollRegionPreference,
    brollVisualStyle, setBrollVisualStyle,
    logoOverlay, setLogoOverlay,
    brandSubtitleDefault, setBrandSubtitleDefault,
    layerVisibility, setLayerVisibility,
    headlineHook, setHeadlineHook,
    mixPreset, setMixPreset,
    usage, avatarInfo, elevenVoices, omniVoices, omniVoiceEnabled, retryOmniVoices, internalAiTester, heroAiBeta, heroAiImageEligible, heroAiImageAccess, brandVisualAllowed, brandLibraryAllowed, hasPersistedVisualPin, setHasPersistedVisualPin, hasAdmittedVisualPin, setHasAdmittedVisualPin, brandVisualCohort, brandVisualRolloutBucket, starterAiImageAllowance, isActiveTrial, isAdmin, isPaidManagedKie, recommendedAutoMixDefault, managedKieOn, managedStockKeyHint,
    plan, canUploadOwnMedia, canUseLogoOverlay: logoEligible, projectId, projectReady, projectInitialization, projectStatus, activeJobId, activeExportJobId, latestVideoId, previewMediaState, resetProject, completeArchivedProject,
    brandContentPreflightId, setBrandContentPreflightId,
    projectStylePack, setProjectStylePack,
    saveStatus, retryProjectSave,
    flushPendingProjectDraft,
    recovery, retryProjectBootstrap, chooseLocalProjectDraft, chooseServerProjectDraft, retryConflictServerRefresh,
    canRunProjectOperation, saveAccountVideoDefaults,
    acceptAuthoritativeProjectSnapshot,
  };
}

export type V2Project = ReturnType<typeof useV2Project>;
