"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FilePlus2, History, NotebookPen } from "lucide-react";
import { fetchMe } from "@/lib/use-me";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import { limitsForPlan } from "@/lib/plan-limits";
import type { HeroScriptStarterTopic } from "@/lib/hero-script-presets";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  BrandProfilePanel,
  type BrandProfile,
  type BrandProfilePanelHandle,
  type DurationSec,
} from "./_components/BrandProfilePanel";
import { TopicStep } from "./_components/TopicStep";
import { HookStep, hookContextKey, type HookChoice, type HookStepHandle } from "./_components/HookStep";
import {
  ScriptEditorStep,
  type ScriptDraft,
  type ScriptEditorStepHandle,
  type ScriptSaveState,
} from "./_components/ScriptEditorStep";
import { ScriptPacingRail } from "./_components/ScriptPacingRail";
import {
  ScriptLibrary,
  type SavedScript,
  type ScriptLibraryItem,
  type ScriptLibraryPage,
} from "./_components/ScriptHistory";
import { HeroScriptQuickStart } from "./_components/HeroScriptQuickStart";
import {
  readHeroScriptWritingPreferences,
  loadLatestHeroScriptDetail,
  writeHeroScriptWritingPreferences,
  type HeroScriptWritingPreferences,
} from "./_components/hero-script-workspace-state";
import { HS_COLOR, HS_FONT } from "./_components/hero-script-tokens";

type WorkspaceAction =
  | { kind: "new" }
  | { kind: "open"; item: ScriptLibraryItem }
  | { kind: "navigate"; projectId: string }
  | { kind: "handoff"; operation: HandoffOperation };

type HandoffOperation = {
  scriptId: string | null;
  workspaceDraft: ScriptDraft | null;
  posting: boolean;
  valid: boolean;
};

export default function HeroScriptPage() {
  const router = useRouter();
  const [plan, setPlan] = useState("FREE");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [availableProfiles, setAvailableProfiles] = useState<BrandProfile[] | null>(null);
  const [activeTab, setActiveTab] = useState<"write" | "library">("write");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [stylePreset, setStylePreset] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<DurationSec>(60);
  const [preferredStructure, setPreferredStructure] = useState<string | null>(null);
  const [ctaStyleOverride, setCtaStyleOverride] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [selectedHook, setSelectedHook] = useState<HookChoice | null>(null);
  const [hookStepOpen, setHookStepOpen] = useState(false);
  const [hookStepLoading, setHookStepLoading] = useState(false);
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [recentDraft, setRecentDraft] = useState<ScriptLibraryItem | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [openingScriptId, setOpeningScriptId] = useState<string | null>(null);
  const [pendingReplacement, setPendingReplacement] = useState<WorkspaceAction | null>(null);
  const [replacementAfterSaveFailure, setReplacementAfterSaveFailure] = useState(false);
  const [handoffPhase, setHandoffPhase] = useState<"saving" | "posting" | null>(null);
  const [editorStatus, setEditorStatus] = useState<{
    saveState: ScriptSaveState;
    generating: boolean;
    compacting: boolean;
    sending: boolean;
  }>({ saveState: "idle", generating: false, compacting: false, sending: false });

  const hydratedAccountRef = useRef<string | null>(null);
  const workspaceChangedRef = useRef(false);
  const newWritingPreferencesRef = useRef<HeroScriptWritingPreferences>({ profileId: null, durationSec: 60, stylePreset: null });
  const draftRef = useRef<ScriptDraft | null>(null);
  const editorRef = useRef<ScriptEditorStepHandle>(null);
  const hookStepRef = useRef<HookStepHandle>(null);
  const brandPanelRef = useRef<BrandProfilePanelHandle>(null);
  const detailRequestRef = useRef(0);
  const openingScriptIdRef = useRef<string | null>(null);
  const handoffOperationRef = useRef<HandoffOperation | null>(null);
  const dialogActionRef = useRef(false);
  const libraryDirtyRef = useRef(false);
  const pendingHookFetchRef = useRef(false);

  const invalidateHandoff = useCallback(() => {
    const operation = handoffOperationRef.current;
    if (!operation) return;
    operation.valid = false;
    if (!operation.posting) {
      handoffOperationRef.current = null;
      setHandoffPhase(null);
    }
  }, []);

  const ownsHandoffAction = useCallback((action: WorkspaceAction) => action.kind !== "handoff"
    || (handoffOperationRef.current === action.operation && action.operation.valid), []);

  const cancelHandoffOperation = useCallback((operation: HandoffOperation) => {
    if (handoffOperationRef.current !== operation) return;
    operation.valid = false;
    if (!operation.posting) {
      handoffOperationRef.current = null;
      setHandoffPhase(null);
    }
  }, []);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  useEffect(() => {
    fetchMe().then((me) => {
      if (me) setPlan((me.effectivePlan ?? me.plan) || "FREE");
      setAccountId(typeof me?.id === "string" ? me.id : null);
    });
  }, []);

  useEffect(() => {
    workspaceChangedRef.current = false;
    hydratedAccountRef.current = null;
    newWritingPreferencesRef.current = { profileId: null, durationSec: 60, stylePreset: null };
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !availableProfiles) return;
    if (hydratedAccountRef.current === accountId) return;
    hydratedAccountRef.current = accountId;
    if (workspaceChangedRef.current) return;
    const preferences = readHeroScriptWritingPreferences(window.localStorage, accountId, availableProfiles);
    newWritingPreferencesRef.current = preferences;
    setSelectedProfileId(preferences.profileId);
    setDurationSec(preferences.durationSec);
    setStylePreset(preferences.profileId ? null : (preferences.stylePreset ?? null));
  }, [accountId, availableProfiles]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void authenticatedFetch("/api/scripts/library?status=draft&page=1&pageSize=1")
      .then(async (response) => response.ok ? response.json() as Promise<ScriptLibraryPage> : null)
      .then((page) => {
        if (!cancelled) setRecentDraft(page?.items?.[0] ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [accountId]);

  // Trigger hook fetch right after HookStep mounts when user clicks "เลือก 5 Hook ก่อน".
  useEffect(() => {
    if (!hookStepOpen || !pendingHookFetchRef.current) return;
    pendingHookFetchRef.current = false;
    void hookStepRef.current?.fetchHooks();
  }, [hookStepOpen]);

  const rememberWritingPreferences = useCallback((
    profileId: string | null,
    nextDurationSec: DurationSec,
    nextStylePreset: string | null,
  ) => {
    const nextPrefs: HeroScriptWritingPreferences = {
      profileId,
      durationSec: nextDurationSec,
      ...(profileId ? {} : nextStylePreset ? { stylePreset: nextStylePreset } : {}),
    };
    newWritingPreferencesRef.current = nextPrefs;
    if (!accountId) return;
    writeHeroScriptWritingPreferences(window.localStorage, accountId, nextPrefs);
  }, [accountId]);

  const changeProfile = useCallback((profileId: string | null) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    const nextPreset = profileId ? null : stylePreset;
    if (selectedHook?.contextKey !== hookContextKey(topic, durationSec, profileId, nextPreset)) {
      setSelectedHook(null);
    }
    setSelectedProfileId(profileId);
    if (profileId) setStylePreset(null);
    rememberWritingPreferences(profileId, durationSec, nextPreset);
  }, [durationSec, invalidateHandoff, rememberWritingPreferences, selectedHook, stylePreset, topic]);

  const changeStylePreset = useCallback((presetKey: string | null) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    if (selectedHook?.contextKey !== hookContextKey(topic, durationSec, null, presetKey)) {
      setSelectedHook(null);
    }
    setStylePreset(presetKey);
    rememberWritingPreferences(null, durationSec, presetKey);
  }, [durationSec, invalidateHandoff, rememberWritingPreferences, selectedHook, topic]);

  const changeDuration = useCallback((nextDurationSec: DurationSec) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    if (selectedHook?.contextKey !== hookContextKey(topic, nextDurationSec, selectedProfileId, stylePreset)) {
      setSelectedHook(null);
    }
    setDurationSec(nextDurationSec);
    rememberWritingPreferences(selectedProfileId, nextDurationSec, stylePreset);
  }, [invalidateHandoff, rememberWritingPreferences, selectedHook, selectedProfileId, stylePreset, topic]);

  const restoreScript = useCallback((script: SavedScript) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    setSelectedProfileId(script.brandProfileId);
    setDurationSec(script.durationSec as DurationSec);
    setTopic(script.topic);
    setPreferredStructure(script.structure ?? null);
    setHookStepOpen(false);
    setSelectedHook({
      formula: script.hookFormula ?? "",
      text: script.hookText,
      contextKey: hookContextKey(script.topic, script.durationSec, script.brandProfileId, null),
    });
    const next: ScriptDraft = {
      id: script.id,
      brandProfileId: script.brandProfileId,
      topic: script.topic,
      durationSec: script.durationSec,
      hookFormula: script.hookFormula,
      structure: script.structure,
      hookText: script.hookText,
      bodyText: script.bodyText,
      ctaText: script.ctaText,
      status: script.status,
      editorProjectId: script.editorProjectId,
      editorProjectAvailable: script.editorProjectAvailable,
    };
    draftRef.current = next;
    setDraft(next);
    setActiveTab("write");
  }, [invalidateHandoff]);

  const changeTopic = useCallback((nextTopic: string) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    if (!nextTopic.trim()) setHookStepOpen(false);
    if (selectedHook?.contextKey !== hookContextKey(nextTopic, durationSec, selectedProfileId, stylePreset)) {
      setSelectedHook(null);
    }
    setTopic(nextTopic);
  }, [durationSec, invalidateHandoff, selectedHook, selectedProfileId, stylePreset]);

  const handleStarterTopicPick = useCallback((starter: HeroScriptStarterTopic) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    const nextPreset = selectedProfileId ? null : starter.presetKey;
    if (!selectedProfileId) setStylePreset(starter.presetKey);
    setDurationSec(starter.durationSec);
    setSelectedHook(null);
    setTopic(starter.topic);
    rememberWritingPreferences(selectedProfileId, starter.durationSec, nextPreset);
  }, [invalidateHandoff, rememberWritingPreferences, selectedProfileId]);

  const handleRequestHooks = useCallback(() => {
    if (!topic.trim()) return;
    if (hookStepOpen) {
      void hookStepRef.current?.fetchHooks();
    } else {
      pendingHookFetchRef.current = true;
      setHookStepOpen(true);
    }
  }, [hookStepOpen, topic]);

  const changeHook = useCallback((hook: HookChoice | null) => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    setSelectedHook(hook);
  }, [invalidateHandoff]);

  const changeDraft = useCallback((nextDraft: ScriptDraft | null) => {
    if (nextDraft) workspaceChangedRef.current = true;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const resetWorkspace = useCallback(() => {
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    detailRequestRef.current += 1;
    openingScriptIdRef.current = null;
    setOpeningScriptId(null);
    const defaults = newWritingPreferencesRef.current;
    setSelectedProfileId(defaults.profileId);
    setStylePreset(defaults.profileId ? null : (defaults.stylePreset ?? null));
    setDurationSec(defaults.durationSec as DurationSec);
    setPreferredStructure(null);
    setCtaStyleOverride(null);
    setTopic("");
    setSelectedHook(null);
    setHookStepOpen(false);
    draftRef.current = null;
    setDraft(null);
    setActiveTab("write");
  }, [invalidateHandoff]);

  const openScript = useCallback(async (item: ScriptLibraryItem) => {
    openingScriptIdRef.current = item.id;
    setOpeningScriptId(item.id);
    const outcome = await loadLatestHeroScriptDetail<SavedScript>(item.id, detailRequestRef, authenticatedFetch);
    if (outcome.status === "applied") restoreScript(outcome.data);
    else if (outcome.status === "error") toast.error(outcome.message);
    if (openingScriptIdRef.current === item.id && outcome.status !== "stale") {
      openingScriptIdRef.current = null;
      setOpeningScriptId(null);
    }
  }, [restoreScript]);

  const executeWorkspaceAction = useCallback(async (action: WorkspaceAction) => {
    if (action.kind === "handoff") {
      const operation = action.operation;
      if (handoffOperationRef.current !== operation || !operation.valid || operation.posting) return;
      editorRef.current?.invalidateAsyncRequests();
      const scriptId = operation.scriptId ?? draftRef.current?.id;
      if (!scriptId) {
        handoffOperationRef.current = null;
        setHandoffPhase(null);
        return;
      }
      operation.scriptId = scriptId;
      operation.workspaceDraft = draftRef.current;
      operation.posting = true;
      setHandoffPhase("posting");
      const startedAt = performance.now();
      const ownsWorkspace = () => operation.valid
        && handoffOperationRef.current === operation
        && draftRef.current === operation.workspaceDraft;
      try {
        trackEvent("hero_script_handoff_requested", { status: "started" });
        const response = await authenticatedFetch(`/api/scripts/${encodeURIComponent(scriptId)}/send-to-editor`, { method: "POST" });
        if (!ownsWorkspace()) return;
        const payload = await response.json().catch(() => null);
        if (!ownsWorkspace()) return;
        if (!response.ok || typeof payload?.projectId !== "string") {
          trackEvent("hero_script_handoff_failed", {
            category: "error", status: "error", durationMs: performance.now() - startedAt,
            properties: { httpStatus: response.status },
          });
          toast.error(payload?.error || "ส่งไปตัดต่อไม่สำเร็จ");
          return;
        }
        libraryDirtyRef.current = true;
        if (draftRef.current?.id === scriptId) {
          const sentDraft: ScriptDraft = {
            ...draftRef.current,
            status: "sent",
            editorProjectId: payload.projectId,
            editorProjectAvailable: true,
          };
          draftRef.current = sentDraft;
          setDraft(sentDraft);
        }
        setRecentDraft((current) => current?.id === scriptId ? null : current);
        trackEvent("hero_script_handoff_completed", { status: "done", durationMs: performance.now() - startedAt });
        router.push(`/video-editor?projectId=${encodeURIComponent(payload.projectId)}`);
      } catch {
        if (ownsWorkspace()) {
          trackEvent("hero_script_handoff_failed", {
            category: "error", status: "error", durationMs: performance.now() - startedAt,
            properties: { failure: "network" },
          });
          toast.error("ส่งไปตัดต่อไม่สำเร็จ");
        }
      } finally {
        if (handoffOperationRef.current === operation) {
          handoffOperationRef.current = null;
          setHandoffPhase(null);
        }
      }
      return;
    }
    invalidateHandoff();
    editorRef.current?.invalidateAsyncRequests();
    if (action.kind === "new") resetWorkspace();
    else if (action.kind === "open") await openScript(action.item);
    else router.push(`/video-editor?projectId=${encodeURIComponent(action.projectId)}`);
  }, [invalidateHandoff, openScript, resetWorkspace, router]);

  const requestWorkspaceAction = useCallback(async (action: WorkspaceAction) => {
    if (!ownsHandoffAction(action)) return false;
    if (!draftRef.current && (topic.trim() || selectedHook)) {
      setReplacementAfterSaveFailure(false);
      setPendingReplacement(action);
      return false;
    }
    let savedLatest: boolean | undefined;
    try {
      savedLatest = !draftRef.current || await editorRef.current?.saveLatest();
    } catch (error) {
      if (action.kind !== "handoff") throw error;
      if (!ownsHandoffAction(action)) return false;
      setReplacementAfterSaveFailure(true);
      setPendingReplacement(action);
      return false;
    }
    if (!ownsHandoffAction(action)) return false;
    if (!savedLatest) {
      setReplacementAfterSaveFailure(true);
      setPendingReplacement(action);
      return false;
    }
    await executeWorkspaceAction(action);
    return true;
  }, [executeWorkspaceAction, ownsHandoffAction, selectedHook, topic]);

  const handleSaved = useCallback((savedDraft: ScriptDraft) => {
    libraryDirtyRef.current = true;
    if (savedDraft.status === "draft" && savedDraft.id) {
      setRecentDraft((current) => ({
        id: savedDraft.id!,
        topic: savedDraft.topic,
        brandProfileId: savedDraft.brandProfileId,
        brandName: current?.id === savedDraft.id ? current.brandName : null,
        durationSec: savedDraft.durationSec,
        status: savedDraft.status,
        editorProjectId: savedDraft.editorProjectId,
        editorProjectAvailable: savedDraft.editorProjectAvailable,
        createdAt: current?.id === savedDraft.id ? current.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    } else if (savedDraft.id) {
      setRecentDraft((current) => current?.id === savedDraft.id ? null : current);
    }
  }, []);

  const showLibrary = useCallback(() => {
    if (libraryDirtyRef.current) {
      libraryDirtyRef.current = false;
      setHistoryKey((key) => key + 1);
    }
    trackEvent("hero_script_library_viewed");
    setActiveTab("library");
  }, []);

  const createEditorProject = useCallback(async (scriptId: string | null) => {
    if (handoffOperationRef.current) return false;
    const operation: HandoffOperation = { scriptId, workspaceDraft: draftRef.current, posting: false, valid: true };
    handoffOperationRef.current = operation;
    setHandoffPhase("saving");
    await requestWorkspaceAction({ kind: "handoff", operation });
    return true;
  }, [requestWorkspaceAction]);

  const beforeDelete = useCallback(async (item: ScriptLibraryItem) => {
    if (draftRef.current?.id !== item.id) return true;
    return (await editorRef.current?.saveLatest()) ?? true;
  }, []);

  const handleDeleted = useCallback((id: string) => {
    if (openingScriptIdRef.current === id) {
      detailRequestRef.current += 1;
      openingScriptIdRef.current = null;
      setOpeningScriptId(null);
    }
    setRecentDraft((current) => current?.id === id ? null : current);
    if (draftRef.current?.id !== id) return;
    resetWorkspace();
  }, [resetWorkspace]);

  const canSendToEditor = limitsForPlan(plan).allowVideoEditor;
  const workspaceActionsBusy = handoffPhase !== null || editorStatus.generating || editorStatus.compacting || editorStatus.sending;

  return (
    <div className="relative flex-1 overflow-y-auto" style={{ fontFamily: HS_FONT.body }}>
      <div className="mx-auto max-w-6xl px-4 py-5 md:px-6 md:py-7">
        <div className="space-y-5">
          {/* ── Editor v2-Aligned Header ── */}
          <header
            className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"
            style={{ borderColor: "var(--ui-divider)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                style={{ background: HS_COLOR.violetSoft, border: `1px solid ${HS_COLOR.violetBorder}`, color: HS_COLOR.violet }}
              >
                <NotebookPen className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h1
                  className="text-xl font-bold tracking-tight md:text-2xl"
                  style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
                >
                  เขียนสคริปต์ AI
                </h1>
                <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  พิมพ์หัวข้อ → สร้างสคริปต์พร้อมแบ่งซีนในคลิกเดียว หรือเลือก 5 Hook ก่อน
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void requestWorkspaceAction({ kind: "new" }); }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors hover:bg-black/5 dark:hover:bg-white/5 sm:text-sm"
                style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-primary)" }}
              >
                <FilePlus2 className="h-4 w-4" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
                สคริปต์ใหม่
              </button>

              <div
                role="tablist"
                aria-label="พื้นที่สคริปต์"
                className="flex min-h-11 items-center gap-1 rounded-xl border p-1"
                style={{ background: "var(--ui-btn-bg)", borderColor: "var(--ui-card-border)" }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "write"}
                  onClick={() => setActiveTab("write")}
                  className="min-h-9 rounded-lg px-3 text-xs font-semibold transition-all sm:text-sm"
                  style={{
                    background: activeTab === "write" ? HS_COLOR.violetGradient : "transparent",
                    color: activeTab === "write" ? "#ffffff" : "var(--ui-text-secondary)",
                    fontFamily: HS_FONT.heading,
                  }}
                >
                  เขียนสคริปต์
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "library"}
                  onClick={showLibrary}
                  className="min-h-9 rounded-lg px-3 text-xs font-semibold transition-all sm:text-sm"
                  style={{
                    background: activeTab === "library" ? HS_COLOR.violetGradient : "transparent",
                    color: activeTab === "library" ? "#ffffff" : "var(--ui-text-secondary)",
                    fontFamily: HS_FONT.heading,
                  }}
                >
                  คลังสคริปต์
                </button>
              </div>
            </div>
          </header>

          {/* ── Writing Tab (2-Column Studio Layout; kept mounted across tab switches) ── */}
          <div role="tabpanel" hidden={activeTab !== "write"} className="space-y-4">
            {/* Compact top utility bar: recent draft recovery + collapsed guide */}
            {recentDraft && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={openingScriptId === recentDraft.id}
                  onClick={() => {
                    trackEvent("hero_script_script_opened", { properties: { source: "recent_draft", status: recentDraft.status } });
                    void requestWorkspaceAction({ kind: "open", item: recentDraft });
                  }}
                  className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-xl border px-3 py-1.5 text-left text-xs font-medium transition-colors hover:border-violet-400 sm:text-sm"
                  style={{
                    borderColor: HS_COLOR.violetBorder,
                    background: HS_COLOR.violetSoft,
                    color: "var(--ui-text-primary)",
                  }}
                >
                  <History className="h-3.5 w-3.5 shrink-0" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
                  <span className="truncate">
                    {openingScriptId === recentDraft.id ? "กำลังเปิดร่างล่าสุด…" : `ทำร่างล่าสุดต่อ · ${recentDraft.topic}`}
                  </span>
                </button>
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
              {/* Left Main Column: Controls → Smart Composer → Optional Hook Step → Full Script Editor */}
              <div className="min-w-0 space-y-4">
                <BrandProfilePanel
                  ref={brandPanelRef}
                  plan={plan}
                  selectedProfileId={selectedProfileId}
                  onSelectedProfileIdChange={changeProfile}
                  stylePreset={stylePreset}
                  onStylePresetChange={changeStylePreset}
                  durationSec={durationSec}
                  onDurationSecChange={changeDuration}
                  preferredStructure={preferredStructure}
                  onPreferredStructureChange={setPreferredStructure}
                  ctaStyleOverride={ctaStyleOverride}
                  onCtaStyleOverrideChange={setCtaStyleOverride}
                  onProfilesChange={setAvailableProfiles}
                />

                <TopicStep
                  selectedProfileId={selectedProfileId}
                  stylePreset={stylePreset}
                  topic={topic}
                  hasDraft={Boolean(draft)}
                  quickGenerating={editorStatus.generating}
                  hookPickerLoading={hookStepLoading}
                  actionsDisabled={workspaceActionsBusy}
                  onTopicChange={changeTopic}
                  onStarterTopicPick={handleStarterTopicPick}
                  onQuickGenerate={() => { void editorRef.current?.runQuickGenerate(); }}
                  onRequestHooks={handleRequestHooks}
                />

                {topic.trim() && hookStepOpen && (
                  <HookStep
                    ref={hookStepRef}
                    topic={topic}
                    durationSec={durationSec}
                    selectedProfileId={selectedProfileId}
                    stylePreset={stylePreset}
                    selectedHook={selectedHook}
                    onSelectedHookChange={changeHook}
                    onLoadingChange={setHookStepLoading}
                    onGenerateWithHook={() => { void editorRef.current?.runHookGenerate(); }}
                    generateDisabled={workspaceActionsBusy}
                    generating={editorStatus.generating}
                  />
                )}

                {!selectedHook && draft && (
                  <p role="status" className="rounded-xl px-3 py-2 text-xs" style={{ background: "var(--ui-card-bg-2)", color: "var(--ui-text-muted)" }}>
                    ร่างเดิมยังอยู่ — กด “สร้างสคริปต์เลย (1 คลิก)” หรือเลือก Hook ใหม่เพื่อสร้างฉบับใหม่
                  </p>
                )}

                <ScriptEditorStep
                  ref={editorRef}
                  topic={topic}
                  durationSec={durationSec}
                  selectedProfileId={selectedProfileId}
                  stylePreset={stylePreset}
                  preferredStructure={preferredStructure}
                  ctaStyleOverride={ctaStyleOverride}
                  profilesCount={availableProfiles?.length ?? 0}
                  selectedHook={selectedHook}
                  onSelectedHookChange={changeHook}
                  draft={draft}
                  onDraftChange={changeDraft}
                  onSaved={handleSaved}
                  onCreateEditorProject={() => createEditorProject(draftRef.current?.id ?? null)}
                  onOpenCreateBrand={() => brandPanelRef.current?.openCreateDialog()}
                  onStatusChange={setEditorStatus}
                  handoffPending={handoffPhase !== null}
                  handoffPosting={handoffPhase === "posting"}
                />

                <HeroScriptQuickStart accountId={accountId} />
              </div>

              {/* Right Sticky Rail: Live Spoken Duration · Scene Breakdown · Copy · Send to Editor */}
              <ScriptPacingRail
                draft={draft}
                durationSec={durationSec}
                saveState={editorStatus.saveState}
                canSendToEditor={canSendToEditor}
                generating={editorStatus.generating}
                compacting={editorStatus.compacting}
                sending={editorStatus.sending}
                handoffPending={handoffPhase !== null}
                onCompact={() => { void editorRef.current?.runCompact(); }}
                onOpenEditorProject={(projectId) => { void requestWorkspaceAction({ kind: "navigate", projectId }); }}
                onCreateEditorProject={() => { void editorRef.current?.createEditorProject(); }}
              />
            </div>
          </div>

          {/* ── Library Tab ── */}
          <div role="tabpanel" hidden={activeTab !== "library"}>
            <ScriptLibrary
              active={activeTab === "library"}
              refreshKey={historyKey}
              activeScriptId={draft?.id ?? null}
              onOpenScript={(item) => { void requestWorkspaceAction({ kind: "open", item }); }}
              onOpenEditorProject={(item) => { if (item.editorProjectId) void requestWorkspaceAction({ kind: "navigate", projectId: item.editorProjectId }); }}
              onCreateEditorProject={async (item) => { await createEditorProject(item.id); }}
              handoffPending={handoffPhase !== null}
              beforeDelete={beforeDelete}
              onDeleted={handleDeleted}
              onStartWriting={() => setActiveTab("write")}
            />
          </div>
        </div>
      </div>

      <AlertDialog open={!!pendingReplacement} onOpenChange={(open) => {
        if (open) return;
        if (dialogActionRef.current) {
          dialogActionRef.current = false;
          return;
        }
        if (pendingReplacement?.kind === "handoff") cancelHandoffOperation(pendingReplacement.operation);
        setPendingReplacement(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{replacementAfterSaveFailure ? "บันทึกไม่สำเร็จ" : "ทิ้งสิ่งที่กำลังเขียน?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {replacementAfterSaveFailure
                ? pendingReplacement?.kind === "handoff"
                  ? "ข้อความล่าสุดยังอยู่ในหน้านี้ ลองบันทึกอีกครั้ง หรือยกเลิกเพื่อกลับไปแก้ไข"
                  : "ข้อความล่าสุดยังอยู่ในหน้านี้ ลองบันทึกอีกครั้ง หรือทิ้งการแก้ไขเพื่อไปต่อ"
                : "หัวข้อและ Hook นี้ยังไม่ได้สร้างเป็นสคริปต์ คุณต้องการทิ้งแล้วไปต่อหรือไม่"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">ยกเลิก</AlertDialogCancel>
            {replacementAfterSaveFailure && (
              <button type="button" className="min-h-11 rounded-md border px-4 text-sm font-medium" onClick={() => {
                const replacement = pendingReplacement;
                if (!replacement || !ownsHandoffAction(replacement)) {
                  dialogActionRef.current = true;
                  setPendingReplacement(null);
                  return;
                }
                dialogActionRef.current = true;
                setPendingReplacement(null);
                void requestWorkspaceAction(replacement);
              }}>
                ลองบันทึกอีกครั้ง
              </button>
            )}
            {!(replacementAfterSaveFailure && pendingReplacement?.kind === "handoff") && (
              <AlertDialogAction className="min-h-11" onClick={() => {
                const replacement = pendingReplacement;
                if (replacement?.kind === "handoff" && replacementAfterSaveFailure) return;
                if (!replacement || !ownsHandoffAction(replacement)) return;
                dialogActionRef.current = true;
                setPendingReplacement(null);
                void executeWorkspaceAction(replacement);
              }}>ทิ้งแล้วไปต่อ</AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
