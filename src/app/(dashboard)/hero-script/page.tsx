"use client";

// /hero-script — "เขียนสคริปต์ AI" page shell.
//
// Task 1 shipped the Setup rail (BrandProfilePanel: profile picker + duration
// + create/edit dialog + Niche Drill-down). Task 2 added steps 2-3 (หัวข้อ →
// เลือก Hook). Task 3 adds step 4 (สคริปต์เต็ม, with the still-disabled step-5
// "ส่งไปตัดต่อ" CTA) and the "สคริปต์ของฉัน" history list. All cross-step state
// is lifted here: profile/duration/topic/hook feed generation, and `draft` is
// the working Script that step 4 autosaves and the history list restores into.

import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/use-me";
import {
  BrandProfilePanel,
  type DurationSec,
} from "./_components/BrandProfilePanel";
import { TopicStep } from "./_components/TopicStep";
import { HookStep, type HookChoice } from "./_components/HookStep";
import { ScriptEditorStep, type ScriptDraft } from "./_components/ScriptEditorStep";
import { ScriptHistory, type SavedScript } from "./_components/ScriptHistory";

const VIOLET_LIGHT = "#B9A6FF";

export default function HeroScriptPage() {
  const [plan, setPlan] = useState("FREE");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<DurationSec>(60);
  const [topic, setTopic] = useState("");
  const [selectedHook, setSelectedHook] = useState<HookChoice | null>(null);
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  useEffect(() => {
    fetchMe().then((me) => {
      if (me) setPlan((me.effectivePlan ?? me.plan) || "FREE");
    });
  }, []);

  // Restore a saved script into step 4 — and back-fill the earlier steps it
  // was written with, so a regenerate uses the same profile/duration/topic.
  function restoreScript(script: SavedScript) {
    setSelectedProfileId(script.brandProfileId);
    setDurationSec(script.durationSec as DurationSec);
    setTopic(script.topic);
    setSelectedHook({ formula: script.hookFormula ?? "", text: script.hookText });
    setDraft({
      id: script.id,
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

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="space-y-6">
          {/* ── Page header ── */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
              Hero Script
            </p>
            <h1
              className="text-2xl font-bold tracking-tight md:text-3xl"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}
            >
              เขียนสคริปต์ AI
            </h1>
          </div>

          {/* ── Step 1: Setup rail ── */}
          <BrandProfilePanel
            plan={plan}
            selectedProfileId={selectedProfileId}
            onSelectedProfileIdChange={setSelectedProfileId}
            durationSec={durationSec}
            onDurationSecChange={setDurationSec}
          />

          {/* ── Step 2: หัวข้อ ── */}
          <TopicStep
            selectedProfileId={selectedProfileId}
            topic={topic}
            onTopicChange={setTopic}
          />

          {/* ── Step 3: เลือก Hook ── */}
          <HookStep
            topic={topic}
            durationSec={durationSec}
            selectedProfileId={selectedProfileId}
            selectedHook={selectedHook}
            onSelectedHookChange={setSelectedHook}
          />

          {/* ── Step 4: สคริปต์เต็ม (+ the step-5 CTA, wired in Task 4) ── */}
          <ScriptEditorStep
            topic={topic}
            durationSec={durationSec}
            selectedProfileId={selectedProfileId}
            selectedHook={selectedHook}
            onSelectedHookChange={setSelectedHook}
            draft={draft}
            onDraftChange={setDraft}
            onSaved={() => setHistoryKey((k) => k + 1)}
          />

          {/* ── History: สคริปต์ของฉัน ── */}
          <ScriptHistory
            refreshKey={historyKey}
            activeScriptId={draft?.id ?? null}
            onRestore={restoreScript}
            onDeleted={(id) => setDraft((d) => (d?.id === id ? null : d))}
          />
        </div>
      </div>
    </div>
  );
}
