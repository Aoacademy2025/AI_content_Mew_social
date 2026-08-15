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
// Step 5 ("ส่งไปตัดต่อ") is the money path and lives here too: paid plans POST
// /api/scripts/[id]/send-to-editor and land in the editor on the new project;
// FREE sees the locked CTA + the /pricing upsell.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, Lock, RefreshCw, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tokenizeWords } from "@/lib/tts-timing";
import { limitsForPlan } from "@/lib/plan-limits";
import { TTS_WORDS_PER_SECOND } from "@/lib/prompts/content-generator";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import { hookContextKey, type HookChoice } from "./HookStep";

const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";

// 429 quota copy — exact Thai string from the shared spec's "Quota/error states" table.
const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";
/** Locked-CTA copy for FREE (UI spec step 5) — the API's 403 EDITOR_LOCKED says the same. */
const EDITOR_LOCKED_MESSAGE = "อัปเกรดเป็น PRO เพื่อส่งเข้าตัดต่อ";
/** 503 from the pro-tier routes when the configured model id is gone/unusable.
 *  Mirrors MODEL_UNAVAILABLE_CODE/MESSAGE in src/lib/hero-script.server.ts
 *  (a server module — it can't be imported here), same as the two above. */
const MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE";
const MODEL_UNAVAILABLE_MESSAGE =
  "โมเดล AI สำหรับเขียนสคริปต์ไม่พร้อมใช้งานชั่วคราว โปรดลองใหม่อีกครั้งหรือแจ้งทีมงาน";

const AUTOSAVE_DELAY_MS = 1200;
/** ±15% — the tolerance the GENERATE prompt states around the word budget. */
const BUDGET_TOLERANCE = 0.15;

/** The step-4 working copy of a Script. `id` is null until the first autosave
 *  has created the row. */
export interface ScriptDraft {
  id: string | null;
  brandProfileId: string | null;
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

async function toastErrorResponse(
  res: Response,
  fallback: string,
  opts?: { onUpgrade?: () => void }
) {
  let data: { error?: string; code?: string } | null = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 429) { toast.error(QUOTA_MESSAGE); return; }
  if (res.status === 401) {
    toast.error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง");
    return;
  }
  if (res.status === 409 && data?.code === "KEY_REQUIRED") {
    toast.error("ยังไม่ได้ตั้งค่า Gemini API key — ไปที่ Settings เพื่อเพิ่มคีย์");
    return;
  }
  // The pro model id is gone/unusable (503 MODEL_UNAVAILABLE) — a different
  // problem from "AI ตอบผิดรูปแบบ", and retrying the same call won't fix it,
  // so it gets its own (longer-lived) toast instead of the generic one.
  if (res.status === 503 && data?.code === MODEL_UNAVAILABLE_CODE) {
    toast.error(data.error || MODEL_UNAVAILABLE_MESSAGE, { duration: 8000 });
    return;
  }
  // Plan walls (FREE script cap / editor locked) — offer the pricing page.
  if (res.status === 403 && (data?.code === "SCRIPT_LIMIT" || data?.code === "EDITOR_LOCKED") && opts?.onUpgrade) {
    toast.error(data.error || fallback, {
      duration: 8000,
      action: { label: "ดูแผนราคา", onClick: opts.onUpgrade },
    });
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
  /** Effective plan — decides whether step 5 sends or upsells. */
  plan: string;
  selectedProfileId: string | null;
  selectedHook: HookChoice | null;
  onSelectedHookChange: (hook: HookChoice | null) => void;
  draft: ScriptDraft | null;
  onDraftChange: (draft: ScriptDraft | null) => void;
  /** Fired after a successful save so the history list can refresh. */
  onSaved?: () => void;
}

export function ScriptEditorStep({
  topic, durationSec, plan, selectedProfileId, selectedHook, onSelectedHookChange,
  draft, onDraftChange, onSaved,
}: ScriptEditorStepProps) {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [regenTarget, setRegenTarget] = useState<RegenTarget | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [sending, setSending] = useState(false);
  const goToPricing = useCallback(() => {
    trackEvent("hero_script_upgrade_clicked", { properties: { surface: "limit_error" } });
    router.push("/pricing?source=hero_script_limit");
  }, [router]);

  // Refs so the debounced autosave always reads the freshest values without
  // re-arming itself on every parent re-render.
  const draftRef = useRef(draft);
  const onDraftChangeRef = useRef(onDraftChange);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { draftRef.current = draft; }, [draft]);
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

  const snapshotOf = useCallback((d: ScriptDraft) => JSON.stringify({
    id: d.id,
    topic: d.topic,
    durationSec: d.durationSec,
    hookFormula: d.hookFormula,
    structure: d.structure,
    hookText: d.hookText,
    bodyText: d.bodyText,
    ctaText: d.ctaText,
    brandProfileId: d.brandProfileId,
  }), []);

  const persist = useCallback(async () => {
    const d = draftRef.current;
    if (!d) return;
    const generation = generationRef.current;
    const snapshot = snapshotOf(d);
    if (snapshot === lastSavedRef.current) return;

    const rowId = d.id ?? rowIdRef.current;
    const saveMode = rowId ? "update" : "create";
    const startedAt = performance.now();
    const payload = {
      topic: d.topic,
      durationSec: d.durationSec,
      hookFormula: d.hookFormula,
      structure: d.structure,
      hookText: d.hookText,
      bodyText: d.bodyText,
      ctaText: d.ctaText,
      brandProfileId: d.brandProfileId,
    };
    setSaveState("saving");
    try {
      const res = rowId
        ? await authenticatedFetch(`/api/scripts/${rowId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await authenticatedFetch("/api/scripts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      // The draft was replaced while this save was in flight (new generation or
      // a restore) — its result must not touch what's on screen now.
      if (generationRef.current !== generation) return;
      if (!res.ok) {
        setSaveState("idle");
        trackEvent("hero_script_save_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status, saveMode },
        });
        // 403 SCRIPT_LIMIT lands here — the FREE 3-scripts/30-days cap.
        await toastErrorResponse(res, "บันทึกสคริปต์ไม่สำเร็จ", { onUpgrade: goToPricing });
        return;
      }
      const saved = await res.json();
      rowIdRef.current = saved.id;
      lastSavedRef.current = JSON.stringify({ ...JSON.parse(snapshot), id: saved.id });
      const latest = draftRef.current;
      if (latest && latest.id !== saved.id) onDraftChangeRef.current({ ...latest, id: saved.id });
      setSaveState("saved");
      trackEvent("hero_script_saved", {
        status: "done", durationMs: performance.now() - startedAt,
        properties: { saveMode, profileUsed: Boolean(d.brandProfileId) },
      });
      onSavedRef.current?.();
    } catch {
      if (generationRef.current === generation) {
        setSaveState("idle");
        trackEvent("hero_script_save_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { failure: "network", saveMode },
        });
        toast.error("บันทึกสคริปต์ไม่สำเร็จ");
      }
    }
  }, [snapshotOf, goToPricing]);

  // Debounced autosave.
  useEffect(() => {
    if (!draft) return;
    const snapshot = snapshotOf(draft);
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
  }, [draft, snapshotOf, persist]);

  async function handleGenerate() {
    const currentContext = hookContextKey(topic, durationSec, selectedProfileId);
    if (!selectedHook || selectedHook.contextKey !== currentContext || !topic.trim()) return;
    const startedAt = performance.now();
    trackEvent("hero_script_generation_requested", {
      status: "started",
      properties: { durationSec, profileUsed: Boolean(selectedProfileId), hookFormula: selectedHook.formula },
    });
    setGenerating(true);
    try {
      const res = await authenticatedFetch("/api/scripts/generate", {
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
      if (!res.ok) {
        trackEvent("hero_script_generation_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status, durationSec, profileUsed: Boolean(selectedProfileId) },
        });
        await toastErrorResponse(res, "สร้างสคริปต์ไม่สำเร็จ", { onUpgrade: goToPricing });
        return;
      }
      const data = await res.json();
      if (data.warning) toast.warning(data.warning);
      // A fresh generation is a NEW script (id: null) — the autosave creates
      // its own row, so regenerating never overwrites an earlier script.
      generationRef.current += 1;
      rowIdRef.current = null;
      lastSavedRef.current = "";
      onDraftChange({
        id: null,
        brandProfileId: selectedProfileId,
        topic: topic.trim(),
        durationSec,
        hookFormula: selectedHook.formula,
        structure: data.structure ?? null,
        hookText: selectedHook.text,
        bodyText: data.bodyText ?? "",
        ctaText: data.ctaText ?? "",
        status: "draft",
      });
      trackEvent("hero_script_generated", {
        status: "done", durationMs: performance.now() - startedAt,
        properties: {
          durationSec,
          profileUsed: Boolean(selectedProfileId),
          warning: Boolean(data.warning),
        },
      });
      setSaveState("idle");
    } catch {
      trackEvent("hero_script_generation_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { failure: "network", durationSec, profileUsed: Boolean(selectedProfileId) },
      });
      toast.error("สร้างสคริปต์ไม่สำเร็จ");
    } finally {
      setGenerating(false);
    }
  }

  async function handleRegen(target: RegenTarget) {
    const d = draftRef.current;
    if (!d) return;
    const startedAt = performance.now();
    trackEvent("hero_script_regen_requested", { status: "started", properties: { target } });
    setRegenTarget(target);
    try {
      const res = await authenticatedFetch("/api/scripts/regen-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          topic: d.topic,
          durationSec: d.durationSec,
          brandProfileId: d.brandProfileId,
          hookFormula: d.hookFormula,
          current: { hookText: d.hookText, bodyText: d.bodyText, ctaText: d.ctaText },
        }),
      });
      if (!res.ok) {
        trackEvent("hero_script_regen_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { target, httpStatus: res.status },
        });
        await toastErrorResponse(res, "เขียนใหม่ไม่สำเร็จ");
        return;
      }
      const data = await res.json();
      if (data.warning) toast.warning(data.warning);
      const text = typeof data.text === "string" ? data.text : "";
      if (!text) return;
      const current = draftRef.current;
      if (!current) return;
      if (target === "hook") {
        const formula = typeof data.formula === "string" ? data.formula : current.hookFormula;
        onDraftChange({ ...current, hookText: text, hookFormula: formula });
        onSelectedHookChange({
          formula: formula ?? "",
          text,
          contextKey: hookContextKey(d.topic, d.durationSec, d.brandProfileId),
        });
      } else if (target === "body") {
        onDraftChange({ ...current, bodyText: text });
      } else {
        onDraftChange({ ...current, ctaText: text });
      }
      trackEvent("hero_script_regenerated", {
        status: "done", durationMs: performance.now() - startedAt, properties: { target },
      });
    } catch {
      trackEvent("hero_script_regen_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { target, failure: "network" },
      });
      toast.error("เขียนใหม่ไม่สำเร็จ");
    } finally {
      setRegenTarget(null);
    }
  }

  // Step 5 — hand the saved script to the video editor and go there.
  // The row must exist first (the autosave creates it), so the CTA stays
  // disabled until this draft has an id.
  async function handleSendToEditor() {
    const d = draftRef.current;
    const scriptId = d?.id ?? rowIdRef.current;
    if (!d || !scriptId || sending) return;
    const startedAt = performance.now();
    trackEvent("hero_script_handoff_requested", { status: "started" });
    setSending(true);
    try {
      const res = await authenticatedFetch(`/api/scripts/${scriptId}/send-to-editor`, { method: "POST" });
      if (!res.ok) {
        trackEvent("hero_script_handoff_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status },
        });
        await toastErrorResponse(res, "ส่งไปตัดต่อไม่สำเร็จ", { onUpgrade: goToPricing });
        return;
      }
      const data = await res.json();
      const projectId = typeof data?.projectId === "string" ? data.projectId : "";
      if (!projectId) {
        trackEvent("hero_script_handoff_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { failure: "missing_project_id" },
        });
        toast.error("ส่งไปตัดต่อไม่สำเร็จ");
        return;
      }
      // Flip the local status so the history chip reads "ส่งแล้ว" even if the
      // navigation takes a moment.
      const latest = draftRef.current;
      if (latest) onDraftChangeRef.current({ ...latest, status: "sent" });
      onSavedRef.current?.();
      trackEvent("hero_script_handoff_completed", {
        status: "done", durationMs: performance.now() - startedAt,
      });
      router.push(`/video-editor?projectId=${encodeURIComponent(projectId)}`);
    } catch {
      trackEvent("hero_script_handoff_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { failure: "network" },
      });
      toast.error("ส่งไปตัดต่อไม่สำเร็จ");
    } finally {
      setSending(false);
    }
  }

  function editSection(patch: Partial<ScriptDraft>) {
    const current = draftRef.current;
    if (!current) return;
    onDraftChange({ ...current, ...patch });
  }

  // Plan gate for step 5 — the same `allowVideoEditor` limit the API enforces
  // (a FREE user who forces the request still gets 403 EDITOR_LOCKED).
  const canSendToEditor = limitsForPlan(plan).allowVideoEditor;
  const hookMatchesCurrentInputs = selectedHook?.contextKey === hookContextKey(topic, durationSec, selectedProfileId);

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
        {/* flex-wrap so the budget indicator drops below the button instead of
            squeezing/overflowing next to it at 360px */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {draft && (
            <span className="text-[11px]" style={{ color: withinBudget ? VIOLET : "var(--ui-text-muted)" }}>
              {wordCount} คำ / งบคำ ~{wordBudget} คำ (±15%)
            </span>
          )}
          <Button
            onClick={handleGenerate}
            disabled={generating || !selectedHook || !hookMatchesCurrentInputs || !topic.trim()}
            size="sm"
            className="min-h-11 gap-1.5 text-white"
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
                  className="min-h-11 gap-1 px-2 text-[11px]"
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

          {/* flex-col on mobile: the send-to-editor CTA (the money path) becomes a
              full-width, easily-reachable one-handed tap target below the save-status
              line, instead of squeezed into a row next to it. */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
              {saveState === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> กำลังบันทึก…</>}
              {saveState === "saved" && <><Check className="h-3 w-3" /> บันทึกแล้ว</>}
            </span>
            {/* ── Step 5: ส่งไปตัดต่อ ── */}
            {canSendToEditor ? (
              <Button
                onClick={handleSendToEditor}
                disabled={!draft.id || sending}
                className="min-h-11 gap-1.5 text-white sm:w-auto"
                style={{ background: VIOLET }}
              >
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                ส่งไปตัดต่อ
              </Button>
            ) : (
              <div
                className="rounded-lg border px-3 py-2.5 text-xs"
                style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-muted)" }}
              >
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  <span>{EDITOR_LOCKED_MESSAGE}</span>
                </div>
                <Link
                  href="/pricing?source=hero_script_editor_lock"
                  onClick={() => trackEvent("hero_script_upgrade_clicked", { properties: { surface: "editor_lock" } })}
                  className="font-medium underline"
                  style={{ color: VIOLET_LIGHT }}
                >
                  ดูแผนราคา
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
