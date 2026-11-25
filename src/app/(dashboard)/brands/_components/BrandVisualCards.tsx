"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImageOff, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_THEME_BRAND_CI,
  isNewMotionTheme,
  motionTemplatesForTheme,
  resolveMotionBrandCiFromPalette,
  type MotionMascotId,
  type MotionTemplateConfig,
  type MotionThemeId,
} from "@/lib/motion-broll-catalog";
import { paintMotionBrollCanvas } from "@/remotion/MotionBrollScene";
import { stylePack, type StylePackId } from "@/lib/style-pack-catalog";
import { stylePackSample } from "@/lib/style-pack-samples";
import {
  MOTION_THEME_DISPLAY_ORDER,
  MOTION_THEME_META,
  PACING_BADGE_LABELS,
  STYLE_PACK_CARD_META,
} from "./brand-kit-constants";
import type { LibraryResponse } from "./types";

function MotionThemePosterCard({
  themeId,
  selected,
  disabled,
  palette,
  fontFamily,
  accentColor,
  mascot,
  onSelect,
}: {
  themeId: MotionThemeId;
  selected: boolean;
  disabled: boolean;
  palette: string[];
  fontFamily: string;
  accentColor: string;
  mascot: MotionMascotId;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState(false);

  const meta = MOTION_THEME_META[themeId];
  const nativeCi = DEFAULT_THEME_BRAND_CI[themeId];
  const isNew = isNewMotionTheme(themeId);
  const template = useMemo(() => motionTemplatesForTheme(themeId)[0] ?? null, [themeId]);

  // Show each theme's authentic native palette on unselected cards so all 6
  // look unmistakably distinct; sync the user's Brand CI onto the selected card.
  const motionConfig = useMemo<MotionTemplateConfig | null>(() => {
    if (!template) return null;
    const brandCi = selected
      ? resolveMotionBrandCiFromPalette({
          themeId,
          palette,
          fontFamily,
          accentColor,
        })
      : nativeCi;
    return {
      templateId: template.id,
      themeId,
      brandCi,
      mascot,
      props: {
        ...template.defaultProps,
        mascot,
      },
    };
  }, [accentColor, fontFamily, mascot, nativeCi, palette, selected, template, themeId]);

  useEffect(() => {
    if (!motionConfig) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!hovered || reduced) {
      paintMotionBrollCanvas(canvas, motionConfig, 0.74);
      return;
    }

    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = (((now - startedAt) / 1000) % 3.2) / 3.2;
      paintMotionBrollCanvas(canvas, motionConfig, progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hovered, motionConfig]);

  const swatches = [nativeCi.backgroundColor, nativeCi.primaryColor, nativeCi.accentColor];

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-zinc-950 text-left transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 disabled:cursor-not-allowed disabled:opacity-55",
        selected
          ? "border-violet-500 ring-2 ring-violet-500/40 shadow-md shadow-violet-950/30"
          : "border-border hover:border-violet-500/50",
      )}
    >
      {/* Live Motion Canvas Poster */}
      <div
        className="relative aspect-[9/12] w-full overflow-hidden"
        style={{ backgroundColor: nativeCi.backgroundColor }}
      >
        <canvas
          ref={canvasRef}
          width={216}
          height={288}
          aria-hidden="true"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />

        {/* Top badges */}
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur-md",
              isNew
                ? "border border-violet-400/40 bg-violet-950/80 text-violet-200"
                : "border border-white/15 bg-black/65 text-white/90",
            )}
          >
            <Play className="h-2.5 w-2.5 fill-current" />
            {isNew ? "ใหม่ · 60fps" : "60fps"}
          </span>

          {selected ? (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white shadow-sm ring-2 ring-black/40">
              <Check className="h-3 w-3 stroke-[3]" />
            </span>
          ) : null}
        </div>

        {/* Bottom gradient + title overlay */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-2.5 pb-2.5 pt-8">
          <div className="flex items-center justify-between gap-1.5">
            <span className="truncate text-xs font-bold leading-4 text-white sm:text-[13px]">
              {meta.shortLabel}
            </span>
            <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
              {swatches.map((hex, i) => (
                <span
                  key={`${themeId}-swatch-${i}`}
                  className="h-2 w-2 rounded-full border border-white/30"
                  style={{ backgroundColor: hex }}
                />
              ))}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-[10.5px] leading-4 text-white/75">
            {meta.tagline}
          </p>
          <p className="mt-0.5 truncate text-[9.5px] font-medium text-violet-300/90">
            {meta.bestFor}
          </p>
        </div>
      </div>
    </button>
  );
}

export function MotionThemeCardGrid({
  activeTheme,
  disabled,
  palette,
  fontFamily,
  accentColor,
  mascot,
  onSelect,
}: {
  activeTheme: MotionThemeId;
  disabled: boolean;
  palette: string[];
  fontFamily: string;
  accentColor: string;
  mascot: MotionMascotId;
  onSelect: (themeId: MotionThemeId) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {MOTION_THEME_DISPLAY_ORDER.map((themeId) => (
        <MotionThemePosterCard
          key={themeId}
          themeId={themeId}
          selected={activeTheme === themeId}
          disabled={disabled}
          palette={palette}
          fontFamily={fontFamily}
          accentColor={accentColor}
          mascot={mascot}
          onSelect={() => onSelect(themeId)}
        />
      ))}
    </div>
  );
}

function MiniSubtitlePreview({ packId }: { packId: StylePackId }) {
  const pack = stylePack(packId);
  const meta = STYLE_PACK_CARD_META[packId] ?? { sampleCaption: pack.thaiLabel, accentWord: "" };
  const sub = pack.subtitle;
  const fontStyle: React.CSSProperties = {
    fontFamily: `'${sub.fontFamily}', 'Kanit', sans-serif`,
  };

  if (sub.preset === "news") {
    return (
      <div
        aria-hidden="true"
        style={fontStyle}
        className="inline-flex max-w-full items-center gap-1 rounded-[4px] border-l-2 border-red-500 bg-zinc-950/90 px-1.5 py-0.5 text-[10px] font-extrabold leading-tight text-white shadow-sm"
      >
        <span className="truncate">{meta.sampleCaption}</span>
        <span className="shrink-0 rounded-[2px] bg-red-600 px-1 text-[9px] text-white">
          {meta.accentWord}
        </span>
      </div>
    );
  }

  if (sub.preset === "karaoke-box" || sub.preset === "box" || sub.preset === "box-rounded") {
    return (
      <div
        aria-hidden="true"
        style={fontStyle}
        className={cn(
          "inline-flex max-w-full flex-wrap items-center justify-center gap-1 bg-black/80 px-2 py-0.5 text-[10px] font-extrabold leading-tight text-white shadow-sm",
          sub.preset === "box-rounded" ? "rounded-full" : "rounded-md",
        )}
      >
        <span className="truncate">{meta.sampleCaption}</span>
        <span
          className="shrink-0 rounded px-1 text-zinc-950"
          style={{ backgroundColor: sub.accentColor }}
        >
          {meta.accentWord}
        </span>
      </div>
    );
  }

  if (sub.preset === "hormozi" || sub.preset === "pop-outline") {
    return (
      <div
        aria-hidden="true"
        style={{
          ...fontStyle,
          textShadow: "0 1.5px 0 #000, 0 -1px 0 #000, 1.5px 0 0 #000, -1.5px 0 0 #000, 0 2px 6px rgba(0,0,0,0.85)",
        }}
        className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 text-[11px] font-black uppercase leading-tight tracking-tight text-white"
      >
        <span className="truncate">{meta.sampleCaption}</span>
        <span className="shrink-0" style={{ color: sub.accentColor }}>
          {meta.accentWord}
        </span>
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      style={{
        ...fontStyle,
        color: sub.textColor,
        textShadow: sub.preset === "glow"
          ? `0 0 10px ${sub.accentColor}, 0 2px 6px rgba(0,0,0,0.95)`
          : "0 2px 6px rgba(0,0,0,0.95)",
      }}
      className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 text-[10.5px] font-bold leading-tight"
    >
      <span className="truncate">{meta.sampleCaption}</span>
      <span className="shrink-0 font-extrabold" style={{ color: sub.accentColor }}>
        {meta.accentWord}
      </span>
    </div>
  );
}

export function StylePackPosterGrid({
  packs,
  selectedId,
  disabled,
  failedThumbIds,
  onImageError,
  onSelect,
}: {
  packs: LibraryResponse["stylePacks"];
  selectedId: StylePackId | null;
  disabled: boolean;
  failedThumbIds: Record<string, boolean>;
  onImageError: (id: string) => void;
  onSelect: (id: StylePackId) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {packs.map((item) => {
        const checked = item.id === selectedId;
        const fullPack = stylePack(item.id);
        const cardMeta = STYLE_PACK_CARD_META[item.id] ?? { sampleCaption: item.thaiLabel, accentWord: "" };
        const packSample = stylePackSample(item.id);
        const thumbUrl = packSample?.imageUrl && !failedThumbIds[item.id] ? packSample.imageUrl : null;

        return (
          <label
            key={item.id}
            className={cn(
              "group relative block min-w-0 cursor-pointer overflow-hidden rounded-2xl border bg-zinc-950 transition-all duration-200",
              "focus-within:ring-2 focus-within:ring-violet-500/60",
              checked
                ? "border-violet-500 ring-2 ring-violet-500/40 shadow-md shadow-violet-950/30"
                : "border-border hover:border-violet-500/50",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="radio"
              name="brand-setup-style"
              value={item.id}
              checked={checked}
              onChange={() => onSelect(item.id)}
              className="sr-only"
            />

            {/* 9:13 Vertical Video Poster Frame */}
            <div className="relative aspect-[9/13] w-full overflow-hidden bg-zinc-900">
              {thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbUrl}
                  alt=""
                  className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
                  onError={() => onImageError(item.id)}
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-3 text-center text-[11px] text-muted-foreground">
                  <ImageOff className="h-4 w-4" />
                  <span>ภาพตัวอย่างยังไม่พร้อม</span>
                </div>
              )}

              {/* Subtle cinematic vignette for crisp legibility */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/95"
              />

              {/* Top row: Trend / Genre Badge + Selected Check */}
              <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-1.5">
                {cardMeta.badge ? (
                  <span
                    className={cn(
                      "inline-flex max-w-[calc(100%-26px)] truncate rounded-full px-2 py-0.5 text-[9.5px] font-semibold backdrop-blur-md",
                      cardMeta.badgeTone === "trending"
                        ? "border border-amber-400/40 bg-amber-950/80 text-amber-200"
                        : cardMeta.badgeTone === "new"
                          ? "border border-sky-400/40 bg-sky-950/80 text-sky-200"
                          : "border border-white/15 bg-black/65 text-white/90",
                    )}
                  >
                    {cardMeta.badge}
                  </span>
                ) : (
                  <span className="inline-flex rounded-full border border-white/15 bg-black/60 px-2 py-0.5 text-[9.5px] font-medium text-white/80 backdrop-blur-md">
                    {PACING_BADGE_LABELS[fullPack.pacing]}
                  </span>
                )}

                {checked ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white shadow-sm ring-2 ring-black/40">
                    <Check className="h-3 w-3 stroke-[3]" />
                  </span>
                ) : null}
              </div>

              {/* Lower-middle signature video subtitle sample + Title footer */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-2.5 pb-2.5 pt-8">
                <div className="flex justify-center">
                  <MiniSubtitlePreview packId={item.id} />
                </div>

                <div className="border-t border-white/10 pt-1.5">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="truncate text-xs font-bold leading-4 text-white sm:text-[13px]">
                      {item.thaiLabel}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
                      {item.palette.map((hex, i) => (
                        <span
                          key={`${item.id}-${i}`}
                          className="h-2 w-2 rounded-full border border-white/30"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </span>
                  </div>
                  <span className="mt-0.5 line-clamp-1 block text-[10.5px] leading-4 text-white/70">
                    {item.tagline}
                  </span>
                </div>
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );
}
