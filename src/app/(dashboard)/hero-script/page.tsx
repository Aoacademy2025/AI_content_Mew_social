"use client";

// /hero-script — "เขียนสคริปต์ AI" page shell.
//
// Task 1 shipped the Setup rail (BrandProfilePanel: profile picker + duration
// + create/edit dialog + Niche Drill-down). Task 2 added steps 2-3 (หัวข้อ →
// เลือก Hook). Task 3 adds step 4 (สคริปต์เต็ม, with the still-disabled step-5
// "ส่งไปตัดต่อ" CTA) and the "สคริปต์ของฉัน" history list. All cross-step state
// is lifted here: profile/duration/topic/hook feed generation, and `draft` is
// the working Script that step 4 autosaves and the history list restores into.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe } from "@/lib/use-me";
import {
  BrandProfilePanel,
  type DurationSec,
} from "./_components/BrandProfilePanel";
import { TopicStep } from "./_components/TopicStep";
import { HookStep, hookContextKey, type HookChoice } from "./_components/HookStep";
import { ScriptEditorStep, type ScriptDraft } from "./_components/ScriptEditorStep";
import { ScriptHistory, type SavedScript } from "./_components/ScriptHistory";
import { HeroScriptQuickStart } from "./_components/HeroScriptQuickStart";
import {
  readHeroScriptWritingPreferences,
  writeHeroScriptWritingPreferences,
} from "./_components/hero-script-workspace-state";

const VIOLET_LIGHT = "#B9A6FF";

export default function HeroScriptPage() {
  const [plan, setPlan] = useState("FREE");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [availableProfiles, setAvailableProfiles] = useState<Array<{ id: string }> | null>(null);
  const [activeTab, setActiveTab] = useState<"write" | "library">("write");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<DurationSec>(60);
  const [topic, setTopic] = useState("");
  const [selectedHook, setSelectedHook] = useState<HookChoice | null>(null);
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const hydratedAccountRef = useRef<string | null>(null);
  const workspaceChangedRef = useRef(false);

  useEffect(() => {
    fetchMe().then((me) => {
      if (me) setPlan((me.effectivePlan ?? me.plan) || "FREE");
      setAccountId(typeof me?.id === "string" ? me.id : null);
    });
  }, []);

  useEffect(() => {
    workspaceChangedRef.current = false;
    hydratedAccountRef.current = null;
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !availableProfiles) return;
    if (hydratedAccountRef.current === accountId) return;
    hydratedAccountRef.current = accountId;
    if (workspaceChangedRef.current) return;
    const preferences = readHeroScriptWritingPreferences(window.localStorage, accountId, availableProfiles);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrates React state from validated browser-only preferences.
    setSelectedProfileId(preferences.profileId);
    setDurationSec(preferences.durationSec);
  }, [accountId, availableProfiles]);

  const rememberWritingPreferences = useCallback((profileId: string | null, nextDurationSec: DurationSec) => {
    if (!accountId) return;
    writeHeroScriptWritingPreferences(window.localStorage, accountId, { profileId, durationSec: nextDurationSec });
  }, [accountId]);

  const changeProfile = useCallback((profileId: string | null) => {
    workspaceChangedRef.current = true;
    setSelectedProfileId(profileId);
    rememberWritingPreferences(profileId, durationSec);
  }, [durationSec, rememberWritingPreferences]);

  const changeDuration = useCallback((nextDurationSec: DurationSec) => {
    workspaceChangedRef.current = true;
    setDurationSec(nextDurationSec);
    rememberWritingPreferences(selectedProfileId, nextDurationSec);
  }, [rememberWritingPreferences, selectedProfileId]);

  // Restore a saved script into step 4 — and back-fill the earlier steps it
  // was written with, so a regenerate uses the same profile/duration/topic.
  function restoreScript(script: SavedScript) {
    workspaceChangedRef.current = true;
    setSelectedProfileId(script.brandProfileId);
    setDurationSec(script.durationSec as DurationSec);
    setTopic(script.topic);
    const contextKey = hookContextKey(script.topic, script.durationSec, script.brandProfileId);
    setSelectedHook({ formula: script.hookFormula ?? "", text: script.hookText, contextKey });
    setDraft({
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
    });
  }

  const changeTopic = useCallback((nextTopic: string) => {
    workspaceChangedRef.current = true;
    if (selectedHook?.contextKey !== hookContextKey(nextTopic, durationSec, selectedProfileId)) setSelectedHook(null);
    setTopic(nextTopic);
  }, [durationSec, selectedHook, selectedProfileId]);

  const changeHook = useCallback((hook: HookChoice | null) => {
    workspaceChangedRef.current = true;
    setSelectedHook(hook);
  }, []);

  const changeDraft = useCallback((nextDraft: ScriptDraft | null) => {
    if (nextDraft) workspaceChangedRef.current = true;
    setDraft(nextDraft);
  }, []);

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="space-y-6">
          <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-3" style={{ borderColor: "var(--ui-divider)" }}>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
                Hero Script
              </p>
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl" style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}>
                เขียนสคริปต์ AI
              </h1>
            </div>
            <div role="tablist" aria-label="พื้นที่สคริปต์" className="flex min-h-11 items-center gap-1 rounded-lg p-1" style={{ background: "var(--ui-btn-bg)" }}>
              <button type="button" role="tab" aria-selected={activeTab === "write"} onClick={() => setActiveTab("write")} className="min-h-9 rounded-md px-3 text-sm font-semibold" style={{ background: activeTab === "write" ? VIOLET_LIGHT : "transparent", color: activeTab === "write" ? "#241a3c" : "var(--ui-text-secondary)" }}>
                เขียนสคริปต์
              </button>
              <button type="button" role="tab" aria-selected={activeTab === "library"} onClick={() => setActiveTab("library")} className="min-h-9 rounded-md px-3 text-sm font-semibold" style={{ background: activeTab === "library" ? VIOLET_LIGHT : "transparent", color: activeTab === "library" ? "#241a3c" : "var(--ui-text-secondary)" }}>
                คลังสคริปต์
              </button>
            </div>
          </header>

          {/* Keep this pane mounted while the library is open: the editor owns
              debounced saves and its in-flight work must survive tab changes. */}
          <div role="tabpanel" hidden={activeTab !== "write"} className="space-y-6">
            <HeroScriptQuickStart accountId={accountId} />
            <BrandProfilePanel
              plan={plan}
              selectedProfileId={selectedProfileId}
              onSelectedProfileIdChange={changeProfile}
              durationSec={durationSec}
              onDurationSecChange={changeDuration}
              onProfilesChange={setAvailableProfiles}
            />
            <TopicStep selectedProfileId={selectedProfileId} topic={topic} onTopicChange={changeTopic} />
            {topic.trim() && <HookStep topic={topic} durationSec={durationSec} selectedProfileId={selectedProfileId} selectedHook={selectedHook} onSelectedHookChange={changeHook} />}
            {(selectedHook || draft) && <>
              {!selectedHook && <p role="status" className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ร่างเดิมยังอยู่ เลือก Hook ใหม่ก่อนสร้างสคริปต์ต่อ</p>}
              <ScriptEditorStep topic={topic} durationSec={durationSec} plan={plan} selectedProfileId={selectedProfileId} selectedHook={selectedHook} onSelectedHookChange={changeHook} draft={draft} onDraftChange={changeDraft} onSaved={() => setHistoryKey((k) => k + 1)} />
            </>}
          </div>

          <div role="tabpanel" hidden={activeTab !== "library"}>
            <ScriptHistory refreshKey={historyKey} activeScriptId={draft?.id ?? null} onRestore={restoreScript} onDeleted={(id) => setDraft((d) => (d?.id === id ? null : d))} />
          </div>
        </div>
      </div>
    </div>
  );
}
