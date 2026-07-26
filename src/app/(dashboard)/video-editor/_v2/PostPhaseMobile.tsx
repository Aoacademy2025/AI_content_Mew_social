"use client";

/**
 * PostPhaseMobile — เลย์เอาต์แต่งซับสำหรับจอมือถือ (<1024px) แบบ touch-native:
 * preview ติดบน + สครับ, รายการ์ดซับเลื่อนแนวตั้ง, bottom-sheet แก้การ์ด + สไตล์ซับ.
 *
 * ใช้ usePostPhaseEditor ตัวเดียวกับ desktop PostPhase — ไม่มี state ซับ/สไตล์/burn ซ้ำ.
 * timeline ตั้งใจตัดทิ้งบนมือถือ. subtitle timing แก้ผ่าน handleCaptionsChange เดิม
 * (nudge ±100ms / ตั้งจุด=ตำแหน่งที่เล่นอยู่) — ไม่แตะ math ของ subtitle/avatar.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check, CheckCircle2, ChevronDown, Download, Image as ImageIcon, Loader2, Move, Pause, Pencil, Play, SlidersHorizontal, Undo2,
} from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary, BtnGhost, Chip, GroupLabel, Segmented } from "./ui";
import {
  V2_QUICK_STYLES, PRESETS_DATA, EFFECTS_DATA, FONTS_LIST,
  EDITABLE_EFFECT_PRESETS_DATA, BUILT_IN_EFFECT_PRESETS_DATA,
  V2_TEXT_COLORS, V2_ACCENT_COLORS,
  LOCKED_EFFECT_PRESETS, LOCKED_COLOR_PRESETS, LOCKED_ACCENT_PRESETS,
  V2_CARD_LEN_OPTIONS, type V2CardLen,
} from "./subtitle-style";
import type { V2JobState } from "./useV2Job";
import { V2CaptionOverlay } from "./V2CaptionOverlay";
import { AvatarAdjustOverlay } from "./AvatarAdjustOverlay";
import { usePostPhaseEditor } from "./usePostPhaseEditor";
import { LogoOverlayControls } from "./LogoOverlayControls";
import { LogoOverlayPreview } from "./LogoOverlayPreview";
import { MobileSheet } from "./MobileSheet";
import { BrollWindowInspector, WindowEditsBottomBar } from "./BrollWindowInspector";
import { brollWindowSpans } from "@/lib/broll-spans";
import type { BrollRegionPreference, BrollVisualStyle } from "@/lib/broll-preferences";
import { normalizeLogoOverlayConfig, type LogoOverlayConfig } from "@/lib/logo-overlay";
import { trackEvent } from "@/lib/client-telemetry";

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const avatarModeLabel = (m?: string | null) =>
  m === "full" ? "ทั้งคลิป" : m === "bookend-both" ? "เปิด-ปิด" : m === "bookend" ? "เปิด" : "";

const BROLL_WINDOW_EDIT = process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1";

export function PostPhaseMobile({
  job,
  script,
  onExportJob,
  onAdoptJob,
  onNewProject,
  onPreviewError,
  projectId,
  logoOverlay,
  onLogoOverlayChange,
  logoEligible,
  projectSaveStatus,
  onRetryProjectSave,
  brollRegionPreference = "auto",
  brollVisualStyle = "auto",
  internalAiTester,
  aiImageEnabled,
  downloadFilename,
}: {
  job: V2JobState; script: string;
  onExportJob: (input: { sourceJobId: string; subtitleOverlayConfig: unknown; script?: string; sceneCount?: number }) => Promise<{ ok: boolean; message?: string }>;
  onAdoptJob: (next: { id: string; projectId?: string | null }) => void; onNewProject: () => void;
  onPreviewError: () => void;
  projectId: string | null;
  logoOverlay?: LogoOverlayConfig;
  onLogoOverlayChange: (next: LogoOverlayConfig | undefined) => void;
  logoEligible: boolean;
  projectSaveStatus: "idle" | "saving" | "saved" | "error";
  onRetryProjectSave: () => void;
  brollRegionPreference?: BrollRegionPreference; brollVisualStyle?: BrollVisualStyle;
  internalAiTester: boolean;
  aiImageEnabled: boolean;
  downloadFilename: string;
}) {
  const ed = usePostPhaseEditor(job, script, {
    onExportJob,
    onAdoptJob,
    projectId,
    logoOverlay,
    onLogoOverlayChange,
    logoEligible,
    projectSaveStatus,
    onRetryProjectSave,
    surface: "mobile",
  });
  const [styleOpen, setStyleOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const logoTriggerRef = useRef<HTMLButtonElement | null>(null);
  const logoEnabled = !!normalizeLogoOverlayConfig(logoOverlay)?.enabled;
  // Per-window b-roll editing (Task 11) — hidden entirely for upload-cutaway projects
  // (same reasoning as PostPhase.tsx's desktop gate).
  const brollEditEnabled = (BROLL_WINDOW_EDIT || internalAiTester) && ed.preview?.avatarModel !== "upload-cutaway";

  const selectedCap = ed.captions[ed.selected];
  const durationMs = Math.max(
    ed.preview?.audioDurationMs ?? 0,
    ed.captions.length ? ed.captions[ed.captions.length - 1].endMs : 0,
    1,
  );
  const pct = Math.min(100, Math.max(0, (ed.timeMs / durationMs) * 100));
  const busy = ed.exp.phase === "burning" || ed.exp.phase === "saving";
  // มือถือไม่มี timeline (ตัดทิ้งตั้งใจ) — แถบชิปนี้คือทางเข้าเลือกหน้าต่างบีโรลแทน
  const brollSpans = useMemo(() => brollWindowSpans(ed.previewConfig, durationMs), [ed.previewConfig, durationMs]);

  useEffect(() => {
    if (!logoOpen) return;
    trackEvent("logo_overlay_panel_opened", { properties: { surface: "mobile" } });
  }, [logoOpen]);

  function togglePlay() {
    const v = ed.videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play(); else v.pause();
  }
  function seekTrack(e: React.MouseEvent<HTMLDivElement>) {
    const v = ed.videoRef.current;
    if (!v) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    v.currentTime = (frac * durationMs) / 1000;
  }
  function openEdit(i: number) {
    ed.setSelected(i);
    ed.setFollow(true);
    const v = ed.videoRef.current;
    const cap = ed.captions[i];
    if (v && cap) v.currentTime = cap.startMs / 1000 + 0.01;
    v?.pause(); // กันเสียงเล่นค้างหลัง sheet ที่บัง preview
    setStyleOpen(false);
    setLogoOpen(false);
    setEditOpen(true);
  }

  function openStyle() {
    setEditOpen(false);
    setLogoOpen(false);
    setStyleOpen(true);
  }

  function openLogo() {
    ed.videoRef.current?.pause();
    setEditOpen(false);
    setStyleOpen(false);
    setLogoOpen(true);
  }

  // timing edits ทั้งหมดเข้าทาง handleCaptionsChange(next, true) เดียวกับ timeline drag commit
  function setBoundary(field: "startMs" | "endMs", rawMs: number) {
    const i = ed.selected;
    const cap = ed.captions[i];
    if (!cap) return;
    const v = Math.max(0, Math.round(rawMs));
    const start = field === "startMs" ? v : cap.startMs;
    const end = field === "endMs" ? v : cap.endMs;
    if (start >= end) { toast.error("ปรับไม่ได้ — จุดเข้าต้องมาก่อนจุดออก"); return; } // guard start < end
    ed.handleCaptionsChange(ed.captions.map((c, ci) => (ci === i ? { ...c, [field]: v } : c)), true);
  }
  function nudge(field: "startMs" | "endMs", deltaMs: number) {
    const cap = ed.captions[ed.selected];
    if (!cap) return;
    setBoundary(field, (field === "startMs" ? cap.startMs : cap.endMs) + deltaMs);
  }
  function snapToPlayhead(field: "startMs" | "endMs") {
    const v = ed.videoRef.current;
    if (!v) return;
    setBoundary(field, Math.round(v.currentTime * 1000));
  }

  function openAvatarAdjust() {
    const v = ed.videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
    setStyleOpen(false);
    ed.setAdjustingAvatar(true);
  }

  if (ed.exp.phase === "done") {
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-5">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} color={color.success} />
          <span style={{ font: `600 15px ${font.heading}`, color: color.success, textAlign: "center" }}>ส่งออกสำเร็จ — อยู่ใน Gallery แล้ว</span>
        </div>
        <video src={ed.exp.url} controls playsInline style={{ maxHeight: "44vh", borderRadius: radius.cardLg, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16" }} />
        <div className="flex w-full max-w-[360px] flex-col gap-2.5" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <a href={ed.exp.url} download={downloadFilename} className="block">
            <BtnPrimary style={{ width: "100%", minHeight: 46 }}><span className="flex items-center justify-center gap-2"><Download size={15} /> ดาวน์โหลด</span></BtnPrimary>
          </a>
          <a href="/videos" className="block"><BtnSecondary style={{ width: "100%", minHeight: 46 }}>ดูใน Gallery</BtnSecondary></a>
          <BtnGhost onClick={() => ed.setExp({ phase: "idle" })} style={{ width: "100%", minHeight: 44 }}>แก้ซับต่อ &amp; ส่งออกใหม่</BtnGhost>
          <BtnGhost onClick={onNewProject} style={{ width: "100%", minHeight: 44 }}>เริ่มโปรเจกต์ใหม่</BtnGhost>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── preview ติดบน + สครับ ── */}
      <div data-mobile-preview="true" className="shrink-0" style={{ background: "#000", borderBottom: `1px solid ${color.cardBorder}` }}>
        <div data-mobile-video-preview-frame="true" style={{ position: "relative", height: "40vh", maxHeight: 360, aspectRatio: "9/16", margin: "0 auto", background: "#000", overflow: "hidden" }}>
          <video
            ref={ed.videoRef}
            src={ed.baseUrl}
            playsInline
            onTimeUpdate={(e) => ed.setTimeMs(e.currentTarget.currentTime * 1000)}
            onPlay={() => ed.setPlaying(true)}
            onPause={() => ed.setPlaying(false)}
            onError={onPreviewError}
            className="h-full w-full object-cover"
          />
          <LogoOverlayPreview value={logoOverlay} asset={ed.logo.asset} />
          {/* เส้นไกด์ตำแหน่งซับ */}
          <div className="pointer-events-none absolute left-2 right-2" style={{ top: `${ed.cfg.verticalPos}%`, borderTop: "1px dashed rgba(255,255,255,.25)" }} />
          {/* ซับสด — renderer เดียวกับไฟล์ burn (WYSIWYG) */}
          <V2CaptionOverlay
            captions={ed.captions}
            overrides={ed.overrides}
            cfg={ed.cfg}
            videoRef={ed.videoRef}
            playing={ed.playing}
            onVerticalPos={(p) => ed.set("verticalPos", p)}
          />
          {!ed.playing && !ed.adjustingAvatar && !busy && (
            <button
              onClick={togglePlay}
              aria-label="เล่น"
              className="absolute flex items-center justify-center"
              style={{ top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 52, height: 52, borderRadius: "50%", background: "rgba(0,0,0,.42)", border: "1.5px solid rgba(255,255,255,.55)", cursor: "pointer", backdropFilter: "blur(3px)" }}
            >
              <Play size={20} fill="#fff" color="#fff" style={{ marginLeft: 3 }} />
            </button>
          )}
          {ed.adjustingAvatar && ed.canAdjustAvatar && ed.preview && (
            <AvatarAdjustOverlay
              avatarId={ed.preview.avatarModel!}
              avatarMode={ed.preview.avatarMode!}
              introSecs={ed.preview.avatarIntroSecs ?? 5}
              tailSecs={ed.preview.avatarTailSecs ?? 5}
              avatarVideoUrl={ed.preview.avatarVideoUrl!}
              tailAvatarUrl={ed.preview.tailAvatarUrl ?? null}
              bgVideoUrl={ed.compositeBaseUrl!}
              jobId={job.jobId}
              onClose={() => ed.setAdjustingAvatar(false)}
              onDone={(url) => {
                ed.setBaseUrl(url);
                ed.setAdjustingAvatar(false);
                const v = ed.videoRef.current;
                if (v) { v.load(); v.currentTime = 0; }
              }}
            />
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(10,10,16,.55)" }}>
              <Loader2 size={22} className="animate-spin" color={color.primary300} />
            </div>
          )}
        </div>
        {!ed.adjustingAvatar && (
          <div className="flex items-center gap-2.5 px-3.5 py-2" style={{ background: color.bgTimeline }}>
            <button
              onClick={togglePlay}
              aria-label={ed.playing ? "หยุด" : "เล่น"}
              className="flex shrink-0 items-center justify-center"
              style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(255,255,255,.08)", border: `1px solid ${color.cardBorder}`, color: color.text, cursor: "pointer" }}
            >
              {ed.playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" style={{ marginLeft: 1 }} />}
            </button>
            <span style={{ fontSize: 11, color: color.textSecondary, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtMs(ed.timeMs)}</span>
            {/* hit area สูง ≥44px ครอบเส้นบาง 5px เดิม — seekTrack ใช้ rect ของ wrapper นี้ (left/width เท่าเดิม) จึงคำนวณ seek เหมือนเดิม */}
            <div onClick={seekTrack} className="relative flex flex-1 items-center" style={{ height: 44, cursor: "pointer" }}>
              <div className="pointer-events-none absolute left-0 right-0" style={{ top: "50%", transform: "translateY(-50%)", height: 5, borderRadius: 999, background: "rgba(255,255,255,.10)" }}>
                <div className="absolute left-0 top-0 bottom-0" style={{ width: `${pct}%`, borderRadius: 999, background: color.gradientPrimary }} />
                <div className="absolute" style={{ top: "50%", left: `${pct}%`, transform: "translate(-50%,-50%)", width: 13, height: 13, borderRadius: "50%", background: "#fff", boxShadow: "0 0 0 3px rgba(139,92,246,.35)" }} />
              </div>
            </div>
            <span style={{ fontSize: 11, color: color.textSecondary, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtMs(durationMs)}</span>
          </div>
        )}
      </div>

      <div
        data-mobile-editor-actions="true"
        className="flex shrink-0 gap-2 px-3.5 py-2"
        style={{ background: color.bgTimeline, borderBottom: `1px solid ${color.cardBorder}` }}
      >
        <button
          type="button"
          data-mobile-editor-action="subtitle"
          onClick={() => openEdit(ed.activeIdx >= 0 ? ed.activeIdx : ed.selected)}
          style={mobileEditorActionStyle}
        >
          <Pencil size={15} aria-hidden="true" />
          <span>แก้ซับ</span>
        </button>
        <button
          ref={logoTriggerRef}
          type="button"
          data-mobile-editor-action="logo"
          aria-haspopup="dialog"
          aria-expanded={logoOpen}
          onClick={openLogo}
          style={mobileEditorActionStyle}
        >
          <ImageIcon size={16} aria-hidden="true" />
          <span>โลโก้</span>
          {logoEnabled && (
            <span
              data-logo-enabled-indicator="true"
              className="inline-flex items-center gap-1"
              style={{ padding: "2px 6px", borderRadius: radius.pill, background: "rgba(52,211,153,.13)", color: color.success, fontSize: 10, fontWeight: 600 }}
            >
              <Check size={11} strokeWidth={3} aria-hidden="true" />
              เปิดอยู่
            </span>
          )}
        </button>
      </div>

      {/* ── body: สถานะ + รายการ์ดซับ + สรุปคลิป ── */}
      <div onScroll={ed.onListScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ WebkitOverflowScrolling: "touch" }}>
        <div className="flex items-center justify-between gap-2 px-3.5 pt-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: color.success, flex: "none" }} />
            <span style={{ fontSize: 12, color: color.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>เรนเดอร์เสร็จแล้ว · แก้ซับเห็นผลทันที</span>
          </span>
          <button onClick={onNewProject} style={{ fontSize: 12, color: color.link, background: "none", border: "none", cursor: "pointer", flex: "none" }}>เรนเดอร์ใหม่</button>
        </div>

        {ed.exp.phase === "error" && (
          <div className="px-3.5 pt-2" style={{ fontSize: 11.5, color: color.danger }}>
            {ed.exp.message} — <button onClick={() => ed.setExp({ phase: "idle" })} style={{ color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}>ลองใหม่</button>
          </div>
        )}

        {/* บีโรล — ไม่มี timeline บนมือถือ ชิปแนวนอนนี้คือทางเข้าเลือกหน้าต่างแทน (Task 11) */}
        {brollEditEnabled && brollSpans.length > 0 && (
          <div className="px-3.5 pb-1 pt-3">
            <GroupLabel style={{ display: "block", marginBottom: 8 }}>บีโรล ({brollSpans.length})</GroupLabel>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {brollSpans.map((s) => {
                const edited = ed.windowEdits.has(s.index);
                return (
                  <button
                    key={s.index}
                    onClick={() => ed.setSelectedWindow(s.index)}
                    className="flex shrink-0 flex-col items-start gap-1 text-left"
                    style={{
                      padding: "8px 12px", minWidth: 96, borderRadius: radius.card,
                      background: edited ? color.selectedBg : "rgba(255,255,255,.035)",
                      border: `1px solid ${edited ? color.selectedBorder : color.cardBorder}`,
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: 10, color: color.textFaint }}>{fmtMs(s.startMs)}–{fmtMs(s.endMs)}</span>
                    <span style={{ fontSize: 11.5, color: color.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 110 }}>{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-3.5 pb-1.5 pt-3">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <GroupLabel>การ์ดซับ ({ed.captions.length})</GroupLabel>
              <button
                onClick={ed.undoCaptions}
                disabled={ed.historyLen === 0}
                aria-label="เลิกทำการแก้ไขล่าสุด"
                title="เลิกทำ"
                className="flex items-center justify-center"
                style={{
                  width: 44, height: 44, borderRadius: "50%", background: "none",
                  border: `1px solid ${color.cardBorder}`, color: color.textSecondary,
                  cursor: ed.historyLen === 0 ? "default" : "pointer",
                  opacity: ed.historyLen === 0 ? 0.4 : 1, flex: "none",
                }}
              >
                <Undo2 size={16} />
              </button>
            </div>
            <Chip selected={ed.follow} onClick={ed.resumeFollow} style={{ padding: "5px 11px", fontSize: 11 }}>ตามซับที่กำลังเล่น</Chip>
          </div>
          {ed.captions.map((c, i) => {
            const isActive = i === ed.activeIdx;
            const tagLabel = c.tag === "hook" ? "HOOK" : c.tag === "cta" ? "CTA" : "เนื้อหา";
            const tagStyle = c.tag === "hook"
              ? { background: "rgba(251,191,36,.16)", color: color.warning }
              : c.tag === "cta"
                ? { background: "rgba(52,211,153,.16)", color: color.success }
                : { background: "rgba(156,156,180,.16)", color: color.textSecondary };
            return (
              <div
                key={`${i}-${c.startMs}`}
                ref={(el) => { ed.cardRefs.current[i] = el; }}
                onClick={() => openEdit(i)}
                className="mb-2 flex items-start gap-3"
                style={{
                  padding: 12, borderRadius: radius.card, cursor: "pointer",
                  background: isActive ? color.selectedBg : "rgba(255,255,255,.035)",
                  border: `1px solid ${isActive ? color.selectedBorder : color.cardBorder}`,
                }}
              >
                <span style={{ font: `600 11px ${font.heading}`, color: color.textFaintest, width: 16, textAlign: "center", flex: "none", paddingTop: 2, fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div style={{ fontSize: 14, lineHeight: 1.45, color: color.text }}>{c.text}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, fontWeight: 600, ...tagStyle }}>{tagLabel}</span>
                    <span style={{ fontSize: 11, color: color.textFaint, fontVariantNumeric: "tabular-nums" }}>{fmtMs(c.startMs)} – {fmtMs(c.endMs)}</span>
                  </div>
                </div>
                <Pencil size={16} strokeWidth={2} color={color.textFaintest} style={{ flex: "none", marginTop: 2 }} />
              </div>
            );
          })}
        </div>

        <ClipSummary open={summaryOpen} onToggle={() => setSummaryOpen((o) => !o)} preview={ed.preview} captionCount={ed.captions.length} durationMs={durationMs} />
      </div>

      {/* ── sticky footer ── */}
      {!ed.adjustingAvatar && (
        <div
          className="flex shrink-0 items-stretch gap-2.5"
          style={{ padding: "12px 14px calc(12px + env(safe-area-inset-bottom))", borderTop: `1px solid ${color.cardBorder}`, background: "rgba(10,10,16,.92)", backdropFilter: "blur(12px)" }}
        >
          <BtnSecondary onClick={openStyle} style={{ flex: 1, minHeight: 46, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <SlidersHorizontal size={16} /> สไตล์ซับ
          </BtnSecondary>
          <BtnPrimary
            onClick={() => void ed.exportVideo()}
            disabled={busy}
            style={{ flex: 2, minHeight: 46, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, ...(busy ? { opacity: 0.7, cursor: "wait" } : {}) }}
          >
            {ed.exp.phase === "burning" ? `กำลังฝังซับ ${ed.exp.progress}%` : ed.exp.phase === "saving" ? "กำลังบันทึก…" : (<><Download size={16} /> ส่งออกวิดีโอ</>)}
          </BtnPrimary>
        </div>
      )}

      {/* ── edit bottom-sheet ── */}
      <MobileSheet open={editOpen} onClose={() => setEditOpen(false)} title={`การ์ดที่ ${ed.selected + 1}`} size="large">
        {selectedCap && (
          <>
            <GroupLabel style={{ display: "block", margin: "10px 0 7px" }}>ข้อความ</GroupLabel>
            <textarea
              value={selectedCap.text}
              onChange={(e) => ed.setCaptions((caps) => caps.map((cc, ci) => (ci === ed.selected ? { ...cc, text: e.target.value } : cc)))}
              rows={3}
              className="w-full resize-none"
              style={{ padding: "12px 14px", borderRadius: 11, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontSize: 13.5, lineHeight: 1.7, fontFamily: font.body, outline: "none" }}
            />
            <GroupLabel style={{ display: "block", margin: "16px 0 8px" }}>จังหวะ</GroupLabel>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 12px", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: color.textSecondary }}>เข้า</span>
              <Nudge value={selectedCap.startMs} onDelta={(d) => nudge("startMs", d)} />
              <span style={{ fontSize: 13, color: color.textSecondary }}>ออก</span>
              <Nudge value={selectedCap.endMs} onDelta={(d) => nudge("endMs", d)} />
            </div>
            <button onClick={() => snapToPlayhead("startMs")} style={snapBtnStyle}>↧ ตั้งจุดเข้า = ตำแหน่งที่เล่นอยู่ ({fmtMs(ed.timeMs)})</button>
            <button onClick={() => snapToPlayhead("endMs")} style={snapBtnStyle}>↥ ตั้งจุดออก = ตำแหน่งที่เล่นอยู่ ({fmtMs(ed.timeMs)})</button>
            <div className="mt-4 flex gap-2.5">
              <BtnSecondary onClick={() => ed.mergeSelected()} style={{ flex: 1, minHeight: 44, textAlign: "center" }}>รวมกับใบถัดไป</BtnSecondary>
              <BtnSecondary onClick={() => ed.splitSelected()} style={{ flex: 1, minHeight: 44, textAlign: "center" }}>แยกการ์ด</BtnSecondary>
            </div>
          </>
        )}
      </MobileSheet>

      {/* ── style full-screen sheet ── */}
      <MobileSheet open={styleOpen} onClose={() => setStyleOpen(false)} title="สไตล์ซับ (ทั้งคลิป)" size="large">
        <div className="flex flex-col gap-5 pt-2">
          {ed.canAdjustAvatar && (
            <section className="flex flex-col gap-2">
              <GroupLabel>อวตาร</GroupLabel>
              <button
                onClick={openAvatarAdjust}
                className="flex items-center justify-center gap-2"
                style={{ minHeight: 46, borderRadius: radius.control, background: "rgba(139,92,246,.10)", border: "1px solid rgba(139,92,246,.45)", color: color.primary300, fontSize: 13, cursor: "pointer" }}
              >
                <Move size={14} /> ปรับตำแหน่ง/ขนาดอวตาร (ฟรี)
              </button>
              <span style={{ fontSize: 10, color: color.textFaintest }}>ตำแหน่งที่บันทึกจะถูกใช้เป็นค่าเริ่มต้นของอวตารนี้ในการเรนเดอร์ครั้งถัดไปด้วย</span>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <GroupLabel>ความยาวการ์ดซับ</GroupLabel>
            <Segmented
              value={ed.cardLen}
              onChange={(v) => ed.applyCardLen(v as V2CardLen)}
              options={V2_CARD_LEN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              style={{ display: "flex", flexWrap: "wrap" }}
            />
            <span style={{ fontSize: 10, color: color.textFaintest }}>≤N คำ = ซับสั้นเด้งเร็วแบบ TikTok · เปลี่ยนแล้วจะล้างการรวม/แยก/สีรายการ์ดที่แก้ไว้</span>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>สไตล์แนะนำ</GroupLabel>
            <div className="grid grid-cols-2 gap-2">
              {V2_QUICK_STYLES.map((s) => {
                const active = ed.cfg.preset === s.preset && ed.cfg.effect === s.effect;
                return (
                  <button
                    key={s.key}
                    onClick={() => ed.setCfg((c) => ({ ...c, preset: s.preset, effect: s.effect }))}
                    className="flex flex-col items-start gap-1 text-left"
                    style={{ borderRadius: radius.card, padding: "11px 12px", background: active ? color.selectedBg : color.cardBg, border: `1px solid ${active ? color.selectedBorder : color.cardBorder}`, cursor: "pointer" }}
                  >
                    <span style={{ font: `500 13px ${font.heading}`, color: color.text }}>{s.label}</span>
                    <span style={{ fontSize: 10.5, color: active ? color.primary300 : color.textFaint }}>{active ? "กำลังใช้" : s.desc}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ปรับเอฟเฟกต์ได้ ({EDITABLE_EFFECT_PRESETS_DATA.length})</GroupLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {EDITABLE_EFFECT_PRESETS_DATA.map((p) => (
                <button
                  key={p.value}
                  onClick={() => ed.set("preset", p.value)}
                  style={{ borderRadius: 9, padding: "10px 4px", fontSize: 11, minHeight: 42, background: ed.cfg.preset === p.value ? color.selectedBg : color.cardBg, border: `1px solid ${ed.cfg.preset === p.value ? color.selectedBorder : color.cardBorder}`, color: ed.cfg.preset === p.value ? color.primary300 : color.textSecondary, cursor: "pointer", fontFamily: font.body }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>เอฟเฟกต์ติดมากับสไตล์ ({BUILT_IN_EFFECT_PRESETS_DATA.length})</GroupLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {BUILT_IN_EFFECT_PRESETS_DATA.map((p) => (
                <button
                  key={p.value}
                  onClick={() => ed.set("preset", p.value)}
                  title="สไตล์นี้มีเอฟเฟกต์ในตัว"
                  style={{ borderRadius: 9, padding: "10px 4px", fontSize: 11, minHeight: 42, background: ed.cfg.preset === p.value ? color.selectedBg : color.cardBg, border: `1px solid ${ed.cfg.preset === p.value ? color.selectedBorder : color.cardBorder}`, color: ed.cfg.preset === p.value ? color.primary300 : color.textSecondary, cursor: "pointer", fontFamily: font.body }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 10, color: color.textFaintest }}>เลือกกลุ่มนี้แล้วระบบจะใช้เอฟเฟกต์ประจำสไตล์แทนปุ่มเอฟเฟกต์ด้านล่าง</span>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>เอฟเฟกต์ตัวอักษร</GroupLabel>
            {LOCKED_EFFECT_PRESETS.includes(ed.cfg.preset) ? (
              <span style={{ fontSize: 10.5, color: color.textFaintest }}>สไตล์ &quot;{PRESETS_DATA.find((p) => p.value === ed.cfg.preset)?.label}&quot; กำหนดเอฟเฟกต์ในตัว</span>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {EFFECTS_DATA.map((ef) => (
                  <button
                    key={ef.value}
                    onClick={() => ed.set("effect", ef.value)}
                    title={ef.desc}
                    style={{ borderRadius: 9, padding: "10px 4px", fontSize: 11, minHeight: 42, background: ed.cfg.effect === ef.value ? color.selectedBg : color.cardBg, border: `1px solid ${ed.cfg.effect === ef.value ? color.selectedBorder : color.cardBorder}`, color: ed.cfg.effect === ef.value ? color.primary300 : color.textSecondary, cursor: "pointer", fontFamily: font.body }}
                  >
                    {ef.label}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ฟอนต์ · น้ำหนัก · ขนาด ({ed.cfg.fontSize}px)</GroupLabel>
            <div className="flex items-center gap-2">
              <select
                value={ed.cfg.fontFamily}
                onChange={(e) => ed.set("fontFamily", e.target.value)}
                className="min-w-0 flex-1"
                style={{ padding: "11px 12px", borderRadius: radius.control, fontSize: 13, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontFamily: font.body }}
              >
                {FONTS_LIST.map((f) => <option key={f.value} value={f.value} style={{ background: color.bg1 }}>{f.label}</option>)}
              </select>
              <Segmented
                value={ed.cfg.bold ? "bold" : "regular"}
                onChange={(v) => ed.set("bold", v === "bold")}
                options={[{ value: "bold", label: "หนา" }, { value: "regular", label: "บาง" }]}
              />
            </div>
            <input type="range" min={30} max={160} value={ed.cfg.fontSize} onChange={(e) => ed.set("fontSize", Number(e.target.value))} style={{ accentColor: color.primary500, height: 28 }} />
          </section>

          {(!LOCKED_COLOR_PRESETS.includes(ed.cfg.preset) || !LOCKED_ACCENT_PRESETS.includes(ed.cfg.preset)) && (
            <section className="flex flex-col gap-2">
              <GroupLabel>ใช้สีกับ</GroupLabel>
              <Segmented
                value={ed.scope}
                onChange={(v) => ed.setScope(v as "all" | "card")}
                options={[{ value: "all", label: "ทั้งคลิป" }, { value: "card", label: `การ์ดที่เลือก (#${ed.selected + 1})` }]}
                style={{ display: "flex" }}
              />
            </section>
          )}

          {!LOCKED_COLOR_PRESETS.includes(ed.cfg.preset) && (() => {
            const effective = ed.scope === "card" ? (ed.activeOverride.textColor ?? ed.cfg.textColor) : ed.cfg.textColor;
            return (
              <section className="flex flex-col gap-2">
                <GroupLabel>สีตัวอักษร{ed.scope === "card" ? ` · การ์ด #${ed.selected + 1}` : ""}</GroupLabel>
                <div className="flex flex-wrap items-center gap-3">
                  {V2_TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => ed.setColorScoped("textColor", c)}
                      aria-label={c}
                      style={{ width: 30, height: 30, borderRadius: "50%", background: c, cursor: "pointer", border: c === "#FFFFFF" || c === "#000000" ? "1px solid rgba(255,255,255,.25)" : "none", outline: effective === c ? `2px solid ${color.primary500}` : "none", outlineOffset: 2 }}
                    />
                  ))}
                  <label className="relative cursor-pointer" style={{ width: 30, height: 30, borderRadius: "50%", background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)", outline: !V2_TEXT_COLORS.includes(effective as typeof V2_TEXT_COLORS[number]) ? `2px solid ${color.primary500}` : "none", outlineOffset: 2 }}>
                    <input type="color" value={effective} onChange={(e) => ed.setColorScoped("textColor", e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="สีกำหนดเอง" />
                  </label>
                </div>
              </section>
            );
          })()}

          {!LOCKED_ACCENT_PRESETS.includes(ed.cfg.preset) && (() => {
            const effective = ed.scope === "card" ? (ed.activeOverride.accentColor ?? ed.cfg.accentColor) : ed.cfg.accentColor;
            return (
              <section className="flex flex-col gap-2">
                <GroupLabel>สีเน้น HOOK · CTA{ed.scope === "card" ? ` · การ์ด #${ed.selected + 1}` : ""}</GroupLabel>
                <div className="flex flex-wrap items-center gap-3">
                  {V2_ACCENT_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => ed.setColorScoped("accentColor", c)}
                      aria-label={c}
                      style={{ width: 30, height: 30, borderRadius: "50%", background: c, cursor: "pointer", outline: effective === c ? `2px solid ${color.primary500}` : "none", outlineOffset: 2 }}
                    />
                  ))}
                  <label className="relative cursor-pointer" style={{ width: 30, height: 30, borderRadius: "50%", background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)", outline: !V2_ACCENT_COLORS.includes(effective as typeof V2_ACCENT_COLORS[number]) ? `2px solid ${color.primary500}` : "none", outlineOffset: 2 }}>
                    <input type="color" value={effective} onChange={(e) => ed.setColorScoped("accentColor", e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="สีเน้นกำหนดเอง" />
                  </label>
                </div>
              </section>
            );
          })()}

          <section className="flex flex-col gap-2">
            <GroupLabel>เงา · เส้นขอบ</GroupLabel>
            <div className="flex flex-wrap items-center gap-4" style={{ fontSize: 13, color: color.textSecondary }}>
              <label className="flex cursor-pointer items-center gap-1.5" style={{ minHeight: 30 }}>
                <input type="checkbox" checked={ed.cfg.shadow} onChange={(e) => ed.set("shadow", e.target.checked)} style={{ accentColor: color.primary500, width: 18, height: 18 }} /> เงา
              </label>
              <label className="flex cursor-pointer items-center gap-1.5" style={{ minHeight: 30 }}>
                <input type="checkbox" checked={ed.cfg.outline} onChange={(e) => ed.set("outline", e.target.checked)} style={{ accentColor: color.primary500, width: 18, height: 18 }} /> เส้นขอบ
              </label>
              {ed.cfg.outline && (
                <input type="range" min={1} max={8} value={ed.cfg.outlineSize} onChange={(e) => ed.set("outlineSize", Number(e.target.value))} className="flex-1" style={{ accentColor: color.primary500, minWidth: 120 }} />
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ตำแหน่งแนวตั้ง ({ed.cfg.verticalPos}%)</GroupLabel>
            <input type="range" min={10} max={95} value={ed.cfg.verticalPos} onChange={(e) => ed.set("verticalPos", Number(e.target.value))} style={{ accentColor: color.primary500, height: 28 }} />
            <Segmented
              value={ed.cfg.verticalPos <= 30 ? "top" : ed.cfg.verticalPos <= 62 ? "mid" : "bot"}
              onChange={(v) => ed.set("verticalPos", v === "top" ? 20 : v === "mid" ? 55 : 82)}
              options={[{ value: "top", label: "บน" }, { value: "mid", label: "กลาง" }, { value: "bot", label: "ล่าง" }]}
              style={{ display: "flex" }}
            />
          </section>
        </div>
      </MobileSheet>

      <MobileSheet
        open={logoOpen}
        onClose={() => setLogoOpen(false)}
        title="โลโก้"
        size="medium"
        triggerRef={logoTriggerRef}
      >
        <div className="pt-2">
          <LogoOverlayControls
            value={logoOverlay}
            eligible={logoEligible}
            editor={ed.logo}
          />
        </div>
      </MobileSheet>

      {brollEditEnabled && <WindowEditsBottomBar ed={ed} />}

      {brollEditEnabled && ed.selectedWindow != null && (
        <BrollWindowInspector ed={ed} brollRegionPreference={brollRegionPreference} brollVisualStyle={brollVisualStyle} aiImageEnabled={aiImageEnabled} />
      )}
    </div>
  );
}

// ── รายละเอียดคลิป (read-only, ยุบได้) ───────────────────────────────────────
function ClipSummary({ open, onToggle, preview, captionCount, durationMs }: {
  open: boolean;
  onToggle: () => void;
  preview: ReturnType<typeof usePostPhaseEditor>["preview"];
  captionCount: number;
  durationMs: number;
}) {
  const hasAvatar = !!(preview?.avatarModel && preview.avatarModel !== "none");
  const bgm = typeof preview?.config?.bgmFile === "string" ? (preview.config.bgmFile as string) : null;
  const bgmName = bgm ? decodeURIComponent(bgm.split("/").pop() ?? bgm).replace(/\.[a-z0-9]+$/i, "") : null;
  return (
    <div className="mx-3.5 mb-4 overflow-hidden" style={{ borderRadius: radius.card, border: `1px solid ${color.cardBorder}`, background: "rgba(255,255,255,.02)" }}>
      <button onClick={onToggle} className="flex w-full items-center justify-between" style={{ padding: "12px 14px", background: "none", border: "none", cursor: "pointer" }}>
        <span style={{ fontSize: 13, color: color.textSecondary }}>รายละเอียดคลิป</span>
        <ChevronDown size={16} color={color.textSecondary} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 200ms ease" }} />
      </button>
      {open && (
        <div className="px-3.5 pb-3">
          {hasAvatar && (
            <SummaryRow dot={color.trackAvatar} label="พิธีกร AI" value={`${avatarModeLabel(preview?.avatarMode)}${preview?.avatarMode && preview.avatarMode !== "full" ? ` · ${preview.avatarIntroSecs ?? 5} วิ` : ""}`.trim()} />
          )}
          <SummaryRow dot={color.trackSub} label="ซับไทย" value={`${captionCount} การ์ด`} />
          <SummaryRow dot={color.trackMusic} label="เพลงประกอบ" value={bgmName ?? "ไม่มี"} />
          <SummaryRow dot={color.trackVoice} label="ความยาว" value={fmtMs(durationMs)} />
        </div>
      )}
    </div>
  );
}

function SummaryRow({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5" style={{ padding: "8px 0", borderTop: "1px solid rgba(255,255,255,.05)" }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, flex: "none", background: dot }} />
      <span style={{ flex: 1, fontSize: 13, color: color.text }}>{label}</span>
      <span style={{ fontSize: 12, color: color.textSecondary, textAlign: "right" }}>{value}</span>
    </div>
  );
}

// ── nudge ±0.1s ─────────────────────────────────────────────────────────────
function Nudge({ value, onDelta }: { value: number; onDelta: (deltaMs: number) => void }) {
  return (
    <div className="flex items-center overflow-hidden" style={{ borderRadius: 11, border: "1px solid rgba(255,255,255,.12)" }}>
      <button onClick={() => onDelta(-100)} aria-label="ลด 0.1 วินาที" style={nudgeBtnStyle}>−</button>
      <span style={{ flex: 1, textAlign: "center", font: `500 15px ${font.heading}`, fontVariantNumeric: "tabular-nums", background: "rgba(255,255,255,.02)", padding: "10px 4px", color: color.text }}>{(value / 1000).toFixed(1)}s</span>
      <button onClick={() => onDelta(100)} aria-label="เพิ่ม 0.1 วินาที" style={nudgeBtnStyle}>+</button>
    </div>
  );
}

const nudgeBtnStyle: React.CSSProperties = {
  width: 46, height: 44, border: "none", background: "rgba(255,255,255,.05)",
  color: color.text, fontSize: 20, cursor: "pointer", fontFamily: font.heading, flex: "none",
};

const snapBtnStyle: React.CSSProperties = {
  width: "100%", marginTop: 10, minHeight: 42, borderRadius: 11,
  border: "1px dashed rgba(167,139,250,.45)", background: "rgba(139,92,246,.06)",
  color: color.primary300, fontSize: 12.5, cursor: "pointer", fontFamily: font.body,
};

const mobileEditorActionStyle: React.CSSProperties = {
  minHeight: 44,
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  padding: "7px 9px",
  borderRadius: radius.control,
  border: `1px solid ${color.cardBorder}`,
  background: "rgba(255,255,255,.045)",
  color: color.textSecondary,
  font: `500 12.5px ${font.body}`,
  cursor: "pointer",
};
