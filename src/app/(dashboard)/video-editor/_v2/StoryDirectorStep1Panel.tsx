"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Crown, Film, Loader2, Mic, Plus, Sparkles, Trash2, Volume2, Wand2, Zap } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { STORY_DIRECTOR_FLASH_CREDITS, STORY_DIRECTOR_NEON_CREDITS } from "@/lib/credit-costs";
import { normalizeHeadlineHook } from "@/lib/headline-hook";
import type {
  StoryboardCardSummary,
  StoryDirectorModelTier,
  StoryDirectorPlan,
  StoryVoiceMode,
} from "@/lib/story-director-planner";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary } from "./ui";
import type { V2Project } from "./useV2Project";

type UploadedStoryItem = {
  importId?: string;
  src: string;
  filename: string;
  clipDuration: number;
  stillImage?: boolean;
  hasAudio?: boolean;
  isLivePhotoCadence?: boolean;
};

export function StoryDirectorStep1Panel({
  p,
  onExpressRender,
  onOpenStep2,
}: {
  p: V2Project;
  onExpressRender?: () => void;
  onOpenStep2?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<UploadedStoryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [cards, setCards] = useState<StoryboardCardSummary[]>([]);
  const [bpmLabel, setBpmLabel] = useState<number | null>(null);
  const [planBadge, setPlanBadge] = useState<{ modelUsed?: string; creditsCharged?: number } | null>(null);

  const hasPlannedFootage = Array.isArray(p.storyBgVideos) && p.storyBgVideos.length > 0;
  const activeVoiceMode: StoryVoiceMode = p.storyVoiceMode ?? "real-moments";
  const activeModelTier: StoryDirectorModelTier = p.storyModelTier ?? "neon";

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).slice(0, Math.max(0, 16 - items.length));
    if (files.length === 0) {
      toast.error("เพิ่มฟุตเทจได้สูงสุด 16 ไฟล์ต่อโปรเจกต์");
      return;
    }

    setUploading(true);
    const added: UploadedStoryItem[] = [];
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await authenticatedFetch("/api/videos/story-director/upload", {
          method: "POST",
          body: fd,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.src) {
          toast.error(data?.message ?? `อัปโหลด "${file.name}" ไม่สำเร็จ`);
          continue;
        }
        added.push({
          importId: data.importId,
          src: data.src,
          filename: data.filename || file.name,
          clipDuration: Number(data.clipDuration) || 5,
          stillImage: Boolean(data.stillImage),
          hasAudio: Boolean(data.hasAudio),
          isLivePhotoCadence: Boolean(data.isLivePhotoCadence),
        });
      }
      if (added.length > 0) {
        setItems((prev) => [...prev, ...added]);
        toast.success(`อัปโหลดฟุตเทจพร้อมใช้ ${added.length} ไฟล์`);
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleGenerateStoryPlan() {
    if (items.length === 0) {
      toast.error("กรุณาเพิ่มคลิปหรือรูปอย่างน้อย 1 ไฟล์ก่อนครับ");
      return;
    }
    setPlanning(true);
    try {
      const res = await authenticatedFetch("/api/videos/story-director/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: p.storyDirectorBrief,
          templateId: p.templateId,
          modelTier: activeModelTier,
          voiceMode: activeVoiceMode,
          clips: items.map((it) => ({
            src: it.src,
            filename: it.filename,
            stillImage: it.stillImage,
            durationSec: it.clipDuration,
            hasAudio: it.hasAudio,
            isLivePhotoCadence: it.isLivePhotoCadence,
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.plan) {
        toast.error(data?.message ?? "วางโครงเรื่องไม่สำเร็จ กรุณาลองใหม่");
        return;
      }
      const plan = data.plan as StoryDirectorPlan;
      if (p.motionThemeId) p.setMotionThemeId(null);
      p.selectVideoTemplate(plan.templateId);
      p.setStoryVoiceMode(plan.voiceMode);
      p.setStoryMomentCaptions(plan.momentCaptions);
      if (plan.voiceMode === "tts" || plan.script) {
        p.setScript(plan.script);
      }
      p.setHeadlineHook(
        normalizeHeadlineHook({
          enabled: true,
          headline: plan.headline,
          subheadline: plan.subheadline,
          preset: p.headlineHook?.preset ?? "viral",
          durationMs: 3600,
          topPercent: p.headlineHook?.topPercent ?? 18,
        }) ?? undefined,
      );
      p.setStoryBgVideos(plan.bgVideos);
      p.setStoryOverlays(plan.storyOverlays);
      p.setDualTikTokExport(plan.dualTikTokExport);
      setCards(plan.storyboardCards);
      setBpmLabel(plan.bpm);
      setPlanBadge({
        modelUsed: plan.modelUsed,
        creditsCharged: typeof plan.creditsCharged === "number" ? plan.creditsCharged : undefined,
      });
      toast.success(
        `คัดช็อต "${plan.thaiTemplateLabel}" (${plan.bgVideos.length} ช็อตตามบีต) พร้อมสร้างคลิปเลย!`,
      );
    } finally {
      setPlanning(false);
    }
  }

  function handleClearStoryPlan() {
    p.setStoryBgVideos(undefined);
    p.setStoryOverlays(undefined);
    p.setStoryMomentCaptions(undefined);
    setCards([]);
    setBpmLabel(null);
    setPlanBadge(null);
    toast("ล้างแผนตัดต่อฟุตเทจแล้ว");
  }

  return (
    <div
      data-testid="story-director-step1-panel"
      className="flex flex-col gap-3.5 p-4"
      style={{
        borderRadius: 13,
        background: "linear-gradient(180deg, rgba(124,92,255,.07) 0%, rgba(255,255,255,.02) 100%)",
        border: `1px solid ${color.selectedBorder}`,
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wand2 size={15} style={{ color: color.primary300 }} />
          <span style={{ font: `600 13.5px ${font.heading}`, color: color.text }}>
            โยนฟุตเทจให้ AI คัดช็อตตามบีต (พร้อมโพสต์ในหน้าเดียว)
          </span>
        </div>
        {hasPlannedFootage ? (
          <button
            type="button"
            onClick={handleClearStoryPlan}
            style={{
              fontSize: 11,
              color: color.textSecondary,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            ล้างแผนช็อต
          </button>
        ) : null}
      </div>

      {/* 1. Upload Zone */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,.mov,.mp4,.webm,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={(e) => void handleFilesSelected(e.target.files)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <BtnSecondary
          onClick={() => inputRef.current?.click()}
          disabled={uploading || planning}
        >
          <span className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {uploading
              ? "กำลังเตรียมฟุตเทจ 30fps + เก็บเสียงจริง..."
              : items.length > 0
                ? `เพิ่มคลิป/รูปอีก (${items.length}/16)`
                : "1) เลือกคลิปวิดีโอ / รูปถ่ายหลายไฟล์พร้อมกัน"}
          </span>
        </BtnSecondary>
        <span style={{ fontSize: 11, color: color.textFaint }}>
          รองรับ MP4, MOV (รวม Live Photo), JPG, PNG · เก็บเสียงพูด/เสียงเชียร์จริงให้อัตโนมัติ
        </span>
      </div>

      {/* Uploaded chips */}
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, idx) => (
            <div
              key={`${it.src}-${idx}`}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
              style={{
                background: "rgba(255,255,255,.04)",
                border: `1px solid ${color.cardBorder}`,
                fontSize: 11,
                color: color.text,
              }}
            >
              <Film size={12} style={{ color: color.primary300 }} />
              <span className="max-w-[140px] truncate">{it.filename}</span>
              <span style={{ color: color.textFaint }}>
                {it.stillImage ? "รูปภาพ" : `${it.clipDuration.toFixed(1)}s`}
              </span>
              {it.hasAudio && (
                <span title="มีเสียงในคลิป" style={{ color: "#34D399" }}>
                  <Volume2 size={11} />
                </span>
              )}
              <button
                type="button"
                aria-label="ลบไฟล์"
                onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                style={{
                  color: color.textFaint,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 2,
                }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 2. Two Simple Pill Toggles for Beginners (Voice Style + AI Model Tier) */}
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        <div
          className="flex flex-col gap-1.5 rounded-xl p-2.5"
          style={{ background: "rgba(9,11,19,.52)", border: `1px solid ${color.cardBorder}` }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: color.textSecondary }}>
            สไตล์การเล่าเรื่อง (ไม่ต้องเขียนสคริปต์เอง)
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="story-voice-real-moments"
              onClick={() => p.setStoryVoiceMode("real-moments")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors"
              style={{
                fontSize: 11.5,
                color: activeVoiceMode === "real-moments" ? color.primary300 : color.textSecondary,
                background: activeVoiceMode === "real-moments" ? color.selectedBg : "rgba(255,255,255,.03)",
                border: `1px solid ${activeVoiceMode === "real-moments" ? color.selectedBorder : color.cardBorder}`,
                cursor: "pointer",
              }}
            >
              <Volume2 size={13} className="shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-semibold">เสียงจริง + ป้ายข้อความ</span>
                <span className="block truncate" style={{ fontSize: 10, color: color.textFaint }}>
                  TikTok Vlog · ไม่พากย์ทับ
                </span>
              </span>
            </button>
            <button
              type="button"
              data-testid="story-voice-tts"
              onClick={() => p.setStoryVoiceMode("tts")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors"
              style={{
                fontSize: 11.5,
                color: activeVoiceMode === "tts" ? color.primary300 : color.textSecondary,
                background: activeVoiceMode === "tts" ? color.selectedBg : "rgba(255,255,255,.03)",
                border: `1px solid ${activeVoiceMode === "tts" ? color.selectedBorder : color.cardBorder}`,
                cursor: "pointer",
              }}
            >
              <Mic size={13} className="shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-semibold">ให้ AI พากย์เล่า</span>
                <span className="block truncate" style={{ fontSize: 10, color: color.textFaint }}>
                  AI เขียนบท + พากย์ให้
                </span>
              </span>
            </button>
          </div>
        </div>

        <div
          className="flex flex-col gap-1.5 rounded-xl p-2.5"
          style={{ background: "rgba(9,11,19,.52)", border: `1px solid ${color.cardBorder}` }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: color.textSecondary }}>
            ระดับความแม่น AI คัดช็อต (สแกนครั้งเดียว แก้ซับ/สลับเพลงฟรี)
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="story-model-neon"
              onClick={() => p.setStoryModelTier("neon")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors"
              style={{
                fontSize: 11.5,
                color: activeModelTier === "neon" ? "#FFE500" : color.textSecondary,
                background: activeModelTier === "neon" ? "rgba(255,229,0,.09)" : "rgba(255,255,255,.03)",
                border: `1px solid ${activeModelTier === "neon" ? "rgba(255,229,0,.42)" : color.cardBorder}`,
                cursor: "pointer",
              }}
            >
              <Crown size={13} className="shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-semibold">Pro · 4 Neon ({STORY_DIRECTOR_NEON_CREDITS} เครดิต)</span>
                <span className="block truncate" style={{ fontSize: 10, color: color.textFaint }}>
                  จำตัวเอกแม่น · หลบคนบังกล้อง
                </span>
              </span>
            </button>
            <button
              type="button"
              data-testid="story-model-flash"
              onClick={() => p.setStoryModelTier("flash")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors"
              style={{
                fontSize: 11.5,
                color: activeModelTier === "flash" ? color.primary300 : color.textSecondary,
                background: activeModelTier === "flash" ? color.selectedBg : "rgba(255,255,255,.03)",
                border: `1px solid ${activeModelTier === "flash" ? color.selectedBorder : color.cardBorder}`,
                cursor: "pointer",
              }}
            >
              <Zap size={13} className="shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-semibold">ประหยัด · 3.8 Flash ({STORY_DIRECTOR_FLASH_CREDITS} เครดิต)</span>
                <span className="block truncate" style={{ fontSize: 10, color: color.textFaint }}>
                  เร็ว · เหมาะกับคลิปร่างไว
                </span>
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* 3. Short Brief Input + 1-Click Plan Button */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span style={{ fontSize: 11.5, fontWeight: 500, color: color.textSecondary }}>
            2) บอกโจทย์สั้น ๆ 1 บรรทัด (ใครทำอะไร · กิจกรรมอะไร)
          </span>
          <input
            type="text"
            value={p.storyDirectorBrief}
            onChange={(e) => p.setStoryDirectorBrief(e.target.value)}
            placeholder="เช่น น้องโซนิคเป็นดรัมเมเยอร์สีชมพู + แข่งวิ่งคว้า 3 เหรียญ"
            className="w-full rounded-lg px-3 py-2 outline-none"
            style={{
              fontSize: 12.5,
              color: color.text,
              background: "rgba(9,11,19,.65)",
              border: `1px solid ${color.cardBorder}`,
            }}
          />
        </label>
        <BtnPrimary
          onClick={() => void handleGenerateStoryPlan()}
          disabled={planning || uploading || items.length === 0}
          style={{ minHeight: 38, whiteSpace: "nowrap" }}
        >
          <span className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
            {planning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {planning
              ? "AI กำลังส่องเฟรมรายวินาที & ถอดเสียงจริง..."
              : `3) ให้ AI คัดช็อต (${activeModelTier === "neon" ? `${STORY_DIRECTOR_NEON_CREDITS}` : `${STORY_DIRECTOR_FLASH_CREDITS}`} เครดิต)`}
          </span>
        </BtnPrimary>
      </div>

      {/* 4. Clean 1-Glance Storyboard Cards + Express Render CTA */}
      {(cards.length > 0 || hasPlannedFootage) && (
        <div
          className="flex flex-col gap-2.5 rounded-xl p-3"
          style={{ background: "rgba(9,11,19,.48)", border: `1px solid ${color.selectedBorder}` }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ fontSize: 12, fontWeight: 600, color: color.primary300 }}>
                ✓ คัดช็อตพร้อมสร้างวิดีโอแล้ว ({Array.isArray(p.storyBgVideos) ? p.storyBgVideos.length : 0} ช็อต
                {bpmLabel ? ` · ${bpmLabel} BPM` : ""})
              </span>
              {planBadge?.modelUsed && (
                <span
                  style={{
                    fontSize: 10.5,
                    padding: "2px 8px",
                    borderRadius: radius.pill,
                    background: "rgba(52,211,153,.12)",
                    border: "1px solid rgba(52,211,153,.32)",
                    color: "#34D399",
                  }}
                >
                  {planBadge.modelUsed}
                  {typeof planBadge.creditsCharged === "number" && planBadge.creditsCharged > 0
                    ? ` · ใช้ ${planBadge.creditsCharged} เครดิตแล้ว (แก้ต่อฟรี)`
                    : ""}
                </span>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-1.5" style={{ fontSize: 11, color: color.textSecondary }}>
              <input
                type="checkbox"
                checked={p.dualTikTokExport}
                onChange={(e) => p.setDualTikTokExport(e.target.checked)}
                className="accent-violet-500"
              />
              <span>ส่งออกไฟล์คู่ TikTok (ไร้เพลง เหลือเสียงจริง+SFX)</span>
            </label>
          </div>
          {cards.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {cards.map((card) => (
                <div
                  key={`${card.index}-${card.badge}`}
                  className="flex flex-col gap-0.5 rounded-lg px-3 py-2"
                  style={{
                    background: "rgba(9,11,19,.65)",
                    border: `1px solid ${color.cardBorder}`,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "#FFE500" }}>{card.badge}</span>
                    <span style={{ fontSize: 10, color: color.textFaint }}>{card.timeLabel}</span>
                  </div>
                  <span className="truncate" style={{ fontSize: 12, fontWeight: 500, color: color.text }}>
                    {card.title}
                  </span>
                  <span style={{ fontSize: 10.5, color: color.textFaint }}>{card.detail}</span>
                </div>
              ))}
            </div>
          )}

          {onExpressRender && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span style={{ fontSize: 11, color: color.textFaint }}>
                ระบบตั้งเพลง เอฟเฟกต์เสียง และป้ายข้อความให้ครบแล้ว — กดสร้างแล้วไปแก้คำบนคลิปจริงได้ฟรี
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {onOpenStep2 && (
                  <BtnSecondary onClick={onOpenStep2}>
                    <span style={{ fontSize: 11.5 }}>ปรับเพลง/ตั้งค่าเพิ่มเอง</span>
                  </BtnSecondary>
                )}
                <BtnPrimary
                  data-testid="story-director-express-render-btn"
                  onClick={onExpressRender}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>🎬 สร้างวิดีโอพร้อมโพสต์เลย →</span>
                </BtnPrimary>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
