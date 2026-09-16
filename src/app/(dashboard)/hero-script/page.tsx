"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchMe } from "@/lib/use-me";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BrandProfilePanel, type DurationSec } from "./_components/BrandProfilePanel";
import { TopicStep } from "./_components/TopicStep";
import { HookStep, hookContextKey, type HookChoice } from "./_components/HookStep";
import {
  ScriptEditorStep,
  type ScriptDraft,
  type ScriptEditorStepHandle,
} from "./_components/ScriptEditorStep";
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

const VIOLET_LIGHT = "#B9A6FF";

type WorkspaceAction =
  | { kind: "new" }
  | { kind: "open"; item: ScriptLibraryItem }
  | { kind: "navigate"; projectId: string };

export default function HeroScriptPage() {
  const router = useRouter();
  const [plan, setPlan] = useState("FREE");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [availableProfiles, setAvailableProfiles] = useState<Array<{ id: string }> | null>(null);
  const [activeTab, setActiveTab] = useState<"write" | "library">("write");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<DurationSec>(60);
  const [topic, setTopic] = useState("");
  const [selectedHook, setSelectedHook] = useState<HookChoice | null>(null);
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [recentDraft, setRecentDraft] = useState<ScriptLibraryItem | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [openingScriptId, setOpeningScriptId] = useState<string | null>(null);
  const [pendingReplacement, setPendingReplacement] = useState<WorkspaceAction | null>(null);
  const [replacementAfterSaveFailure, setReplacementAfterSaveFailure] = useState(false);
  const hydratedAccountRef = useRef<string | null>(null);
  const workspaceChangedRef = useRef(false);
  const newWritingPreferencesRef = useRef<HeroScriptWritingPreferences>({ profileId: null, durationSec: 60 });
  const draftRef = useRef<ScriptDraft | null>(null);
  const editorRef = useRef<ScriptEditorStepHandle>(null);
  const detailRequestRef = useRef(0);
  const openingScriptIdRef = useRef<string | null>(null);
  const handoffScriptIdRef = useRef<string | null>(null);
  const libraryDirtyRef = useRef(false);

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
    newWritingPreferencesRef.current = { profileId: null, durationSec: 60 };
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

  const rememberWritingPreferences = useCallback((profileId: string | null, nextDurationSec: DurationSec) => {
    newWritingPreferencesRef.current = { profileId, durationSec: nextDurationSec };
    if (!accountId) return;
    writeHeroScriptWritingPreferences(window.localStorage, accountId, { profileId, durationSec: nextDurationSec });
  }, [accountId]);

  const changeProfile = useCallback((profileId: string | null) => {
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    if (selectedHook?.contextKey !== hookContextKey(topic, durationSec, profileId)) setSelectedHook(null);
    setSelectedProfileId(profileId);
    rememberWritingPreferences(profileId, durationSec);
  }, [durationSec, rememberWritingPreferences, selectedHook, topic]);

  const changeDuration = useCallback((nextDurationSec: DurationSec) => {
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    if (selectedHook?.contextKey !== hookContextKey(topic, nextDurationSec, selectedProfileId)) setSelectedHook(null);
    setDurationSec(nextDurationSec);
    rememberWritingPreferences(selectedProfileId, nextDurationSec);
  }, [rememberWritingPreferences, selectedHook, selectedProfileId, topic]);

  const restoreScript = useCallback((script: SavedScript) => {
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    setSelectedProfileId(script.brandProfileId);
    setDurationSec(script.durationSec as DurationSec);
    setTopic(script.topic);
    setSelectedHook({
      formula: script.hookFormula ?? "",
      text: script.hookText,
      contextKey: hookContextKey(script.topic, script.durationSec, script.brandProfileId),
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
  }, []);

  const changeTopic = useCallback((nextTopic: string) => {
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    if (selectedHook?.contextKey !== hookContextKey(nextTopic, durationSec, selectedProfileId)) setSelectedHook(null);
    setTopic(nextTopic);
  }, [durationSec, selectedHook, selectedProfileId]);

  const changeHook = useCallback((hook: HookChoice | null) => {
    editorRef.current?.invalidateAsyncRequests();
    workspaceChangedRef.current = true;
    setSelectedHook(hook);
  }, []);

  const changeDraft = useCallback((nextDraft: ScriptDraft | null) => {
    if (nextDraft) workspaceChangedRef.current = true;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const resetWorkspace = useCallback(() => {
    editorRef.current?.invalidateAsyncRequests();
    detailRequestRef.current += 1;
    openingScriptIdRef.current = null;
    setOpeningScriptId(null);
    const defaults = newWritingPreferencesRef.current;
    setSelectedProfileId(defaults.profileId);
    setDurationSec(defaults.durationSec as DurationSec);
    setTopic("");
    setSelectedHook(null);
    draftRef.current = null;
    setDraft(null);
    setActiveTab("write");
  }, []);

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
    editorRef.current?.invalidateAsyncRequests();
    if (action.kind === "new") resetWorkspace();
    else if (action.kind === "open") await openScript(action.item);
    else router.push(`/video-editor?projectId=${encodeURIComponent(action.projectId)}`);
  }, [openScript, resetWorkspace, router]);

  const requestWorkspaceAction = useCallback(async (action: WorkspaceAction) => {
    if (!draftRef.current && (topic.trim() || selectedHook)) {
      setReplacementAfterSaveFailure(false);
      setPendingReplacement(action);
      return;
    }
    if (draftRef.current && !(await editorRef.current?.saveLatest())) {
      setReplacementAfterSaveFailure(true);
      setPendingReplacement(action);
      return;
    }
    await executeWorkspaceAction(action);
  }, [executeWorkspaceAction, selectedHook, topic]);

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
    setActiveTab("library");
  }, []);

  const createEditorProject = useCallback(async (item: ScriptLibraryItem) => {
    if (handoffScriptIdRef.current) return;
    if (draftRef.current?.id === item.id) {
      await editorRef.current?.createEditorProject();
      return;
    }
    handoffScriptIdRef.current = item.id;
    try {
      const response = await authenticatedFetch(`/api/scripts/${encodeURIComponent(item.id)}/send-to-editor`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || typeof payload?.projectId !== "string") {
        toast.error(payload?.error || "ส่งไปตัดต่อไม่สำเร็จ");
        return;
      }
      router.push(`/video-editor?projectId=${encodeURIComponent(payload.projectId)}`);
    } catch {
      toast.error("ส่งไปตัดต่อไม่สำเร็จ");
    } finally {
      handoffScriptIdRef.current = null;
    }
  }, [router]);

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

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="space-y-6">
          <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-3" style={{ borderColor: "var(--ui-divider)" }}>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>Hero Script</p>
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>เขียนสคริปต์ AI</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => { void requestWorkspaceAction({ kind: "new" }); }} className="min-h-11 rounded-lg px-3 text-sm font-semibold" style={{ color: VIOLET_LIGHT }}>สคริปต์ใหม่</button>
              <div role="tablist" aria-label="พื้นที่สคริปต์" className="flex min-h-11 items-center gap-1 rounded-lg p-1" style={{ background: "var(--ui-btn-bg)" }}>
                <button type="button" role="tab" aria-selected={activeTab === "write"} onClick={() => setActiveTab("write")} className="min-h-9 rounded-md px-3 text-sm font-semibold" style={{ background: activeTab === "write" ? VIOLET_LIGHT : "transparent", color: activeTab === "write" ? "#241a3c" : "var(--ui-text-secondary)" }}>เขียนสคริปต์</button>
                <button type="button" role="tab" aria-selected={activeTab === "library"} onClick={showLibrary} className="min-h-9 rounded-md px-3 text-sm font-semibold" style={{ background: activeTab === "library" ? VIOLET_LIGHT : "transparent", color: activeTab === "library" ? "#241a3c" : "var(--ui-text-secondary)" }}>คลังสคริปต์</button>
              </div>
            </div>
          </header>

          <div role="tabpanel" hidden={activeTab !== "write"} className="space-y-6">
            <HeroScriptQuickStart accountId={accountId} />
            {recentDraft && (
              <button type="button" disabled={openingScriptId === recentDraft.id} onClick={() => { void requestWorkspaceAction({ kind: "open", item: recentDraft }); }} className="min-h-11 rounded-lg px-3 text-left text-sm font-medium" style={{ color: VIOLET_LIGHT }}>
                {openingScriptId === recentDraft.id ? "กำลังเปิดร่างล่าสุด…" : `ทำร่างล่าสุดต่อ · ${recentDraft.topic}`}
              </button>
            )}
            <BrandProfilePanel plan={plan} selectedProfileId={selectedProfileId} onSelectedProfileIdChange={changeProfile} durationSec={durationSec} onDurationSecChange={changeDuration} onProfilesChange={setAvailableProfiles} />
            <TopicStep selectedProfileId={selectedProfileId} topic={topic} onTopicChange={changeTopic} />
            {topic.trim() && <HookStep topic={topic} durationSec={durationSec} selectedProfileId={selectedProfileId} selectedHook={selectedHook} onSelectedHookChange={changeHook} />}
            {!selectedHook && draft && <p role="status" className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ร่างเดิมยังอยู่ เลือก Hook ใหม่ก่อนสร้างสคริปต์ต่อ</p>}
            <div hidden={!selectedHook && !draft}>
              <ScriptEditorStep ref={editorRef} topic={topic} durationSec={durationSec} plan={plan} selectedProfileId={selectedProfileId} selectedHook={selectedHook} onSelectedHookChange={changeHook} draft={draft} onDraftChange={changeDraft} onSaved={handleSaved} onOpenEditorProject={(projectId) => { void requestWorkspaceAction({ kind: "navigate", projectId }); }} />
            </div>
          </div>

          <div role="tabpanel" hidden={activeTab !== "library"}>
            <ScriptLibrary
              active={activeTab === "library"}
              refreshKey={historyKey}
              activeScriptId={draft?.id ?? null}
              onOpenScript={(item) => { void requestWorkspaceAction({ kind: "open", item }); }}
              onOpenEditorProject={(item) => { if (item.editorProjectId) void requestWorkspaceAction({ kind: "navigate", projectId: item.editorProjectId }); }}
              onCreateEditorProject={createEditorProject}
              beforeDelete={beforeDelete}
              onDeleted={handleDeleted}
              onStartWriting={() => setActiveTab("write")}
            />
          </div>
        </div>
      </div>

      <AlertDialog open={!!pendingReplacement} onOpenChange={(open) => { if (!open) setPendingReplacement(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{replacementAfterSaveFailure ? "บันทึกไม่สำเร็จ" : "ทิ้งสิ่งที่กำลังเขียน?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {replacementAfterSaveFailure
                ? "ข้อความล่าสุดยังอยู่ในหน้านี้ ลองบันทึกอีกครั้ง หรือทิ้งการแก้ไขเพื่อไปต่อ"
                : "หัวข้อและ Hook นี้ยังไม่ได้สร้างเป็นสคริปต์ คุณต้องการทิ้งแล้วไปต่อหรือไม่"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">ยกเลิก</AlertDialogCancel>
            {replacementAfterSaveFailure && (
              <button type="button" className="min-h-11 rounded-md border px-4 text-sm font-medium" onClick={() => {
                const replacement = pendingReplacement;
                setPendingReplacement(null);
                if (replacement) void requestWorkspaceAction(replacement);
              }}>
                ลองบันทึกอีกครั้ง
              </button>
            )}
            <AlertDialogAction className="min-h-11" onClick={() => {
              const replacement = pendingReplacement;
              setPendingReplacement(null);
              if (replacement) void executeWorkspaceAction(replacement);
            }}>ทิ้งแล้วไปต่อ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
