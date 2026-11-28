"use client";

/**
 * สเต็ป 1 — สคริปต์ (จอ 5a): การ์ดเลือกโหมด 2 ใบ + กล่องสคริปต์ + rail เซ็กเมนต์ (ลากเรียงได้)
 * กติกา: 1 บรรทัด = 1 เซ็กเมนต์ · เลือกคลิปเอง = ข้ามเสียง/อวตาร ไปทำ B-roll + ซับ (cutaway)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PenLine, Clapperboard, GripVertical, Crown, Sparkles, NotebookPen, Wand2 } from "lucide-react";
import { DirectAvatarUpload } from "../_components/DirectAvatarUpload";
import { StoryDirectorStep1Panel } from "./StoryDirectorStep1Panel";
import { color, font, radius } from "./tokens";
import { BtnPrimary, Card, IconTile } from "./ui";
import { estimateClipSecV2, countWordsV2 } from "./estimate";
import type { V2Project } from "./useV2Project";
import { audioDurationLimitViolation } from "@/lib/plan-limits";
import { activeStylePacks } from "@/lib/style-pack-catalog";
import { FLAGSHIP_MOTION_STEP1_PRESETS, type FlagshipMotionStep1Preset } from "@/lib/video-template-apply";
import { FIRST_CLIP_STARTERS, shouldApplyFirstClipStarterScript } from "@/lib/first-clip-starter";
import { trackEvent } from "@/lib/client-telemetry";

const CLIP_CUTAWAY_ON = process.env.NEXT_PUBLIC_CLIP_CUTAWAY === "1";

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function segLabel(i: number, total: number) {
  if (i === 0) return "HOOK";
  if (total > 2 && i === total - 1) return "CTA";
  return `เนื้อหา ${i}`;
}

function fallbackClipFileName(url: string): string {
  try {
    const clean = decodeURIComponent(url.split("?")[0] ?? "");
    const base = clean.split("/").pop()?.trim() ?? "";
    if (!base) return "";
    // Server-generated random filenames like avatar-17608...-uuid.mp4 or presenter-import-...
    if (/^(avatar|presenter-import|presenter-stitch|presenter-tighten)-\d+/i.test(base)) {
      return "";
    }
    return base;
  } catch {
    return "";
  }
}

export function Step1Script({
  p,
  onNext,
  onExpressRender,
  firstClipPath = false,
  firstClipScriptOnly = false,
}: {
  p: V2Project;
  onNext: () => void;
  onExpressRender?: () => void;
  firstClipPath?: boolean;
  firstClipScriptOnly?: boolean;
}) {
  useEffect(() => {
    if (firstClipScriptOnly && p.mode !== "script") p.setMode("script");
  }, [firstClipScriptOnly, p.mode, p.setMode]);
  const lines = useMemo(() => p.script.split("\n").filter(l => l.trim().length > 0), [p.script]);
  // นับจากข้อความที่ clean แล้ว (ตรงกับที่ TTS จะอ่านจริง) — สูตรความยาว calibrate ใน estimate.ts
  const totalSec = useMemo(() => estimateClipSecV2(p.script, p.ttsSpeed), [p.script, p.ttsSpeed]);
  const wordCount = useMemo(() => countWordsV2(p.script), [p.script]);
  const [selectedSeg, setSelectedSeg] = useState(0);
  const [storyDirectorOpen, setStoryDirectorOpen] = useState<boolean>(
    () => Array.isArray(p.storyBgVideos) && p.storyBgVideos.length > 0,
  );
  const dragIdx = useRef<number | null>(null);
  const uploadDurationLabel = p.clipDurationSec > 0 ? fmtTime(p.clipDurationSec) : null;
  const clipDurationViolation = p.mode === "upload" && p.clipDurationSec > 0
    ? audioDurationLimitViolation(p.clipDurationSec * 1000, p.plan ?? "FREE")
    : null;
  const scriptDurationViolation = p.mode === "script" && !storyDirectorOpen && totalSec > 0
    ? audioDurationLimitViolation(totalSec * 1000, p.plan ?? "FREE")
    : null;
  const hasPlannedStoryFootage = Array.isArray(p.storyBgVideos) && p.storyBgVideos.length > 0;
  const storyHidesScriptBox =
    p.mode === "script"
    && storyDirectorOpen
    && !firstClipScriptOnly
    && p.storyVoiceMode === "real-moments";
  const showScriptSegments = p.mode !== "upload" && !storyHidesScriptBox;
  const activeClipUrls = useMemo(
    () => (Array.isArray(p.clipUrls) && p.clipUrls.length > 0 ? p.clipUrls : p.clipUrl ? [p.clipUrl] : []),
    [p.clipUrl, p.clipUrls],
  );

  // เวลาโดยประมาณต่อเซ็กเมนต์ — แบ่งตามสัดส่วนความยาวตัวอักษรของแต่ละบรรทัด
  const segTimes = useMemo(() => {
    const weights = lines.map(l => Math.max(1, estimateClipSecV2(l)));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return lines.map((_, i) => {
      const start = acc;
      acc += (weights[i] / sum) * totalSec;
      return { start, end: acc };
    });
  }, [lines, totalSec]);

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...lines];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    p.setScript(next.join("\n"));
    setSelectedSeg(to);
  }

  function handleInsertSampleScript() {
    const sample = FIRST_CLIP_STARTERS[0];
    if (!sample || !shouldApplyFirstClipStarterScript(p.script)) return;
    p.setScript(sample.script);
    trackEvent("step1_empty_starter_clicked", {
      properties: { kind: "sample_script" },
    });
    toast.success("ใส่สคริปต์ตัวอย่าง 30 วิให้แล้ว — แก้ข้อความหรือกดถัดไปได้เลย");
  }

  // CTA เดียว — ใช้ทั้งใน rail (desktop) และ sticky footer (mobile), ไม่ให้ logic แยกกัน
  const isStoryExpressReady =
    p.mode === "script" && storyDirectorOpen && hasPlannedStoryFootage && Boolean(onExpressRender);
  const ctaDisabled = p.mode === "upload"
    ? (!p.canUploadOwnMedia || !p.clipUrl || Boolean(clipDurationViolation))
    : storyDirectorOpen
      ? !hasPlannedStoryFootage && !lines.length
      : !lines.length;
  const primaryCta = (
    <BtnPrimary
      className="w-full"
      disabled={ctaDisabled}
      style={ctaDisabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
      onClick={isStoryExpressReady ? onExpressRender : onNext}
    >
      {isStoryExpressReady
        ? "🎬 สร้างวิดีโอพร้อมโพสต์เลย →"
        : firstClipPath && p.mode === "script"
          ? "ถัดไป: เลือกเสียงแล้วสร้างคลิปแรก →"
          : "ถัดไป: เลือกองค์ประกอบ →"}
    </BtnPrimary>
  );

  const presenterEnhancementOptions = p.canUploadOwnMedia ? (
    <div
      className="flex w-full flex-col gap-2 rounded-xl p-3"
      style={{ background: "rgba(255,255,255,.03)", border: `1px solid ${color.cardBorder}` }}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={Boolean(p.tighten)}
          onChange={(e) => p.setTighten(e.target.checked)}
          className="mt-0.5 accent-violet-500"
        />
        <span className="flex flex-col">
          <span style={{ fontSize: 12, fontWeight: 500, color: color.text }}>กระชับจังหวะอัตโนมัติ (ตัดช่วงเงียบ + เร่ง 1.1x)</span>
          <span style={{ fontSize: 10.5, color: color.textFaint }}>ตัดจังหวะเงียบเกิน 0.4 วิให้กระชับก่อนถอดซับไทย</span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={Boolean(p.punchZoom)}
          onChange={(e) => p.setPunchZoom(e.target.checked)}
          className="mt-0.5 accent-violet-500"
        />
        <span className="flex flex-col">
          <span style={{ fontSize: 12, fontWeight: 500, color: color.text }}>ซูมสลับจังหวะคนพูดอัตโนมัติ (Punch-in Zoom 1.15x)</span>
          <span style={{ fontSize: 10.5, color: color.textFaint }}>สลับระยะกล้องเฉพาะชั้นวิดีโอคนพูดโดยซับไม่ขยับ</span>
        </span>
      </label>
    </div>
  ) : null;

  return (
    <>
    <div className="flex min-h-0 flex-1 max-lg:flex-col max-lg:overflow-y-auto">
      {/* ── เนื้อหาซ้าย ── */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 lg:overflow-y-auto max-lg:overflow-visible px-7 py-6">
        {/* Conversion Trial stays on Narrative Source; paid-equivalent users retain upload. */}
        {firstClipScriptOnly ? null : (
        <div className="grid grid-cols-3 gap-2.5 max-lg:grid-cols-1">
          <ModeCard
            selected={p.mode === "script" && !storyDirectorOpen}
            onClick={() => {
              setStoryDirectorOpen(false);
              p.setMode("script");
            }}
            icon={<PenLine size={17} strokeWidth={1.6} />}
            title="พิมพ์สคริปต์"
            desc="ยังไม่มีคลิป · ให้ AI พากย์เสียง + หาภาพ + ทำซับให้ครบ"
          />
          <ModeCard
            selected={p.mode === "upload"}
            disabled={!CLIP_CUTAWAY_ON}
            onClick={() => {
              if (!CLIP_CUTAWAY_ON) return;
              setStoryDirectorOpen(false);
              p.setMode("upload");
            }}
            icon={<Clapperboard size={17} strokeWidth={1.6} />}
            title="ใช้คลิปพูดของตัวเอง"
            desc={CLIP_CUTAWAY_ON ? "มีคลิปพูดหน้ากล้อง 1–5 ช่วง · ตัดจังหวะเงียบ + ถอดซับ + แทรก B-roll" : "เร็ว ๆ นี้"}
          />
          <ModeCard
            selected={p.mode === "script" && storyDirectorOpen}
            onClick={() => {
              p.setMode("script");
              setStoryDirectorOpen(true);
            }}
            icon={<Wand2 size={17} strokeWidth={1.6} />}
            title="โยนฟุตเทจให้ AI ตัด"
            desc="มีหลายคลิป/รูป Vlog · AI คัดช็อตตามบีต ดึงเสียงจริง + ขึ้นป้ายไฮไลต์"
          />
        </div>
        )}

        {/* เทมเพลตสไตล์วิดีโอ (1 คลิก — ตั้งซับ พาดหัว เสียง เพลง และจังหวะครบชุด) */}
        <section
          aria-label="เลือกสไตล์เทมเพลตวิดีโอ"
          className="flex flex-col gap-2"
          style={{
            borderRadius: 13,
            padding: "10px 12px",
            background: "rgba(255,255,255,.02)",
            border: `1px solid ${color.cardBorder}`,
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} strokeWidth={1.8} style={{ color: color.primary300 }} />
              <span style={{ font: `600 12px ${font.heading}`, color: color.text }}>
                เลือกสไตล์เทมเพลตวิดีโอ (Video Template)
              </span>
              <span style={{ fontSize: 10.5, color: color.textFaint }}>
                · แตะ 1 คลิกเพื่อตั้งซับ พาดหัว โทนเสียง และเพลงให้อัตโนมัติ
              </span>
            </div>
            {(p.templateId || p.motionThemeId) ? (
              <button
                type="button"
                onClick={() => {
                  p.selectVideoTemplate(null);
                  p.setMotionThemeId(null);
                  toast("เปลี่ยนกลับเป็นกำหนดเองแล้ว");
                }}
                style={{
                  fontSize: 10.5,
                  color: color.primary300,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                ล้างเทมเพลต (กำหนดเอง)
              </button>
            ) : null}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {FLAGSHIP_MOTION_STEP1_PRESETS.map((preset: FlagshipMotionStep1Preset) => {
              const active = p.motionThemeId === preset.motionThemeId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-motion-preset-id={preset.motionThemeId}
                  aria-pressed={active}
                  onClick={() => {
                    if (active) {
                      p.setMotionThemeId(null);
                      p.selectVideoTemplate(null);
                      toast("เปลี่ยนกลับเป็นกำหนดเองแล้ว");
                      return;
                    }
                    p.selectVideoTemplate(preset.templateId);
                    p.setMotionThemeId(preset.motionThemeId);
                    trackEvent("motion_broll_quick_cta_clicked", {
                      properties: { surface: "step1_template_strip", motionThemeId: preset.motionThemeId, templateId: preset.templateId },
                    });
                    toast.success(`เลือก Motion "${preset.shortLabel}" แล้ว (60fps · 0 เครดิต)`);
                  }}
                  className="flex min-w-[178px] max-w-[214px] shrink-0 flex-col items-start gap-1 text-left"
                  style={{
                    borderRadius: radius.card,
                    padding: "8px 10px",
                    background: active ? color.selectedBg : "rgba(139,92,246,.06)",
                    border: `1px solid ${active ? color.selectedBorder : "rgba(139,92,246,.28)"}`,
                    cursor: "pointer",
                    transition: "all 150ms ease",
                  }}
                >
                  <div className="flex w-full items-center justify-between gap-1.5">
                    <span className="truncate" style={{ font: `600 12px ${font.heading}`, color: color.text }}>
                      {preset.thaiLabel}
                    </span>
                    <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                      {preset.palette.map((hex, idx) => (
                        <span
                          key={`${preset.id}-${idx}`}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: hex,
                            border: "1px solid rgba(255,255,255,.22)",
                          }}
                        />
                      ))}
                    </span>
                  </div>
                  <span
                    className="w-full truncate"
                    style={{ fontSize: 10, color: active ? color.primary300 : color.textSecondary }}
                  >
                    {active ? `กำลังใช้ · ${preset.tagline}` : preset.tagline}
                  </span>
                </button>
              );
            })}
            {activeStylePacks().map((pack) => {
              const active = p.templateId === pack.id && !p.motionThemeId;
              return (
                <button
                  key={pack.id}
                  type="button"
                  data-template-id={pack.id}
                  aria-pressed={active}
                  onClick={() => {
                    const next = active ? null : pack.id;
                    if (p.motionThemeId) p.setMotionThemeId(null);
                    p.selectVideoTemplate(next);
                    if (next) toast.success(`เลือกเทมเพลต "${pack.thaiLabel}" แล้ว`);
                    else toast("เปลี่ยนกลับเป็นกำหนดเองแล้ว");
                  }}
                  className="flex min-w-[164px] max-w-[196px] shrink-0 flex-col items-start gap-1 text-left"
                  style={{
                    borderRadius: radius.card,
                    padding: "8px 10px",
                    background: active ? color.selectedBg : color.cardBg,
                    border: `1px solid ${active ? color.selectedBorder : color.cardBorder}`,
                    cursor: "pointer",
                    transition: "all 150ms ease",
                  }}
                >
                  <div className="flex w-full items-center justify-between gap-1.5">
                    <span className="truncate" style={{ font: `500 12px ${font.heading}`, color: color.text }}>
                      {pack.thaiLabel}
                    </span>
                    <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                      {pack.palette.map((hex, idx) => (
                        <span
                          key={`${pack.id}-${idx}`}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: hex,
                            border: "1px solid rgba(255,255,255,.22)",
                          }}
                        />
                      ))}
                    </span>
                  </div>
                  <span
                    className="w-full truncate"
                    style={{ fontSize: 10, color: active ? color.primary300 : color.textFaint }}
                  >
                    {active ? `กำลังใช้ · ${pack.tagline}` : pack.tagline}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* โหมด AI ผู้กำกับฟุตเทจ (โยนหลายคลิป+รูปให้ AI วางโครงเรื่องและตัดตามบีต) */}
        {p.mode === "script" && storyDirectorOpen && !firstClipScriptOnly ? (
          p.canUploadOwnMedia ? (
            <StoryDirectorStep1Panel
              p={p}
              onExpressRender={onExpressRender}
              onOpenStep2={onNext}
            />
          ) : (
            <div
              className="flex items-center justify-center p-6"
              style={{ borderRadius: 13, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}
            >
              <LockedUploadPanel />
            </div>
          )
        ) : null}

        {/* โหมดอัปคลิปเอง (cutaway) */}
        {p.mode === "upload" && !firstClipScriptOnly ? (
          <div
            className={`flex min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto p-6 ${p.clipUrl ? "justify-start" : "justify-center"}`}
            style={{ borderRadius: 13, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}
          >
            {!p.canUploadOwnMedia ? (
              <LockedUploadPanel />
            ) : p.clipUrl ? (
              <div className="grid w-full max-w-[820px] grid-cols-1 items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
                {/* คอลัมน์ซ้าย: พรีวิววิดีโอ 9:16 + ความยาวรวม */}
                <div className="flex flex-col items-center gap-2.5">
                  <video
                    src={p.clipUrl}
                    controls
                    playsInline
                    className="w-full max-w-[240px] max-h-[420px]"
                    style={{
                      borderRadius: 12,
                      border: `1px solid ${color.cardBorder}`,
                      aspectRatio: "9/16",
                      objectFit: p.presenterFit === "contain" ? "contain" : "cover",
                      background: "#09090f",
                    }}
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      if (
                        activeClipUrls.length <= 1
                        && Number.isFinite(v.duration)
                        && v.duration > 0
                      ) {
                        p.setClipDurationSec(v.duration);
                      }
                    }}
                  />
                  {uploadDurationLabel && (
                    <span className="text-center" style={{ fontSize: 11, color: color.textFaint }}>
                      {activeClipUrls.length > 1
                        ? `รวม ${activeClipUrls.length} คลิป · ยาว ~${uploadDurationLabel} นาที (ครอสเฟดเสียง 12ms อัตโนมัติ)`
                        : `คลิปยาว ${uploadDurationLabel} นาที`}
                    </span>
                  )}
                  {clipDurationViolation && (
                    <div
                      role="alert"
                      className="w-full rounded-lg px-3 py-2 text-center"
                      style={{ fontSize: 11.5, lineHeight: 1.65, color: color.danger, background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.22)" }}
                    >
                      {clipDurationViolation.message}<br />{clipDurationViolation.userAction}
                    </div>
                  )}
                </div>

                {/* คอลัมน์ขวา: รายละเอียดการตั้งค่าคลิป + รายการคลิปที่นำมาต่อเรียงกัน */}
                <div className="flex min-w-0 flex-col gap-3">
                  {/* การจัดวางคลิปลงจอแนวตั้ง 9:16 (รองรับคลิปแนวนอน 16:9 / จัตุรัส) */}
                  <div
                    className="flex w-full flex-col gap-1.5 rounded-xl p-3"
                    style={{ background: "rgba(255,255,255,.03)", border: `1px solid ${color.cardBorder}` }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 500, color: color.textSecondary }}>
                      การจัดวางลงจอแนวตั้ง 9:16 (สำหรับคลิปแนวนอน / จัตุรัส)
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => p.setPresenterFit("crop")}
                        className="rounded-lg px-2.5 py-2 text-left transition-colors"
                        style={{
                          fontSize: 11.5,
                          color: p.presenterFit !== "contain" ? color.primary300 : color.textSecondary,
                          background: p.presenterFit !== "contain" ? color.selectedBg : "rgba(255,255,255,.03)",
                          border: `1px solid ${p.presenterFit !== "contain" ? color.selectedBorder : color.cardBorder}`,
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>ครอปกลางเต็มจอ 9:16</div>
                        <div style={{ fontSize: 10, color: color.textFaint }}>ซูมเต็มจอแนวตั้งอัตโนมัติ</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => p.setPresenterFit("contain")}
                        className="rounded-lg px-2.5 py-2 text-left transition-colors"
                        style={{
                          fontSize: 11.5,
                          color: p.presenterFit === "contain" ? color.primary300 : color.textSecondary,
                          background: p.presenterFit === "contain" ? color.selectedBg : "rgba(255,255,255,.03)",
                          border: `1px solid ${p.presenterFit === "contain" ? color.selectedBorder : color.cardBorder}`,
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>วางเต็มเฟรม + พื้นหลังเบลอ</div>
                        <div style={{ fontSize: 10, color: color.textFaint }}>เห็นภาพ 16:9 ครบไม่โดนตัด</div>
                      </button>
                    </div>
                  </div>

                  {/* ต่อคลิปพูดหลายช่วงอัตโนมัติ (Multi-Clip Stitch สูงสุด 5 คลิป) */}
                  <div
                    className="flex w-full flex-col gap-2 rounded-xl p-3"
                    style={{ background: "rgba(255,255,255,.03)", border: `1px solid ${color.cardBorder}` }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span style={{ fontSize: 11.5, fontWeight: 500, color: color.textSecondary }}>
                        คลิปที่นำมาต่อเรียงกัน ({activeClipUrls.length}/5 คลิป)
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          p.setClipUrls([]);
                          p.setClipNames([]);
                          p.setClipUrl("");
                          p.setClipDurationSec(0);
                        }}
                        style={{ fontSize: 11.5, color: color.link, background: "none", border: "none", cursor: "pointer" }}
                      >
                        ล้างทั้งหมด / เปลี่ยนคลิปหลัก
                      </button>
                    </div>
                    {activeClipUrls.length >= 1 && (
                      <div className="flex flex-col gap-1">
                        {activeClipUrls.map((u, idx) => {
                          const clipName = p.clipNames?.[idx]?.trim() || fallbackClipFileName(u);
                          return (
                            <div
                              key={`${u}-${idx}`}
                              className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
                              style={{ background: "rgba(255,255,255,.04)", fontSize: 11.5, color: color.text }}
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="shrink-0 font-medium">คลิปช่วงที่ {idx + 1}</span>
                                {clipName && (
                                  <span
                                    className="truncate"
                                    style={{ color: color.textSecondary }}
                                    title={clipName}
                                  >
                                    · {clipName}
                                  </span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  const next = activeClipUrls.filter((_, i) => i !== idx);
                                  const nextNames = Array.from(
                                    { length: activeClipUrls.length },
                                    (_, i) => p.clipNames?.[i] ?? "",
                                  ).filter((_, i) => i !== idx);
                                  p.setClipUrls(next);
                                  p.setClipNames(nextNames);
                                }}
                                className="shrink-0"
                                style={{ fontSize: 11, color: color.danger, background: "none", border: "none", cursor: "pointer" }}
                              >
                                ลบ
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {activeClipUrls.length < 5 && (
                      <DirectAvatarUpload
                        onUrl={(u, meta) => {
                          const current = activeClipUrls;
                          const currentNames = Array.from({ length: current.length }, (_, i) => p.clipNames?.[i] ?? "");
                          const next = [...current, u].slice(0, 5);
                          const nextNames = [...currentNames, meta?.fileName?.trim() ?? ""].slice(0, 5);
                          p.setClipUrls(next);
                          p.setClipNames(nextNames);
                          if (meta?.durationSec && meta.durationSec > 0) {
                            p.setClipDurationSec((p.clipDurationSec || 0) + meta.durationSec);
                          }
                        }}
                        label={`+ เพิ่มคลิปพูดต่อท้าย (ช่วงที่ ${activeClipUrls.length + 1}/5)`}
                        hint="อัปเพิ่มเพื่อต่อเรียงเป็นคลิปเดียวอัตโนมัติ"
                        planRequiredMessage="อัปโหลดคลิปส่วนตัวใช้ได้เฉพาะแผน Pro ขึ้นไป"
                        successMessage="เพิ่มคลิปช่วงถัดไปสำเร็จ"
                      />
                    )}
                  </div>

                  {presenterEnhancementOptions}
                </div>
              </div>
            ) : (
              <div className="flex w-full max-w-[420px] flex-col gap-3">
                <div>
                  <DirectAvatarUpload
                    onUrl={(u, meta) => {
                      p.setClipUrls([u]);
                      p.setClipNames([meta?.fileName?.trim() ?? ""]);
                      p.setClipUrl(u);
                      p.setClipDurationSec(meta?.durationSec ?? 0);
                      if (meta?.width && meta?.height && meta.width > meta.height) {
                        toast("อัปโหลดคลิปแนวนอนสำเร็จ — เลือกครอปกลาง 9:16 หรือวางเต็มเฟรมพร้อมพื้นหลังเบลอได้ด้านข้าง");
                      }
                    }}
                    label="อัปโหลดคลิปของคุณ (แนวตั้ง 9:16 หรือแนวนอน 16:9)"
                    hint="mp4 / mov / webm · มีเสียงพูดในคลิป · ต่อหลายคลิปได้"
                    planRequiredMessage="อัปโหลดคลิปส่วนตัวใช้ได้เฉพาะแผน Pro ขึ้นไป"
                    successMessage="อัปโหลดคลิปสำเร็จ"
                  />
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {[
                      "รองรับ 9:16 & 16:9 แนวนอน",
                      "ต่อเรียงสูงสุด 5 คลิป",
                      "ตัดจังหวะเงียบอัตโนมัติ",
                      "ถอดซับไทย + แทรก B-roll",
                    ].map((badge) => (
                      <span
                        key={badge}
                        style={{
                          fontSize: 10.5,
                          padding: "2px 8px",
                          borderRadius: radius.pill,
                          background: "rgba(139,92,246,.10)",
                          border: `1px solid ${color.selectedBorder}`,
                          color: color.primary300,
                        }}
                      >
                        {badge}
                      </span>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: color.textFaint, marginTop: 8, lineHeight: 1.7, textAlign: "center" }}>
                    รองรับทั้งคลิปแนวตั้ง (9:16) และแนวนอน (16:9) ที่มีเสียงพูดของคุณ — ระบบจะแปลงเป็น 9:16
                    ถอดซับไทยจากเสียง แล้วแทรกบีโรลให้อัตโนมัติ
                  </p>
                </div>
                {presenterEnhancementOptions}
              </div>
            )}
          </div>
        ) : storyHidesScriptBox ? null : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{ borderRadius: 13, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5">
            <span style={{ font: `500 13.5px ${font.heading}` }}>สคริปต์ของคุณ</span>
            <span style={{ fontSize: 10.5, color: firstClipPath ? color.success : color.textFaint }}>
              {firstClipPath
                ? "✓ รวมเสียง AI + สต็อกในสิทธิ์ทดลองแล้ว ไม่ต้องใส่ API Key · Enter = แยกเซ็กเมนต์"
                : "Enter = ขึ้นเซ็กเมนต์ใหม่"}
            </span>
          </div>
          {p.mode === "script" && !lines.length && (
            <div
              data-testid="step1-empty-starter-strip"
              className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5"
              style={{
                background: "rgba(139,92,246,.07)",
                border: `1px solid ${color.selectedBorder}`,
              }}
            >
              <span className="w-full text-[11.5px] sm:mr-1 sm:w-auto" style={{ color: color.textSecondary }}>
                ยังไม่มีสคริปต์? เริ่มไวใน 1 คลิก:
              </span>
              <button
                type="button"
                data-testid="step1-sample-script-btn"
                onClick={handleInsertSampleScript}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-all hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
                style={{
                  background: "linear-gradient(180deg,#8B66F8,#6C4CF4)",
                  color: "#fff",
                  cursor: "pointer",
                  border: "none",
                }}
              >
                <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
                ลองสคริปต์ตัวอย่าง 30 วิ (1 คลิก)
              </button>
              <Link
                href="/hero-script"
                data-testid="step1-ai-script-link"
                onClick={() => {
                  trackEvent("step1_empty_starter_clicked", {
                    properties: { kind: "hero_script" },
                  });
                }}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors hover:bg-violet-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
                style={{
                  background: color.cardBg,
                  border: `1px solid ${color.selectedBorder}`,
                  color: color.primary300,
                }}
              >
                <NotebookPen size={13} strokeWidth={2} aria-hidden="true" />
                ให้ AI เขียนสคริปต์ให้
              </Link>
              {FLAGSHIP_MOTION_STEP1_PRESETS.map((preset) => (
                <button
                  key={`starter-${preset.id}`}
                  type="button"
                  data-testid={`step1-motion-starter-${preset.motionThemeId}`}
                  onClick={() => {
                    if (!shouldApplyFirstClipStarterScript(p.script)) return;
                    p.selectVideoTemplate(preset.templateId);
                    p.setMotionThemeId(preset.motionThemeId);
                    p.setScript(preset.sampleScript);
                    trackEvent("step1_empty_starter_clicked", {
                      properties: {
                        kind: "motion_flagship_starter",
                        motionThemeId: preset.motionThemeId,
                        templateId: preset.templateId,
                      },
                    });
                    toast.success(`เริ่มด้วย Motion "${preset.shortLabel}" + สคริปต์ตัวอย่างแล้ว`);
                  }}
                  className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium transition-colors hover:bg-violet-500/15"
                  style={{
                    background: "rgba(255,255,255,.03)",
                    border: `1px solid ${color.cardBorder}`,
                    color: color.textSecondary,
                    cursor: "pointer",
                  }}
                >
                  ✦ {preset.shortLabel} (60fps)
                </button>
              ))}
            </div>
          )}
          <textarea
            value={p.script}
            onChange={(e) => p.setScript(e.target.value)}
            placeholder={"พิมพ์สคริปต์ที่นี่…\nขึ้นบรรทัดใหม่ = แยกเซ็กเมนต์"}
            className="min-h-[220px] flex-1 resize-none bg-transparent px-4 py-3 outline-none"
            style={{ fontSize: 14, lineHeight: 1.7, color: color.text, fontFamily: font.body }}
          />
          <div
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            style={{ borderTop: `1px solid ${color.cardBorder}` }}
          >
            {scriptDurationViolation ? (
              <span
                data-testid="script-duration-limit-warning"
                style={{ fontSize: 11.5, color: color.warningText, fontWeight: 500 }}
              >
                ⚠️ ประมาณการยาวเกินเพดานแผน: {scriptDurationViolation.message}
              </span>
            ) : <span />}
            <span style={{ fontSize: 11, color: scriptDurationViolation ? color.warningText : color.textFaint }}>
              {wordCount} คำ · {lines.length} เซ็กเมนต์ · คลิปยาว ~{fmtTime(totalSec)} นาที
            </span>
          </div>
        </div>
        )}
      </div>

      {/* ── Right rail 372px ── */}
      <aside
        className="flex flex-col lg:w-[372px] lg:shrink-0 max-lg:w-full max-lg:shrink"
        style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}
      >
        <div className="px-5 pt-5 pb-3">
          <div style={{ font: `500 13.5px ${font.heading}` }}>
            {p.mode === "upload"
              ? "โหมดใช้คลิปของคุณ"
              : storyHidesScriptBox
                ? "โหมดผู้กำกับฟุตเทจ (TikTok Vlog)"
                : lines.length
                  ? "ระบบแบ่งเซ็กเมนต์ให้แล้ว"
                  : "เซ็กเมนต์จะขึ้นที่นี่"}
          </div>
          <div style={{ fontSize: 11, color: color.textFaint, marginTop: 2 }}>
            {p.mode === "upload"
              ? p.canUploadOwnMedia ? "ซับ + บีโรลจะถูกสร้างจากเสียงในคลิปหลังกดเรนเดอร์" : "อัปโหลดคลิปส่วนตัวเปิดให้ Pro ขึ้นไป"
              : storyHidesScriptBox
                ? "ใช้เสียงพูด/เชียร์จริงในคลิป + เพลง + ป้ายข้อความอัตโนมัติ"
                : "ลากการ์ดเพื่อสลับลำดับ"}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 lg:overflow-y-auto max-lg:overflow-visible px-5 pb-3">
          {p.mode === "upload" && (
            <div
              className="flex flex-1 flex-col justify-center gap-3 text-center"
              style={{ fontSize: 12, color: color.textFaint, borderRadius: radius.card, border: `1px dashed rgba(255,255,255,.12)`, minHeight: 160, padding: 18 }}
            >
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "rgba(124,92,255,.16)", color: color.primary300 }}>
                <Clapperboard size={18} strokeWidth={1.8} />
              </div>
              {p.canUploadOwnMedia ? (
                p.clipUrl ? (
                  <div className="flex flex-col gap-1.5">
                    <span style={{ font: `500 13px ${font.heading}`, color: color.text }}>คลิปพร้อมใช้งาน</span>
                    <span style={{ lineHeight: 1.65 }}>
                      {uploadDurationLabel ? `ความยาว ${uploadDurationLabel} นาที · ` : ""}ระบบจะใช้เสียงจากคลิปนี้เพื่อสร้างซับและบีโรล
                    </span>
                  </div>
                ) : (
                  <span style={{ lineHeight: 1.65 }}>อัปโหลดคลิปทางซ้าย แล้วไปเลือกองค์ประกอบต่อ</span>
                )
              ) : (
                <span style={{ lineHeight: 1.65 }}>อัปเกรดเป็น Pro เพื่ออัปโหลดคลิปส่วนตัว</span>
              )}
            </div>
          )}
          {storyHidesScriptBox && (
            <div
              className="flex flex-1 flex-col justify-center gap-3 text-center"
              style={{ fontSize: 12, color: color.textFaint, borderRadius: radius.card, border: `1px dashed rgba(255,255,255,.12)`, minHeight: 160, padding: 18 }}
            >
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "rgba(124,92,255,.16)", color: color.primary300 }}>
                <Wand2 size={18} strokeWidth={1.8} />
              </div>
              {hasPlannedStoryFootage ? (
                <div className="flex flex-col gap-1.5">
                  <span style={{ font: `500 13px ${font.heading}`, color: color.text }}>
                    พร้อมสร้างคลิป ({Array.isArray(p.storyBgVideos) ? p.storyBgVideos.length : 0} ช็อตตามบีต)
                  </span>
                  <span style={{ lineHeight: 1.65 }}>
                    กดปุ่มด้านล่างเพื่อเรนเดอร์ทันทีโดยไม่ต้องผ่านหน้าตั้งค่าเสียง — หลังเรนเดอร์แก้ข้อความและสลับเพลงได้ฟรี
                  </span>
                </div>
              ) : (
                <span style={{ lineHeight: 1.65 }}>
                  1) อัปโหลดคลิป/รูปทางซ้าย<br />
                  2) พิมพ์โจทย์สั้น ๆ 1 บรรทัด แล้วกดให้ AI คัดช็อต
                </span>
              )}
            </div>
          )}
          {showScriptSegments && lines.map((line, i) => (
            <div
              key={`${i}-${line.slice(0, 12)}`}
              draggable
              onDragStart={() => { dragIdx.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIdx.current != null) reorder(dragIdx.current, i); dragIdx.current = null; }}
              onClick={() => setSelectedSeg(i)}
              style={{ cursor: "grab" }}
            >
              <Card selected={i === selectedSeg}>
                <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
                  <span style={{ color: i === selectedSeg ? color.primary300 : color.textSecondary, fontWeight: 600 }}>
                    {segLabel(i, lines.length)}
                  </span>
                  <span className="flex items-center gap-1.5" style={{ color: color.textFaint }}>
                    {fmtTime(segTimes[i]?.start ?? 0)}–{fmtTime(segTimes[i]?.end ?? 0)}
                    <GripVertical size={12} strokeWidth={1.6} />
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5, lineHeight: 1.55, marginTop: 6,
                    color: i === selectedSeg ? color.text : color.textSecondary,
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                  }}
                >
                  {line}
                </div>
              </Card>
            </div>
          ))}
          {showScriptSegments && !lines.length && (
            <div
              className="flex flex-1 items-center justify-center text-center"
              style={{ fontSize: 12, color: color.textFaintest, borderRadius: radius.card, border: `1px dashed rgba(255,255,255,.12)`, minHeight: 120 }}
            >
              เริ่มพิมพ์สคริปต์ทางซ้าย<br />ระบบจะแบ่งเซ็กเมนต์ให้อัตโนมัติ
            </div>
          )}
        </div>

        {/* CTA เดียว — ซ่อนบนมือถือ (ย้ายไป sticky footer ด้านล่างแทน) */}
        <div className="px-5 pb-5 pt-2 max-lg:hidden">
          {primaryCta}
        </div>
      </aside>
    </div>

    {/* Sticky bottom CTA — มือถือเท่านั้น, ใช้ handler/label เดียวกับปุ่มใน rail */}
    <div
      className="lg:hidden sticky bottom-0 z-10"
      style={{
        background: color.bg0,
        borderTop: `1px solid ${color.cardBorder}`,
        padding: "12px 14px calc(12px + env(safe-area-inset-bottom))",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {primaryCta}
    </div>
    </>
  );
}

function LockedUploadPanel() {
  return (
    <div className="flex w-full max-w-[430px] flex-col items-center text-center" style={{ gap: 12 }}>
      <div
        className="flex h-11 w-11 items-center justify-center rounded-full"
        style={{ background: "rgba(251,191,36,.12)", color: color.warning, border: "1px solid rgba(251,191,36,.28)" }}
      >
        <Crown size={18} strokeWidth={1.8} />
      </div>
      <div className="flex flex-col" style={{ gap: 5 }}>
        <span style={{ font: `500 13.5px ${font.heading}`, color: color.text }}>อัปโหลดคลิปส่วนตัวใช้ได้ใน Pro</span>
        <span style={{ fontSize: 11.5, lineHeight: 1.65, color: color.textFaint }}>
          แผน Free ยังสร้างวิดีโอจากสคริปต์และใช้เพลงระบบได้ แต่โหมดอัปคลิปของตัวเองต้องอัปเกรดก่อน
        </span>
      </div>
      <a
        href="/pricing"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          minHeight: 36, padding: "0 16px", borderRadius: radius.control,
          background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
          color: color.primary300, fontSize: 12, fontWeight: 500,
        }}
      >
        ดูแพ็ก Pro
      </a>
    </div>
  );
}

function ModeCard({ selected, disabled, onClick, icon, title, desc }: {
  selected: boolean; disabled?: boolean; onClick: () => void;
  icon: React.ReactNode; title: string; desc: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 text-left"
      style={{
        borderRadius: 13, padding: "13px 16px",
        background: selected ? color.selectedBg : color.cardBg,
        border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 150ms ease",
      }}
    >
      <IconTile size={34}>{icon}</IconTile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span style={{ font: `500 13px ${font.heading}`, color: color.text }}>{title}</span>
        <span style={{ fontSize: 10.5, color: color.textFaint }}>{desc}</span>
      </span>
      {/* radio 15px */}
      <span
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
        style={{ border: `1.5px solid ${selected ? color.primary500 : "rgba(255,255,255,.25)"}` }}
      >
        {selected && <span className="h-[7px] w-[7px] rounded-full" style={{ background: color.primary500 }} />}
      </span>
    </button>
  );
}
