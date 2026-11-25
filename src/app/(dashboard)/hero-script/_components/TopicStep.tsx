"use client";

// TopicStep v2 — Dual-mode Smart Composer:
//   - Topic input with immediate 1-click "สร้างสคริปต์เลย (1 คลิก)" primary CTA
//   - Secondary "เลือก 5 Hook ก่อน" (step-by-step control) & "คิดไอเดียให้"
//   - 3 clickable starter topic chips when blank so first-timers & 0-brand users
//     never stall on an empty text box.

import { useState } from "react";
import { toast } from "sonner";
import { Lightbulb, ListChecks, Loader2, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackEvent } from "@/lib/client-telemetry";
import {
  HERO_SCRIPT_STARTER_TOPICS,
  type HeroScriptStarterTopic,
} from "@/lib/hero-script-presets";
import { HS_COLOR, HS_FONT } from "./hero-script-tokens";

const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";

export interface ScriptIdea {
  topic: string;
  angle: string;
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

interface TopicStepProps {
  selectedProfileId: string | null;
  stylePreset: string | null;
  topic: string;
  hasDraft: boolean;
  quickGenerating: boolean;
  hookPickerLoading: boolean;
  actionsDisabled: boolean;
  onTopicChange: (topic: string) => void;
  onStarterTopicPick: (starter: HeroScriptStarterTopic) => void;
  onQuickGenerate: () => void;
  onRequestHooks: () => void;
}

export function TopicStep({
  selectedProfileId,
  stylePreset,
  topic,
  hasDraft,
  quickGenerating,
  hookPickerLoading,
  actionsDisabled,
  onTopicChange,
  onStarterTopicPick,
  onQuickGenerate,
  onRequestHooks,
}: TopicStepProps) {
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [ideas, setIdeas] = useState<ScriptIdea[]>([]);

  async function handleGenerateIdeas() {
    const startedAt = performance.now();
    trackEvent("hero_script_ideas_requested", {
      status: "started",
      properties: { profileUsed: Boolean(selectedProfileId), presetUsed: Boolean(!selectedProfileId && stylePreset) },
    });
    setLoadingIdeas(true);
    try {
      const res = await fetch("/api/scripts/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandProfileId: selectedProfileId,
          stylePreset: selectedProfileId ? null : stylePreset,
        }),
      });
      if (!res.ok) {
        trackEvent("hero_script_ideas_failed", {
          category: "error", status: "error", durationMs: performance.now() - startedAt,
          properties: { httpStatus: res.status, profileUsed: Boolean(selectedProfileId) },
        });
        await toastErrorResponse(res, "คิดไอเดียไม่สำเร็จ");
        return;
      }
      const data = await res.json();
      const nextIdeas = Array.isArray(data.ideas) ? data.ideas : [];
      setIdeas(nextIdeas);
      trackEvent("hero_script_ideas_generated", {
        status: "done", durationMs: performance.now() - startedAt, value: nextIdeas.length,
        properties: { profileUsed: Boolean(selectedProfileId), presetUsed: Boolean(!selectedProfileId && stylePreset) },
      });
    } catch {
      trackEvent("hero_script_ideas_failed", {
        category: "error", status: "error", durationMs: performance.now() - startedAt,
        properties: { failure: "network", profileUsed: Boolean(selectedProfileId) },
      });
      toast.error("คิดไอเดียไม่สำเร็จ");
    } finally {
      setLoadingIdeas(false);
    }
  }

  const hasTopic = topic.trim().length > 0;

  return (
    <section
      className="rounded-2xl p-4 sm:p-5"
      style={{
        background: "var(--ui-card-bg)",
        border: `1px solid ${hasTopic ? HS_COLOR.violetBorder : "var(--ui-card-border)"}`,
      }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            className="text-sm font-semibold"
            style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
          >
            หัวข้อคลิป
          </h2>
          <p className="text-xs" style={{ color: "var(--ui-text-muted)" }}>
            พิมพ์หัวข้อแล้วกดสร้างได้ทันที หรือให้ AI ช่วยคิดไอเดียก่อน
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleGenerateIdeas}
          disabled={loadingIdeas}
          className="min-h-10 gap-1.5 rounded-xl text-xs"
        >
          {loadingIdeas ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" style={{ color: HS_COLOR.violet }} />}
          คิดไอเดียให้หน่อย
        </Button>
      </div>

      <div className="space-y-3">
        <div>
          <Label htmlFor="hero-script-topic-input" className="sr-only">หัวข้อคลิป</Label>
          <Input
            id="hero-script-topic-input"
            aria-label="หัวข้อสคริปต์"
            className="min-h-12 rounded-xl text-base"
            style={{ fontSize: "1rem" }}
            placeholder="เช่น ทำไมเงินเดือนขึ้นทุกปี แต่เงินเก็บไม่เคยเหลือถึงสิ้นเดือน"
            value={topic}
            onChange={(e) => onTopicChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && hasTopic && !actionsDisabled) {
                e.preventDefault();
                onQuickGenerate();
              }
            }}
          />
        </div>

        {/* Dual-mode primary CTA row */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button
            type="button"
            onClick={onQuickGenerate}
            disabled={!hasTopic || actionsDisabled || quickGenerating}
            className="min-h-11 gap-2 rounded-xl px-4 text-sm font-semibold text-white transition hover:brightness-110"
            style={{
              background: HS_COLOR.violetGradient,
              boxShadow: hasTopic && !actionsDisabled ? HS_COLOR.violetShadow : undefined,
              fontFamily: HS_FONT.heading,
            }}
          >
            {quickGenerating
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Zap className="h-4 w-4" />}
            {quickGenerating ? "กำลังสร้างสคริปต์ + 5 Hook…" : "สร้างสคริปต์เลย (1 คลิก)"}
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={onRequestHooks}
            disabled={!hasTopic || actionsDisabled || hookPickerLoading}
            className="min-h-11 gap-1.5 rounded-xl text-xs font-semibold sm:text-sm"
          >
            {hookPickerLoading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <ListChecks className="h-4 w-4" style={{ color: HS_COLOR.hook }} />}
            เลือก 5 Hook ก่อน
          </Button>
        </div>

        {/* Starter topic chips for blank first-visit momentum */}
        {!hasTopic && ideas.length === 0 && !hasDraft && (
          <div className="pt-1">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "var(--ui-text-muted)" }}>
              <Lightbulb className="h-3.5 w-3.5" style={{ color: HS_COLOR.warn }} aria-hidden="true" />
              ลองเริ่มจากหัวข้อตัวอย่างใน 1 คลิก:
            </p>
            <div className="flex flex-wrap gap-2">
              {HERO_SCRIPT_STARTER_TOPICS.map((starter) => (
                <button
                  key={starter.topic}
                  type="button"
                  onClick={() => {
                    trackEvent("hero_script_starter_topic_clicked", {
                      properties: { presetKey: starter.presetKey, durationSec: starter.durationSec },
                    });
                    onStarterTopicPick(starter);
                  }}
                  className="min-h-9 rounded-xl border px-3 py-1.5 text-left text-xs transition-colors hover:border-violet-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                  style={{
                    borderColor: "var(--ui-card-border)",
                    background: "var(--ui-card-bg-2)",
                    color: "var(--ui-text-secondary)",
                  }}
                >
                  {starter.topic}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Generated 8 Idea Cards */}
      {ideas.length > 0 && (
        <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--ui-divider)" }}>
          <p className="mb-2.5 text-xs font-medium" style={{ color: "var(--ui-text-secondary)" }}>
            เลือก 1 ไอเดียด้านล่าง แล้วกด “สร้างสคริปต์เลย (1 คลิก)” หรือ “เลือก 5 Hook ก่อน”
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {ideas.map((idea, i) => {
              const selected = topic === idea.topic;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    trackEvent("hero_script_idea_selected", { properties: { position: i + 1 } });
                    onTopicChange(idea.topic);
                  }}
                  className="rounded-xl border p-3 text-left text-xs transition-all hover:border-violet-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                  style={{
                    borderColor: selected ? HS_COLOR.violet : "var(--ui-card-border)",
                    background: selected ? HS_COLOR.violetSoft : "var(--ui-card-bg-2)",
                  }}
                >
                  <p className="mb-1 font-semibold leading-snug" style={{ color: "var(--ui-text-primary)" }}>{idea.topic}</p>
                  <p className="leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>{idea.angle}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
