"use client";

// ScriptEditorStep — Hero Script UI spec step 4 ("สคริปต์เต็ม") + the step-5
// primary CTA: three editable sections (Hook / เนื้อหา / CTA), each with its own
// regenerate button, a word-count-vs-budget indicator, and a debounced autosave
// that creates the Script row once (POST) and then updates it (PUT).
//
// The chosen hook is the user's, not the model's: /api/scripts/generate never
// returns a hook — line 1 of the saved script is always the exact text the user
// picked/edited in step 3.
//
// "ส่งไปตัดต่อ" is rendered here but stays disabled: Task 4 wires
// POST /api/scripts/[id]/send-to-editor + the FREE upsell state.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tokenizeWords } from "@/lib/tts-timing";
import { TTS_WORDS_PER_SECOND } from "@/lib/prompts/content-generator";
import type { HookChoice } from "./HookStep";

const VIOLET = "#8B5CF6";

// 429 quota copy — exact Thai string from the shared spec's "Quota/error states" table.
const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";

const AUTOSAVE_DELAY_MS = 1200;
/** ±15% — the tolerance the GENERATE prompt states around the word budget. */
const BUDGET_TOLERANCE = 0.15;

/** The step-4 working copy of a Script. `id` is null until the first autosave
 *  has created the row. */
export interface ScriptDraft {
  id: string | null;
  topic: string;
  durationSec: number;
  hookFormula: string | null;
  structure: string | null;
  hookText: string;
  bodyText: string;
  ctaText: string;
  status: string;
}

type RegenTarget = "hook" | "body" | "cta";

async function toastErrorResponse(res: Response, fallback: string) {
  let data: { error?: string; code?: string } | null = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 429) { toast.error(QUOTA_MESSAGE); return; }
  if (res.status === 409 && data?.code === "KEY_REQUIRED") {
    toast.error("ยังไม่ได้ตั้งค่า Gemini API key — ไปที่ Settings เพื่อเพิ่มคีย์");
    return;
  }
  toast.error(data?.error || fallback);
}

/** Same layout as assembleScript() on the server (hook \n body \n cta) — used
 *  only to count words for the budget indicator. */
function assembleForCount(draft: ScriptDraft): string {
  return `${draft.hookText}\n${draft.bodyText}\n${draft.ctaText}`;
}

interface ScriptEditorStepProps {
  topic: string;
  durationSec: number;
  selectedProfileId: string | null;
  selectedHook: HookChoice | null;
  onSelectedHookChange: (hook: HookChoice | null) => void;
  draft: ScriptDraft | null;
  onDraftChange: (draft: ScriptDraft | null) => void;
  /** Fired after a successful save so the history list can refresh. */
  onSaved?: () => void;
}

export function ScriptEditorStep({
  topic, durationSec, selectedProfileId, selectedHook, onSelectedHookChange,
  draft, onDraftChange, onSaved,
}: ScriptEditorStepProps) {
  const [generating, setGenerating] = useState(false);
  const [regenTarget, setRegenTarget] = useState<RegenTarget | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Refs so the debounced autosave always reads the freshest values without
  // re-arming itself on every parent re-render.
  const draftRef = useRef(draft);
  const profileIdRef = useRef(selectedProfileId);
  const onDraftChangeRef = useRef(onDraftChange);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { profileIdRef.current = selectedProfileId; }, [selectedProfileId]);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  // Autosave bookkeeping:
  //  - lastSavedRef: the last snapshot successfully persisted (dedupe).
  //  - rowIdRef: the DB row this draft maps to. Read INSTEAD of draft.id when
  //    saving, because a queued save can run before React has re-rendered the
  //    draft with the id its own POST just created — reading a stale null there
  //    would create a second row for the same script.
  //  - generationRef: bumped whenever the draft is replaced wholesale (a fresh
  //    generation / a restore from history), so an in-flight save can tell that
  //    its result no longer belongs to what's on screen.
  //  - chainRef: serializes saves so two writes can never land out of order.
  const lastSavedRef = useRef("");
  const rowIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const snapshotOf = useCallback((d: ScriptDraft, profileId: string | null) => JSON.stringify({
    id: d.id,
    topic: d.topic,
    durationSec: d.durationSec,
    hookFormula: d.hookFormula,
    structure: d.structure,
    hookText: d.hookText,
    bodyText: d.bodyText,
    ctaText: d.ctaText,
    brandProfileId: profileId,
  }), []);

  const persist = useCallback(async () => {
    const d = draftRef.current;
    if (!d) return;
    const generation = generationRef.current;
    const profileId = profileIdRef.current;
    const snapshot = snapshotOf(d, profileId);
    if (snapshot === lastSavedRef.current) return;

    const rowId = d.id ?? rowIdRef.current;
    const payload = {
      topic: d.topic,
      durationSec: d.durationSec,
      hookFormula: d.hookFormula,
      structure: d.structure,
      hookText: d.hookText,
      bodyText: d.bodyText,
      ctaText: d.ctaText,
      brandProfileId: profileId,
    };
    setSaveState("saving");
    try {
      const res = rowId
        ? await fetch(`/api/scripts/${rowId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/scripts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      // The draft was replaced while this save was in flight (new generation or
      // a restore) — its result must not touch what's on screen now.
      if (generationRef.current !== generation) return;
      if (!res.ok) {
        setSaveState("idle");
        await toastErrorResponse(res, "บันทึกสคริปต์ไม่สำเร็จ");
        return;
      }
      const saved = await res.json();
      rowIdRef.current = saved.id;
      lastSavedRef.current = JSON.stringify({ ...JSON.parse(snapshot), id: saved.id });
      const latest = draftRef.current;
      if (latest && latest.id !== saved.id) onDraftChangeRef.current({ ...latest, id: saved.id });
      setSaveState("saved");
      onSavedRef.current?.();
    } catch {
      if (generationRef.current === generation) {
        setSaveState("idle");
        toast.error("บันทึกสคริปต์ไม่สำเร็จ");
      }
    }
  }, [snapshotOf]);

  // Debounced autosave.
  useEffect(() => {
    if (!draft) return;
    const snapshot = snapshotOf(draft, selectedProfileId);
    if (snapshot === lastSavedRef.current) return;
    // A draft that arrives with an id we haven't saved ourselves came from
    // "สคริปต์ของฉัน" — it is already persisted, so record it as the baseline
    // instead of immediately writing identical content back.
    if (draft.id && draft.id !== rowIdRef.current) {
      generationRef.current += 1;
      rowIdRef.current = draft.id;
      lastSavedRef.current = snapshot;
      setSaveState("saved");
      return;
    }
    const timer = setTimeout(() => {
      chainRef.current = chainRef.current.then(persist).catch(() => {});
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, selectedProfileId, snapshotOf, persist]);

  async function handleGenerate() {
    if (!selectedHook || !topic.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          hookText: selectedHook.text,
          hookFormula: selectedHook.formula,
          brandProfileId: selectedProfileId,
          durationSec,
        }),
      });
      if (!res.ok) { await toastErrorResponse(res, "สร้างสคริปต์ไม่สำเร็จ"); return; }
      const data = await res.json();
      if (data.warning) toast.warning(data.warning);
      // A fresh generation is a NEW script (id: null) — the autosave creates
      // its own row, so regenerating never overwrites an earlier script.
      generationRef.current += 1;
      rowIdRef.current = null;
      lastSavedRef.current = "";
      onDraftChange({
        id: null,
        topic: topic.trim(),
        durationSec,
        hookFormula: selectedHook.formula,
        structure: data.structure ?? null,
        hookText: selectedHook.text,
        bodyText: data.bodyText ?? "",
        ctaText: data.ctaText ?? "",
        status: "draft",
      });
      setSaveState("idle");
    } catch {
      toast.error("สร้างสคริปต์ไม่สำเร็จ");
    } finally {
      setGenerating(false);
    }
  }

  async function handleRegen(target: RegenTarget) {
    const d = draftRef.current;
    if (!d) return;
    setRegenTarget(target);
    try {
      const res = await fetch("/api/scripts/regen-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          topic: d.topic,
          durationSec: d.durationSec,
          brandProfileId: selectedProfileId,
          hookFormula: d.hookFormula,
          current: { hookText: d.hookText, bodyText: d.bodyText, ctaText: d.ctaText },
        }),
      });
      if (!res.ok) { await toastErrorResponse(res, "เขียนใหม่ไม่สำเร็จ"); return; }
      const data = await res.json();
      if (data.warning) toast.warning(data.warning);
      const text = typeof data.text === "string" ? data.text : "";
      if (!text) return;
      const current = draftRef.current;
      if (!current) return;
      if (target === "hook") {
        const formula = typeof data.formula === "string" ? data.formula : current.hookFormula;
        onDraftChange({ ...current, hookText: text, hookFormula: formula });
        onSelectedHookChange({ formula: formula ?? "", text });
      } else if (target === "body") {
        onDraftChange({ ...current, bodyText: text });
      } else {
        onDraftChange({ ...current, ctaText: text });
      }
    } catch {
      toast.error("เขียนใหม่ไม่สำเร็จ");
    } finally {
      setRegenTarget(null);
    }
  }

  function editSection(patch: Partial<ScriptDraft>) {
    const current = draftRef.current;
    if (!current) return;
    onDraftChange({ ...current, ...patch });
  }

  const budgetDuration = draft?.durationSec ?? durationSec;
  // Same formula as wordBudgetForDuration() on the server — one pacing constant.
  const wordBudget = Math.round(budgetDuration * TTS_WORDS_PER_SECOND);
  const wordCount = draft ? tokenizeWords(assembleForCount(draft)).length : 0;
  const withinBudget =
    wordCount >= Math.round(wordBudget * (1 - BUDGET_TOLERANCE)) &&
    wordCount <= Math.round(wordBudget * (1 + BUDGET_TOLERANCE));

  const sections: { key: RegenTarget; label: string; value: string; rows: number; onChange: (v: string) => void }[] = draft
    ? [
        { key: "hook", label: "Hook", value: draft.hookText, rows: 2, onChange: (v) => editSection({ hookText: v }) },
        { key: "body", label: "เนื้อหา", value: draft.bodyText, rows: 10, onChange: (v) => editSection({ bodyText: v }) },
        { key: "cta", label: "CTA", value: draft.ctaText, rows: 2, onChange: (v) => editSection({ ctaText: v }) },
      ]
    : [];

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>สคริปต์เต็ม</h2>
        <div className="flex items-center gap-3">
          {draft && (
            <span className="text-[11px]" style={{ color: withinBudget ? VIOLET : "var(--ui-text-muted)" }}>
              {wordCount} คำ / งบคำ ~{wordBudget} คำ (±15%)
            </span>
          )}
          <Button
            onClick={handleGenerate}
            disabled={generating || !selectedHook || !topic.trim()}
            size="sm"
            className="gap-1.5 text-white"
            style={{ background: VIOLET }}
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            สร้างสคริปต์เต็ม
          </Button>
        </div>
      </div>

      {draft && (
        <div className="space-y-4">
          {sections.map((section) => (
            <div key={section.key}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>{section.label}</span>
                <Button
                  onClick={() => handleRegen(section.key)}
                  disabled={regenTarget !== null}
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px]"
                  style={{ color: VIOLET }}
                >
                  {regenTarget === section.key
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                  เขียนใหม่
                </Button>
              </div>
              <Textarea
                value={section.value}
                onChange={(e) => section.onChange(e.target.value)}
                rows={section.rows}
                className="text-xs"
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
              {saveState === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> กำลังบันทึก…</>}
              {saveState === "saved" && <><Check className="h-3 w-3" /> บันทึกแล้ว</>}
            </span>
            {/* Task 4 wires this to POST /api/scripts/[id]/send-to-editor. */}
            <Button disabled className="text-white" style={{ background: VIOLET }}>
              ส่งไปตัดต่อ
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
