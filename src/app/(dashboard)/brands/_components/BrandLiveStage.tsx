"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ImageOff, Pause, Play, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { stylePackSample } from "@/lib/style-pack-samples";
import { stylePack } from "@/lib/style-pack-catalog";
import { normalizeSubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";
import { renderSubtitle } from "@/remotion/renderSubtitle";
import { paintMotionBrollCanvas } from "@/remotion/MotionBrollScene";
import {
  isMotionMascotId,
  isMotionThemeId,
  motionTemplatesForTheme,
  resolveMotionBrandCiFromPalette,
  type MotionMascotId,
  type MotionTemplateConfig,
  type MotionThemeId,
} from "@/lib/motion-broll-catalog";
import { GEMINI_VOICES } from "@/lib/gemini-voices";
import type { HeadlineHookPreset } from "@/lib/headline-hook";
import {
  MOTION_THEME_META,
  MUSIC_MOOD_LABELS,
  resolveEffectiveBrollSource,
} from "./brand-kit-constants";
import type { BrandPayload, LibraryResponse } from "./types";

function HeadlineHookPreviewChip({
  preset,
  accentColor,
  fontFamily,
  compact = false,
}: {
  preset: HeadlineHookPreset;
  accentColor: string;
  fontFamily: string;
  compact?: boolean;
}) {
  const sampleText = "3 จุดพลาดที่ทำให้คลิปไม่ปัง";
  const baseStyle: React.CSSProperties = { fontFamily: `'${fontFamily}', 'Kanit', sans-serif` };
  const sizeClass = compact ? "px-1.5 py-0.5 text-[7px] leading-tight" : "px-2.5 py-1 text-[11px] leading-tight";

  if (preset === "news") {
    return (
      <div
        style={baseStyle}
        className={cn("mx-auto max-w-[90%] rounded-sm border-l-2 border-red-500 bg-zinc-950/90 font-bold text-white shadow-sm", sizeClass)}
      >
        <span className="mr-1 inline-block rounded-[2px] bg-red-600 px-1 text-[0.75em] font-extrabold">LIVE</span>
        {sampleText}
      </div>
    );
  }
  if (preset === "clean") {
    return (
      <div
        style={baseStyle}
        className={cn("mx-auto max-w-[90%] rounded-md bg-white/92 font-semibold text-zinc-950 shadow-sm", sizeClass)}
      >
        {sampleText}
      </div>
    );
  }
  if (preset === "banner") {
    return (
      <div
        style={{ ...baseStyle, backgroundColor: accentColor }}
        className={cn("w-full text-center font-extrabold text-zinc-950 shadow-sm", compact ? "px-1 py-0.5 text-[7px]" : "px-2 py-1 text-[11px]")}
      >
        {sampleText}
      </div>
    );
  }
  if (preset === "stat-burst") {
    return (
      <div
        style={baseStyle}
        className={cn("mx-auto max-w-[90%] rounded-lg border border-white/20 bg-zinc-950/88 text-center font-extrabold text-white shadow-sm", sizeClass)}
      >
        <span style={{ color: accentColor }} className="mr-1">3.4x</span>
        {sampleText}
      </div>
    );
  }
  if (preset === "question-pill") {
    return (
      <div
        style={baseStyle}
        className={cn("mx-auto max-w-[90%] rounded-full border border-white/25 bg-black/80 text-center font-bold text-white shadow-sm", sizeClass)}
      >
        {sampleText}?
      </div>
    );
  }
  return (
    <div
      style={{ ...baseStyle, borderColor: accentColor }}
      className={cn("mx-auto max-w-[90%] rounded-lg border bg-black/82 text-center font-extrabold text-white shadow-sm", sizeClass)}
    >
      {sampleText}
    </div>
  );
}

export function BrandLiveStage({
  draft,
  library,
  activeId,
  basePackLabel,
}: {
  draft: BrandPayload;
  library: LibraryResponse;
  activeId: string | null;
  basePackLabel: string | null;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [sceneIndex, setSceneIndex] = useState(0);
  const desktopCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mobileCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const effectiveSource = resolveEffectiveBrollSource(draft.visual, draft.subtitle.config);
  const isMotion = effectiveSource === "motion";
  const resolvedMotionTheme: MotionThemeId = isMotionThemeId(draft.visual.motionThemeId)
    ? draft.visual.motionThemeId
    : isMotionThemeId(draft.subtitle.config?.motionThemeId)
      ? draft.subtitle.config.motionThemeId
      : "apple-bento-glass";
  const resolvedMascot: MotionMascotId = isMotionMascotId(draft.visual.motionMascot)
    ? draft.visual.motionMascot
    : isMotionMascotId(draft.subtitle.config?.motionMascot)
      ? draft.subtitle.config.motionMascot
      : "stickman-scarf";

  const selectedPack = library.stylePacks.find((item) => item.id === draft.visual.stylePackId) ?? null;
  const fullPack = selectedPack ? stylePack(selectedPack.id) : null;
  const format = library.visualFormats.find((item) => item.id === draft.visual.primaryVisualFormatId) ?? null;
  const sample = selectedPack ? stylePackSample(selectedPack.id) : null;
  const subtitleConfig = useMemo(
    () => normalizeSubtitleStylePresetConfig(draft.subtitle.config) ?? fullPack?.subtitle ?? stylePack("life-drama").subtitle,
    [draft.subtitle.config, fullPack],
  );

  const themeTemplates = useMemo(() => motionTemplatesForTheme(resolvedMotionTheme), [resolvedMotionTheme]);
  const safeSceneIndex = themeTemplates.length > 0 ? sceneIndex % themeTemplates.length : 0;
  const activeTemplate = themeTemplates[safeSceneIndex] ?? themeTemplates[0];

  const motionConfig = useMemo<MotionTemplateConfig | null>(() => {
    if (!isMotion || !activeTemplate) return null;
    const brandCi = resolveMotionBrandCiFromPalette({
      themeId: resolvedMotionTheme,
      palette: draft.visual.palette,
      fontFamily: subtitleConfig.fontFamily,
      accentColor: subtitleConfig.accentColor,
    });
    return {
      templateId: activeTemplate.id,
      themeId: resolvedMotionTheme,
      brandCi,
      mascot: resolvedMascot,
      props: {
        ...activeTemplate.defaultProps,
        mascot: resolvedMascot,
      },
    };
  }, [activeTemplate, draft.visual.palette, isMotion, resolvedMascot, resolvedMotionTheme, subtitleConfig.accentColor, subtitleConfig.fontFamily]);

  useEffect(() => {
    if (!isMotion || !motionConfig) return;
    const desktopCanvas = desktopCanvasRef.current;
    const mobileCanvas = mobileCanvasRef.current;
    const reduced = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldAnimate = playing && !reduced;

    if (!shouldAnimate) {
      paintMotionBrollCanvas(desktopCanvas, motionConfig, 0.72);
      paintMotionBrollCanvas(mobileCanvas, motionConfig, 0.72);
      return;
    }

    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = (0.58 + (now - startedAt) / 3600) % 1;
      paintMotionBrollCanvas(desktopCanvas, motionConfig, progress);
      paintMotionBrollCanvas(mobileCanvas, motionConfig, progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isMotion, motionConfig, playing]);

  const image = sample?.imageUrl
    ? { url: sample.imageUrl, alt: `ภาพประกอบแนวทาง ${selectedPack?.thaiLabel}`, label: sample.label }
    : format?.previewUrl
      ? { url: format.previewUrl, alt: `ตัวอย่างแนวภาพ ${format.label}`, label: `ตัวอย่างแนวภาพ ${format.label} · สี เสียง ซับ ตามค่าที่ตั้งไว้` }
      : null;
  const imageUrl = image && failedUrl !== image.url ? image.url : null;

  const logoAsset = library.brandAssets.find((item) => item.id === draft.brandMark.assetId) ?? null;
  const logoPositionClass = {
    "top-left": "left-[7%] top-[5%]",
    "top-right": "right-[7%] top-[5%]",
    "bottom-left": "bottom-[5%] left-[7%]",
    "bottom-right": "bottom-[5%] right-[7%]",
  }[draft.brandMark.position] ?? "right-[7%] top-[5%]";

  const headlineEnabled = draft.videoDefaults?.headlineHookEnabled ?? Boolean(fullPack?.headlineHookPreset);
  const headlinePreset: HeadlineHookPreset = draft.videoDefaults?.headlineHookPreset ?? fullPack?.headlineHookPreset ?? "viral";

  const geminiVoice = draft.voice.provider === "gemini" && draft.voice.voiceId
    ? GEMINI_VOICES.find((v) => v.id === draft.voice.voiceId)?.label ?? draft.voice.voiceId
    : null;
  const voiceSummary = draft.voice.provider === "gemini"
    ? (geminiVoice ? `Gemini · ${geminiVoice}` : "Gemini · ค่าเริ่มต้น")
    : draft.voice.provider === "omnivoice"
      ? "Hero AI Voice"
      : "ElevenLabs";

  const musicMood = draft.videoDefaults?.musicMood ?? fullPack?.musicMood ?? null;
  const stageTitle = isMotion
    ? `Motion · ${MOTION_THEME_META[resolvedMotionTheme].shortLabel}`
    : selectedPack?.thaiLabel ?? (basePackLabel ? `ปรับจาก ${basePackLabel}` : "สไตล์ที่กำหนดเอง");

  const visualModeLabel = isMotion
    ? "Motion 60fps · 0 เครดิต"
    : effectiveSource === "kie-image"
      ? "ภาพ AI แบรนด์"
      : effectiveSource === "automix"
        ? "AutoMix"
        : "สต็อกฟรี · 0 เครดิต";

  const hasCustomScriptDna = Boolean(
    draft.niche.trim()
    && draft.niche.trim() !== "วิดีโอสั้นให้ความรู้และเล่าเรื่อง"
    && draft.audience.trim(),
  );

  const renderStageFrame = (compact: boolean) => (
    <figure
      {...(compact ? {} : { "data-brand-mark-preview": "true" })}
      className={cn(
        "relative overflow-hidden bg-zinc-950 shadow-sm",
        compact
          ? "aspect-[9/16] w-[92px] shrink-0 rounded-xl border border-border"
          : "mx-auto aspect-[9/16] w-full max-w-[236px] rounded-[22px] border border-border/90 ring-1 ring-white/5",
      )}
      aria-label="ตัวอย่างสด 9:16 ของแบรนด์"
    >
      {isMotion ? (
        <canvas
          ref={compact ? mobileCanvasRef : desktopCanvasRef}
          width={360}
          height={640}
          className="h-full w-full object-cover"
        />
      ) : imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={image?.alt ?? "ตัวอย่างแนวภาพแบรนด์"}
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 p-3 text-center text-[11px] leading-4 text-muted-foreground">
          <ImageOff className="h-4 w-4" />
          <span>ภาพตัวอย่างยังไม่พร้อม</span>
        </div>
      )}

      {/* Subtle legibility gradient so overlays & subtitles stay sharp */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/65"
      />

      {/* Layer 2: Headline Hook preview (in Motion mode, shown when explicitly enabled so Motion canvas headers stay crisp) */}
      {headlineEnabled && (!isMotion || draft.videoDefaults?.headlineHookEnabled === true) && (
        <div className={cn("pointer-events-none absolute inset-x-2", isMotion ? "top-[4%]" : compact ? "top-[14%]" : "top-[15%]")}>
          <HeadlineHookPreviewChip
            preset={headlinePreset}
            accentColor={subtitleConfig.accentColor}
            fontFamily={subtitleConfig.fontFamily}
            compact={compact}
          />
        </div>
      )}

      {/* Layer 3: Brand Logo Watermark */}
      {draft.brandMark.enabled && logoAsset && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/user/brand-assets/${logoAsset.id}/image`}
          alt={`ตัวอย่างโลโก้ ${logoAsset.name}`}
          className={cn("pointer-events-none absolute max-h-[28%] object-contain", logoPositionClass)}
          style={{ width: `${draft.brandMark.sizePct}%`, opacity: draft.brandMark.opacity }}
        />
      )}

      {/* Layer 4: Live Remotion Subtitle */}
      <div
        aria-label={compact ? undefined : "ตัวอย่างตัวอักษรซับ"}
        className={cn(
          "pointer-events-none absolute inset-x-1.5 text-center",
          compact ? "bottom-[10%]" : "bottom-[12%]",
        )}
      >
        {renderSubtitle(
          "ทุกเรื่องเริ่มต้นได้",
          subtitleConfig.textColor,
          compact ? 9 : 17,
          false,
          subtitleConfig.preset,
          subtitleConfig.fontFamily,
          subtitleConfig.fontWeight,
          -1,
          60,
          subtitleConfig.effect,
          subtitleConfig.accentColor,
          {
            shadow: subtitleConfig.shadow,
            outline: subtitleConfig.outline,
            outlineSize: subtitleConfig.outlineSize,
            lineBudgetSize: subtitleConfig.fontSize,
          },
        )}
      </div>

      {/* Motion playback controls on desktop stage */}
      {!compact && isMotion && (
        <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "หยุดภาพเคลื่อนไหว" : "เล่นภาพเคลื่อนไหว"}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90"
          >
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>
          {themeTemplates.length > 1 && (
            <button
              type="button"
              onClick={() => setSceneIndex((idx) => (idx + 1) % themeTemplates.length)}
              aria-label="ดูฉากตัวอย่างถัดไป"
              title={`ฉาก ${safeSceneIndex + 1}/${themeTemplates.length}`}
              className="flex h-7 items-center gap-1 rounded-full border border-white/15 bg-black/70 px-2 text-[10px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/90"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              <span>{safeSceneIndex + 1}/{themeTemplates.length}</span>
            </button>
          )}
        </div>
      )}
    </figure>
  );

  return (
    <aside
      aria-label="ตัวอย่างและการตั้งค่าที่เลือก"
      className="order-first min-w-0 rounded-2xl border border-border bg-card p-4 lg:order-last lg:sticky lg:top-6 lg:p-5"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{stageTitle}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{visualModeLabel}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <Sparkles className="h-2.5 w-2.5" />
          พรีวิวสด · 0 เครดิต
        </span>
      </div>

      {/* Mobile compact layout (< lg) */}
      <div className="flex items-start gap-3.5 lg:hidden">
        {renderStageFrame(true)}
        <div className="min-w-0 flex-1 space-y-2.5">
          <dl className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs leading-4" aria-live="polite">
            <dt className="text-muted-foreground">ภาพ</dt>
            <dd className="truncate text-foreground">{isMotion ? MOTION_THEME_META[resolvedMotionTheme].shortLabel : (format?.label ?? "แนวภาพที่เลือก")}</dd>
            <dt className="text-muted-foreground">เสียง</dt>
            <dd className="truncate text-foreground">{voiceSummary}</dd>
            <dt className="text-muted-foreground">ซับ</dt>
            <dd className="truncate text-foreground">{subtitleConfig.fontFamily} · {headlineEnabled ? "มีพาดหัว" : "ซับอย่างเดียว"}</dd>
            {musicMood && (
              <>
                <dt className="text-muted-foreground">เพลง</dt>
                <dd className="truncate text-foreground">{MUSIC_MOOD_LABELS[musicMood]}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap items-center gap-1.5" aria-label="ชุดสีที่เลือก">
            {draft.visual.palette.map((hex, idx) => (
              <span
                key={`${hex}-${idx}`}
                title={hex}
                className="h-4 w-4 rounded-full border border-border"
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Desktop full 9:16 live stage (>= lg) */}
      <div className="hidden lg:block">
        {renderStageFrame(false)}

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">ชุดสี Brand CI</span>
          <div className="flex items-center gap-1.5" aria-label="ชุดสีที่เลือก">
            {draft.visual.palette.map((hex, idx) => (
              <span
                key={`${hex}-${idx}`}
                title={hex}
                className="h-5 w-5 rounded-full border border-border shadow-xs"
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border pt-3 text-xs leading-5" aria-live="polite">
          <dt className="text-muted-foreground">ภาพ</dt>
          <dd className="truncate font-medium text-foreground">
            {isMotion ? MOTION_THEME_META[resolvedMotionTheme].shortLabel : (format?.label ?? "แนวภาพที่เลือก")}
          </dd>
          <dt className="text-muted-foreground">เสียง</dt>
          <dd className="truncate text-foreground">{voiceSummary}</dd>
          <dt className="text-muted-foreground">ซับ</dt>
          <dd className="truncate text-foreground">
            {library.subtitlePresets.find((item) => item.id === draft.subtitle.presetId)?.name ?? `${subtitleConfig.fontFamily} · ${headlineEnabled ? "พาดหัวเปิด" : "ไม่มีพาดหัว"}`}
          </dd>
          <dt className="text-muted-foreground">เพลง</dt>
          <dd className="truncate text-foreground">
            {musicMood ? MUSIC_MOOD_LABELS[musicMood] : "เลือกตามเนื้อหา"}
          </dd>
        </dl>

        {/* 3-Channel Brand Readiness Strip */}
        <div className="mt-3.5 border-t border-border pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            ความพร้อมใช้งาน
          </p>
          <div className="space-y-1.5 text-[11.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                Video Editor
              </span>
              <span className="truncate text-muted-foreground">{visualModeLabel}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-foreground">
                <CheckCircle2 className={cn("h-3.5 w-3.5 shrink-0", hasCustomScriptDna ? "text-emerald-400" : "text-muted-foreground/60")} />
                Hero Script
              </span>
              <span className="truncate text-muted-foreground">
                {hasCustomScriptDna ? "ครบพร้อมเขียนบท" : "เติม Script DNA เพิ่มได้"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-foreground">
                <CheckCircle2 className={cn("h-3.5 w-3.5 shrink-0", activeId ? "text-emerald-400" : "text-muted-foreground/60")} />
                AI Agent (MCP)
              </span>
              <span className="truncate text-muted-foreground">
                {activeId ? "พร้อมสั่งงานด้วย ID" : "บันทึกเพื่อรับ ID"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!isMotion && imageUrl && image?.label && (
        <p className="mt-3 hidden text-[11px] leading-4 text-muted-foreground lg:block">{image.label}</p>
      )}
    </aside>
  );
}
