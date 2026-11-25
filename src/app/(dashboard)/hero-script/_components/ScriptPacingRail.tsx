"use client";

// ScriptPacingRail — Editor v2-inspired persistent right rail (stacks cleanly
// below the editor on mobile). Shows live spoken-duration estimate via
// estimateClipSecV2 (identical to Video Editor Step 1), word-budget progress
// meter + 1-click compact button when over budget, scene/segment breakdown
// preview, save status, copy button, and the primary Send-to-Editor CTA.

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Film,
  Loader2,
  Lock,
  Scissors,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { tokenizeWords } from "@/lib/tts-timing";
import { TTS_WORDS_PER_SECOND } from "@/lib/prompts/content-generator";
import { estimateClipSecV2 } from "@/app/(dashboard)/video-editor/_v2/estimate";
import { trackEvent } from "@/lib/client-telemetry";
import { HS_COLOR, HS_FONT } from "./hero-script-tokens";
import type { ScriptDraft, ScriptSaveState } from "./ScriptEditorStep";

const BUDGET_TOLERANCE = 0.15;
const EDITOR_LOCKED_MESSAGE = "อัปเกรดเป็น PRO เพื่อส่งเข้าตัดต่อ";

function fmtTime(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface ScriptPacingRailProps {
  draft: ScriptDraft | null;
  durationSec: number;
  saveState: ScriptSaveState;
  canSendToEditor: boolean;
  generating: boolean;
  compacting: boolean;
  sending: boolean;
  handoffPending: boolean;
  onCompact: () => void;
  onOpenEditorProject: (projectId: string) => void;
  onCreateEditorProject: () => void;
}

export function ScriptPacingRail({
  draft,
  durationSec,
  saveState,
  canSendToEditor,
  generating,
  compacting,
  sending,
  handoffPending,
  onCompact,
  onOpenEditorProject,
  onCreateEditorProject,
}: ScriptPacingRailProps) {
  const [copied, setCopied] = useState(false);

  const assembledText = useMemo(() => {
    if (!draft) return "";
    return `${draft.hookText}\n${draft.bodyText}\n${draft.ctaText}`;
  }, [draft]);

  const lines = useMemo(
    () => assembledText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
    [assembledText],
  );

  const targetSec = draft?.durationSec ?? durationSec;
  const wordBudget = Math.round(targetSec * TTS_WORDS_PER_SECOND);
  const wordCount = useMemo(() => (draft ? tokenizeWords(assembledText).length : 0), [assembledText, draft]);
  const estimatedSec = useMemo(() => (draft ? estimateClipSecV2(assembledText) : 0), [assembledText, draft]);

  const minBudget = Math.round(wordBudget * (1 - BUDGET_TOLERANCE));
  const maxBudget = Math.round(wordBudget * (1 + BUDGET_TOLERANCE));
  const isOverBudget = draft !== null && wordCount > maxBudget;
  const isWayOverBudget = draft !== null && wordCount > Math.round(wordBudget * 1.25);
  const isWithinBudget = draft !== null && wordCount >= minBudget && wordCount <= maxBudget;
  const fillPct = wordBudget > 0 ? Math.min(100, Math.round((wordCount / maxBudget) * 100)) : 0;

  const meterColor = isWayOverBudget
    ? HS_COLOR.danger
    : isOverBudget
      ? HS_COLOR.warn
      : isWithinBudget
        ? HS_COLOR.ok
        : HS_COLOR.violet;

  // Approximate per-scene timestamps (same proportion model as Step1Script.tsx)
  const segments = useMemo(() => {
    if (lines.length === 0) return [];
    const weights = lines.map((line) => Math.max(1, estimateClipSecV2(line)));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return lines.map((text, index) => {
      const start = acc;
      acc += (weights[index] / sum) * estimatedSec;
      const role = index === 0
        ? "hook"
        : lines.length > 2 && index === lines.length - 1
          ? "cta"
          : "body";
      return { index, text, start, role };
    });
  }, [estimatedSec, lines]);

  async function handleCopy() {
    if (!draft || lines.length === 0) return;
    const textToCopy = lines.join("\n");
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      trackEvent("hero_script_copied", { properties: { durationSec: targetSec, segmentCount: lines.length } });
      toast.success("คัดลอกสคริปต์ทั้งหมดแล้ว");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("คัดลอกไม่สำเร็จ");
    }
  }

  return (
    <aside
      aria-label="สรุปจังหวะและส่งเข้าตัดต่อ"
      className="flex flex-col gap-4 rounded-2xl p-4 sm:p-5 lg:sticky lg:top-6"
      style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}
    >
      {/* ── Pacing & Word Budget Header ── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span
            className="flex items-center gap-1.5 text-xs font-semibold"
            style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
          >
            <Clock className="h-3.5 w-3.5" style={{ color: HS_COLOR.violet }} aria-hidden="true" />
            จังหวะและเวลาพูดโดยประมาณ
          </span>
          <span
            className="text-xs font-bold tabular-nums"
            style={{ color: draft ? meterColor : "var(--ui-text-muted)", fontFamily: HS_FONT.heading }}
          >
            {draft ? `~${fmtTime(estimatedSec)} / ${fmtTime(targetSec)}` : `เป้า ${fmtTime(targetSec)}`}
          </span>
        </div>

        <div
          className="h-2 w-full overflow-hidden rounded-full"
          style={{ background: "var(--ui-btn-bg)" }}
          role="progressbar"
          aria-label="ความยาวเทียบงบคำ"
          aria-valuenow={draft ? wordCount : 0}
          aria-valuemin={0}
          aria-valuemax={maxBudget}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${draft ? fillPct : 0}%`, background: meterColor }}
          />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
          <span>
            {draft
              ? `${wordCount} คำ / งบ ~${wordBudget} คำ (±15%)`
              : `งบคำแนะนำ ~${wordBudget} คำ สำหรับคลิป ${targetSec} วิ`}
          </span>
          {draft && (
            <span>{lines.length} ซีน</span>
          )}
        </div>

        {isOverBudget && (
          <div
            className="mt-3 rounded-xl border p-2.5 text-xs"
            style={{
              borderColor: isWayOverBudget ? "rgba(239,68,68,.35)" : "rgba(245,158,11,.35)",
              background: isWayOverBudget ? "rgba(239,68,68,.08)" : "rgba(245,158,11,.08)",
            }}
          >
            <p className="mb-2 flex items-start gap-1.5 leading-snug" style={{ color: "var(--ui-text-primary)" }}>
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                style={{ color: isWayOverBudget ? HS_COLOR.danger : HS_COLOR.warn }}
                aria-hidden="true"
              />
              <span>สคริปต์ยาวเกินงบ {targetSec} วิ — กดกระชับให้พูดจบพอดีเวลาได้ทันที</span>
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={compacting || generating || sending || handoffPending || !draft.hookText.trim()}
              onClick={onCompact}
              className="min-h-9 w-full gap-1.5 rounded-lg text-xs font-semibold"
            >
              {compacting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
              {compacting ? "กำลังกระชับสคริปต์…" : `กระชับให้พอดี ${targetSec} วิ`}
            </Button>
          </div>
        )}
      </div>

      {/* ── Live Scene Breakdown Preview (mirrors Video Editor Step 1) ── */}
      <div className="border-t pt-3.5" style={{ borderColor: "var(--ui-divider)" }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span
            className="flex items-center gap-1.5 text-xs font-semibold"
            style={{ fontFamily: HS_FONT.heading, color: "var(--ui-text-primary)" }}
          >
            <Film className="h-3.5 w-3.5" style={{ color: HS_COLOR.body }} aria-hidden="true" />
            ตัวอย่างการแบ่งซีนใน Editor
          </span>
          {segments.length > 0 && (
            <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
              1 บรรทัด = 1 ซีน
            </span>
          )}
        </div>

        {segments.length > 0 ? (
          <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
            {segments.map((seg) => {
              const badgeColor = seg.role === "hook"
                ? HS_COLOR.hook
                : seg.role === "cta"
                  ? HS_COLOR.cta
                  : HS_COLOR.body;
              const badgeBg = seg.role === "hook"
                ? HS_COLOR.hookBg
                : seg.role === "cta"
                  ? HS_COLOR.ctaBg
                  : HS_COLOR.bodyBg;
              const label = seg.role === "hook" ? "HOOK" : seg.role === "cta" ? "CTA" : `ซีน ${seg.index + 1}`;
              return (
                <div
                  key={`${seg.index}-${seg.text.slice(0, 12)}`}
                  className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs"
                  style={{ borderColor: "var(--ui-card-border)", background: "var(--ui-card-bg-2)" }}
                >
                  <span className="mt-0.5 shrink-0 font-mono text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
                    {fmtTime(seg.start)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span
                      className="mr-1.5 inline-block rounded px-1.5 py-0.5 text-[9.5px] font-bold"
                      style={{ background: badgeBg, color: badgeColor }}
                    >
                      {label}
                    </span>
                    <span className="line-clamp-2 break-words leading-snug" style={{ color: "var(--ui-text-primary)" }}>
                      {seg.text}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="rounded-xl border border-dashed p-4 text-center text-xs"
            style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-muted)" }}
          >
            <p className="font-medium" style={{ color: "var(--ui-text-secondary)" }}>
              พรีวิวการแบ่งซีนจะขึ้นที่นี่
            </p>
            <p className="mt-1 leading-relaxed">
              พิมพ์หัวข้อด้านซ้ายแล้วกด “สร้างสคริปต์เลย (1 คลิก)” ระบบจะจัด Hook · เนื้อหา · CTA และแบ่งซีนให้พร้อมตัดต่อทันที
            </p>
          </div>
        )}
      </div>

      {/* ── Save Status + Copy + Primary Send-to-Editor CTA ── */}
      {draft && (
        <div className="space-y-2.5 border-t pt-3.5" style={{ borderColor: "var(--ui-divider)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="flex items-center gap-1.5" style={{ color: saveState === "needs-hook" ? HS_COLOR.warn : "var(--ui-text-muted)" }}>
              {saveState === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> กำลังบันทึก…</>}
              {saveState === "saved" && <><Check className="h-3 w-3" style={{ color: HS_COLOR.ok }} /> บันทึกแล้ว</>}
              {saveState === "needs-hook" && <>กรุณาใส่ Hook ก่อนจึงจะบันทึกอัตโนมัติ</>}
              {saveState === "failed" && <>บันทึกไม่สำเร็จ ลองอีกครั้ง</>}
            </span>

            <button
              type="button"
              onClick={() => { void handleCopy(); }}
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: "var(--ui-text-secondary)" }}
            >
              {copied ? <Check className="h-3.5 w-3.5" style={{ color: HS_COLOR.ok }} /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "คัดลอกแล้ว" : "คัดลอกสคริปต์"}
            </button>
          </div>

          {canSendToEditor ? (
            <div className="flex flex-col gap-2">
              {draft.status === "sent" && (
                <p className="text-[11px] leading-snug" style={{ color: "var(--ui-text-muted)" }}>
                  การแก้สคริปต์นี้ยังไม่เปลี่ยนงานตัดต่อเดิม
                </p>
              )}
              {draft.status === "sent" && draft.editorProjectAvailable && draft.editorProjectId && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full gap-1.5 rounded-xl"
                  disabled={sending || handoffPending}
                  onClick={() => onOpenEditorProject(draft.editorProjectId!)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  เปิดงานตัดต่อเดิม
                </Button>
              )}
              {draft.status === "sent" && !draft.editorProjectAvailable && (
                <p className="text-center text-xs" style={{ color: "var(--ui-text-muted)" }}>
                  งานตัดต่อเดิมไม่พร้อมใช้งาน
                </p>
              )}
              <Button
                type="button"
                onClick={onCreateEditorProject}
                disabled={sending || handoffPending || !draft.hookText.trim()}
                className="min-h-11 w-full gap-2 rounded-xl text-sm font-semibold text-white transition hover:brightness-110"
                style={{
                  background: HS_COLOR.violetGradient,
                  boxShadow: HS_COLOR.violetShadow,
                  fontFamily: HS_FONT.heading,
                }}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {draft.status === "sent" ? "สร้างงานตัดต่อใหม่" : "ส่งไปตัดต่อ"}
              </Button>
            </div>
          ) : (
            <div
              className="rounded-xl border px-3 py-2.5 text-xs"
              style={{ borderColor: "var(--ui-card-border)", color: "var(--ui-text-muted)" }}
            >
              <div className="mb-1.5 flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>{EDITOR_LOCKED_MESSAGE}</span>
              </div>
              <Link
                href="/pricing?source=hero_script_editor_lock"
                onClick={() => trackEvent("hero_script_upgrade_clicked", { properties: { surface: "editor_lock" } })}
                className="font-semibold underline"
                style={{ color: HS_COLOR.violet }}
              >
                ดูแผนราคา
              </Link>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
