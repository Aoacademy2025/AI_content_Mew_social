"use client";

// ScriptEditorStep v2 — Dual-mode script editor:
//   - Supports BOTH 1-click Quick Generate (returns chosen hook + 4 alternative
//     hooks + body + CTA in one call) AND step-by-step Hook Generate.
//   - Semantic section cards (HOOK orange / เนื้อหา sky / CTA emerald), inline
//     alternative-hook switcher, per-section regenerate, 1-click compact, and
//     gentle post-generation brand-save nudge for 0-brand creators.
//   - Autosave empty-hook guard: skips PUT /api/scripts/[id] while hookText is
//     temporarily blank mid-edit (stops the 400 error toast spam observed in prod)
//     and reports `saveState: "needs-hook"` cleanly.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  Loader2,
  RefreshCw,
  Scissors,
  Sparkles,
  SwatchBook,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import { getStoryStructure } from "@/lib/viral-frameworks";
import { hookContextKey, hookFormulaName, type HookChoice } from "./HookStep";
import { HS_COLOR, HS_FONT } from "./hero-script-tokens";

const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";
const MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE";
const MODEL_UNAVAILABLE_MESSAGE =
  "โมเดล AI สำหรับเขียนสคริปต์ไม่พร้อมใช้งานชั่วคราว โปรดลองใหม่อีกครั้งหรือแจ้งทีมงาน";

const AUTOSAVE_DELAY_MS = 1200;

export type ScriptSaveState = "idle" | "saving" | "saved" | "needs-hook" | "failed";

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
  editorProjectId: string | null;
  editorProjectAvailable: boolean;
}

export interface AlternativeHookItem {
  formula: string;
  text: string;
}

export interface ScriptEditorStepHandle {
  saveLatest: () => Promise<boolean>;
  createEditorProject: () => Promise<boolean>;
  runQuickGenerate: () => Promise<void>;
  runHookGenerate: () => Promise<void>;
  runCompact: () => Promise<void>;
  invalidateAsyncRequests: () => void;
}

type RegenTarget = "hook" | "body" | "cta";

async function toastErrorResponse(
  res: Response,
  fallback: string,
  opts?: { onUpgrade?: () => void; isCurrent?: () => boolean },
) {
  let data: { error?: string; code?: string } | null = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (opts?.isCurrent && !opts.isCurrent()) return;
  if (res.status === 429) { toast.error(QUOTA_MESSAGE); return; }
  if (res.status === 401) {
    toast.error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง");
    return;
  }
  if (res.status === 409 && data?.code === "KEY_REQUIRED") {
    toast.error("ยังไม่ได้ตั้งค่า Gemini API key — ไปที่ Settings เพื่อเพิ่มคีย์");
    return;
  }
  if (res.status === 503 && data?.code === MODEL_UNAVAILABLE_CODE) {
    toast.error(data.error || MODEL_UNAVAILABLE_MESSAGE, { duration: 8000 });
    return;
  }
  if (res.status === 403 && (data?.code === "SCRIPT_LIMIT" || data?.code === "EDITOR_LOCKED") && opts?.onUpgrade) {
    toast.error(data.error || fallback, {
      duration: 8000,
      action: { label: "ดูแผนราคา", onClick: opts.onUpgrade },
    });
    return;
  }
  toast.error(data?.error || fallback);
}

interface ScriptEditorStepProps {
  topic: string;
  durationSec: number;
  selectedProfileId: string | null;
  stylePreset: string | null;
  preferredStructure: string | null;
  ctaStyleOverride: string | null;
  profilesCount: number;
  selectedHook: HookChoice | null;
  onSelectedHookChange: (hook: HookChoice | null) => void;
  draft: ScriptDraft | null;
  onDraftChange: (draft: ScriptDraft | null) => void;
  onSaved?: (draft: ScriptDraft) => void;
  onCreateEditorProject: () => Promise<boolean>;
  onOpenCreateBrand?: () => void;
  onStatusChange?: (status: {
    saveState: ScriptSaveState;
    generating: boolean;
    compacting: boolean;
    sending: boolean;
  }) => void;
  handoffPending: boolean;
  handoffPosting: boolean;
}

export const ScriptEditorStep = forwardRef<ScriptEditorStepHandle, ScriptEditorStepProps>(function ScriptEditorStep({
  topic,
  durationSec,
  selectedProfileId,
  stylePreset,
  preferredStructure,
  ctaStyleOverride,
  profilesCount,
  selectedHook,
  onSelectedHookChange,
  draft,
  onDraftChange,
  onSaved,
  onCreateEditorProject,
  onOpenCreateBrand,
  onStatusChange,
  handoffPending,
  handoffPosting,
}, ref) {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [generatingMode, setGeneratingMode] = useState<"quick" | "hook">("quick");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [regenTarget, setRegenTarget] = useState<RegenTarget | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [saveState, setSaveState] = useState<ScriptSaveState>("idle");
  const [sending, setSending] = useState(false);
  const [alternativeHooks, setAlternativeHooks] = useState<AlternativeHookItem[]>([]);
  const [hooksDrawerOpen, setHooksDrawerOpen] = useState(false);
  const [brandNudgeDismissed, setBrandNudgeDismissed] = useState(false);

  const sendingRef = useRef(false);
  const goToPricing = useCallback(() => {
    trackEvent("hero_script_upgrade_clicked", { properties: { surface: "limit_error" } });
    router.push("/pricing?source=hero_script_limit");
  }, [router]);

  const draftRef = useRef(draft);
  const onDraftChangeRef = useRef(onDraftChange);
  const onSavedRef = useRef(onSaved);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  useEffect(() => {
    onStatusChangeRef.current?.({ saveState, generating, compacting, sending });
  }, [compacting, generating, saveState, sending]);

  const lastSavedRef = useRef("");
  const rowIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceRequestRef = useRef(0);

  const invalidateAsyncRequests = useCallback(() => {
    workspaceRequestRef.current += 1;
    setGenerating(false);
    setRegenTarget(null);
    setCompacting(false);
    setGenerationError(null);
  }, []);

  // Clear stale alternative hooks when workspace is reset or restored to a different draft.
  useEffect(() => {
    if (!draft) {
      setAlternativeHooks([]);
      setHooksDrawerOpen(false);
      setSaveState("idle");
      rowIdRef.current = null;
      lastSavedRef.current = "";
    }
  }, [draft]);

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

  const persist = useCallback(async (): Promise<boolean> => {
    const d = draftRef.current;
    if (!d) return true;
    const generation = generationRef.current;
    const snapshot = snapshotOf(d);
    if (snapshot === lastSavedRef.current) return true;

    // Empty-hook guard: PUT /api/scripts/[id] rejects blank hookText with 400.
    // Pause autosave cleanly while the user clears & rewrites their Hook.
    if (!d.hookText.trim()) {
      setSaveState("needs-hook");
      return false;
    }

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
      if (generationRef.current !== generation) return false;
      if (!res.ok) {
        setSaveState("failed");
        trackEvent("hero_script_save_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status, saveMode },
        });
        await toastErrorResponse(res, "บันทึกสคริปต์ไม่สำเร็จ", { onUpgrade: goToPricing });
        return false;
      }
      const saved = await res.json();
      rowIdRef.current = saved.id;
      lastSavedRef.current = JSON.stringify({ ...JSON.parse(snapshot), id: saved.id });
      const latest = draftRef.current;
      const latestWithId = latest ? { ...latest, id: saved.id } : null;
      if (latestWithId) draftRef.current = latestWithId;
      if (latestWithId && latest?.id !== saved.id) onDraftChangeRef.current(latestWithId);
      setSaveState(latestWithId && snapshotOf(latestWithId) === lastSavedRef.current ? "saved" : "saving");
      trackEvent("hero_script_saved", {
        status: "done", durationMs: performance.now() - startedAt,
        properties: { saveMode, profileUsed: Boolean(d.brandProfileId) },
      });
      onSavedRef.current?.({ ...d, id: saved.id });
      return true;
    } catch {
      if (generationRef.current === generation) {
        setSaveState("failed");
        trackEvent("hero_script_save_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { failure: "network", saveMode },
        });
        toast.error("บันทึกสคริปต์ไม่สำเร็จ");
      }
      return false;
    }
  }, [snapshotOf, goToPricing]);

  const saveLatest = useCallback((): Promise<boolean> => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const drainLatest = async () => {
      while (true) {
        if (!(await persist())) return false;
        const latest = draftRef.current;
        if (!latest || snapshotOf(latest) === lastSavedRef.current) return true;
      }
    };
    const result = chainRef.current.then(drainLatest);
    chainRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [persist, snapshotOf]);

  // Debounced autosave.
  useEffect(() => {
    if (!draft) return;
    const snapshot = snapshotOf(draft);
    if (snapshot === lastSavedRef.current) return;
    if (draft.id && draft.id !== rowIdRef.current) {
      generationRef.current += 1;
      rowIdRef.current = draft.id;
      lastSavedRef.current = snapshot;
      setAlternativeHooks([]);
      setHooksDrawerOpen(false);
      setSaveState("saved");
      return;
    }
    if (!draft.hookText.trim()) {
      setSaveState("needs-hook");
      return;
    }
    const timer = setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveLatest();
    }, AUTOSAVE_DELAY_MS);
    autosaveTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null;
    };
  }, [draft, snapshotOf, saveLatest]);

  const applyDraftPatch = useCallback((patch: Partial<ScriptDraft>) => {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setSaveState(next.hookText.trim() ? "saving" : "needs-hook");
    onDraftChange(next);
  }, [onDraftChange]);

  const runQuickGenerate = useCallback(async () => {
    if (sendingRef.current || !topic.trim()) return;
    const requestId = ++workspaceRequestRef.current;
    const startedAt = performance.now();
    const effectivePreset = selectedProfileId ? null : stylePreset;
    trackEvent("hero_script_quick_generate_requested", {
      status: "started",
      properties: {
        durationSec,
        profileUsed: Boolean(selectedProfileId),
        presetUsed: Boolean(effectivePreset),
        structureOverride: Boolean(preferredStructure),
        ctaOverride: Boolean(ctaStyleOverride),
      },
    });
    trackEvent("hero_script_generation_requested", {
      status: "started",
      properties: {
        mode: "quick",
        durationSec,
        profileUsed: Boolean(selectedProfileId),
        presetUsed: Boolean(effectivePreset),
      },
    });
    setGeneratingMode("quick");
    setGenerating(true);
    setGenerationError(null);
    try {
      if (draftRef.current && !(await saveLatest())) return;
      if (requestId !== workspaceRequestRef.current) return;
      const res = await authenticatedFetch("/api/scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "quick",
          topic: topic.trim(),
          brandProfileId: selectedProfileId,
          stylePreset: effectivePreset,
          durationSec,
          structure: preferredStructure,
          ctaStyle: ctaStyleOverride,
        }),
      });
      if (requestId !== workspaceRequestRef.current) return;
      if (!res.ok) {
        const errorBody = await res.clone().json().catch(() => null);
        if (requestId !== workspaceRequestRef.current) return;
        trackEvent("hero_script_generation_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { mode: "quick", httpStatus: res.status, durationSec, profileUsed: Boolean(selectedProfileId) },
        });
        setGenerationError(typeof errorBody?.error === "string" && errorBody.error.trim()
          ? errorBody.error
          : "สร้างสคริปต์ไม่สำเร็จ กรุณาลองอีกครั้ง");
        await toastErrorResponse(res, "สร้างสคริปต์ไม่สำเร็จ", {
          onUpgrade: goToPricing,
          isCurrent: () => requestId === workspaceRequestRef.current,
        });
        return;
      }
      const data = await res.json();
      if (requestId !== workspaceRequestRef.current) return;
      if (data.warning) toast.warning(data.warning);

      const generatedHookText = typeof data.hookText === "string" ? data.hookText : "";
      const generatedHookFormula = typeof data.hookFormula === "string" ? data.hookFormula : null;
      const alts: AlternativeHookItem[] = Array.isArray(data.alternativeHooks)
        ? data.alternativeHooks.filter(
            (item: unknown): item is AlternativeHookItem =>
              Boolean(item && typeof item === "object"
                && typeof (item as { formula?: unknown }).formula === "string"
                && typeof (item as { text?: unknown }).text === "string"),
          )
        : [];

      generationRef.current += 1;
      rowIdRef.current = null;
      lastSavedRef.current = "";
      setAlternativeHooks(alts);
      setHooksDrawerOpen(false);
      onSelectedHookChange({
        formula: generatedHookFormula ?? "",
        text: generatedHookText,
        contextKey: hookContextKey(topic, durationSec, selectedProfileId, effectivePreset),
      });
      onDraftChange({
        id: null,
        brandProfileId: selectedProfileId,
        topic: topic.trim(),
        durationSec,
        hookFormula: generatedHookFormula,
        structure: data.structure ?? null,
        hookText: generatedHookText,
        bodyText: data.bodyText ?? "",
        ctaText: data.ctaText ?? "",
        status: "draft",
        editorProjectId: null,
        editorProjectAvailable: false,
      });
      trackEvent("hero_script_quick_generate_completed", {
        status: "done", durationMs: performance.now() - startedAt,
        properties: {
          durationSec,
          profileUsed: Boolean(selectedProfileId),
          presetUsed: Boolean(effectivePreset),
          altHooks: alts.length,
          compacted: Boolean(data.compacted),
        },
      });
      trackEvent("hero_script_generated", {
        status: "done", durationMs: performance.now() - startedAt,
        properties: {
          mode: "quick",
          durationSec,
          profileUsed: Boolean(selectedProfileId),
          warning: Boolean(data.warning),
          compacted: Boolean(data.compacted),
        },
      });
      setSaveState("idle");
    } catch {
      if (requestId !== workspaceRequestRef.current) return;
      trackEvent("hero_script_generation_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { mode: "quick", failure: "network", durationSec, profileUsed: Boolean(selectedProfileId) },
      });
      setGenerationError("เชื่อมต่อไม่สำเร็จ กรุณาลองอีกครั้ง");
      toast.error("สร้างสคริปต์ไม่สำเร็จ");
    } finally {
      if (requestId === workspaceRequestRef.current) setGenerating(false);
    }
  }, [
    ctaStyleOverride,
    durationSec,
    goToPricing,
    onDraftChange,
    onSelectedHookChange,
    preferredStructure,
    saveLatest,
    selectedProfileId,
    stylePreset,
    topic,
  ]);

  const runHookGenerate = useCallback(async () => {
    if (sendingRef.current) return;
    const effectivePreset = selectedProfileId ? null : stylePreset;
    const currentContext = hookContextKey(topic, durationSec, selectedProfileId, effectivePreset);
    if (!selectedHook || selectedHook.contextKey !== currentContext || !topic.trim()) return;
    const requestId = ++workspaceRequestRef.current;
    const startedAt = performance.now();
    trackEvent("hero_script_generation_requested", {
      status: "started",
      properties: {
        mode: "hook",
        durationSec,
        profileUsed: Boolean(selectedProfileId),
        hookFormula: selectedHook.formula,
      },
    });
    setGeneratingMode("hook");
    setGenerating(true);
    setGenerationError(null);
    try {
      if (draftRef.current && !(await saveLatest())) return;
      if (requestId !== workspaceRequestRef.current) return;
      const res = await authenticatedFetch("/api/scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          hookText: selectedHook.text,
          hookFormula: selectedHook.formula,
          brandProfileId: selectedProfileId,
          stylePreset: effectivePreset,
          durationSec,
          structure: preferredStructure,
          ctaStyle: ctaStyleOverride,
        }),
      });
      if (requestId !== workspaceRequestRef.current) return;
      if (!res.ok) {
        const errorBody = await res.clone().json().catch(() => null);
        if (requestId !== workspaceRequestRef.current) return;
        trackEvent("hero_script_generation_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { mode: "hook", httpStatus: res.status, durationSec, profileUsed: Boolean(selectedProfileId) },
        });
        setGenerationError(typeof errorBody?.error === "string" && errorBody.error.trim()
          ? errorBody.error
          : "สร้างสคริปต์ไม่สำเร็จ กรุณาลองอีกครั้ง");
        await toastErrorResponse(res, "สร้างสคริปต์ไม่สำเร็จ", {
          onUpgrade: goToPricing,
          isCurrent: () => requestId === workspaceRequestRef.current,
        });
        return;
      }
      const data = await res.json();
      if (requestId !== workspaceRequestRef.current) return;
      if (data.warning) toast.warning(data.warning);
      generationRef.current += 1;
      rowIdRef.current = null;
      lastSavedRef.current = "";
      setAlternativeHooks([]);
      setHooksDrawerOpen(false);
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
        editorProjectId: null,
        editorProjectAvailable: false,
      });
      trackEvent("hero_script_generated", {
        status: "done", durationMs: performance.now() - startedAt,
        properties: {
          mode: "hook",
          durationSec,
          profileUsed: Boolean(selectedProfileId),
          warning: Boolean(data.warning),
          compacted: Boolean(data.compacted),
        },
      });
      setSaveState("idle");
    } catch {
      if (requestId !== workspaceRequestRef.current) return;
      trackEvent("hero_script_generation_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { mode: "hook", failure: "network", durationSec, profileUsed: Boolean(selectedProfileId) },
      });
      setGenerationError("เชื่อมต่อไม่สำเร็จ กรุณาลองอีกครั้ง");
      toast.error("สร้างสคริปต์ไม่สำเร็จ");
    } finally {
      if (requestId === workspaceRequestRef.current) setGenerating(false);
    }
  }, [
    ctaStyleOverride,
    durationSec,
    goToPricing,
    onDraftChange,
    preferredStructure,
    saveLatest,
    selectedHook,
    selectedProfileId,
    stylePreset,
    topic,
  ]);

  const handleRegen = useCallback(async (target: RegenTarget) => {
    if (sendingRef.current) return;
    const d = draftRef.current;
    if (!d) return;
    const requestId = ++workspaceRequestRef.current;
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
          stylePreset: d.brandProfileId ? null : stylePreset,
          ctaStyle: ctaStyleOverride,
          hookFormula: d.hookFormula,
          current: { hookText: d.hookText, bodyText: d.bodyText, ctaText: d.ctaText },
        }),
      });
      if (requestId !== workspaceRequestRef.current) return;
      if (!res.ok) {
        trackEvent("hero_script_regen_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { target, httpStatus: res.status },
        });
        await toastErrorResponse(res, "เขียนใหม่ไม่สำเร็จ", {
          isCurrent: () => requestId === workspaceRequestRef.current,
        });
        return;
      }
      const data = await res.json();
      if (requestId !== workspaceRequestRef.current) return;
      if (data.warning) toast.warning(data.warning);
      const text = typeof data.text === "string" ? data.text : "";
      if (!text) return;
      const current = draftRef.current;
      if (!current) return;
      if (target === "hook") {
        const formula = typeof data.formula === "string" ? data.formula : current.hookFormula;
        applyDraftPatch({ hookText: text, hookFormula: formula });
        onSelectedHookChange({
          formula: formula ?? "",
          text,
          contextKey: hookContextKey(d.topic, d.durationSec, d.brandProfileId, d.brandProfileId ? null : stylePreset),
        });
      } else if (target === "body") {
        applyDraftPatch({ bodyText: text });
      } else {
        applyDraftPatch({ ctaText: text });
      }
      trackEvent("hero_script_regenerated", {
        status: "done", durationMs: performance.now() - startedAt, properties: { target },
      });
    } catch {
      if (requestId !== workspaceRequestRef.current) return;
      trackEvent("hero_script_regen_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { target, failure: "network" },
      });
      toast.error("เขียนใหม่ไม่สำเร็จ");
    } finally {
      if (requestId === workspaceRequestRef.current) setRegenTarget(null);
    }
  }, [applyDraftPatch, ctaStyleOverride, onSelectedHookChange, stylePreset]);

  const runCompact = useCallback(async () => {
    if (sendingRef.current) return;
    const d = draftRef.current;
    if (!d || !d.hookText.trim()) return;
    const requestId = ++workspaceRequestRef.current;
    const startedAt = performance.now();
    trackEvent("hero_script_compact_requested", {
      status: "started",
      properties: { durationSec: d.durationSec },
    });
    setCompacting(true);
    try {
      const res = await authenticatedFetch("/api/scripts/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: d.topic,
          durationSec: d.durationSec,
          brandProfileId: d.brandProfileId,
          stylePreset: d.brandProfileId ? null : stylePreset,
          ctaStyle: ctaStyleOverride,
          current: { hookText: d.hookText, bodyText: d.bodyText, ctaText: d.ctaText },
        }),
      });
      if (requestId !== workspaceRequestRef.current) return;
      if (!res.ok) {
        trackEvent("hero_script_compact_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status, durationSec: d.durationSec },
        });
        await toastErrorResponse(res, "กระชับสคริปต์ไม่สำเร็จ", {
          isCurrent: () => requestId === workspaceRequestRef.current,
        });
        return;
      }
      const data = await res.json();
      if (requestId !== workspaceRequestRef.current) return;
      if (data.warning) toast.warning(data.warning);
      if (typeof data.bodyText === "string" && typeof data.ctaText === "string") {
        applyDraftPatch({ bodyText: data.bodyText, ctaText: data.ctaText });
        toast.success(`กระชับสคริปต์ให้พอดี ${d.durationSec} วิแล้ว`);
        trackEvent("hero_script_compact_completed", {
          status: "done", durationMs: performance.now() - startedAt,
          properties: { durationSec: d.durationSec },
        });
      }
    } catch {
      if (requestId !== workspaceRequestRef.current) return;
      trackEvent("hero_script_compact_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { failure: "network", durationSec: d.durationSec },
      });
      toast.error("กระชับสคริปต์ไม่สำเร็จ");
    } finally {
      if (requestId === workspaceRequestRef.current) setCompacting(false);
    }
  }, [applyDraftPatch, ctaStyleOverride, stylePreset]);

  const createEditorProject = useCallback(async (): Promise<boolean> => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    invalidateAsyncRequests();
    try {
      return await onCreateEditorProject();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [invalidateAsyncRequests, onCreateEditorProject]);

  useImperativeHandle(
    ref,
    () => ({
      saveLatest,
      createEditorProject,
      runQuickGenerate,
      runHookGenerate,
      runCompact,
      invalidateAsyncRequests,
    }),
    [createEditorProject, invalidateAsyncRequests, runCompact, runHookGenerate, runQuickGenerate, saveLatest],
  );

  function editSection(patch: Partial<ScriptDraft>) {
    if (handoffPosting) return;
    invalidateAsyncRequests();
    applyDraftPatch(patch);
  }

  function swapAlternativeHook(index: number) {
    if (handoffPosting || !draft) return;
    const picked = alternativeHooks[index];
    if (!picked) return;
    const previous: AlternativeHookItem | null = draft.hookText.trim()
      ? { formula: draft.hookFormula ?? "curiosity-gap", text: draft.hookText }
      : null;
    setAlternativeHooks((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      if (previous) next.unshift(previous);
      return next;
    });
    invalidateAsyncRequests();
    applyDraftPatch({ hookText: picked.text, hookFormula: picked.formula });
    onSelectedHookChange({
      formula: picked.formula,
      text: picked.text,
      contextKey: hookContextKey(draft.topic, draft.durationSec, draft.brandProfileId, draft.brandProfileId ? null : stylePreset),
    });
    trackEvent("hero_script_hook_swapped", {
      properties: { formula: picked.formula, position: index + 1 },
    });
  }

  const structureName = draft?.structure ? getStoryStructure(draft.structure)?.name ?? null : null;
  const bodySceneCount = draft
    ? draft.bodyText.split("\n").map((l) => l.trim()).filter(Boolean).length
    : 0;
  const anyBusy = sending || handoffPending || generating || compacting || regenTarget !== null;

  if (!draft && !generating && !generationError) {
    return null;
  }

  return (
    <section
      className="rounded-2xl p-4 sm:p-5"
      style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            className="text-sm font-semibold"
            style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
          >
            สคริปต์เต็ม
          </h2>
          {structureName && (
            <span
              className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
              style={{ background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-secondary)" }}
            >
              โครง: {structureName}
            </span>
          )}
        </div>

        {draft && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={anyBusy || !draft.hookText.trim()}
            onClick={() => { void runCompact(); }}
            className="min-h-9 gap-1.5 rounded-xl text-xs"
          >
            {compacting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
            {compacting ? "กำลังกระชับ…" : `กระชับให้พอดี ${draft.durationSec} วิ`}
          </Button>
        )}
      </div>

      {generationError && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm"
          style={{ borderColor: "rgba(239,68,68,.35)", background: "rgba(239,68,68,.08)", color: "var(--ui-text-primary)" }}
        >
          <span>{generationError} · หัวข้อยังอยู่ ลองกดสร้างอีกครั้งได้</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={anyBusy}
            onClick={() => {
              if (generatingMode === "hook" && selectedHook) void runHookGenerate();
              else void runQuickGenerate();
            }}
            className="min-h-9 rounded-lg text-xs"
          >
            <Sparkles className="mr-1 h-3.5 w-3.5" /> ลองอีกครั้ง
          </Button>
        </div>
      )}

      {generating && (
        <div
          role="status"
          className="mb-4 space-y-2.5 rounded-xl border p-4"
          style={{ borderColor: HS_COLOR.violetBorder, background: HS_COLOR.violetSoft }}
        >
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--ui-text-primary)" }}>
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: HS_COLOR.violet }} />
            {generatingMode === "quick"
              ? "AI กำลังเขียนสคริปต์เต็ม + 5 Hook ให้ในชุดเดียว กรุณารอสักครู่…"
              : "AI กำลังเขียนจาก Hook ที่เลือก กรุณารอสักครู่…"}
          </div>
          <div className="h-3 w-3/4 rounded skeleton-wave" />
          <div className="h-3 w-1/2 rounded skeleton-wave" />
        </div>
      )}

      {draft && (
        <div className="space-y-4">
          {/* ── HOOK Block ── */}
          <div
            className="rounded-xl border p-3.5"
            style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg-2)" }}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-md px-2 py-0.5 text-[10.5px] font-bold tracking-wide"
                  style={{ background: HS_COLOR.hookBg, color: HS_COLOR.hook }}
                >
                  HOOK
                </span>
                {draft.hookFormula && (
                  <span className="text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>
                    สูตร: {hookFormulaName(draft.hookFormula)}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1">
                {alternativeHooks.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHooksDrawerOpen((open) => !open)}
                    className="min-h-9 gap-1 rounded-lg px-2 text-xs font-medium"
                    style={{ color: HS_COLOR.hook }}
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    สลับ Hook ({alternativeHooks.length})
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => { void handleRegen("hook"); }}
                  disabled={anyBusy}
                  size="sm"
                  variant="ghost"
                  className="min-h-9 gap-1 rounded-lg px-2 text-xs font-medium"
                  style={{ color: HS_COLOR.violet }}
                >
                  {regenTarget === "hook" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  เขียนใหม่
                </Button>
              </div>
            </div>

            <Textarea
              aria-label="ข้อความ Hook"
              value={draft.hookText}
              onChange={(e) => editSection({ hookText: e.target.value })}
              disabled={handoffPosting}
              rows={2}
              className="rounded-lg text-base"
              style={{ fontSize: "1rem", background: "var(--ui-input-bg)" }}
            />

            {!draft.hookText.trim() && (
              <p className="mt-1.5 text-xs" style={{ color: HS_COLOR.warn }}>
                กรุณาใส่ข้อความ Hook เพื่อให้ระบบบันทึกอัตโนมัติและส่งเข้าตัดต่อได้
              </p>
            )}

            {/* 4 Alternative Hooks quick-swap tray */}
            {hooksDrawerOpen && alternativeHooks.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t pt-3" style={{ borderColor: "var(--ui-divider)" }}>
                <p className="text-[11px] font-medium" style={{ color: "var(--ui-text-muted)" }}>
                  คลิก Hook สำรองเพื่อสลับใช้งานทันที (Hook เดิมจะถูกเก็บไว้ให้สลับกลับได้):
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {alternativeHooks.map((alt, idx) => (
                    <button
                      key={`${alt.formula}-${idx}`}
                      type="button"
                      onClick={() => swapAlternativeHook(idx)}
                      className="rounded-lg border p-2.5 text-left text-xs transition-colors hover:border-violet-400"
                      style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg)" }}
                    >
                      <span className="mb-1 block font-semibold" style={{ color: HS_COLOR.hook }}>
                        {hookFormulaName(alt.formula)}
                      </span>
                      <span className="block leading-snug" style={{ color: "var(--ui-text-primary)" }}>
                        {alt.text}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── BODY Block ── */}
          <div
            className="rounded-xl border p-3.5"
            style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg-2)" }}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-md px-2 py-0.5 text-[10.5px] font-bold tracking-wide"
                  style={{ background: HS_COLOR.bodyBg, color: HS_COLOR.body }}
                >
                  เนื้อหา
                </span>
                <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  {bodySceneCount} บรรทัด (1 บรรทัด = 1 ซีน B-roll)
                </span>
              </div>
              <Button
                type="button"
                onClick={() => { void handleRegen("body"); }}
                disabled={anyBusy}
                size="sm"
                variant="ghost"
                className="min-h-9 gap-1 rounded-lg px-2 text-xs font-medium"
                style={{ color: HS_COLOR.violet }}
              >
                {regenTarget === "body" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                เขียนใหม่
              </Button>
            </div>
            <Textarea
              aria-label="เนื้อหาสคริปต์"
              value={draft.bodyText}
              onChange={(e) => editSection({ bodyText: e.target.value })}
              disabled={handoffPosting}
              rows={9}
              className="rounded-lg text-base leading-relaxed"
              style={{ fontSize: "1rem", background: "var(--ui-input-bg)" }}
            />
          </div>

          {/* ── CTA Block ── */}
          <div
            className="rounded-xl border p-3.5"
            style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg-2)" }}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className="rounded-md px-2 py-0.5 text-[10.5px] font-bold tracking-wide"
                  style={{ background: HS_COLOR.ctaBg, color: HS_COLOR.cta }}
                >
                  CTA
                </span>
                <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  ประโยคปิดท้าย
                </span>
              </div>
              <Button
                type="button"
                onClick={() => { void handleRegen("cta"); }}
                disabled={anyBusy}
                size="sm"
                variant="ghost"
                className="min-h-9 gap-1 rounded-lg px-2 text-xs font-medium"
                style={{ color: HS_COLOR.violet }}
              >
                {regenTarget === "cta" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                เขียนใหม่
              </Button>
            </div>
            <Textarea
              aria-label="ข้อความ CTA"
              value={draft.ctaText}
              onChange={(e) => editSection({ ctaText: e.target.value })}
              disabled={handoffPosting}
              rows={2}
              className="rounded-lg text-base"
              style={{ fontSize: "1rem", background: "var(--ui-input-bg)" }}
            />
          </div>

          {/* ── Gentle 0-Brand Post-Generation Nudge ── */}
          {!draft.brandProfileId && profilesCount === 0 && !brandNudgeDismissed && onOpenCreateBrand && (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-xs"
              style={{ borderColor: HS_COLOR.violetBorder, background: HS_COLOR.violetSoft }}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <SwatchBook className="h-4 w-4 shrink-0" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
                <span style={{ color: "var(--ui-text-primary)" }}>
                  อยากให้สคริปต์ครั้งหน้าจำโทนเสียงและกลุ่มเป้าหมายช่องคุณอัตโนมัติ?
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onOpenCreateBrand}
                  className="min-h-9 rounded-lg text-xs font-semibold"
                >
                  บันทึกเป็นโปรไฟล์แบรนด์
                </Button>
                <button
                  type="button"
                  onClick={() => setBrandNudgeDismissed(true)}
                  aria-label="ปิดคำแนะนำสร้างโปรไฟล์แบรนด์"
                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                  style={{ color: "var(--ui-text-muted)" }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
