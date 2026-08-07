"use client";

// HookStep — Hero Script UI spec step 3 ("เลือก Hook"): 5 hook cards, each
// labeled with ชื่อสูตรไทย (from HOOK_FORMULAS — the single source of truth
// shared with the HOOKS prompt builder); inline-editable after pick; ปุ่ม
// "ขออีกชุด" (re)generates 5 more. Calls POST /api/scripts/hooks.
//
// Produces a HookChoice ({formula, text}) — the interface Task 3's GENERATE
// step consumes (lifted into page.tsx as `selectedHook`).

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HOOK_FORMULAS } from "@/lib/viral-frameworks";
import { trackEvent } from "@/lib/client-telemetry";

const VIOLET = "#8B5CF6";

// 429 quota copy — exact Thai string from the shared spec's "Quota/error states" table.
const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";

export interface HookChoice {
  formula: string;
  text: string;
  /** Inputs that produced this hook; prevents generating with stale upstream state. */
  contextKey: string;
}

export function hookContextKey(topic: string, durationSec: number, profileId: string | null): string {
  return JSON.stringify([topic.trim(), durationSec, profileId]);
}

function hookFormulaName(key: string): string {
  return HOOK_FORMULAS.find((f) => f.key === key)?.name ?? key;
}

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

interface HookStepProps {
  topic: string;
  durationSec: number;
  selectedProfileId: string | null;
  selectedHook: HookChoice | null;
  onSelectedHookChange: (hook: HookChoice | null) => void;
}

export function HookStep({
  topic, durationSec, selectedProfileId, selectedHook, onSelectedHookChange,
}: HookStepProps) {
  const [loading, setLoading] = useState(false);
  const [hooks, setHooks] = useState<HookChoice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const currentContext = hookContextKey(topic, durationSec, selectedProfileId);
  const previousContextRef = useRef(currentContext);
  const currentContextRef = useRef(currentContext);

  useEffect(() => {
    currentContextRef.current = currentContext;
    if (previousContextRef.current === currentContext) return;
    previousContextRef.current = currentContext;
    setSelectedIndex(null);
    if (selectedHook && selectedHook.contextKey !== currentContext) onSelectedHookChange(null);
  }, [currentContext, selectedHook, onSelectedHookChange]);

  async function handleFetchHooks() {
    if (!topic.trim()) return;
    const requestContext = hookContextKey(topic, durationSec, selectedProfileId);
    const startedAt = performance.now();
    trackEvent("hero_script_hooks_requested", {
      status: "started",
      properties: { durationSec, profileUsed: Boolean(selectedProfileId) },
    });
    setLoading(true);
    try {
      const res = await fetch("/api/scripts/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), brandProfileId: selectedProfileId, durationSec }),
      });
      if (!res.ok) {
        trackEvent("hero_script_hooks_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status, durationSec, profileUsed: Boolean(selectedProfileId) },
        });
        await toastErrorResponse(res, "สร้าง hook ไม่สำเร็จ");
        return;
      }
      const data = await res.json();
      if (currentContextRef.current !== requestContext) {
        trackEvent("hero_script_hooks_discarded", {
          status: "skip", durationMs: performance.now() - startedAt,
          properties: { reason: "inputs_changed" },
        });
        return;
      }
      const nextHooks = Array.isArray(data.hooks)
        ? data.hooks.map((hook: Omit<HookChoice, "contextKey">) => ({ ...hook, contextKey: requestContext }))
        : [];
      setHooks(nextHooks);
      setSelectedIndex(null);
      onSelectedHookChange(null);
      trackEvent("hero_script_hooks_generated", {
        status: "done", durationMs: performance.now() - startedAt, value: nextHooks.length,
        properties: { durationSec, profileUsed: Boolean(selectedProfileId) },
      });
    } catch {
      trackEvent("hero_script_hooks_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { failure: "network", durationSec, profileUsed: Boolean(selectedProfileId) },
      });
      toast.error("สร้าง hook ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  function selectHook(index: number, hook: HookChoice) {
    setSelectedIndex(index);
    onSelectedHookChange({ ...hook });
    trackEvent("hero_script_hook_selected", {
      properties: { formula: hook.formula, position: index + 1 },
    });
  }

  // Write the edit back into the `hooks` state array (keyed by index, formula
  // key untouched) — not just the ephemeral lifted `selectedHook` — so
  // picking card B then reselecting card A restores the edited text instead
  // of silently reverting to the original LLM output.
  function editSelectedText(text: string) {
    if (selectedIndex === null || !selectedHook) return;
    const updated = { ...selectedHook, text };
    onSelectedHookChange(updated);
    setHooks((prev) => prev.map((h, i) => (i === selectedIndex ? updated : h)));
  }

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>เลือก Hook</h2>
        <Button
          onClick={handleFetchHooks}
          disabled={loading || !topic.trim()}
          size="sm"
          variant="outline"
          className="min-h-11 gap-1.5"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {hooks.length > 0 ? "ขออีกชุด" : "สร้าง Hook"}
        </Button>
      </div>

      {hooks.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {hooks.map((hook, i) => {
            const isSelected = selectedIndex === i;
            return (
              <div
                key={i}
                className="rounded-lg border p-3 text-xs transition-colors"
                style={{
                  borderColor: isSelected ? VIOLET : "var(--ui-card-border)",
                  background: isSelected ? "rgba(139,92,246,.08)" : "transparent",
                }}
              >
                <p className="mb-1.5 font-semibold" style={{ color: VIOLET }}>{hookFormulaName(hook.formula)}</p>
                {isSelected && selectedHook ? (
                  <Textarea
                    value={selectedHook.text}
                    onChange={(e) => editSelectedText(e.target.value)}
                    rows={2}
                    className="text-xs"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => selectHook(i, hook)}
                    className="w-full text-left"
                    style={{ color: "var(--ui-text-secondary)" }}
                  >
                    {hook.text}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
