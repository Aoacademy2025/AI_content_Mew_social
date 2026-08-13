"use client";

/**
 * สเต็ป 2 — องค์ประกอบ (จอ 4a): 4 กลุ่ม (บีโรล/เสียง/เพลง/อวตาร) + rail สรุป + CTA เรนเดอร์
 * ทุกกลุ่มมี "ตั้งค่าขั้นสูง" (นโยบาย: ฟีเจอร์เดิมย้ายมาซ่อนตรงนี้ ไม่ตัดทิ้ง — เนื้อจริงมากับ P4/P6)
 * ปุ่มเรนเดอร์จริง = P4 (VideoJob preview mode) — ตอนนี้เป็น stub แจ้งชัด
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Shuffle, Film, ImagePlus, Sparkles, ChevronDown, User, UserX, Music2,
  Play, Pause,
} from "lucide-react";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import {
  BROLL_REGION_OPTIONS,
  BROLL_STYLE_OPTIONS,
  type BrollRegionPreference,
  type BrollVisualStyle,
} from "@/lib/broll-preferences";
import { KIE_IMAGE_MODEL_OPTIONS, PRICED_KIE_MODEL_OPTIONS, AUTO_MIX_PROVIDER_OPTIONS } from "../_components/types";
import { color, font, radius } from "./tokens";
import { BtnPrimary, Card, IconTile, Segmented, GroupLabel } from "./ui";
import { VoicePreviewButton } from "../_components/VoicePreviewButton";
import { HERO_VOICE_COMING_SOON, HERO_VOICE_NAME, HERO_VOICE_TEASER_VISIBLE } from "@/lib/hero-voice-brand";
import { OMNIVOICE_UI_ENABLED } from "@/lib/tts-providers";
import {
  estimateClipSecV2,
  estimateAutoMixAiImageCount,
  disclosedAutoMixAiImageCount,
  heroDefaultTargetClipCount,
  heroHoldLengthSec,
} from "./estimate";
import { minutesFromSeconds } from "@/lib/minute-round";
import { useBgm } from "../_hooks/useBgm";
import { useHeygenAvatars } from "../_hooks/useHeygenAvatars";
import { MusicLibraryModal } from "./MusicLibraryModal";
import { AvatarPickerModal } from "./AvatarPickerModal";
import type { V2Project, V2BrollSource, V2VoiceEngine } from "./useV2Project";
import { PRESET_WEIGHTS, type MixPreset } from "./mix-presets";
import { HeroVoicePicker } from "./HeroVoicePicker";
import { HERO_AI_IMAGE_CREDITS } from "@/lib/credit-costs";
import { BrandVisualSelector, type BrandVisualPreflightStatus } from "./BrandVisualSelector";
import { trackEvent } from "@/lib/client-telemetry";

/** Hero AI Image locked-state copy (Task 5 D8) — one string pair for every locked
 *  surface (customer cards, AutoMix preset picker) so eligibility copy never drifts. */
const HERO_UPGRADE_BADGE = "อัปเกรด";
const HERO_UPGRADE_TITLE = "Hero AI Image ใช้ได้กับแผน PRO/BUSINESS";

// AutoMix intensity (D5.1) — shown after an eligible customer selects AutoMix.
// `sub` is the price-free base copy; MixPresetButtons appends the live
// `~{total} เครดิต/คลิป` line (Task 5 item 4) computed from HERO_AI_IMAGE_CREDITS —
// no credit numbers are hardcoded here.
const MIX_PRESETS: { key: MixPreset; label: string; sub: string; badge?: string }[] = [
  { key: "free", label: "ฟรีล้วน", sub: "สต็อกฟรีทั้งหมด · 0 เครดิต" },
  { key: "recommended", label: "AutoMix แนะนำ", sub: "สต็อก + ภาพ AI แทรก", badge: "แนะนำ" },
  { key: "full", label: "AutoMix · AI เด่น", sub: "วิดีโอสต็อก + ภาพสต็อก + AI สัดส่วนสูง" },
];
const MIX_PRESET_LABEL: Record<MixPreset, string> = {
  free: "ฟรีล้วน", recommended: "AutoMix แนะนำ", full: "AI เด่น",
};

// ลำดับตามความสำคัญจริง: สต็อกฟรีเสมอ แต่ไม่ติดป้าย "แนะนำ" แบบ global;
// สำหรับลูกค้าที่จ่ายเงิน AutoMix เป็นคำแนะนำตาม product default.
const BROLL_OPTIONS: { value: V2BrollSource; title: string; desc: string; icon: React.ReactNode; badge?: string; beta?: boolean; comingSoon?: boolean }[] = [
  { value: "stock", title: "วิดีโอสต็อก", desc: "Pexels · Pixabay", icon: <Film size={16} strokeWidth={1.6} />, badge: "ฟรี" },
  { value: "kie-image", title: "Hero AI Image", desc: "ภาพ AI ทุกช่วง · ไม่ใช้สต็อก", icon: <ImagePlus size={16} strokeWidth={1.6} />, beta: true },
  { value: "kie-video", title: "วิดีโอ AI", desc: "เร็ว ๆ นี้", icon: <Sparkles size={16} strokeWidth={1.6} />, beta: true, comingSoon: true },
  { value: "automix", title: "AutoMix", desc: "วิดีโอสต็อก + ภาพสต็อก + AI", icon: <Shuffle size={16} strokeWidth={1.6} />, beta: true },
];

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function starterRemaining(p: V2Project): number | null {
  return p.starterAiImageAllowance?.eligible
    ? p.starterAiImageAllowance.remainingImages
    : null;
}

function heroDefaultImageCount(p: V2Project): number {
  return heroDefaultTargetClipCount(0, starterRemaining(p));
}

function imageFundingLine(p: V2Project, requested: number, approximate = false): string {
  const remaining = starterRemaining(p);
  if (remaining === null) {
    return `${approximate ? "~" : ""}${requested} รูป × ${HERO_AI_IMAGE_CREDITS} เครดิต = ${approximate ? "~" : ""}${requested * HERO_AI_IMAGE_CREDITS} เครดิต`;
  }
  const admitted = Math.min(requested, remaining);
  const density = admitted < requested ? ` · ลดความถี่จากแผน ${requested} รูป` : "";
  return `${approximate ? "~" : ""}${admitted} ภาพจากสิทธิ์ทดลอง · เหลือ ${remaining}/${p.starterAiImageAllowance?.limitImages ?? 8}${density}`;
}

export function Step2Elements({ p, onRender }: { p: V2Project; onRender: () => Promise<void> }) {
  const stepTwoContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = stepTwoContentRef.current;
    if (!content) return;

    // Brand access and the library load asynchronously. Without this reset and
    // `overflow-anchor: none` below, Chromium preserves the B-roll card as its
    // scroll anchor when BrandVisualSelector is inserted above it. The selector
    // then exists and completes its preflight, but is silently pushed just above
    // the viewport on every reload. Keep Step 2 at its actual beginning instead.
    content.scrollTop = 0;
    const frame = window.requestAnimationFrame(() => {
      content.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const bgm = useBgm();
  const scriptEstSec = useMemo(() => estimateClipSecV2(p.script), [p.script]);
  const hasUploadDuration = p.mode === "upload" && p.clipDurationSec > 0;
  const displaySec = hasUploadDuration ? p.clipDurationSec : scriptEstSec;
  const displayMin = displaySec > 0 ? minutesFromSeconds(displaySec) : 0;
  // Hero AI Image: fresh selection defaults to 8 images and clamps to the
  // remaining Starter AI Image Allowance for never-paid accounts, plus the
  // "อัตโนมัติ" projected count — the SAME window-based estimate buildReceipt uses (an
  // all-AI preset over the same estimated duration), so this screen's numbers never
  // drift from what the Render Receipt discloses right before render.
  const heroDefaultN = heroDefaultImageCount(p);
  const heroAutoProjectedCount = useMemo(
    () => estimateAutoMixAiImageCount(displaySec, { video: 0, photo: 0, ai: 1 }),
    [displaySec],
  );
  const heroHoldSec = useMemo(
    () => heroHoldLengthSec(displaySec, p.targetClipCount),
    [displaySec, p.targetClipCount],
  );
  const brollCountLabel = p.brollSource === "kie-image"
    ? "จำนวนภาพ AI:"
    : p.brollSource === "automix"
      ? "จำนวน B-roll รวม:"
      : "จำนวนคลิปบีโรล:";
  const customerBrollLabel = p.brollSource === "kie-image"
    ? "Hero AI Image"
    : p.brollSource === "automix"
      ? `AutoMix · ${MIX_PRESET_LABEL[p.mixPreset]}`
      : "สต็อกฟรี";
  const geminiVoice = GEMINI_VOICES.find(v => v.id === p.geminiVoiceName) ?? GEMINI_VOICES[0];
  // ชื่อเสียง ElevenLabs ที่ตรงกับ voiceId ปัจจุบัน (โชว์ชื่อแทน ID เมื่อ resolve ได้)
  const elevenVoice = p.voiceEngine === "elevenlabs"
    ? p.elevenVoices?.find(v => v.voice_id === p.voiceId.trim())
    : undefined;
  const omniVoice = p.voiceEngine === "omnivoice"
    ? p.omniVoices?.find(v => v.voice_id === p.omniVoiceId)
    : undefined;
  const heroVoiceVisible = HERO_VOICE_TEASER_VISIBLE || OMNIVOICE_UI_ENABLED || p.voiceEngine === "omnivoice";
  const [submitting, setSubmitting] = useState(false);
  const [brandPreflightStatus, setBrandPreflightStatus] = useState<BrandVisualPreflightStatus>("idle");
  const requiresBrandPreflight = (p.brandVisualAllowed || p.hasPersistedVisualPin)
    && p.mode !== "upload"
    && (
      p.brollSource === "kie-image"
      || (p.brollSource === "automix" && p.mixPreset !== "free")
    );
  const brandPreflightBlocked = requiresBrandPreflight && brandPreflightStatus !== "ready";
  const [savingDefault, setSavingDefault] = useState<"voice" | "avatar" | null>(null);
  const [musicLibOpen, setMusicLibOpen] = useState(false);
  const avatarLib = useHeygenAvatars();
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const step2TelemetryKeyRef = useRef("");
  useEffect(() => {
    const measurableCohort = p.brandVisualCohort === "control"
      || p.brandVisualCohort === "treatment-10"
      || p.brandVisualCohort === "treatment-50"
      || p.brandVisualCohort === "treatment-100";
    if (!p.projectReady || !p.projectId || !measurableCohort) return;
    const key = `${p.projectId}:${p.brandVisualCohort}`;
    if (step2TelemetryKeyRef.current === key) return;
    step2TelemetryKeyRef.current = key;
    trackEvent("editor_step2_reached", {
      step: "editor.step2",
      status: "viewed",
      properties: {
        projectId: p.projectId,
        cohort: p.brandVisualCohort,
        bucket: p.brandVisualRolloutBucket,
      },
    });
  }, [p.brandVisualCohort, p.brandVisualRolloutBucket, p.projectId, p.projectReady]);
  const openAvatarPicker = () => { setAvatarPickerOpen(true); avatarLib.load(); };
  // Prime the avatar list as soon as avatar mode is on, so it's ready by the time the user
  // opens the picker. load() is idempotent (no-op once loaded/loading) → never double-fetches.
  useEffect(() => { if (p.useAvatar) avatarLib.load(); }, [p.useAvatar]); // eslint-disable-line react-hooks/exhaustive-deps
  // chips = 6 เพลงแรกของระบบ · ถ้าเพลงที่เลือกไม่อยู่ในนั้น (ระบบตัวท้าย ๆ / ของผู้ใช้) เอามาโชว์หน้าสุด
  const baseChips = bgm.systemTracks.slice(0, 6).map((t) => ({ ...t, kind: "system" as const }));
  const selectedTrack = p.musicTrack
    ? (p.musicTrackKind === "user"
        ? bgm.userTracks.find((t) => t.filename === p.musicTrack)
        : bgm.systemTracks.find((t) => t.filename === p.musicTrack))
    : null;
  const selectedInChips = p.musicTrackKind === "system" && baseChips.some((t) => t.filename === p.musicTrack);
  const chipTracks = selectedTrack && !selectedInChips
    ? [{ id: selectedTrack.id, title: selectedTrack.title, filename: selectedTrack.filename, kind: p.musicTrackKind }, ...baseChips.slice(0, 5)]
    : baseChips;

  async function handleRender() {
    if (submitting || brandPreflightBlocked) return;
    setSubmitting(true);
    try { await onRender(); } finally { setSubmitting(false); }
  }

  async function saveVoiceDefault() {
    if (!p.voiceId.trim() || savingDefault) return;
    setSavingDefault("voice");
    try {
      await p.saveAccountVideoDefaults({
        elevenlabsVoiceId: p.voiceId,
        ttsProvider: p.voiceEngine,
        geminiVoiceName: p.geminiVoiceName,
      });
      toast.success("บันทึกเสียงเริ่มต้นแล้ว — โปรเจกต์ใหม่จะใช้เสียงนี้");
    } catch {
      toast.error("บันทึกเสียงเริ่มต้นไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      setSavingDefault(null);
    }
  }

  async function saveAvatarDefault() {
    if (!p.avatarId.trim() || savingDefault) return;
    setSavingDefault("avatar");
    try {
      await p.saveAccountVideoDefaults({ heygenAvatarId: p.avatarId });
      toast.success("บันทึกอวตารเริ่มต้นแล้ว — โปรเจกต์ใหม่จะใช้อวตารนี้");
    } catch {
      toast.error("บันทึกอวตารเริ่มต้นไม่สำเร็จ กรุณาลองอีกครั้ง");
    } finally {
      setSavingDefault(null);
    }
  }

  // CTA เดียว — ใช้ทั้งใน rail (desktop) และ sticky footer (mobile), ไม่ให้ logic แยกกัน
  const primaryCta = (
    <BtnPrimary
      className="w-full"
      onClick={() => void handleRender()}
      disabled={submitting || brandPreflightBlocked}
      style={submitting || brandPreflightBlocked ? { opacity: 0.6, cursor: submitting ? "wait" : "not-allowed" } : undefined}
    >
      {submitting
        ? "กำลังส่งงาน…"
        : brandPreflightBlocked
          ? brandPreflightStatus === "error" ? "รอวิเคราะห์แนวภาพ" : "กำลังวิเคราะห์แนวภาพ…"
          : "เรนเดอร์วิดีโอ"}
    </BtnPrimary>
  );

  return (
    <>
    <div className="flex min-h-0 flex-1 max-lg:flex-col max-lg:overflow-y-auto">
      {/* ── เนื้อหาซ้าย: 4 กลุ่ม ── */}
      <div
        ref={stepTwoContentRef}
        className="flex min-w-0 flex-1 flex-col gap-6 lg:overflow-y-auto max-lg:overflow-visible px-7 py-6"
        style={{ overflowAnchor: "none" }}
      >
        {/* ย้อนกลับ = คลิก step pill บน topbar (ตัดปุ่มเล็กซ้ำซ้อนออก 07-03) */}

        <BrandVisualSelector p={p} onPreflightStatusChange={setBrandPreflightStatus} />

        {/* 1 · บีโรล */}
        <Group title="บีโรล" desc="ภาพประกอบที่สลับทุก 3–5 วิ ระหว่างเสียงพูด">
          {/* Customers see the product choices by their public names. Internal admins keep
              the raw beta controls (including the unreleased AI-video source). */}
          {p.isAdmin ? (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {BROLL_OPTIONS.map((o) => {
              // Beta = admin เสมอ · paid (managed-kie) ปลดล็อกภาพ AI/AutoMix · วิดีโอ AI (comingSoon) ยังไม่เปิดให้ใคร
              const locked = o.comingSoon || (o.beta && !p.isAdmin && !p.isPaidManagedKie);
              // Admin card parity (Task 5 item 5): same total-price info as the customer
              // card, using the same fresh-selection default (8 รูป) the click below applies.
              const desc = o.value === "kie-image"
                ? `${o.desc} · ${imageFundingLine(p, heroDefaultN)}`
                : o.desc;
              return (
                <button
                  key={o.value}
                  disabled={locked}
                  onClick={() => {
                    if (locked) return;
                    p.setBrollSource(o.value);
                    // The funding-aware default only applies while the user hasn't touched the count
                    // control themselves — otherwise re-selecting Hero AI Image after
                    // switching away would clobber an explicit "อัตโนมัติ" (0) choice.
                    if (o.value === "kie-image" && !p.heroCountTouched) {
                      p.setTargetClipCount(heroDefaultTargetClipCount(p.targetClipCount, starterRemaining(p)));
                    }
                  }}
                  className="relative flex flex-col items-start gap-2 text-left"
                  style={{
                    borderRadius: radius.card, padding: "12px 14px",
                    background: p.brollSource === o.value ? color.selectedBg : color.cardBg,
                    border: `1px solid ${p.brollSource === o.value ? color.selectedBorder : color.cardBorder}`,
                    cursor: locked ? "not-allowed" : "pointer",
                    opacity: locked ? 0.55 : 1,
                    transition: "all 150ms ease",
                  }}
                >
                  {o.badge && (
                    <span className="absolute right-2.5 top-2" style={{ fontSize: 10, color: color.primary300, fontWeight: 500 }}>{o.badge}</span>
                  )}
                  {o.beta && (
                    <span className="absolute right-2.5 top-2 rounded-full px-1.5" style={{ fontSize: 9.5, color: color.warning, border: `1px solid rgba(251,191,36,.35)` }}>Beta</span>
                  )}
                  <IconTile size={32}>{o.icon}</IconTile>
                  <span className="flex flex-col">
                    <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{o.title}</span>
                    <span style={{ fontSize: 10.5, color: color.textFaint }}>{desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
          ) : (
            <CustomerBrollSourceButtons p={p} durationSec={displaySec} />
          )}
          <Advanced note="สลับคลิป/แก้จังหวะรายช่วง (มากับ timeline)">
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2" style={{ fontSize: 11.5, color: color.textSecondary }}>
                {brollCountLabel}
                <Segmented
                  value={p.targetClipCount > 0 ? "custom" : "auto"}
                  onChange={(v) => {
                    // Any direct interaction with this control is an explicit user choice
                    // (including picking "อัตโนมัติ") — stop the Hero default-8 from ever
                    // overriding it again this session (fast-follow fix, see p.heroCountTouched).
                    p.setHeroCountTouched(true);
                    p.setTargetClipCount(v === "auto" ? 0 : Math.max(1, p.targetClipCount || heroDefaultN));
                  }}
                  options={p.brollSource === "kie-image"
                    ? [
                        { value: "auto", label: `อัตโนมัติ (1 รูป/ช่วง ≈ ${heroAutoProjectedCount} รูป)` },
                        { value: "custom", label: "กำหนดจำนวนรูป (แนะนำ)" },
                      ]
                    : [{ value: "auto", label: "Auto" }, { value: "custom", label: "กำหนดเอง" }]}
                />
                {p.targetClipCount > 0 && (
                  <input
                    type="number" min={1} max={60} value={p.targetClipCount}
                    onChange={(e) => {
                      p.setHeroCountTouched(true);
                      p.setTargetClipCount(Math.max(1, Math.min(60, Number(e.target.value) || 1)));
                    }}
                    className="w-[64px]"
                    style={{ padding: "6px 8px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }}
                  />
                )}
              </label>
              {p.targetClipCount > 0 && (
                <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.6 }}>
                  {p.brollSource === "kie-image"
                    // Total-price disclosure (Task 5 item 3) — every hero count/price hint
                    // shows the TOTAL (n × HERO_AI_IMAGE_CREDITS), never a bare count.
                    ? `${imageFundingLine(p, p.targetClipCount)} · ไม่ใช้วิดีโอหรือภาพสต็อก`
                    : p.brollSource === "automix"
                      ? `สร้าง B-roll รวม ${p.targetClipCount} ชิ้น โดยผสมวิดีโอสต็อก ภาพสต็อก และภาพ AI`
                      : `ใช้ B-roll สต็อกรวม ${p.targetClipCount} ชิ้น`}
                </span>
              )}
              {p.targetClipCount > 0 && p.brollSource === "kie-image" && (
                <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.6 }}>
                  {/* Hold-length hint (Task 5 item 6) — warn when few images must cover a
                      long clip, so a budget-safe default doesn't quietly look static. */}
                  รูปละ ~{heroHoldSec} วิ{heroHoldSec > 12 ? " (ภาพค้างนาน — เพิ่มจำนวนรูปช่วยให้คลิปดูมีชีวิตขึ้น)" : ""}
                </span>
              )}
              {p.targetClipCount === 0 && p.brollSource === "kie-image" && (
                <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.6 }}>
                  {imageFundingLine(p, heroAutoProjectedCount, true)}
                </span>
              )}
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 11, color: color.textFaint }}>แนวภาพ / โซนภาพ</span>
                <Segmented
                  value={p.brollRegionPreference}
                  onChange={(v) => p.setBrollRegionPreference(v as BrollRegionPreference)}
                  options={BROLL_REGION_OPTIONS}
                  style={{ display: "flex", flexWrap: "wrap", width: "fit-content", maxWidth: "100%" }}
                />
              </label>
              {p.brollSource === "kie-image" ? (
                <div className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>สไตล์ภาพ Hero AI</span>
                  <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.6 }}>
                    ใช้แนวภาพที่เลือกใน “แบรนด์และแนวภาพของคลิปนี้” ด้านบน
                  </span>
                </div>
              ) : (
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>
                    {p.brollSource === "automix" ? "สไตล์วิดีโอ / ภาพสต็อก" : "สไตล์ภาพสต็อก"}
                  </span>
                  <Segmented
                    value={p.brollVisualStyle}
                    onChange={(v) => p.setBrollVisualStyle(v as BrollVisualStyle)}
                    options={BROLL_STYLE_OPTIONS}
                    style={{ display: "flex", flexWrap: "wrap", width: "fit-content", maxWidth: "100%" }}
                  />
                </label>
              )}
              {p.heroAiImageEligible && p.brollSource === "kie-image" && (
                <div className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>โมเดล Hero AI Image</span>
                  <div
                    className="w-full max-w-[320px] rounded-md px-3 py-2"
                    style={{ fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }}
                  >
                    {/* Total-price disclosure (item 3) — same n × HERO_AI_IMAGE_CREDITS total
                        as the hint above, so this box never shows a bare per-image price. */}
                    ภาพ AI คุณภาพสูง · {imageFundingLine(p, p.targetClipCount > 0 ? p.targetClipCount : heroAutoProjectedCount)}
                  </div>
                </div>
              )}
              {(p.isAdmin || p.isPaidManagedKie) && p.brollSource === "automix" && (
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>
                    {p.isAdmin ? "โมเดลภาพ AI (Beta)" : "โมเดลภาพ AI (คิดเครดิตต่อภาพ)"}
                  </span>
                  <select
                    // Paid users have no "system default" ("") option, so surface the
                    // priced default (gpt-image-2) when unset — matches the server's coercion.
                    value={p.isAdmin ? p.kieModel : (p.kieModel || "gpt-image-2-text-to-image")}
                    onChange={(e) => p.setKieModel(e.target.value as typeof p.kieModel)}
                    className="w-full max-w-[280px]"
                    style={{ padding: "8px 10px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }}
                  >
                    {/* Admins get the "system default" escape hatch + all 8 models;
                        paid users get only the 3 priced models (server coerces anything else). */}
                    {p.isAdmin && <option value="" style={{ background: color.bg1 }}>ค่าเริ่มต้นของระบบ</option>}
                    {(p.isAdmin ? KIE_IMAGE_MODEL_OPTIONS : PRICED_KIE_MODEL_OPTIONS).map((m) => (
                      <option key={m.value} value={m.value} style={{ background: color.bg1 }}>{m.label}</option>
                    ))}
                  </select>
                </label>
              )}
              {p.isAdmin && p.brollSource === "automix" && (
                <div className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>แหล่งภาพ Auto Mix (Beta)</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {AUTO_MIX_PROVIDER_OPTIONS.map((o) => (
                      <label key={o.value} className="flex cursor-pointer items-center gap-1.5" style={{ fontSize: 11, color: color.textSecondary }}>
                        <input
                          type="checkbox"
                          checked={p.autoMixProviders.includes(o.value)}
                          onChange={(e) => p.setAutoMixProviders(
                            e.target.checked
                              ? [...p.autoMixProviders, o.value]
                              : p.autoMixProviders.filter((x) => x !== o.value),
                          )}
                          style={{ accentColor: color.primary500 }}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Advanced>
        </Group>

        {/* โหมดอัปคลิปเอง: เสียงพูดมาจากคลิป แต่ยังเลือกเพลงประกอบได้ */}
        {p.mode === "upload" && (
          <div className="px-3 py-2.5" style={{ borderRadius: radius.card, border: `1px dashed rgba(255,255,255,.14)`, fontSize: 11.5, color: color.textFaint, lineHeight: 1.7 }}>
            โหมดใช้คลิปของคุณ: เสียงพูดมาจากคลิปโดยตรง — เลือกเพลงประกอบด้านล่างได้ ระบบจะข้ามเฉพาะเสียงพากย์และอวตาร
          </div>
        )}

        {/* 2 · เสียงพากย์ */}
        {p.mode !== "upload" && (
        <Group title="เสียงพากย์" desc="เสียง AI อ่านสคริปต์ของคุณ">
          <Segmented<V2VoiceEngine>
            value={p.voiceEngine}
            onChange={p.setVoiceEngine}
            ariaLabel="ผู้ให้บริการเสียงพากย์"
            optionPadding="6px clamp(7px, 2vw, 14px)"
            style={{ display: "grid", gridTemplateColumns: `repeat(${heroVoiceVisible ? 3 : 2},minmax(0,1fr))`, width: "100%" }}
            options={[
              ...(heroVoiceVisible ? [{
                value: "omnivoice" as const,
                label: HERO_VOICE_NAME,
                badge: p.omniVoiceEnabled ? "แนะนำ · 48 เสียง" : HERO_VOICE_COMING_SOON,
                disabled: !p.omniVoiceEnabled,
                featured: p.omniVoiceEnabled,
                title: p.omniVoiceEnabled ? "เสียงเฉพาะของ Hero AI จำนวน 48 เสียง" : `${HERO_VOICE_NAME} ${HERO_VOICE_COMING_SOON}`,
              }] : []),
              { value: "gemini" as const, label: "Gemini" },
              { value: "elevenlabs" as const, label: "ElevenLabs" },
            ]}
          />
          <Card
            selected
            className={p.voiceEngine === "omnivoice"
              ? "grid grid-cols-[34px_minmax(0,1fr)] items-center gap-3"
              : "grid grid-cols-[34px_minmax(0,1fr)_132px] items-center gap-3 max-[360px]:grid-cols-[34px_minmax(0,1fr)]"}
          >
            <span
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full"
              style={{ background: "linear-gradient(135deg,#F472B6,#8B5CF6)", color: "#fff" }}
            >
              <Music2 size={15} strokeWidth={1.8} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate" style={{ font: `500 13px ${font.heading}` }}>
                {p.voiceEngine === "gemini"
                  ? geminiVoice.label
                  : p.voiceEngine === "omnivoice"
                    ? (omniVoice?.desc || `เสียง ${HERO_VOICE_NAME}`)
                    : (elevenVoice?.name || "เสียงโคลนของฉัน")}
              </span>
              <span className="truncate" style={{ fontSize: 11, color: color.textSecondary }}>
                {p.voiceEngine === "gemini"
                  ? `${geminiVoice.gender} · ${geminiVoice.style}`
                  : p.voiceEngine === "omnivoice"
                    ? (p.omniVoiceEnabled ? "48 เสียงเฉพาะ · รองรับภาษาไทย" : `ฟีเจอร์ใหม่ ${HERO_VOICE_COMING_SOON}`)
                    : (p.voiceId ? `Voice ID: ${p.voiceId.slice(0, 12)}…` : "ยังไม่ได้ตั้ง Voice ID — ตั้งได้ที่ขั้นสูง")}
              </span>
            </span>
            {p.voiceEngine !== "omnivoice" && (
              <span className="w-[132px] shrink-0 self-center max-[360px]:col-span-2 max-[360px]:w-full">
                <VoicePreviewButton className="mt-0" provider={p.voiceEngine} geminiVoiceName={p.geminiVoiceName} voiceId={p.voiceId} omniVoiceId={p.omniVoiceId} omniPreviewUrl={omniVoice?.preview_url} />
              </span>
            )}
          </Card>
          <Advanced label="เลือกเสียงอื่น">
            {p.voiceEngine === "gemini" ? (
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 12, color: color.textSecondary }}>เลือกเสียง Gemini</span>
                <select
                  value={p.geminiVoiceName}
                  onChange={(e) => p.setGeminiVoiceName(e.target.value)}
                  className="min-h-11 w-full max-w-[280px]"
                  style={{
                    padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                    background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                    color: color.text, fontFamily: font.body,
                  }}
                >
                  {GEMINI_VOICES.map(v => (
                    <option key={v.id} value={v.id} style={{ background: color.bg1 }}>
                      {v.label} — {v.gender} · {v.style}
                    </option>
                  ))}
                </select>
              </label>
            ) : p.voiceEngine === "omnivoice" ? (
              <div className="flex flex-col gap-1.5">
                {!p.omniVoiceEnabled ? (
                  <span role="status" style={{ fontSize: 12, color: color.warning }}>
                    {HERO_VOICE_NAME} กำลังเตรียมเปิดให้ใช้งานเร็ว ๆ นี้
                  </span>
                ) : p.omniVoices === null ? (
                  <span role="status" style={{ fontSize: 12, color: color.textSecondary }}>กำลังเตรียมรายการเสียง…</span>
                ) : p.omniVoices.length === 0 ? (
                  <span className="flex items-center gap-2" role="alert" style={{ fontSize: 12, color: color.danger }}>
                    เตรียมรายการเสียงไม่สำเร็จ
                    <button type="button" onClick={p.retryOmniVoices} className="min-h-11 rounded-md px-2 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 lg:min-h-8">ลองใหม่</button>
                  </span>
                ) : (
                  <HeroVoicePicker voices={p.omniVoices} value={p.omniVoiceId} onChange={p.setOmniVoiceId} />
                )}
                <span style={{ fontSize: 11.5, color: color.textSecondary, lineHeight: 1.65 }}>
                  ฟังตัวอย่างก่อนเลือก เพื่อหาโทนเสียงที่เข้ากับคลิปของคุณ
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {p.elevenVoices && p.elevenVoices.length > 0 && (
                  <label className="flex flex-col gap-1.5">
                    <span style={{ fontSize: 12, color: color.textSecondary }}>เลือกเสียงจากบัญชี ElevenLabs ของคุณ</span>
                    <select
                      value={elevenVoice ? elevenVoice.voice_id : ""}
                      onChange={(e) => { if (e.target.value) p.setVoiceId(e.target.value); }}
                      className="min-h-11 w-full max-w-[280px]"
                      style={{
                        padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                        background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                        color: color.text, fontFamily: font.body,
                      }}
                    >
                      <option value="" style={{ background: color.bg1 }}>— เลือกจากรายชื่อ หรือวาง ID ด้านล่าง —</option>
                      {p.elevenVoices.map(v => (
                        <option key={v.voice_id} value={v.voice_id} style={{ background: color.bg1 }}>
                          {v.name}{v.category ? ` — ${v.category}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 12, color: color.textSecondary }}>ElevenLabs Voice ID</span>
                  <input
                    value={p.voiceId}
                    onChange={(e) => p.setVoiceId(e.target.value)}
                    placeholder="วาง ElevenLabs Voice ID"
                    className="min-h-11 w-full max-w-[280px]"
                    style={{
                      padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                      background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                      color: color.text, fontFamily: font.body, outline: "none",
                    }}
                  />
                  {p.voiceId.trim() !== "" && p.elevenVoices && p.elevenVoices.length > 0 && !elevenVoice && (
                    <span style={{ fontSize: 10.5, color: color.textFaint }}>
                      ID นี้ไม่อยู่ในรายชื่อเสียงของบัญชีคุณ — ถ้าเป็นเสียง public/shared ก็ยังใช้เรนเดอร์ได้
                    </span>
                  )}
                </label>
                <button
                  type="button"
                  onClick={() => void saveVoiceDefault()}
                  disabled={!p.voiceId.trim() || savingDefault !== null}
                  className="min-h-11 self-start rounded-lg px-3 text-[11.5px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    color: color.primary300,
                    background: color.selectedBg,
                    border: `1px solid ${color.selectedBorder}`,
                  }}
                >
                  {savingDefault === "voice" ? "กำลังบันทึก…" : "บันทึกเสียงนี้เป็นค่าเริ่มต้น"}
                </button>
              </div>
            )}
          </Advanced>
        </Group>
        )}

        {/* 3 · เพลงประกอบ */}
        <Group title="เพลงประกอบ" desc="เพลงเบา ๆ ใต้เสียงพูด (ลดเสียงอัตโนมัติ) · กดไอคอนเพื่อฟังตัวอย่าง">
          <MusicChips p={p} tracks={chipTracks} />
          <button
            onClick={() => setMusicLibOpen(true)}
            className="self-start"
            style={{ fontSize: 11.5, color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            คลังเพลงทั้งหมด ({bgm.systemTracks.length + bgm.userTracks.length}) · {p.canUploadOwnMedia ? "อัปโหลดเพลงของคุณ" : "เพลงของฉัน (Pro)"}
          </button>
          <MusicLibraryModal
            open={musicLibOpen}
            onClose={() => setMusicLibOpen(false)}
            systemTracks={bgm.systemTracks}
            userTracks={bgm.userTracks}
            canUpload={p.canUploadOwnMedia}
            onUploaded={(t) => bgm.setUserTracks([t, ...bgm.userTracks])}
            selected={p.musicTrack}
            selectedKind={p.musicTrackKind}
            onSelect={(filename, kind) => { p.setMusicTrack(filename); p.setMusicTrackKind(kind); }}
          />
          <Advanced>
            <label className="flex flex-col gap-2">
              <span style={{ fontSize: 11, color: color.textFaint }}>ระดับเสียงเพลง</span>
              <div className="flex items-center gap-2.5">
                <input
                  type="range" min={0} max={1} step={0.01} value={p.bgmVolume}
                  disabled={!p.musicTrack}
                  onChange={(e) => p.setBgmVolume(Number(e.target.value))}
                  className="min-w-0 flex-1"
                  style={{ accentColor: color.primary500, cursor: p.musicTrack ? "pointer" : "not-allowed", opacity: p.musicTrack ? 1 : 0.5 }}
                />
                <span style={{ fontSize: 11.5, color: color.textSecondary, fontVariantNumeric: "tabular-nums", width: 34, textAlign: "right" }}>
                  {Math.round(p.bgmVolume * 100)}%
                </span>
              </div>
              <span style={{ fontSize: 10.5, color: color.textFaintest, lineHeight: 1.6 }}>
                {p.musicTrack
                  ? "ระดับเสียงเพลงเทียบกับเสียงพูด · ค่าเริ่มต้น 12%"
                  : "เลือกเพลงก่อนถึงจะปรับระดับเสียงได้"}
              </span>
            </label>
          </Advanced>
        </Group>

        {/* 4 · อวตารพิธีกร */}
        {p.mode !== "upload" && (
        <Group title="อวตารพิธีกร" desc="พิธีกร AI อ่านสคริปต์ให้ (คิดค่า HeyGen ตามวินาที)">
          <Segmented
            value={p.useAvatar ? "avatar" : "faceless"}
            onChange={(v) => p.setUseAvatar(v === "avatar")}
            options={[{ value: "avatar", label: "มีอวตาร" }, { value: "faceless", label: "Faceless" }]}
          />
          {p.useAvatar && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-[66px] w-[50px] items-center justify-center overflow-hidden"
                  style={{
                    borderRadius: 10,
                    outline: `1.5px solid ${color.primary500}`, outlineOffset: 2,
                    background: "#1C1C2B",
                  }}
                >
                  {p.avatarInfo?.previewUrl
                    ? // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.avatarInfo.previewUrl} alt="avatar" className="h-full w-full object-cover" />
                    : <User size={20} strokeWidth={1.5} color={color.textFaint} />}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span style={{ font: `500 12.5px ${font.heading}`, color: color.primary300 }}>
                    {p.avatarInfo?.name || (p.avatarId ? p.avatarId : "ยังไม่ได้ตั้งอวตาร")}
                  </span>
                  <span style={{ fontSize: 10.5, color: color.textFaint }}>
                    {p.avatarId ? "อวตารที่เลือกไว้" : "เลือกจากคลัง หรือวาง Avatar ID"}
                  </span>
                </div>
                <button
                  onClick={openAvatarPicker}
                  className="shrink-0"
                  style={{
                    fontSize: 12, color: color.primary300, cursor: "pointer",
                    padding: "8px 14px", borderRadius: radius.control,
                    background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
                  }}
                >
                  เลือกจากคลัง
                </button>
              </div>
              <label className="flex flex-col gap-1.5">
                <span style={{ fontSize: 11, color: color.textFaint }}>หรือวาง Avatar ID เอง</span>
                <input
                  value={p.avatarId}
                  onChange={(e) => p.setAvatarId(e.target.value)}
                  placeholder="วาง HeyGen Avatar ID"
                  className="w-full max-w-[280px]"
                  style={{
                    padding: "9px 12px", borderRadius: radius.control, fontSize: 12.5,
                    background: "rgba(255,255,255,.05)", border: `1px solid rgba(255,255,255,.10)`,
                    color: color.text, fontFamily: font.body, outline: "none",
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => void saveAvatarDefault()}
                disabled={!p.avatarId.trim() || savingDefault !== null}
                className="min-h-11 self-start rounded-lg px-3 text-[11.5px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  color: color.primary300,
                  background: color.selectedBg,
                  border: `1px solid ${color.selectedBorder}`,
                }}
              >
                {savingDefault === "avatar" ? "กำลังบันทึก…" : "บันทึกอวตารนี้เป็นค่าเริ่มต้น"}
              </button>
            </div>
          )}
          {!p.useAvatar && (
            <div className="flex items-center gap-2" style={{ fontSize: 11.5, color: color.textFaint }}>
              <UserX size={14} strokeWidth={1.6} /> วิดีโอเสียง + บีโรล ไม่มีพิธีกร
            </div>
          )}
          <Advanced>
            {p.useAvatar && (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span style={{ fontSize: 11, color: color.textFaint }}>โหมดพิธีกร (HeyGen คิดเงินตามวินาทีที่เจน)</span>
                  <Segmented
                    value={p.avatarMode}
                    onChange={p.setAvatarMode}
                    options={[
                      { value: "bookend", label: "เปิดคลิป" },
                      { value: "bookend-both", label: "เปิด+ปิด" },
                      { value: "full", label: "ทั้งคลิป" },
                    ]}
                  />
                </label>
                {p.avatarMode !== "full" && (
                  <div className="flex items-center gap-3" style={{ fontSize: 11.5, color: color.textSecondary }}>
                    <label className="flex items-center gap-1.5">
                      เปิด
                      <input type="number" min={1} max={30} value={p.avatarIntroSecs}
                        onChange={(e) => p.setAvatarIntroSecs(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
                        className="w-[52px]" style={{ padding: "5px 7px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }} />
                      วิ
                    </label>
                    {p.avatarMode === "bookend-both" && (
                      <label className="flex items-center gap-1.5">
                        ปิด
                        <input type="number" min={1} max={30} value={p.avatarTailSecs}
                          onChange={(e) => p.setAvatarTailSecs(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
                          className="w-[52px]" style={{ padding: "5px 7px", borderRadius: radius.control, fontSize: 12, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text }} />
                        วิ
                      </label>
                    )}
                  </div>
                )}
                <span style={{ fontSize: 10.5, color: color.textFaintest, lineHeight: 1.6 }}>
                  ปรับตำแหน่ง/ขนาดอวตารได้ฟรีหลังเรนเดอร์ (ในจอแต่งซับ)
                </span>
              </div>
            )}
          </Advanced>
          <AvatarPickerModal
            open={avatarPickerOpen}
            onClose={() => setAvatarPickerOpen(false)}
            selectedId={p.avatarId}
            onSelect={(id) => p.setAvatarId(id)}
            avatars={avatarLib.avatars}
            loading={avatarLib.loading}
            error={avatarLib.error}
            stale={avatarLib.stale}
            onReload={avatarLib.reload}
          />
        </Group>
        )}
      </div>

      {/* ── Right rail 372px ── */}
      <aside
        className="flex flex-col gap-4 lg:overflow-y-auto max-lg:overflow-visible px-5 py-5 lg:w-[372px] lg:shrink-0 max-lg:w-full max-lg:shrink"
        style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}
      >
        {/* Preview 9:16 (196×348) — พรีวิวจริงมีแค่หลังเรนเดอร์ ซ่อนบนมือถือเพื่อประหยัดที่ */}
        <div className="flex justify-center max-lg:hidden">
          <div
            className="flex h-[348px] w-[196px] flex-col items-center justify-center gap-2"
            style={{ borderRadius: 16, background: "#0A0A12", border: `1px solid ${color.cardBorder}` }}
          >
            <Film size={22} strokeWidth={1.4} color={color.textFaintest} />
            <span style={{ fontSize: 10.5, color: color.textFaintest, textAlign: "center", lineHeight: 1.6 }}>
              พรีวิวจะแสดงหลังเรนเดอร์<br />(9:16)
            </span>
          </div>
        </div>

        {p.mode === "script" && (
          <div
            aria-label="ลำดับการสร้างวิดีโอ"
            className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4 lg:grid-cols-2"
            style={{ borderRadius: radius.card, background: "rgba(139,92,246,.055)", border: `1px solid ${color.selectedBorder}`, padding: "12px 14px" }}
          >
            {[
              "สร้างเสียง",
              "แบ่งฉากตามเสียง",
              p.brollSource === "kie-image" ? "สร้าง Hero AI Image" : p.brollSource === "automix" ? "จัด AutoMix" : "หาบีโรล",
              "เรนเดอร์วิดีโอ",
            ].map((label, index) => (
              <span key={label} className="flex min-w-0 items-center gap-2">
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                  style={{ background: color.selectedBg, border: `1px solid ${color.selectedBorder}`, color: color.primary300, font: `600 9.5px ${font.heading}` }}
                >
                  {index + 1}
                </span>
                <span className="truncate" style={{ color: color.textSecondary, fontSize: 10.5 }}>{label}</span>
              </span>
            ))}
          </div>
        )}

        {/* สรุปการตั้งค่า */}
        <div style={{ borderRadius: radius.card, background: color.cardBg, border: `1px solid ${color.cardBorder}` }}>
          <div className="px-4 pt-3 pb-1"><GroupLabel>สรุปการตั้งค่า</GroupLabel></div>
          {p.mode === "upload" ? (
            <>
              <SummaryRow label="ที่มา" value="คลิปที่อัปโหลดเอง" />
              <SummaryRow label="ความยาว" value={hasUploadDuration ? fmtTime(p.clipDurationSec) : "กำลังอ่านความยาวคลิป"} />
              <SummaryRow label="บีโรล" value={`${p.isAdmin ? (BROLL_OPTIONS.find(o => o.value === p.brollSource)?.title ?? "-") : customerBrollLabel} · แทรก cutaway`} />
              <SummaryRow label="เสียง" value="จากคลิปของคุณ (ต่อเนื่อง)" />
              <SummaryRow label="เพลง" value={p.musicTrack === null ? "ไม่ใส่" : (selectedTrack?.title ?? "ยังไม่เลือก")} />
              <SummaryRow label="ซับไทย" value="ถอดจากเสียงอัตโนมัติ" last />
            </>
          ) : (
            <>
              <SummaryRow label="สคริปต์" value={`${p.script.split("\n").filter(l => l.trim()).length} เซ็กเมนต์ · คลิปยาว ~${fmtTime(scriptEstSec)}`} />
              <SummaryRow label="บีโรล" value={p.isAdmin ? (BROLL_OPTIONS.find(o => o.value === p.brollSource)?.title ?? "-") : customerBrollLabel} />
              <SummaryRow label="เสียง" value={p.voiceEngine === "gemini"
                ? `Gemini · ${geminiVoice.label}`
                : p.voiceEngine === "omnivoice"
                  ? `${HERO_VOICE_NAME}${omniVoice ? ` · ${omniVoice.desc}` : ""}`
                  : `ElevenLabs${elevenVoice ? ` · ${elevenVoice.name}` : ""}`} />
              <SummaryRow label="เพลง" value={p.musicTrack === null ? "ไม่ใส่" : (selectedTrack?.title ?? "ยังไม่เลือก")} />
              <SummaryRow label="อวตาร" value={p.useAvatar ? (p.avatarInfo?.name || p.avatarId || "ยังไม่ตั้ง") : "Faceless"} last />
            </>
          )}
        </div>

        {/* CTA เดียว — ปุ่มซ่อนบนมือถือ (ย้ายไป sticky footer), แต่ caption ยังโชว์เหนือ footer */}
        <div className="flex flex-col gap-2">
          <div className="max-lg:hidden">{primaryCta}</div>
          {brandPreflightBlocked && <span role="status" style={{ fontSize: 10.5, color: brandPreflightStatus === "error" ? color.dangerText : color.infoText, textAlign: "center", lineHeight: 1.6 }}>{brandPreflightStatus === "error" ? "การวิเคราะห์ฉากยังไม่พร้อม — กดลองอีกครั้งในการ์ดแนวภาพ" : "กำลังวิเคราะห์ฉากและบันทึกแนวภาพสำหรับคลิปนี้"}</span>}
          <span style={{ fontSize: 10.5, color: color.textFaint, textAlign: "center", lineHeight: 1.6 }}>
            {p.mode === "upload" && !hasUploadDuration ? "กำลังอ่านความยาวคลิป" : `คลิปยาว ${hasUploadDuration ? "" : "~"}${fmtTime(displaySec)}`}
            {p.usage?.minutes && displayMin > 0 ? ` · ใช้ ${hasUploadDuration ? "" : "~"}${displayMin} จาก ${p.usage.minutes.remaining} นาทีที่เหลือ` : ""}
            {" "}· แก้ทุกอย่างได้ทีหลัง
          </span>
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

/** Public product choices. Ordinary customers see AI Image and AutoMix but they stay
 * locked with an upgrade badge until `p.heroAiImageEligible` (Task 4's plan gate —
 * beta cohort OR HERO_AI_IMAGE_PUBLIC=1 + PRO/BUSINESS/active-trial) turns true. */
function CustomerBrollSourceButtons({ p, durationSec }: { p: V2Project; durationSec: number }) {
  const hasFunding = p.hasPersistedVisualPin || starterRemaining(p) === null || (starterRemaining(p) ?? 0) > 0;
  const hasAiRenderAccess = p.heroAiImageEligible || p.hasPersistedVisualPin;
  const heroImageUnlocked = hasAiRenderAccess && hasFunding;
  const autoMixUnlocked = hasAiRenderAccess && hasFunding;
  const heroDefaultN = heroDefaultImageCount(p);
  const options: { value: "stock" | "kie-image" | "automix"; title: string; desc: string; icon: React.ReactNode }[] = [
    { value: "stock", title: "สต็อกฟรี", desc: "0 เครดิต AI · Pexels/Pixabay", icon: <Film size={16} strokeWidth={1.6} /> },
    {
      value: "kie-image",
      title: "Hero AI Image",
      // Total-price disclosure (Task 5 item 3): the fresh-selection default (8 รูป)
      // this card applies on click, priced out — never a bare per-image number.
      desc: `ภาพ AI ล้วน · ไม่ใช้สต็อก · ${imageFundingLine(p, heroDefaultN)}`,
      icon: <ImagePlus size={16} strokeWidth={1.6} />,
    },
    { value: "automix", title: "AutoMix", desc: "วิดีโอสต็อก + ภาพสต็อก + AI", icon: <Shuffle size={16} strokeWidth={1.6} /> },
  ];

  function selectSource(value: "stock" | "kie-image" | "automix") {
    if (value === "stock") {
      p.setMixPreset("free");
      return;
    }
    if (value === "kie-image") {
      if (!heroImageUnlocked) return;
      p.setBrollSource("kie-image");
      // Hero defaults to 8 and clamps to remaining starter allowance — a fresh
      // selection lands on a concrete, budget-safe quote. Once the user has touched the count
      // control directly (incl. explicitly picking "อัตโนมัติ"), leave it alone — don't
      // clobber an explicit choice when they switch away and back (fast-follow fix).
      if (!p.heroCountTouched) {
        p.setTargetClipCount(heroDefaultTargetClipCount(p.targetClipCount, starterRemaining(p)));
      }
      return;
    }
    if (!autoMixUnlocked) return;
    p.setMixPreset(p.mixPreset === "full" ? "full" : "recommended");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {options.map((option) => {
          const locked = option.value === "kie-image"
            ? !heroImageUnlocked
            : option.value === "automix"
              ? !autoMixUnlocked
              : false;
          const selected = p.brollSource === option.value;
          const badge = option.value === "stock"
            ? "ฟรี"
            : option.value === "automix" && p.recommendedAutoMixDefault
              ? "แนะนำ"
              : locked
                ? HERO_UPGRADE_BADGE
                : "Beta";
          return (
            <button
              key={option.value}
              type="button"
              disabled={locked}
              title={locked ? HERO_UPGRADE_TITLE : undefined}
              onClick={() => selectSource(option.value)}
              className="relative flex min-h-11 flex-col items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{
                borderRadius: radius.card,
                padding: "12px 14px",
                background: selected ? color.selectedBg : color.cardBg,
                border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
                cursor: locked ? "not-allowed" : "pointer",
                opacity: locked ? 0.58 : 1,
                outlineColor: color.primary300,
                transition: "background 150ms ease, border-color 150ms ease, opacity 150ms ease",
              }}
            >
              <span
                className="absolute right-2.5 top-2 rounded-full px-1.5"
                style={{
                  fontSize: 9.5,
                  color: option.value === "stock" ? color.primary300 : color.warning,
                  border: `1px solid ${option.value === "stock" ? color.selectedBorder : "rgba(251,191,36,.35)"}`,
                }}
              >
                {badge}
              </span>
              <IconTile size={32}>{option.icon}</IconTile>
              <span className="flex flex-col pr-10">
                <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{option.title}</span>
                <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.5 }}>{option.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {p.brollSource === "stock" && (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-xl px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3"
          style={{
            background: "rgba(52,211,153,.07)",
            border: "1px solid rgba(52,211,153,.24)",
          }}
        >
          <span className="shrink-0" style={{ font: `600 11.5px ${font.heading}`, color: "#6ee7b7" }}>
            เส้นทางใช้ฟรีพร้อมแล้ว
          </span>
          <span style={{ fontSize: 11, lineHeight: 1.55, color: color.textSecondary }}>
            ต่อไปเลือกเสียงและกดเรนเดอร์ — สต็อกใช้ 0 เครดิต AI และใช้เฉพาะนาทีในแพ็กเกจ
          </span>
        </div>
      )}

      {autoMixUnlocked && p.brollSource === "automix" && (
        <div className="flex flex-col gap-2">
          <GroupLabel>สัดส่วน AutoMix</GroupLabel>
          <MixPresetButtons p={p} durationSec={durationSec} />
        </div>
      )}
    </div>
  );
}

/** AutoMix intensity (D5.1). The top-level customer source cards own Free/AI Image/
 * AutoMix selection; this nested control only chooses the two AutoMix weight profiles. */
function MixPresetButtons({ p, durationSec }: { p: V2Project; durationSec: number }) {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {MIX_PRESETS.filter((preset) => preset.key !== "free").map((pr) => {
        // Same gate as the AutoMix card itself (Task 5 item 1) — a customer who can open
        // AutoMix can pick either intensity; only ineligible users see the lock.
        const locked = !(p.heroAiImageEligible || p.hasPersistedVisualPin);
        const selected = p.mixPreset === pr.key;
        // AutoMix "AI เด่น"/"แนะนำ" preset price (Task 5 item 4) — the SAME disclosed
        // count buildReceipt uses (manual targetClipCount when set, else the window
        // estimate), so this label can never drift from the Render Receipt's number.
        const aiCount = disclosedAutoMixAiImageCount(durationSec, PRESET_WEIGHTS[pr.key], p.targetClipCount);
        const priceLine = `${pr.sub} · ${imageFundingLine(p, aiCount, true)}`;
        return (
          <button
            key={pr.key}
            disabled={locked}
            title={locked ? HERO_UPGRADE_TITLE : undefined}
            onClick={() => { if (!locked) p.setMixPreset(pr.key); }}
            className="relative flex flex-col items-start gap-1.5 text-left"
            style={{
              borderRadius: radius.card, padding: "12px 14px",
              background: selected ? color.selectedBg : color.cardBg,
              border: `1px solid ${selected ? color.selectedBorder : color.cardBorder}`,
              cursor: locked ? "not-allowed" : "pointer",
              opacity: locked ? 0.55 : 1,
              transition: "all 150ms ease",
            }}
          >
            {locked ? (
              <span className="absolute right-2.5 top-2 rounded-full px-1.5" style={{ fontSize: 9.5, color: color.warning, border: "1px solid rgba(251,191,36,.35)" }}>{HERO_UPGRADE_BADGE}</span>
            ) : pr.badge && (
              <span className="absolute right-2.5 top-2" style={{ fontSize: 10, color: color.primary300, fontWeight: 500 }}>{pr.badge}</span>
            )}
            <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{pr.label}</span>
            <span style={{ fontSize: 10.5, color: color.textFaint, lineHeight: 1.5 }}>{priceLine}</span>
          </button>
        );
      })}
    </div>
  );
}

/** ชิปเพลง + ปุ่มฟังตัวอย่างในตัว (logic เดียวกับ toggleMusicPreview ของ OrderPanel, URL = /api/music/<filename>) */
function MusicChips({ p, tracks }: { p: V2Project; tracks: { id: string; title: string; filename: string; kind: "system" | "user" }[] }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState("");

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewing("");
  }
  useEffect(() => () => stopPreview(), []);

  async function togglePreview(filename: string) {
    if (previewing === filename) { stopPreview(); return; }
    stopPreview();
    const audio = new Audio(`/api/music/${filename}`);
    audio.volume = 0.5;
    audio.preload = "auto";
    audioRef.current = audio;
    setPreviewing(filename);
    audio.onended = () => { if (audioRef.current === audio) stopPreview(); };
    audio.onerror = () => { if (audioRef.current === audio) { stopPreview(); toast.error("เล่นเพลงตัวอย่างไม่สำเร็จ"); } };
    try { await audio.play(); } catch { if (audioRef.current === audio) { stopPreview(); toast.error("เบราว์เซอร์ไม่อนุญาตให้เล่นเสียง ลองกดอีกครั้ง"); } }
  }

  const chipStyle = (selected: boolean, dashed = false): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 8,
    padding: "6px 10px 6px 14px", borderRadius: radius.pill,
    background: selected ? color.selectedBg : "rgba(255,255,255,.04)",
    border: `1px ${dashed ? "dashed" : "solid"} ${selected ? color.selectedBorder : color.cardBorder}`,
    color: selected ? color.primary300 : color.textSecondary,
    font: `${selected ? 500 : 400} 12.5px ${font.body}`,
    cursor: "pointer", transition: "all 150ms ease",
  });

  return (
    <div className="flex flex-wrap gap-2">
      {tracks.map((t, i) => (
        <span
          key={t.id}
          role="button"
          tabIndex={0}
          onClick={() => { p.setMusicTrack(t.filename); p.setMusicTrackKind(t.kind); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { p.setMusicTrack(t.filename); p.setMusicTrackKind(t.kind); } }}
          style={chipStyle(p.musicTrack === t.filename)}
        >
          {t.title}{i === 0 ? " · แนะนำ" : ""}
          <span
            role="button"
            aria-label={previewing === t.filename ? "หยุดตัวอย่าง" : "ฟังตัวอย่าง"}
            onClick={(e) => { e.stopPropagation(); void togglePreview(t.filename); }}
            className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
            style={{
              background: previewing === t.filename ? "rgba(52,211,153,.15)" : "rgba(255,255,255,.07)",
              color: previewing === t.filename ? color.success : color.textSecondary,
            }}
          >
            {previewing === t.filename
              ? <Pause size={9} strokeWidth={2} />
              : <Play size={9} strokeWidth={2} style={{ marginLeft: 1 }} />}
          </span>
        </span>
      ))}
      <span
        role="button"
        tabIndex={0}
        onClick={() => { stopPreview(); p.setMusicTrack(null); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { stopPreview(); p.setMusicTrack(null); } }}
        style={{ ...chipStyle(p.musicTrack === null, true), padding: "6px 14px" }}
      >
        ไม่ใส่เพลง
      </span>
    </div>
  );
}

function Group({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <div style={{ font: `500 13.5px ${font.heading}` }}>{title}</div>
        <div style={{ fontSize: 11.5, color: color.textSecondary }}>{desc}</div>
      </div>
      {children}
    </section>
  );
}

/** ตั้งค่าขั้นสูง — จุดพักของฟีเจอร์เดิมทั้งหมด (นโยบาย "ย้าย ไม่ตัด").
 *  note = ป้ายบอกฟีเจอร์ที่ยังไม่ยกเข้ามา (ไม่มี children → "จะอยู่ตรงนี้", มีบางส่วน → "กำลังตามมา").
 *  ฟีเจอร์ที่ทำเสร็จครบแล้วไม่ต้องส่ง note — จะแสดงแค่ตัวคุมจริง */
function Advanced({ label = "ตั้งค่าขั้นสูง", note, children }: { label?: string; note?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 items-center gap-1 rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 lg:min-h-7"
        style={{ fontSize: 11.5, color: color.textSecondary, background: "none", border: "none", cursor: "pointer", outlineColor: color.primary300 }}
      >
        <ChevronDown size={12} strokeWidth={1.8} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 150ms ease" }} />
        {label}
      </button>
      {open && (
        <div id={panelId} className="mt-2 flex flex-col gap-2 px-3 py-2.5" style={{ borderRadius: radius.control, border: `1px dashed rgba(255,255,255,.12)` }}>
          {children}
          {note && (
            <span style={{ fontSize: 11, color: color.textFaintest, lineHeight: 1.7, display: "block" }}>
              {children ? "กำลังตามมา: " : "จะอยู่ตรงนี้: "}{note}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2.5"
      style={{ borderBottom: last ? "none" : `1px solid ${color.cardBorder}` }}
    >
      <span style={{ fontSize: 11.5, color: color.textFaint }}>{label}</span>
      <span style={{ fontSize: 12, color: color.text, textAlign: "right", maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
