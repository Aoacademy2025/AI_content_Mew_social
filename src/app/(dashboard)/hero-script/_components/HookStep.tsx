"use client";

// HookStep v2 — step-by-step Hook picker (triggered explicitly via "เลือก 5 Hook
// ก่อน" so the composer never shows an empty dead card before the user asks).
// Keeps inline editing of the chosen hook + "ขออีกชุด" + direct generate CTA.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HOOK_FORMULAS } from "@/lib/viral-frameworks";
import { trackEvent } from "@/lib/client-telemetry";
import { HS_COLOR, HS_FONT } from "./hero-script-tokens";

const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";

export interface HookChoice {
  formula: string;
  text: string;
  /** Inputs that produced this hook; prevents generating with stale upstream state. */
  contextKey: string;
}

export function hookContextKey(
  topic: string,
  durationSec: number,
  profileId: string | null,
  stylePreset: string | null = null,
): string {
  const effectivePreset = profileId ? null : stylePreset;
  return JSON.stringify([topic.trim(), durationSec, profileId, effectivePreset]);
}

export function hookFormulaName(key: string): string {
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

export interface HookStepHandle {
  fetchHooks: () => Promise<void>;
}

interface HookStepProps {
  topic: string;
  durationSec: number;
  selectedProfileId: string | null;
  stylePreset: string | null;
  selectedHook: HookChoice | null;
  onSelectedHookChange: (hook: HookChoice | null) => void;
  onLoadingChange?: (loading: boolean) => void;
  onGenerateWithHook?: () => void;
  generateDisabled?: boolean;
  generating?: boolean;
}

export const HookStep = forwardRef<HookStepHandle, HookStepProps>(function HookStep({
  topic,
  durationSec,
  selectedProfileId,
  stylePreset,
  selectedHook,
  onSelectedHookChange,
  onLoadingChange,
  onGenerateWithHook,
  generateDisabled = false,
  generating = false,
}, ref) {
  const [loading, setLoading] = useState(false);
  const [hooks, setHooks] = useState<HookChoice[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const currentContext = hookContextKey(topic, durationSec, selectedProfileId, stylePreset);
  const previousContextRef = useRef(currentContext);
  const currentContextRef = useRef(currentContext);
  const onSelectedHookChangeRef = useRef(onSelectedHookChange);
  const onLoadingChangeRef = useRef(onLoadingChange);

  useEffect(() => { onSelectedHookChangeRef.current = onSelectedHookChange; }, [onSelectedHookChange]);
  useEffect(() => { onLoadingChangeRef.current = onLoadingChange; }, [onLoadingChange]);

  useEffect(() => {
    currentContextRef.current = currentContext;
    if (previousContextRef.current === currentContext) return;
    previousContextRef.current = currentContext;
    setSelectedIndex(null);
    setHooks([]);
    if (selectedHook && selectedHook.contextKey !== currentContext) {
      onSelectedHookChangeRef.current(null);
    }
  }, [currentContext, selectedHook]);

  const handleFetchHooks = useCallback(async () => {
    if (!topic.trim()) return;
    const requestContext = hookContextKey(topic, durationSec, selectedProfileId, stylePreset);
    const startedAt = performance.now();
    trackEvent("hero_script_hooks_requested", {
      status: "started",
      properties: { durationSec, profileUsed: Boolean(selectedProfileId), presetUsed: Boolean(!selectedProfileId && stylePreset) },
    });
    setLoading(true);
    onLoadingChangeRef.current?.(true);
    try {
      const res = await fetch("/api/scripts/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          brandProfileId: selectedProfileId,
          stylePreset: selectedProfileId ? null : stylePreset,
          durationSec,
        }),
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
      const nextHooks: HookChoice[] = Array.isArray(data.hooks)
        ? data.hooks.map((hook: Omit<HookChoice, "contextKey">) => ({ ...hook, contextKey: requestContext }))
        : [];
      setHooks(nextHooks);
      setSelectedIndex(null);
      onSelectedHookChangeRef.current(null);
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
      onLoadingChangeRef.current?.(false);
    }
  }, [durationSec, selectedProfileId, stylePreset, topic]);

  useImperativeHandle(ref, () => ({ fetchHooks: handleFetchHooks }), [handleFetchHooks]);

  function selectHook(index: number, hook: HookChoice) {
    setSelectedIndex(index);
    onSelectedHookChange({ ...hook });
    trackEvent("hero_script_hook_selected", {
      properties: { formula: hook.formula, position: index + 1 },
    });
  }

  function editSelectedText(text: string) {
    if (selectedIndex === null || !selectedHook) return;
    const updated = { ...selectedHook, text };
    onSelectedHookChange(updated);
    setHooks((prev) => prev.map((h, i) => (i === selectedIndex ? updated : h)));
  }

  return (
    <section
      className="rounded-2xl p-4 sm:p-5"
      style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
    >
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide"
            style={{ background: HS_COLOR.hookBg, color: HS_COLOR.hook }}
          >
            HOOK
          </span>
          <h2
            className="text-sm font-semibold"
            style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
          >
            เลือก Hook
          </h2>
        </div>
        <Button
          type="button"
          onClick={() => { void handleFetchHooks(); }}
          disabled={loading || !topic.trim()}
          size="sm"
          variant="outline"
          className="min-h-10 gap-1.5 rounded-xl text-xs"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {hooks.length > 0 ? "ขออีกชุด" : "สร้าง Hook"}
        </Button>
      </div>

      {loading && hooks.length === 0 ? (
        <div className="grid gap-2.5 sm:grid-cols-2" role="status" aria-label="กำลังสร้าง 5 Hook">
          {Array.from({ length: 4 }, (_, idx) => (
            <div
              key={idx}
              className="h-20 rounded-xl border p-3 skeleton-wave"
              style={{ borderColor: "var(--ui-card-border)" }}
            />
          ))}
        </div>
      ) : hooks.length > 0 ? (
        <>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {hooks.map((hook, i) => {
              const isSelected = selectedIndex === i;
              const cardStyle = {
                borderColor: isSelected ? HS_COLOR.violet : "var(--ui-card-border)",
                background: isSelected ? HS_COLOR.violetSoft : "var(--ui-card-bg-2)",
              };
              return isSelected && selectedHook ? (
                <div
                  key={i}
                  className="rounded-xl border p-3 text-xs transition-colors"
                  style={cardStyle}
                >
                  <p className="mb-1.5 font-semibold" style={{ color: HS_COLOR.hook }}>{hookFormulaName(hook.formula)}</p>
                  <Textarea
                    value={selectedHook.text}
                    onChange={(e) => editSelectedText(e.target.value)}
                    rows={2}
                    className="text-sm"
                  />
                </div>
              ) : (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectHook(i, hook)}
                  className="rounded-xl border p-3 text-left text-xs transition-all hover:border-violet-400 focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ ...cardStyle, outlineColor: HS_COLOR.violet }}
                >
                  <span className="mb-1.5 block font-semibold" style={{ color: HS_COLOR.hook }}>{hookFormulaName(hook.formula)}</span>
                  <span className="block leading-relaxed" style={{ color: "var(--ui-text-primary)" }}>{hook.text}</span>
                </button>
              );
            })}
          </div>

          {selectedHook && selectedHook.contextKey === currentContext && onGenerateWithHook && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3.5" style={{ borderColor: "var(--ui-divider)" }}>
              <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
                แก้คำใน Hook ได้โดยตรง แล้วกดสร้างสคริปต์เต็มจาก Hook นี้
              </span>
              <Button
                type="button"
                onClick={onGenerateWithHook}
                disabled={generateDisabled || generating}
                size="sm"
                className="min-h-11 gap-1.5 rounded-xl px-4 text-white"
                style={{ background: HS_COLOR.violetGradient }}
              >
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {generating ? "กำลังสร้างสคริปต์…" : "สร้างสคริปต์เต็ม"}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
          กด “สร้าง Hook” เพื่อดูประโยคเปิด 5 สูตรไวรัลสำหรับหัวข้อนี้
        </p>
      )}
    </section>
  );
});
